'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {planCostProbes,classifyCostShape}=require('../pipeline/cost-probes');
const catalogue=JSON.parse(fs.readFileSync(process.env.SWU_COST_PROBE_CATALOGUE??path.resolve(__dirname,'../../card-compiler/generated/catalog.json'),'utf8'));
const ids=['HMW_154','HMW_249','SEC_154','TS26_079'];
const plan=id=>planCostProbes(catalogue.cards.find(c=>c.setCode===id),{catalogue});
test('generic cost planners preserve card identity independence and finite uncovered boundaries',()=>{
    for(const id of ids){assert.ok(classifyCostShape(catalogue.cards.find(c=>c.setCode===id)),'Expected committed cost-query family '+id);const p=plan(id);assert.ok(p.cases.length>=7);assert.ok(p.cases.every(c=>c.probe.family==='cost-query'));const e=structuredClone(catalogue.cards.find(c=>c.setCode===id));e.setCode='SYN_999';assert.equal(planCostProbes(e,{catalogue}).cases.length,p.cases.length);assert.ok(p.uncovered.some(o=>o.id.endsWith('source-semantics')));}
});
test('cost shape classifiers reject unknown ability resolver and nested expression properties',()=>{
    for(const id of ids){const e=structuredClone(catalogue.cards.find(c=>c.setCode===id));const a=Object.values(e.abilities).flat()[0];if(a)a.unimplemented=true;else e.attachCondition.left.hidden=true;assert.equal(classifyCostShape(e),null);}
    const e=structuredClone(catalogue.cards.find(c=>c.setCode==='SEC_154'));e.abilities.card[0].targetResolver.chooser='opponent';assert.equal(classifyCostShape(e),null);
    const f=structuredClone(catalogue.cards.find(c=>c.setCode==='HMW_249'));f.abilities.card[0].targetResolver.predicate.left.receiver.path=['player'];assert.equal(classifyCostShape(f),null);
});
test('actual engine cost-query experiments execute state changes, exact exclusions, cancellation, real deaths and attachments',{skip:!fs.existsSync(path.resolve(__dirname,'../../../forceteki/build/server/game/core/Game.js'))},async()=>{
    const {Env}=require('../../env'),{loadPool}=require('../../omni/rs/pool'),{fixture}=require('../pipeline/cost-probe-fixture');
    const pool=loadPool(process.env.SWU_COST_PROBE_POOL??path.resolve(__dirname,'../../card-compiler/generated/runtime-pool.json')),env=new Env();
    let total=0;for(const id of ids)for(const scenario of plan(id).cases){const {records,witness}=await fixture(env,pool,scenario,970000+total++);assert.equal(records.at(-1).type,'result');assert.deepEqual(witness.coverageObligationIds,scenario.coverageObligationIds);assert.ok(witness.observations.some(o=>o.stage==='after-resolution'));if(scenario.probe.shape==='attach'&&(scenario.probe.decline||scenario.probe.negativeOnly))assert.equal(witness.played,false,'Later random play cannot rewrite a negative activation receipt');for(let i=0;i<records.length;i++)if(records[i].type==='state')assert.equal(records[i].state.actor,records[i+1].actor);}
});
