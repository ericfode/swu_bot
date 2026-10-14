'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const p = require('../pipeline/parent-upgrade-probes');
const catalogue = JSON.parse(fs.readFileSync(process.env.SWU_DIAGNOSTIC_CATALOGUE ?? path.resolve(__dirname, '../../card-compiler/generated/catalog.json')));
const get = id => structuredClone(catalogue.cards.find(e => e.setCode === id));
test('two complete ordinary parent-upgrade source shapes classify', () => {
    assert.equal(p.classifyParentUpgrade(get('HMW_038')).mode, 'parent-trait-beast');
    assert.equal(p.classifyParentUpgrade(get('HMW_264')).mode, 'parent-aspect-shield');
});
test('source metadata/class/provenance/positive HP construction bounds fail closed', () => {
    for (const mutate of [e => e.baseClass = 'EventCard', e => e.card.types = ['token', 'upgrade'], e => e.card.unique = true,
        e => e.sourcePath = null, e => e.sourceHash = null, e => e.card.pilotText = 'Pilot', e => e.attachCondition = { kind: 'const', value: true },
        e => e.card.hp = 3, e => e.card.upgradeHp = 1, e => e.card.cost = 20, e => e.card.aspects = null]) {
        const e = get('HMW_038');
        mutate(e);
        assert.equal(p.classifyParentUpgrade(e), null);
    }
});
test('extra registration/side/optional/cost/continuation is unmodeled', () => {
    for (const mutate of [e => e.abilities.card[0].optional = true, e => e.abilities.card[0].costs = [{ kind: 'exhaustSelf' }],
        e => e.abilities.card[0].ifYouDo = {}, e => e.abilities.card[0].condition = { kind: 'const', value: true },
        e => e.abilities.unit.push(e.abilities.card[0]), e => e.abilities.card.push(e.abilities.card[0])]) {
        const e = get('HMW_264');
        mutate(e);
        assert.equal(p.classifyParentUpgrade(e), null);
    }
});
test('Bestial OR/null-guard/own receiver and exact one-Beast semantics are preserved', () => {
    for (const mutate of [e => e.abilities.card[0].effect.condition.op = '||', e => e.abilities.card[0].effect.condition.right.args[0].items.pop(),
        e => e.abilities.card[0].effect.onTrue.target = 'opponent', e => e.abilities.card[0].effect.onTrue.amount.value = 2,
        e => e.abilities.card[0].effect.onTrue.entersReady = true, e => e.abilities.card[0].contextTitle = null]) {
        const e = get('HMW_038');
        mutate(e);
        assert.equal(p.classifyParentUpgrade(e), null);
    }
});
test('Heroic host aspect/parent identity and operational title are exact', () => {
    for (const mutate of [e => e.abilities.card[0].effect.condition.receiver.path = ['player'], e => e.abilities.card[0].effect.condition.args[0].value = 'vigilance',
        e => e.abilities.card[0].effect.onTrue.target.path = ['source'], e => e.abilities.card[0].contextTitle[1].left.path = ['source', 'title'],
        e => e.abilities.card[0].contextTitle[1].op = '||', e => e.abilities.card[0].contextTitle[1].right.value = 'stale host']) {
        const e = get('HMW_264');
        mutate(e);
        assert.equal(p.classifyParentUpgrade(e), null);
    }
});
test('quiet host metadata is data-only and cannot hide source/intrinsic/pilot behavior', () => {
    const quiet = catalogue.cards.find(p.quietUnit);
    assert.ok(quiet);
    for (const mutate of [e => e.sourceHash = 'a'.repeat(64), e => e.sourcePath = 'fake.ts', e => e.baseClass = false,
        e => e.card.unique = undefined, e => e.card.cost = undefined, e => e.card.keywords = ['hidden'], e => e.card.pilotText = 'Pilot']) {
        const e = structuredClone(quiet);
        mutate(e);
        assert.equal(p.quietUnit(e), false);
    }
});
test('native Clone and Weakness dependencies bind complete reviewed entries', () => {
    for (const [id, classify] of [['TOKEN_CLONE_TROOPER', p.nativeCloneTrooper], ['TOKEN_WEAKNESS', p.nativeWeakness]]) {
        assert.ok(classify(get(id)));
        for (const mutate of [e => e.setCode = 'TOKEN_FAKE', e => e.sourceHash = 'a'.repeat(64), e => e.card.hp++, e => e.abilities.card.push({ trigger: 'whenPlayed' })]) {
            const e = get(id);
            mutate(e);
            assert.equal(classify(e), false);
        }
    }
});
test('leader host rejects class/pilot/extra side mechanics', () => {
    const donor = catalogue.cards.find(p.leaderHost);
    assert.ok(donor);
    for (const mutate of [e => e.baseClass = 'BaseCard', e => e.card.pilotText = 'Pilot', e => e.abilities.unit.push({ trigger: 'onAttack' })]) {
        const e = structuredClone(donor);
        mutate(e);
        assert.equal(p.leaderHost(e), false);
    }
});
test('actual later-return donors have complete guarded body and affordable metadata', () => {
    assert.ok(p.returnDonor(get('SHD_209')));
    assert.ok(p.torrentDonor(get('HMW_100')));
    for (const [id, classify] of [['SHD_209', p.returnDonor], ['HMW_100', p.torrentDonor]]) {
        const e = get(id);
        e.card.cost = 40;
        assert.equal(classify(e), false);
        const f = get(id);
        f.card.pilotText = 'Pilot';
        assert.equal(classify(f), false);
    }
});
test('missing native dependency becomes uncovered construction, never a fake token', () => {
    const cat = catalogue.cards.filter(e => e.setCode !== 'TOKEN_BEAST');
    const plan = p.planParentUpgradeProbes(get('HMW_038'), { catalogue: cat });
    assert.equal(plan.cases.length, 0);
    assert.ok(plan.uncovered.length);
});
test('68 proposed terminal definitions round trip with paired seats and explicit detached gap', () => {
    const library = require('../reference/library');
    const plans = ['HMW_038', 'HMW_264'].map(id => p.planParentUpgradeProbes(get(id), { catalogue }));
    assert.equal(plans.flatMap(x => x.cases).length, 68);
    for (const plan of plans) {
        assert.deepEqual([...new Set(plan.cases.map(c => c.probe.sourceSeat))].sort(), [1, 2]);
        assert.ok(plan.uncovered.some(o => o.id.endsWith(':detached-source-captured-wp')));
        for (const c of plan.cases)
            assert.deepEqual(library.definition(c.id, { cases: [] }, c), c);
    }
});
test('overlap and leader donor statistics/deployment text cannot be malformed', () => {
    const overlap = get('LOF_170');
    assert.ok(p.overlapHost(overlap));
    for (const mutate of [e => e.card.hp = undefined, e => e.card.power = -1, e => e.card.traits = null, e => e.card.unique = undefined]) {
        const e = structuredClone(overlap);
        mutate(e);
        assert.equal(p.overlapHost(e), false);
    }
    const leader = catalogue.cards.find(p.leaderHost);
    assert.ok(leader);
    const e = structuredClone(leader);
    e.card.deployBox += ' and an unmodeled ability';
    assert.equal(p.leaderHost(e), false);
});

test('blank Naboo base requires complete quiet metadata and no pilot fields', () => {
    const base = catalogue.cards.find(p.blankNabooBase);
    assert.ok(base);
    for (const mutate of [e => e.card.types = undefined, e => e.card.traits = null, e => e.card.aspects = null,
        e => e.sourceHash = 'a'.repeat(64), e => e.sourcePath = 'fake.ts', e => e.baseClass = 'BaseCard',
        e => e.card.text = 'Unmodeled', e => e.card.hp = 0, e => e.card.keywords = ['restore'],
        e => e.keywordValues = { restore: 1 }, e => e.abilities.card.push({ trigger: 'whenPlayed' })]) {
        const e = structuredClone(base);
        mutate(e);
        assert.equal(p.blankNabooBase(e), false);
    }
    for (const value of [false, '', 0, {}, 'Pilot']) {
        for (const field of ['pilotText', 'pilotBox', 'pilotingBox', 'piloting']) {
            const e = get('HMW_038');
            if (field === 'piloting') e[field] = value;
            else e.card[field] = value;
            assert.equal(p.classifyParentUpgrade(e), null);
        }
    }
});
