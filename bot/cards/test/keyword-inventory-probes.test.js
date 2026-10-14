'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const p = require('../pipeline/keyword-inventory-probes');
const catalogue = JSON.parse(fs.readFileSync(process.env.SWU_DIAGNOSTIC_CATALOGUE ?? path.resolve(__dirname, '../../card-compiler/generated/catalog.json')));
const get = id => structuredClone(catalogue.cards.find(e => e.setCode === id));
test('complete aura and optional exhaust source shapes classify', () => {
    assert.equal(p.classifyKeywordInventory(get('ASH_100')).mode, 'other-friendly-aura');
    assert.equal(p.classifyKeywordInventory(get('ASH_214')).mode, 'optional-exhaust');
});
test('whole source class/type/provenance/side/pilot bounds reject unmodeled entries', () => {
    for (const mutate of [e => e.baseClass = 'BaseCard', e => e.card.types = ['unit', 'token'], e => e.card.unique = undefined,
        e => e.sourcePath = null, e => e.sourceHash = null, e => e.card.arena = undefined, e => e.card.traits = null,
        e => e.piloting = false, e => e.card.pilotBox = false, e => e.attachCondition = {}, e => e.keywordValues = { sentinel: 1 },
        e => e.abilities.unit.push({ trigger: 'onAttack' }), e => e.abilities.card.push(e.abilities.card[0])]) {
        const e = get('ASH_100');
        mutate(e);
        assert.equal(p.classifyKeywordInventory(e), null);
    }
});
test('inventory expression threshold and receiver are exact', () => {
    for (const mutate of [e => e.abilities.card[0].targetResolver.predicate.right.value = 1,
        e => e.abilities.card[0].targetResolver.predicate.left.path = ['source', 'keywords', 'length'],
        e => e.abilities.card[0].targetResolver.owner = 'self', e => e.abilities.card[0].targetResolver.zone = 'ground',
        e => e.abilities.card[0].optional = false, e => e.abilities.card[0].ifYouDo = {}, e => e.abilities.card[0].effect = { kind: 'ready', target: 'chosen' }]) {
        const e = get('ASH_214');
        mutate(e);
        assert.equal(p.classifyKeywordInventory(e), null);
    }
});
test('aura guards preserve source exclusion/controller/all arenas and exact stats', () => {
    for (const mutate of [e => e.abilities.card[0].targetResolver.predicate.left.left.op = '===',
        e => e.abilities.card[0].targetResolver.predicate.right.right.value = 2, e => e.abilities.card[0].effect.hp.value = 3,
        e => e.abilities.card[0].targetResolver.owner = 'any', e => e.abilities.card[0].optional = true,
        e => e.abilities.card[0].condition = { kind: 'const', value: true }]) {
        const e = get('ASH_100');
        mutate(e);
        assert.equal(p.classifyKeywordInventory(e), null);
    }
});
test('literal donors require whole grammar and exact quiet provenance', () => {
    const donor = catalogue.cards.find(e => p.literalUnit(e) && Object.keys(e.keywordValues).length);
    assert.ok(donor);
    for (const mutate of [e => e.sourceHash = 'a'.repeat(64), e => e.sourcePath = 'fake.ts', e => e.baseClass = 'NonLeaderUnitCard',
        e => e.card.text += '\nWhen Played: draw a card.', e => e.card.keywords.push('bounty'), e => e.card.unique = undefined,
        e => e.card.cost = -1, e => e.card.pilotText = false, e => e.abilities.card.push({ trigger: 'whenPlayed' })]) {
        const e = structuredClone(donor);
        mutate(e);
        assert.equal(p.literalUnit(e), false);
    }
});
test('Coordinate is independent printed instance with full guarded registration', () => {
    assert.ok(p.coordinateUnit(get('TWI_045')));
    for (const mutate of [e => e.abilities.card[0].coordinate = false, e => e.abilities.card[0].effect.hp.value = 4,
        e => e.card.keywords = [], e => e.keywordValues = {}, e => e.card.pilotBox = false]) {
        const e = get('TWI_045');
        mutate(e);
        assert.equal(p.coordinateUnit(e), false);
    }
});
test('secondary source donors bind complete independent bodies and metadata', () => {
    for (const [id, role] of [['HMW_117', 'dynamic-raid'], ['LOF_196', 'force-sentinel'], ['TWI_170', 'damage-two'], ['HMW_096', 'restore-upgrade']]) {
        assert.ok(p.roleDonor(get(id), role));
        for (const mutate of [e => e.baseClass = 'BaseCard', e => e.abilities.card[0].optional = true, e => e.abilities.unit.push({}), e => e.card.pilotBox = false]) {
            const e = get(id);
            mutate(e);
            assert.equal(p.roleDonor(e, role), false);
        }
    }
});
test('missing native dependency removes dependent actual macro instead of manufacturing tokens', () => {
    const without = catalogue.cards.filter(e => e.setCode !== 'TOKEN_THE_FORCE' && e.setCode !== 'TOKEN_SHIELD');
    const plan = p.planKeywordInventoryProbes(get('ASH_100'), { catalogue: without });
    assert.ok(!plan.cases.some(e => e.probe.macro?.startsWith('force-') || e.probe.macro?.startsWith('shielded')));
});
test('68 whole terminal definitions round trip and preserve source-seat pairings', () => {
    const library = require('../reference/library');
    const plans = ['ASH_100', 'ASH_214'].map(id => p.planKeywordInventoryProbes(get(id), { catalogue }));
    assert.equal(plans.flatMap(x => x.cases).length, 68);
    for (const plan of plans) {
        assert.deepEqual([...new Set(plan.cases.map(c => c.probe.sourceSeat))].sort(), [1, 2]);
        assert.ok(plan.uncovered.some(o => o.id.endsWith(':controller-transfer')));
        for (const c of plan.cases)
            assert.deepEqual(library.definition(c.id, { cases: [] }, c), c);
    }
});

test('missing Coordinate ability metadata returns rejection without throwing', () => {
    for (const value of [undefined, null, {}, { leader: [], unit: [] }]) {
        const donor = get('TWI_045'); donor.abilities = value;
        assert.equal(p.coordinateUnit(donor), false);
    }
});
test('renamed structural Force donors retain identity-based gain/use assertions', () => {
    const { assertGainUseCheckpoint } = require('../pipeline/keyword-inventory-probe-fixture');
    const gain = get('LOF_193'), use = get('LOF_195');
    gain.internalName = gain.card.internalName = 'alternate-gain'; gain.card.title = 'Alternate Gain';
    use.internalName = use.card.internalName = 'alternate-use'; use.card.title = 'Alternate Use';
    assert.ok(p.roleDonor(gain, 'gain-force')); assert.ok(p.roleDonor(use, 'use-ready'));
    const firstGain = { internalName: gain.internalName }, secondGain = { internalName: gain.internalName }, used = { internalName: use.internalName, exhausted: false };
    const extras = [{}, firstGain, used, secondGain];
    const host = { cardData: { hp: 4 }, keywords: [{ name: 'sentinel' }, { name: 'restore' }], getHp: () => 7 };
    for (const card of [firstGain, secondGain]) {
        assert.equal(assertGainUseCheckpoint(host, card, extras, { held: true }), 'gain');
        assert.throws(() => assertGainUseCheckpoint(host, card, extras, { held: false }));
    }
    host.keywords = [{ name: 'restore' }]; host.getHp = () => 5;
    assert.equal(assertGainUseCheckpoint(host, used, extras, { held: false }), 'use');
    assert.throws(() => assertGainUseCheckpoint(host, used, extras, { held: true }));
    used.exhausted = true;
    assert.throws(() => assertGainUseCheckpoint(host, used, extras, { held: false }));
});
