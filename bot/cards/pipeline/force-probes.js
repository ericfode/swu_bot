'use strict';
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const keys = (a, allowed) => a && Object.keys(a).every(k => allowed.includes(k));
const FORCE_CARD = {
    title: 'The Force', subtitle: '', cost: 0, hp: null, power: null,
    text: '(The Force is with you. When you use the Force, remove this token from play.)',
    deployBox: null, epicAction: '', unique: false,
    rules: 'An individual player may only control one Force token at a time. If a player already controls a Force token when they are instructed to create their Force token, nothing happens.\nEach player may create their own Force token. It is not shared between players.\n',
    upgradePower: null, upgradeHp: null, id: '4571900905', aspects: [], traits: [], keywords: [],
    types: ['token'], setId: { set: 'LOF' }, internalName: 'the-force'
};
function nativeForce(entry) {
    return entry?.setCode === 'TOKEN_THE_FORCE' && entry.baseClass === 'TokenCard' &&
        entry.sourceHash === '3ff3888f5186845acdd8d3ef96f396875b2daf4f9b808fa9b4a2ef03a1b954b6' &&
        same(entry.card, FORCE_CARD) && entry.attachCondition === undefined && !entry.piloting &&
        !Object.keys(entry.keywordValues ?? {}).length && !Object.values(entry.abilities ?? {}).flat().length;
}
function classifyForce(entry) {
    const all = Object.values(entry.abilities ?? {}).flat(), a = all[0];
    if (entry.status !== 'supported' || entry.baseClass !== 'NonLeaderUnitCard' || !same(entry.card?.types, ['unit']) ||
        !['ground', 'space'].includes(entry.card.arena) || all.length !== 1 || entry.abilities.card?.length !== 1 ||
        a?.trigger !== 'whenPlayed' || !same(a?.costs, []) || Object.keys(entry.keywordValues ?? {}).length ||
        entry.card.keywords?.length || entry.card.pilotText || entry.card.pilotBox || entry.card.pilotingBox || entry.piloting) return null;
    if (same(a.effect, { kind: 'gainForce', target: 'ownPlayer' }) &&
        keys(a, ['trigger', 'title', 'costs', 'effect']) && !entry.card.unique) return { family: 'force', kind: 'gain' };
    if (!keys(a, ['trigger', 'title', 'costs', 'optional', 'effect', 'ifYouDo']) || a.optional !== true ||
        !same(a.effect, { kind: 'useForce', target: 'ownPlayer' }) ||
        !keys(a.ifYouDo, ['title', 'costs', 'effect']) || !same(a.ifYouDo.costs, [])) return null;
    if (same(a.ifYouDo.effect, { kind: 'ready', target: 'self' })) return { family: 'force', kind: 'ready' };
    if (same(a.ifYouDo.effect, { kind: 'draw', target: 'ownPlayer', amount: { kind: 'const', value: 2 } })) {
        return { family: 'force', kind: 'draw', drawAmount: 2 };
    }
    return null;
}
function planForceProbes(entry, options = {}) {
    const result = { schema: 'swu-card-probes/v1', cardId: entry.setCode, sourceHash: entry.sourceHash,
        cases: [], obligations: [], uncovered: [] };
    function obligation(d, reason) {
        const id = entry.setCode + ':force:' + d;
        result.obligations.push({ id, path: 'force', dimension: d });
        if (reason) result.uncovered.push({ id, path: 'force', reason });
        return id;
    }
    if (nativeForce(entry)) {
        for (const d of ['native-source-review', 'native-lifecycle-dependent-source-witness', 'force-hook-reactions', 'gain-replacement']) {
            obligation(d, 'Native Force is a precreated player token, not an ordinarily playable card; actual gain/use ordinary-source constructions provide dependency lifecycle evidence, with independent native source/metadata review required');
        }
        return result;
    }
    const shape = classifyForce(entry);
    if (!shape) return null;
    const defs = Array.isArray(options.catalogue) ? options.catalogue : options.catalogue?.cards ?? [];
    const token = defs.find(nativeForce);
    if (!token) {
        obligation('native-dependency', 'Missing reviewed native Force identity/metadata');
        return result;
    }
    function add(name, targets = [], extra = {}) {
        const id = obligation(name);
        const probe = { ...shape, cardId: entry.setCode, sourceTypes: entry.card.types, sourceArena: entry.card.arena,
            targets, initiative: 'self', resourceCount: 20, held: false, enemyHeld: false, ...extra };
        result.cases.push({ id: `auto/${entry.setCode}/force-${name}`, name: 'force-' + name, kind: 'probe',
            focusCardIds: [entry.setCode], setupCardIds: [...new Set([token.setCode, ...targets.map(t => t.code)])].sort(),
            behaviorIds: ['force-state', 'native-token-identity', shape.kind],
            assertionStages: ['construction', 'activation', 'observation'], coverageObligationIds: [id], probe });
    }
    if (shape.kind === 'gain') {
        add('first-gain');
        add('already-held-no-allocation', [], { held: true });
        add('enemy-held-independent', [], { enemyHeld: true });
        add('both-already-held', [], { held: true, enemyHeld: true });
        const ready = defs.find(e => classifyForce(e)?.kind === 'ready');
        const draw = defs.find(e => classifyForce(e)?.kind === 'draw');
        if (ready && draw) {
            const row = (e, owner) => ({ code: e.setCode, owner, arena: e.card.arena, zone: 'hand' });
            const targets = [row(ready, 'self'), row(entry, 'self'), row(entry, 'opponent'), row(draw, 'self')];
            add('actual-both-owner-gain-use-absent-repeat-regain', targets, { lifecycle: true, resourceCount: 32 });
            add('actual-regain-with-opponent-already-held', targets, { lifecycle: true, resourceCount: 32, enemyHeld: true });
        } else obligation('actual-regain', 'No fully classified ready/draw use sources for real gain/use/regain');
    } else {
        add('held-accept', [], { held: true });
        add('both-held-accept', [], { held: true, enemyHeld: true });
        add('held-decline', [], { held: true, decline: true });
        add('both-held-decline', [], { held: true, enemyHeld: true, decline: true });
        add('absent-both');
        add('enemy-only-held', [], { enemyHeld: true });
        if (entry.card.unique) {
            const targets = [{ code: entry.setCode, owner: 'self', arena: entry.card.arena, exhausted: true, damage: 0 }];
            add('unique-keep-new', targets, { held: true, uniqueReplacement: true });
            add('unique-keep-old-departed-source', targets, { held: true, uniqueReplacement: true, keepOld: true });
        }
        if (shape.kind === 'draw') {
            for (const deckSize of [0, 1, 2]) add('draw-deck-' + deckSize, [], { held: true, deckSize });
            add('empty-deck-lethal-fatigue', [], { held: true, deckSize: 0, baseDamage: 24, lethalFatigue: true });
        }
    }
    for (const d of ['source-review', 'force-hook-reactions', 'gain-replacement', 'broader-player-targets-costs',
        'phase-history-boundaries', 'hand-capacity', 'source-leader-token-variants']) {
        obligation(d, 'No actual source-card construction for this dimension; primitive diagnostics are not full-card source witnesses');
    }
    return result;
}
module.exports = { classifyForce, nativeForce, planForceProbes };
