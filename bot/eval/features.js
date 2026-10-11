'use strict';

/**
 * Position features from a recorder Snapshot (bot/recorder.js), seen by one player (the "judge").
 *
 * Everything works on the snapshot, not on live engine objects, so the same evaluator scores
 * recorded games (any replay, any machine with card data) and positions inside a lookahead bot
 * (which calls recorder.snapshot(eg) first).
 *
 * Views:
 *   subjective  the judge sees its own hand; the opponent's hand is only a count
 *   objective   both hands are visible (an observer who sees everything but the future)
 *
 * Hidden hands: with `decks` (both 50-card decklists, as set codes) the opponent's hidden hand is valued as
 * hand size x the average of the cards of their decklist not yet seen (discard, arena). This is the
 * "both decks are known, as in a tournament" model. Without `decks` a fixed prior card is used, so only the
 * hand size carries information.
 */

const { cardDb } = require('./cards');

// average card of a random 50-card deck (measured on 200 env.randomDeck decks; only used when decklists are unknown)
const PRIOR = { cost: 3.4, unit: 0.62, stats: 4.6, cheap: 0.55 };

const SIDE_KEYS = [
    'baseHp', 'baseLow', 'units', 'power', 'hp', 'readyPower', 'groundPower', 'spacePower', 'boardCost',
    'sentinel', 'raid', 'overwhelm', 'saboteur', 'restore', 'grit', 'shields', 'upgrades',
    'leaderDeployed', 'leaderReady', 'resources', 'readyResources', 'hand', 'handCost', 'handStats', 'handPlayable',
    'deck', 'deckLow', 'discard', 'initiative', 'pressure'
];
const GLOBAL_KEYS = ['round', 'toAct'];
const NAMES = [...SIDE_KEYS.map((k) => `me.${k}`), ...SIDE_KEYS.map((k) => `opp.${k}`), ...GLOBAL_KEYS];

const other = (seat) => (seat === 'p1' ? 'p2' : 'p1');

function cardStats(info) {
    if (!info) {
        return { cost: 0, unit: 0, stats: 0 };
    }
    return { cost: info.cost, unit: info.unit ? 1 : 0, stats: info.unit ? info.power + info.hp : info.upgrade ? info.upPower + info.upHp : 0 };
}

/** Average hidden card of a player: their decklist minus every card of theirs that is already public. */
function hiddenAverage(deck, ps, db) {
    if (!deck) {
        return PRIOR;
    }
    const left = new Map();
    for (const s of deck) {
        left.set(s, (left.get(s) ?? 0) + 1);
    }
    const seen = [...ps.discard, ...ps.ground, ...ps.space, ...[...ps.ground, ...ps.space].flatMap((u) => u.u ?? [])];
    for (const c of seen) {
        if (c.s && left.get(c.s) > 0) {
            left.set(c.s, left.get(c.s) - 1);
        }
    }
    let n = 0,
        cost = 0,
        unit = 0,
        stats = 0,
        cheap = 0;
    const res = ps.res.total;
    for (const [s, k] of left) {
        if (k <= 0) {
            continue;
        }
        const st = cardStats(db.get(s));
        n += k;
        cost += k * st.cost;
        unit += k * st.unit;
        stats += k * st.stats;
        cheap += k * (st.cost <= res + 1 ? 1 : 0);
    }
    return n ? { cost: cost / n, unit: unit / n, stats: stats / n, cheap: cheap / n } : PRIOR;
}

function sideFeatures(ps, opp, state, seat, { handVisible, deck, db }) {
    const f = Object.fromEntries(SIDE_KEYS.map((k) => [k, 0]));
    const hp = Math.max(0, ps.base.hp - ps.base.d);
    f.baseHp = hp;
    f.baseLow = hp < 10 ? ((10 - hp) ** 2) / 10 : 0;
    for (const u of [...ps.ground, ...ps.space]) {
        const info = db.get(u.s);
        const rem = Math.max(0, u.h - u.d);
        f.units++;
        f.power += u.p;
        f.hp += rem;
        if (!u.x) {
            f.readyPower += u.p;
        }
        if (ps.space.includes(u)) {
            f.spacePower += u.p;
        } else {
            f.groundPower += u.p;
        }
        f.boardCost += info?.cost ?? 0;
        if (u.sn || info?.kw.has('sentinel')) {
            f.sentinel++;
        }
        for (const k of ['raid', 'overwhelm', 'saboteur', 'restore', 'grit']) {
            if (info?.kw.has(k)) {
                f[k]++;
            }
        }
        for (const up of u.u ?? []) {
            if (/^shield$/i.test(up.n)) {
                f.shields++;
            } else {
                f.upgrades++;
            }
        }
    }
    f.leaderDeployed = ps.leader?.dep ? 1 : 0;
    f.leaderReady = ps.leader && !ps.leader.dep && !ps.leader.x ? 1 : 0;
    f.resources = ps.res.total;
    f.readyResources = ps.res.ready;
    f.hand = ps.hand.length;
    if (handVisible) {
        for (const c of ps.hand) {
            const st = cardStats(db.get(c.s));
            f.handCost += st.cost;
            f.handStats += st.stats;
            f.handPlayable += st.cost <= ps.res.total + 1 ? 1 : 0;
        }
    } else {
        const avg = hiddenAverage(deck, ps, db);
        f.handCost = f.hand * avg.cost;
        f.handStats = f.hand * avg.stats;
        f.handPlayable = f.hand * avg.cheap;
    }
    f.deck = ps.deck;
    f.deckLow = ps.deck < 5 ? 5 - ps.deck : 0;
    f.discard = ps.discard.length;
    f.initiative = state.initiative === seat ? 1 : 0;
    // share of the opponent's remaining base this side's board threatens per round (capped)
    const oppHp = Math.max(1, opp.base.hp - opp.base.d);
    f.pressure = Math.min(2, f.power / oppHp);
    return f;
}

/**
 * Features of `state` in the frame of `judge` ('p1' | 'p2').
 * opts: { view: 'subjective' | 'objective', decks: {p1: [setCode], p2: [setCode]} | null, toAct: 'p1' | 'p2' | null, db }
 * Returns { me, opp, g } objects; `vector()` flattens in NAMES order.
 */
function frameFeatures(state, judge, { view = 'subjective', decks = null, toAct = null, db = cardDb() } = {}) {
    const o = other(judge);
    const P = state.players;
    return {
        me: sideFeatures(P[judge], P[o], state, judge, { handVisible: true, deck: decks?.[judge], db }),
        opp: sideFeatures(P[o], P[judge], state, o, { handVisible: view === 'objective', deck: decks?.[o], db }),
        g: { round: state.round ?? 0, toAct: toAct == null ? 0 : toAct === judge ? 1 : -1 }
    };
}

function vector(fr) {
    return [...SIDE_KEYS.map((k) => fr.me[k]), ...SIDE_KEYS.map((k) => fr.opp[k]), fr.g.round, fr.g.toAct];
}

/** Terminal check from the snapshot: 1 judge won, 0 judge lost, null not decided. */
function terminal(state, judge) {
    const dead = (s) => s.base.hp - s.base.d <= 0;
    const me = dead(state.players[judge]);
    const op = dead(state.players[other(judge)]);
    if (me && !op) {
        return 0;
    }
    if (op && !me) {
        return 1;
    }
    return null;
}

module.exports = { frameFeatures, vector, terminal, NAMES, SIDE_KEYS, GLOBAL_KEYS, PRIOR, other };
