'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { classifyArenaDamage, planArenaDamageProbes, quietUnit, defeatEvent, nativeShield } = require('../pipeline/arena-damage-probes');
const catalogue = JSON.parse(fs.readFileSync(process.env.SWU_DIAGNOSTIC_CATALOGUE ?? path.resolve(__dirname, '../../card-compiler/generated/catalog.json')));
const selected = ['IBH_072', 'LOF_170', 'SEC_263', 'SHD_158', 'TWI_164'].map(id => catalogue.cards.find(e => e.setCode === id));
const clone = structuredClone;
test('complete five source shapes classify with actual full keyword and registration scopes', () => {
    const shapes = selected.map(classifyArenaDamage);
    assert.ok(shapes.every(Boolean));
    assert.deepEqual(shapes.map(s => [s.trigger, s.amount, s.receiver, s.arena, s.excludeSource, s.exhaustedOnly, s.coordinateRaid, s.overwhelm]), [
        ['whenPlayed', 1, 'game', null, true, false, 0, false], ['onAttack', 3, 'game', null, true, false, 0, false],
        ['whenDefeated', 1, 'opponent', 'ground', false, true, 0, false], ['whenPlayed', 2, 'game', 'ground', true, false, 0, true],
        ['whenDefeated', 1, 'opponent', 'ground', false, false, 2, false],
    ]);
});
test('registrar extras, omitted effects, incompatible class/types, pilot and unsupported keywords reject', () => {
    for (const change of [e => e.baseClass = 'EventCard', e => e.card.types = ['unit', 'leader'], e => e.card.pilotText = 'unmodeled', e => e.abilities.unit = [{ trigger: 'action' }], e => e.abilities.card[0].optional = true, e => e.abilities.card[0].ifYouDo = { effect: { kind: 'draw' } }, e => delete e.abilities.card[0].effect, e => e.keywordValues.hidden = 1, e => e.card.keywords = ['hidden'], e => e.attachCondition = { kind: 'const', value: true }]) {
        const entry = clone(selected[0]);
        change(entry);
        assert.equal(classifyArenaDamage(entry), null);
    }
});
test('target grammar and construction domains fail closed', () => {
    for (const change of [e => e.abilities.card[0].effect.target.kind = 'group', e => e.abilities.card[0].effect.target.receiver.path = ['player'], e => e.abilities.card[0].effect.target.predicate = { kind: 'const', value: true }, e => e.abilities.card[0].effect.amount.value = 4, e => e.abilities.card[0].effect.amount = { kind: 'unary', op: '+', value: { kind: 'const', value: 1 } }, e => e.abilities.card[0].effect.amount.extra = true, e => e.abilities.card[0].effect.duration = 'phase']) {
        const entry = clone(selected[0]);
        change(entry);
        assert.equal(classifyArenaDamage(entry), null);
    }
    const death = clone(selected[2]);
    death.abilities.card[0].effect.target.receiver.path = ['game'];
    assert.equal(classifyArenaDamage(death), null);
});
test('Coordinate is whole-card mandatory constant and Raid presence is conditional', () => {
    for (const change of [e => e.abilities.card[0].coordinate = false, e => e.abilities.card[0].optional = true, e => e.abilities.card[0].effect.keyword = 'grit', e => e.keywordValues.raid = 2, e => e.abilities.card.splice(1, 1), e => e.abilities.card[1].trigger = 'onAttack']) {
        const entry = clone(selected[4]);
        change(entry);
        assert.equal(classifyArenaDamage(entry), null);
    }
});
test('quiet and actual defeat donors enforce plain class and metadata domains', () => {
    const q = catalogue.cards.find(quietUnit), d = catalogue.cards.find(defeatEvent);
    assert.ok(q && d);
    for (const field of ['pilotText', 'pilotBox', 'pilotingBox']) {
        const e = clone(q);
        e.card[field] = 'unmodeled';
        assert.equal(quietUnit(e), false);
    }
    const e = clone(q);
    e.baseClass = 'EventCard';
    assert.equal(quietUnit(e), false);
    const f = clone(d);
    f.abilities.card[0].effect.extra = true;
    assert.equal(defeatEvent(f), false);
});
test('plans include actual source seats, Shield token identity, full keyword and finite gaps', () => {
    const plans = selected.map(e => planArenaDamageProbes(e, { catalogue }));
    assert.deepEqual(plans.map(p => p.cases.length), [9, 12, 9, 11, 11]);
    for (const p of plans) {
        assert.ok(p.cases.some(c => c.probe.sourceSeat === 1) && p.cases.some(c => c.probe.sourceSeat === 2));
        assert.ok(p.cases.some(c => c.probe.sameOwnerShields));
        assert.ok(p.uncovered.some(o => o.id.endsWith('source-review')));
        for (const c of p.cases) {
            assert.equal(new Set(c.setupCardIds).size, c.setupCardIds.length);
            for (const owner of ['self', 'opponent']) {
                const codes = c.probe.targets.filter(t => t.owner === owner && !t.token).map(t => t.code);
                for (const code of codes)
                    assert.ok(codes.filter(x => x === code).length <= 3, 'Ordinary deck copy limit');
            }
        }
    }
    assert.ok(plans[1].cases.some(c => c.probe.defenseToken));
    assert.ok(plans[3].cases.some(c => c.probe.combatAfterPlay));
    assert.deepEqual(plans[4].cases.filter(c => c.probe.coordinateCombat).map(c => c.probe.friendlyCount), [2, 3]);
});
test('every new construction round-trips through immutable reference definition protocol', () => {
    const library = require('../reference/library');
    for (const e of selected)
        for (const c of planArenaDamageProbes(e, { catalogue }).cases)
            assert.deepEqual(library.definition(c.id, { cases: [] }, c), c);
});
test('source-only provenance, arena attack constructors and exact native Shield fail closed', () => {
    const quiet = clone(catalogue.cards.find(quietUnit));
    quiet.baseClass = undefined;
    quiet.sourcePath = null;
    quiet.sourceHash = 'unexpected';
    assert.equal(quietUnit(quiet), false);
    const attack = clone(selected[1]);
    attack.card.arena = 'space';
    assert.equal(classifyArenaDamage(attack), null);
    const shield = catalogue.cards.find(nativeShield);
    assert.ok(shield);
    for (const change of [e => e.card.traits = [], e => e.sourceHash = 'wrong', e => e.card.text = 'unmodeled', e => e.abilities.card = [{ trigger: 'constant' }], e => e.setCode = 'TOKEN_OTHER']) {
        const e = clone(shield);
        change(e);
        assert.equal(nativeShield(e), false);
    }
});

test('broader low-HP and lethal Coordinate constructions remain explicit uncovered bounds', () => {
    const attack = clone(selected[1]); attack.card.hp = 1;
    const plan = planArenaDamageProbes(attack, { catalogue });
    assert.ok(!plan.cases.some(c => c.probe.defenderSurvivesWave));
    assert.ok(plan.uncovered.some(o => o.id.endsWith('surviving-wave-combat')));
    const coordinate = clone(selected[4]); coordinate.abilities.card[0].effect.amount.value = 127;
    const raid = planArenaDamageProbes(coordinate, { catalogue });
    assert.ok(!raid.cases.some(c => c.probe.coordinateCombat));
    assert.ok(raid.uncovered.some(o => o.id.endsWith('coordinate-combat-boundary')));
});
