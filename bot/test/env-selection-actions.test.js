'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EnvGame}=require('../env');
const cards=['a','b','c'].map(uuid=>({uuid,internalName:uuid}));
function model({selected=[],limit=2,protectedIds=[],promptName='SelectCardPrompt',otherPlayer=false,nested=true}={}){
 const player={currentPrompt:()=>({buttons:[]}),promptState:{selectableCards:cards,selectedCards:selected.map(i=>cards[i])}};
 const prompt={constructor:{name:promptName},choosingPlayer:otherPlayer?{}:player,selectedCards:selected.map(i=>cards[i]),context:{},properties:{mustSelect:protectedIds.map(i=>cards[i])},cannotUnselectMustSelect:protectedIds.length>0,selector:{hasReachedLimit:(chosen)=>chosen.length>=limit}};
 return {player:()=>player,game:{pipeline:{currentStep:nested?{pipeline:{currentStep:{pipeline:{currentStep:prompt}}}}:prompt}}};
}
const ids=(m)=>EnvGame.prototype.legalActions.call(m,'p1').map(a=>a.cardUuid);
test('UpTo nested prompt permits selected-card toggles and blocks new candidates at cap',()=>{
 assert.deepEqual(ids(model({selected:[0],limit:2})),['a','b','c']);
 assert.deepEqual(ids(model({selected:[1,0],limit:2})),['a','b']);
});
test('protected must-select cards cannot toggle; unrelated or other-player prompts retain prior behavior',()=>{
 assert.deepEqual(ids(model({selected:[0,1],protectedIds:[0]})),['b']);
 assert.deepEqual(ids(model({selected:[0],promptName:'VariableResourcePrompt'})),['b','c']);
 assert.deepEqual(ids(model({selected:[0],otherPlayer:true})),['b','c']);
});
