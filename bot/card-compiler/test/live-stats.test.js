'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {compileSource,loadEnums}=require('../compiler');
const root=path.resolve(__dirname,'../../../forceteki/server'),enums=loadEnums(root);
function compile(modifier,fields='') {
    return compileSource(`export default class FreshDynamic extends NonLeaderUnitCard {
        getImplementationId(){return {id:'fresh-dynamic',internalName:'fresh-dynamic'};}
        setupCardAbilities(registrar,AbilityHelper){registrar.addConstantAbility({${fields}ongoingEffect:AbilityHelper.ongoingEffects.modifyStats(${modifier})});}
    }`,'fresh-dynamic.ts',enums);
}
function supported(modifier,fields=''){const c=compile(modifier,fields);assert.equal(c.status,'supported',JSON.stringify(c.diagnostics));return c.abilities.card[0];}
function rejected(modifier,fields=''){const c=compile(modifier,fields);assert.equal(c.status,'unsupported',modifier);return c;}
test('persistent callback binds affected card independently and keeps live scalar arithmetic',()=>{
    const a=supported('(unit,ctx)=>({power:unit.damage*2+ctx.player.hand.length,hp:unit.controller.resources.length})');
    assert.deepEqual(a.effect.power.left.left,{kind:'ref',path:['modifierTarget','damage']});
    assert.deepEqual(a.effect.power.right,{kind:'ref',path:['player','hand','length']});
    assert.deepEqual(a.effect.hp,{kind:'ref',path:['modifierTarget','controller','resources','length']});
    assert.equal(a.effect.duration,'persistent');
    assert.deepEqual(supported('unit=>({power:-unit.damage,hp:0})').effect.power.value,{kind:'ref',path:['modifierTarget','damage']});
    assert.deepEqual(supported('{power:1,hp:-1}').effect.power,{kind:'const',value:1});
});
test('resource pair expression lowers only exact floor of total resources divided by two',()=>{
    for(const [text,receiver]of [['unit.controller',['modifierTarget','controller']],['ctx.player',['player']],['ctx.player.opponent',['opponent']]]) {
        const a=supported(`(unit,ctx)=>({power:Math.floor(${text}.resources.length/2),hp:0})`);
        assert.deepEqual(a.effect.power,{kind:'query',name:'resourcePairs',receiver:{kind:'ref',path:receiver},args:[]});
    }
    for(const power of ['Math.floor(unit.damage/2)','Math.floor(unit.controller.resources.length/3)','Math.floor(unit.controller.resources.length/0)','Math.floor(unit.controller.resources.length)','Math.ceil(unit.controller.resources.length/2)','unit.controller.resources.length/2','Math.floor(unit.controller.resources.length/2,3)']) rejected(`unit=>({power:${power},hp:0})`);
});
test('nested arena predicate keeps candidate, source and modifier target distinct',()=>{
    const a=supported(`(unit,ctx)=>({power:unit.controller.getArenaUnits({otherThan:unit,condition:card=>card.zone.name===ZoneName.SpaceArena&&card.damage>0}).length,hp:ctx.player.getArenaUnits({otherThan:ctx.source,trait:Trait.Ewok}).length})`);
    assert.deepEqual(a.effect.power.receiver,{kind:'ref',path:['modifierTarget','controller']});
    const refs=[];const visit=v=>{if(!v||typeof v!=='object')return;if(v.kind==='ref')refs.push(v.path.join('.'));Object.values(v).forEach(visit);};visit(a);
    assert.ok(refs.includes('card.zoneName'));assert.ok(refs.includes('modifierTarget'));assert.ok(refs.includes('source'));
    const token=supported('(_,ctx)=>({power:ctx.player.getArenaUnits({condition:card=>card.isTokenUnit()&&!card.exhausted}).length,hp:0})');
    assert.equal(token.effect.power.args[0].right.left.name,'isTokenUnit');
    for(const condition of ['card.name===unit.name','card.damage>unit.damage','card.getPower()===0','card.hp>1','card.hasSomeKeyword(KeywordName.Sentinel)','ctx.target===card']) rejected(`(unit,ctx)=>({power:ctx.player.getArenaUnits({condition:card=>${condition}}).length,hp:0})`);
});
test('live grammar rejects hidden fields, captures, cycles, mutations and unsupported counts',()=>{
    for(const modifier of ['unit=>({power:unit.damage,hp:0,unknown:true})','unit=>({power:unit.damage,hp:0,effect:"hidden"})','unit=>({power:unit.damage})','unit=>({power:()=>unit.damage,hp:0})','unit=>({power:unit.power,hp:0})','unit=>({power:unit.upgrades.length,hp:0})','unit=>({power:unit.controller.base.upgrades.length,hp:0})','unit=>({power:unit.controller.discardZone.cards.filter(c=>c.isUnit()).length,hp:0})','(unit,ctx)=>({power:ctx.target.damage,hp:0})','(unit,ctx)=>({power:ctx.events[0].totalDistributed,hp:0})','unit=>{unit.damage=2;return {power:unit.damage,hp:0};}','unit=>({power:unit.damage*1000,hp:0})']) rejected(modifier);
    rejected('unit=>({power:unit.damage,hp:0})','condition:ctx=>ctx.source.getPower()>0,');
    rejected('unit=>({power:unit.damage,hp:0})','matchTarget:card=>card.remainingHp>0,');
    const phase=compileSource(`export default class Phase extends NonLeaderUnitCard{getImplementationId(){return{id:'phase',internalName:'phase'};}setupCardAbilities(registrar,AbilityHelper){registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.forThisPhaseCardEffect({effect:AbilityHelper.ongoingEffects.modifyStats(unit=>({power:unit.damage,hp:0}))})});}}`,'phase.ts',enums);
    assert.equal(phase.status,'unsupported');
});
test('nine complete actual sources compile while deferred modifier families stay rejected',()=>{
    const files=['09_HMW/units/WroshyrRebel.ts','09_HMW/units/ChiefChirpaDefiantElder.ts','04_JTL/units/DQarCargoFrigate.ts','04_JTL/units/CloneCombatSquadron.ts','05_LOF/units/PazVizslaUnyieldingWarrior.ts','06_SEC/leaders/GovernorPryceTyrantOfLothal.ts','06_SEC/units/KinoLoyYouAnswerToMe.ts','01_SOR/units/97thLegionKeepingThePeaceOnSullust.ts','07_TS26/units/GeneralGrievousCrushThem.ts'];
    for(const file of files){const source=path.join(root,'game/cards',file);const c=compileSource(fs.readFileSync(source,'utf8'),source,enums);assert.equal(c.status,'supported',file+JSON.stringify(c.diagnostics));}
    for(const file of ['08_ASH/units/KelleranBeqWhereAreTheOthers.ts','09_HMW/units/CarrionSpikeHarbingerOfTyranny.ts','04_JTL/units/SwarmingVultureDroid.ts','05_LOF/units/AxeWovesAccomplishedWarrior.ts','05_LOF/units/CaptainEnochCaptainOfTheGuard.ts']){const source=path.join(root,'game/cards',file);assert.equal(compileSource(fs.readFileSync(source,'utf8'),source,enums).status,'unsupported',file);}
});
