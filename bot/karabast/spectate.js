#!/usr/bin/env node
'use strict';
/**
 * Spectate Karabast games and save each one as JSON Lines of scrubbed `gamestate` frames, which
 * `node importer/import.js <dir> --out <replays>` turns into replays (seen as a spectator: both hands hidden).
 *
 *   node bot/karabast/spectate.js --out captures [--lobby <id> | --public] [--games 1] [--gap 30]
 *                                 [--server http://127.0.0.1:9500] [--predict mlp-g5] [--max-minutes 90]
 *                                 [--allow-host <host> --token-env KARABAST_TOKEN --ledger <file> [--max-people 10]]
 *                                 [--stop-file <file>]
 *
 * --lobby watches one game by its lobby id (from a spectate link `.../spectate?lobbyId=<id>`). --public watches
 * games listed by `/api/ongoing-games` that allow spectators, one at a time, oldest listing skipped once seen.
 * --predict prints P(win) after each decision with a bot/eval evaluator (card data: SWU_CARD_JSON or
 * forceteki/test/json), using bot/eval's spectator view (both hands hidden, only their counts). `mlp-g5` is the best
 * one without decklists: Brier 0.213 on 181 real KaraBuddy games, 0.171 on engine games.
 *
 * People cap: a run against a non-local server needs --ledger (bot/karabast/ledger.js). Two places under --max-people
 * are reserved before joining a game, or the run stops; both players are counted in them when the first frame
 * arrives. The run stops before the next game when --stop-file exists.
 *
 * Only localhost is allowed unless --allow-host names the host. The live site needs a login to spectate (anonymous
 * spectators are a development-only setting), so a live run also needs a session token, read from the environment
 * variable named by --token-env. Spectators are visible: the game log names them and both players see them.
 *
 * Privacy: every frame goes through makeScrubber before it is written. Player ids and usernames become
 * player1/player2, spectators become "a spectator", user objects (settings, cosmetics) and player chat text are
 * dropped. File names are a hash of the lobby and game ids, never names.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { KarabastSocket, get, post } = require('./socket');
const { makeScrubber } = require('./frame');
const { PeopleLedger } = require('./ledger');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}
const flag = (name) => process.argv.includes(`--${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

/** P(p1 wins) printer for the latest frame, or null when --predict is off. */
function predictor(name) {
    if (!name) {
        return null;
    }
    const { loadEvaluator } = require('../eval/evaluators');
    const { assignSeats, compactSnapshot, messageText } = require('../../importer/karabast');
    const ev = loadEvaluator(name);
    let round = 0;
    let last = null;
    return (frames) => {
        const gs = frames[frames.length - 1];
        for (const m of gs.newMessages ?? []) {
            const r = String(messageText(m, new Map()) ?? '').match(/^Round:\s*(\d+)\s*-/i);
            if (r) {
                round = Number(r[1]);
            }
        }
        if (gs.phase !== 'action' && !gs.winners?.length) {
            return;
        }
        const seatIds = assignSeats(frames.map((state) => ({ state })));
        const state = compactSnapshot(gs, seatIds, round);
        const p = ev.predict(state, 'p1', { view: 'spectator' });
        const line = `round ${round} ${gs.phase}: P(p1 wins) = ${p.toFixed(3)}  base ${state.players.p1.base.hp - state.players.p1.base.d} vs ${state.players.p2.base.hp - state.players.p2.base.d}`;
        if (line !== last) {
            console.log(line);
            last = line;
        }
    };
}

/** Watch one game until it has a winner, the socket closes, or maxMs passes. Returns the number of frames saved. */
async function watch(server, lobbyId, out, opts) {
    const user = { id: `spectator-${crypto.randomUUID()}`, username: opts.username };
    const res = await post(server, '/api/spectate-game', { gameId: lobbyId, user }, opts);
    if (!res.body?.success) {
        throw new Error(`spectate-game refused: ${res.body?.message ?? res.status}`);
    }
    // from here on the players may see us in the spectator list
    opts.onJoined?.();
    const sock = new KarabastSocket(server, { user, spectator: true, token: opts.token, allowHosts: opts.allowHosts });
    const scrub = makeScrubber([user.id, user.username]);
    const frames = [];
    let file = null;
    let fd = null;
    let counted = false;
    let stopped = false;
    let timer = null;
    let predict = predictor(opts.predict);
    const ended = new Promise((resolve) => {
        timer = setTimeout(() => resolve('time limit'), opts.maxMs);
        sock.on('disconnect', (why) => {
            clearTimeout(timer);
            resolve(why);
        });
        sock.on('gamestate', (gs) => {
            if (stopped || !gs?.players || Object.keys(gs.players).length < 2) {
                return;
            }
            if (!counted) {
                counted = true;
                try {
                    opts.onPlayers?.(Object.keys(gs.players));
                } catch (e) {
                    // over the people cap: leave before anything is saved
                    stopped = true;
                    clearTimeout(timer);
                    resolve(e.message);
                    return;
                }
            }
            const clean = scrub(gs);
            if (!fd) {
                file = path.join(out, `${hash(`${lobbyId}|${gs.id ?? ''}`)}.jsonl`);
                fd = fs.openSync(file, 'a');
            }
            fs.writeSync(fd, JSON.stringify(clean) + '\n');
            frames.push(clean);
            if (predict) {
                // the recording matters more than the prediction: an evaluator error turns prediction off
                try {
                    predict(frames);
                } catch (e) {
                    console.error(`prediction off: ${e.message}`);
                    predict = null;
                }
            }
            if (gs.winners?.length) {
                clearTimeout(timer);
                setTimeout(() => resolve('game over'), 1000);
            }
        });
    });
    let why;
    try {
        await sock.connect();
        why = await ended;
    } finally {
        stopped = true;
        clearTimeout(timer);
        sock.close();
        if (fd) {
            fs.closeSync(fd);
        }
    }
    console.error(`${frames.length} frames -> ${file ?? '(nothing saved)'} (${why})`);
    return frames.length;
}

async function main() {
    const server = arg('server', 'http://127.0.0.1:9500');
    const out = arg('out');
    if (!out) {
        throw new Error('--out <dir> is required');
    }
    const allowHosts = arg('allow-host') ? [arg('allow-host')] : [];
    const tokenEnv = arg('token-env');
    const opts = {
        allowHosts,
        token: tokenEnv ? process.env[tokenEnv] : null,
        username: arg('username', 'swu-bot spectator'),
        predict: arg('predict'),
        maxMs: Number(arg('max-minutes', 90)) * 60000,
    };
    if (tokenEnv && !opts.token) {
        throw new Error(`environment variable ${tokenEnv} is empty`);
    }
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(server).hostname);
    if (!local && !arg('ledger')) {
        throw new Error('a run against a non-local server needs --ledger <file> (the people cap)');
    }
    const ledger = arg('ledger') ? new PeopleLedger(arg('ledger'), Number(arg('max-people', 10))) : null;
    const stopFile = arg('stop-file');
    fs.mkdirSync(out, { recursive: true });
    const games = Number(arg('games', 1));
    const gapMs = Number(arg('gap', 30)) * 1000;
    const lobby = arg('lobby');
    if (!lobby && !flag('public')) {
        throw new Error('pass --lobby <id> or --public');
    }
    const seen = new Set();
    for (let g = 0; g < games; g++) {
        if (stopFile && fs.existsSync(stopFile)) {
            console.error(`stop file ${stopFile} exists; stopping`);
            break;
        }
        if (ledger && !ledger.room(2)) {
            console.error(`people cap reached (${ledger.count} of ${ledger.max}); stopping`);
            break;
        }
        let id = lobby;
        if (!id) {
            const list = await get(server, '/api/ongoing-games', opts);
            id = (list.body?.ongoingGames ?? []).find((x) => x.allowSpectators && !seen.has(x.id))?.id;
            if (!id) {
                console.error('no spectatable game listed; waiting');
                await sleep(gapMs);
                g--;
                continue;
            }
        }
        seen.add(id);
        // both players' places are held before joining, so another run sharing the ledger cannot take them
        const hold = ledger ? ledger.reserve(2) : null;
        if (ledger && !hold) {
            console.error(`people cap reached (${ledger.count} counted, ${ledger.reserved()} reserved, of ${ledger.max}); stopping`);
            break;
        }
        let joined = false;
        try {
            const counted = { onJoined: () => { joined = true; }, onPlayers: (ids) => ledger.add(ids, 'watched', hold) };
            await watch(server, id, out, ledger ? { ...opts, ...counted } : opts);
        } finally {
            // joined but no frame told us who played: the two places stay counted
            if (joined) {
                ledger?.spend(hold, 'watched');
            } else {
                ledger?.release(hold);
            }
        }
        if (lobby) {
            break;
        }
        if (g + 1 < games) {
            await sleep(gapMs);
        }
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
}

module.exports = { watch };
