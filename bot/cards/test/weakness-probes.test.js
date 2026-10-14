'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyWeakness, planWeaknessProbes } = require('../pipeline/weakness-probes');
const catalogue = require('../../card-compiler/generated/catalog.json');
const entry = id => structuredClone(catalogue.cards.find(e => e.setCode === id));
test('source trio constructs optional signed-token and explicit finite gaps', () => {
    for (const id of ['HMW_059', 'HMW_087', 'HMW_242']) {
        const p = planWeaknessProbes(entry(id), { catalogue });
        assert.ok(p.cases.some(c => c.probe.decline));
        assert.ok(p.cases.some(c => c.probe.lethal));
        assert.ok(p.cases.some(c => c.probe.stacked));
        assert.ok(p.cases.some(c => c.probe.leaderCode));
        assert.ok(p.uncovered.some(o => o.id.endsWith('mixed-effect-groups')));
        assert.ok(p.cases.every(c => c.setupCardIds.includes('TOKEN_WEAKNESS')));
    }
    const p = planWeaknessProbes(entry('HMW_242'), { catalogue });
    assert.ok(p.cases.some(c => c.probe.resourceCount === 5));
    assert.ok(p.cases.some(c => c.probe.resourceCount === 6));
    assert.ok(p.cases.some(c => c.probe.resourceCount === 7));
});
test('registrar, source domain, side and intrinsic effects reject', () => {
    for (const change of [e => e.baseClass = 'LeaderUnitCard', e => e.card.types.push('token'),
        e => e.card.pilotText = 'Piloting 1', e => e.keywordValues.hidden = 1,
        e => e.card.keywords.push('hidden'), e => e.abilities.unit.push({ trigger: 'onAttack' }),
        e => e.abilities.card[0].optional = false, e => e.abilities.card[0].optional = 'true',
        e => e.abilities.card[0].costs.push({ kind: 'exhaustSelf' }),
        e => e.abilities.card[0].condition = { kind: 'const', value: true },
        e => e.abilities.card[0].ifYouDo = { effect: { kind: 'noAction' } },
        e => e.abilities.card[0].trigger = 'onAttack']) {
        const e = entry('HMW_059'); change(e); assert.equal(classifyWeakness(e), null);
    }
});
test('unconstructed target domains, batches and predicate expressions reject', () => {
    for (const change of [a => a.targetResolver.owner = 'self', a => a.targetResolver.type = 'any',
        a => a.targetResolver.zone = 'discard', a => a.targetResolver.arena = 'ground',
        a => a.targetResolver.optional = true, a => a.targetResolver.count = 2,
        a => a.targetResolver.predicate.right.op = '===',
        a => a.targetResolver.predicate.right.left.path = ['source', 'damage'],
        a => a.effect.target = 'source', a => a.effect.amount.value = 2,
        a => a.effect = { kind: 'simultaneous', effects: [a.effect] }, a => a.effect = null]) {
        const e = entry('HMW_087'); change(e.abilities.card[0]); assert.equal(classifyWeakness(e), null);
    }
});
test('resource conditional requires exact live player count and modeled false branch', () => {
    for (const change of [e => e.condition.left.path = ['opponent', 'resources', 'length'],
        e => e.condition.op = '>', e => e.condition.right.value = 1,
        e => e.condition.right.value = 20, e => e.condition.right.value = 6.5,
        e => e.condition.extra = true, e => e.onFalse = e.onTrue,
        e => e.onTrue.amount.value = 2, e => e.extra = true]) {
        const e = entry('HMW_242'); change(e.abilities.card[0].effect); assert.equal(classifyWeakness(e), null);
    }
});
test('missing native token leaves explicit unmet construction dependency', () => {
    const p = planWeaknessProbes(entry('HMW_059'), { catalogue: catalogue.cards.filter(e => e.setCode !== 'TOKEN_WEAKNESS') });
    assert.equal(p.cases.length, 0);
    assert.ok(p.uncovered.some(o => o.id.endsWith('metadata-donors')));
});

test('altered native Weakness source or signed metadata cannot satisfy construction dependency', () => {
    for (const change of [e => e.sourceHash = 'altered', e => e.card.title = 'Experience',
        e => e.card.upgradeHp = 1, e => e.card.power = 0, e => e.card.aspects.push('heroism'),
        e => e.abilities.card.push({ trigger: 'whenPlayed' })]) {
        const cards = structuredClone(catalogue.cards);
        change(cards.find(e => e.setCode === 'TOKEN_WEAKNESS'));
        const p = planWeaknessProbes(entry('HMW_059'), { catalogue: cards });
        assert.equal(p.cases.length, 0);
        assert.ok(p.uncovered.some(o => o.id.endsWith('metadata-donors')));
    }
});
