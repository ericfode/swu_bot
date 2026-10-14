'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const p = require('../pipeline/weakness-continuation-probes');
const catalogue = JSON.parse(fs.readFileSync(process.env.SWU_DIAGNOSTIC_CATALOGUE ?? path.resolve(__dirname, '../../card-compiler/generated/catalog.json')));
const entries = ['HMW_100', 'HMW_199', 'HMW_202', 'HMW_231'].map(id => catalogue.cards.find(e => e.setCode === id));
const clone = structuredClone;
test('complete four source modes classify with exact continuation topology', () => {
    assert.deepEqual(entries.map(e => p.classifyWeaknessContinuation(e)?.mode), ['base-amount', 'beast-then', 'damage-pair', 'weakness-exhaust']);
});
test('source class, full side arrays, provenance, pilots, intrinsic and unmodeled headers reject', () => {
    for (const original of entries)
        for (const change of [e => e.baseClass = 'LeaderUnitCard', e => e.card.types = ['unit', 'leader'], e => e.sourcePath = null, e => delete e.card.unique, e => e.sourceHash = null, e => e.card.pilotText = 'extra', e => e.card.pilotBox = 'extra', e => e.card.pilotingBox = 'extra', e => e.piloting = {}, e => e.attachCondition = false, e => e.card.keywords = ['hidden'], e => e.keywordValues.hidden = 1, e => e.abilities.unit = [{ trigger: 'onAttack' }], e => e.abilities.unknown = [], e => e.abilities.card = {}, e => e.abilities.card[0].condition = { kind: 'const', value: true }, e => e.abilities.card[0].costs = [{}]]) {
            const e = clone(original);
            change(e);
            assert.equal(p.classifyWeaknessContinuation(e), null);
        }
});
test('Torrent own-base conditional amount and exact context title are complete source fields', () => {
    for (const change of [e => e.abilities.card[0].effect.amount.then.value = 3, e => e.abilities.card[0].effect.amount.condition.receiver.path = ['opponent', 'base'], e => e.abilities.card[0].effect.amount.condition.args = [], e => e.abilities.card[0].effect.amount.condition.args = { 0: { kind: 'const', value: 'naboo' }, length: 1 }, e => delete e.abilities.card[0].contextTitle, e => e.abilities.card[0].contextTitle[1].then.value = 'unmodeled', e => e.abilities.card[0].targetResolver.owner = 'self', e => e.abilities.card[0].optional = true]) {
        const e = clone(entries[0]);
        change(e);
        assert.equal(p.classifyWeaknessContinuation(e), null);
    }
});
test('Beast then friendly Weakness has no optional, reversed, deeper or hostile continuation', () => {
    for (const change of [e => e.abilities.card[0].effect.entersReady = true, e => e.abilities.card[0].effect.tokenType = 'cloneTrooper', e => e.abilities.card[0].then.optional = true, e => e.abilities.card[0].then.then = {}, e => e.abilities.card[0].then.targetResolver.owner = 'any', e => e.abilities.card[0].then.effect.amount.value = 2, e => e.card.hp = 1]) {
        const e = clone(entries[1]);
        change(e);
        assert.equal(p.classifyWeaknessContinuation(e), null);
    }
});
test('Inferno requires both complete printed registrations and independent simultaneous child shapes', () => {
    for (const change of [e => e.abilities.card.pop(), e => e.abilities.card[1].trigger = 'onAttack', e => e.abilities.card[0].optional = false, e => e.abilities.card[1].effect.effects.reverse(), e => e.abilities.card[0].effect.kind = 'sequence', e => e.abilities.card[1].effect.effects[0].amount.value = 2, e => e.abilities.card[0].targetResolver.predicate = { kind: 'const', value: true }]) {
        const e = clone(entries[2]);
        change(e);
        assert.equal(p.classifyWeaknessContinuation(e), null);
    }
});
test('Dragonboat exact unique predicate has conditional Exhaust after child physical settlement', () => {
    for (const change of [e => e.abilities.card[0].effect.effects.reverse(), e => e.abilities.card[0].effect.effects[1].condition.path = ['source', 'unique'], e => e.abilities.card[0].effect.effects[1].onFalse = { kind: 'ready', target: 'chosen' }, e => e.abilities.card[0].optional = 'true', e => e.abilities.card[0].ifYouDo = {}]) {
        const e = clone(entries[3]);
        change(e);
        assert.equal(p.classifyWeaknessContinuation(e), null);
    }
});
test('quiet and defeat donors bind real provenance, class and plain mechanics', () => {
    const q = catalogue.cards.find(e => p.quietUnit(e)), u = catalogue.cards.find(e => p.quietUnit(e, true)), d = catalogue.cards.find(p.defeatEvent);
    assert.ok(q && u && d);
    for (const change of [e => e.sourceHash = 'a'.repeat(64), e => e.sourcePath = 'extra.ts', e => e.baseClass = 'NonLeaderUnitCard', e => e.card.pilotText = 'extra', e => e.card.hp = 0, e => e.abilities.extra = []]) {
        const e = clone(q);
        change(e);
        assert.equal(p.quietUnit(e), false);
    }
    for (const change of [e => e.sourceHash = null, e => e.card.pilotBox = 'extra', e => e.abilities.card[0].effect.extra = true, e => e.abilities.card[0].targetResolver.owner = 'self']) {
        const e = clone(d);
        change(e);
        assert.equal(p.defeatEvent(e), false);
    }
});
test('native Beast exact complete source metadata cannot be substituted or partially altered', () => {
    const b = catalogue.cards.find(p.nativeBeast);
    assert.ok(b);
    for (const change of [e => e.setCode = 'TOKEN_FAKE', e => e.sourceHash = 'a'.repeat(64), e => e.card.hp = 4, e => e.card.text = 'extra', e => e.card.rules = 'extra', e => e.card.pilotText = 'extra', e => e.abilities.card = [{}]]) {
        const e = clone(b);
        change(e);
        assert.equal(p.nativeBeast(e), false);
    }
});
test('source-driven plans cover both source seats, recipient ownership, exact unique copies and explicit gaps', () => {
    const plans = entries.map(e => p.planWeaknessContinuationProbes(e, { catalogue }));
    assert.deepEqual(plans.map(p => p.cases.length), [24, 8, 30, 14]);
    for (const plan of plans) {
        assert.ok(plan.cases.some(c => c.probe.sourceSeat === 1) && plan.cases.some(c => c.probe.sourceSeat === 2));
        assert.ok(plan.uncovered.some(o => o.id.endsWith('source-review')));
        for (const c of plan.cases) {
            assert.equal(c.source.scenario, c.name);
            assert.equal(new Set(c.setupCardIds).size, c.setupCardIds.length);
        }
    }
    assert.equal(plans[2].cases.filter(c => c.probe.uniqueReplacement).length, 4);
    assert.ok(plans[2].cases.filter(c => c.probe.uniqueReplacement).every(c => c.probe.expectedWeak === 2));
    assert.equal(plans[1].cases.filter(c => c.probe.snokeEntry).length, 2);
    assert.equal(plans.flatMap(p => p.cases).filter(c => c.probe.deathDamage).length, 8);
});
test('missing native Shield leaves a named construction gap instead of a false shield scenario', () => {
    const reduced = { ...catalogue, cards: catalogue.cards.filter(e => e.setCode !== 'TOKEN_SHIELD') };
    const plan = p.planWeaknessContinuationProbes(entries[2], { catalogue: reduced });
    assert.ok(!plan.cases.some(c => c.probe.variant === 'shield'));
    assert.equal(plan.uncovered.filter(o => o.id.includes('shield-donor')).length, 4);
});
