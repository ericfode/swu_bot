'use strict';

/**
 * A deterministic, free evaluator over replay snapshots. Two uses:
 *  - a baseline curve to compare the LLM views against (does the LLM know more than material counting?);
 *  - running the whole pipeline offline, with no API key.
 *
 * It reads only public counts (hand size, not hand contents), so its subjective and objective views coincide.
 * Its "omniscient" view is outcome-anchored: the objective estimate pulled toward the real result in proportion to
 * how far through the game the checkpoint is. That is a stand-in, not hindsight reasoning.
 */

const W = { power: 1.3, hp: 0.9, hand: 1.8, resource: 1.4, initiative: 2.5, baseHp: 0.9, leader: 3 };
const SCALE = 0.11; // logistic temperature: a 10-point value lead is about 75%

const logistic = (x) => 1 / (1 + Math.exp(-x));
const logit = (p) => Math.log(p / (1 - p));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function sideTerms(p, hasInit) {
    const units = [...p.ground, ...p.space];
    const board = units.reduce((v, u) => v + (u.p * W.power + Math.max(0, u.h - u.d) * W.hp) * (u.x ? 0.85 : 1), 0) + (p.leader?.dep ? W.leader : 0);
    const hp = Math.max(0, p.base.hp - p.base.d);
    return {
        board,
        // base HP matters more the lower it gets
        base_race: hp * W.baseHp * 1.5 - (hp <= 12 ? ((12 - hp) ** 2) / 6 : 0),
        cards: p.hand.length * W.hand,
        resources: p.res.total * W.resource,
        initiative: hasInit ? W.initiative : 0,
        dead: hp <= 0
    };
}

/** P(p1 wins) and per-factor advantages in [-1,1] for p1. */
function evaluateState(state) {
    const a = sideTerms(state.players.p1, state.initiative === 'p1');
    const b = sideTerms(state.players.p2, state.initiative === 'p2');
    if (a.dead || b.dead) {
        return { p1: a.dead ? 0 : 1, factors: { board: 0, base_race: a.dead ? -1 : 1, cards: 0, resources: 0, initiative: 0 } };
    }
    const keys = ['board', 'base_race', 'cards', 'resources', 'initiative'];
    const factors = {};
    let total = 0;
    for (const k of keys) {
        const d = a[k] - b[k];
        total += d;
        factors[k] = Number(Math.tanh(d / 8).toFixed(3));
    }
    return { p1: clamp(logistic(total * SCALE), 0.01, 0.99), factors };
}

/** Same shape as an LLM checkpoint answer, for one view. seat = whose win probability p_win is. */
function checkpointAnswer(state, seat) {
    const e = evaluateState(state);
    const flip = seat === 'p2';
    const factors = Object.fromEntries(Object.entries(e.factors).map(([k, v]) => [k, flip ? -v : v]));
    const key = Object.entries(factors).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))[0][0];
    return { p_win: flip ? 1 - e.p1 : e.p1, confidence: 0.5, factors, key_factor: key, why: 'material, base race, cards, resources and initiative' };
}

/** Outcome-anchored stand-in for the omniscient view. */
function omniscientAnswer(cps, states, winner) {
    const target = winner === 'p1' ? 0.99 : winner === 'p2' ? 0.01 : 0.5;
    const n = cps.length;
    const evals = cps.map((cp, j) => {
        const p = evaluateState(states[j]).p1;
        const w = n > 1 ? (j / (n - 1)) ** 1.5 : 1;
        return { i: cp.i, p1: Number(logistic((1 - w) * logit(clamp(p, 0.01, 0.99)) + w * logit(target)).toFixed(4)), note: '' };
    });
    return { evals, turning_points: [], summary: 'Heuristic stand-in: the objective estimate pulled toward the actual result as the game progresses.' };
}

module.exports = { evaluateState, checkpointAnswer, omniscientAnswer };
