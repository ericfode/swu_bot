'use strict';
const { nativeForce } = require('./force-probes');
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const keys = (a, allowed) => a && Object.keys(a).every(k => allowed.includes(k));
function literal(e) {
    let sign = 1, unary = false;
    if (keys(e, ['kind', 'op', 'value']) && e.kind === 'unary' && e.op === '-') {
        sign = -1; unary = true; e = e.value;
    }
    return keys(e, ['kind', 'value']) && e.kind === 'const' && Number.isInteger(e.value) &&
        Math.abs(e.value) <= 127 && (!unary || e.value >= 0) ? sign * e.value : null;
}
function classifyForceFollowon(entry) {
    const all = Object.values(entry.abilities ?? {}).flat(), a = all[0];
    const event = same(entry.card?.types, ['event']), unit = same(entry.card?.types, ['unit']);
    if (entry.status !== 'supported' || !(event || unit) || unit && !['ground', 'space'].includes(entry.card.arena) || entry.baseClass !== (event ? 'EventCard' : 'NonLeaderUnitCard') ||
        all.length !== 1 || entry.abilities.card?.length !== 1 ||
        !keys(a, ['trigger', 'title', 'costs', 'optional', 'effect', 'ifYouDo']) || !same(a.costs, []) ||
        (event ? a.trigger !== 'event' || a.optional !== undefined : !['whenPlayed', 'whenDefeated'].includes(a.trigger) || a.optional !== true) ||
        !same(a.effect, { kind: 'useForce', target: 'ownPlayer' }) ||
        !keys(a.ifYouDo, ['title', 'costs', 'targetResolver', 'effect']) || !same(a.ifYouDo.costs, []) ||
        entry.card.pilotText || entry.card.pilotBox || entry.card.pilotingBox || entry.piloting) return null;
    const child = a.ifYouDo, e = child.effect, r = child.targetResolver;
    let shape;
    if (same(e, { kind: 'discardOwnHand', target: 'enemyPlayer', amount: { kind: 'const', value: 1 } }) &&
        !r && unit && a.trigger === 'whenDefeated') shape = { effectKind: 'discard', amount: 1 };
    else {
        if (!keys(r, ['owner', 'type', 'zone']) || !['any', 'self'].includes(r.owner) ||
            !['unit', 'base'].includes(r.type) || r.zone !== 'anyAttackable') return null;
        if (keys(e, ['kind', 'target', 'amount']) && ['heal', 'damage'].includes(e.kind) && e.target === 'chosen' &&
            keys(e.amount, ['kind', 'value']) && e.amount.kind === 'const' && Number.isInteger(e.amount.value) &&
            e.amount.value > 0 && e.amount.value <= 8 && (e.kind === 'heal' || r.type === 'unit')) {
            shape = { effectKind: e.kind, amount: e.amount.value, targetType: r.type, owner: r.owner };
        } else if (keys(e, ['kind', 'target', 'duration', 'power', 'hp']) && e.kind === 'modifyStats' && e.target === 'chosen' &&
            e.duration === 'phase' && r.type === 'unit' && literal(e.power) !== null && literal(e.hp) !== null &&
            (literal(e.power) || literal(e.hp))) {
            shape = { effectKind: 'stats', power: literal(e.power), hp: literal(e.hp), targetType: 'unit', owner: r.owner };
        } else return null;
    }
    const kw = entry.keywordValues ?? {};
    if (Object.keys(kw).length && !(
        same(kw, { shielded: 1 }) && unit && a.trigger === 'whenPlayed' && shape.effectKind === 'heal' && shape.targetType === 'base' ||
        same(kw, { overwhelm: 1 }) && unit && a.trigger === 'whenPlayed' && shape.effectKind === 'damage' ||
        same(kw, { hidden: 1 }) && unit && a.trigger === 'whenDefeated' && shape.effectKind === 'discard')) return null;
    if (!same([...(entry.card.keywords ?? [])].sort(), Object.keys(kw).sort()) || event && Object.keys(kw).length) return null;
    return { family: 'force-followon', trigger: a.trigger, title: a.title, continuationTitle: child.title,
        ...shape, keywords: { ...kw } };
}
function planForceFollowonProbes(entry, options = {}) {
    const shape = classifyForceFollowon(entry);
    if (!shape) return null;
    const defs = Array.isArray(options.catalogue) ? options.catalogue : options.catalogue?.cards ?? [];
    const result = { schema: 'swu-card-probes/v1', cardId: entry.setCode, sourceHash: entry.sourceHash,
        cases: [], obligations: [], uncovered: [] };
    function obligation(d, reason) {
        const id = entry.setCode + ':force-followon:' + d;
        result.obligations.push({ id, path: 'force-followon', dimension: d });
        if (reason) result.uncovered.push({ id, path: 'force-followon', reason });
        return id;
    }
    const token = defs.find(nativeForce);
    const quiet = defs.filter(e => e.status === 'supported' && same(e.card.types, ['unit']) && !e.card.unique &&
        !Object.values(e.abilities ?? {}).flat().length && !Object.keys(e.keywordValues ?? {}).length && !e.card.keywords?.length &&
        !e.card.pilotText && !e.card.pilotBox && !e.card.pilotingBox && !e.piloting &&
        (e.baseClass === 'NonLeaderUnitCard' || e.baseClass === undefined && !e.card.text))
        .sort((a, b) => a.setCode.localeCompare(b.setCode));
    const ground = quiet.find(e => e.card.arena === 'ground' && e.card.hp >= Math.max(5, 3 - (shape.hp ?? 0), shape.effectKind === 'damage' ? shape.amount + 2 : 0));
    const space = quiet.find(e => e.card.arena === 'space' && e.card.hp >= Math.max(5, 3 - (shape.hp ?? 0), shape.effectKind === 'damage' ? shape.amount + 2 : 0));
    const defeat = defs.find(e => e.status === 'supported' && e.baseClass === 'EventCard' && same(e.card.types, ['event']) &&
        Object.values(e.abilities ?? {}).flat().length === 1 && e.abilities.card?.length === 1 &&
        !Object.keys(e.keywordValues ?? {}).length && !e.card.keywords?.length &&
        !e.card.pilotText && !e.card.pilotBox && !e.card.pilotingBox && !e.piloting &&
        keys(e.abilities.card[0], ['trigger', 'title', 'costs', 'targetResolver', 'effect']) &&
        e.abilities.card[0].trigger === 'event' && same(e.abilities.card[0].costs, []) &&
        same(e.abilities.card[0].effect, { kind: 'defeat', target: 'chosen' }) &&
        same(e.abilities.card[0].targetResolver, { owner: 'any', type: 'unit', zone: 'anyAttackable' }));
    if (!token || !ground || !space || shape.trigger === 'whenDefeated' && !defeat) {
        obligation('metadata-donors', 'Missing reviewed native token/quiet arena/death donor'); return result;
    }
    const row = (e, owner, extra = {}) => ({ code: e.setCode, owner, arena: e.card.arena, exhausted: false, damage: 1, ...extra });
    const mixed = [row(ground, 'self'), row(space, 'opponent')];
    function add(name, targets = mixed, extra = {}) {
        const id = obligation(name);
        const probe = { ...shape, cardId: entry.setCode, sourceTypes: entry.card.types, sourceArena: entry.card.arena,
            targets, held: true, enemyHeld: true, ownBaseDamage: 4, enemyBaseDamage: 5, initiative: 'self', resourceCount: 20,
            ...(shape.trigger === 'whenDefeated' ? { activationCode: defeat.setCode } : {}), ...extra };
        result.cases.push({ id: `auto/${entry.setCode}/force-followon-${name}`, name: 'force-followon-' + name,
            kind: 'probe', focusCardIds: [entry.setCode], setupCardIds: [...new Set([token.setCode,
                ...targets.map(t => t.code), ...targets.flatMap(t => (t.attachments ?? []).map(a => a.code)),
                ...(probe.activationCode ? [probe.activationCode] : [])])].sort(),
            behaviorIds: ['use-force-continuation', shape.trigger, shape.effectKind, ...Object.keys(shape.keywords)],
            assertionStages: ['construction', 'activation', 'observation'], coverageObligationIds: [id], probe });
    }
    add('own-positive');
    if (shape.owner !== 'self' && shape.effectKind !== 'discard') add('enemy-positive', mixed, { selectedIndex: 1, chooseEnemyBase: true });
    if (shape.owner === 'self') add('reject-enemy-domain');
    add('absent-own-enemy-held', mixed, { held: false });
    if (shape.trigger === 'event') add('absent-cancel', mixed, { held: false, cancel: true });
    else add('optional-decline', mixed, { decline: true });
    add(shape.trigger === 'whenPlayed' && shape.targetType === 'unit' ? 'empty-staged-recipients-entering-source' : 'no-beneficial-recipient', [], { ownBaseDamage: 0, enemyBaseDamage: 0,
        ...(shape.trigger === 'whenPlayed' && shape.targetType === 'unit' ? { selectSource: true } : {}),
        ...(shape.effectKind === 'discard' ? { emptyEnemyHand: true } : {}) });
    if (shape.effectKind === 'heal') add('undamaged-no-healing', mixed.map(t => ({ ...t, damage: 0 })),
        { ownBaseDamage: 0, enemyBaseDamage: 0 });
    if (shape.effectKind === 'heal' && shape.targetType === 'unit') {
        const wounded = quiet.find(e => e.card.arena === 'ground' && e.card.hp >= shape.amount + 2);
        if (wounded) add('partial-heal-leaves-one-damage',
            [row(wounded, 'self', { damage: shape.amount + 1 }), row(space, 'opponent')]);
        else obligation('partial-heal-amount-boundary', 'No quiet unit with HP at least healing amount plus two');
    }
    if (shape.effectKind === 'stats') add('phase-expiry', mixed, { waitForExpiry: true });
    if (shape.targetType === 'unit' && shape.trigger === 'whenPlayed') add('entering-source-recipient', mixed, { selectSource: true });
    if (shape.effectKind === 'stats' && shape.hp < 0 || shape.effectKind === 'damage') {
        const small = quiet.find(e => e.card.arena === 'ground' && e.card.hp <= (shape.effectKind === 'damage' ? shape.amount : -shape.hp));
        if (small) add('actual-lethal-recipient', [row(small, 'opponent', { damage: 0 }), row(ground, 'self')],
            { lethal: true });
    }
    if (shape.keywords.shielded) add('shielded-first-order', mixed, { shieldFirst: true });
    if (shape.effectKind === 'damage') add('shield-prevents-selected-damage',
        [row(ground, 'self'), row(space, 'opponent', { attachments: [{ code: 'TOKEN_SHIELD', token: 'shield' }] })],
        { selectedIndex: 1, shield: true });
    if (shape.keywords.hidden) add('actual-hidden-menu-before-death', [row(ground, 'self'), row(ground, 'opponent')], { hiddenMenu: true });
    if (shape.keywords.overwhelm) {
        const defender = quiet.find(e => e.card.arena === entry.card.arena && e.card.hp < entry.card.power);
        if (defender) add('actual-overwhelm-combat-after-ready', [row(defender, 'opponent', { damage: 0 })],
            { overwhelmCombat: true, selectSource: true });
        else obligation('intrinsic-overwhelm-combat', 'No quiet bounded real defender');
    }
    for (const d of ['source-review', 'force-hook-reactions', 'gain-replacement', 'recipient-reentry', 'unique-source-departure',
        'multi-trigger-death-windows', 'token-leader-recipient', 'inactive-target-after-selection', 'full-healing-result-replacement']) {
        obligation(d, 'No actual source-card construction for this dimension; separate diagnostics are not full-card witnesses');
    }
    return result;
}
module.exports = { classifyForceFollowon, planForceFollowonProbes };
