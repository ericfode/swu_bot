'use strict';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (a, allowed) => a && Object.keys(a).every(k => allowed.includes(k));
const sourceExclusion = { kind: 'binary', op: '||', left: { kind: 'unary', op: '!', value: { kind: 'ref', path: ['source'] } },
    right: { kind: 'binary', op: '!==', left: { kind: 'ref', path: ['card'] }, right: { kind: 'ref', path: ['source'] } } };
function literal(expr) {
    if (expr?.kind === 'unary' && expr.op === '+' && keys(expr, ['kind', 'op', 'value'])) expr = expr.value;
    return keys(expr, ['kind', 'value']) && expr.kind === 'const' && Number.isInteger(expr.value) &&
        expr.value > 0 && expr.value <= 127 ? expr.value : null;
}
function classifyArenaStatFilter(entry) {
    const all = Object.values(entry.abilities ?? {}).flat(), a = all[0];
    const event = same(entry.card?.types, ['event']), unit = same(entry.card?.types, ['unit']);
    if (entry.status !== 'supported' || !(event || unit) ||
        entry.baseClass !== (event ? 'EventCard' : 'NonLeaderUnitCard') ||
        all.length !== 1 || entry.abilities.card?.length !== 1 ||
        !keys(a, ['trigger', 'title', 'costs', 'effect']) || !same(a.costs, []) ||
        a.trigger !== (event ? 'event' : 'whenPlayed') ||
        Object.keys(entry.keywordValues ?? {}).length || entry.card.keywords?.length ||
        entry.card.pilotText || entry.card.pilotBox || entry.card.pilotingBox || entry.piloting) return null;
    const e = a.effect, t = e?.target;
    if (!keys(e, ['kind', 'target', 'duration', 'power', 'hp']) || e.kind !== 'modifyStats' || e.duration !== 'phase' ||
        !keys(t, ['kind', 'receiver', 'predicate']) || t.kind !== 'arenaList' ||
        !same(t.receiver, { kind: 'ref', path: ['player'] }) || !literal(e.power) || !literal(e.hp)) return null;
    const p = t.predicate;
    if (!keys(p, ['kind', 'op', 'left', 'right']) || p.kind !== 'binary' || p.op !== '&&' ||
        !same(p.left, { kind: 'const', value: true })) return null;
    let trait, excludeSource = false;
    if (same(p.right, sourceExclusion) && unit) excludeSource = true;
    else {
        const q = p.right;
        if (!event || !keys(q, ['kind', 'name', 'receiver', 'args']) || q.kind !== 'query' || q.name !== 'hasSomeTrait' ||
            !same(q.receiver, { kind: 'ref', path: ['card'] }) || !Array.isArray(q.args) || q.args.length !== 1 ||
            !keys(q.args[0], ['kind', 'value']) || q.args[0].kind !== 'const' ||
            typeof q.args[0].value !== 'string' || !q.args[0].value) return null;
        trait = q.args[0].value;
    }
    return { family: 'arena-stat-filter', trigger: a.trigger, trait, excludeSource,
        power: literal(e.power), hp: literal(e.hp) };
}
function planArenaStatFilterProbes(entry, options = {}) {
    const shape = classifyArenaStatFilter(entry);
    if (!shape) return null;
    const defs = Array.isArray(options.catalogue) ? options.catalogue : options.catalogue?.cards ?? [];
    const result = { schema: 'swu-card-probes/v1', cardId: entry.setCode, sourceHash: entry.sourceHash,
        cases: [], obligations: [], uncovered: [] };
    function obligation(d, reason) {
        const id = entry.setCode + ':arena-stat-filter:' + d;
        result.obligations.push({ id, path: 'arena-stat-filter', dimension: d });
        if (reason) result.uncovered.push({ id, path: 'arena-stat-filter', reason });
        return id;
    }
    const quiet = defs.filter(e => e.status === 'supported' && same(e.card.types, ['unit']) && !e.card.unique &&
        !Object.values(e.abilities ?? {}).flat().length && !Object.keys(e.keywordValues ?? {}).length &&
        !e.card.keywords?.length && !e.card.pilotText).sort((a, b) => a.setCode.localeCompare(b.setCode));
    const matches = e => !shape.trait || e.card.traits?.includes(shape.trait);
    const ground = quiet.find(e => e.card.arena === 'ground' && matches(e));
    const space = quiet.find(e => e.card.arena === 'space' && matches(e));
    if (!ground || !space) {
        obligation('quiet-arena-donors', 'No matching quiet ordinary unit in both arenas');
        return result;
    }
    const row = (e, owner, extra = {}) => ({ code: e.setCode, owner, arena: e.card.arena, damage: 0, exhausted: false, ...extra });
    const mixed = [row(ground, 'self'), row(space, 'self'), row(ground, 'opponent'), row(space, 'opponent')];
    const wrong = shape.trait && quiet.find(e => !matches(e));
    if (wrong) mixed.push(row(wrong, 'self'));
    function add(name, targets, extra = {}) {
        const id = obligation(name);
        const probe = { ...shape, cardId: entry.setCode, sourceTypes: entry.card.types, sourceArena: entry.card.arena,
            targets, initiative: 'self', resourceCount: 20, ...extra };
        result.cases.push({ id: `auto/${entry.setCode}/arena-stat-filter-${name}`, name: 'arena-stat-filter-' + name,
            kind: 'probe', focusCardIds: [entry.setCode], setupCardIds: [...new Set([...targets.map(t => t.code),
                ...(probe.activationCode ? [probe.activationCode] : [])])].sort(), behaviorIds: ['arena-list', 'phase-stats',
                shape.excludeSource ? 'source-exclusion' : 'trait-filter'], assertionStages: ['construction', 'activation', 'observation'],
            coverageObligationIds: [id], probe });
    }
    add('mixed-owner-arena-membership', mixed);
    add('natural-phase-expiry', mixed, { waitForExpiry: true });
    add('empty-before-play', [], { empty: true });
    if (shape.trigger === 'event') {
        add('empty-cancel', [], { empty: true, cancel: true });
        add('two-actual-casts-stack', [...mixed, row(entry, 'self', { zone: 'hand' })], { stack: true });
    }
    add('new-entrant-excluded', [...mixed, row(ground, 'self', { zone: 'hand' })], { newEntrant: true });
    const defeat = defs.find(e => e.status === 'supported' && same(e.card.types, ['event']) &&
        Object.values(e.abilities ?? {}).flat().length === 1 && e.abilities.card?.length === 1 &&
        e.baseClass === 'EventCard' && e.abilities.card[0].trigger === 'event' &&
        !Object.keys(e.keywordValues ?? {}).length && !e.card.keywords?.length && !e.card.pilotText &&
        keys(e.abilities.card[0], ['trigger', 'title', 'costs', 'targetResolver', 'effect']) &&
        same(e.abilities.card[0].costs, []) && same(e.abilities.card[0].effect, { kind: 'defeat', target: 'chosen' }) &&
        same(e.abilities.card[0].targetResolver, { owner: 'any', type: 'unit', zone: 'anyAttackable' }));
    if (shape.trigger === 'whenPlayed' && defeat) add('source-departure-retains-modifiers', mixed,
        { sourceDeparture: true, activationCode: defeat.setCode });
    const damage = defs.find(e => e.status === 'supported' && same(e.card.types, ['event']) &&
        Object.values(e.abilities ?? {}).flat().length === 1 && e.abilities.card?.length === 1 &&
        e.baseClass === 'EventCard' && e.abilities.card[0].trigger === 'event' &&
        !Object.keys(e.keywordValues ?? {}).length && !e.card.keywords?.length && !e.card.pilotText &&
        keys(e.abilities.card[0], ['trigger', 'title', 'costs', 'targetResolver', 'effect']) &&
        same(e.abilities.card[0].costs, []) &&
        keys(e.abilities.card[0].effect, ['kind', 'target', 'amount']) &&
        keys(e.abilities.card[0].effect?.amount, ['kind', 'value']) &&
        e.abilities.card[0].effect?.kind === 'damage' &&
        e.abilities.card[0].effect.target === 'chosen' && e.abilities.card[0].effect.amount?.kind === 'const' &&
        Number.isInteger(e.abilities.card[0].effect.amount.value) && e.abilities.card[0].effect.amount.value > 0 &&
        e.abilities.card[0].effect.amount.value <= shape.hp &&
        same(e.abilities.card[0].targetResolver, { owner: 'any', type: 'any', zone: 'anyAttackable' }));
    if (damage) add('actual-damage-survives-buff-dies-at-expiry', [row(ground, 'self', { damage: ground.card.hp - 1 })],
        { expiryLethal: true, activationCode: damage.setCode, damageAmount: damage.abilities.card[0].effect.amount.value });
    else obligation('damaged-expiry-lethal', 'No bounded actual constant-damage donor');
    const token = defs.filter(e => e.status === 'supported' && e.card.types.includes('token') &&
        e.card.types.includes('unit') && matches(e) && !Object.values(e.abilities ?? {}).flat().length &&
        !Object.keys(e.keywordValues ?? {}).length).sort((a, b) => a.setCode.localeCompare(b.setCode))[0];
    if (token) add('real-token-membership', [...mixed, row(token, 'self', { token: token.internalName }),
        row(token, 'opponent', { token: token.internalName })]);
    const leader = defs.filter(e => e.status === 'supported' && e.card.types.includes('leader') && matches(e) &&
        Object.values(e.abilities ?? {}).flat().every(a => ['action', 'onAttack'].includes(a.trigger)))
        .sort((a, b) => a.setCode.localeCompare(b.setCode))[0];
    if (leader) add('deployed-leader-membership', [...mixed, row(leader, 'self', { deployedLeader: true }),
        row(leader, 'opponent', { deployedLeader: true })], { leaderCode: leader.setCode });
    else obligation('matching-deployed-leader', 'No matching bounded actual leader donor');
    for (const d of ['source-review', 'recipient-reentry', 'live-trait-changes', 'multi-recipient-lethal-expiry',
        'aura-attachment-stat-death', 'global-capacity-arithmetic', 'unit-repeated-source-inclusion']) {
        obligation(d, 'No actual source-card construction for this dimension; separate primitive diagnostics are not full-card witnesses');
    }
    return result;
}
module.exports = { classifyArenaStatFilter, planArenaStatFilterProbes };
