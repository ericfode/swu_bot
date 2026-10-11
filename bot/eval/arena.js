'use strict';
/**
 * Parallel round-robin runner for evaluator research. Same game loop (bot/match.js) and output format as
 * bot/tournament.js, spread over several processes.
 *
 *   node bot/eval/arena.js --bots random,heuristic,h@linear --games 20 --seed 1000 --out <dir> [--workers 4]
 *                          [--record full|positions|none] [--every 1] [--maxSteps 3000]
 *
 * Writes <out>/index.json (tournament index, updated live, readable by the viewer and the research dashboard),
 * <out>/games/<id>.jsonl (full replays, with --record full), <out>/decks.jsonl (both decklists per game) and,
 * with --record full|positions, <out>/positions/<shard>.jsonl: one line per checkpoint (the state just before
 * an action-window decision; --every N keeps every Nth) plus the game result, which is the training and test data for evaluators.
 *
 * Bot names: random*, heuristic (shipped evaluator), heuristic-d2, h@<evaluator>, h2@<evaluator>.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const writeJson = (file, obj) => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(obj));
    fs.renameSync(`${file}.tmp`, file);
};

function schedule(names, perPair, seed0) {
    const jobs = [];
    let seed = seed0;
    for (let a = 0; a < names.length; a++) {
        for (let b = a + 1; b < names.length; b++) {
            for (let k = 0; k < perPair; k++, seed++) {
                const seats = k % 2 === 1 ? [names[b], names[a]] : [names[a], names[b]];
                jobs.push({ seed, seats, id: `${seats[0]}-vs-${seats[1]}-${seed}` });
            }
        }
    }
    // a self-pairing ("h@x,h@x") plays mirror games
    if (names.length === 1) {
        for (let k = 0; k < perPair; k++, seed++) {
            jobs.push({ seed, seats: [names[0], names[0]], id: `${names[0]}-vs-${names[0]}-${seed}` });
        }
    }
    return jobs;
}

/** The bots for one game; a bot program is handed out once per seat (see makeBot in bot/players/index.js). */
function seatBots(names) {
    const { makeBot } = require('../players');
    const bots = [];
    names.forEach((n) => bots.push(makeBot(n, bots)));
    return bots;
}

async function worker(out, shard, shards, jobs, record, maxSteps, every) {
    const { Env, seededRng } = require('../env');
    const { playGame } = require('../match');
    const { snapshot } = require('../recorder');
    const env = new Env();
    env.engineRev = engineRev();
    const mine = jobs.filter((_, i) => i % shards === shard);
    const part = path.join(out, 'parts', `${shard}.json`);
    const done = [];
    const posFile = path.join(out, 'positions', `${shard}.jsonl`);
    for (const job of mine) {
        // same deck draw as match.js, so the decklists can be stored next to the result
        const rng = seededRng('bot' + job.seed);
        const decks = { p1: env.randomDeck(rng), p2: env.randomDeck(rng) };
        const flat = (d) => d.deck.flatMap((c) => Array(c.count).fill(c.id));
        const entry = { id: job.id, seed: job.seed, p1: job.seats[0], p2: job.seats[1], winner: null, winnerSeat: null, rounds: 0, steps: 0, outcome: 'running', error: null, ms: 0 };
        writeJson(part, [...done, entry]);
        const file = path.join(out, 'games', `${job.id}.jsonl`);
        if (record === 'full') {
            fs.writeFileSync(file, '');
        }
        const positions = [];
        let prev = null;
        let seen = 0;
        const onEvent = (e) => {
            if (record === 'full') {
                fs.appendFileSync(file, `${JSON.stringify(e)}\n`);
            }
            if (e.t !== 'step') {
                return;
            }
            // checkpoint: the position right before an action-window decision, with who is about to act
            if (prev && e.prompt?.startsWith('actionWindow') && prev.state.phase === 'action' && seen++ % every === 0) {
                positions.push({ n: prev.n, round: prev.state.round, toAct: e.pid, state: prev.state });
            }
            prev = e;
        };
        const r = await playGame(env, { seed: job.seed, bots: seatBots(job.seats), record: record !== 'none', snapshot, maxSteps, onEvent: record === 'none' ? null : onEvent });
        r.events = null;
        const winnerBot = r.winner === 'p1' ? job.seats[0] : r.winner === 'p2' ? job.seats[1] : r.winner;
        Object.assign(entry, { winner: winnerBot, winnerSeat: r.winner, rounds: r.round, steps: r.steps, outcome: r.outcome, error: r.error ?? null, by: r.by ?? null, ms: r.ms });
        if (r.botStats?.some(Boolean)) {
            entry.botStats = r.botStats;
        }
        done.push(entry);
        writeJson(part, done);
        fs.appendFileSync(path.join(out, 'decks', `${shard}.jsonl`), `${JSON.stringify({ id: job.id, seed: job.seed, p1: flat(decks.p1), p2: flat(decks.p2), names: [decks.p1.metadata.name, decks.p2.metadata.name] })}\n`);
        if (record !== 'none' && positions.length) {
            const lines = positions.map((p) => JSON.stringify({ id: job.id, winner: r.winner, outcome: r.outcome, ...p }));
            fs.appendFileSync(posFile, `${lines.join('\n')}\n`);
        }
        console.log(`[${shard}] ${job.id}: ${r.outcome} ${winnerBot ?? ''} R${r.round} ${r.steps} steps ${r.ms}ms${r.error ? ' ' + r.error : ''}`);
    }
    require('../players').closeBots();
}

function engineRev() {
    try {
        return execFileSync('git', ['-C', path.join(__dirname, '..', '..', 'forceteki'), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}

async function main() {
    const names = arg('bots', 'random-a,random-b').split(',');
    const perPair = Number(arg('games', 4));
    const seed0 = Number(arg('seed', 1));
    const out = path.resolve(arg('out', 'replays/arena'));
    const workers = Number(arg('workers', 4));
    const record = arg('record', 'full');
    const maxSteps = Number(arg('maxSteps', 3000));
    const jobs = schedule(names, perPair, seed0);

    const shard = arg('shard', null);
    if (shard !== null) {
        return worker(out, Number(shard), workers, jobs, record, maxSteps, Number(arg('every', 1)));
    }

    for (const d of ['games', 'parts', 'positions', 'decks']) {
        fs.mkdirSync(path.join(out, d), { recursive: true });
    }
    // shards append, so a rerun into the same folder would duplicate positions and pick up stale index parts
    for (const d of ['parts', 'positions', 'decks']) {
        for (const f of fs.readdirSync(path.join(out, d))) {
            fs.rmSync(path.join(out, d, f), { force: true });
        }
    }
    const index = { id: path.basename(out), createdAt: new Date().toISOString(), engine: engineRev(), bots: names, gamesPerPairing: perPair, games: [] };
    const merge = () => {
        const byId = new Map();
        for (let k = 0; k < workers; k++) {
            const f = path.join(out, 'parts', `${k}.json`);
            try {
                for (const g of JSON.parse(fs.readFileSync(f, 'utf8'))) {
                    byId.set(g.id, g);
                }
            } catch {
                // shard has not written yet
            }
        }
        index.games = jobs.filter((j) => byId.has(j.id)).map((j) => byId.get(j.id));
        writeJson(path.join(out, 'index.json'), index);
    };
    merge();
    const timer = setInterval(merge, 3000);
    const procs = Array.from({ length: Math.min(workers, jobs.length) }, (_, k) => new Promise((resolve) => {
        const p = spawn(process.execPath, [__filename, ...process.argv.slice(2), '--shard', String(k), '--workers', String(workers)], { stdio: 'inherit' });
        p.on('error', (e) => resolve(`shard ${k}: ${e.message}`));
        p.on('exit', (code, signal) => resolve(code === 0 ? null : `shard ${k} exited with ${signal ?? code}`));
    }));
    const failures = (await Promise.all(procs)).filter(Boolean);
    clearInterval(timer);
    merge();
    if (failures.length) {
        console.error(`incomplete run: ${failures.join('; ')}`);
        process.exitCode = 1;
    }
    const won = index.games.filter((g) => g.outcome === 'won').length;
    console.log(`wrote ${index.games.length} games (${won} decided) to ${out}`);
}

main().catch((e) => {
    console.error(e); process.exit(1);
});
