'use strict';
/**
 * Write the research dashboard files for the position-evaluation study (contract: dashboard/README.md).
 *
 *   node bot/eval/publish.js --brier brier.json [--ladder results/<run>/index.json] [--dash /mnt/project-files/dashboard]
 *                            [--now "..."] [--thought "..."] [--plan plan.json] [--status running|done]
 *
 * Writes dashboard/panels/position-eval.json (strategy panel) and dashboard/experiments/position-eval-*.json.
 * Thoughts accumulate: the panel's existing thoughts are kept and --thought is appended.
 */
const fs = require('fs');
const path = require('path');
const { loadEvaluator } = require('./evaluators');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const readJson = (f) => (f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const writeJson = (file, obj) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(obj, null, 1));
    fs.renameSync(`${file}.tmp`, file);
};
const pct = (x) => `${(100 * x).toFixed(1)}%`;

/** Per-bot score from a tournament index: wins + draws/2 over decided games, plus head-to-head vs one opponent. */
function ladderStats(index) {
    const bots = {};
    const get = (b) => (bots[b] ??= { games: 0, score: 0, vs: {} });
    for (const g of index.games) {
        if (g.outcome !== 'won' && g.winner !== 'draw') {
            continue;
        }
        for (const [me, opp] of [[g.p1, g.p2], [g.p2, g.p1]]) {
            const s = g.winner === me ? 1 : g.winner === 'draw' ? 0.5 : 0;
            const b = get(me);
            b.games++;
            b.score += s;
            const v = (b.vs[opp] ??= { games: 0, score: 0 });
            v.games++;
            v.score += s;
        }
    }
    return bots;
}

function main() {
    const dash = arg('dash', '/mnt/project-files/dashboard');
    const brier = readJson(arg('brier', null));
    const ladderIndex = readJson(arg('ladder', null));
    const panelFile = path.join(dash, 'panels', 'position-eval.json');
    const old = readJson(panelFile) ?? {};
    const now = new Date().toISOString();
    const thoughts = [...(old.thoughts ?? [])];
    if (arg('thought', null)) {
        thoughts.push({ t: now, text: arg('thought') });
    }
    const plan = readJson(arg('plan', null)) ?? old.plan ?? [];
    const evals = Object.entries(brier?.evaluators ?? {});
    const best = evals.slice().sort((a, b) => a[1].subjective.all.brier - b[1].subjective.all.brier)[0];
    const lad = ladderIndex ? ladderStats(ladderIndex) : null;

    const widgets = [];
    if (brier) {
        widgets.push({
            type: 'stats',
            items: [
                { label: 'held-out games', value: brier.testGames },
                { label: 'held-out positions', value: brier.testPositions },
                { label: 'best Brier (subjective)', value: best ? +best[1].subjective.all.brier.toFixed(3) : null },
                { label: 'coin flip Brier', value: 0.25 }
            ]
        });
        widgets.push({
            type: 'bars', title: 'Brier score on held-out games, subjective view (lower is better)',
            items: evals.map(([name, r]) => ({ label: name, value: +r.subjective.all.brier.toFixed(4) }))
        });
        const srcs = [...new Set(evals.flatMap(([, r]) => Object.keys(r.subjective).filter((k) => k.startsWith('src:'))))];
        const rounds = [...new Set(evals.flatMap(([, r]) => Object.keys(r.subjective).filter((k) => k.startsWith('round:'))))];
        widgets.push({
            type: 'table', title: 'Prediction quality by evaluator (Brier; lower is better)',
            columns: ['evaluator', 'subjective', 'objective', 'accuracy', ...srcs.map((s) => s.slice(4) + ' games'), ...rounds.map((r) => r.slice(6)), ...(lad ? ['ladder score'] : [])],
            rows: evals.map(([name, r]) => [
                name, r.subjective.all.brier.toFixed(3), r.objective.all.brier.toFixed(3), pct(r.subjective.all.acc),
                ...srcs.map((s) => r.subjective[s]?.brier.toFixed(3) ?? ''),
                ...rounds.map((k) => r.subjective[k]?.brier.toFixed(3) ?? ''),
                ...(lad ? [lad[`h@${name}`] ? pct(lad[`h@${name}`].score / lad[`h@${name}`].games) : ''] : [])
            ])
        });
        if (best) {
            widgets.push({
                type: 'line', title: `Calibration of ${best[0]}: predicted vs actual win rate`, x: 'predicted P(win)', yFormat: 'pct',
                series: [
                    { name: best[0], points: best[1].calibration.map((c) => [c.p, c.y]) },
                    { name: 'perfect', points: [[0, 0], [1, 1]] }
                ]
            });
        }
        if (brier.llm) {
            const views = ['subjective_p1', 'subjective_p2', 'objective', 'omniscient'];
            widgets.push({
                type: 'table', title: `Same ${brier.llm.checkpoints} checkpoints as the LLM analysis (${brier.llm.game}); Brier by view`,
                columns: ['evaluator', ...views],
                rows: Object.entries(brier.llm.rows).map(([name, v]) => [name, ...views.map((k) => v[k]?.brier.toFixed(3) ?? '')])
            });
        }
    }
    if (lad) {
        const names = Object.keys(lad).sort((a, b) => lad[b].score / lad[b].games - lad[a].score / lad[a].games);
        widgets.push({
            type: 'table', title: `Ladder ${ladderIndex.id}: row's score vs column (same search, different evaluator)`,
            columns: ['bot', 'games', 'score', ...names],
            rows: names.map((a) => [a, String(lad[a].games), pct(lad[a].score / lad[a].games), ...names.map((b) => (lad[a].vs[b] ? `${lad[a].vs[b].score}/${lad[a].vs[b].games}` : ''))])
        });
    }

    // mental model: the fitted linear weights, in standard deviations of each feature (comparable scale)
    let features = old.mentalModel?.features ?? [];
    try {
        const lin = loadEvaluator('linear').model;
        features = lin.names.map((n, i) => ({ name: n, weight: +lin.w[i].toFixed(3) }))
            .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 14);
        widgets.push({ type: 'bars', title: 'Linear evaluator: weight per feature difference (per standard deviation)', items: features.map((f) => ({ label: f.name, value: f.weight })) });
    } catch {
        // no fitted linear model yet
    }

    const panel = {
        schema: 1,
        id: 'position-eval',
        title: 'Position evaluation',
        thread: 'Position evaluation research',
        bots: lad ? Object.keys(lad).filter((b) => b.startsWith('h@')) : (old.bots ?? []),
        status: arg('status', old.status ?? 'running'),
        updatedAt: now,
        now: arg('now', old.now ?? ''),
        goal: 'Find the best way to score a position from one player\'s view: same lookahead bot, swap only the evaluator, judge by prediction (Brier) and by ladder wins.',
        mentalModel: {
            summary: 'Each evaluator maps a board snapshot, seen by one player (opponent hand = count only), to P(that player wins). The lookahead bot plays the action whose resulting position scores best.',
            features
        },
        plan,
        thoughts: thoughts.slice(-12),
        widgets
    };
    writeJson(panelFile, panel);

    if (brier) {
        writeJson(path.join(dash, 'experiments', 'position-eval-brier.json'), {
            schema: 1, id: 'position-eval-brier', title: 'Position evaluators: predicting the winner (Brier)', owner: 'Position evaluation research',
            hypothesis: 'Evaluators fitted on game outcomes predict the winner better than hand-tuned material counting, and knowing the opponent\'s decklist helps.',
            status: arg('status', 'running'), startedAt: brier.createdAt, updatedAt: now,
            progress: { done: brier.testGames, total: brier.testGames, unit: 'held-out games' },
            metrics: evals.map(([name, r]) => ({ label: `${name} Brier`, value: +r.subjective.all.brier.toFixed(4) })).slice(0, 8),
            chart: best ? { x: 'predicted P(win)', y: 'actual win rate', yFormat: 'pct', series: [{ name: best[0], points: best[1].calibration.map((c) => [c.p, c.y]) }, { name: 'perfect', points: [[0, 0], [1, 1]] }] } : undefined,
            conclusion: arg('conclusion', null)
        });
    }
    if (lad) {
        const names = Object.keys(lad).sort((a, b) => lad[b].score / lad[b].games - lad[a].score / lad[a].games);
        const total = ladderIndex.bots.length * (ladderIndex.bots.length - 1) / 2 * ladderIndex.gamesPerPairing;
        writeJson(path.join(dash, 'experiments', 'position-eval-ladder.json'), {
            schema: 1, id: 'position-eval-ladder', title: 'Position evaluators: ladder under the same search', owner: 'Position evaluation research',
            hypothesis: 'A better predictor of the winner also makes the one-ply lookahead bot win more.',
            status: ladderIndex.games.length >= total && ladderIndex.games.every((g) => g.outcome !== 'running') ? 'done' : 'running',
            startedAt: ladderIndex.createdAt, updatedAt: now,
            progress: { done: ladderIndex.games.filter((g) => g.outcome !== 'running').length, total, unit: 'games' },
            metrics: names.slice(0, 8).map((b) => ({ label: `${b} score`, value: +(lad[b].score / lad[b].games).toFixed(3), format: 'pct' })),
            conclusion: arg('ladderConclusion', null)
        });
    }
    console.log(`wrote ${panelFile}`);
}

main();
