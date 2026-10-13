'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyForce, nativeForce, planForceProbes } = require('../pipeline/force-probes');
const catalogue = require('../../card-compiler/generated/catalog.json');
const entry = id => structuredClone(catalogue.cards.find(e => e.setCode === id));
test('all three printed shapes construct optional and actual native identity boundaries', () => {
    for (const id of ['LOF_146', 'LOF_195', 'LOF_193']) {
        const p = planForceProbes(entry(id), { catalogue });
        assert.ok(p.cases.length >= 6);
        assert.ok(p.cases.every(c => c.setupCardIds.includes('TOKEN_THE_FORCE')));
        assert.ok(p.uncovered.some(o => o.id.endsWith('force-hook-reactions')));
    }
    const draw = planForceProbes(entry('LOF_146'), { catalogue });
    assert.ok(draw.cases.some(c => c.probe.lethalFatigue));
    assert.ok(draw.cases.some(c => c.probe.keepOld));
    const gain = planForceProbes(entry('LOF_193'), { catalogue });
    assert.ok(gain.cases.some(c => c.probe.lifecycle && c.probe.enemyHeld));
});
test('native packet focus has explicit dependency review and no ordinary fake play', () => {
    const e = entry('TOKEN_THE_FORCE');
    assert.equal(nativeForce(e), true);
    const p = planForceProbes(e, { catalogue });
    assert.equal(p.cases.length, 0);
    assert.ok(p.uncovered.some(o => o.id.endsWith('native-source-review')));
});
test('unmodeled registrar, metadata, side and intrinsic semantics reject', () => {
    for (const change of [e => e.baseClass = 'LeaderUnitCard', e => e.card.types.push('token'),
        e => e.card.pilotText = 'Piloting 1', e => e.keywordValues.hidden = 1,
        e => e.card.keywords.push('hidden'), e => e.abilities.unit.push({ trigger: 'onAttack' }),
        e => e.abilities.card[0].trigger = 'whenDefeated', e => e.abilities.card[0].optional = false,
        e => e.abilities.card[0].optional = 'true', e => e.abilities.card[0].costs.push({ kind: 'exhaustSelf' }),
        e => e.abilities.card[0].targetResolver = {}, e => e.abilities.card[0].condition = { kind: 'const', value: true },
        e => e.abilities.card[0].then = {}]) {
        const e = entry('LOF_195'); change(e); assert.equal(classifyForce(e), null);
    }
});
test('Force operation and continuation domains fail closed', () => {
    for (const change of [a => a.effect.target = 'opponent', a => a.effect.amount = { kind: 'const', value: 1 },
        a => a.ifYouDo = undefined, a => a.ifYouDo.costs.push({ kind: 'useForce' }),
        a => a.ifYouDo.targetResolver = {}, a => a.ifYouDo.optional = true,
        a => a.ifYouDo.effect.target = 'chosen', a => a.ifYouDo.effect.amount = { kind: 'const', value: 1 },
        a => a.ifYouDo.effect = { kind: 'simultaneous', effects: [a.ifYouDo.effect] }]) {
        const e = entry('LOF_195'); change(e.abilities.card[0]); assert.equal(classifyForce(e), null);
    }
    const e = entry('LOF_146'); e.abilities.card[0].ifYouDo.effect.amount.value = 3;
    assert.equal(classifyForce(e), null);
});
test('gain is mandatory nonunique ordinary source with no extra effect arguments', () => {
    for (const change of [e => e.card.unique = true, e => e.abilities.card[0].optional = true,
        e => e.abilities.card[0].optional = false, e => e.abilities.card[0].effect.target = 'opponent',
        e => e.abilities.card[0].effect.amount = { kind: 'const', value: 1 },
        e => e.abilities.card[0].ifYouDo = { effect: { kind: 'draw' } }]) {
        const e = entry('LOF_193'); change(e); assert.equal(classifyForce(e), null);
    }
});
test('missing or altered native dependency produces no purported source construction', () => {
    for (const change of [e => e.setCode = 'ANOTHER_FORCE', e => e.sourceHash = 'altered', e => e.baseClass = 'TokenUpgradeCard',
        e => e.card.id = 'another', e => e.card.title = 'Force Upgrade', e => e.card.hp = 0,
        e => e.card.text = '', e => e.card.subtitle = 'changed', e => e.card.deployBox = '',
        e => e.card.epicAction = 'changed', e => e.card.rules = '', e => e.card.setId.set = 'OTHER',
        e => e.attachCondition = { kind: 'const', value: true }, e => e.card.attachCondition = {},
        e => e.card.aspects.push('heroism'), e => e.card.unique = true,
        e => e.abilities.card.push({ trigger: 'whenPlayed' })]) {
        const cards = structuredClone(catalogue.cards); change(cards.find(e => e.setCode === 'TOKEN_THE_FORCE'));
        const p = planForceProbes(entry('LOF_146'), { catalogue: cards });
        assert.equal(p.cases.length, 0);
        assert.ok(p.uncovered.some(o => o.id.endsWith('native-dependency')));
    }
    const p = planForceProbes(entry('LOF_146'), { catalogue: catalogue.cards.filter(e => e.setCode !== 'TOKEN_THE_FORCE') });
    assert.equal(p.cases.length, 0);
});
test('malformed effect and ability nodes reject without throwing', () => {
    for (const change of [e => e.abilities.card[0] = null,
        e => e.abilities.card[0].effect = null, e => e.abilities.card[0].ifYouDo = null]) {
        const e = entry('LOF_146'); change(e); assert.equal(classifyForce(e), null);
    }
});
