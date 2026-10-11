'use strict';

/**
 * Card-value lens: what every card on the table is worth to the omniscient bot, step by step.
 *
 *   node bot/omni/lens.js <tournament dir> [--decisions dir] [--out dir] [--game id]
 *
 * Reads replays (<dir>/index.json + games/*.jsonl) and writes <out>/<gameId>.json in the `swu-lens/1` format
 * (see /mnt/project-files/omni/LENS.md). Needs no engine, only card data for unit costs, so it works on any replay.
 *
 * Two layers:
 *   - static: each card's share of the position score the omni search uses at its leaves
 *     (bot/omni/evaluate.js), for every step of the game;
 *   - search: at the omni bot's own action windows (from the OMNI_LOG_DIR decision logs), the searched value of
 *     the best move led by each card, relative to the move it played.
 */

const fs = require('fs');
const path = require('path');

// the omni leaf score (bot/omni/evaluate.js); the lens reads it from snapshots instead of the engine
const { W, baseTermHp } = require('./evaluate');

let cards = null;
function cardData() {
    if (!cards) {
        const dir = path.join(__dirname, '..', '..', 'forceteki', 'test', 'json');
        const bySet = JSON.parse(fs.readFileSync(path.join(dir, '_setCodeMap.json'), 'utf8'));
        const byId = new Map(JSON.parse(fs.readFileSync(path.join(dir, '_cardMap.json'), 'utf8')).map((c) => [c.id, c]));
        cards = new Map();
        for (const [set, id] of Object.entries(bySet)) {
            const c = byId.get(id);
            if (c) {
                cards.set(set, { internalName: c.internalName, cost: c.cost ?? 0 });
            }
        }
    }
    return cards;
}

const r2 = (x) => Math.round(x * 100) / 100;

function unitValue(u) {
    const hpLeft = Math.max(0, (u.h ?? 0) - (u.d ?? 0));
    const cost = cardData().get(u.s)?.cost ?? 0;
    let v = (u.p ?? 0) * W.power + hpLeft * W.hp + cost * W.cost;
    const parts = { power: (u.p ?? 0) * W.power, hp: hpLeft * W.hp, cost: cost * W.cost, upgrades: 0, sentinel: 0 };
    for (const up of u.u ?? []) {
        const add = /^shield$/i.test(up.n) ? W.shield : W.upgrade;
        v += add;
        parts.upgrades += add;
    }
    if (u.sn) {
        v += W.sentinel;
        parts.sentinel = W.sentinel;
    }
    const mult = u.x ? W.exhaustedMult : 1;
    // parts are the card's value split by term, after the exhausted multiplier, so they sum to the value
    for (const k of Object.keys(parts)) {
        parts[k] = r2(parts[k] * mult);
    }
    return { v: v * mult, exhausted: !!u.x, parts };
}

function baseValue(b) {
    return baseTermHp(b.hp - b.d);
}

function baseParts(b) {
    const left = Math.max(0, b.hp - b.d);
    const danger = left <= W.dangerHp ? ((W.dangerHp - left) ** 2) * W.danger * W.baseMult : 0;
    return { hp: r2(left * W.baseHp * W.baseMult), danger: r2(-danger) };
}

/** Per-card values for one side of a recorder snapshot. Arrays line up with the snapshot's arrays. */
function sideLens(p, hasInitiative) {
    const ground = p.ground.map(unitValue);
    const space = p.space.map(unitValue);
    const out = {
        base: r2(baseValue(p.base)),
        ground: ground.map((x) => r2(x.v)),
        space: space.map((x) => r2(x.v)),
        hand: p.hand.map(() => W.hand),
        resources: r2(p.res.total * W.resource),
        initiative: hasInitiative ? W.initiative : 0
    };
    out.total = r2(out.base + out.ground.reduce((a, b) => a + b, 0) + out.space.reduce((a, b) => a + b, 0) + out.hand.length * W.hand + out.resources + out.initiative);
    // per-card split by term; the term names are listed in the file's evaluator.terms
    out.parts = { base: baseParts(p.base), ground: ground.map((x) => x.parts), space: space.map((x) => x.parts) };
    return out;
}

/** Static lens of a whole snapshot: {p1, p2, edge} with edge = p1 total - p2 total (what the search maximizes for p1). */
function lensFromSnapshot(state) {
    const p1 = sideLens(state.players.p1, state.initiative === 'p1');
    const p2 = sideLens(state.players.p2, state.initiative === 'p2');
    return { p1, p2, edge: r2(p1.total - p2.total) };
}

/**
 * Search layer for one omni decision: per card of the deciding side, the best searched value among moves started by
 * that card, minus the value of the move played (0 = the chosen card, negative = worse). Pass/initiative go to `buttons`.
 */
function searchLens(decision, state) {
    const side = state.players[decision.seat];
    const best = new Map();
    for (const m of decision.moves ?? []) {
        const head = m.move.split(' > ')[0];
        if (!best.has(head) || m.value > best.get(head)) {
            best.set(head, m.value);
        }
    }
    const chosen = decision.value ?? 0;
    const sign = 1; // decision values are from the deciding seat's point of view
    const rel = (c) => {
        const name = cardData().get(c.s)?.internalName;
        return name && best.has(name) ? r2(sign * (best.get(name) - chosen)) : null;
    };
    const buttons = {};
    for (const [head, v] of best) {
        if (/^(pass|claim initiative|take the initiative)$/i.test(head)) {
            buttons[head] = r2(v - chosen);
        }
    }
    // |value| >= 9000: the search saw a forced result (9999: `by` wins, -9998: `by` loses)
    const forced = Math.abs(decision.value ?? 0) >= 9000 ? (decision.value > 0 ? decision.seat : decision.seat === 'p1' ? 'p2' : 'p1') : null;
    return {
        by: decision.seat, value: decision.value, depth: decision.depth, nodes: decision.nodes, ms: decision.ms,
        pv: decision.pv, ground: side.ground.map(rel), space: side.space.map(rel), hand: side.hand.map(rel),
        leader: side.leader ? rel(side.leader) : null, buttons,
        frame: 'by', kind: 'alpha-beta', unit: 'points', tolerance: 0.05, ...(forced ? { proven: forced } : {})
    };
}

/**
 * Which score produced the numbers. Viewers should read term names and labels from here rather than assume a fixed
 * list: a later evaluator may have other terms, weights that change per step (then `constantWeights` is false and
 * each step carries `weights`), or no weights at all (a learned model: `weights` null, `parts` may be missing).
 */
// Contract: /mnt/project-files/omni/LENS.md (optional fields from viewer-kit/LENS-proposal.md, section 8 P1).
// `rule`/`unitNote` are literal text for old readers; `ruleTpl`/`unitNoteTpl` name weight keys in braces.
const EVALUATOR = {
    id: 'omni-linear-v1',
    label: 'Omni v1',
    source: 'bot/omni/evaluate.js',
    description: 'Hand-set linear score from the original heuristic bot, with the low-base-HP penalty subtracted. Not fitted to data yet.',
    sees: 'public',
    constantWeights: true,
    // toWinProb is today's (1 + tanh(edge / 25)) / 2 written as a logistic; a hand-set guess, not fitted
    scale: { unit: 'points', typical: 25, toWinProb: { kind: 'logistic', k: 0.08, b: 0, fitted: false } },
    // measured by the Holotable thread on the 110 lens games with a winner (2026-10-11); the map was never fitted
    quality: {
        data: 'the 110 lens games with a winner (games/demo, results/omni-ref-1..6, results/omni-selfplay); the map was never fitted, so every game is held out',
        games: 110, n: 16715, heldOut: true, brier: 0.1692, logloss: 0.4972, acc: 0.7294,
        byRound: [
            { from: 0, to: 3, n: 4514, brier: 0.2406, logloss: 0.6735 },
            { from: 4, to: 6, n: 5934, brier: 0.1613, logloss: 0.4837 },
            { from: 7, to: 9, n: 3609, brier: 0.1181, logloss: 0.3596 },
            { from: 10, to: 99, n: 2658, brier: 0.1350, logloss: 0.4147 }
        ],
        calibration: [
            { n: 1299, p: 0.043, y: 0.003 }, { n: 982, p: 0.148, y: 0.147 }, { n: 1036, p: 0.251, y: 0.248 },
            { n: 1351, p: 0.357, y: 0.46 }, { n: 2191, p: 0.455, y: 0.486 }, { n: 2579, p: 0.544, y: 0.562 },
            { n: 1745, p: 0.646, y: 0.708 }, { n: 1700, p: 0.748, y: 0.709 }, { n: 1483, p: 0.852, y: 0.845 },
            { n: 2349, p: 0.961, y: 0.971 }
        ]
    },
    terms: {
        unit: [
            { key: 'power', label: 'Power', rule: 'power x 1.3', ruleTpl: 'power x {power}' },
            { key: 'hp', label: 'HP left', rule: 'remaining HP x 0.9', ruleTpl: 'remaining HP x {hp}' },
            { key: 'cost', label: 'Cost', rule: 'printed cost x 0.25', ruleTpl: 'printed cost x {cost}' },
            { key: 'upgrades', label: 'Upgrades', rule: '2.2 per Shield, 0.6 per other upgrade', ruleTpl: '{shield} per Shield, {upgrade} per other upgrade' },
            { key: 'sentinel', label: 'Sentinel', rule: '+1', ruleTpl: '+{sentinel}' }
        ],
        unitNote: 'every unit part is multiplied by 0.85 when the unit is exhausted',
        unitNoteTpl: 'every unit part is multiplied by {exhaustedMult} when the unit is exhausted',
        base: [
            { key: 'hp', label: 'Base HP', rule: 'HP left x 0.9 x 1.5', ruleTpl: 'HP left x {baseHp} x {baseMult}' },
            { key: 'danger', label: 'Danger', rule: '-(12 - HP left)^2 / 6 x 1.5 under 12 HP', ruleTpl: '-({dangerHp} - HP left)^2 x {danger} x {baseMult} under {dangerHp} HP' }
        ],
        side: [
            { key: 'hand', label: 'Hand', rule: '1.8 per card', ruleTpl: '{hand} per card' },
            { key: 'resources', label: 'Resources', rule: '1.4 per resource', ruleTpl: '{resource} per resource' },
            { key: 'initiative', label: 'Initiative', rule: '2.5 for the side holding it', ruleTpl: '{initiative} for the side holding it', transient: true }
        ]
    }
};

/** One value per line; a line that does not parse (a torn write on the shared drive) becomes null, so line k stays line k. */
function readJsonl(file) {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
        try {
            return JSON.parse(l);
        } catch {
            return null;
        }
    });
}

function buildLens(gameFile, decisionsDir) {
    const lines = readJsonl(gameFile).filter(Boolean);
    const header = lines.find((l) => l.t === 'header');
    const gameId = path.basename(gameFile, '.jsonl');
    // decisions of omni bots in this game, per seat, in order
    const queues = {};
    for (const pl of header?.players ?? []) {
        const f = decisionsDir && path.join(decisionsDir, `${header.seed}-${pl.bot}-${pl.id}.jsonl`);
        if (f && fs.existsSync(f)) {
            queues[pl.id] = readJsonl(f);
        }
    }
    const steps = [];
    let prevState = null;
    for (const l of lines) {
        if (l.t !== 'step' || !l.state) {
            continue;
        }
        const s = { n: l.n, ...lensFromSnapshot(l.state) };
        // the k-th actionWindow step of a seat is that seat's k-th logged decision; the step's state is after the move,
        // so the search layer is aligned with the previous step's board (what the bot was looking at)
        if (queues[l.pid] && /^actionWindow/.test(l.prompt ?? '')) {
            const d = queues[l.pid].shift();
            if (d && prevState) {
                steps[steps.length - 1].search = searchLens(d, prevState);
            }
        }
        steps.push(s);
        prevState = l.state;
    }
    return {
        schema: 'swu-lens/1', gameId, seed: header?.seed ?? null,
        players: (header?.players ?? []).map((p) => ({ id: p.id, bot: p.bot })),
        source: 'bot/omni/lens.js: static = omni leaf evaluation (bot/omni/evaluate.js); search = omni decision logs',
        evaluator: EVALUATOR,
        weights: W,
        steps
    };
}

function main() {
    const argv = process.argv.slice(2);
    const opt = (n, d) => {
        const i = argv.indexOf(`--${n}`);
        return i >= 0 ? argv[i + 1] : d;
    };
    const dir = argv[0];
    const out = path.resolve(opt('out', '/mnt/project-files/dashboard/lens'));
    const decisions = opt('decisions', process.env.OMNI_LOG_DIR ?? null);
    const only = opt('game', null);
    fs.mkdirSync(out, { recursive: true });
    const gamesDir = path.join(dir, 'games');
    for (const f of fs.readdirSync(gamesDir).filter((x) => x.endsWith('.jsonl'))) {
        const id = path.basename(f, '.jsonl');
        if (only && id !== only) {
            continue;
        }
        const lens = buildLens(path.join(gamesDir, f), decisions);
        const file = path.join(out, `${id}.json`);
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(lens));
        fs.renameSync(`${file}.tmp`, file);
        console.log(`${id}: ${lens.steps.length} steps, ${lens.steps.filter((s) => s.search).length} search decisions -> ${file}`);
    }
}

if (require.main === module) {
    main();
}

module.exports = { lensFromSnapshot, searchLens, buildLens, readJsonl };
