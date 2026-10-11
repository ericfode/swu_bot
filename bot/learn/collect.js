'use strict';
// node bot/learn/collect.js --games 2000 --seed 100000 --workers 4 --out data/traj/random [--bots random,random] [--all] [--key K|none]
//
// Plays games with the normal match loop and writes, for every decision, what a stdio bot would have seen
// (the `decide` body: prompt, state, actions) plus the action that was chosen and, at the end, who won.
// Output: <out>/shard-<k>.jsonl.gz, format "swu-traj/1" (see bot/rust-learned/README.md).
// Bots: any name tournament.js knows (random*, heuristic*, a bot program from bot/external-bots.json).
// Games are dealt from a secret run key (rng.js runKey); each `end` line has the game's key, which plays it again.
// The same --key and --seed give the same games. --key none: seed alone.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { fork } = require('child_process');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const { view, promptView, actionView, actionKey } = require('../view');
const { answer } = require('../stdio');

/** The body of the `decide` message a bot program would get (as bot/protocol.js builds it). */
function decideBody(eg, pid, actions) {
    return { you: eg.seatOf(pid), prompt: promptView(eg, pid), state: view(eg, eg.seatOf(pid)), actions: actions.map((a, i) => actionView(eg, a, i, pid)) };
}

const { makeBot, closeBots } = require('../players');
const { gameKey, runKey } = require('../rng');

/** Wraps a bot (native or protocol client) so every choice it makes is written as a trajectory line. */
function recording(bot, write, all) {
    let seq = 0;
    const log = (obs, i) => {
        seq++;
        if (obs) {
            write({ t: 'd', seq, you: obs.you, prompt: obs.prompt, state: obs.state, actions: obs.actions, i });
        }
    };
    const wrap = {
        name: bot.name,
        lang: bot.lang,
        timeoutMs: bot.timeoutMs,
        startTimeoutMs: bot.startTimeoutMs,
        get stats() {
            return bot.stats;
        },
        reset() {
            seq = 0;
        }
    };
    if (typeof bot.decide === 'function') {
        return Object.assign(wrap, {
            hello: (msg) => answer(bot, msg),
            over: (msg) => answer(bot, msg),
            async decide(msg, sim) {
                const r = await bot.decide(msg, sim);
                log(all || msg.actions.length > 1 ? msg : null, r?.i);
                return r;
            }
        });
    }
    return Object.assign(wrap, {
        needsUndo: bot.needsUndo,
        async choose(ctx) {
            const { game, pid, actions } = ctx;
            const obs = all || actions.length > 1 ? decideBody(game, pid, actions) : null;
            const a = await bot.choose(ctx);
            log(obs, actions.findIndex((x) => x === a || actionKey(game, x) === actionKey(game, a)));
            return a;
        }
    });
}

async function worker(first, count, out, botNames, all) {
    // the run key comes over IPC, not argv or the environment, which the bot programs could read
    const key = process.send ? await new Promise((resolve) => process.once('message', (m) => resolve(m.key))) : runKey(arg('key', null));
    const { Env } = require('../env');
    const { playGame } = require('../match');
    const env = new Env();
    // a rerun of the same seed range replaces the shard instead of appending duplicate games
    fs.writeFileSync(out, '');
    // one gzip member per game, appended synchronously: the file is readable while it grows,
    // and nothing piles up in memory (the engine rarely yields to the event loop)
    let lines = [];
    const write = (o) => lines.push(JSON.stringify(o));
    const flush = () => {
        fs.appendFileSync(out, zlib.gzipSync(`${lines.join('\n')}\n`));
        lines = [];
    };
    const raw = [];
    botNames.forEach((n) => raw.push(makeBot(n, raw)));
    const bots = raw.map((b) => recording(b, write, all));
    let wins = { p1: 0, p2: 0 };
    for (let seed = first; seed < first + count; seed++) {
        // alternate seats so each bot plays both sides
        const seats = (seed % 2 === 0) ? [bots[0], bots[1]] : [bots[1], bots[0]];
        seats.forEach((b) => b.reset());
        write({ t: 'game', seed, bots: seats.map((b) => b.name) });
        const r = await playGame(env, { seed, bots: seats, key: key && gameKey(key, seed) });
        // a forfeit (ERROR, `by` the seat that broke it) was not played out, so it has no winner here
        write({ t: 'end', seed, winner: r.outcome === 'won' ? r.winner : null, outcome: r.outcome, round: r.round, steps: r.steps, error: r.error ?? null, by: r.by ?? null, ...(r.key ? { key: r.key } : {}) });
        if (r.outcome === 'won' && (r.winner === 'p1' || r.winner === 'p2')) {
            wins[r.winner]++;
        }
        flush();
        process.send?.({ done: 1, outcome: r.outcome });
    }
    await closeBots();
    return wins;
}

async function main() {
    const games = Number(arg('games', 100));
    const seed = Number(arg('seed', 100000));
    const workers = Number(arg('workers', 1));
    const out = path.resolve(arg('out', 'data/traj/random'));
    const botNames = arg('bots', 'random-a,random-b').split(',');
    const all = process.argv.includes('--all');
    const key = runKey(arg('key', null));
    fs.mkdirSync(out, { recursive: true });
    if (process.argv.includes('--worker')) {
        await worker(Number(arg('first')), Number(arg('count')), arg('file'), botNames, all);
        process.exit(0);
    }
    const per = Math.ceil(games / workers);
    const t0 = Date.now();
    let done = 0;
    const outcomes = {};
    const procs = [];
    for (let k = 0; k < workers; k++) {
        const first = seed + k * per;
        const count = Math.min(per, seed + games - first);
        if (count <= 0) {
            break;
        }
        const file = path.join(out, `shard-${first}.jsonl.gz`);
        const args = ['--worker', '--first', String(first), '--count', String(count), '--file', file, '--bots', botNames.join(','), '--out', out];
        if (all) {
            args.push('--all');
        }
        const p = fork(__filename, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        p.send({ key });
        p.on('message', (m) => {
            done += m.done;
            outcomes[m.outcome] = (outcomes[m.outcome] ?? 0) + 1;
            if (done % 50 === 0 || done === games) {
                const s = (Date.now() - t0) / 1000;
                console.log(`${done}/${games} games, ${(done / s).toFixed(2)} games/s, ${JSON.stringify(outcomes)}`);
            }
        });
        procs.push(new Promise((res, rej) => p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`collect worker for seeds ${first}.. exited with code ${code}`))))));
    }
    await Promise.all(procs);
    console.log(`wrote ${out} in ${((Date.now() - t0) / 1000).toFixed(0)}s ${JSON.stringify(outcomes)}${key ? ` (run key ${key})` : ''}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
