'use strict';

/**
 * Deck makers for experiments. A deck here is { name, leader, base, cards: [setCode, ...] } (one entry per copy);
 * `toList` turns it into the SWUDB-format list the engine and bot/decklists.js take, `fromList` reads one back.
 *
 *   randomDeck   aspect-legal random cards (what bot/env.js deals, but for a chosen leader and base)
 *   statDeck     a simple hand-written builder: units only, the best printed stats for their cost, on the curve and
 *                arena split of the real tournament decks. The baseline a learned builder must beat.
 *   mutate       swap k copies for random aspect-legal cards (local search and training data)
 */
const { penalty } = require('./cards');

const MAX_COPIES = 3;

/** Cost curve of the 27 real Premier decks (bot/decks/ash-meta-2026-09.json), scaled to 50 cards. */
const REAL_CURVE = { 1: 4, 2: 12, 3: 11, 4: 8, 5: 6, 6: 3, 7: 3, 8: 3 };
const SPACE_SHARE = 0.37;

function toList(d) {
    const tally = new Map();
    for (const c of d.cards) {
        tally.set(c, (tally.get(c) ?? 0) + 1);
    }
    return {
        metadata: { name: d.name },
        leader: { id: d.leader, count: 1 },
        base: { id: d.base, count: 1 },
        deck: [...tally].map(([id, count]) => ({ id, count }))
    };
}

function fromList(l, pool = null) {
    const cards = [];
    for (const e of l.deck) {
        const code = pool ? pool.get(e.id)?.setCode ?? e.id : e.id;
        for (let i = 0; i < e.count; i++) {
            cards.push(code);
        }
    }
    const canon = (id) => (pool ? pool.get(id)?.setCode ?? id : id);
    return { name: l.metadata?.name ?? `${l.leader.id}/${l.base.id}`, leader: canon(l.leader.id), base: canon(l.base.id), cards };
}

const counts = (cards) => {
    const m = new Map();
    for (const c of cards) {
        m.set(c, (m.get(c) ?? 0) + 1);
    }
    return m;
};

function randomDeck(pool, leader, base, rng, { size = 50, name = null } = {}) {
    const legal = pool.inAspect(leader, base);
    const n = new Map();
    const cards = [];
    let guard = 0;
    while (cards.length < size && guard++ < 100000) {
        const c = legal[Math.floor(rng() * legal.length)];
        if ((n.get(c.setCode) ?? 0) >= MAX_COPIES) {
            continue;
        }
        n.set(c.setCode, (n.get(c.setCode) ?? 0) + 1);
        cards.push(c.setCode);
    }
    return { name: name ?? `random:${leader}/${base}`, leader, base, cards };
}

/** Printed stat value of a unit beyond what its cost buys (least squares over all units in the pool), plus keywords. */
function statScorer(pool) {
    const units = pool.main.filter((c) => c.type === 'unit');
    const xs = units.map((c) => c.cost),
        ys = units.map((c) => c.power + c.hp);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length,
        my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0,
        sxx = 0;
    xs.forEach((x, i) => {
        sxy += (x - mx) * (ys[i] - my);
        sxx += (x - mx) ** 2;
    });
    const slope = sxy / sxx,
        icpt = my - slope * mx;
    const KW = { sentinel: 1, shielded: 1.5, overwhelm: 0.5, raid: 1, restore: 1, saboteur: 0.5, ambush: 1, grit: 0.5, hidden: 0.5 };
    return (c) => c.power + c.hp - (icpt + slope * c.cost) + c.keywords.reduce((a, k) => a + (KW[k] ?? 0), 0);
}

function statDeck(pool, leader, base, { size = 50, name = null, scorer = null } = {}) {
    const score = scorer ?? statScorer(pool);
    const units = pool.inAspect(leader, base).filter((c) => c.type === 'unit');
    const total = Object.values(REAL_CURVE).reduce((a, b) => a + b, 0);
    const cards = [];
    for (const [cost, want0] of Object.entries(REAL_CURVE)) {
        const want = Math.round((want0 * size) / total);
        const bucket = units.filter((c) => (Number(cost) === 8 ? c.cost >= 8 : c.cost === Number(cost)));
        const wantSpace = Math.round(want * SPACE_SHARE);
        const fill = (list, k) => {
            const ranked = [...list].sort((a, b) => score(b) - score(a) || (a.setCode < b.setCode ? -1 : 1));
            const out = [];
            for (const c of ranked) {
                for (let i = 0; i < (c.unique ? 2 : MAX_COPIES) && out.length < k; i++) {
                    out.push(c.setCode);
                }
            }
            return out;
        };
        const space = fill(bucket.filter((c) => c.arena === 'space'), wantSpace);
        const ground = fill(bucket.filter((c) => c.arena !== 'space'), want - space.length);
        cards.push(...space, ...ground);
    }
    // a short bucket leaves the deck short: top up from the best units left
    if (cards.length < size) {
        const n = counts(cards);
        const ranked = [...units].sort((a, b) => score(b) - score(a));
        for (const c of ranked) {
            while (cards.length < size && (n.get(c.setCode) ?? 0) < MAX_COPIES) {
                cards.push(c.setCode);
                n.set(c.setCode, (n.get(c.setCode) ?? 0) + 1);
            }
        }
    }
    return { name: name ?? `stat:${leader}/${base}`, leader, base, cards: cards.slice(0, size) };
}

/** Replace k random copies with random aspect-legal cards (copy limit kept). */
function mutate(pool, d, rng, k, { name = null } = {}) {
    const legal = pool.inAspect(d.leader, d.base);
    const cards = [...d.cards];
    const n = counts(cards);
    for (let i = 0; i < k; i++) {
        const at = Math.floor(rng() * cards.length);
        let c,
            guard = 0;
        do {
            c = legal[Math.floor(rng() * legal.length)].setCode;
        } while ((n.get(c) ?? 0) >= MAX_COPIES && guard++ < 1000);
        n.set(cards[at], n.get(cards[at]) - 1);
        n.set(c, (n.get(c) ?? 0) + 1);
        cards[at] = c;
    }
    return { name: name ?? `${d.name}~${k}`, leader: d.leader, base: d.base, cards };
}

/** Problems that make a deck illegal in Premier (size, copies). Aspect penalties are legal, so only counted. */
function premierProblems(pool, d) {
    const p = [];
    if (d.cards.length < 50) {
        p.push(`${d.cards.length} cards`);
    }
    for (const [c, k] of counts(d.cards)) {
        if (!pool.get(c)) {
            p.push(`${c} unknown`);
        } else if (k > MAX_COPIES) {
            p.push(`${c} x${k}`);
        }
    }
    return p;
}

const offAspectCopies = (pool, d) => {
    const prov = pool.provided(d.leader, d.base);
    return d.cards.filter((c) => penalty(pool.get(c), prov) > 0).length;
};

module.exports = { toList, fromList, randomDeck, statDeck, statScorer, mutate, premierProblems, offAspectCopies, counts, REAL_CURVE, MAX_COPIES };
