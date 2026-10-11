'use strict';

/**
 * Summarise the omniscient experiments and publish them to the research dashboard.
 *
 *   node bot/omni/report.js [--root /mnt/project-files]
 *
 * Reads:  <root>/omni/solve-*\/*.json        (bot/omni/solve-games.js)
 *         <root>/results/omni-ref-*\/index.json (bot/tournament.js runs with the omni bots)
 *         <root>/omni/decisions/*.jsonl      (OMNI_LOG_DIR decision logs)
 * Writes: <root>/omni/summary.json, <root>/dashboard/panels/omni.json,
 *         <root>/dashboard/experiments/omni-solve-horizon.json, <root>/dashboard/experiments/omni-vs-heuristic.json
 * Every file is written to a temp name and renamed, so readers never see half a file.
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const root = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : '/mnt/project-files';
const now = new Date().toISOString();

function readJson(f) {
    try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
        return null;
    }
}

function writeJson(f, obj) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(obj, null, 1));
    fs.renameSync(`${f}.tmp`, f);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r = (x, d = 2) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);
const { readJsonl } = require('./lens');
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

// ---------- solve horizon ----------

function solveStats() {
    const games = [];
    for (const d of list(path.join(root, 'omni')).filter((x) => x.startsWith('solve-'))) {
        for (const f of list(path.join(root, 'omni', d)).filter((x) => x.endsWith('.json'))) {
            const g = readJson(path.join(root, 'omni', d, f));
            if (g && g.solves && g.winner) {
                games.push({ ...g, set: d });
            }
        }
    }
    const byFromEnd = new Map();
    const horizons = [];
    const noReturn = [];
    const proofDepths = [];
    const evalChecks = { agree: 0, total: 0 };
    let nodes = 0;
    let ms = 0;
    const moves = [];
    const blunders = [];
    for (const g of games) {
        let contiguous = 0;
        let broken = false;
        let decidedFromEnd = 0;
        const solvesByI = new Map(g.solves.map((s) => [s.i, s]));
        for (const s of g.solves) {
            nodes += s.nodes;
            ms += s.ms;
            const b = byFromEnd.get(s.fromEnd) ?? { tried: 0, solved: 0 };
            b.tried++;
            if (s.result) {
                b.solved++;
                proofDepths.push(s.depth);
                const w = g.windowsList[s.i];
                if (w && w.eval !== 0) {
                    evalChecks.total++;
                    if ((w.eval > 0) === (s.result === 'p1')) {
                        evalChecks.agree++;
                    }
                }
            }
            byFromEnd.set(s.fromEnd, b);
            if (!broken && s.result) {
                contiguous = s.fromEnd;
                if (s.result === g.winner) {
                    decidedFromEnd = s.fromEnd;
                }
            } else {
                broken = true;
            }
            // a proven win for the player to move, followed by a proven win for the other side: a thrown game
            const next = solvesByI.get(s.i + 1);
            if (s.result && s.result === s.actor && next?.result && next.result !== s.actor) {
                blunders.push({ seed: g.seed, round: s.round, actor: s.actor, played: g.windowsList[s.i]?.played });
            }
        }
        horizons.push(contiguous);
        // the earliest window (counting back from the end without a gap) already proven for the eventual winner
        const firstDecided = decidedFromEnd ? g.windowsList[g.windowsList.length - decidedFromEnd] : null;
        noReturn.push({ seed: g.seed, windows: decidedFromEnd, rounds: firstDecided ? g.rounds - firstDecided.round : 0 });
        for (const w of g.windowsList) {
            if (w.moves) {
                moves.push({ round: w.round, moves: w.moves, firstActions: w.firstActions });
            }
        }
    }
    // game tree size: sum of log10(moves) over all windows, using the sampled windows' mean per round
    const perRound = new Map();
    for (const m of moves) {
        const x = perRound.get(m.round) ?? [];
        x.push(m.moves);
        perRound.set(m.round, x);
    }
    const allMean = mean(moves.map((m) => m.moves)) ?? 1;
    const treeLog10 = games.map((g) => g.windowsList.reduce((a, w) => a + Math.log10(Math.max(1, mean(perRound.get(w.round) ?? []) ?? allMean)), 0));
    return {
        games: games.length,
        windowsPerGame: r(mean(games.map((g) => g.windows)), 1),
        roundsPerGame: r(mean(games.map((g) => g.rounds)), 1),
        msPerNode: nodes ? r(ms / nodes, 1) : null,
        budget: games[0]?.config?.budget ?? null,
        maxDepth: games[0]?.config?.depth ?? null,
        movesPerWindow: r(allMean, 1),
        firstActionsPerWindow: r(mean(moves.map((m) => m.firstActions)), 1),
        movesByRound: [...perRound.entries()].sort((a, b) => a[0] - b[0]).map(([round, xs]) => [round, r(mean(xs), 1)]),
        treeLog10: r(mean(treeLog10), 0),
        solveRateByFromEnd: [...byFromEnd.entries()].sort((a, b) => a[0] - b[0]).map(([k, b]) => ({ fromEnd: k, tried: b.tried, solved: b.solved, rate: r(b.solved / b.tried) })),
        horizon: { mean: r(mean(horizons), 2), max: Math.max(0, ...horizons), perGame: horizons },
        decided: noReturn,
        proofDepths: [1, 2, 3, 4, 5, 6, 7, 8].map((d) => [d, proofDepths.filter((x) => x === d).length]).filter(([, n]) => n),
        evalAgreement: evalChecks.total ? { agree: evalChecks.agree, total: evalChecks.total, rate: r(evalChecks.agree / evalChecks.total) } : null,
        blunders
    };
}

// ---------- matches ----------

/** One row per pairing (bot vs opponent), summed over every omni-ref-* run of that pairing. */
function matchStats() {
    const pairs = new Map();
    for (const d of list(path.join(root, 'results')).filter((x) => x.startsWith('omni-ref')).sort()) {
        const idx = readJson(path.join(root, 'results', d, 'index.json'));
        if (!idx) {
            continue;
        }
        const omni = idx.bots.find((b) => b.startsWith('omni'));
        const opponent = idx.bots.find((b) => b !== omni);
        const key = `${omni} vs ${opponent}`;
        const p = pairs.get(key) ?? { pair: key, bot: omni, opponent, runs: [], scheduled: 0, games: [] };
        p.runs.push(d);
        p.scheduled += idx.gamesPerPairing;
        p.games.push(...idx.games.map((g) => ({ id: g.id, run: d, seed: g.seed, winner: g.winner, rounds: g.rounds, outcome: g.outcome })));
        pairs.set(key, p);
    }
    return [...pairs.values()].map((p) => {
        const done = p.games.filter((g) => g.outcome !== 'running');
        const decided = done.filter((g) => g.outcome === 'won');
        const wins = decided.filter((g) => g.winner === p.bot).length;
        const curve = [];
        let w = 0;
        decided.forEach((g, i) => {
            w += g.winner === p.bot ? 1 : 0;
            curve.push([i + 1, r(w / (i + 1))]);
        });
        const rate = decided.length ? wins / decided.length : null;
        // normal-approximation 95% interval, enough to say whether a gap is real
        const ci = decided.length ? 1.96 * Math.sqrt((rate * (1 - rate)) / decided.length) : null;
        return {
            ...p, played: done.length, decided: decided.length, wins, winRate: r(rate), ci95: r(ci),
            errors: done.filter((g) => g.outcome === 'ERROR').length, avgRounds: r(mean(decided.map((g) => g.rounds)), 1), curve, games: done
        };
    });
}

// ---------- decisions ----------

function decisionStats() {
    const top = path.join(root, 'omni', 'decisions');
    // one sub-folder per run (OMNI_LOG_DIR=<top>/<run>)
    const files = list(top).filter((d) => fs.statSync(path.join(top, d)).isDirectory())
        .flatMap((d) => list(path.join(top, d)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f)));
    const dir = top;
    let all = [];
    let latest = null;
    let latestT = 0;
    for (const f of files) {
        const full = path.join(dir, f);
        const lines = readJsonl(full).filter(Boolean);
        all = all.concat(lines.map((l) => ({ ...l, bot: path.basename(f).replace(/^\d+-|-p\d\.jsonl$/g, '') })));
        const t = fs.statSync(full).mtimeMs;
        if (t > latestT && lines.length) {
            latestT = t;
            latest = { file: f, last: lines[lines.length - 1], recent: lines.slice(-6) };
        }
    }
    const depth = {};
    for (const d of all) {
        depth[d.depth] = (depth[d.depth] ?? 0) + 1;
    }
    return {
        decisions: all.length,
        msPerDecision: r(mean(all.map((d) => d.ms)), 0),
        nodesPerDecision: r(mean(all.map((d) => d.nodes)), 0),
        depth,
        latest
    };
}

function trees() {
    const top = path.join(root, 'omni', 'decisions');
    const files = list(top).filter((d) => fs.statSync(path.join(top, d)).isDirectory())
        .flatMap((d) => list(path.join(top, d)).filter((f) => /^latest-tree-.*\.json$/.test(f)).map((f) => path.join(top, d, f)));
    return files.map((f) => readJson(f)).filter(Boolean)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 1);
}

// ---------- publish ----------

function main() {
    const solve = solveStats();
    const matches = matchStats();
    const dec = decisionStats();
    const summary = { updatedAt: now, solve, matches, decisions: dec };
    writeJson(path.join(root, 'omni', 'summary.json'), summary);

    const running = matches.some((m) => m.played < m.scheduled);
    const ref = matches.find((m) => m.bot === 'omni');
    const blind = matches.find((m) => m.bot === 'omni-blind');

    writeJson(path.join(root, 'dashboard', 'experiments', 'omni-vs-heuristic.json'), {
        schema: 1, id: 'omni-vs-heuristic', title: 'Omniscient bot vs fair heuristic', owner: 'Omniscient optimal play',
        hypothesis: 'Seeing both hands, deck order and future draws, plus a 2-window search, beats the fair 1-ply heuristic by a wide margin; most of the gain comes from knowing the draws.',
        status: running ? 'running' : 'done', startedAt: '2026-10-11T07:15:00Z', updatedAt: now,
        progress: { done: matches.reduce((a, m) => a + m.played, 0), total: matches.reduce((a, m) => a + m.scheduled, 0), unit: 'games' },
        metrics: matches.map((m) => ({ label: `${m.pair} win rate`, value: m.winRate ?? 0, format: 'pct' })),
        chart: { x: 'games played', y: 'win rate', yFormat: 'pct', series: matches.slice(0, 4).map((m) => ({ name: m.pair, points: m.curve })) },
        conclusion: null
    });

    writeJson(path.join(root, 'dashboard', 'experiments', 'omni-solve-horizon.json'), {
        schema: 1, id: 'omni-solve-horizon', title: 'How close to the end can SWU be solved exactly?', owner: 'Omniscient optimal play',
        hypothesis: 'With the real engine (~30 nodes/s), exact forced-win proofs only reach the last few action windows of a game.',
        status: solve.games >= 16 ? 'done' : 'running', startedAt: '2026-10-11T07:05:00Z', updatedAt: now,
        progress: { done: solve.games, total: 16, unit: 'games' },
        metrics: [
            { label: 'mean solve horizon (windows from end)', value: solve.horizon.mean ?? 0 },
            { label: 'ms per search node', value: solve.msPerNode ?? 0 },
            { label: 'moves per window', value: solve.movesPerWindow ?? 0 },
            { label: 'log10 game-tree size', value: solve.treeLog10 ?? 0 }
        ],
        chart: { x: 'windows before the end', y: 'positions solved', yFormat: 'pct', series: [{ name: `budget ${solve.budget} nodes`, points: solve.solveRateByFromEnd.map((b) => [b.fromEnd, b.rate]) }] },
        conclusion: null
    });

    const last = dec.latest?.last;
    const thoughts = [];
    if (solve.games) {
        thoughts.push({ t: now, text: `Solved ${solve.games} heuristic-vs-heuristic endgames: proofs reach ${solve.horizon.mean} windows from the end on average (max ${solve.horizon.max}), at ${solve.msPerNode} ms per node.` });
        thoughts.push({ t: now, text: `A window has ~${solve.movesPerWindow} distinct moves (${solve.firstActionsPerWindow} first actions before targets), so a whole game tree is ~10^${solve.treeLog10}. Exact solving from the start is out of reach by hundreds of orders of magnitude.` });
        if (solve.evalAgreement) {
            thoughts.push({ t: now, text: `On proven positions the position score picks the right winner ${Math.round(solve.evalAgreement.rate * 100)}% of the time (${solve.evalAgreement.total} positions).` });
        }
    }
    for (const m of matches) {
        if (m.decided) {
            thoughts.push({ t: now, text: `${m.pair}: ${m.wins}/${m.decided} wins (${Math.round(m.winRate * 100)}% +/- ${Math.round(m.ci95 * 100)}).` });
        }
    }
    for (const d of dec.latest?.recent ?? []) {
        thoughts.push({ t: now, text: `R${d.round} ${d.seat}: plays ${d.pv?.[0] ?? '?'} (value ${d.value}, depth ${d.depth}, ${d.nodes} nodes, ${d.ms} ms)${d.pv?.length > 1 ? `; expects ${d.pv.slice(1).join(' / ')}` : ''}.` });
    }

    writeJson(path.join(root, 'dashboard', 'panels', 'omni.json'), {
        schema: 1, id: 'omni', title: 'Omniscient optimal play', thread: 'Omniscient optimal play',
        bots: ['omni', 'omni-blind'], status: running || solve.games < 16 ? 'running' : 'done', updatedAt: now,
        now: last ? `Round ${last.round}: searched ${last.nodes} nodes to depth ${last.depth}; best line ${last.pv?.join(' | ')}` : 'Starting reference games',
        goal: 'An upper reference: how well can SWU be played with perfect information, and how far from the end can it be solved exactly?',
        mentalModel: {
            summary: 'Sees both hands, both deck orders and the real RNG, so every searched line uses the real future draws. Alpha-beta over action windows (its move, the best reply, ...), each move = an action plus its target; leaves scored with the shared position score. Near the end an AND/OR prover looks for forced wins.',
            features: [
                { name: 'unit power', weight: 1.3 }, { name: 'unit HP left', weight: 0.9 }, { name: 'unit cost', weight: 0.25 },
                { name: 'shield', weight: 2.2 }, { name: 'other upgrade', weight: 0.6 }, { name: 'sentinel', weight: 1.0 },
                { name: 'card in hand', weight: 1.8 }, { name: 'resource', weight: 1.4 }, { name: 'initiative', weight: 2.5 },
                { name: 'own base HP (x1.5, steeper under 12)', weight: 1.35 }
            ]
        },
        plan: [
            { text: 'Omniscient alpha-beta search and exact endgame prover on the real engine', state: 'done' },
            { text: 'Card-value lens for the viewer (dashboard/lens)', state: 'done' },
            { text: 'Solve horizon on 16 heuristic-vs-heuristic games', state: solve.games >= 16 ? 'done' : 'doing' },
            { text: 'Omni and omni-blind vs heuristic, 16 games each', state: running ? 'doing' : 'done' },
            { text: 'Release solved endgame positions as ground truth for position functions', state: 'todo' },
            { text: 'Faster simulator (Rust / engine fast clone) to push the horizon', state: 'todo' }
        ],
        thoughts: thoughts.slice(-12),
        widgets: [
            { type: 'stats', items: [
                { label: 'ms per node', value: solve.msPerNode ?? dec.msPerDecision ?? 0 },
                { label: 'moves per window', value: solve.movesPerWindow ?? 0 },
                { label: 'game tree (log10)', value: solve.treeLog10 ?? 0 },
                { label: 'solve horizon (windows)', value: solve.horizon.mean ?? 0 },
                ...matches.map((m) => ({ label: `${m.pair} win %`, value: m.winRate === null ? 0 : Math.round(m.winRate * 100) }))
            ] },
            { type: 'line', title: 'Win rate by pairing', x: 'games', yFormat: 'pct', series: matches.slice(0, 4).map((m) => ({ name: m.pair, points: m.curve })) },
            { type: 'bars', title: 'Endgames solved, by windows before the end', items: solve.solveRateByFromEnd.slice(0, 12).map((b) => ({ label: `${b.fromEnd} from end`, value: Math.round(b.rate * 100) })) },
            { type: 'bars', title: 'Distinct moves per window, by round', items: solve.movesByRound.map(([round, v]) => ({ label: `R${round}`, value: v })) },
            ...trees().map((t) => ({ type: 'tree', title: `Search tree at the last decision (${t.bot})`, caption: 'Values are the search score squashed to P(p1 wins) with a 15-point logistic (not calibrated yet). Children: its 8 best moves; under each, the replies it expects.', root: t.root })),
            ...(last ? [{ type: 'table', title: `Last decision (round ${last.round}, ${last.seat})`, columns: ['move', 'searched value'], rows: (last.moves ?? []).slice(0, 8).map((m) => [m.move, String(m.value)]) }] : [])
        ]
    });
    console.log(JSON.stringify({ solveGames: solve.games, horizon: solve.horizon.mean, matches: matches.map((m) => `${m.bot} ${m.wins}/${m.decided}`), decisions: dec.decisions }));
}

main();
