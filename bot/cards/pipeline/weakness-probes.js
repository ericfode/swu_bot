'use strict';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (a, allowed) => a && Object.keys(a).every(k => allowed.includes(k));
const damagedPredicate = { kind: 'binary', op: '&&',
    left: { kind: 'query', name: 'isUnit', receiver: { kind: 'ref', path: ['card'] }, args: [] },
    right: { kind: 'binary', op: '!==', left: { kind: 'ref', path: ['card', 'damage'] }, right: { kind: 'const', value: 0 } } };
function classifyWeakness(entry) {
    const all = Object.values(entry.abilities ?? {}).flat(), a = all[0];
    if (entry.status !== 'supported' || !same(entry.card?.types, ['unit']) || entry.baseClass !== 'NonLeaderUnitCard' ||
        all.length !== 1 || entry.abilities.card?.length !== 1 ||
        !keys(a, ['trigger', 'title', 'costs', 'optional', 'targetResolver', 'effect']) ||
        !['whenPlayed', 'whenDefeated'].includes(a.trigger) || a.optional !== true || !same(a.costs, []) ||
        Object.keys(entry.keywordValues ?? {}).length || entry.card.keywords?.length || entry.card.pilotText ||
        entry.card.pilotBox || entry.card.pilotingBox || entry.piloting) return null;
    const r = a.targetResolver;
    if (!keys(r, ['owner', 'type', 'zone', 'predicate']) || r.owner !== 'any' || r.type !== 'unit' ||
        r.zone !== 'anyAttackable' || r.predicate !== undefined && !same(r.predicate, damagedPredicate)) return null;
    let effect = a.effect, resourceMinimum;
    if (effect?.kind === 'conditional') {
        const c = effect.condition;
        if (!keys(effect, ['kind', 'condition', 'onTrue', 'onFalse']) ||
            !keys(c, ['kind', 'op', 'left', 'right']) || c.kind !== 'binary' || c.op !== '>=' ||
            !same(c.left, { kind: 'ref', path: ['player', 'resources', 'length'] }) ||
            !keys(c.right, ['kind', 'value']) || c.right.kind !== 'const' ||
            !Number.isInteger(c.right.value) || c.right.value < 5 || c.right.value > 12 ||
            !same(effect.onFalse, { kind: 'noAction' }) || a.trigger !== 'whenPlayed' || r.predicate) return null;
        resourceMinimum = c.right.value;
        effect = effect.onTrue;
    }
    if (!same(effect, { kind: 'giveWeakness', target: 'chosen', amount: { kind: 'const', value: 1 } })) return null;
    return { family: 'weakness', trigger: a.trigger, damagedOnly: r.predicate !== undefined, resourceMinimum };
}
function planWeaknessProbes(entry, options = {}) {
    const shape = classifyWeakness(entry);
    if (!shape) return null;
    const defs = Array.isArray(options.catalogue) ? options.catalogue : options.catalogue?.cards ?? [];
    const result = { schema: 'swu-card-probes/v1', cardId: entry.setCode, sourceHash: entry.sourceHash,
        cases: [], obligations: [], uncovered: [] };
    function obligation(d, reason) {
        const id = entry.setCode + ':weakness:' + d;
        result.obligations.push({ id, path: 'weakness', dimension: d });
        if (reason) result.uncovered.push({ id, path: 'weakness', reason });
        return id;
    }
    const quiet = defs.filter(e => e.status === 'supported' && same(e.card.types, ['unit']) && !e.card.unique &&
        !Object.values(e.abilities ?? {}).flat().length && !Object.keys(e.keywordValues ?? {}).length)
        .sort((a, b) => a.setCode.localeCompare(b.setCode));
    const durable = quiet.find(e => e.card.hp >= 4 && e.card.power === 1);
    const hpOne = quiet.find(e => e.card.hp === 1);
    const lethal = quiet.find(e => e.card.hp >= 2 && e.card.hp <= 3);
    const defeat = defs.find(e => e.status === 'supported' && same(e.card.types, ['event']) &&
        Object.values(e.abilities ?? {}).flat().length === 1 &&
        keys(e.abilities.card[0], ['trigger', 'title', 'costs', 'targetResolver', 'effect']) &&
        same(e.abilities.card[0].costs, []) && same(e.abilities.card[0].effect, { kind: 'defeat', target: 'chosen' }) &&
        same(e.abilities.card[0].targetResolver, { owner: 'any', type: 'unit', zone: 'anyAttackable' }));
    const token = defs.find(e => e.setCode === 'TOKEN_WEAKNESS' && e.baseClass === 'TokenUpgradeCard' &&
        e.sourceHash === 'dd546e4886757d77fffeb8be6e7381144fa7378b6493ce444aa87e4ba1202778' &&
        !Object.values(e.abilities ?? {}).flat().length && !Object.keys(e.keywordValues ?? {}).length &&
        same(e.card.types, ['token', 'upgrade']) && same(e.card.aspects, []) &&
        same(e.card.traits, ['condition']) && same(e.card.keywords, []) && !e.card.unique &&
        e.card.internalName === 'weakness' && e.card.title === 'Weakness' && e.card.text === '' &&
        e.card.cost === 0 && e.card.hp === -1 && e.card.power === -1 &&
        e.card.upgradeHp === -1 && e.card.upgradePower === -1);
    if (!durable || !hpOne || !lethal || !token || shape.trigger === 'whenDefeated' && !defeat) {
        obligation('metadata-donors', 'No validated native Weakness/durable/lethal/actual-defeat donors');
        return result;
    }
    const row = (e, owner, damage = shape.damagedOnly ? 1 : 0, extra = {}) =>
        ({ code: e.setCode, owner, arena: e.card.arena, damage, exhausted: false, ...extra });
    function add(name, target, extra = {}) {
        const targets = target ? [target, row(durable, target.owner === 'self' ? 'opponent' : 'self', 0)] : [];
        const id = obligation(name);
        const probe = { ...shape, cardId: entry.setCode, sourceTypes: entry.card.types, sourceArena: entry.card.arena,
            targets, selectedIndex: 0, initiative: 'self', resourceCount: shape.resourceMinimum ?? 20,
            ...(shape.trigger === 'whenDefeated' ? { activationCode: defeat.setCode } : {}), ...extra };
        result.cases.push({ id: `auto/${entry.setCode}/weakness-${name}`, name: 'weakness-' + name, kind: 'probe',
            focusCardIds: [entry.setCode], setupCardIds: [...new Set([token.setCode, ...targets.map(t => t.code),
                ...(probe.activationCode ? [probe.activationCode] : []),
                ...targets.flatMap(t => (t.attachments ?? []).map(a => a.code))])].sort(),
            behaviorIds: ['weakness-token', 'signed-upgrade-stats', shape.trigger],
            assertionStages: ['construction', 'activation', 'observation'], coverageObligationIds: [id], probe });
    }
    add('enemy-nonlethal-zero-power', row(durable, 'opponent'));
    add('friendly-nonlethal', row(durable, 'self'));
    add('optional-decline', row(durable, 'opponent'), { decline: true });
    add('damaged-exact-lethal', row(lethal, 'opponent', lethal.card.hp - 1), { lethal: true });
    if (!shape.damagedOnly) add('hp-one-undamaged-lethal', row(hpOne, 'self', 0), { lethal: true });
    add('stacked-token-zero-power', row(durable, 'opponent', shape.damagedOnly ? 1 : 0,
        { attachments: [{ code: token.setCode, token: token.internalName }] }), { stacked: true });
    if (shape.trigger === 'whenDefeated' && !shape.damagedOnly) add('no-surviving-unit-eligible', null, { noEligible: true });
    if (shape.damagedOnly) add('no-damaged-eligible', row(durable, 'opponent', 0), { noEligible: true });
    if (shape.resourceMinimum) {
        add('resource-below-threshold', row(durable, 'opponent'), { resourceCount: shape.resourceMinimum - 1, noEligible: true });
        add('resource-above-threshold', row(durable, 'opponent'), { resourceCount: shape.resourceMinimum + 1 });
        add('entering-source-recipient', null, { selectSource: true });
    }
    const unitToken = defs.find(e => e.status === 'supported' && e.card.types.includes('token') &&
        e.card.types.includes('unit') && e.card.hp === 2 && !Object.values(e.abilities ?? {}).flat().length &&
        !Object.keys(e.keywordValues ?? {}).length);
    if (unitToken) add('real-token-recipient', row(unitToken, 'opponent', shape.damagedOnly ? 1 : 0,
        { token: unitToken.internalName }), { lethal: unitToken.card.hp === 2 && shape.damagedOnly });
    const leader = defs.filter(e => e.status === 'supported' && e.card.types.includes('leader') &&
        Object.values(e.abilities ?? {}).flat().every(a => ['action', 'onAttack'].includes(a.trigger)))
        .sort((a, b) => a.setCode.localeCompare(b.setCode))[0];
    if (leader) add('deployed-leader-recipient', row(leader, 'opponent', shape.damagedOnly ? 1 : 0,
        { deployedLeader: true }), { leaderCode: leader.setCode });
    for (const d of ['source-review', 'mixed-attachment-cleanup-order', 'removal-return-cleanup',
        'creation-replacement', 'source-target-departure', 'multiple-recipient-token-batches', 'mixed-effect-groups']) {
        obligation(d, 'No actual source-card construction for this dimension; separate primitive tests are not full-card witnesses');
    }
    return result;
}
module.exports = { classifyWeakness, planWeaknessProbes };
