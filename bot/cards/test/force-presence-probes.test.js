'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { classifyForcePresence, planForcePresenceProbes } = require('../pipeline/force-presence-probes');
const catalogue = require('../../card-compiler/generated/catalog.json');
const entry = id => structuredClone(catalogue.cards.find(e => e.setCode === id));
test('four full source constant shapes have actual lifecycle plans and explicit gaps', () => {
    for (const id of ['LOF_050','LOF_196','LOF_231','LOF_237']) {
        const p = planForcePresenceProbes(entry(id), {catalogue});
        assert.ok(p.cases.some(c => c.probe.lifecycle));
        assert.ok(p.cases.some(c => !c.probe.held && c.probe.enemyHeld));
        assert.ok(p.uncovered.some(g => g.id.endsWith('pending-window-force-change')));
        assert.ok(p.cases.every(c => c.setupCardIds.includes('TOKEN_THE_FORCE')));
    }
});
test('exact ordinary source and sole constant registrar fail closed', () => {
    for (const mutate of [e=>e.baseClass='LeaderUnitCard',e=>e.card.types.push('token'),e=>e.card.arena='base',
        e=>e.card.pilotText='Pilot1',e=>e.piloting={},e=>e.abilities.unit.push({}),
        e=>e.abilities.card[0].optional=true,e=>e.abilities.card[0].ifYouDo={},
        e=>e.abilities.card[0].costs.push({}),e=>e.abilities.card[0].condition.path[0]='opponent',
        e=>e.abilities.card[0].condition={kind:'query',name:'hasTheForce',args:[]},
        e=>e.keywordValues.hidden=1,e=>e.card.keywords.push('hidden')]) {
        const e=entry('LOF_050'); mutate(e); assert.equal(classifyForcePresence(e),null);
    }
});
test('conditional keyword is a literal singleton on persistent self only', () => {
    for (const mutate of [e=>e.effect.keyword='hidden',e=>e.effect.amount.value=2,
        e=>e.effect.amount={kind:'unary',op:'-',value:{kind:'const',value:1}},
        e=>e.effect.duration='phase',e=>e.effect.target='chosen',e=>e.targetResolver={}]) {
        const e=entry('LOF_196');mutate(e.abilities.card[0]);assert.equal(classifyForcePresence(e),null);
    }
});
test('aura admits only friendly unit arena power and exactly zero HP', () => {
    for(const mutate of [a=>a.effect.hp.value=1,a=>a.effect.power.value=0,a=>a.effect.power.value=1.5,
        a=>a.targetResolver.owner='any',a=>a.targetResolver.type='any',a=>a.targetResolver.zone='anyAttackable',
        a=>a.targetResolver.predicate={kind:'const',value:true},a=>a.targetResolver.count=1]) {
        const e=entry('LOF_237');mutate(e.abilities.card[0]);assert.equal(classifyForcePresence(e),null);
    }
});
test('raw keyword mentions match conditional plus modeled intrinsic rather than becoming intrinsic', () => {
    const e=entry('LOF_231');assert.deepEqual(classifyForcePresence(e).keywords,{shielded:1});
    e.keywordValues.ambush=1;assert.equal(classifyForcePresence(e),null);
    for(const id of ['LOF_050','LOF_196','LOF_231','LOF_237']) {
        const e=entry(id);e.card.keywords.push('restore');assert.equal(classifyForcePresence(e),null);
    }
});
test('reviewed native Force dependency is mandatory even absent own Force', () => {
    const cards=structuredClone(catalogue.cards);
    cards.find(e=>e.setCode==='TOKEN_THE_FORCE').card.rules='changed';
    const p=planForcePresenceProbes(entry('LOF_050'),{catalogue:cards});
    assert.equal(p.cases.length,0);assert.ok(p.uncovered.length);
});
test('quiet donors reject extra pilot body and class mismatches', () => {
    const original = planForcePresenceProbes(entry('LOF_050'), {catalogue});
    const code = original.cases[0].probe.targets[0].code;
    for (const mutate of [e=>e.card.pilotText='Pilot',e=>e.piloting={},e=>e.baseClass='LeaderUnitCard',e=>e.keywordValues.raid=1]) {
        const cards=structuredClone(catalogue.cards); mutate(cards.find(e=>e.setCode===code));
        const p=planForcePresenceProbes(entry('LOF_050'),{catalogue:cards});
        assert.ok(p.cases.every(c=>c.probe.targets.every(t=>t.code!==code)));
    }
});
test('actual Hidden donor has exact other-friendly persistent grant and bounded metadata', () => {
    const original=planForcePresenceProbes(entry('LOF_196'),{catalogue});
    const row=original.cases.find(c=>c.probe.hiddenGrant).probe.targets[4];
    for(const mutate of [e=>e.abilities.card[0].effect.amount.value=2,e=>e.abilities.card[0].condition={},e=>e.abilities.card[0].targetResolver.owner='any',e=>e.card.pilotText='Pilot']) {
        const cards=structuredClone(catalogue.cards);mutate(cards.find(e=>e.setCode===row.code));
        const p=planForcePresenceProbes(entry('LOF_196'),{catalogue:cards});
        assert.ok(!p.cases.some(c=>c.probe.hiddenGrant));
    }
});

test('constructed Sentinel and Ambush attack domains fail closed outside ground', () => {
    for(const id of ['LOF_196','LOF_231']) {
        const e=entry(id);e.card.arena='space';assert.equal(classifyForcePresence(e),null);
    }
});
test('aura source-death donor rejects every pilot metadata form', () => {
    const original=planForcePresenceProbes(entry('LOF_237'),{catalogue});
    const row=original.cases.find(c=>c.probe.sourceDeparture).probe.targets[4];
    for(const field of ['pilotText','pilotBox','pilotingBox']) {
        const cards=structuredClone(catalogue.cards);cards.find(e=>e.setCode===row.code).card[field]='Pilot';
        const p=planForcePresenceProbes(entry('LOF_237'),{catalogue:cards});
        assert.ok(!p.cases.some(c=>c.probe.sourceDeparture));
    }
});
