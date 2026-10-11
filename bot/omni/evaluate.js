'use strict';

/**
 * Position score used by the omniscient search at its leaves (and by the lens).
 *
 * Same terms and weights as `evaluate` in bot/players/heuristic.js, with one fix: there the "danger" part of the
 * base term is added, so a side's score rises as its own base drops below ~9 HP. Here it is subtracted, so the
 * score falls faster the closer a base is to 0 (monotonic in base HP). heuristic.js is left as it is, because other
 * bots and recorded results depend on it.
 */

const W = { power: 1.3, hp: 0.9, cost: 0.25, shield: 2.2, upgrade: 0.6, sentinel: 1.0, exhaustedMult: 0.85, hand: 1.8, resource: 1.4, initiative: 2.5, baseHp: 0.9, baseMult: 1.5, dangerHp: 12, danger: 1 / 6 };

function unitValue(u) {
    let v = u.getPower() * W.power + Math.max(0, u.remainingHp) * W.hp + (u.cost ?? 0) * W.cost;
    for (const up of u.upgrades ?? []) {
        v += up.internalName === 'shield' ? W.shield : W.upgrade;
    }
    if (u.hasSomeKeyword?.('sentinel')) {
        v += W.sentinel;
    }
    return u.exhausted ? v * W.exhaustedMult : v;
}

/** Base HP term from HP left: 0.9 per HP, minus a growing penalty under 12 HP. */
function baseTermHp(hp) {
    const left = Math.max(0, hp);
    return (left * W.baseHp - (left <= W.dangerHp ? ((W.dangerHp - left) ** 2) * W.danger : 0)) * W.baseMult;
}

function sideValue(p) {
    let v = baseTermHp(p.base.getHp() - p.base.damage);
    for (const u of p.getArenaUnits()) {
        v += unitValue(u);
    }
    v += p.hand.length * W.hand + p.resources.length * W.resource;
    if (p.hasInitiative()) {
        v += W.initiative;
    }
    return v;
}

/** Score for `pid` (higher is better); terminal positions are scored by the caller. */
function evaluate(eg, pid) {
    const me = eg.player(pid);
    return sideValue(me) - sideValue(me.opponent);
}

module.exports = { evaluate, baseTermHp, W };
