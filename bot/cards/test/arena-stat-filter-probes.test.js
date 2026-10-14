'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyArenaStatFilter, planArenaStatFilterProbes } = require('../pipeline/arena-stat-filter-probes');
const catalogue = require('../../card-compiler/generated/catalog.json');
const entry = id => structuredClone(catalogue.cards.find(e => e.setCode === id));
test('both printed sources get membership, lifecycle and actual damaged-expiry cases', () => {
    for (const id of ['HMW_111', 'LOF_127']) {
        const p = planArenaStatFilterProbes(entry(id), { catalogue });
        assert.equal(p.cases.length, 8);
        assert.ok(p.cases.some(c => c.probe.expiryLethal && c.probe.damageAmount > 0));
        assert.ok(p.cases.some(c => c.probe.newEntrant));
        assert.ok(p.cases.some(c => c.probe.targets.some(t => t.token)));
        assert.ok(p.uncovered.some(o => o.id.endsWith('recipient-reentry')));
        for (const c of p.cases) {
            const counts = new Map();
            for (const t of c.probe.targets) counts.set(t.code, (counts.get(t.code) ?? 0) + 1);
            assert.ok([...counts.values()].every(n => n <= 3));
        }
    }
    const p = planArenaStatFilterProbes(entry('HMW_111'), { catalogue });
    assert.ok(p.cases.some(c => c.probe.sourceDeparture));
    assert.ok(p.cases.some(c => c.probe.leaderCode));
    const q = planArenaStatFilterProbes(entry('LOF_127'), { catalogue });
    assert.ok(q.cases.some(c => c.probe.cancel));
    assert.ok(q.cases.some(c => c.probe.stack));
});
test('extra registrar, pilot, side, intrinsic and source-domain behavior reject', () => {
    for (const change of [e => e.baseClass = 'LeaderUnitCard', e => e.card.types.push('token'),
        e => e.card.pilotText = 'Piloting 1', e => e.keywordValues.raid = 1,
        e => e.card.keywords.push('coordinate'), e => e.abilities.unit.push({ trigger: 'onAttack' }),
        e => e.abilities.card[0].optional = true, e => e.abilities.card[0].targetResolver = {},
        e => e.abilities.card[0].costs.push({ kind: 'exhaustSelf' }),
        e => e.abilities.card[0].condition = { kind: 'const', value: true },
        e => e.abilities.card[0].then = {}, e => e.abilities.card[0].contextTitle = 'unmodeled']) {
        const e = entry('HMW_111'); change(e); assert.equal(classifyArenaStatFilter(e), null);
    }
});
test('unconstructed scalar and nested effect forms reject', () => {
    for (const change of [e => e.duration = 'persistent', e => e.power.value = 0,
        e => e.hp.value = -1, e => e.hp.value = 128, e => e.hp.value = 1.5,
        e => e.extra = true, e => e.power = { kind: 'ref', path: ['source', 'power'] }]) {
        const e = entry('LOF_127'); change(e.abilities.card[0].effect); assert.equal(classifyArenaStatFilter(e), null);
    }
    for (const kind of ['simultaneous', 'sequential', 'phaseModifiers']) {
        const e = entry('LOF_127'), a = e.abilities.card[0]; a.effect = { kind, effects: [a.effect] };
        assert.equal(classifyArenaStatFilter(e), null);
    }
    const e = entry('HMW_111'); e.abilities.card[0].effect.power.op = '-';
    assert.equal(classifyArenaStatFilter(e), null);
});
test('static trait and source-exclusion predicates do not accept broader logical domains', () => {
    for (const change of [t => t.receiver.path = ['game'], t => t.receiver.path = ['opponent'],
        t => t.predicate.left.value = false, t => t.predicate.op = '||',
        t => t.predicate.right.args[0] = { kind: 'ref', path: ['source'] },
        t => t.predicate.right.receiver.path = ['source'], t => t.predicate.right.extra = true,
        t => t.predicate.right.args.push({ kind: 'const', value: 'jedi' })]) {
        const e = entry('LOF_127'); change(e.abilities.card[0].effect.target); assert.equal(classifyArenaStatFilter(e), null);
    }
    const e = entry('HMW_111'); e.abilities.card[0].effect.target.predicate.right.right.op = '===';
    assert.equal(classifyArenaStatFilter(e), null);
});
test('missing and malformed effect/target nodes fail closed', () => {
    for (const change of [a => a.effect = null, a => a.effect.target = null,
        a => a.effect.target.predicate = null, a => a.effect.target.predicate.right = null]) {
        const e = entry('LOF_127'); change(e.abilities.card[0]); assert.equal(classifyArenaStatFilter(e), null);
    }
});

test('secondary damage donors require exact event and effect shapes', () => {
    const focus = entry('HMW_111');
    const baseline = planArenaStatFilterProbes(focus, { catalogue });
    const code = baseline.cases.find(c => c.probe.expiryLethal).probe.activationCode;
    for (const change of [e => e.baseClass = 'NonLeaderUnitCard',
        e => e.abilities.card[0].trigger = 'whenPlayed',
        e => e.abilities.card[0].effect.extra = true,
        e => e.abilities.card[0].effect.amount.extra = true,
        e => e.abilities.card[0].condition = { kind: 'const', value: true }]) {
        const cards = structuredClone(catalogue.cards);
        change(cards.find(e => e.setCode === code));
        const p = planArenaStatFilterProbes(focus, { catalogue: cards });
        assert.ok(!p.cases.some(c => c.probe.activationCode === code));
    }
});
