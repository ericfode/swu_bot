'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classifyForceContinuation: classify, planForceContinuationProbes: plan, quietUnit, gainDonor } = require('../pipeline/force-continuation-probes');
const catalogue = JSON.parse(fs.readFileSync(process.env.SWU_DIAGNOSTIC_CATALOGUE ?? path.resolve(__dirname, '../../card-compiler/generated/catalog.json')));
const clone = v => structuredClone(v);
const get = id => clone(catalogue.cards.find(e => e.setCode === id));
function drain() {
    const e = get('LOF_041');
    // Expected source-derived display field; compiler integration independently verifies it.
    e.abilities.card[0].effect.effects[0].targetResolver.promptTitle = 'Select a unit to deal 2 damage to';
    return e;
}
test('exact three full-source continuation shapes classify', () => {
    assert.equal(classify(get('LOF_039')).mode, 'wave-after-use');
    assert.equal(classify(drain()).mode, 'inline-damage-gain');
    assert.equal(classify(get('LOF_072')).mode, 'five-shields-after-use');
});
test('ordinary source class/type/provenance and boolean uniqueness are mandatory', () => {
    for (const mutate of [e => e.baseClass = 'EventCard', e => e.card.types = ['leader'], e => e.card.unique = undefined,
        e => e.sourcePath = null, e => e.sourceHash = null, e => e.card.pilotText = 'Pilot', e => e.attachCondition = { kind: 'const', value: true }]) {
        const e = get('LOF_072');
        mutate(e);
        assert.equal(classify(e), null);
    }
});
test('whole registration rejects extra headers, side abilities and nested continuations', () => {
    for (const mutate of [a => a.condition = { kind: 'const', value: true }, a => a.costs = [{ kind: 'exhaustSelf' }],
        a => a.then = {}, a => a.confirmation = true, a => a.optional = false, a => a.ifYouDo.ifYouDo = {}]) {
        const e = get('LOF_072');
        mutate(e.abilities.card[0]);
        assert.equal(classify(e), null);
    }
    const e = get('LOF_072');
    e.abilities.unit.push(e.abilities.card[0]);
    assert.equal(classify(e), null);
});
test('five-target continuation is exact and fails closed on wider selectors', () => {
    for (const mutate of [r => r.count.value = 6, r => r.owner = 'self', r => r.optional = false, r => r.type = 'any', r => r.promptTitle = 'extra']) {
        const e = get('LOF_072');
        mutate(e.abilities.card[0].ifYouDo.targetResolver);
        assert.equal(classify(e), null);
    }
});
test('global defeat predicate, intrinsic Restore and trait immunity are exact', () => {
    for (const mutate of [e => e.keywordValues.restore = 3, e => e.card.keywords.push('hidden'),
        e => e.abilities.card[0].ifYouDo.effect.target.receiver.path = ['player'],
        e => e.abilities.card[0].ifYouDo.effect.target.predicate.right.right.right.value = 4]) {
        const e = get('LOF_039');
        mutate(e);
        assert.equal(classify(e), null);
    }
});
test('inline literal display field and ordered shared effects are bounded', () => {
    for (const mutate of [e => delete e.abilities.card[0].effect.effects[0].targetResolver.promptTitle,
        e => e.abilities.card[0].effect.effects.reverse(), e => e.abilities.card[0].effect.effects[0].effect.amount.value = 3,
        e => e.abilities.card[0].effect.effects[0].targetResolver.cardCondition = {}, e => e.abilities.card[0].effect.effects[1].target = 'enemyPlayer']) {
        const e = drain();
        mutate(e);
        assert.equal(classify(e), null);
    }
});
test('quiet and actual gain donors reject forged provenance/classes/mechanics', () => {
    const quiet = catalogue.cards.find(quietUnit);
    assert.ok(quiet);
    for (const mutate of [e => e.sourceHash = 'a'.repeat(64), e => e.baseClass = 'BaseCard', e => e.card.keywords = ['sentinel'], e => e.card.pilotText = 'Pilot', e => e.card.unique = undefined, e => e.card.cost = -1, e => e.card.cost = undefined]) {
        const e = clone(quiet);
        mutate(e);
        assert.equal(quietUnit(e), false);
    }
    const gain = get('LOF_193');
    assert.ok(gainDonor(gain));
    gain.abilities.card[0].ifYouDo = {};
    assert.equal(gainDonor(gain), false);
});
test('missing native dependency yields honest uncovered plans', () => {
    const entries = catalogue.cards.filter(e => e.setCode !== 'TOKEN_THE_FORCE');
    const p = plan(get('LOF_072'), { catalogue: entries });
    assert.equal(p.cases.length, 0);
    assert.ok(p.uncovered.length);
});
test('complete planned cases are source-seat paired and library definitions round trip', () => {
    const library = require('../reference/library');
    const cases = [get('LOF_039'), drain(), get('LOF_072')].flatMap(e => plan(e, { catalogue }).cases);
    assert.equal(cases.length, 80);
    assert.deepEqual([...new Set(cases.map(c => c.probe.sourceSeat))].sort(), [1, 2]);
    for (const c of cases)
        assert.deepEqual(library.definition(c.id, { cases: [] }, c), c);
});
test('malformed wave traits and oversized inline UTF-8 title reject', () => {
    for (const traits of [undefined, 'sith', ['sith', null]]) {
        const e = get('LOF_039');
        e.card.traits = traits;
        assert.equal(classify(e), null);
    }
    const e = drain();
    e.abilities.card[0].effect.effects[0].targetResolver.promptTitle = '界'.repeat(342);
    assert.equal(classify(e), null);
});
test('unbuilt original design dimensions remain explicit in their source mode', () => {
    const wave = plan(get('LOF_039'), { catalogue }).uncovered.map(o => o.id);
    const damage = plan(drain(), { catalogue }).uncovered.map(o => o.id);
    const shields = plan(get('LOF_072'), { catalogue }).uncovered.map(o => o.id);
    assert.ok(wave.some(id => id.endsWith(':actual-beast-token-wave')));
    assert.ok(damage.some(id => id.endsWith(':repeat-drain-gain')));
    assert.ok(damage.some(id => id.endsWith(':nonlethal-sentinel-hp-refresh')));
    assert.ok(shields.some(id => id.endsWith(':natural-phase-shield-persistence')));
    assert.ok(!wave.some(id => id.endsWith(':repeat-drain-gain')));
});
