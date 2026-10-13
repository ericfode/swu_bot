'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { classifyForceFollowon, planForceFollowonProbes } = require('../pipeline/force-followon-probes');
const catalogue = require('../../card-compiler/generated/catalog.json');
const ids = ['LOF_031','LOF_035','LOF_048','LOF_075','LOF_149','LOF_159','LOF_172','LOF_173'];
const entry = id => structuredClone(catalogue.cards.find(e => e.setCode === id));
test('all eight printed continuation shapes have bounded timing and finite-gap constructions', () => {
    for (const id of ids) {
        const p = planForceFollowonProbes(entry(id), { catalogue });
        assert.ok(p.cases.length >= 5);
        assert.ok(p.cases.some(c => !c.probe.held));
        assert.ok(p.uncovered.some(o => o.id.endsWith('force-hook-reactions')));
        assert.ok(p.cases.every(c => c.setupCardIds.includes('TOKEN_THE_FORCE')));
    }
    for (const id of ['LOF_035','LOF_149']) {
        const p = planForceFollowonProbes(entry(id), { catalogue });
        assert.ok(p.cases.some(c => c.name.endsWith('empty-staged-recipients-entering-source') && c.probe.selectSource));
        assert.ok(!p.cases.some(c => c.name.endsWith('no-beneficial-recipient')));
    }
    assert.ok(planForceFollowonProbes(entry('LOF_159'),{catalogue}).cases.some(c => c.probe.hiddenMenu));
    assert.ok(planForceFollowonProbes(entry('LOF_149'),{catalogue}).cases.some(c => c.probe.overwhelmCombat));
});
test('extra registrars, source types, pilot, costs and continuations reject', () => {
    for (const change of [e => e.baseClass = 'LeaderUnitCard', e => e.card.types.push('token'),
        e => e.card.pilotText = 'Piloting 1', e => e.abilities.unit.push({trigger:'onAttack'}),
        e => e.abilities.card[0].costs.push({kind:'useForce'}), e => e.abilities.card[0].condition = {},
        e => e.abilities.card[0].targetResolver = {}, e => e.abilities.card[0].then = {},
        e => e.abilities.card[0].ifYouDo.ifYouDo = {}, e => e.abilities.card[0].ifYouDo.optional = true,
        e => e.abilities.card[0].optional = false]) {
        const e = entry('LOF_035'); change(e); assert.equal(classifyForceFollowon(e), null);
    }
});
test('primary Force scope and secondary selector domains are exact', () => {
    for (const change of [a => a.effect.target = 'enemyPlayer', a => a.effect.amount = {kind:'const',value:1},
        a => a.ifYouDo.targetResolver.owner = 'opponent', a => a.ifYouDo.targetResolver.type = 'any',
        a => a.ifYouDo.targetResolver.zone = 'discard', a => a.ifYouDo.targetResolver.optional = true,
        a => a.ifYouDo.targetResolver.count = 2, a => a.ifYouDo.targetResolver.predicate = {kind:'const',value:true},
        a => a.ifYouDo.effect.target = 'self', a => a.ifYouDo.effect.duration = 'persistent',
        a => a.ifYouDo.effect.hp = {kind:'ref',path:['source','hp']}]) {
        const e = entry('LOF_031'); change(e.abilities.card[0]); assert.equal(classifyForceFollowon(e), null);
    }
});
test('events mandatory and malformed/zero/oversized scalar children fail closed', () => {
    for (const change of [a => a.optional = true, a => a.optional = false,
        a => a.ifYouDo.effect.amount.value = 0, a => a.ifYouDo.effect.amount.value = 9,
        a => a.ifYouDo.effect.amount.value = 1.5, a => a.ifYouDo.effect.amount.extra = true,
        a => a.ifYouDo.effect = {kind:'simultaneous',effects:[a.ifYouDo.effect]}, a => a.ifYouDo = null]) {
        const e = entry('LOF_172'); change(e.abilities.card[0]); assert.equal(classifyForceFollowon(e), null);
    }
});
test('intrinsic combinations must match the fully constructed source family', () => {
    for (const change of [e => e.keywordValues.raid = 1, e => e.keywordValues.hidden = 1,
        e => e.keywordValues.shielded = 2, e => e.card.keywords.push('ambush'),
        e => e.card.keywords = [], e => e.abilities.card[0].trigger = 'whenDefeated']) {
        const e = entry('LOF_048'); change(e); assert.equal(classifyForceFollowon(e), null);
    }
    const e = entry('LOF_149'); e.keywordValues = {hidden:1}; e.card.keywords = ['hidden'];
    assert.equal(classifyForceFollowon(e), null);
});
test('discard continuation is opposing player exactly one without a selector', () => {
    for (const change of [a => a.ifYouDo.effect.target = 'ownPlayer', a => a.ifYouDo.effect.amount.value = 2,
        a => a.ifYouDo.targetResolver = {owner:'opponent',type:'any',zone:'hand'}, a => a.trigger = 'whenPlayed']) {
        const e = entry('LOF_159'); change(e.abilities.card[0]); assert.equal(classifyForceFollowon(e), null);
    }
});
test('reviewed native dependency and reachable source metadata remain mandatory', () => {
    const cards = structuredClone(catalogue.cards);
    cards.find(e => e.setCode === 'TOKEN_THE_FORCE').card.rules = '';
    const p = planForceFollowonProbes(entry('LOF_031'), {catalogue:cards});
    assert.equal(p.cases.length,0);
    assert.ok(p.uncovered.some(o => o.id.endsWith('metadata-donors')));
});

test('unary plus and unmodeled pilot/intrinsic donor mechanics fail closed', () => {
    const e = entry('LOF_031'); e.abilities.card[0].ifYouDo.effect.power.op = '+';
    assert.equal(classifyForceFollowon(e),null);
    const original=planForceFollowonProbes(entry('LOF_031'),{catalogue});
    const quietCode=original.cases[0].probe.targets[0].code;
    const defeatCode=original.cases[0].probe.activationCode;
    for(const change of [e=>e.card.pilotText='Piloting 1',e=>e.piloting={},e=>e.baseClass='LeaderUnitCard']) {
        const cards=structuredClone(catalogue.cards); change(cards.find(e=>e.setCode===quietCode));
        const p=planForceFollowonProbes(entry('LOF_031'),{catalogue:cards});
        assert.ok(p.cases.every(c=>!c.probe.targets.some(t=>t.code===quietCode)));
    }
    for(const change of [e=>e.keywordValues.hidden=1,e=>e.card.pilotText='Piloting 1',e=>e.piloting={},e=>e.baseClass='NonLeaderUnitCard']) {
        const cards=structuredClone(catalogue.cards); change(cards.find(e=>e.setCode===defeatCode));
        const p=planForceFollowonProbes(entry('LOF_031'),{catalogue:cards});
        assert.ok(p.cases.every(c=>c.probe.activationCode!==defeatCode));
    }
});

test('unary minus operand and ordinary unit arena match exact runtime grammar', () => {
    const e=entry('LOF_031'); e.abilities.card[0].ifYouDo.effect.hp.value.value=-2;
    assert.equal(classifyForceFollowon(e),null);
    for(const arena of [undefined,null,'outsideTheGame']) {
        const e=entry('LOF_035'); e.card.arena=arena; assert.equal(classifyForceFollowon(e),null);
    }
});

test('unit healing constructs uncapped amount boundary with one residual wound', () => {
    const plan = planForceFollowonProbes(entry('LOF_075'), {catalogue});
    const c = plan.cases.find(c => c.name.endsWith('partial-heal-leaves-one-damage'));
    assert.ok(c);
    assert.equal(c.probe.targets[0].damage, c.probe.amount + 1);
    const donor = catalogue.cards.find(e => e.setCode === c.probe.targets[0].code);
    assert.ok(donor.card.hp >= c.probe.amount + 2);
});
