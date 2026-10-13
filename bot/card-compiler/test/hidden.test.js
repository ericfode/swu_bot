'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {compileSource,loadEnums}=require('../compiler');
const {compileCatalog,keywordValues}=require('../build');
const enums=loadEnums(path.resolve(__dirname,'../../../forceteki/server'));
test('Hidden intrinsic extraction requires printed own-line keyword',()=>{
 for(const text of ['Hidden','Hidden\nOther text','Hidden\r\nOther text'])assert.deepEqual(keywordValues({keywords:['hidden'],types:['unit'],text}),{hidden:1});
 for(const text of ['Choose a unit with Hidden.','This unit gains Hidden.'])assert.deepEqual(keywordValues({keywords:['hidden'],types:['event'],text}),{});
});
test('Hidden modifier lowering preserves boolean shape and rejects numeric variants',()=>{
 const body=amount=>'export default class NewCard extends NonLeaderUnitCard {getImplementationId(){return {id:"hidden-test",internalName:"hidden-test"};} setupCardAbilities(registrar,AbilityHelper){registrar.addConstantAbility({title:"Hidden",ongoingEffect:AbilityHelper.ongoingEffects.gainKeyword('+amount+')});}}';
 const c=compileSource(body('KeywordName.Hidden'),'hidden.ts',enums);assert.equal(c.status,'supported',JSON.stringify(c.diagnostics));assert.equal(c.abilities.card[0].effect.keyword,'hidden');assert.deepEqual(c.abilities.card[0].effect.amount,{kind:'const',value:1});
 const bad=compileSource(body('{keyword:KeywordName.Hidden,amount:2}'),'hidden.ts',enums);assert.equal(bad.status,'unsupported');
});
test('actual Hidden modifier cards compile completely and query event stays nonintrinsic',()=>{
 const catalog=compileCatalog();const cards=new Map(catalog.cards.map(c=>[c.setCode,c]));
 for(const code of ['ASH_177','HMW_162','HMW_176','LOF_132','LOF_209','SEC_203'])assert.equal(cards.get(code).status,'supported',code);
 assert.equal(cards.get('LOF_241').keywordValues.hidden,undefined);
 assert.equal(cards.get('ASH_177').keywordValues.hidden,1);
});
