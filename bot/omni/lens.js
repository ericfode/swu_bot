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
    return { v: v * mult, exhausted: !!u.x, parts };
}

function baseValue(b) {
    return baseTermHp(b.hp - b.d);
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
    return {
        by: decision.seat, value: decision.value, depth: decision.depth, nodes: decision.nodes, ms: decision.ms,
        pv: decision.pv, ground: side.ground.map(rel), space: side.space.map(rel), hand: side.hand.map(rel),
        leader: side.leader ? rel(side.leader) : null, buttons
    };
}

function readJsonl(file) {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function buildLens(gameFile, decisionsDir) {
    const lines = readJsonl(gameFile);
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

module.exports = { lensFromSnapshot, searchLens, buildLens };
