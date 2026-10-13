'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const{compileSource,loadEnums}=require('../compiler');
const root=path.resolve(__dirname,'../../../forceteki/server'),enums=loadEnums(root);
function compile(resolvers,extra='') {
    return compileSource(`export default class FreshNamed extends EventCard {
        getImplementationId(){return{id:'fresh-named',internalName:'fresh-named'};}
        setupCardAbilities(registrar,AbilityHelper){registrar.setEventAbility({title:'Named targets',targetResolvers:{${resolvers}},${extra}});}
    }`,'fresh-named.ts',enums);
}
function positive(text,extra){const c=compile(text,extra);assert.equal(c.status,'supported',JSON.stringify(c.diagnostics));return c.abilities.card[0];}
function negative(text,extra){assert.equal(compile(text,extra).status,'unsupported',text+extra);}
const damage=(amount=2)=>`immediateEffect:AbilityHelper.immediateEffects.damage({amount:${amount}})`;
test('named resolver order, chooser, labels and backward identity refs remain structural',()=>{
    const a=positive(`enemy:{choosingPlayer:RelativePlayer.Opponent,controller:RelativePlayer.Opponent,cardTypeFilter:WildcardCardType.Unit,activePromptTitle:'Opponent chooses',${damage(3)}},friendly:{controller:RelativePlayer.Self,cardTypeFilter:WildcardCardType.Unit,dependsOn:'enemy',cardCondition:(card,ctx)=>card!==ctx.targets.enemy,${damage(1)}}`);
    assert.deepEqual(a.effect,{kind:'noAction'});
    assert.deepEqual(a.targetResolvers.map(e=>e.name),['enemy','friendly']);
    assert.equal(a.targetResolvers[0].chooser,'opponent');assert.equal(a.targetResolvers[1].chooser,'self');
    assert.equal(a.targetResolvers[0].targetResolver.promptTitle,'Opponent chooses');
    assert.equal(a.targetResolvers[1].dependsOn,'enemy');
    assert.deepEqual(a.targetResolvers[1].targetResolver.predicate.left,{kind:'ref',path:['card']});
    assert.deepEqual(a.targetResolvers[1].targetResolver.predicate.right,{kind:'ref',path:['namedTargets','enemy']});
    assert.equal(a.targetResolvers[0].effect.target,'chosen');
    assert.equal(a.targetResolvers[1].effect.amount.value,1);
});
test('parent with no child system preserves dependency feasibility and explicit target override',()=>{
    const a=positive(`parent:{cardTypeFilter:WildcardCardType.Unit},child:{dependsOn:'parent',cardTypeFilter:WildcardCardType.Unit,cardCondition:(card,ctx)=>card!==ctx.targets.parent,immediateEffect:AbilityHelper.immediateEffects.damage(ctx=>({amount:2,target:ctx.player.opponent.base}))}`);
    assert.equal(Object.hasOwn(a.targetResolvers[0],'effect'),false);
    assert.equal(a.targetResolvers[1].effect.target,'enemyBase');
    const current=positive(`self:{cardTypeFilter:WildcardCardType.Unit,cardCondition:(card,ctx)=>card===ctx.targets.self,${damage()}}`);
    assert.deepEqual(current.targetResolvers[0].targetResolver.predicate.right,{kind:'ref',path:['namedTargets','self']});
});
test('Exactly one retains array slot and cannot silently read properties or first element',()=>{
    const a=positive(`unit:{mode:TargetMode.Exactly,numCards:1,canChooseNoCards:true,cardTypeFilter:WildcardCardType.Unit,${damage()}}`);
    assert.equal(a.targetResolvers[0].targetResolver.mode,'exactly');
    assert.deepEqual(a.targetResolvers[0].targetResolver.count,{kind:'const',value:1});
    assert.equal(a.targetResolvers[0].targetResolver.optional,true);
    for(const reference of ['ctx.targets.unit.power','ctx.targets.unit[0]','ctx.targets.unit.length']) negative(`unit:{mode:TargetMode.Exactly,numCards:1,cardTypeFilter:WildcardCardType.Unit,immediateEffect:AbilityHelper.immediateEffects.damage(ctx=>({amount:${reference}}))}`);
});
test('lexical named identity survives continuation multiple token leaves without target substitution',()=>{
    const a=positive(`friendlyUnit:{controller:RelativePlayer.Self,cardTypeFilter:WildcardCardType.Unit,immediateEffect:AbilityHelper.immediateEffects.exhaust()}`,`ifYouDo:parent=>({title:'Tokens',immediateEffect:AbilityHelper.immediateEffects.simultaneous([AbilityHelper.immediateEffects.giveExperience({amount:2,target:parent.targets.friendlyUnit}),AbilityHelper.immediateEffects.giveShield({target:parent.targets.friendlyUnit})])})`);
    assert.equal(a.ifYouDo.effect.kind,'simultaneous');
    for(const e of a.ifYouDo.effect.effects)assert.deepEqual(e.target,{kind:'ref',path:['namedTargets','friendlyUnit']});
    assert.equal(a.ifYouDo.effect.effects[0].amount.value,2);
    negative(`unit:{cardTypeFilter:WildcardCardType.Unit,${damage()}}`,`ifYouDo:ctx=>({immediateEffect:AbilityHelper.immediateEffects.damage({amount:ctx.events[0].totalDistributed})})`);
    negative(`unit:{cardTypeFilter:WildcardCardType.Unit,${damage()}}`,`ifYouDo:ctx=>({targetResolver:{cardTypeFilter:WildcardCardType.Unit,immediateEffect:AbilityHelper.immediateEffects.damage({amount:1,target:ctx.targets.unit})}})`);
});
test('named lowering fails closed on unknown fields, names, graph, chooser and unsupported mechanics',()=>{
    for(const field of ['unknown:true','mustChangeGameState:true','condition:ctx=>true','onSelectionSetChanged:()=>true','choosingPlayer:ctx=>ctx.player','controller:ctx=>ctx.player','mode:TargetMode.UpTo,numCards:1','mode:TargetMode.Exactly,numCards:2','numCards:1','optional:1','canChooseNoCards:1','zoneFilter:ZoneName.Hand']) negative(`unit:{cardTypeFilter:WildcardCardType.Unit,${field},${damage()}}`);
    negative(`unit:{cardTypeFilter:WildcardCardType.Unit,${damage()}}`,'immediateEffect:AbilityHelper.immediateEffects.draw({amount:1})');
    negative(`unit:{cardTypeFilter:WildcardCardType.Unit,${damage()}}`,'targetResolver:{immediateEffect:AbilityHelper.immediateEffects.draw({amount:1})}');
    negative(`unit:{cardTypeFilter:WildcardCardType.Unit,${damage()}}`,'cost:AbilityHelper.costs.exhaustSelf()');
    negative(`a:{dependsOn:'b',${damage()}},b:{${damage()}}`);
    negative(`a:{dependsOn:'a',${damage()}}`);
    negative(`a:{${damage()}},b:{dependsOn:'a',${damage()}},c:{dependsOn:'a',${damage()}}`);
    negative(`a:{cardCondition:(card,ctx)=>card!==ctx.targets.b,${damage()}},b:{${damage()}}`);
    negative(`a:{${damage()}},b:{cardCondition:(card,ctx)=>card!==ctx.targets.a,${damage()}}`);
    negative(`a:{${damage()}},b:{${damage()}},c:{${damage()}},d:{${damage()}},e:{${damage()}}`);
    negative(`'01':{${damage()}}`);negative(`constructor:{${damage()}}`);
    negative(`a:{${damage()},immediateEffect:AbilityHelper.immediateEffects.damage({amount:1})}`);
    for(const effect of ['AbilityHelper.immediateEffects.damage({amount:1,source:ctx.source})','AbilityHelper.immediateEffects.payResources({amount:1})','AbilityHelper.immediateEffects.playCard()','AbilityHelper.immediateEffects.giveAdvantage()']) negative(`a:{immediateEffect:${effect}}`);
    negative(`a:{cardCondition:(card,ctx)=>card!==ctx.targets.unknown,${damage()}}`);
    negative(`a:{immediateEffect:AbilityHelper.immediateEffects.damage(ctx=>({amount:ctx.target.power}))}`);
});
test('all seventeen complete pinned card sources convert without dropping named effects',()=>{
const files=["game/cards/09_HMW/units/C-3POCaptivatingStoryteller.ts", "game/cards/09_HMW/units/WreckerWreckingTheEmpire.ts", "game/cards/04_JTL/events/CoordinatedFront.ts", "game/cards/07_LAW/units/BosskJoinOurMerryBand.ts", "game/cards/07_LAW/units/MillenniumFalconDodgingPatrols.ts", "game/cards/07_LAW/units/GovernorsShuttle.ts", "game/cards/07_LAW/units/AerieCloudRiderDropship.ts", "game/cards/05_LOF/events/CalmInTheStorm.ts", "game/cards/01_SOR/units/DeathTrooper.ts", "game/cards/01_SOR/events/AsteroidSanctuary.ts", "game/cards/07_TS26/units/ZitonMojSowingChaos.ts", "game/cards/07_TS26/events/Fervor.ts", "game/cards/07_TS26/events/Mislead.ts", "game/cards/03_TWI/events/UnlimitedPower.ts", "game/cards/03_TWI/events/GrenadeStrike.ts", "game/cards/03_TWI/events/MercilessContest.ts", "game/cards/03_TWI/events/HeroesOnBothSides.ts"];
for(const file of files){const c=compileSource(fs.readFileSync(path.join(root,file),'utf8'),file,enums);assert.equal(c.status,'supported',file+JSON.stringify(c.diagnostics));const a=[...c.abilities.card,...c.abilities.unit,...c.abilities.leader].find(a=>a.targetResolvers);assert.ok(a&&a.targetResolvers.length);assert.deepEqual(a.effect,{kind:'noAction'});assert.ok(a.targetResolvers.every(e=>e.effect));}
});
