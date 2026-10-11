#!/usr/bin/env node
'use strict';
/**
 * Play one game between two random players on a LOCAL Karabast server, through the same socket messages the web
 * client sends. It tests bot/karabast (legal actions from frames, the socket client) and gives spectate.js a game
 * to watch. Local only: socket.js refuses other hosts.
 *
 *   node bot/karabast/selfplay.js [--server http://127.0.0.1:9500] [--cards <card json dir>] [--seed 1]
 *                                 [--private] [--delay-ms 0] [--max-steps 4000]
 *
 * Decks are random 50-card decks (one leader, one base, at most 3 copies) from the card json that `npm run
 * get-cards` writes (default forceteki/test/json, or SWU_CARD_JSON). Public lobbies allow spectators by default; with
 * --private the host turns spectators on, and the spectate link is printed either way.
 */
const fs = require('fs');
const path = require('path');
const { seededRng } = require('../rng');
const { KarabastSocket, post } = require('./socket');
const { legalActions, gameMessage, decisionKey } = require('./frame');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const code = (c) => `${c.setId.set}_${String(c.setId.number).padStart(3, '0')}`;

/** A random 50-card deck in the swudb shape the server takes. */
function randomDeck(cardDir, rng) {
    const dir = path.join(cardDir, 'Card');
    const cards = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter((c) => c.setId?.set && c.types);
    const pick = (list) => list[Math.floor(rng() * list.length)];
    const leaders = cards.filter((c) => c.types.includes('leader'));
    const bases = cards.filter((c) => c.types.includes('base'));
    const pool = cards.filter((c) => !c.types.some((t) => ['leader', 'base', 'token'].includes(t) || t.includes('Token')));
    const counts = new Map();
    let n = 0;
    while (n < 50) {
        const c = code(pick(pool));
        if ((counts.get(c) ?? 0) < 3) {
            counts.set(c, (counts.get(c) ?? 0) + 1);
            n++;
        }
    }
    return {
        metadata: { name: 'selfplay', author: 'swu-bot' },
        leader: { id: code(pick(leaders)), count: 1 },
        base: { id: code(pick(bases)), count: 1 },
        deck: [...counts].map(([id, count]) => ({ id, count })),
        sideboard: []
    };
}

/** A legal random split for a distribute action: one point at a time onto targets with room left. */
function randomSplit(a, rng) {
    const { spec, targets, caps } = a;
    const max = Math.min(spec.maxTargets ?? targets.length, targets.length);
    const given = new Map();
    for (let k = 0; k < spec.amount; k++) {
        const open = targets.map((t, i) => i).filter((i) => (given.get(i) ?? 0) < caps[i] && (given.has(i) || given.size < max));
        if (!open.length) {
            break;
        }
        const i = open[Math.floor(rng() * open.length)];
        given.set(i, (given.get(i) ?? 0) + 1);
    }
    return [...given].map(([i, amount]) => ({ id: targets[i], amount }));
}

/**
 * One seat: answers each new decision with a random legal action. The server ignores an answer it cannot take (for
 * example a third card in "select 2 cards") and sends no new frame, so after a short wait the seat tries an action it
 * has not tried yet for the same decision.
 */
function randomSeat(sock, me, rng, { delayMs, onStep }) {
    let latest = null;
    let lastKey = null;
    let lastAt = 0;
    let tried = new Set();
    const act = () => {
        const actions = legalActions(latest, me);
        let fresh = actions.filter((a, i) => !tried.has(i));
        if (!fresh.length) {
            tried = new Set();
            fresh = actions;
        }
        if (!fresh.length) {
            return;
        }
        const a = fresh[Math.floor(rng() * fresh.length)];
        tried.add(actions.indexOf(a));
        sock.send('game', ...gameMessage(a, a.kind === 'distribute' ? randomSplit(a, rng) : []));
        lastAt = Date.now();
        onStep(a);
    };
    sock.on('gamestate', (gs) => {
        latest = gs;
        if (gs.winners?.length) {
            return;
        }
        const key = decisionKey(gs, me);
        if (key !== lastKey) {
            lastKey = key;
            tried = new Set();
            setTimeout(act, delayMs);
        }
    });
    const watchdog = setInterval(() => {
        if (latest && !latest.winners?.length && lastAt && Date.now() - lastAt > 500 + delayMs && legalActions(latest, me).length) {
            act();
        }
    }, 250);
    return () => clearInterval(watchdog);
}

async function main() {
    const server = arg('server', 'http://127.0.0.1:9500');
    const cardDir = arg('cards', process.env.SWU_CARD_JSON ?? path.join(__dirname, '..', '..', 'forceteki', 'test', 'json'));
    const seed = arg('seed', '1');
    const isPrivate = process.argv.includes('--private');
    const delayMs = Number(arg('delay-ms', 0));
    const maxSteps = Number(arg('max-steps', 4000));
    const rng = seededRng(`karabast-selfplay-${seed}`);
    const users = [0, 1].map((i) => ({ id: `selfplay-${seed}-${i}-${process.pid}`, username: `Seat${i + 1}` }));
    const decks = [randomDeck(cardDir, rng), randomDeck(cardDir, rng)];

    const made = await post(server, '/api/create-lobby', { user: users[0], deck: decks[0], lobbyName: `selfplay ${seed}`, format: 'open', cardPool: 'unlimited', gamesToWinMode: 'bestOfOne', isPrivate });
    if (!made.body?.success) {
        throw new Error(`create-lobby failed: ${JSON.stringify(made.body)}`);
    }
    const host = await new KarabastSocket(server, { user: users[0] }).connect();
    const lobby = await host.next('lobbystate');
    if (!isPrivate) {
        const joined = await post(server, '/api/join-lobby', { lobbyId: lobby.id, user: users[1] });
        if (!joined.body?.success) {
            throw new Error(`join-lobby failed: ${JSON.stringify(joined.body)}`);
        }
    }
    const guest = await new KarabastSocket(server, { user: users[1], lobbyId: isPrivate ? lobby.id : null }).connect();
    await guest.next('lobbystate');
    guest.send('lobby', 'changeDeck', decks[1]);
    guest.send('lobby', 'setReadyStatus', true);
    host.send('lobby', 'setReadyStatus', true);
    if (isPrivate) {
        host.send('lobby', 'updateSetting', 'allowSpectators', true);
    }
    console.log(`lobby ${lobby.id}; spectate with: node bot/karabast/spectate.js --lobby ${lobby.id} --out <dir>`);
    await sleep(Number(arg('start-after-ms', 500)));

    let steps = 0;
    let stops = [];
    const result = new Promise((resolve) => {
        const onStep = () => {
            if (++steps >= maxSteps) {
                resolve({ winners: [], reason: 'step cap' });
            }
        };
        stops = [
            randomSeat(host, users[0].id, rng, { delayMs, onStep }),
            randomSeat(guest, users[1].id, rng, { delayMs, onStep })
        ];
        host.on('gamestate', (gs) => {
            if (gs.winners?.length) {
                resolve({ winners: gs.winners, reason: 'game over' });
            }
        });
        host.on('disconnect', (why) => resolve({ winners: [], reason: why }));
    });
    host.send('lobby', 'startGameAsync');
    const r = await result;
    stops.forEach((s) => s());
    console.log(`${r.reason}: ${steps} actions, winner ${r.winners.join(', ') || 'none'}`);
    await sleep(1500);
    host.close();
    guest.close();
}

if (require.main === module) {
    main().then(() => process.exit(0), (e) => {
        console.error(e.message);
        process.exit(1);
    });
}

module.exports = { randomDeck, randomSplit, main };
