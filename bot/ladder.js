'use strict';
/**
 * Round-robin ladder with ratings, run on worker threads.
 *
 *   node bot/ladder.js --bots rush,aggro,tempo,control,heuristic,random --games 10
 *       [--seed 1] [--workers 3] [--max-steps 6000] [--id my-run] [--out <dir>] [--record] [--vs a,b,c]
 *
 * Each pair plays `--games` games (rounded up to even): every seed twice, once from each seat, so random-deck luck
 * cancels out. Everything goes in <out>/<id>/, rewritten atomically after every finished game:
 *   index.json   the same tournament index tournament.js writes (viewer and dashboard read it as is)
 *   ladder.json  the full report (schema "swu-ladder/1", see ladder-report.js): ratings, CIs, pair matrix, Elo history
 *   games/       per-game recordings (<id>.jsonl, same format as tournament.js), only with --record
 * --vs a,b,c makes it a gauntlet: each --bots entry plays each --vs entry (and --bots entries do not play each
 * other). Every challenger gets the same seeds, so a parameter sweep compares variants on the same decks.
 * --out defaults to /mnt/project-files/results when that folder exists, else results/ in the repo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { execFileSync } = require('child_process');
const { describeBot } = require('./players');
const { roundRobin, gauntlet } = require('./ratings');
const { summarize } = require('./ladder-report');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

function engineRev() {
    try {
        return execFileSync('git', ['-C', path.join(__dirname, '..', 'forceteki'), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}

function writeJson(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
}

function defaultOut() {
    return fs.existsSync('/mnt/project-files') ? '/mnt/project-files/results' : path.join(__dirname, '..', 'results');
}

async function main() {
    const challengers = arg('bots', 'rush,aggro,tempo,control,heuristic,random').split(',');
    const vs = arg('vs', null)?.split(',') ?? null;
    const names = vs ? [...challengers, ...vs] : challengers;
    if (new Set(names).size !== names.length) {
        throw new Error('bot names must be unique (use name#2 to enter the same bot twice)');
    }
    const botInfo = {};
    for (const n of names) {
        botInfo[n] = describeBot(n);
        if (!botInfo[n]) {
            throw new Error(`unknown bot "${n}"`);
        }
        delete botInfo[n].name;
    }
    const perPair = Number(arg('games', 10));
    const firstSeed = Number(arg('seed', 1));
    const maxSteps = Number(arg('max-steps', 6000));
    const workers = Math.max(1, Number(arg('workers', Math.max(1, os.cpus().length - 1))));
    const createdAt = new Date().toISOString();
    const id = arg('id', `ladder-${createdAt.replace(/[:.]/g, '-').slice(0, 19)}`);
    const out = path.join(path.resolve(arg('out', defaultOut())), id);
    const record = process.argv.includes('--record');
    fs.mkdirSync(path.join(out, 'games'), { recursive: true });

    const engine = engineRev();
    const schedule = vs ? gauntlet(challengers, vs, perPair, firstSeed) : roundRobin(names, perPair, firstSeed);
    const config = { bots: names, gamesPerPair: perPair + (perPair % 2), firstSeed, maxSteps, workers, ...(vs ? { format: 'gauntlet', vs } : {}) };
    const games = [];
    let status = 'running';
    const save = () => {
        const doc = summarize({ id, createdAt, status, engine, config, botInfo, games, scheduled: schedule.length });
        writeJson(path.join(out, 'ladder.json'), doc);
        writeJson(path.join(out, 'index.json'), tIndex);
        return doc;
    };
    // tournament.js-format index (TournamentIndex in viewer/src/core/types.ts)
    const tIndex = { id, createdAt, engine, bots: names, gamesPerPairing: config.gamesPerPair, games: [] };
    save();
    console.log(`${id}: ${schedule.length} games, ${names.length} bots, ${workers} workers -> ${out}`);

    const queue = schedule.map((s) => ({ ...s, id: `${s.p1}-vs-${s.p2}-${s.seed}` }));
    const t0 = Date.now();
    await new Promise((resolve, reject) => {
        let live = 0;
        const feed = (w) => {
            const job = queue.shift();
            if (!job) {
                w.postMessage('exit');
                return;
            }
            const entry = { id: job.id, seed: job.seed, p1: job.p1, p2: job.p2, winner: null, winnerSeat: null, outcome: 'running', rounds: 0, steps: 0, ms: 0, error: null };
            games.push(entry);
            tIndex.games.push({ ...entry });
            if (record) {
                job.replayFile = path.join(out, 'games', `${job.id}.jsonl`);
            }
            save();
            w.postMessage(job);
        };
        for (let i = 0; i < Math.min(workers, queue.length); i++) {
            live++;
            const w = new Worker(path.join(__dirname, 'ladder-worker.js'), { workerData: { maxSteps, engineRev: engine } });
            w.on('message', (msg) => {
                if (msg.ready) {
                    feed(w);
                    return;
                }
                const { job, result: r } = msg;
                const winner = r.winner === 'p1' ? job.p1 : r.winner === 'p2' ? job.p2 : r.winner;
                const done = { winner, winnerSeat: r.winner, outcome: r.outcome, rounds: r.round, steps: r.steps, ms: r.ms, error: r.error ?? null, by: r.by ?? null, timing: r.timing };
                Object.assign(games.find((g) => g.id === job.id), done, { botStats: r.botStats });
                Object.assign(tIndex.games.find((g) => g.id === job.id), done);
                const doc = save();
                const top = doc.bots.slice(0, 3).map((b) => `${b.name} ${b.btElo}`).join(', ');
                console.log(`[${doc.progress.finished}/${schedule.length}] ${job.id}: ${r.outcome} ${winner ?? ''} R${r.round} ${r.steps} steps ${r.ms}ms${r.error ? ' ' + r.error : ''} | ${top}`);
                feed(w);
            });
            w.on('error', reject);
            w.on('exit', () => {
                if (--live === 0) {
                    resolve();
                }
            });
        }
        if (!queue.length) {
            resolve();
        }
    });
    status = 'done';
    const doc = save();
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    for (const b of doc.bots) {
        console.log(`${b.name.padEnd(14)} BT ${String(b.btElo).padStart(5)}  Elo ${String(b.elo).padStart(5)}  ${b.wins}-${b.losses}-${b.draws}  incomplete ${b.incomplete}  ${b.winRate === null ? '' : (b.winRate * 100).toFixed(0) + '%'}`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
