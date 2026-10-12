'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyNamedTarget, planNamedTargetProbes } = require('../pipeline/named-target-probes');
const catalogue = require('../../card-compiler/generated/catalog.json');
const entry = id => structuredClone(catalogue.cards.find(e => e.setCode === id));
test('two complete printed sources get bounded essential timing constructions', () => {
    for (const id of ['HMW_255', 'JTL_253']) {
        const p = planNamedTargetProbes(entry(id), { catalogue });
        assert.ok(p.cases.some(c => c.name.endsWith('both-enemy-selections')));
        assert.ok(p.cases.some(c => c.name.endsWith('decline-both')));
        assert.ok(p.uncovered.some(o => o.id.endsWith('unique-source-departure')));
    }
    const p = planNamedTargetProbes(entry('HMW_255'), { catalogue });
    assert.ok(p.cases.some(c => c.name.endsWith('missing-staged-2-entering-source')));
    assert.ok(!p.cases.some(c => c.name.endsWith('missing-2')));
    const q = planNamedTargetProbes(entry('JTL_253'), { catalogue });
    for (const name of ['cancel-first', 'cancel-second', 'empty-play-anyway', 'empty-cancel']) {
        assert.ok(q.cases.some(c => c.name.endsWith(name)));
    }
});
test('registrar, source domain, side abilities and intrinsic effects fail closed', () => {
    for (const change of [e => e.baseClass = 'LeaderUnitCard', e => e.card.types.push('token'),
        e => e.card.pilotText = 'Piloting 1', e => e.keywordValues.hidden = 1,
        e => e.card.keywords.push('hidden'), e => e.abilities.unit.push({ trigger: 'onAttack' }),
        e => e.abilities.card[0].costs.push({ kind: 'exhaustSelf' }),
        e => e.abilities.card[0].condition = { kind: 'const', value: true },
        e => e.abilities.card[0].ifYouDo = { effect: { kind: 'noAction' } },
        e => e.abilities.card[0].optional = true]) {
        const e = entry('HMW_255'); change(e); assert.equal(classifyNamedTarget(e), null);
    }
});
test('descriptor identities, chooser, cardinality and predicate domains fail closed', () => {
    for (const change of [d => d.name = 'target', d => d.name = '__proto__',
        d => d.name = 'rebelUnit', d => d.chooser = 'opponent',
        d => d.targetResolver.optional = false, d => d.targetResolver.count = 2,
        d => d.targetResolver.owner = 'self', d => d.targetResolver.type = 'any',
        d => d.targetResolver.zone = 'discard', d => d.targetResolver.arena = 'all',
        d => d.targetResolver.predicate.receiver.path = ['source'],
        d => d.targetResolver.predicate.args[0] = { kind: 'ref', path: ['target'] },
        d => d.targetResolver.predicate.extra = true]) {
        const e = entry('HMW_255'); change(e.abilities.card[0].targetResolvers[0]);
        assert.equal(classifyNamedTarget(e), null);
    }
});
test('unconstructed signed, grouped, lasting or malformed effects reject', () => {
    for (const change of [d => d.effect.hp.value = -1, d => d.effect.power.value = 0,
        d => d.effect.power.value = 128, d => d.effect.hp.value = 1.5,
        d => d.effect.duration = 'persistent', d => d.effect.target = 'source',
        d => d.effect.extra = true, d => d.effect = { kind: 'simultaneous', effects: [d.effect] },
        d => d.effect = undefined]) {
        const e = entry('JTL_253'); change(e.abilities.card[0].targetResolvers[0]);
        assert.equal(classifyNamedTarget(e), null);
    }
});

test('malformed descriptors and nonboolean optional values reject without throwing', () => {
    for (const d of [null, undefined, {}, { name: 'valid' }]) {
        const e = entry('JTL_253'); e.abilities.card[0].targetResolvers[0] = d;
        assert.equal(classifyNamedTarget(e), null);
    }
    for (const value of [0, 1, 'true', null]) {
        const e = entry('JTL_253'); e.abilities.card[0].targetResolvers[0].targetResolver.optional = value;
        assert.equal(classifyNamedTarget(e), null);
    }
    const e = entry('JTL_253'); e.baseClass = 'NonLeaderUnitCard';
    assert.equal(classifyNamedTarget(e), null);
});

test('overlapping future descriptors never construct more than three copies', () => {
    const e = entry('JTL_253');
    e.abilities.card[0].targetResolvers[1].targetResolver.arena = 'ground';
    const p = planNamedTargetProbes(e, { catalogue });
    for (const scenario of p.cases) {
        const counts = new Map();
        for (const t of scenario.probe.targets) counts.set(t.code, (counts.get(t.code) ?? 0) + 1);
        assert.ok([...counts.values()].every(n => n <= 3));
    }
});
