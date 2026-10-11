#!/usr/bin/env node
'use strict';
/**
 * Games between two protocol bots on a LOCAL Karabast server, each seat played through bot/karabast/seat.js over the
 * same socket messages the web client sends. It tests the Karabast client end to end and gives spectate.js games to
 * watch. Local only: socket.js refuses other hosts.
 *
 *   node bot/karabast/selfplay.js [--bots js-random,js-random] [--games 1] [--seed 1] [--server http://127.0.0.1:9500]
 *                                 [--cards <card json dir>] [--private] [--pester-undo 0.3] [--max-minutes 15]
 *                                 [--out results.jsonl] [--start-after-ms 500] [--verbose]
 *                                 [--decks bot/decks/ash-meta-2026-09.json [--pair <deck name>,<deck name>]]
 *
 * Bots: names from bot/external-bots.json (programs such as c-clock, rust-greedy2) or js-random. Decks come from
 * --decks (a list of deck lists; two at random per game, or the two named by --pair). Otherwise they are random
 * 50-card decks (one leader, one base, at most 3 copies) from the card json that `npm run get-cards` writes (default
 * forceteki/test/json, or SWU_CARD_JSON). Lobbies are public by default, so the server runs the public-game timer
 * (20 s per prompt plus a 120 s bank) and undo needs the opponent's approval; --private turns both off.
 *
 * --pester-undo P makes the second seat a test harness that, while it waits, asks to undo its last action with
 * probability P per frame (at most 6 times a game). It checks the first seat's undo policy and that games survive
 * rollbacks. It sends rollbackToSnapshot itself; a KarabastSeat never does.
 */
const fs = require('fs');
const path = require('path');
const { seededRng } = require('../rng');
const { KarabastSocket, post } = require('./socket');
const { KarabastSeat, loadClient } = require('./seat');
const { legalActions } = require('./frame');

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
    // 50 cards at 3 copies each need 17 different cards
    if (!leaders.length || !bases.length || new Set(pool.map(code)).size < 17) {
        throw new Error(`${dir} has too few cards for a deck (${leaders.length} leaders, ${bases.length} bases, ${pool.length} others)`);
    }
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

/** Test harness: seat `me` asks to undo its last action now and then while the other seat acts. */
function pesterUndo(sock, me, rng, p, max = 6) {
    let sent = 0;
    let lastAt = 0;
    const onFrame = (gs) => {
        const state = gs?.players?.[me]?.availableSnapshots?.quickSnapshotAvailable;
        const waiting = gs?.players && !legalActions(gs, me).length;
        if (sent < max && waiting && !gs.winners?.length && (state === 'requestUndoAvailable' || state === 'freeUndoAvailable') && Date.now() - lastAt > 3000 && rng() < p) {
            sent++;
            lastAt = Date.now();
            sock.send('game', 'rollbackToSnapshot', { type: 'quick', playerId: me, actionOffset: 0 });
        }
    };
    sock.on('gamestate', onFrame);
    return { stop: () => sock.off('gamestate', onFrame), count: () => sent };
}

const pct = (xs, q) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] : null);

function seatSummary(name, s) {
    return {
        bot: name, decisions: s.decisions, botMsP50: pct(s.botMs, 0.5), botMsMax: pct(s.botMs, 1), waitMsMax: pct(s.waitMs, 1),
        rejected: s.rejected, failures: s.failures.length, fallbacks: s.fallbacks, undoAllowed: s.undoAllowed, undoDenied: s.undoDenied,
        payRecovery: s.payRecovery.length, conceded: s.conceded
    };
}

/** One game; resolves to a result row. */
async function playOne({ server, cardDir, seed, bots, isPrivate, pester, maxMs, startAfterMs, verbose, deckList, pair }) {
    const rng = seededRng(`karabast-selfplay-${seed}`);
    const users = [0, 1].map((i) => ({ id: `selfplay-${seed}-${i}-${process.pid}`, username: `Seat${i + 1}` }));
    const named = (name) => deckList.find((d) => d.metadata?.name === name) ?? (() => {
        throw new Error(`no deck named ${name}`);
    })();
    const decks = deckList
        ? [0, 1].map((i) => (pair?.[i] ? named(pair[i]) : deckList[Math.floor(rng() * deckList.length)]))
        : [randomDeck(cardDir, rng), randomDeck(cardDir, rng)];
    const socks = [];
    const clients = [];
    let pestering = null;
    const t0 = Date.now();
    try {
        const made = await post(server, '/api/create-lobby', { user: users[0], deck: decks[0], lobbyName: `selfplay ${seed}`, format: 'open', cardPool: 'unlimited', gamesToWinMode: 'bestOfOne', isPrivate });
        if (!made.body?.success) {
            throw new Error(`create-lobby failed: ${JSON.stringify(made.body)}`);
        }
        const host = await new KarabastSocket(server, { user: users[0] }).connect();
        socks.push(host);
        const lobby = await host.next('lobbystate');
        if (!isPrivate) {
            const joined = await post(server, '/api/join-lobby', { lobbyId: lobby.id, user: users[1] });
            if (!joined.body?.success) {
                throw new Error(`join-lobby failed: ${JSON.stringify(joined.body)}`);
            }
        }
        const guest = await new KarabastSocket(server, { user: users[1], lobbyId: isPrivate ? lobby.id : null }).connect();
        socks.push(guest);
        await guest.next('lobbystate');
        guest.send('lobby', 'changeDeck', decks[1]);
        guest.send('lobby', 'setReadyStatus', true);
        host.send('lobby', 'setReadyStatus', true);
        if (isPrivate) {
            host.send('lobby', 'updateSetting', 'allowSpectators', true);
        }
        if (verbose) {
            console.error(`lobby ${lobby.id}; spectate with: node bot/karabast/spectate.js --lobby ${lobby.id} --out <dir>`);
        }
        await sleep(startAfterMs);

        clients.push(...bots.map((b) => loadClient(b)));
        const log = (i) => (line) => verbose && console.error(`[seed ${seed} ${bots[i]}] ${line}`);
        const seats = [host, guest].map((s, i) => new KarabastSeat(s, users[i].id, clients[i], { deck: decks[i], seed: `${seed}-${i}`, log: log(i) }));
        const plays = seats.map((s) => s.play());
        if (pester > 0) {
            pestering = pesterUndo(guest, users[1].id, rng, pester);
        }
        host.send('lobby', 'startGameAsync');
        let timer;
        const limit = new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), maxMs);
        });
        const results = await Promise.race([Promise.all(plays), limit]);
        clearTimeout(timer);
        const winner = results ? results.findIndex((r) => r.result === 'win') : -1;
        const reason = results ? results.map((r) => r.reason).find((r) => r !== 'game over') ?? 'game over' : 'time limit';
        return {
            seed, bots, decks: decks.map((d) => d.metadata?.name ?? null), winner: winner >= 0 ? `seat${winner + 1}` : null, reason,
            minutes: +((Date.now() - t0) / 60000).toFixed(2),
            undoRequests: pestering?.count() ?? 0, seats: seats.map((s, i) => seatSummary(bots[i], s.stats))
        };
    } finally {
        pestering?.stop();
        // let a spectator receive the last frames before the lobby closes
        await sleep(1500);
        socks.forEach((s) => s.close());
        await Promise.all(clients.map((c) => Promise.resolve(c.close?.()).catch(() => undefined)));
    }
}

async function main() {
    const bots = arg('bots', 'js-random,js-random').split(',');
    if (bots.length !== 2) {
        throw new Error('--bots takes two names');
    }
    const opts = {
        server: arg('server', 'http://127.0.0.1:9500'),
        cardDir: arg('cards', process.env.SWU_CARD_JSON ?? path.join(__dirname, '..', '..', 'forceteki', 'test', 'json')),
        bots,
        isPrivate: process.argv.includes('--private'),
        pester: Number(arg('pester-undo', 0)),
        maxMs: Number(arg('max-minutes', 15)) * 60000,
        startAfterMs: Number(arg('start-after-ms', 500)),
        verbose: process.argv.includes('--verbose'),
        deckList: arg('decks') ? JSON.parse(fs.readFileSync(arg('decks'), 'utf8')) : null,
        pair: arg('pair') ? arg('pair').split(',') : null
    };
    const games = Number(arg('games', 1));
    const seed0 = Number(arg('seed', 1));
    const out = arg('out');
    const rows = [];
    for (let g = 0; g < games; g++) {
        const row = await playOne({ ...opts, seed: seed0 + g });
        rows.push(row);
        console.log(JSON.stringify(row));
        if (out) {
            fs.appendFileSync(out, JSON.stringify(row) + '\n');
        }
    }
    const wins = bots.map((b, i) => rows.filter((r) => r.winner === `seat${i + 1}`).length);
    const sum = (k) => rows.reduce((s, r) => s + r.seats.reduce((t, x) => t + (x[k] ?? 0), 0), 0);
    console.log(`${games} games: ${bots[0]} ${wins[0]}, ${bots[1]} ${wins[1]}, no winner ${games - wins[0] - wins[1]}; ` +
        `ignored answers ${sum('rejected')}, bot failures ${sum('failures')}, fallbacks ${sum('fallbacks')}, ` +
        `undo allowed ${sum('undoAllowed')} denied ${sum('undoDenied')}, slowest bot reply ${Math.max(0, ...rows.flatMap((r) => r.seats.map((s) => s.botMsMax ?? 0)))} ms`);
}

if (require.main === module) {
    main().then(() => process.exit(0), (e) => {
        console.error(e.message);
        process.exit(1);
    });
}

module.exports = { randomDeck, pesterUndo, playOne };
