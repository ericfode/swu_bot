'use strict';

function ref(eg, c) {
    const { placedRef } = require('../../view');
    const v = placedRef(eg, c);
    return { id: v.id, setCode: v.s || (c.internalName === 'shield' ? 'TOKEN_SHIELD' : null), name: c.internalName };
}
function fullState(eg, actor = null) {
    const players = {};
    for (const pid of eg.ids) {
        const p = eg.player(pid);
        const cards = (zone) => p.getCardsInZone(zone) ?? [];
        const leader = p.getAllDeckLeaders()[0];
        const ls = leader.getSummary(p, true);
        const bs = p.base.getSummary(p, true);
        const unit = (c) => {
            const s = c.getSummary(p, true);
            return { ...ref(eg, c), damage: s.damage ?? 0, exhausted: !!s.exhausted, power: s.power ?? c.cardData.power, hp: s.hp ?? c.cardData.hp, upgrades: (c.upgrades ?? []).map((u) => ({ ...ref(eg, u), token: !!u.isToken?.() })) };
        };
        players[eg.seatOf(pid)] = {
            base: { ...ref(eg, p.base), damage: bs.damage ?? 0, hp: p.base.cardData.hp, epicUsed: !!bs.epicActionSpent },
            leader: { ...ref(eg, leader), deployed: !!leader.deployed || ls.onStartingSide === false, exhausted: !!ls.exhausted, epicUsed: !!ls.epicDeployActionSpent },
            hand: cards('hand').map((c) => ref(eg, c)),
            deck: p.drawDeck.map((c) => ref(eg, c)),
            resources: cards('resource').map((c) => ({ ...ref(eg, c), exhausted: !!c.exhausted })),
            discard: cards('discard').map((c) => ref(eg, c)),
            ground: cards('groundArena').filter((c) => c.isUnit()).map(unit),
            space: cards('spaceArena').filter((c) => c.isUnit()).map(unit),
            out: !!p.passedActionPhase
        };
    }
    return { nextCardId: eg.game.state.allCards.length, round: eg.round, phase: eg.phase, initiative: eg.game.initiativePlayer ? eg.seatOf(eg.game.initiativePlayer.id) : null, initiativeClaimed: !!eg.game.isInitiativeClaimed, prevPassed: !!eg.game.prevActionPhasePlayerPassed, activePlayer: eg.game.actionPhaseActivePlayer ? eg.seatOf(eg.game.actionPhaseActivePlayer.id) : null, actor: actor ? eg.seatOf(actor) : null, winner: eg.winner, players };
}
function normalizeArg(eg, value) {
    if (typeof value === 'string' && eg.game.state.allCards.includes(value)) return eg.cardId(value);
    return value === undefined ? null : value;
}
function canonicalAction(eg, a) {
    const card = a.cardUuid ? eg.cardId(a.cardUuid) : a.kind === 'displayCard' ? eg.cardId(a.arg) : null;
    const arg = a.kind === 'distribute' ? (a.split ?? []).filter((e) => e.amount > 0).map((e) => [eg.cardId(e.id), e.amount]).sort((a, b) => a[0].localeCompare(b[0])) : normalizeArg(eg, a.arg);
    const method = a.method ?? null;
    return { key: JSON.stringify([a.kind, card, arg, method, a.label]), kind: a.kind, card, arg, method, label: a.label };
}
/** A distribute menu is a family of actions. Enumerate every legal concrete allocation. */
function expandActions(eg, actions) {
    const out = [];
    for (const a of actions) {
        if (a.kind !== 'distribute') { out.push(a); continue; }
        if (a.spec.type !== 'distributeHealing' || a.spec.maxTargets !== 1 || a.spec.amount > 2) {
            throw new Error(`Pool produced unsupported distribution ${JSON.stringify(a.spec)}`);
        }
        if (a.spec.canDistributeLess || a.spec.canChooseNoTargets) out.push({ ...a, split: [] });
        a.targets.forEach((id, i) => {
            const start = a.spec.canDistributeLess ? 1 : a.spec.amount;
            for (let amount = start; amount <= Math.min(a.spec.amount, a.caps[i]); amount++) out.push({ ...a, split: [{ id, amount }] });
        });
    }
    const seen = new Set();
    for (const a of out) {
        const key = canonicalAction(eg, a).key;
        if (seen.has(key)) throw new Error(`Canonical action collision: ${key}`);
        seen.add(key);
    }
    return out;
}
// Sort object keys without changing array order: deck, discard and registry orders are game state.
function stableJson(value) {
    if (Array.isArray(value)) return value.map(stableJson);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stableJson(value[k])]));
    return value;
}
const stateHash = (state) => require('crypto').createHash('sha256').update(JSON.stringify(stableJson(state))).digest('hex');
module.exports = { fullState, stateHash, canonicalAction, expandActions };
