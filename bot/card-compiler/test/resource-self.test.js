'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {compileSource}=require('../compiler');
const compile=(props,resolver=false)=>compileSource(`export default class ResourceUnit extends NonLeaderUnitCard {getImplementationId(){return{id:'resource-unit',internalName:'resource-unit'};}setupCardAbilities(registrar,AbilityHelper){registrar.addWhenPlayedAbility({title:'Resource',${resolver?`targetResolver:{cardTypeFilter:'unit',immediateEffect:AbilityHelper.immediateEffects.resourceCard(${props})}`:`immediateEffect:AbilityHelper.immediateEffects.resourceCard(${props})`}});}}`,'resource-unit.ts');
test('resourceCard preserves target overrides and rejects unrepresented helper properties',()=>{
 assert.deepEqual(compile('').abilities.card[0].effect,{kind:'resourceCard',target:'self'});assert.deepEqual(compile('',true).abilities.card[0].effect,{kind:'resourceCard',target:'chosen'});
 for(const props of ['{readyResource:true}','{targetPlayer:context=>context.player}','{amount:1}','{isCost:false}','{unknown:true}','{},{}'])assert.equal(compile(props).status,'unsupported',props);
});
test('all three actual resource-self sources preserve complete programs',()=>{
 const fs=require('node:fs'),path=require('node:path'),{loadEnums}=require('../compiler');const root=path.resolve(__dirname,'../../../forceteki/server'),enums=loadEnums(root);let found=0;
 for(const relative of fs.readdirSync(path.join(root,'game/cards'),{recursive:true}).filter(f=>f.endsWith('.ts'))) {const file=path.join(root,'game/cards',relative),source=fs.readFileSync(file,'utf8');if(!['expendable-mercenary','eeth-koth#spiritual-warrior','resupply'].some(n=>source.includes(`'${n}'`)))continue;const c=compileSource(source,file,enums);assert.equal(c.status,'supported',file);assert.ok(JSON.stringify(c.abilities).includes('resourceCard'));found++;}assert.equal(found,3);
});
