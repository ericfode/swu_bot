'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {classifyUpgradeReturn,planUpgradeReturnProbes}=require('../pipeline/upgrade-return-probes');
const catalogue=require('../../card-compiler/generated/catalog.json');
const ids=['HMW_222','SHD_044','SHD_209','HMW_236','SEC_200'];
const plan=id=>planUpgradeReturnProbes(catalogue.cards.find(e=>e.setCode===id),{catalogue});
test('upgrade-return family recognizes complete source shapes and fails closed on unknown fields',()=>{
    for(const id of ids){const raw=catalogue.cards.find(e=>e.setCode===id);assert.ok(classifyUpgradeReturn(raw));assert.deepEqual(plan(id),plan(id));const altered=structuredClone(raw);altered.abilities.card[0].targetResolver.count={kind:'const',value:2};assert.equal(classifyUpgradeReturn(altered),null);altered.abilities.card[0].targetResolver=raw.abilities.card[0].targetResolver;altered.abilities.card[0].effect.hidden=true;assert.equal(classifyUpgradeReturn(altered),null);}
});
test('base trait adapter is structural rather than tied to one printed trait',()=>{const entry=structuredClone(catalogue.cards.find(e=>e.setCode==='HMW_222'));entry.abilities.card[0].effect.condition.args[0].value='synthetic-trait';assert.equal(classifyUpgradeReturn(entry).baseTrait,'synthetic-trait');});
test('upgrade-return planner constructs actual token, owner, threshold, unique, discard and base boundaries',()=>{
    assert.ok(plan('SHD_209').cases.some(c=>c.name.endsWith('unique-excluded')));
    for(const id of ['HMW_222','HMW_236','SEC_200'])assert.ok(plan(id).cases.some(c=>c.name.endsWith('above-only')));
    for(const id of ['HMW_222','HMW_236','SEC_200','SHD_209']){
        const p=plan(id);assert.ok(p.cases.some(c=>c.name.endsWith('own-upgrade-enemy-host')));assert.ok(p.cases.some(c=>c.name.endsWith('hp-removal-host-death')));assert.ok(p.cases.some(c=>c.name.endsWith('shield')));assert.ok(p.cases.some(c=>c.name.endsWith('experience')));
    }
    assert.ok(plan('SHD_044').cases.some(c=>c.name.endsWith('enemy-discard-excluded')));
    assert.ok(plan('HMW_222').cases.some(c=>c.name.endsWith('base-trait-false')));
    assert.ok(plan('HMW_236').cases.some(c=>c.probe.chosenSource));
});
test('actual pinned engine plays each source and witnesses upgrade return lifecycle boundaries',async()=>{
    const {Env}=require('../../env'),{loadPool}=require('../../omni/rs/pool'),{fixture}=require('../pipeline/upgrade-return-probe-fixture');
    const pool=loadPool(require('node:path').resolve(__dirname,'../../card-compiler/generated/runtime-pool.json')),scenarios=ids.flatMap(id=>plan(id).cases),env=new Env();
    for(const id of new Set(scenarios.flatMap(c=>[...c.focusCardIds,...c.setupCardIds])))if(!pool.cards.some(c=>c.setCode===id))pool.cards.push({...catalogue.cards.find(c=>c.setCode===id).card,setCode:id});
    let seed=87000;for(const scenario of scenarios){const {records,witness}=await fixture(env,pool,scenario,seed++);assert.equal(records.at(-1).type,'result');assert.deepEqual(witness.coverageObligationIds,scenario.coverageObligationIds);assert.ok(witness.played);}
});


test('upgrade-return construction rejects unproved type and unmodeled owner domains',()=>{
    const entry=id=>structuredClone(catalogue.cards.find(c=>c.setCode===id));
    const mixed=entry('SHD_209');mixed.abilities.card[0].targetResolver.type='any';
    assert.equal(classifyUpgradeReturn(mixed),null,'Non-unique any-card selectors include units');
    const enemyDiscard=entry('SHD_044');enemyDiscard.abilities.card[0].targetResolver.owner='any';
    assert.equal(classifyUpgradeReturn(enemyDiscard),null,'This discard constructor witnesses only own inventory');
    const ownArena=entry('SEC_200');ownArena.abilities.card[0].targetResolver.owner='self';
    assert.equal(classifyUpgradeReturn(ownArena),null,'Mixed-controller arena constructor needs any owner');
});
