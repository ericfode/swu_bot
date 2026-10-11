'use strict';
/**
 * Non-LLM competitor: a (1+lambda) evolution strategy over the heuristic bot's evaluation weights and search budget.
 * It is an ordinary arena client: it reads the clock, posts thoughts and submits through the arena API (direct, or
 * over HTTP when ARENA_URL is set), so it competes on the same terms as the Claude and Codex competitors.
 *
 *   node bot/arena/optimizer.js --name optimizer [--start tempo] [--lambda 3] [--seeds 1] [--workers 3]
 *       [--sigma 0.25] [--until-round-end] [--generations 50] [--token T]
 *
 * Each generation: mutate the incumbent into `lambda` candidates; every candidate plays the incumbent and rush,
 * `seeds` seeds from both seats (eval seeds, never ladder seeds); the incumbent also plays rush. Fitness =
 * mean(win rate vs incumbent, win rate vs rush), the incumbent's own = mean(0.5, its rush rate). The best candidate
 * replaces the incumbent if it scores higher. A new incumbent is submitted at once, so the newest version is always
 * the best found. Time forfeits count as losses, so the search budget evolves to fit the cap.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seededRng } = require('../env');
// loaded before main() points ARENA_HOME at the scratch arena, so API calls still reach the real one;
// the eval worker threads start later and see the scratch home
const directApi = process.env.ARENA_URL ? null : require('./api');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const NAME = arg('name', 'optimizer');
const LAMBDA = Number(arg('lambda', 3));
const SEEDS = Number(arg('seeds', 1));
const WORKERS = Number(arg('workers', 3));
const SIGMA = Number(arg('sigma', 0.25));
const GENERATIONS = Number(arg('generations', 50));
const TOKEN = arg('token', process.env.ARENA_COMPETITOR_TOKEN);

// The arena the optimizer competes in, reached through the API like any other client.
async function arena(method, args = {}) {
    const a = TOKEN && args.token === undefined ? { ...args, token: TOKEN } : args;
    const out = process.env.ARENA_URL
        ? await (await fetch(`${process.env.ARENA_URL.replace(/\/$/, '')}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a) })).json()
        : await directApi.call(method, a);
    if (out.error) {
        throw new Error(`${method}: ${out.error.message}`);
    }
    return out.result;
}

const START = {
    tempo: { weights: { power: 1.5, cost: 0.5, resource: 2.2, initiative: 4.0, exhaustedMult: 0.95 }, side: {} },
    heuristic: { weights: {}, side: {} }
};
// Base values (heuristic.js W / SIDE) and bounds for every gene; search budget genes are integers.
const GENES = {
    'weights.power': [1.3, 0.1, 5], 'weights.hp': [0.9, 0.1, 5], 'weights.cost': [0.25, 0, 3], 'weights.shield': [2.2, 0, 8],
    'weights.upgrade': [0.6, 0, 4], 'weights.sentinel': [1.0, 0, 6], 'weights.exhaustedMult': [0.85, 0.3, 1.2], 'weights.hand': [1.8, 0, 6],
    'weights.resource': [1.4, 0, 6], 'weights.initiative': [2.5, 0, 10], 'weights.baseHp': [0.9, 0.1, 5],
    'side.myBase': [1.5, 0.2, 5], 'side.oppBase': [1.5, 0.2, 6], 'side.myUnits': [1, 0.2, 3], 'side.oppUnits': [1, 0.2, 3], 'side.baseDangerHp': [12, 0, 25],
    'search.maxCandidates': [40, 4, 60, 'int'], 'search.maxBranch': [8, 1, 16, 'int']
};

function genomeFrom(start) {
    const s = START[start] ?? START.tempo;
    const g = {};
    for (const [k, [base]] of Object.entries(GENES)) {
        const [grp, key] = k.split('.');
        g[k] = s[grp]?.[key] ?? base;
    }
    g['search.maxCandidates'] = 16; // start inside the time cap: the stock 40 forfeits about half its games
    g['search.maxBranch'] = 4;
    return g;
}

function mutate(g, rng) {
    const out = { ...g };
    const gauss = () => Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng());
    for (const [k, [, lo, hi, kind]] of Object.entries(GENES)) {
        if (rng() < 0.5) {
            continue; // mutate about half the genes each time
        }
        let v = out[k] === 0 ? 0.05 : out[k];
        v *= Math.exp(SIGMA * gauss());
        v = Math.min(hi, Math.max(lo, v));
        out[k] = kind === 'int' ? Math.round(v) : +v.toFixed(3);
    }
    return out;
}

function botSource(g, note) {
    const profile = { weights: {}, side: {} };
    for (const [k, v] of Object.entries(g)) {
        const [grp, key] = k.split('.');
        if (grp !== 'search') {
            profile[grp][key] = v;
        }
    }
    return `'use strict';
// Written by bot/arena/optimizer.js (no LLM): rollback search with an evolved evaluation profile and search budget.
// ${note}
const { HeuristicBot } = require('./heuristic');

const GENOME = ${JSON.stringify(g, null, 4)};
const PROFILE = ${JSON.stringify(profile, null, 4)};

function createBot(name) {
    return new HeuristicBot(name, { depth: 1, profile: PROFILE, maxCandidates: GENOME['search.maxCandidates'], maxBranch: GENOME['search.maxBranch'] });
}

module.exports = { createBot, GENOME };
`;
}

/** The incumbent as a strategy diagram (strategy.js): genes feed the board score, which drives the search. */
function diagramFor(g, prev, gen) {
    const evalGenes = Object.keys(g).filter((k) => !k.startsWith('search.'));
    const changed = prev ? evalGenes.filter((k) => Math.abs(g[k] - prev[k]) > 1e-9).sort((a, b) => Math.abs(Math.log((g[b] + 0.01) / (prev[b] + 0.01))) - Math.abs(Math.log((g[a] + 0.01) / (prev[a] + 0.01)))).slice(0, 4) : [];
    const nodes = evalGenes.map((k) => ({ id: k, label: k.split('.')[1], kind: k.startsWith('side.') ? 'memory' : 'input', value: g[k], note: prev ? `was ${prev[k]}` : undefined }));
    nodes.push({ id: 'score', label: 'board score', kind: 'feature' });
    nodes.push({ id: 'search', label: `search ${g['search.maxCandidates']}x${g['search.maxBranch']}`, kind: 'decision', value: g['search.maxCandidates'] });
    nodes.push({ id: 'move', label: 'play best move', kind: 'action' });
    const edges = evalGenes.map((k) => ({ from: k, to: 'score', weight: g[k] }));
    edges.push({ from: 'score', to: 'search', weight: 1 }, { from: 'search', to: 'move', weight: 1 });
    return {
        title: `${NAME}: evolved evaluation, generation ${gen}`,
        caption: changed.length ? `Last accepted mutation moved ${changed.map((k) => k.split('.')[1]).join(', ')}.` : 'Starting genome.',
        nodes, edges, highlight: [...changed, 'score', 'search', 'move'],
        steps: [
            { caption: 'Each gene is a weight in the board score (circle size = value).', highlight: evalGenes },
            { caption: changed.length ? `What evolution changed last: ${changed.map((k) => k.split('.')[1]).join(', ')}.` : 'Nothing changed yet.', highlight: [...changed, 'score'] },
            { caption: `Every legal move is played out on the real engine, scored, rolled back (budget ${g['search.maxCandidates']} moves x ${g['search.maxBranch']} follow-ups).`, highlight: ['score', 'search', 'move'] }
        ]
    };
}

const HEURISTIC_SRC = fs.readFileSync(path.join(__dirname, 'starters', 'heuristic.js'), 'utf8');

async function main() {
    // candidates are evaluated in a private arena home, so they never show up in the real roster
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-opt-'));
    process.env.ARENA_HOME = scratch;
    process.env.ARENA_DASH = path.join(scratch, 'dash');
    fs.mkdirSync(path.join(scratch, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'roster.json'), JSON.stringify({ thinkCapMs: (await arena('status')).thinkCapMs, baselines: [], agents: [] }));
    const { runEval } = require('./eval');
    const put = (id, g) => {
        const d = path.join(scratch, 'agents', id);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'heuristic.js'), HEURISTIC_SRC);
        fs.writeFileSync(path.join(d, 'bot.js'), botSource(g, id));
        return id;
    };
    const rate = (sum, opp) => (sum.byOpp[opp] ? sum.byOpp[opp].win / Math.max(1, sum.byOpp[opp].win + sum.byOpp[opp].loss + sum.byOpp[opp].other) : 0);

    const rng = seededRng(`optimizer-${NAME}`);
    let best = genomeFrom(arg('start', 'tempo'));
    let prev = null;
    let gen = 0;
    let seed = 30001;
    await arena('say', { name: NAME, now: 'Starting the evolution strategy', diagram: diagramFor(best, null, 0), idea: `(1+${LAMBDA}) evolution strategy over ${Object.keys(GENES).length} evaluation weights and search-budget genes; fitness = win rate vs the incumbent and vs rush.` });
    const status = await arena('status');
    const roundEnd = process.argv.includes('--until-round-end') && status.deadline ? Date.parse(status.deadline) : Infinity;
    while (gen < GENERATIONS && Date.now() < roundEnd) {
        gen++;
        const inc = put(`inc${gen}`, best);
        const incSum = await runEval({ me: inc, opps: ['rush'], seeds: SEEDS, first: seed, workers: WORKERS });
        const incFit = (0.5 + rate(incSum, 'rush')) / 2;
        let top = null;
        for (let i = 0; i < LAMBDA; i++) {
            const g = mutate(best, rng);
            const c = put(`g${gen}c${i}`, g);
            const s = await runEval({ me: c, opps: [inc, 'rush'], seeds: SEEDS, first: seed, workers: WORKERS });
            const fit = (rate(s, inc) + rate(s, 'rush')) / 2;
            if (!top || fit > top.fit) {
                top = { g, fit, ms: s.timing.msPerDecision };
            }
        }
        seed += SEEDS;
        const improved = top.fit > incFit;
        const msg = `gen ${gen}: incumbent ${incFit.toFixed(2)}, best candidate ${top.fit.toFixed(2)} (${top.ms} ms/decision)${improved ? ', replacing the incumbent' : ''}`;
        console.log(msg);
        if (improved) {
            prev = best;
            best = top.g;
            const r = await arena('submit', { name: NAME, note: `ES generation ${gen}: fitness ${top.fit.toFixed(2)} vs ${incFit.toFixed(2)}`, bot: { kind: 'js', files: { 'bot.js': botSource(best, `generation ${gen}`), 'heuristic.js': HEURISTIC_SRC } } });
            await arena('say', { name: NAME, text: `${msg} -> submitted ${r.version}`, now: `Generation ${gen + 1}`, diagram: diagramFor(best, prev, gen) });
        } else {
            await arena('say', { name: NAME, text: msg, now: `Generation ${gen + 1}` });
        }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
}

main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
});
