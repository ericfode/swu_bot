'use strict';

function phaseStats(card) {
    let power = 0, hp = 0;
    for (const effect of card.getOngoingEffects()) {
        // Constant stat programs are derived from arena sources by Rust; they are
        // not stored as phase deltas. Persistent lasting effects are a different rule.
        if (effect.duration === 'persistent' && effect.type === 'modifyStats' &&
            effect.source?.getConstantAbilities?.().some((ability) => ability.registeredEffects.includes(effect))) continue;
        if (effect.duration !== 'untilEndOfPhase') {
            if (effect.type === 'modifyStats') throw new Error(`Unsupported stat effect duration ${effect.duration} on ${card.internalName}`);
            continue;
        }
        if (effect.type !== 'modifyStats') throw new Error(`Unsupported phase effect ${effect.type} on ${card.internalName}`);
        const value = effect.getValue(card);
        if (!value || Object.keys(value).some((key) => !['power', 'hp'].includes(key)) ||
            !Number.isSafeInteger(value.power) || !Number.isSafeInteger(value.hp)) {
            throw new Error(`Unsupported phase stat value on ${card.internalName}`);
        }
        power += value.power;
        hp += value.hp;
        if (!Number.isSafeInteger(power) || !Number.isSafeInteger(hp) || Math.abs(power) > 65535 || Math.abs(hp) > 65535) {
            throw new Error(`Phase stat total outside simulator bounds on ${card.internalName}`);
        }
    }
    return power === 0 && hp === 0 ? {} : { phaseStats: { power, hp } };
}

function ref(eg, c) {
    const { placedRef } = require('../../view');
    const v = placedRef(eg, c);
    return { id: v.id, setCode: v.s || (c.isToken?.() ? `TOKEN_${c.internalName.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}` : null), name: c.internalName };
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
            return { ...ref(eg, c), ...phaseStats(c), damage: s.damage ?? 0, exhausted: !!s.exhausted, power: s.power ?? c.cardData.power, hp: s.hp ?? c.cardData.hp, upgrades: (c.upgrades ?? []).map((u) => ({ ...ref(eg, u), token: !!u.isToken?.() })) };
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
/** A distribution prompt represents every legal integer allocation, not a sample.
 * Refuse a combinatorial explosion explicitly so a conformance trace can never
 * pretend that a pruned action list is the engine's complete legal action set.
 */
function expandActions(eg, actions, maxAllocations = 4096) {
    const out = [];
    for (const a of actions) {
        if (a.kind !== 'distribute') { out.push(a); continue; }
        const { spec, targets, caps } = a;
        if (!['distributeHealing', 'distributeDamage', 'distributeIndirectDamage'].includes(spec.type) ||
            !Number.isSafeInteger(spec.amount) || spec.amount < 0 || spec.amount > 64 ||
            targets.length > 64 || new Set(targets).size !== targets.length || caps.length !== targets.length ||
            caps.some((cap) => cap !== Infinity && (!Number.isSafeInteger(cap) || cap < 0))) {
            throw new Error(`Unsupported distribution shape ${JSON.stringify(spec)}`);
        }
        const maxTargets = Math.min(spec.maxTargets ?? targets.length, targets.length);
        if (!Number.isSafeInteger(maxTargets) || maxTargets < 0) throw new Error(`Invalid distribution maxTargets ${maxTargets}`);
        let count = 0;
        let visited = 0;
        const add = (split) => {
            if (++count > maxAllocations) throw new Error(`Distribution exceeds ${maxAllocations} exact allocations; trace aborted without pruning`);
            out.push({ ...a, split });
        };
        if (spec.canChooseNoTargets) add([]);
        const walk = (start, sum, split) => {
            if (++visited > 1000000) throw new Error('Distribution exceeds exact enumeration work bound; trace aborted without pruning');
            if (sum > 0 && (spec.canDistributeLess || sum === spec.amount)) add(split);
            if (split.length === maxTargets || sum === spec.amount) return;
            for (let i = start; i < targets.length; i++) {
                for (let amount = 1; amount <= Math.min(spec.amount - sum, caps[i]); amount++) {
                    walk(i + 1, sum + amount, [...split, { id: targets[i], amount }]);
                }
            }
        };
        walk(0, 0, []);
        if (!count) throw new Error('Distribution has no legal concrete allocation');
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
module.exports = { fullState, phaseStats, stateHash, canonicalAction, expandActions };
