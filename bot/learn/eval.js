'use strict';
// node bot/learn/eval.js --bots rust-learned,random-a --games 200 [--seed 500000] [--workers 4] [--out results/learned-vs-random] [--record]
//
// Head-to-head match between two bots, games split over worker processes, seats alternating by seed.
// Prints the win rate with a 95% interval and, with --out, writes a tournament index.json (the format
// bot/tournament.js writes, so the viewer and the research dashboard read it unchanged), plus replays
// with --record.
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const { makeBot } = require('../players');

async function worker() {
    const { Env } = require('../env');
    const { playGame } = require('../match');
    const { snapshot } = require('../recorder');
    const names = arg('bots').split(',');
    const first = Number(arg('first'));
    const count = Number(arg('count'));
    const out = arg('out', null);
    const env = new Env();
    const bots = names.map(makeBot);
    for (let seed = first; seed < first + count; seed++) {
        const seats = seed % 2 === 0 ? [0, 1] : [1, 0];
        const id = `${names[seats[0]]}-vs-${names[seats[1]]}-${seed}`;
        let onEvent = null;
        if (out && process.argv.includes('--record')) {
            const file = path.join(out, 'games', `${id}.jsonl`);
            fs.writeFileSync(file, '');
            onEvent = (e) => fs.appendFileSync(file, `${JSON.stringify(e)}\n`);
        }
        process.send({ start: { id, seed, p1: names[seats[0]], p2: names[seats[1]] } });
        const r = await playGame(env, { seed, bots: seats.map((k) => bots[k]), record: !!onEvent, snapshot, onEvent });
        const winner = r.winner === 'p1' ? names[seats[0]] : r.winner === 'p2' ? names[seats[1]] : r.winner;
        process.send({ done: { id, seed, p1: names[seats[0]], p2: names[seats[1]], winner, winnerSeat: r.winner, rounds: r.round, steps: r.steps, outcome: r.outcome, error: r.error ?? null, ms: r.ms, timing: r.timing } });
    }
    process.exit(0);
}

function wilson(k, n) {
    if (!n) {
        return [0, 1];
    }
    const z = 1.96;
    const p = k / n;
    const d = 1 + (z * z) / n;
    const c = (p + (z * z) / (2 * n)) / d;
    const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    return [c - h, c + h];
}

async function main() {
    if (process.argv.includes('--worker')) {
        return worker();
    }
    const names = arg('bots', 'rust-learned,random-a').split(',');
    const games = Number(arg('games', 100));
    const seed = Number(arg('seed', 500000));
    const workers = Number(arg('workers', 4));
    const out = arg('out', null) && path.resolve(arg('out'));
    const record = process.argv.includes('--record');
    const index = { id: out ? path.basename(out) : 'eval', createdAt: new Date().toISOString(), engine: null, bots: names, gamesPerPairing: games, games: [] };
    if (out) {
        fs.mkdirSync(path.join(out, 'games'), { recursive: true });
    }
    const write = () => {
        if (out) {
            fs.writeFileSync(path.join(out, 'index.json.tmp'), JSON.stringify(index));
            fs.renameSync(path.join(out, 'index.json.tmp'), path.join(out, 'index.json'));
        }
    };
    const per = Math.ceil(games / workers);
    const wins = Object.fromEntries(names.map((n) => [n, 0]));
    let done = 0;
    let other = 0;
    const t0 = Date.now();
    const procs = [];
    for (let k = 0; k < workers; k++) {
        const first = seed + k * per;
        const count = Math.min(per, seed + games - first);
        if (count <= 0) {
            break;
        }
        const args = ['--worker', '--bots', names.join(','), '--first', String(first), '--count', String(count)];
        if (out) {
            args.push('--out', out);
        }
        if (record) {
            args.push('--record');
        }
        const p = fork(__filename, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        p.on('message', (m) => {
            if (m.start) {
                index.games.push({ ...m.start, winner: null, winnerSeat: null, rounds: 0, steps: 0, outcome: 'running', error: null, ms: 0 });
                write();
                return;
            }
            const g = m.done;
            Object.assign(index.games.find((x) => x.id === g.id), g);
            write();
            done++;
            if (g.winner in wins) {
                wins[g.winner]++;
            } else {
                other++;
            }
            if (done % 10 === 0 || done === games) {
                const [lo, hi] = wilson(wins[names[0]], done);
                console.log(`${done}/${games}  ${names[0]} ${wins[names[0]]} - ${wins[names[1]]} ${names[1]} (${other} other)  win rate ${(wins[names[0]] / done).toFixed(3)} [${lo.toFixed(3)}, ${hi.toFixed(3)}]  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
            }
        });
        procs.push(new Promise((res) => p.on('exit', res)));
    }
    await Promise.all(procs);
    const [lo, hi] = wilson(wins[names[0]], done);
    const summary = { bots: names, games: done, wins, other, winRate: wins[names[0]] / Math.max(1, done), ci95: [lo, hi], secs: (Date.now() - t0) / 1000 };
    console.log(JSON.stringify(summary));
    if (out) {
        fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
