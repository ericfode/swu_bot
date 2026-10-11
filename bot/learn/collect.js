'use strict';
// node bot/learn/collect.js --games 2000 --seed 100000 --workers 4 --out data/traj/random [--bots random,random] [--all]
//
// Plays games with the normal match loop and writes, for every decision, what a stdio bot would have seen
// (the `decide` body: prompt, state, actions) plus the action that was chosen and, at the end, who won.
// Output: <out>/shard-<k>.jsonl.gz, format "swu-traj/1" (see bot/rust-learned/README.md).
// Bots: any name tournament.js knows (random*, heuristic*), or an external bot from bot/external-bots.json
// when the stdio adapter is present.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { fork } = require('child_process');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const { observe, promptView, actionView, seatOf } = require('../observe');

/** The body of the `decide` message a stdio bot would get (built exactly as bot/players/external.js does). */
function decideBody(eg, pid, actions) {
    return { you: seatOf(eg, eg.player(pid)), prompt: promptView(eg, pid), state: observe(eg, pid), actions: actions.map((a, i) => actionView(eg, a, i)) };
}

function makeBot(name) {
    if (/^heuristic/.test(name)) {
        const { HeuristicBot } = require('../players/heuristic');
        const d = /-d(\d)/.exec(name);
        return new HeuristicBot(name, { depth: d ? Number(d[1]) : 1 });
    }
    if (/^random/.test(name)) {
        return require('../players/random').createRandomBot(name);
    }
    const reg = JSON.parse(fs.readFileSync(process.env.SWU_EXTERNAL_BOTS ?? path.join(__dirname, '..', 'external-bots.json'), 'utf8'));
    if (!reg[name]) {
        // rush, aggro, tempo, control, ... from the shared registry
        return require('../players').makeBot(name);
    }
    const { ExternalBot } = require('../players/external');
    return new ExternalBot(name, reg[name]);
}

/** Wraps a bot so every choice it makes is written as a trajectory line. */
function recording(bot, write, all) {
    let seq = 0;
    return {
        name: bot.name,
        needsUndo: bot.needsUndo,
        get stats() {
            return bot.stats;
        },
        reset() {
            seq = 0;
        },
        choose(ctx) {
            const { game, pid, actions } = ctx;
            const obs = all || actions.length > 1 ? decideBody(game, pid, actions) : null;
            const a = bot.choose(ctx);
            seq++;
            if (obs) {
                write({ t: 'd', seq, you: obs.you, prompt: obs.prompt, state: obs.state, actions: obs.actions, i: actions.indexOf(a) });
            }
            return a;
        }
    };
}

async function worker(first, count, out, botNames, all) {
    const { Env } = require('../env');
    const { playGame } = require('../match');
    const env = new Env();
    // one gzip member per game, appended synchronously: the file is readable while it grows,
    // and nothing piles up in memory (the engine rarely yields to the event loop)
    let lines = [];
    const write = (o) => lines.push(JSON.stringify(o));
    const flush = () => {
        fs.appendFileSync(out, zlib.gzipSync(`${lines.join('\n')}\n`));
        lines = [];
    };
    const bots = botNames.map((n) => recording(makeBot(n), write, all));
    let wins = { p1: 0, p2: 0 };
    for (let seed = first; seed < first + count; seed++) {
        // alternate seats so each bot plays both sides
        const seats = (seed % 2 === 0) ? [bots[0], bots[1]] : [bots[1], bots[0]];
        seats.forEach((b) => b.reset());
        write({ t: 'game', seed, bots: seats.map((b) => b.name) });
        const r = await playGame(env, { seed, bots: seats });
        write({ t: 'end', seed, winner: r.winner, outcome: r.outcome, round: r.round, steps: r.steps, error: r.error ?? null });
        if (r.winner === 'p1' || r.winner === 'p2') {
            wins[r.winner]++;
        }
        flush();
        process.send?.({ done: 1, outcome: r.outcome });
    }
    return wins;
}

async function main() {
    const games = Number(arg('games', 100));
    const seed = Number(arg('seed', 100000));
    const workers = Number(arg('workers', 1));
    const out = path.resolve(arg('out', 'data/traj/random'));
    const botNames = arg('bots', 'random-a,random-b').split(',');
    const all = process.argv.includes('--all');
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
        p.on('message', (m) => {
            done += m.done;
            outcomes[m.outcome] = (outcomes[m.outcome] ?? 0) + 1;
            if (done % 50 === 0 || done === games) {
                const s = (Date.now() - t0) / 1000;
                console.log(`${done}/${games} games, ${(done / s).toFixed(2)} games/s, ${JSON.stringify(outcomes)}`);
            }
        });
        procs.push(new Promise((res) => p.on('exit', res)));
    }
    await Promise.all(procs);
    console.log(`wrote ${out} in ${((Date.now() - t0) / 1000).toFixed(0)}s ${JSON.stringify(outcomes)}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
