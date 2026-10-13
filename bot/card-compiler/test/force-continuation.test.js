'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {compileSource,loadEnums}=require('../compiler');
const root=path.resolve(__dirname,'../../../forceteki/server'),enums=loadEnums(root);
function compile(title){return compileSource(`export default class Inline extends EventCard { getImplementationId(){return{id:'inline',internalName:'inline'};}setupCardAbilities(registrar,AbilityHelper){registrar.setEventAbility({title:'Inline',immediateEffect:AbilityHelper.immediateEffects.selectCard({cardTypeFilter:'unit',activePromptTitle:${title},immediateEffect:AbilityHelper.immediateEffects.damage({amount:2})})});}}`,'inline.ts');}
test('inline literal selection title is retained without changing chosen identity',()=>{const c=compile("'Select a unit to deal 2 damage to'");assert.equal(c.status,'supported');assert.equal(c.abilities.card[0].effect.targetResolver.promptTitle,'Select a unit to deal 2 damage to');assert.equal(c.abilities.card[0].effect.effect.target,'chosen');});
test('inline nonliteral titles do not silently disappear',()=>{for(const title of ['context=>context.source.title','42','context.player.name','`Unit ${context.source.title}`'])assert.equal(compile(title).status,'unsupported');});
test('actual three full sources preserve Force topology and five-pick semantics',()=>{
 for(const [file,kind] of [['units/DarthSidiousThePhantomMenace.ts','useForce'],['events/DrainEssence.ts','simultaneous'],['units/PriestessesOfTheForceEternal.ts','useForce']]){
  const p=path.join(root,'game/cards/05_LOF',file);if(!fs.existsSync(p)){assert.fail('missing pinned source '+file);}const c=compileSource(fs.readFileSync(p,'utf8'),p,enums);assert.equal(c.status,'supported');assert.equal(c.abilities.card[0].effect.kind,kind);
 }
});

test('static pinned TextHelper template titles retain real protocol text',()=>{const c=compile('`A friendly unit gains ${TextHelper.Sentinel} for this phase`');assert.equal(c.status,'supported');assert.equal(c.abilities.card[0].effect.targetResolver.promptTitle,'A friendly unit gains Sentinel for this phase');});
