'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const p=require('../pipeline/arena-keyword-set-probes');
const catalogue=JSON.parse(fs.readFileSync(process.env.SWU_DIAGNOSTIC_CATALOGUE??path.resolve(__dirname,'../../card-compiler/generated/catalog.json')));
const entries=['JTL_077','LOF_152','TWI_250','LOF_045'].map(id=>catalogue.cards.find(e=>e.setCode===id));
const clone=structuredClone;
test('four full source registrations retain grouped versus independent event semantics',()=>{
    assert.deepEqual(entries.map(e=>{const s=p.classifyArenaKeywordSet(e);return [s.trigger,s.mode,s.leaves.map(l=>l.keyword)];}),[['event','phaseModifiers',['sentinel','saboteur']],['event','simultaneous',['raid','saboteur']],['event','simultaneous',['raid','sentinel']],['onAttack','single',['restore']]]);
});
test('whole source class, registrar, side, pilot and intrinsic domains fail closed',()=>{
    for(const original of entries)for(const change of [e=>e.baseClass='LeaderUnitCard',e=>e.card.types=['unit','leader'],e=>e.card.pilotText='extra',e=>e.card.pilotBox='extra',e=>e.card.pilotingBox='extra',e=>e.piloting=true,e=>e.attachCondition={kind:'const',value:true},e=>e.abilities.unit=[{trigger:'onAttack'}],e=>e.abilities.card.push(clone(e.abilities.card[0])),e=>e.abilities.card[0].optional=true,e=>e.abilities.card[0].ifYouDo={},e=>e.abilities.card[0].costs=[{}],e=>delete e.abilities.card[0].effect,e=>e.keywordValues.hidden=1,e=>e.card.keywords.push('hidden')]){
        const e=clone(original);change(e);assert.equal(p.classifyArenaKeywordSet(e),null);
    }
});
test('list receiver, predicate and exact keyword expression fields reject unmodeled shapes',()=>{
    for(const change of [e=>e.target.receiver.path=['opponent'],e=>e.target.extra=true,e=>e.target.predicate={kind:'const',value:false},e=>e.amount={kind:'unary',op:'+',value:{kind:'const',value:1}},e=>e.amount.value=2,e=>e.duration='persistent',e=>e.keyword='hidden',e=>e.extra=true]){
        const e=clone(entries[1]);change(e.abilities.card[0].effect.effects[0]);assert.equal(p.classifyArenaKeywordSet(e),null);
    }
    const unit=clone(entries[3]);unit.card.arena='space';assert.equal(p.classifyArenaKeywordSet(unit),null);
    const missing=clone(entries[3]);missing.abilities.card[0].effect.target.predicate=missing.abilities.card[0].effect.target.predicate.left;assert.equal(p.classifyArenaKeywordSet(missing),null);
});
test('grouped phase factories cannot be substituted for independent simultaneous predicates',()=>{
    const e=clone(entries[0]);e.abilities.card[0].effect.kind='simultaneous';assert.equal(p.classifyArenaKeywordSet(e),null);
    const f=clone(entries[2]);f.abilities.card[0].effect.kind='phaseModifiers';assert.equal(p.classifyArenaKeywordSet(f),null);
});
test('quiet donor requires literal data-only provenance and excludes pilot mechanics',()=>{
    const q=catalogue.cards.find(p.quietUnit);assert.ok(q);
    for(const change of [e=>e.sourceHash='unbound',e=>e.sourcePath='source.ts',e=>e.baseClass='NonLeaderUnitCard',e=>e.card.pilotText='extra',e=>e.card.unique=true,e=>e.keywordValues.raid=1,e=>e.card.keywords=['raid']]){const e=clone(q);change(e);assert.equal(p.quietUnit(e),false);}
});
test('real Sentinel HP and damage dependencies have exact supported source shape',()=>{
    const h=catalogue.cards.find(p.sentinelHpDonor),d=catalogue.cards.find(p.damageDonor);assert.ok(h&&d);
    for(const change of [e=>e.abilities.card[0].effect.hp.value=3,e=>e.abilities.card[0].optional=true,e=>e.abilities.card[0].targetResolver.owner='any',e=>e.card.pilotText='extra']){const e=clone(h);change(e);assert.equal(p.sentinelHpDonor(e),false);}
    for(const change of [e=>e.abilities.card[0].effect.extra=true,e=>e.abilities.card[0].effect.amount.extra=true,e=>e.abilities.card[0].targetResolver.predicate={kind:'const',value:true},e=>e.baseClass='NonLeaderUnitCard']){const e=clone(d);change(e);assert.equal(p.damageDonor(e),false);}
});
test('bounded plans include source seats, actual combat, HP expiry and finite gaps',()=>{
    const plans=entries.map(e=>p.planArenaKeywordSetProbes(e,{catalogue}));assert.deepEqual(plans.map(p=>p.cases.length),[9,9,13,9]);
    for(const plan of plans){assert.ok(plan.cases.some(c=>c.probe.sourceSeat===2));assert.ok(plan.uncovered.some(o=>o.id.endsWith('source-review')));assert.ok(plan.uncovered.some(o=>o.id.endsWith('new-entrant')));for(const c of plan.cases){assert.equal(new Set(c.setupCardIds).size,c.setupCardIds.length);for(const owner of ['self','opponent']){const codes=c.probe.targets.filter(t=>t.owner===owner&&!t.token).map(t=>t.code);for(const code of codes)assert.ok(codes.filter(x=>x===code).length<=3);}}}
    assert.ok(plans[0].cases.some(c=>c.probe.hpDependency));assert.ok(plans[2].cases.some(c=>c.probe.hpDependency));assert.deepEqual(plans[3].cases.filter(c=>c.probe.laterRestore).map(c=>c.probe.ownBaseDamage),[4,1,0]);
});

test('intrinsic combat donors bind complete ordinary source or reviewed data-only keyword grammar',()=>{
    const q=catalogue.cards.find(p.keywordOnly);assert.ok(q);
    for(const change of [e=>e.baseClass='EventCard',e=>e.baseClass='BaseCard',e=>e.sourcePath='unbound.ts',e=>e.sourceHash='a'.repeat(64),e=>e.card.keywords.push('raid'),e=>e.card.text+='\nDraw a card.',e=>e.keywordValues.sentinel=2]){const e=clone(q);change(e);assert.equal(p.keywordOnly(e),false);}
    const source=clone(q);source.baseClass='NonLeaderUnitCard';source.sourcePath='cards/ordinary.ts';source.sourceHash='a'.repeat(64);assert.equal(p.keywordOnly(source),true);source.sourceHash=null;assert.equal(p.keywordOnly(source),false);
});
