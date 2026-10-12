'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {classifyOnDefense,planOnDefenseProbes}=require('../pipeline/on-defense-probes');
const catalogue=require('../../card-compiler/generated/catalog.json'),ids=['LOF_047','SHD_035','SOR_196','TS26_024','TWI_049','TWI_083'];
const plan=id=>planOnDefenseProbes(catalogue.cards.find(e=>e.setCode===id),{catalogue});
test('complete defense family accepts supported scalar source shapes and rejects unmodeled fields',()=>{
    for(const id of ids){const raw=catalogue.cards.find(e=>e.setCode===id);assert.ok(classifyOnDefense(raw));const e=structuredClone(raw);e.abilities.card[0].ifYouDo={effect:{kind:'draw',target:'ownPlayer',amount:{kind:'const',value:1}}};assert.equal(classifyOnDefense(e),null);}
    for(const id of ['SOR_196','TS26_024','TWI_049','TWI_083','SEC_187']){const e=structuredClone(catalogue.cards.find(e=>e.setCode===id));e.abilities.card[0].optional=true;assert.equal(classifyOnDefense(e),null);}
    const spaceToken=structuredClone(catalogue.cards.find(e=>e.setCode==='TWI_049'));spaceToken.abilities.card[0].effect.tokenType='tieFighter';assert.equal(classifyOnDefense(spaceToken),null);spaceToken.abilities.card[0].effect.tokenType='notAToken';assert.equal(classifyOnDefense(spaceToken),null);
    const missing=structuredClone(catalogue.cards.find(e=>e.setCode==='LOF_047'));delete missing.abilities.card[0].effect;assert.equal(classifyOnDefense(missing),null);missing.abilities.card[0].effect=catalogue.cards.find(e=>e.setCode==='LOF_047').abilities.card[0].effect;missing.abilities.card[0].optional='true';assert.equal(classifyOnDefense(missing),null);
    const e=structuredClone(catalogue.cards.find(e=>e.setCode==='SHD_035'));e.abilities.card[0].targetResolver.predicate={kind:'const',value:true};assert.equal(classifyOnDefense(e),null);
});
test('metadata Hidden remains an explicit whole-card lifecycle gap even when keywordValues is empty',()=>{
    const p=plan('SEC_187');assert.ok(p.uncovered.some(o=>o.id.endsWith(':hidden-lifecycle')));
    assert.deepEqual(catalogue.cards.find(e=>e.setCode==='SEC_187').keywordValues,{});
});
test('defense probes construct owner priorities, real attack keyword donors, lethal capture and cross-arena selectors',()=>{
    for(const id of ids){const p=plan(id);assert.deepEqual(p,plan(id));for(const variant of ['restore-attacker-first','restore-defender-first','saboteur-attacker-first','saboteur-defender-first','onattack-lethal-attacker-first','onattack-lethal-defender-first','actual-ambush'])assert.ok(p.cases.some(c=>c.name.endsWith(variant)),id+':'+variant);}
    assert.ok(plan('SHD_035').cases.some(c=>c.name.endsWith('experience-other-arena-opponent')));
    assert.ok(plan('SOR_196').cases.some(c=>c.name.endsWith('already-ready-restore')));
});
test('actual defense attacks retain full actors/actions/states/results and finite source assertions',async()=>{
    const {Env}=require('../../env'),{loadPool}=require('../../omni/rs/pool'),{fixture}=require('../pipeline/on-defense-probe-fixture');
    const pool=loadPool(require('node:path').resolve(__dirname,'../../card-compiler/generated/runtime-pool.json')),env=new Env(),scenarios=ids.flatMap(id=>plan(id).cases);
    for(const id of new Set(scenarios.flatMap(c=>[...c.focusCardIds,...c.setupCardIds])))if(!pool.cards.some(c=>c.setCode===id))pool.cards.push({...catalogue.cards.find(c=>c.setCode===id).card,setCode:id});
    let seed=89000;for(const scenario of scenarios){const {records,witness}=await fixture(env,pool,scenario,seed++);assert.ok(witness.declared);assert.equal(records.at(-1).type,'result');assert.deepEqual(witness.coverageObligationIds,scenario.coverageObligationIds);for(let i=0;i<records.length;i++)if(records[i].type==='state'){assert.equal(records[i+1].type,'decision');assert.equal(records[i].state.actor,records[i+1].actor);}}
});
