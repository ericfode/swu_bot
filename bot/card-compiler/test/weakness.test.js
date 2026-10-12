'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {compileSource,loadEnums}=require('../compiler');const {compileCatalog}=require('../build');const engine=path.resolve(__dirname,'../../../forceteki');const enums=loadEnums(path.join(engine,'server'));
const compile=call=>compileSource(`export default class NewWeakness extends NonLeaderUnitCard {getImplementationId(){return{id:'new-weakness',internalName:'new-weakness'};}setupCardAbilities(registrar,AbilityHelper){registrar.addWhenPlayedAbility({title:'Give Weakness',optional:true,targetResolver:{cardTypeFilter:'unit',immediateEffect:AbilityHelper.immediateEffects.${call}}});}}`,'new-weakness.ts',enums);
test('generic Weakness lowering preserves default amount and explicit target/amount',()=>{
 const card=compile('giveWeakness()');assert.equal(card.status,'supported');assert.deepEqual(card.abilities.card[0].effect,{kind:'giveWeakness',target:'chosen',amount:{kind:'const',value:1}});
 const explicit=compile('giveWeakness({amount:2,target:context=>context.source})');assert.equal(explicit.status,'supported');assert.equal(explicit.abilities.card[0].effect.target,'self');assert.deepEqual(explicit.abilities.card[0].effect.amount,{kind:'const',value:2});
 for(const call of ['giveWeakness({createdBy:"opponent"})','giveWeakness({tokenType:"experience"})','giveWeakness({isCost:true})','giveWeakness({}, {})'])assert.equal(compile(call).status,'unsupported',call);
});
test('complete pinned Weakness sources compile and native token remains separately rejected source',()=>{
 const c=compileCatalog({source:path.join(engine,'server'),cards:path.join(engine,'test/json')});
 for(const code of ['HMW_059','HMW_087','HMW_242']){const card=c.cards.find(c=>c.setCode===code);assert.equal(card.status,'supported',code);assert.equal(card.abilities.card.length,1);assert.equal(card.abilities.card[0].optional,true);}
 const token=c.cards.find(c=>c.setCode==='TOKEN_WEAKNESS');assert.equal(token.status,'unsupported');assert.equal(token.sourceHash,'dd546e4886757d77fffeb8be6e7381144fa7378b6493ce444aa87e4ba1202778');assert.equal(token.card.upgradePower,-1);assert.equal(token.card.upgradeHp,-1);assert.deepEqual(token.card.traits,['condition']);
});
test('actual pinned Weakness helper defaults to one self-created unit token batch',()=>{
 require('../../env'); // Load the normal engine entry point before its circular system imports.
 const system=require(path.join(engine,'build/server/game/gameSystems/GameSystemLibrary.js')).giveWeakness();
 assert.deepEqual(system.defaultProperties,{amount:1,createdBy:'self'});assert.deepEqual(system.targetTypeFilter,['unit']);assert.equal(system.eventName,'onTokensCreated');
});
