'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {compileSource}=require('../compiler');
const compile=(effect,resolver=false)=>compileSource(`export default class ForceUnit extends NonLeaderUnitCard {getImplementationId(){return{id:'force-unit',internalName:'force-unit'};}setupCardAbilities(registrar,AbilityHelper){registrar.addWhenPlayedAbility({title:'Force',${resolver?`targetResolver:{cardTypeFilter:'unit',immediateEffect:${effect}}`:`immediateEffect:${effect}`}});}}`,'force-unit.ts');
test('Force defaults own player only when no inherited resolver override exists',()=>{
 for(const helper of ['useTheForce','theForceIsWithYou']){
  const effect=`AbilityHelper.immediateEffects.${helper}()`;let c=compile(effect);assert.equal(c.status,'supported');assert.equal(c.abilities.card[0].effect.target,'ownPlayer');
  for(const nested of [effect,`AbilityHelper.immediateEffects.conditional({condition:context=>true,onTrue:${effect}})`]){c=compile(nested,true);assert.equal(c.status,'unsupported');assert.ok(c.diagnostics.some(d=>d.pattern==='force-inherited-target'));}
  for(const args of ['{target:context=>context.player}','{isCost:true}','{},{}'])assert.equal(compile(`AbilityHelper.immediateEffects.${helper}(${args})`).status,'unsupported');
 }
});
const fs=require('node:fs'),path=require('node:path');const {loadEnums}=require('../compiler');
test('the three pinned source registrations retain use success and gain defaults',()=>{
 const root=path.resolve(__dirname,'../../../forceteki/server'),enums=loadEnums(root);
 function find(dir,fragment){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory()){const hit=find(file,fragment);if(hit)return hit;}else if(e.name.endsWith('.ts')&&fs.readFileSync(file,'utf8').includes(fragment))return file;}}
 for(const [fragment,kind,optional] of [['kiadimundi#we-must-push-on','useForce',true],['vernestra-rwoh#precocious-knight','useForce',true],['youngling-padawan','gainForce',false]]){
  const file=find(path.join(root,'game/cards'),fragment);assert.ok(file,fragment);const c=compileSource(fs.readFileSync(file,'utf8'),file,enums);assert.equal(c.status,'supported');const a=c.abilities.card[0];assert.equal(a.effect.kind,kind);assert.equal(a.effect.target,'ownPlayer');assert.equal(!!a.optional,optional);if(kind==='useForce')assert.ok(a.ifYouDo);
 }
});
