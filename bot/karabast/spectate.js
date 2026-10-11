#!/usr/bin/env node
'use strict';
/**
 * Spectate Karabast games and save each one as JSON Lines of scrubbed `gamestate` frames, which
 * `node importer/import.js <dir> --out <replays>` turns into replays (seen as a spectator: both hands hidden).
 *
 *   node bot/karabast/spectate.js --out captures [--lobby <id> | --public] [--games 1] [--gap 30]
 *                                 [--server http://127.0.0.1:9500] [--predict race] [--max-minutes 90]
 *                                 [--allow-host <host> --token-env KARABAST_TOKEN]
 *
 * --lobby watches one game by its lobby id (from a spectate link `.../spectate?lobbyId=<id>`). --public watches
 * games listed by `/api/ongoing-games` that allow spectators, one at a time, oldest listing skipped once seen.
 * --predict prints P(win) after each decision with a bot/eval evaluator (card data: SWU_CARD_JSON or
 * forceteki/test/json). `race` and `base` only use the public board; the fitted evaluators need the spectator view
 * (both hands hidden) in bot/eval.
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
    const sock = new KarabastSocket(server, { user, spectator: true, token: opts.token, allowHosts: opts.allowHosts });
    const scrub = makeScrubber([user.id, user.username]);
    const frames = [];
    let file = null;
    let fd = null;
    const predict = predictor(opts.predict);
    const ended = new Promise((resolve) => {
        const timer = setTimeout(() => resolve('time limit'), opts.maxMs);
        sock.on('disconnect', (why) => {
            clearTimeout(timer);
            resolve(why);
        });
        sock.on('gamestate', (gs) => {
            if (!gs?.players || Object.keys(gs.players).length < 2) {
                return;
            }
            const clean = scrub(gs);
            if (!fd) {
                file = path.join(out, `${hash(`${lobbyId}|${gs.id ?? ''}`)}.jsonl`);
                fd = fs.openSync(file, 'a');
            }
            fs.writeSync(fd, JSON.stringify(clean) + '\n');
            frames.push(clean);
            if (predict) {
                predict(frames);
            }
            if (gs.winners?.length) {
                clearTimeout(timer);
                setTimeout(() => resolve('game over'), 1000);
            }
        });
    });
    await sock.connect();
    const why = await ended;
    sock.close();
    if (fd) {
        fs.closeSync(fd);
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
    fs.mkdirSync(out, { recursive: true });
    const games = Number(arg('games', 1));
    const gapMs = Number(arg('gap', 30)) * 1000;
    const lobby = arg('lobby');
    if (!lobby && !flag('public')) {
        throw new Error('pass --lobby <id> or --public');
    }
    const seen = new Set();
    for (let g = 0; g < games; g++) {
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
        await watch(server, id, out, opts);
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
