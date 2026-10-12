'use strict';
const assert=require('node:assert/strict');
const {constructProbeFixture}=require('./probe-fixture');
const {fullState,canonicalAction,expandActions}=require('../../omni/rs/state');
function observe(c,eg){const active=c.isInPlay?.();return {id:eg.cardId(c.uuid),zone:c.zoneName,owner:eg.seatOf(c.owner.id),exhausted:c.isUnit?.()&&active?c.exhausted:null,power:c.isUnit?.()&&active?c.getPower():null,hp:c.isUnit?.()&&active?c.getHp():null,damage:c.isUnit?.()&&active?c.damage:null};}
async function fixture(env,pool,scenario,seed){
    const p=scenario.probe;assert.equal(p.family,'on-defense');
    const {eg,rng,bot,deck,own,enemy,source,targets}=await constructProbeFixture(env,pool,scenario,seed),attacker=targets[p.attackerIndex];
    source.exhausted=!p.readyDefender;own.base.damage=p.terminalBaseBoundary?own.base.cardData.hp-1:p.defendingBaseDamage;enemy.base.damage=p.attackBaseDamage;
    for(let i=0;i<(p.shields??0);i++)eg.game.generateToken(own,'shield').attachTo(source);
    eg.game.resolveGameState(true);eg.game.continue();
    const initial={source:observe(source,eg),attacker:observe(attacker,eg),targets:targets.map(c=>observe(c,eg)),baseDamage:[own.base.damage,enemy.base.damage],shields:(source.upgrades??[]).filter(c=>c.isShield()).map(c=>eg.cardId(c.uuid))};
    const witness={scenario:scenario.name,coverageObligationIds:[],initial,observations:[],declared:false,declined:false,ownerOrderChosen:false,defenseTargetSelected:false,focusEvents:[],combatEvents:[],defeatedIds:[]};
    const records=[{type:'meta',schema:'omni-rs-trace-v1',pool:pool.provenance,seed,bots:['on-defense-probe','on-defense-probe'],decks:[deck,deck],scenario:scenario.name,fixtureConstruction:'At first natural action window stage actual defending focus, metadata-selected ready enemy attacker or real Ambush card in hand, declared extra units, damage/exhaustion/base damage and real Shield tokens. Afterwards only normal recorded inputs. Focus activation is a real opponent attack; optional Ambush uses normal play and trigger inputs.',constructionParameters:p}];
    let initiated=false,targeted=false,settled=false,step=0;const created=[];
    const attackContext=()=>eg.game.currentAttack?{attacker:eg.cardId(eg.game.currentAttack.attacker.uuid),defenders:eg.game.currentAttack.getAllTargets().map(c=>eg.cardId(c.uuid)),activePlayer:eg.seatOf(eg.game.getActivePlayer().id)}:null;
    eg.game.on('onAttackDeclared',e=>{if(initiated&&!settled&&e.attack.attacker===attacker&&e.attack.getAllTargets().includes(source)){witness.declared=true;witness.observations.push({stage:'attack-declared',attack:attackContext(),attacker:observe(attacker,eg),defender:observe(source,eg),activePlayer:eg.seatOf(eg.game.getActivePlayer().id)});}});
    for(const name of ['onTokensCreated','onUpgradeAttached','onCardReadied','onDamageDealt','onCardMoved','onCardDefeated','onCardLeavesPlay'])eg.game.on(name,e=>{
        if(!witness.declared||settled||e.isCancelledOrReplaced)return;
        if(name==='onCardDefeated')witness.defeatedIds.push(eg.cardId(e.card.uuid));
        if(e.context?.source===source){const row={name,card:e.card?eg.cardId(e.card.uuid):null,parent:e.parentCard?eg.cardId(e.parentCard.uuid):null,upgrade:e.upgradeCard?eg.cardId(e.upgradeCard.uuid):null,amount:e.damageDealt??e.amount??null,source:observe(source,eg)};witness.focusEvents.push(row);if(name==='onTokensCreated')for(const token of e.generatedTokens??[])created.push(token);}
        if(name==='onDamageDealt')witness.combatEvents.push({target:eg.cardId(e.card.uuid),amount:e.damageDealt??0,requested:e.amount??null,damageType:e.type,attacker:attacker.isInPlay()?observe(attacker,eg):null,defender:source.isInPlay()?observe(source,eg):null});
    });
    eg.game.on('onAttackDamageResolved:preResolve',e=>{if(witness.declared&&!settled&&e.attack.attacker===attacker)witness.observations.push({stage:'before-combat-damage',attack:attackContext(),attacker:observe(attacker,eg),defender:observe(source,eg),targets:targets.map(c=>observe(c,eg))});});
    const defenseTarget=()=>p.chosenDefenseTarget?targets[p.chosenDefenseTarget.target]:source.isInPlay()?source:attacker;
    function assertAfter(){
        const after={source:observe(source,eg),attacker:observe(attacker,eg),targets:targets.map(c=>observe(c,eg)),baseDamage:[own.base.damage,enemy.base.damage],created:created.map(c=>observe(c,eg)),activeAttack:eg.game.currentAttack?{attacker:eg.cardId(eg.game.currentAttack.attacker.uuid),targets:eg.game.currentAttack.getAllTargets().map(c=>eg.cardId(c.uuid))}:null};
        witness.observations.push({stage:'after-attack',...after});assert.ok(witness.declared,'Actual focus defense must be declared');
        if(p.decline)assert.ok(witness.declined,'Real optional Pass input required');
        if(p.kind==='create-token'){
            assert.equal(created.length,1,'Captured defense creates one token even if source died');assert.equal(created[0].owner,own,'Created token belongs to defender controller');assert.equal(created[0].zoneName,'groundArena','Printed defense token enters ground arena');assert.equal(created[0].exhausted,true,'Printed token enters exhausted');
        }else if(p.kind==='base-damage')assert.equal(witness.focusEvents.filter(e=>e.name==='onDamageDealt'&&e.card===eg.cardId(own.base.uuid)).length,1,'Captured defense damages own base once even after source dies');
        else if(['self-experience','chosen-experience'].includes(p.kind)){
            const expected=!p.decline&&(p.kind==='chosen-experience'||!p.lethalOnAttack||p.defenderFirst);
            assert.equal(created.length,expected?1:0,'Experience effect follows optionality and live self-target eligibility');
            if(expected){
                assert.ok(witness.focusEvents.some(e=>e.name==='onUpgradeAttached'),'Experience attaches before combat');
                if(p.kind==='chosen-experience')assert.ok(witness.defenseTargetSelected,'Actual chosen unit selection');
                const beforeCombat=witness.observations.find(o=>o.stage==='before-combat-damage');
                if(!p.lethalOnAttack&&beforeCombat){
                    const recipient=p.kind==='self-experience'?source:defenseTarget();
                    const observation=recipient===source?beforeCombat.defender:beforeCombat.targets[targets.indexOf(recipient)];
                    const old=recipient===source?initial.source:initial.targets[targets.indexOf(recipient)];
                    assert.equal(observation.hp,old.hp+1,'Experience increases live recipient HP before combat');assert.equal(observation.power,old.power+1,'Experience increases live recipient power before combat');
                    if(recipient===attacker){const dealt=witness.combatEvents.find(e=>e.damageType==='combat'&&e.target===eg.cardId(source.uuid));assert.equal(dealt?.requested,initial.attacker.power+1,'Experience given to attacker changes actual declared combat damage');}
                    if(recipient===source){const retaliation=witness.combatEvents.find(e=>e.damageType==='combat'&&e.target===eg.cardId(attacker.uuid));if(retaliation)assert.equal(retaliation.requested,initial.source.power+1,'Experience changes actual simultaneous retaliation');}
                }
            }
        }else if(p.kind==='ready'){
            if(!p.lethalOnAttack&&source.isInPlay())assert.equal(source.exhausted,false,'Defense readies surviving exhausted focus');
            if(p.lethalOnAttack)assert.equal(source.zoneName,'discard','Attack damage donor actually defeated focus');
        }else if(p.kind==='conditional-return'&&p.sourceArena+'Arena'===p.sourceZone){
            if(p.lethalOnAttack&&!p.defenderFirst)assert.equal(source.zoneName,'discard','Condition rechecks departed source and does not resurrect it');else assert.equal(source.zoneName,'hand','Live matching-arena source returns before combat');
        }
        if(p.shields&&(!p.lethalOnAttack))for(const id of initial.shields)assert.ok(witness.defeatedIds.includes(id),'Actual Saboteur defeats disclosed Shield identity');
        if(p.terminalBaseBoundary)assert.equal(own.base.damage,own.base.cardData.hp,'Own base damage boundary becomes terminal');
    }
    try{while(!eg.over&&step<4000){
        const pid=eg.ids.find(id=>eg.legalActions(id).length);assert.ok(pid,'No actor');const actions=expandActions(eg,eg.legalActions(pid)),atWindow=eg.isActionWindow(pid),prompt=eg.player(pid).currentPrompt();let chosen;
        if(atWindow){records.push({type:'state',step,state:fullState(eg,pid)});if(targeted&&!settled){assertAfter();settled=true;}}
        if(atWindow&&!initiated&&pid===enemy.id){chosen=actions.find(a=>a.cardUuid===attacker.uuid);assert.ok(chosen,'Actual attacking donor is playable/ready');initiated=true;}
        if(atWindow&&!settled)chosen??=actions.find(a=>a.arg==='pass');
        if(!atWindow&&initiated&&!settled){
            if(!targeted){chosen=actions.find(a=>a.cardUuid===source.uuid);if(chosen)targeted=true;else if(p.ambush)chosen=actions.find(a=>a.kind==='button'&&/trigger|resolve|ambush/i.test(a.label??''));}
            else if(/Both players have triggered/.test(prompt.menuTitle??'')){
                assert.equal(pid,enemy.id,'Active attacker owns declaration owner-order choice, not initiative holder');
                const expected=['You','Opponent'];assert.deepEqual(actions.map(a=>a.label),expected,'Exact owner-order labels');assert.deepEqual(actions.map(a=>canonicalAction(eg,a).arg),[0,1],'Exact owner-order arguments');
                chosen=actions.find(a=>a.label===(p.defenderFirst?'Opponent':'You'));witness.ownerOrderChosen=true;witness.observations.push({stage:'owner-order',attack:attackContext(),actor:eg.seatOf(pid),actions:actions.map(a=>canonicalAction(eg,a)),defenderFirst:!!p.defenderFirst,state:fullState(eg,pid)});
            }else if(pid===own.id&&p.decline){chosen=actions.find(a=>['passAbility','pass'].includes(a.arg)||a.arg==='done'&&/nothing/i.test(a.label??''));if(chosen)witness.declined=true;}
            else if(actions.some(a=>a.kind==='card')){
                if(pid===own.id&&p.kind==='chosen-experience'){
                    const expected=[...own.getArenaUnits(),...enemy.getArenaUnits()].map(c=>eg.cardId(c.uuid)).sort(),actual=actions.filter(a=>a.kind==='card').map(a=>eg.cardId(a.cardUuid)).sort();assert.deepEqual(actual,expected,'Chosen defense Experience sees all units across controllers and arenas');chosen=actions.find(a=>a.cardUuid===defenseTarget().uuid);assert.ok(chosen,'Chosen live defense target offered');witness.defenseTargetSelected=true;
                }else if(pid===enemy.id&&p.lethalOnAttack&&source.isInPlay())chosen=actions.find(a=>a.cardUuid===source.uuid);
            }
            chosen??=actions.find(a=>a.kind==='button'&&/trigger|resolve|play|yes/i.test(a.label??''));chosen??=actions.find(a=>a.arg==='done');
        }
        chosen??=bot.choose({game:eg,pid,actions,rng});assert.ok(chosen);
        records.push({type:'decision',step,actor:eg.seatOf(pid),prompt:{type:prompt.promptType??null,title:prompt.menuTitle??null,selected:(eg.player(pid).promptState.selectedCards??[]).map(c=>eg.cardId(c.uuid)),actionWindow:atWindow},actions:actions.map(a=>canonicalAction(eg,a)),chosen:canonicalAction(eg,chosen).key,events:[]});eg.apply(pid,chosen,rng);step++;
    }
    if(!settled&&targeted){assertAfter();settled=true;}assert.ok(eg.over,'Full oracle game must finish');assert.ok(settled,'Actual focused attack resolved');records.push({type:'result',step,winner:eg.winner,state:fullState(eg)});witness.coverageObligationIds=[...scenario.coverageObligationIds];return {records,witness};
    }finally{bot.close?.();}
}
module.exports={fixture,dependencies:['bot/cards/pipeline/on-defense-probes.js','bot/cards/pipeline/on-defense-probe-fixture.js','bot/cards/pipeline/probe-fixture.js','bot/env.js','bot/omni/rs/state.js','bot/players/index.js']};
