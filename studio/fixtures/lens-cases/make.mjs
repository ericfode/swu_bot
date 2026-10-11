// Lens test fixtures for the score sources (swu-lens/1 with the optional fields of the lens proposal,
// /mnt/project-files/viewer-kit/LENS-proposal.md sections 3-6): one folder per case, each a lens folder on its own, plus
// the replays the cases use. Built from one current omni lens file, one written before 08:40 and their replays.
//   node fixtures/lens-cases/make.mjs [outDir]   (run from studio/; default: studio/fixtures/lens-cases/out)
// Inputs, each overridable by an env var:
//   BASE_LENS      a current omni lens file           /mnt/project-files/dashboard/lens/heuristic-vs-omni-102.json
//   BASE_REPLAY    its replay                         <gameId>.jsonl in results/omni-ref-*/games, then any other games folder
//   OLD_LENS       a lens file written before 08:40   studio/static-data/data/_lens/omni-blind-vs-heuristic-101.json
//                  (no evaluator block). `npm run build:static` wipes static-data/, so when the file is gone it is rebuilt
//                  from the same game's current file (OLD_LENS_FROM, default dashboard/lens/<same name>) by dropping what
//                  08:40 added; for omni-blind-vs-heuristic-101 that gives the same bytes as the old file.
//   OLD_REPLAY     its replay
//   DEMO_LENS      a demo game's lens file            /mnt/project-files/dashboard/lens/random-b-vs-random-a-2.json
//                  (case 2 gives it the fitted map too, to see it on one axis with that game's evals)
//   DEMO_REPLAY    its replay
// Output (written fresh, the same bytes on every run): <case>/ folders, replays/lens-cases/ (one tournament with every game
// the cases use), cases.json (the case list for scripts) and README.md (how to open each case and what it must show).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const studio = path.resolve(here, '..', '..');
const PF = '/mnt/project-files';
const OUT = path.resolve(process.argv[2] ?? path.join(here, 'out'));
const TID = 'lens-cases';
/** a fixed date for the index files, so two runs write the same bytes */
const UPDATED = '2026-10-11T12:00:00Z';
const SEATS = ['p1', 'p2'];

const BASE_LENS = process.env.BASE_LENS || path.join(PF, 'dashboard', 'lens', 'heuristic-vs-omni-102.json');
const OLD_LENS = process.env.OLD_LENS || path.join(studio, 'static-data', 'data', '_lens', 'omni-blind-vs-heuristic-101.json');
const OLD_LENS_FROM = process.env.OLD_LENS_FROM || path.join(PF, 'dashboard', 'lens', path.basename(OLD_LENS));
const DEMO_LENS = process.env.DEMO_LENS || path.join(PF, 'dashboard', 'lens', 'random-b-vs-random-a-2.json');

// ---------------------------------------------------------------------------------------------------------------------
// Numbers. Stored values are rounded (points to 2 decimals, log-odds and p1Win to 4). A seat built here adds up its total
// from its stored values, and its step's edge from those totals, so I1 and I2 hold exactly.

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mapValues = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const logit = (p) => Math.log(p / (1 - p));
/** a chance rounded to 4 decimals, kept off 0 and 1 so its log-odds stay finite */
const chance = (x) => Math.min(0.9999, Math.max(0.0001, r4(sigmoid(x))));

/** One seat in field order, with its total added up from the stored values (extra terms included). */
function seat({ base, ground, space, hand, resources, initiative, extra, parts }, round = r2) {
    const s = { base, ground, space, hand, resources, initiative };
    if (extra) {
        s.extra = extra;
    }
    s.total = round(base + sum(ground) + sum(space) + sum(hand) + resources + initiative + sum(Object.values(extra ?? {})));
    if (parts) {
        s.parts = parts;
    }
    return s;
}

/**
 * Parts times f, rounded, with the rounding remainder moved into the largest part so they add up to `value` exactly (the
 * lens writer's parts can be 0.01 off their value, which a factor of 10 would push past the I3 tolerance).
 */
function fitParts(parts, f, value) {
    const out = mapValues(parts, (v) => r2(v * f));
    const keys = Object.keys(out);
    if (keys.length) {
        const big = keys.reduce((a, k) => (Math.abs(out[k]) > Math.abs(out[a]) ? k : a));
        out[big] = r2(out[big] + value - sum(Object.values(out)));
    }
    return out;
}

/** An Omni v1 seat with its unit values (and their parts) times unitF and its base times baseF; `rest` replaces other fields. */
function rescaled(v, unitF, baseF, rest = {}) {
    const base = r2(v.base * baseF);
    const ground = v.ground.map((x) => r2(x * unitF));
    const space = v.space.map((x) => r2(x * unitF));
    const parts = v.parts && {
        base: fitParts(v.parts.base, baseF, base),
        ground: v.parts.ground.map((p, i) => fitParts(p, unitF, ground[i])),
        space: v.parts.space.map((p, i) => fitParts(p, unitF, space[i]))
    };
    return seat({ base, ground, space, hand: v.hand, resources: v.resources, initiative: v.initiative, parts, ...rest });
}

// ---------------------------------------------------------------------------------------------------------------------
// Inputs

function findReplay(gameId) {
    const under = (root, pick) => (fs.existsSync(root) ? fs.readdirSync(root).filter(pick).sort() : []).map((d) => path.join(root, d, 'games', `${gameId}.jsonl`));
    const results = path.join(PF, 'results');
    const hit = [...under(results, (d) => d.startsWith('omni-ref-')), ...under(path.join(PF, 'games'), () => true), ...under(results, () => true)].find((f) => fs.existsSync(f));
    if (!hit) {
        throw new Error(`no replay found for ${gameId}; set its *_REPLAY env var`);
    }
    return hit;
}

function readReplay(file) {
    const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { file, header: events.find((e) => e.t === 'header'), steps: events.filter((e) => e.t === 'step'), end: events.find((e) => e.t === 'end') ?? null };
}

/** A lens file (its text as read, so exact copies keep their bytes) with its replay. */
function game(raw, replayEnv) {
    const file = JSON.parse(raw);
    const replay = readReplay(process.env[replayEnv] || findReplay(file.gameId));
    const n = new Set(replay.steps.map((s) => s.n));
    if (!file.steps.every((s) => n.has(s.n))) {
        throw new Error(`${file.gameId}: the lens file has steps its replay ${replay.file} does not have`);
    }
    return { raw, file, replay, gameId: file.gameId, round: new Map(replay.steps.map((s) => [s.n, s.state.round])), board: new Map(replay.steps.map((s) => [s.n, s.state])) };
}

function oldLensText() {
    if (fs.existsSync(OLD_LENS)) {
        return fs.readFileSync(OLD_LENS, 'utf8');
    }
    const f = JSON.parse(fs.readFileSync(OLD_LENS_FROM, 'utf8'));
    delete f.evaluator;
    for (const st of f.steps) {
        for (const s of SEATS) {
            delete st[s].parts;
        }
        for (const k of ['frame', 'kind', 'unit', 'tolerance']) {
            delete st.search?.[k];
        }
    }
    console.log(`${OLD_LENS} is missing: rebuilt the pre-08:40 file from ${OLD_LENS_FROM}`);
    return JSON.stringify(f);
}

const base = game(fs.readFileSync(BASE_LENS, 'utf8'), 'BASE_REPLAY');
const old = game(oldLensText(), 'OLD_REPLAY');
const demo = game(fs.readFileSync(DEMO_LENS, 'utf8'), 'DEMO_REPLAY');
for (const g of [base, demo]) {
    if (!g.file.evaluator?.terms?.unit?.every((t) => t.ruleTpl)) {
        throw new Error(`${g.gameId}: needs a current omni lens file (evaluator block with ruleTpl)`);
    }
}
if (old.file.evaluator) {
    throw new Error(`${old.gameId}: OLD_LENS must be a file written before 08:40 (no evaluator block)`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Evaluator blocks

const SOURCE = (what) => `studio/fixtures/lens-cases/make.mjs: test fixture, ${what}`;

function evaluator(e) {
    return {
        id: e.id, label: e.label, source: e.source, description: e.description, sees: e.sees ?? 'public', perspective: e.perspective ?? null,
        cardValues: e.cardValues ?? 'additive', sampling: e.sampling ?? 'every-step', constantWeights: e.constantWeights ?? true,
        scale: e.scale, quality: e.quality ?? null, terms: e.terms
    };
}

/** The terms with each literal rule (and the unit note) printed from its template with weights w. */
function termsFor(terms, w) {
    const fill = (tpl) => tpl.replace(/\{(\w+)\}/g, (_, k) => (k in w ? String(r4(w[k])) : '?'));
    const out = structuredClone(terms);
    for (const g of ['unit', 'base', 'side', 'joint']) {
        out[g] = out[g]?.map((t) => (t.ruleTpl ? { ...t, rule: fill(t.ruleTpl) } : t));
    }
    if (out.unitNoteTpl) {
        out.unitNote = fill(out.unitNoteTpl);
    }
    return out;
}

function lensFile(g, source, ev, weights, steps, weightSets) {
    return { schema: 'swu-lens/1', gameId: g.gameId, seed: g.file.seed, players: g.file.players, source, evaluator: ev, weights, ...(weightSets ? { weightSets } : {}), steps };
}

// ---------------------------------------------------------------------------------------------------------------------
// Case 2: omni-fitted. The in-sample logistic fit from the design pass (110 lens games with a winner, overall and per
// round bucket), marked fitted so the viewer takes its fitted path. Not a real fit: the held-out check did not beat the
// hand-set curve.

const FITTED_MAP = {
    kind: 'logistic', k: 0.082, b: 0.086, fitted: true,
    byRound: [{ from: 0, to: 3, k: 0.053, b: 0.38 }, { from: 4, to: 6, k: 0.088, b: 0.26 }, { from: 7, to: 9, k: 0.103, b: -0.24 }, { from: 10, to: 99, k: 0.076, b: -0.94 }]
};
const FITTED_QUALITY = { data: 'test fixture: the 110 lens games with a winner, 4-fold split by game (not a real fit)', games: 110, n: 16715, heldOut: true, brier: 0.184 };

function omniFitted(g) {
    const f = JSON.parse(g.raw);
    f.evaluator.label = 'Omni v1';
    f.evaluator.scale = { ...f.evaluator.scale, unit: 'points', typical: 25, toWinProb: FITTED_MAP };
    f.evaluator.quality = FITTED_QUALITY;
    return f;
}

// ---------------------------------------------------------------------------------------------------------------------
// Case 4: phase-weights. Omni v1's values with the unit weights scaled per phase and new hand and initiative weights; base
// and resources keep omni's weights, so each weight set gives its steps' values (up to rounding).

const PHASES = [
    { key: 'R1-3', label: 'Rounds 1-3', to: 3, unit: 1.15, hand: 2.2, initiative: 1.5 },
    { key: 'R4-6', label: 'Rounds 4-6', to: 6, unit: 1, hand: 1.6, initiative: 3 },
    { key: 'R7+', label: 'Rounds 7 on', to: Infinity, unit: 0.9, hand: 1.2, initiative: 3.5 }
];
/** omni weights that act on a unit's value (exhaustedMult multiplies them, so it stays) */
const UNIT_WEIGHTS = ['power', 'hp', 'cost', 'shield', 'upgrade', 'sentinel'];
const PHASE_MAP = {
    kind: 'logistic', k: 0.08, b: 0, fitted: true,
    byRound: [{ from: 0, to: 3, k: 0.05, b: 0.3 }, { from: 4, to: 6, k: 0.09, b: 0.2 }, { from: 7, to: 99, k: 0.1, b: -0.3 }]
};
const PHASE_QUALITY = { data: 'test fixture: eval-ladder-1, split by game (made-up numbers)', games: 206, n: 6742, heldOut: true, brier: 0.166, logloss: 0.49 };

function phaseWeights(g) {
    const w0 = g.file.weights;
    const phaseAt = (n) => PHASES.find((ph) => g.round.get(n) <= ph.to);
    const sets = Object.fromEntries(PHASES.map((ph) => [ph.key, {
        label: ph.label,
        weights: { ...w0, ...Object.fromEntries(UNIT_WEIGHTS.map((k) => [k, r4(w0[k] * ph.unit)])), hand: ph.hand, initiative: ph.initiative }
    }]));
    const seats = (st, ph) => SEATS.map((s) => rescaled(st[s], ph.unit, 1, { hand: st[s].hand.map(() => ph.hand), initiative: st[s].initiative ? ph.initiative : 0 }));
    let prev = null;
    const steps = g.file.steps.map((st) => {
        const ph = phaseAt(st.n);
        const [p1, p2] = seats(st, ph);
        const out = { n: st.n, p1, p2, edge: r2(p1.total - p2.total), weightSet: ph.key };
        if (prev && prev !== ph) {
            // this board scored with the previous step's weights (W5)
            const [q1, q2] = seats(st, prev);
            out.edgePrevWeights = r2(q1.total - q2.total);
        }
        prev = ph;
        return out;
    });
    const first = sets[phaseAt(g.file.steps[0].n).key].weights;
    return lensFile(g, SOURCE(`${g.gameId}'s Omni v1 values with weights per phase`), evaluator({
        id: 'omni-linear-v2-phase', label: 'Omni v2 by phase', source: 'bot/omni/evaluate.js with weights per phase (test fixture)',
        description: 'Test fixture: Omni v1\'s terms with weights that change at rounds 4 and 7 (made-up numbers). Each phase has its own weights.',
        constantWeights: false, scale: { unit: 'points', typical: 25, toWinProb: PHASE_MAP }, quality: PHASE_QUALITY, terms: termsFor(g.file.evaluator.terms, first)
    }), first, steps, sets);
}

// ---------------------------------------------------------------------------------------------------------------------
// Case 5: inline-weights. The hand weight drifts from omni's 1.8 to 2.4 over the game's rounds; full weights on every step.

function inlineWeights(g) {
    const w0 = g.file.weights;
    const last = Math.max(...g.round.values());
    const steps = g.file.steps.map((st) => {
        // rounded like a points value, so each hand card's value is the weight itself
        const hand = r2(w0.hand + 0.6 * Math.min(g.round.get(st.n), last) / last);
        const [p1, p2] = SEATS.map((s) => {
            const v = st[s];
            return seat({ base: v.base, ground: v.ground, space: v.space, hand: v.hand.map(() => hand), resources: v.resources, initiative: v.initiative, parts: v.parts });
        });
        return { n: st.n, p1, p2, edge: r2(p1.total - p2.total), weights: { ...w0, hand } };
    });
    return lensFile(g, SOURCE(`${g.gameId}'s Omni v1 values with a hand weight that drifts by round`), evaluator({
        id: 'omni-drift', label: 'Omni drift', source: 'bot/omni/evaluate.js with a drifting hand weight (test fixture)',
        description: 'Test fixture: Omni v1 with a hand weight that grows from 1.8 in round 0 to 2.4 in the last round. The weights are written on every step.',
        constantWeights: false, scale: structuredClone(g.file.evaluator.scale), terms: termsFor(g.file.evaluator.terms, steps[0].weights)
    }), steps[0].weights, steps);
}

// ---------------------------------------------------------------------------------------------------------------------
// Case 6: logit-linear, the lens proposal's example (c): a logistic model in log-odds, scored here from the replay, with
// extra terms (deck, discard, pressure) and a joint term (toward the player about to act).

const LIN_W = {
    power: 0.04, hp: 0.0175, sentinel: 0.05, groundPower: 0.007, spacePower: 0.008, baseHp: 0.023, baseLow: -0.06,
    hand: 0.03, resource: -0.012, deck: 0.011, deckLow: -0.04, discard: -0.006, pressure: 0.02, intercept: 0.09
};
const LIN_TERMS = {
    unit: [
        { key: 'power', label: 'Power', rule: 'power x 0.04', ruleTpl: 'power x {power}' },
        { key: 'hp', label: 'HP left', rule: 'HP left x 0.0175', ruleTpl: 'HP left x {hp}' },
        { key: 'sentinel', label: 'Sentinel', rule: '+0.05', ruleTpl: '+{sentinel}' },
        { key: 'arena', label: 'Arena power', rule: 'power x 0.007 on the ground, x 0.008 in space', ruleTpl: 'power x {groundPower} on the ground, x {spacePower} in space' }
    ],
    base: [
        { key: 'hp', label: 'Base HP', rule: 'HP left x 0.023', ruleTpl: 'HP left x {baseHp}' },
        { key: 'low', label: 'Low base', rule: '-0.06 at 8 HP or less', ruleTpl: '{baseLow} at 8 HP or less' }
    ],
    side: [
        { key: 'hand', label: 'Hand', rule: '0.03 per card', ruleTpl: '{hand} per card' },
        { key: 'resources', label: 'Resources', rule: '-0.012 per resource', ruleTpl: '{resource} per resource' },
        { key: 'deck', label: 'Deck', rule: '0.011 per card left, -0.04 at 5 or fewer', ruleTpl: '{deck} per card left, {deckLow} at 5 or fewer' },
        { key: 'discard', label: 'Discard', rule: '-0.006 per card', ruleTpl: '{discard} per card' },
        { key: 'pressure', label: 'Pressure', rule: '0.02 x power that can reach the enemy base', ruleTpl: '{pressure} x power that can reach the enemy base' }
    ],
    joint: [
        { key: 'toAct', label: 'Player to act', rule: 'the model\'s intercept, toward the player about to act', ruleTpl: '{intercept} toward the player about to act' }
    ]
};
const LIN_QUALITY = {
    data: 'test fixture: eval-ladder-1, split by game (made-up numbers)', games: 206, n: 6742, heldOut: true, brier: 0.168, logloss: 0.495,
    byRound: [{ from: 0, to: 3, n: 909, brier: 0.236 }], proven: { n: 76, right: 61 }
};

function linearSeat(ps) {
    const w = LIN_W;
    const unit = (u, arena) => ({ power: r4(u.p * w.power), hp: r4(Math.max(0, u.h - u.d) * w.hp), sentinel: u.sn ? w.sentinel : 0, arena: r4(u.p * arena) });
    const ground = ps.ground.map((u) => unit(u, w.groundPower));
    const space = ps.space.map((u) => unit(u, w.spacePower));
    const hpLeft = Math.max(0, ps.base.hp - ps.base.d);
    const baseParts = { hp: r4(hpLeft * w.baseHp), low: hpLeft <= 8 ? w.baseLow : 0 };
    // power that can reach the enemy base: the ready units'
    const ready = sum([...ps.ground, ...ps.space].filter((u) => !u.x).map((u) => u.p));
    const value = (p) => r4(sum(Object.values(p)));
    return seat({
        base: value(baseParts), ground: ground.map(value), space: space.map(value), hand: ps.hand.map(() => w.hand), resources: r4(ps.res.total * w.resource), initiative: 0,
        extra: { deck: r4(ps.deck * w.deck + (ps.deck <= 5 ? w.deckLow : 0)), discard: r4(ps.discard.length * w.discard), pressure: r4(ready * w.pressure) },
        parts: { base: baseParts, ground, space }
    }, r4);
}

function logitLinear(g) {
    const steps = g.replay.steps.map((st, i) => {
        const [p1, p2] = SEATS.map((s) => linearSeat(st.state.players[s]));
        // the player about to act on this board is the one who moves next
        const toAct = (g.replay.steps[i + 1]?.pid ?? st.state.initiative ?? 'p1') === 'p1' ? 1 : -1;
        const joint = { toAct: r4(toAct * LIN_W.intercept) };
        return { n: st.n, p1, p2, joint, edge: r4(p1.total - p2.total + joint.toAct) };
    });
    return lensFile(g, SOURCE(`the linear model of the lens proposal's example (c), scored from ${g.gameId}'s replay`), evaluator({
        id: 'linear-g2', label: 'Linear fit g2', source: 'position-eval bench, model linear (gen 2) (test fixture)',
        description: 'Test fixture: logistic regression on board features, as in the lens proposal\'s example (c). Numbers are log-odds.',
        scale: { unit: 'logit' }, quality: LIN_QUALITY, terms: LIN_TERMS
    }), LIN_W, steps);
}

// ---------------------------------------------------------------------------------------------------------------------
// Case 7: net-none. A chance per step and no per-card values (made from Omni v1's edge with another slope).

const NET_QUALITY = { data: 'test fixture: eval-ladder-1, split by game (made-up numbers)', games: 206, n: 6742, heldOut: true, brier: 0.167, logloss: 0.49 };

function netNone(g) {
    const steps = g.file.steps.map((st) => {
        const p = chance(0.07 * st.edge + 0.15);
        return { n: st.n, edge: r4(logit(p)), p1Win: p };
    });
    return lensFile(g, SOURCE(`a chance per step made from ${g.gameId}'s Omni v1 edge`), evaluator({
        id: 'mlp-deck-g2', label: 'Small net g2', source: 'position-eval bench, model mlp-deck (gen 2) (test fixture)',
        description: 'Test fixture: a small neural net that reads the board and both decklists and gives the chance that p1 wins. It does not split its answer into parts.',
        cardValues: 'none', scale: { unit: 'logit' }, quality: NET_QUALITY, terms: { unit: [], base: [], side: [] }
    }), null, steps);
}

// ---------------------------------------------------------------------------------------------------------------------
// Case 8: ablation. Card numbers are 0.8 x Omni v1's (they no longer add up to the edge); base, resources and initiative
// stay as the model's per-side numbers; totals only on every other step; the edge is Omni v1's.

function ablation(g) {
    const steps = g.file.steps.map((st, i) => {
        const [p1, p2] = SEATS.map((s) => {
            const v = st[s];
            const cut = (list) => list.map((x) => r2(0.8 * x));
            return { base: v.base, ground: cut(v.ground), space: cut(v.space), hand: cut(v.hand), resources: v.resources, initiative: v.initiative, total: i % 2 ? null : v.total };
        });
        return { n: st.n, p1, p2, edge: st.edge };
    });
    return lensFile(g, SOURCE(`0.8 x ${g.gameId}'s Omni v1 card values, as ablation values`), evaluator({
        id: 'ablation-g1', label: 'Ablation g1', source: 'card ablation over Omni v1 (test fixture)',
        description: 'Test fixture: each card\'s number is how much its owner\'s side loses when that card is removed and the board is scored again. These numbers don\'t add up.',
        cardValues: 'ablation', scale: structuredClone(g.file.evaluator.scale), terms: termsFor(g.file.evaluator.terms, g.file.weights)
    }), g.file.weights, steps);
}

// ---------------------------------------------------------------------------------------------------------------------
// Case 9: asymmetric-pair. Omni v1's terms weighed from one seat: its own units and the enemy base count more. Values stay
// good for each card's owner and the edge stays from p1's side; one file per perspective.

const AGGRO = { myUnits: 1.25, oppUnits: 0.85, myBase: 0.7, oppBase: 1.3 };

function aggro(g, perspective) {
    const w = { ...g.file.weights, ...AGGRO };
    const steps = g.file.steps.map((st) => {
        const [p1, p2] = SEATS.map((s) => (s === perspective ? rescaled(st[s], AGGRO.myUnits, AGGRO.myBase) : rescaled(st[s], AGGRO.oppUnits, AGGRO.oppBase)));
        return { n: st.n, p1, p2, edge: r2(p1.total - p2.total) };
    });
    // a file written before 08:40 has no terms of its own: use the current omni file's
    const terms = structuredClone((g.file.evaluator ?? base.file.evaluator).terms);
    terms.unitNoteTpl +=', then by {myUnits} for the weighing seat\'s own units and by {oppUnits} for the other seat\'s';
    for (const t of terms.base) {
        t.ruleTpl += ', then x {myBase} for the weighing seat\'s own base and x {oppBase} for the other base';
    }
    return lensFile(g, SOURCE(`${g.gameId}'s Omni v1 values weighed from ${perspective}'s seat`), evaluator({
        id: 'heur-aggro', label: 'Aggro', source: 'an aggressive weighing of Omni v1\'s terms (test fixture)',
        description: 'Test fixture: Omni v1\'s terms weighed the way an aggressive bot weighs them from its own seat: its own units x1.25, the other seat\'s units x0.85, its own base x0.7 and the other base x1.3.',
        perspective, scale: { unit: 'points', typical: 30, toWinProb: null }, terms: termsFor(terms, w)
    }), w, steps);
}

// ---------------------------------------------------------------------------------------------------------------------
// Case 10: uncalibrated-tenths. Every Omni v1 value times 10, with no typical lead and no chance map.

const TENTHS_WEIGHTS = ['power', 'hp', 'cost', 'shield', 'upgrade', 'sentinel', 'hand', 'resource', 'initiative', 'baseHp', 'danger'];

function tenths(g) {
    const w = { ...g.file.weights, ...Object.fromEntries(TENTHS_WEIGHTS.map((k) => [k, r4(g.file.weights[k] * 10)])) };
    const x10 = (list) => list.map((x) => r2(x * 10));
    const steps = g.file.steps.map((st) => {
        const [p1, p2] = SEATS.map((s) => rescaled(st[s], 10, 10, { hand: x10(st[s].hand), resources: r2(st[s].resources * 10), initiative: r2(st[s].initiative * 10) }));
        return { n: st.n, p1, p2, edge: r2(p1.total - p2.total) };
    });
    return lensFile(g, SOURCE(`${g.gameId}'s Omni v1 values times 10`), evaluator({
        id: 'bend-like', label: 'Bend-like', source: 'Omni v1 times 10 (test fixture)',
        description: 'Test fixture: Omni v1\'s values times 10, with no typical lead and no chance map, like an uncalibrated points score from another bot.',
        scale: { unit: 'points', toWinProb: null }, terms: termsFor(g.file.evaluator.terms, w)
    }), w, steps);
}

// ---------------------------------------------------------------------------------------------------------------------
// Case 11: sparse-decisions. A learned bot's own chance, logged only at the boards where it decided (here: where omni
// searched), with no per-card values.

function sparse(g) {
    const steps = g.file.steps.filter((st) => st.search).map((st) => {
        const p = chance(0.06 * st.edge - 0.1);
        return { n: st.n, edge: r4(logit(p)), p1Win: p };
    });
    return lensFile(g, SOURCE(`a chance at ${g.gameId}'s search steps only, made from its Omni v1 edge`), evaluator({
        id: 'learned-v4', label: 'Learned v4', source: 'rust-learned v4 decision log (test fixture)',
        description: 'Test fixture: a learned bot\'s own chance that p1 wins, written only at the boards where it decided. It gives no per-card values.',
        cardValues: 'none', sampling: 'decisions', scale: { unit: 'logit' }, terms: { unit: [], base: [], side: [] }
    }), null, steps);
}

// ---------------------------------------------------------------------------------------------------------------------
// Cases 12-14 and 17: omni-today with one change each, at the default path.

/** Case 12: the 9999 sentinel on the search step with the best value, -9998 on the last one, step.proven on two late steps. */
function searchProven(g) {
    const f = JSON.parse(g.raw);
    const searched = f.steps.filter((st) => st.search);
    const lost = searched.at(-1);
    const won = searched.slice(0, -1).reduce((a, st) => (st.search.value > a.search.value ? st : a));
    const sentinel = (se, value) => {
        // 9999: the move played wins on every line the search tried; a card whose regret was 0 wins too, any other keeps
        // its own value, so its regret becomes that value minus 9999. -9998: every move loses, so the regrets stay.
        const shift = (r) => (r == null || r === 0 || value < 0 ? r : r2(se.value + r - value));
        for (const z of ['ground', 'space', 'hand']) {
            se[z] = se[z]?.map(shift);
        }
        se.leader = shift(se.leader);
        se.buttons = se.buttons && mapValues(se.buttons, shift);
        se.value = value;
    };
    sentinel(won.search, 9999);
    sentinel(lost.search, -9998);
    const winner = g.replay.end?.winner === 'p2' ? 'p2' : 'p1';
    const proven = f.steps.slice(-3, -1);
    for (const st of proven) {
        const { search, ...rest } = st;
        f.steps[f.steps.indexOf(st)] = { ...rest, proven: winner, provenIn: 3, provenBy: 'and-or', ...(search ? { search } : {}) };
    }
    return { file: f, notes: { sees9999: won.n, sees9998: lost.n, proven: proven.map((st) => st.n), provenSeat: winner } };
}

/** Case 13: one step's p1 ground array one unit short (total and edge follow, so only I4 breaks there) and one step left out. */
function misaligned(g) {
    const f = JSON.parse(g.raw);
    const k = f.steps.findIndex((st, i) => i >= f.steps.length / 3 && st.p1.ground.length >= 2 && !st.search);
    const st = f.steps[k];
    const cut = st.p1.ground.pop();
    st.p1.parts?.ground.pop();
    st.p1.total = r2(st.p1.total - cut);
    st.edge = r2(st.p1.total - st.p2.total);
    const drop = Math.floor(f.steps.length / 2) === k ? Math.floor(f.steps.length / 2) + 1 : Math.floor(f.steps.length / 2);
    const dropped = f.steps[drop].n;
    f.steps.splice(drop, 1);
    return { file: f, notes: { shortened: st.n, dropped } };
}

/** Case 17: an extra side term (deck, 0.4 per card left) at the default path, declared and added into the totals. */
function defaultPathViolation(g) {
    const f = JSON.parse(g.raw);
    f.evaluator.terms.side.push({ key: 'deck', label: 'Deck', rule: '0.4 per card left', ruleTpl: '{deck} per card left' });
    f.weights.deck = 0.4;
    f.steps = f.steps.map((st) => {
        const players = g.board.get(st.n).players;
        const out = { ...st };
        for (const s of SEATS) {
            const { total, parts, ...six } = st[s];
            const extra = { deck: r2(0.4 * players[s].deck) };
            out[s] = { ...six, extra, total: r2(total + extra.deck), ...(parts ? { parts } : {}) };
        }
        out.edge = r2(out.p1.total - out.p2.total);
        return out;
    });
    return f;
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing

const pretty = (v) => JSON.stringify(v, null, 2) + '\n';

function put(rel, text) {
    const f = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
}

/** A lens file in a case folder: dir '' is the default path. `text` keeps exact copies byte for byte. */
const entry = (dir, gameId, file, text) => ({ dir, gameId, evaluator: file.evaluator ?? null, text: text ?? JSON.stringify(file) });

/**
 * One case folder. With `registry` (the dir to show first) it also gets evaluators.json, listing the dirs in the order
 * their first file comes, and an index.json per dir (the root's too).
 */
function writeCase(name, entries, registry) {
    fs.mkdirSync(path.join(OUT, name), { recursive: true });
    for (const e of entries) {
        put(path.join(name, e.dir, `${e.gameId}.json`), e.text);
    }
    if (registry == null) {
        return;
    }
    const dirs = [...new Set(entries.map((e) => e.dir))];
    const evOf = (dir) => entries.find((e) => e.dir === dir && e.evaluator)?.evaluator ?? null;
    put(path.join(name, 'evaluators.json'), pretty({ schema: 'swu-lens-index/1', default: registry, evaluators: dirs.map((dir) => ({ dir, id: evOf(dir)?.id ?? null })) }));
    for (const dir of dirs) {
        const games = entries.filter((e) => e.dir === dir).map((e) => e.gameId).sort();
        put(path.join(name, dir, 'index.json'), pretty({ schema: 'swu-lens-index/1', id: evOf(dir)?.id ?? null, dir, evaluator: evOf(dir), games, updated: UPDATED }));
    }
}

/** The tournament entry for a game: from its own tournament's index.json, else from the replay's header and end. */
function indexGame(g) {
    const idx = path.join(path.dirname(path.dirname(g.replay.file)), 'index.json');
    const hit = fs.existsSync(idx) ? JSON.parse(fs.readFileSync(idx, 'utf8')).games?.find((x) => x.id === g.gameId) : null;
    if (hit) {
        return hit;
    }
    const bot = (seat) => g.replay.header.players.find((p) => p.id === seat)?.bot ?? null;
    const end = g.replay.end;
    return {
        id: g.gameId, seed: g.replay.header.seed, p1: bot('p1'), p2: bot('p2'), winner: end?.winner ? bot(end.winner) : null, winnerSeat: end?.winner ?? null,
        rounds: end?.round ?? Math.max(...g.round.values()), steps: end?.steps ?? g.replay.steps.at(-1).n, outcome: end?.outcome ?? 'running', error: end?.error ?? null, ms: 0
    };
}

// Start from an empty folder, but only one this script made (or an empty one).
if (fs.existsSync(OUT)) {
    if (fs.readdirSync(OUT).length && !fs.existsSync(path.join(OUT, 'cases.json'))) {
        throw new Error(`${OUT} is not empty and was not written by make.mjs; give another folder`);
    }
    fs.rmSync(OUT, { recursive: true, force: true });
}

const B = base.gameId;
const O = old.gameId;
const D = demo.gameId;
const proven = searchProven(base);
const mis = misaligned(base);
const phase = phaseWeights(base);
const switches = phase.steps.filter((st) => st.edgePrevWeights != null);
const raw = (g) => entry('', g.gameId, g.file, g.raw);
const at = (dir, file) => entry(dir, file.gameId, file);

// Expectations are the lens design's fixture list, word for word.
const CASES = [
    {
        name: 'omni-today', games: [B], entries: [raw(base)],
        what: [`${B}.json, an exact copy of the current omni lens file.`],
        expect: [
            'every edge, total, chip, swing and pivotal marker equal to the reference;',
            'the label "Omni v1" and the badge "Omni v1 · points · rough guess · file";',
            'in the breakdown: "Rough guess, not fitted: N%" with N = the reference 50·(1+tanh(edge/25)), and a hollow dot;',
            'no % on the centre line;',
            'a dashed timeline line with the same y values as today, on its own axis;',
            'rule texts identical to the file\'s literal rules.'
        ]
    },
    {
        name: 'omni-fitted', games: [B, D], entries: [at('', omniFitted(base)), at('', omniFitted(demo))],
        what: [
            `${B}.json: a copy with label "Omni v1", typical 25, toWinProb {logistic, k 0.082, b 0.086, fitted true, byRound for rounds 0-3, 4-6, 7-9 and 10-99} and quality (Brier 0.184, 110 games).`,
            `${D}.json: the same change on a demo game that has evals. Serve EVALS_DIR=${PF}/dashboard/evals (STATIC_EVALS for a static build) to see both lines on one axis.`
        ],
        expect: [
            'the headline "Chance heuristic wins N%" from the fitted map, using the byRound entry for the step\'s round;',
            'the quality line naming Brier and games;',
            `a solid line on the 0-100% axis (load with \`${PF}/dashboard/evals/${D}.json\` on a demo game copy to see both on one axis);`,
            'swings in pp of the fitted chance.'
        ]
    },
    {
        name: 'legacy-old-file', games: [O], entries: [raw(old)],
        what: [`${O}.json, an exact copy of a lens file written before 08:40 (no evaluator block, no parts).`],
        expect: [
            '"Omni v1 (old file)", with numbers equal to the reference;',
            'an inspector split computed from the weights that adds up to each chip, with cost as "cost (the rest)" without card data and from card text with it;',
            'the rough chance line.'
        ]
    },
    {
        name: 'phase-weights', games: [B], entries: [at('omni-linear-v2-phase', phase)], registry: 'omni-linear-v2-phase',
        what: [
            'omni-linear-v2-phase/: unit values x1.15 in rounds 0-3, x1.0 in rounds 4-6, x0.9 from round 7; hand weight 2.2 / 1.6 / 1.2; initiative 1.5 / 3.0 / 3.5; base and resources as Omni v1.',
            `weightSets R1-3, R4-6 and R7+, weightSet on every step, edgePrevWeights at the 2 switches (n ${switches.map((st) => `${st.n}: edge ${st.edge}, with the previous weights ${st.edgePrevWeights}`).join('; n ')}).`,
            'toWinProb fitted with byRound (rounds 0-3, 4-6, 7-99).'
        ],
        expect: [
            'the "weights: Rounds 4-6" chip, and rule text with the new numbers after the switch;',
            'at a switch step, the sentence that splits the change into "new weights" and "the move itself";',
            '2 x-axis ticks and 3 labelled strip segments;',
            'a Weights tab with 3 columns and a highlight that moves;',
            'no pivotal marker caused by the switch.'
        ]
    },
    {
        name: 'inline-weights', games: [B], entries: [at('omni-drift', inlineWeights(base))], registry: 'omni-drift',
        what: ['omni-drift/: constantWeights false; full weights on every step, the hand weight going from 1.8 in round 0 to 2.4 in the last round (no edgePrevWeights); Omni v1\'s rough map.'],
        expect: [
            'the chip "weights change every step";',
            'a hand rule showing the weight at that step;',
            'a sparkline for hand in the strip;',
            'a "this step" column in the Weights tab;',
            'swing tooltips that say "includes a weight switch" where the hand weight changed during an action.'
        ]
    },
    {
        name: 'logit-linear', games: [B], entries: [at('linear-g2', logitLinear(base))], registry: 'linear-g2',
        what: ['linear-g2/: the lens proposal\'s example (c) scored from the replay: logit unit, extra deck / discard / pressure, joint toAct, no toWinProb, quality.'],
        expect: [
            '2-decimal chips;',
            'a khaki deck chip by the deck counter, a rose discard chip by the discard counter, and a grey pressure chip in the HQ row;',
            'a hatched "Player to act (both sides)" row;',
            'a Total row equal to the file totals;',
            'the headline % = sigmoid(edge);',
            'a solid line on the % axis;',
            'bars on the 1.2 log-odds half-bar.'
        ]
    },
    {
        name: 'net-none', games: [B], entries: [at('mlp-deck-g2', netNone(base))], registry: 'mlp-deck-g2',
        what: ['mlp-deck-g2/: cardValues none; p1Win on every step and edge = logit(p1Win); weights null; quality.'],
        expect: [
            'no chips, and the Card values button disabled with the title "Small net g2 gives a chance only, no card values";',
            'a breakdown with only the headline %, the edge in log-odds, quality, and "gives a chance only";',
            '"No weights: a learned model" in the Weights tab;',
            'a solid line on the % axis;',
            'swings from p1Win.'
        ]
    },
    {
        name: 'ablation', games: [B], entries: [at('ablation-g1', ablation(base))], registry: 'ablation-g1',
        what: ['ablation-g1/: cardValues ablation; card numbers = 0.8 x the Omni v1 values; base, resources and initiative as Omni v1; seat totals null on every odd-indexed step; edge copied from Omni v1; no parts.'],
        expect: [
            'dashed ⊖ chips;',
            'no lane Σ and no hand Σ;',
            'a seat Σ only on steps with a total;',
            'an "Other (not split)" row equal to edge − Σ rows;',
            '"Cards that matter most";',
            'the inspector note "what the score loses without this card".'
        ]
    },
    {
        name: 'asymmetric-pair', games: [B], entries: [at('heur-aggro@p1', aggro(base, 'p1')), at('heur-aggro@p2', aggro(base, 'p2'))], registry: 'heur-aggro@p1',
        what: ['heur-aggro@p1/ and heur-aggro@p2/: label "Aggro", perspective p1 / p2 (own units x1.25, other units x0.85, own base x0.7, other base x1.3); points, no map, typical 30.'],
        expect: [
            'both entries in the picker as "Aggro, as heuristic weighs it" and "Aggro, as omni weighs it";',
            'no % anywhere;',
            'bars on 0.6 × 30 = 18 points per half-bar;',
            'marker tooltips that say "sized from Aggro\'s points; not a chance".'
        ]
    },
    {
        name: 'uncalibrated-tenths', games: [B], entries: [at('bend-like', tenths(base))], registry: 'bend-like',
        what: ['bend-like/: every Omni v1 value x10 (weights x10 to match), no typical, toWinProb null.'],
        expect: [
            'no %;',
            'typical taken from the 90th percentile of |edge|, rounded, and printed as "bar end = N points";',
            'a dashed own-axis line with "top +N points".'
        ]
    },
    {
        name: 'sparse-decisions', games: [B], entries: [at('learned-v4', sparse(base))], registry: 'learned-v4',
        what: [`learned-v4/: sampling decisions; steps (with p1Win and edge = logit(p1Win)) only at the ${base.file.steps.filter((st) => st.search).length} search steps; cardValues none; weights null.`],
        expect: [
            'held values with "as of step N" in the tooltip and on the centre line;',
            'a stepAfter line;',
            'swings that share each interval evenly among the major actions.'
        ]
    },
    {
        name: 'search-proven', games: [B], entries: [at('', proven.file)],
        what: [
            `${B}.json: omni-today with search.value 9999 at n ${proven.notes.sees9999} (other cards' regrets become their value minus 9999), search.value -9998 at n ${proven.notes.sees9998}, and step.proven ${proven.notes.provenSeat} with provenIn 3 and provenBy "and-or" at n ${proven.notes.proven.join(' and ')}.`
        ],
        expect: [
            '"sees win" / "sees loss" regret tags and a plain (not gold) "search sees a win" badge at the sentinel steps, never the words forced or proven there;',
            'a gold "proven win" badge and gold timeline pins only at the step.proven steps;',
            '9999 nowhere on any axis, with the axis range unchanged.'
        ]
    },
    {
        name: 'misaligned', games: [B], entries: [at('', mis.file)], breaks: ['I4', 'I5'],
        what: [`${B}.json: omni-today with p1's ground array one unit short at n ${mis.notes.shortened} (its total and the edge follow, so only I4 breaks there) and step n ${mis.notes.dropped} left out (I5).`],
        expect: [
            'at those steps: no chips, "file doesn\'t match this board here" / "no value at this step", and a gap in the timeline;',
            'swing 0 for actions touching them;',
            'no estimate mixed in.'
        ]
    },
    {
        name: 'schema-2', games: [B], entries: [at('', { ...JSON.parse(base.raw), schema: 'swu-lens/2' })], breaks: ['schema'],
        what: [`${B}.json: omni-today with schema "swu-lens/2".`],
        expect: [
            'the message "This lens file is swu-lens/2; this viewer reads swu-lens/1";',
            'no score lane and no chips.'
        ]
    },
    {
        name: 'no-file', games: [D, B], entries: [],
        what: [
            'An empty lens folder: no game has a file. Open it with card text (the default CARD_TEXT) and without (CARD_TEXT= empty).',
            `${B} is there to hold the estimate against the lens writer's values (the omni-today case).`
        ],
        expect: [
            '"Omni v1 · estimated here" with dashed chips;',
            `with card text: values equal to the lens writer's within 0.02 (check against ${B} by hiding its file);`,
            'without card text: "card cost left out";',
            'with mount option estimate:false: "No score for this game" everywhere.'
        ]
    },
    {
        name: 'registry', games: [B, O],
        entries: [
            raw(base), raw(old), at('linear-g2', logitLinear(base)), at('mlp-deck-g2', netNone(old)), at('heur-aggro@p1', aggro(base, 'p1')), at('heur-aggro@p2', aggro(old, 'p2'))
        ],
        registry: '',
        what: [
            'evaluators.json lists "", linear-g2, mlp-deck-g2, heur-aggro@p1 and heur-aggro@p2 (default ""), with an index.json in every folder.',
            `${B} has a file in 3 of them: "" (omni-today), linear-g2 and heur-aggro@p1. ${O} has one in the other 3: "" (the pre-08:40 file), mlp-deck-g2 and heur-aggro@p2.`
        ],
        expect: [
            'a picker with only the sources that have this game;',
            'the default "" chosen first;',
            '?score=linear-g2 opening on that source;',
            'the choice saved and restored;',
            'the Compare toggle drawing only the fitted/model sources as thin lines.'
        ]
    },
    {
        name: 'default-path-violation', games: [B], entries: [at('', defaultPathViolation(base))], breaks: ['D2'],
        what: [`${B}.json: omni-today with a declared side term "deck" (0.4 per card left) and seat.extra.deck on every step at the default path; totals and edges include it.`],
        expect: ['The new viewer still reads it, but `npm run check:lens -- --validate` must report "D2: extra not allowed at the default path".']
    }
];

for (const c of CASES) {
    writeCase(c.name, c.entries, c.registry);
}

// Replays: one tournament with every game the cases use.
const games = [base, old, demo];
for (const g of games) {
    put(path.join('replays', TID, 'games', `${g.gameId}.jsonl`), fs.readFileSync(g.replay.file, 'utf8'));
}
const entries = games.map(indexGame);
put(path.join('replays', TID, 'index.json'), JSON.stringify({
    id: TID, createdAt: `${UPDATED.slice(0, -1)}.000Z`, engine: base.replay.header.engine ?? null, bots: [...new Set(entries.flatMap((e) => [e.p1, e.p2]))],
    gamesPerPairing: 1, games: entries
}));

const filesOf = (c) => c.entries.map((e) => (e.dir ? `${e.dir}/${e.gameId}.json` : `${e.gameId}.json`));
put('cases.json', pretty({
    tournament: TID, replays: `replays/${TID}/games`,
    cases: CASES.map((c, i) => ({ case: i + 1, name: c.name, lensDir: c.name, files: filesOf(c), registry: c.registry != null, games: c.games, breaks: c.breaks ?? [] }))
}));

const md = [
    '# Lens test fixtures',
    '',
    'Written by `make.mjs` (`node fixtures/lens-cases/make.mjs`, run from `studio/`). Don\'t edit these files: change the script and run it again. Every run writes the same bytes.',
    '',
    `The cases are the lens design's test fixtures 1-17. Fixture 18 (all current files) is not generated: it is \`${PF}/dashboard/lens\` with its replays.`,
    '',
    '- Each `<case>/` folder is a lens folder on its own, laid out like `dashboard/lens/`: default-path files at the top and other evaluators in subfolders. A case with a subfolder also has `evaluators.json` (`swu-lens-index/1`) and an `index.json` in every folder. A case with only default-path files has neither, like `dashboard/lens/` today.',
    `- \`replays/\` is a replays folder with one tournament, \`${TID}\`, holding every game the cases use: ${games.map((g) => `\`${g.gameId}\``).join(', ')}.`,
    '- `cases.json` is the same list for scripts, with the rules each case breaks on purpose.',
    '',
    'Open a case in the dev server (from `studio/`):',
    '',
    '```bash',
    'REPLAYS_DIR=fixtures/lens-cases/out/replays LENS_DIR=fixtures/lens-cases/out/<case> npm run dev',
    `# then http://localhost:5190/#/t/${TID}/g/<game>`,
    '```',
    '',
    `Static build: \`STATIC_REPLAYS=fixtures/lens-cases/out/replays STATIC_LENS=fixtures/lens-cases/out/<case> npm run build:static\`.`,
    '',
    `Check one case: \`npm run check:lens -- --validate fixtures/lens-cases/out/<case> --replays fixtures/lens-cases/out/replays/${TID}/games\`. Every case passes I1-I8 and D1-D4, except the ones the table lists.`,
    '',
    '| # | Case (folder) | Files | Games | Breaks on purpose |',
    '|---|---|---|---|---|',
    ...CASES.map((c, i) => `| ${i + 1} | \`${c.name}\` | ${filesOf(c).map((f) => `\`${f}\``).join('<br>') || '(none)'}${c.registry != null ? '<br>`evaluators.json`, `index.json`' : ''} | ${c.games.join('<br>')} | ${c.breaks?.join(', ') ?? '-'} |`),
    '',
    ...CASES.flatMap((c, i) => [
        `## ${i + 1}. ${c.name}`,
        '',
        `Folder \`${c.name}/\`. Games: ${c.games.map((g) => `\`#/t/${TID}/g/${g}\``).join(', ')}.`,
        '',
        ...c.what.map((w) => `- ${w}`),
        '',
        c.name === 'default-path-violation' ? 'Expect:' : 'The viewer must show:',
        '',
        ...c.expect.map((e) => `- ${e}`),
        ''
    ])
].join('\n');
put('README.md', md);

console.log(`${CASES.length} cases and ${games.length} replays in ${OUT}`);
