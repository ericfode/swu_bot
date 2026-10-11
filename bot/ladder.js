'use strict';
/**
 * Round-robin ladder with ratings, run on worker threads.
 *
 *   node bot/ladder.js --bots rush,aggro,tempo,control,heuristic,random --games 10
 *       [--seed 1] [--workers 3] [--max-steps 6000] [--id my-run] [--out <dir>] [--record] [--vs a,b,c] [--resume]
 *       [--cap-ms 60000] [--hang-ms 600000]
 * --resume keeps the finished games of an earlier run with the same id and config and plays only the rest.
 * --cap-ms caps each bot's thinking per game (players/guard.js; default none): over it, that bot forfeits. --hang-ms is the
 * watchdog (game-pool.js): one choose() call running longer than that (wall clock) forfeits the game, and its worker is
 * replaced. A bot that fails to load or throws also forfeits; ladder.json games carry fault / faultKind.
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
const { execFileSync } = require('child_process');
const { describeBot } = require('./players');
const { roundRobin, gauntlet } = require('./ratings');
const { summarize } = require('./ladder-report');
const { runPool, killChildren } = require('./game-pool');

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

/** The games of an earlier run in the same folder, when its bots, schedule, limits and engine match this one; else null. */
function readPrevious(file, config, engine) {
    if (!fs.existsSync(file)) {
        return null;
    }
    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        console.log(`resume: ${file} is not readable JSON (${e.message.split('\n')[0]}), starting over`);
        return null;
    }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const c = doc?.config ?? {};
    // everything that changes a game's result: who plays, which seeds, the step cap, the time cap and watchdog, the engine
    if (!same(c.bots, config.bots) || c.gamesPerPair !== config.gamesPerPair || c.firstSeed !== config.firstSeed || c.maxSteps !== config.maxSteps
        || (c.capMs ?? null) !== (config.capMs ?? null) || c.hangMs !== config.hangMs || !same(c.vs ?? null, config.vs ?? null) || (doc.engine ?? null) !== engine) {
        console.log('resume: the earlier run used other bots, seeds, format, limits or engine, starting over');
        return null;
    }
    return { games: Array.isArray(doc.games) ? doc.games : [] };
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
    const capMs = arg('cap-ms') === undefined ? Infinity : Number(arg('cap-ms'));
    const hangMs = Number(arg('hang-ms', 600000));
    if (!(capMs > 0) || !(hangMs > 0)) {
        throw new Error('--cap-ms and --hang-ms must be positive numbers of milliseconds');
    }
    const createdAt = new Date().toISOString();
    const id = arg('id', `ladder-${createdAt.replace(/[:.]/g, '-').slice(0, 19)}`);
    const out = path.join(path.resolve(arg('out', defaultOut())), id);
    const record = process.argv.includes('--record');
    fs.mkdirSync(path.join(out, 'games'), { recursive: true });

    const engine = engineRev();
    const schedule = vs ? gauntlet(challengers, vs, perPair, firstSeed) : roundRobin(names, perPair, firstSeed);
    // capMs null = no cap (JSON has no Infinity)
    const config = { bots: names, gamesPerPair: perPair + (perPair % 2), firstSeed, maxSteps, workers, capMs: Number.isFinite(capMs) ? capMs : null, hangMs,
                     ...(vs ? { format: 'gauntlet', vs } : {}) };
    const games = [];
    let status = 'running';
    const prev = process.argv.includes('--resume') ? readPrevious(path.join(out, 'ladder.json'), config, engine) : null;
    const save = () => {
        const doc = summarize({ id, createdAt, status, engine, config, botInfo, games, scheduled: schedule.length });
        writeJson(path.join(out, 'ladder.json'), doc);
        writeJson(path.join(out, 'index.json'), tIndex);
        return doc;
    };
    // tournament.js-format index (TournamentIndex in viewer/src/core/types.ts)
    const tIndex = { id, createdAt, engine, bots: names, gamesPerPairing: config.gamesPerPair, games: [] };
    let queue = schedule.map((s) => ({ ...s, id: `${s.p1}-vs-${s.p2}-${s.seed}` }));
    if (prev) {
        const kept = prev.games.filter((g) => g?.id && g.outcome !== 'running' && queue.some((q) => q.id === g.id));
        games.push(...kept);
        tIndex.games.push(...kept.map(({ botStats, timing, think, ...g }) => g));
        queue = queue.filter((q) => !kept.some((g) => g.id === q.id));
        console.log(`${id}: resuming, ${kept.length} games already played`);
    }
    save();
    console.log(`${id}: ${queue.length} of ${schedule.length} games to play, ${names.length} bots, ${workers} workers -> ${out}`);

    const t0 = Date.now();
    await runPool(queue, {
        workers,
        hangMs,
        workerData: { maxSteps, engineRev: engine, capMs },
        onStart: (job) => {
            const entry = { id: job.id, seed: job.seed, p1: job.p1, p2: job.p2, winner: null, winnerSeat: null, outcome: 'running', rounds: 0, steps: 0, ms: 0, error: null, fault: null, faultKind: null };
            games.push(entry);
            tIndex.games.push({ ...entry });
            if (record) {
                job.replayFile = path.join(out, 'games', `${job.id}.jsonl`);
            }
            save();
        },
        onResult: ({ job, result: r }) => {
            const done = {
                winner: r.winner ?? null, winnerSeat: r.winnerSeat ?? null, outcome: r.outcome, rounds: r.round, steps: r.steps, ms: r.ms, error: r.error ?? null,
                fault: r.fault ?? null, faultKind: r.faultKind ?? null
            };
            Object.assign(games.find((g) => g.id === job.id), done, { timing: r.timing ?? null, think: r.think ?? null, botStats: r.botStats });
            Object.assign(tIndex.games.find((g) => g.id === job.id), done);
            const doc = save();
            const top = doc.bots.slice(0, 3).map((b) => `${b.name} ${b.btElo}`).join(', ');
            const fault = r.fault ? ` (${r.fault} ${r.faultKind})` : '';
            console.log(`[${doc.progress.finished}/${schedule.length}] ${job.id}: ${r.outcome}${fault} ${r.winner ?? ''} R${r.round} ${r.steps} steps ${r.ms}ms${r.error ? ' ' + r.error : ''} | ${top}`);
        }
    });
    status = 'done';
    const doc = save();
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    for (const b of doc.bots) {
        console.log(`${b.name.padEnd(14)} BT ${String(b.btElo).padStart(5)}  Elo ${String(b.elo).padStart(5)}  ${b.wins}-${b.losses}-${b.draws}  incomplete ${b.incomplete}  forfeits ${b.forfeits}  ${b.winRate === null ? '' : (b.winRate * 100).toFixed(0) + '%'}`);
    }
}

// exit explicitly: a worker retired by the watchdog may still be stuck in a bot's synchronous call
main().then(() => {
    killChildren();
    process.exit(0);
}, (e) => {
    killChildren();
    console.error(e);
    process.exit(1);
});
