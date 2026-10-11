'use strict';
/**
 * Parallel round-robin over bot names, in the tournament format (index.json + games/<id>.jsonl when --record).
 *
 *   node bot/learned/arena.js --bots learned-pi,random --games 40 --workers 4 --seed 50000 [--out results/x] [--record]
 *
 * Same seats, seeds and game ids as bot/tournament.js (first seat alternates; seed increments per game), but games run
 * in --workers child processes. Also writes <out>/ladder.json (a subset of the swu-ladder/1 schema: status, config,
 * progress, bots, pairs, eloHistory) so the research dashboard can show standings while it runs.
 */
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

async function worker() {
    const { Env } = require('../env');
    const { playGame } = require('../match');
    const { snapshot } = require('../recorder');
    const { makeBot } = require('./registry');
    const env = new Env();
    process.on('message', async (job) => {
        if (job === 'stop') {
            process.exit(0);
        }
        const file = job.file;
        if (file) {
            fs.writeFileSync(file, '');
        }
        const r = await playGame(env, {
            seed: job.seed, bots: job.seats.map(makeBot), record: !!file, snapshot,
            onEvent: file ? (e) => fs.appendFileSync(file, `${JSON.stringify(e)}\n`) : null
        });
        delete r.events;
        process.send({ id: job.id, r });
    });
    process.send({ ready: true });
}

function elo(games, names) {
    const R = Object.fromEntries(names.map((n) => [n, 1500]));
    const hist = [];
    for (const g of games) {
        if (g.outcome !== 'won') {
            continue;
        }
        const ea = 1 / (1 + 10 ** ((R[g.p2] - R[g.p1]) / 400));
        const sa = g.winnerSeat === 'p1' ? 1 : g.winnerSeat === 'p2' ? 0 : 0.5;
        R[g.p1] += 24 * (sa - ea);
        R[g.p2] -= 24 * (sa - ea);
        hist.push({ n: hist.length + 1, ...Object.fromEntries(names.map((n) => [n, Math.round(R[n])])) });
    }
    return { R, hist };
}

function ladder(index, cfg, status) {
    const names = index.bots;
    const games = index.games;
    const fin = games.filter((g) => g.outcome !== 'running' && g.outcome !== 'queued');
    const { R, hist } = elo(fin, names);
    const bots = names.map((name) => {
        const mine = fin.filter((g) => g.p1 === name || g.p2 === name);
        const won = mine.filter((g) => g.outcome === 'won');
        const wins = won.filter((g) => g.winner === name).length;
        const draws = won.filter((g) => g.winner === 'draw').length;
        const rated = won.length;
        const wr = rated ? (wins + draws / 2) / rated : 0;
        const ci = rated ? 1.96 * Math.sqrt((wr * (1 - wr)) / rated) : 0;
        return {
            name, kind: /^learned/.test(name) ? 'learned' : /^heuristic/.test(name) ? 'heuristic' : 'random', games: mine.length, wins, losses: rated - wins - draws, draws,
            incomplete: mine.length - rated, asP1: mine.filter((g) => g.p1 === name).length, winRate: wr, winRateCI95: [Math.max(0, wr - ci), Math.min(1, wr + ci)], elo: Math.round(R[name])
        };
    }).sort((a, b) => b.elo - a.elo);
    const pairs = [];
    for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
            const [a, b] = [names[i], names[j]];
            const gs = fin.filter((g) => (g.p1 === a && g.p2 === b) || (g.p1 === b && g.p2 === a));
            const aWins = gs.filter((g) => g.winner === a).length, bWins = gs.filter((g) => g.winner === b).length;
            const draws = gs.filter((g) => g.winner === 'draw').length;
            pairs.push({ a, b, games: gs.length, aWins, bWins, draws, incomplete: gs.length - aWins - bWins - draws, aScore: aWins + bWins + draws ? (aWins + draws / 2) / (aWins + bWins + draws) : null });
        }
    }
    const outcomes = { won: 0, ERROR: 0, STUCK: 0, STEP_CAP: 0 };
    fin.forEach((g) => {
        outcomes[g.outcome] = (outcomes[g.outcome] ?? 0) + 1;
    });
    const wonGames = fin.filter((g) => g.outcome === 'won');
    return {
        schema: 'swu-ladder/1', status, config: cfg,
        progress: { scheduled: games.length, finished: fin.length, rated: wonGames.length, outcomes, firstSeatWinRate: wonGames.length ? wonGames.filter((g) => g.winnerSeat === 'p1').length / wonGames.length : null },
        bots, pairs, eloHistory: hist, games: fin
    };
}

async function main() {
    const names = arg('bots', 'learned-pi,random').split(',');
    const perPair = Number(arg('games', 10));
    const workers = Number(arg('workers', 4));
    const seed0 = Number(arg('seed', 1));
    const outArg = arg('out', null);
    const record = process.argv.includes('--record');
    const out = outArg ? path.resolve(outArg) : null;
    if (out) {
        fs.mkdirSync(path.join(out, 'games'), { recursive: true });
    }
    const index = { id: out ? path.basename(out) : 'arena', createdAt: new Date().toISOString(), engine: null, bots: names, gamesPerPairing: perPair, games: [] };
    const cfg = { bots: names, gamesPerPair: perPair, firstSeed: seed0, maxSteps: 6000, workers, model: process.env.SWU_LEARNED_MODEL ?? 'models/learned/current.json' };
    const jobs = [];
    let seed = seed0;
    for (let a = 0; a < names.length; a++) {
        for (let b = a + 1; b < names.length; b++) {
            for (let k = 0; k < perPair; k++, seed++) {
                const seats = k % 2 === 1 ? [names[b], names[a]] : [names[a], names[b]];
                const id = `${seats[0]}-vs-${seats[1]}-${seed}`;
                jobs.push({ id, seed, seats, file: out && record ? path.join(out, 'games', `${id}.jsonl`) : null });
            }
        }
    }
    const write = (status) => {
        if (!out) {
            return;
        }
        const tmp = (f) => `${f}.tmp`;
        const idx = { ...index, games: index.games.filter((g) => g.outcome !== 'queued') };
        fs.writeFileSync(tmp(path.join(out, 'index.json')), JSON.stringify(idx));
        fs.renameSync(tmp(path.join(out, 'index.json')), path.join(out, 'index.json'));
        fs.writeFileSync(tmp(path.join(out, 'ladder.json')), JSON.stringify(ladder(idx, cfg, status)));
        fs.renameSync(tmp(path.join(out, 'ladder.json')), path.join(out, 'ladder.json'));
    };
    const entries = new Map();
    for (const j of jobs) {
        const e = { id: j.id, seed: j.seed, p1: j.seats[0], p2: j.seats[1], winner: null, winnerSeat: null, rounds: 0, steps: 0, outcome: 'queued', error: null, ms: 0 };
        entries.set(j.id, e);
        index.games.push(e);
    }
    let next = 0;
    let done = 0;
    await new Promise((resolve) => {
        const n = Math.min(workers, jobs.length);
        for (let w = 0; w < n; w++) {
            const child = fork(__filename, ['--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
            const give = () => {
                if (next >= jobs.length) {
                    child.send('stop');
                    return;
                }
                const j = jobs[next++];
                entries.get(j.id).outcome = 'running';
                write('running');
                child.send(j);
            };
            child.on('message', (m) => {
                if (m.ready) {
                    give();
                    return;
                }
                const e = entries.get(m.id);
                const j = jobs.find((x) => x.id === m.id);
                const r = m.r;
                const winnerBot = r.winner === 'p1' ? j.seats[0] : r.winner === 'p2' ? j.seats[1] : r.winner;
                Object.assign(e, { winner: winnerBot, winnerSeat: r.winner, rounds: r.round, steps: r.steps, outcome: r.outcome, error: r.error ?? null, ms: r.ms, botStats: r.botStats });
                done++;
                console.log(`[${done}/${jobs.length}] ${m.id}: ${r.outcome} ${winnerBot ?? ''} R${r.round} ${r.steps} steps ${(r.ms / 1000).toFixed(1)}s${r.error ? ' ' + r.error : ''}`);
                write(done === jobs.length ? 'done' : 'running');
                if (done === jobs.length) {
                    resolve();
                }
                give();
            });
        }
    });
    const L = ladder(index, cfg, 'done');
    for (const b of L.bots) {
        console.log(`${b.name.padEnd(14)} elo ${b.elo}  ${b.wins}-${b.losses}-${b.draws}  win rate ${(b.winRate * 100).toFixed(0)}% [${(b.winRateCI95[0] * 100).toFixed(0)}-${(b.winRateCI95[1] * 100).toFixed(0)}]  incomplete ${b.incomplete}`);
    }
}

if (process.argv.includes('--worker')) {
    worker();
} else {
    main().catch((e) => {
        console.error(e); process.exit(1);
    });
}
