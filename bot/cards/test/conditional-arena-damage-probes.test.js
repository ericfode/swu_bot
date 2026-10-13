'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const p = require('../pipeline/arena-damage-probes');
const catalogue = JSON.parse(fs.readFileSync(process.env.SWU_DIAGNOSTIC_CATALOGUE ?? path.resolve(__dirname, '../../card-compiler/generated/catalog.json')));
const get = id => structuredClone(catalogue.cards.find(e => e.setCode === id));
test('two complete conditional arena source bodies classify independently of IDs', () => {
    for (const [id, mode] of [['ASH_112', 'own-arena-count'], ['TWI_150', 'own-base-damage']]) {
        const e = get(id);
        assert.equal(p.classifyConditionalArenaDamage(e).condition, mode);
        e.setCode = 'OTHER_001';
        e.card.title = 'Another printed title';
        assert.equal(p.classifyConditionalArenaDamage(e).condition, mode);
    }
});
test('conditional whole metadata provenance class and side mechanics fail closed', () => {
    for (const mutate of [e => e.baseClass = 'EventCard', e => e.card.types = ['unit', 'token'], e => e.sourcePath = null, e => e.sourceHash = null,
        e => e.card.unique = undefined, e => e.card.hp = undefined, e => e.card.traits = null, e => e.card.pilotText = false,
        e => e.piloting = false, e => e.attachCondition = {}, e => e.abilities.unit.push({}), e => e.abilities = null]) {
        const e = get('ASH_112');
        mutate(e);
        assert.equal(p.classifyConditionalArenaDamage(e), null);
    }
});
test('unknown conditional thresholds/receivers/predicates and nonempty false branch reject', () => {
    for (const mutate of [e => e.abilities.card[0].effect.condition.right.value = 3,
        e => e.abilities.card[0].effect.condition.left.receiver.path = ['opponent'], e => e.abilities.card[0].effect.onFalse = { kind: 'draw', amount: { kind: 'const', value: 1 } },
        e => e.abilities.card[0].effect.onTrue.target.receiver.path = ['game'], e => e.abilities.card[0].effect.onTrue.amount.value = 4,
        e => e.abilities.card[0].effect.onTrue.target.predicate = { kind: 'ref', path: ['card', 'exhausted'] }]) {
        const e = get('ASH_112');
        mutate(e);
        assert.equal(p.classifyConditionalArenaDamage(e), null);
    }
});
test('Saw exact ownbase ground condition and intrinsic Raid2 are whole-card requirements', () => {
    for (const mutate of [e => e.abilities.card[0].effect.condition.left.path = ['opponent', 'base', 'damage'], e => e.abilities.card[0].effect.condition.right.value = 14,
        e => e.keywordValues.raid = 3, e => e.card.keywords.push('restore'), e => e.abilities.card[0].effect.onTrue.target.predicate = { kind: 'const', value: true },
        e => e.abilities.card[0].effect.onTrue.amount.value = 2]) {
        const e = get('TWI_150');
        mutate(e);
        assert.equal(p.classifyConditionalArenaDamage(e), null);
    }
});
test('registrar cost/optional/header/continuation/nested effects are unmodeled', () => {
    for (const mutate of [e => e.abilities.card[0].optional = true, e => e.abilities.card[0].costs.push({ kind: 'exhaustSelf' }),
        e => e.abilities.card[0].condition = { kind: 'const', value: true }, e => e.abilities.card[0].then = {},
        e => e.abilities.card[0].targetResolver = {}, e => e.abilities.card[0].effect.onTrue = e.abilities.card[0].effect,
        e => e.abilities.card.push(e.abilities.card[0])]) {
        const e = get('ASH_112');
        mutate(e);
        assert.equal(p.classifyConditionalArenaDamage(e), null);
    }
});
test('quiet construction donor guards reject provenance-less source/pilot/keyword mechanics', () => {
    const donor = catalogue.cards.find(p.conditionalQuiet);
    assert.ok(donor);
    for (const mutate of [e => e.sourceHash = 'a'.repeat(64), e => e.baseClass = 'BaseCard', e => e.card.unique = undefined,
        e => e.card.pilotBox = false, e => e.card.text = 'When Played: draw a card.', e => e.abilities.card.push({})]) {
        const e = structuredClone(donor);
        mutate(e);
        assert.equal(p.conditionalQuiet(e), false);
    }
});
test('46 proposed source terminal definitions round-trip without central dispatch changes', () => {
    const library = require('../reference/library');
    const plans = ['ASH_112', 'TWI_150'].map(id => p.planArenaDamageProbes(get(id), { catalogue }));
    assert.equal(plans.flatMap(p => p.cases).length, 46);
    for (const plan of plans)
        for (const c of plan.cases)
            assert.deepEqual(library.definition(c.id, { cases: [] }, c), c);
});

test('null or missing sole registration rejects without throwing', () => {
    for (const value of [null, undefined]) {
        const e = get('ASH_112'); e.abilities.card = [value];
        assert.equal(p.classifyConditionalArenaDamage(e), null);
    }
});
