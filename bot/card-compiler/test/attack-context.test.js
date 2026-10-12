'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const{compileSource,loadEnums}=require('../compiler');
const root=path.resolve(__dirname,'../../../forceteki/server'),enums=loadEnums(root);
function compile(predicate,field='matchTarget') {
    return compileSource(`export default class FreshAttack extends NonLeaderUnitCard {
        getImplementationId(){return{id:'fresh-attack',internalName:'fresh-attack'};}
        setupCardAbilities(registrar,AbilityHelper){registrar.addConstantAbility({${field}:${field==='matchTarget'?'(unit,ctx)':'ctx'}=>${predicate},ongoingEffect:AbilityHelper.ongoingEffects.modifyStats({power:-1,hp:0})});}
    }`,'fresh-attack.ts',enums);
}
function positive(text,field){const c=compile(text,field);assert.equal(c.status,'supported',JSON.stringify(c.diagnostics));return c.abilities.card[0];}
function negative(text,field){assert.equal(compile(text,field).status,'unsupported',text);}
test('attack boolean queries preserve explicit source, outer target and candidate receivers',()=>{
    const own=positive('ctx.source.isDefending()','condition');
    assert.deepEqual(own.condition,{kind:'query',name:'isDefending',receiver:{kind:'ref',path:['source']},args:[]});
    const candidate=positive('unit.isUnit()&&unit.isAttacking()');
    assert.deepEqual(candidate.targetResolver.predicate.right,{kind:'query',name:'isAttacking',receiver:{kind:'ref',path:['card']},args:[]});
    assert.deepEqual(positive('ctx.target.isDefending()','condition').condition.receiver,{kind:'ref',path:['target']});
    for(const text of ['unit.isAttacking(true)','unit.isDefending(ctx.source)','unit.isDefending({unknown:true})','unit?.isDefending()','unit.isDefending?.()','ctx.player.isAttacking()','unit.controller.isDefending()','unit.activeAttack.isDefending()']) negative(text);
});
test('active attacker identity requires same-candidate positive dominating defender guard',()=>{
    const a=positive('unit.isUnit()&&unit.isInPlay()&&unit.isDefending()&&unit.activeAttack.attacker===ctx.source');
    assert.deepEqual(a.targetResolver.predicate.right.left,{kind:'ref',path:['card','activeAttack','attacker']});
    assert.deepEqual(a.targetResolver.predicate.right.right,{kind:'ref',path:['source']});
    for(const text of ['unit.activeAttack.attacker===ctx.source','unit.activeAttack.attacker===ctx.source&&unit.isDefending()','!unit.isDefending()&&unit.activeAttack.attacker===ctx.source','unit.isDefending()||unit.activeAttack.attacker===ctx.source','(unit.isDefending()||ctx.source.isDefending())&&unit.activeAttack.attacker===ctx.source','ctx.source.isDefending()&&unit.activeAttack.attacker===ctx.source','unit.isDefending()&&unit.activeAttack?.attacker===ctx.source','unit.isDefending()&&unit.activeAttack.attacker.controller===ctx.player','unit.isDefending()&&unit.activeAttack.isAmbush','unit.isDefending()&&ctx.source.activeAttack.attacker===ctx.source','unit.isDefending()&&unit.activeAttack.getAllTargets().includes(ctx.source)','unit.isDefending()&&unit.activeAttack.targetIsUnit(c=>c.damage>0)']) negative(text);
    // A nested callback's unit candidate is a different binding. The outer
    // defender guard cannot authorize reading the inner unit's active attack.
    negative('unit.isDefending()&&ctx.player.hasSomeArenaUnit({condition:inner=>inner.activeAttack.attacker===ctx.source})');
});
test('nine complete actual sources compile and all fifteen deferred sources reject',()=>{
    const cases=[["game/cards/08_ASH/leaders/GroguCharmingCompanion.ts", false], ["game/cards/08_ASH/units/ScionShuttleAtMorgansBidding.ts", true], ["game/cards/08_ASH/units/PalaceChefDroid.ts", true], ["game/cards/08_ASH/units/HeroicPurrgil.ts", false], ["game/cards/08_ASH/units/MarroksFiendFighterFormidablePursuer.ts", false], ["game/cards/09_HMW/units/BatcherLoyalHound.ts", true], ["game/cards/09_HMW/units/AwakenedExogorth.ts", true], ["game/cards/09_HMW/units/BlockadeShip.ts", true], ["game/cards/04_JTL/units/GoldLeaderFastestShipInTheFleet.ts", false], ["game/cards/04_JTL/units/RetrofittedAirspeeder.ts", false], ["game/cards/07_LAW/units/LandoCalrissianEyesOpen.ts", false], ["game/cards/05_LOF/units/JediGuardian.ts", true], ["game/cards/06_SEC/units/CassianAndorLayLow.ts", false], ["game/cards/06_SEC/units/MirajScintelTheWeakDeserveToKneel.ts", false], ["game/cards/06_SEC/units/VelSarthaOnePathOneChoice.ts", true], ["game/cards/02_SHD/leaders/MoffGideonFormidableCommander.ts", false], ["game/cards/02_SHD/units/ConcordDawnInterceptors.ts", true], ["game/cards/02_SHD/units/JangoFettRenownedBountyHunter.ts", false], ["game/cards/02_SHD/units/EnfysNestMarauder.ts", false], ["game/cards/01_SOR/leaders/JynErsoResistingOppression.ts", false], ["game/cards/01_SOR/upgrades/Electrostaff.ts", false], ["game/cards/01_SOR/units/FirstLegionSnowtrooper.ts", false], ["game/cards/01_SOR/units/StrafingGunship.ts", false], ["game/cards/03_TWI/units/CloneDiveTrooper.ts", true]];
    for(const [file,supported]of cases){const c=compileSource(fs.readFileSync(path.join(root,file),'utf8'),file,enums);assert.equal(c.status,supported?'supported':'unsupported',file+JSON.stringify(c.diagnostics));}
});
