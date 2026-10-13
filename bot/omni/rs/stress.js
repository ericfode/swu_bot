#!/usr/bin/env node
'use strict';
// Stress test of the Rust simulator against forceteki: bots play real games through the referee (bot/match.js) while
// the Rust engine follows every real move and a sample of the moves bots try in their simulations (bot/omni/rs/mirror.js).
// forceteki decides every game; the Rust side only checks. Each disagreement is written with a trace file that
// `omni-rs check` reproduces on its own.
//
//   node bot/omni/rs/stress.js --bots heuristic,aggro,control,rust-search,node-search --seeds 1-4 \
//       --pool bot/omni/rs/pool.json --out replays/omni-rs-stress [--sim-every 10] [--workers 3] [--key none]
// --selection-toggles plays forceteki with env.js's opt-in select-card rule, which a Rust engine built for it follows.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { fork } = require('child_process');

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? fallback : process.argv[i + 1];
};

/** Every unordered pair once per seed; seats swap on odd seeds. */
function jobs(bots, seeds) {
    const out = [];
    for (let i = 0; i < bots.length; i++) {
        for (let j = i + 1; j < bots.length; j++) {
            for (const seed of seeds) out.push({ bots: seed % 2 ? [bots[j], bots[i]] : [bots[i], bots[j]], seed });
        }
    }
    return out;
}

async function worker(id, list, opts) {
    const { Env, seededRng } = require('../../env');
    const { playGame } = require('../../match');
    const { makeBot, closeBots } = require('../../players');
    const { loadPool } = require('./pool');
    const { createSimulator } = require('../wasm/node');
    const { RustMirror } = require('./mirror');
    const { RustViews } = require('./rust-view');
    const pool = loadPool(opts.pool);
    const views = opts.views ? new RustViews(pool) : null;
    const simulator = await createSimulator({ poolPath: pool.provenance.path });
    const env = new Env();
    const findingsDir = path.join(opts.out, 'findings');
    fs.mkdirSync(findingsDir, { recursive: true });
    const log = fs.openSync(path.join(opts.out, `games-${id}.jsonl`), 'a');
    for (const job of list) {
        const tag = `${job.bots.join('-vs-')}-${job.seed}`;
        const game = { bots: job.bots, seed: job.seed, findings: [], real: null, sims: { lines: 0, decisions: 0, windows: 0, skipped: 0 }, mirrorErrors: 0 };
        // decks dealt here (not by playGame) so the repro header can carry them
        const rng = seededRng(`stress${job.seed}`);
        const decks = { p1: env.randomDeck(rng, { pool }), p2: env.randomDeck(rng, { pool }) };
        const meta = { pool: pool.provenance, seed: job.seed, bots: job.bots, decks: [decks.p1, decks.p2] };
        let n = 0;
        const report = (f) => {
            const file = `${tag}-${++n}`;
            const { repro, ...rest } = f;
            if (repro.length) fs.writeFileSync(path.join(findingsDir, `${file}.jsonl.gz`), zlib.gzipSync(repro.map((r) => JSON.stringify(r)).join('\n') + '\n'));
            game.findings.push({ file, ...rest });
        };
        // a bug in the checker must never change the game: it is counted and that line stops being checked
        const guard = (mirror) => {
            const call = (fn) => (...a) => {
                if (!mirror.dead) {
                    try {
                        fn.apply(mirror, a);
                    } catch (e) {
                        mirror.dead = true;
                        game.mirrorErrors++;
                        game.findings.push({ kind: 'mirror-error', source: mirror.source, error: String(e.stack || e).split('\n').slice(0, 3).join(' | ') });
                    }
                }
            };
            return { pre: call(mirror.pre), post: call(mirror.post), end: call(mirror.end), mirror };
        };
        let simCount = 0;
        let real = null;
        const watch = {
            pre: (...a) => {
                real ??= guard(new RustMirror(simulator, { meta, report, source: 'game', views }));
                real.pre(...a);
            },
            post: (...a) => real?.post(...a),
            end: (...a) => real?.end(...a),
            sim: opts.simEvery > 0 ? () => {
                if (simCount++ % opts.simEvery) return null;
                const m = guard(new RustMirror(simulator, { meta, report, source: 'sim', views }));
                const end = m.end;
                m.end = (...a) => {
                    end(...a);
                    const s = m.mirror.stats;
                    game.sims.lines++;
                    game.sims.decisions += s.decisions;
                    game.sims.windows += s.windows;
                    if (s.skipped) game.sims.skipped++;
                };
                return m;
            } : null
        };
        const bots = job.bots.map((name) => makeBot(name));
        const res = await playGame(env, { seed: job.seed, bots, decks, key: opts.key, watch, limits: opts.limits, engine: opts.engine });
        const s = real?.mirror.stats;
        game.real = s ? { decisions: s.decisions, windows: s.windows, loads: s.loads, skipped: s.skipped } : null;
        Object.assign(game, { outcome: res.outcome, winner: res.winner, steps: res.steps, round: res.round, error: res.error ?? null, by: res.by ?? null, ms: res.ms });
        fs.writeSync(log, JSON.stringify(game) + '\n');
        const found = game.findings.length ? ` FINDINGS ${game.findings.map((f) => f.kind).join(',')}` : '';
        console.log(`[w${id}] ${tag}: ${res.outcome} ${res.winner ?? '-'} steps ${res.steps}, checked ${game.real?.decisions ?? 0} moves + ${game.sims.decisions} sim moves${found}`);
    }
    fs.closeSync(log);
    await closeBots();
    simulator.free();
}

function summarize(out) {
    const games = fs.readdirSync(out).filter((f) => /^games-\d+\.jsonl$/.test(f))
        .flatMap((f) => fs.readFileSync(path.join(out, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
    const sum = (f) => games.reduce((n, g) => n + (f(g) ?? 0), 0);
    const byKind = {}, bySource = {}, byCard = {}, outcomes = {};
    for (const g of games) {
        outcomes[g.outcome] = (outcomes[g.outcome] ?? 0) + 1;
        for (const f of g.findings) {
            byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
            bySource[f.source] = (bySource[f.source] ?? 0) + 1;
            const cards = new Set([...(f.cards ?? []).map((c) => c.setCode), f.lastCard?.setCode].filter(Boolean));
            for (const c of cards) byCard[c] = (byCard[c] ?? 0) + 1;
        }
    }
    const summary = {
        games: games.length, outcomes,
        engineErrors: games.filter((g) => g.outcome === 'ERROR' && !g.by).map((g) => ({ bots: g.bots, seed: g.seed, error: g.error })),
        botErrors: games.filter((g) => g.outcome === 'ERROR' && g.by).map((g) => ({ bots: g.bots, seed: g.seed, by: g.by, error: g.error })),
        checked: {
            realDecisions: sum((g) => g.real?.decisions), realWindows: sum((g) => g.real?.windows),
            simLines: sum((g) => g.sims.lines), simDecisions: sum((g) => g.sims.decisions), simWindows: sum((g) => g.sims.windows),
            gamesNotChecked: games.filter((g) => g.real?.skipped).map((g) => ({ bots: g.bots, seed: g.seed, why: g.real.skipped }))
        },
        findings: { total: sum((g) => g.findings.length), byKind, bySource, byCard: Object.fromEntries(Object.entries(byCard).sort((a, b) => b[1] - a[1])) },
        examples: games.flatMap((g) => g.findings.map((f) => ({ bots: g.bots, seed: g.seed, ...f }))).slice(0, 40)
    };
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    return summary;
}

async function main() {
    if (process.argv.includes('--worker')) {
        const id = Number(arg('worker'));
        const opts = JSON.parse(process.env.STRESS_OPTS);
        await worker(id, opts.jobs[id], opts);
        return;
    }
    if (process.argv.includes('--summary')) {
        console.log(JSON.stringify(summarize(path.resolve(arg('summary'))), null, 2));
        return;
    }
    const bots = arg('bots', 'heuristic,aggro,control').split(',');
    const seeds = require('./trace').seedList(arg('seeds', '1-2'));
    const out = path.resolve(arg('out', 'replays/omni-rs-stress'));
    if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty`);
    fs.mkdirSync(out, { recursive: true });
    const workers = Math.max(1, Number(arg('workers', 2)));
    const all = jobs(bots, seeds);
    const split = Array.from({ length: workers }, () => []);
    all.forEach((job, i) => split[i % workers].push(job));
    const key = arg('key', 'none');
    const opts = {
        out, pool: path.resolve(arg('pool', path.join(__dirname, 'pool.json'))), simEvery: Number(arg('sim-every', 10)),
        key: key === 'none' ? null : key, limits: {}, jobs: split, views: process.argv.includes('--views'),
        engine: process.argv.includes('--selection-toggles') ? { selectionToggles: true } : {}
    };
    fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify({ bots, seeds, workers, simEvery: opts.simEvery, key: opts.key, pool: opts.pool, engine: opts.engine, started: new Date().toISOString() }, null, 2) + '\n');
    const codes = await Promise.all(split.map((_, id) => new Promise((resolve) => {
        const child = fork(__filename, ['--worker', String(id)], { env: { ...process.env, STRESS_OPTS: JSON.stringify(opts) } });
        child.on('exit', resolve);
    })));
    const summary = summarize(out);
    console.log(JSON.stringify({ games: summary.games, outcomes: summary.outcomes, checked: { ...summary.checked, gamesNotChecked: summary.checked.gamesNotChecked.length }, findings: summary.findings }, null, 2));
    if (codes.some((c) => c !== 0)) process.exitCode = 1;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });
module.exports = { jobs, summarize };
