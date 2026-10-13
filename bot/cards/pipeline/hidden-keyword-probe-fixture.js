'use strict';
const assert=require('node:assert/strict');
const {constructProbeFixture}=require('./probe-fixture');
const {fullState,canonicalAction,expandActions}=require('../../omni/rs/state');
const snapshot=(c,eg)=>({id:eg.cardId(c.uuid),zone:c.zoneName,inPlayId:c.isInPlay()?c.inPlayId:null,hidden:c.isInPlay()&&c.hasSomeKeyword('hidden'),qualified:c.isInPlay()&&c.wasPlayedDeployedOrCreatedThisPhase(),power:c.isInPlay()?c.getPower():null,hp:c.isInPlay()?c.getHp():null,damage:c.isInPlay()?c.damage:null});
async function fixture(env,pool,scenario,seed){
 const p=scenario.probe;assert.equal(p.family,'hidden-keyword-only');assert.notEqual(p.kind,'query','Query fixture not yet constructed');
 const {eg,rng,bot,deck,own,enemy,source,activation,targets}=await constructProbeFixture(env,pool,scenario,seed);
 own.base.damage=p.ownBaseDamage??0;eg.game.resolveGameState(true);eg.game.continue();
 const initialRound=eg.round,witness={coverageObligationIds:[],observations:[],focusEvents:[],defeatedIds:[]},records=[{type:'meta',schema:'omni-rs-trace-v1',pool:pool.provenance,seed,bots:['hidden-probe','hidden-probe'],decks:[deck,{...deck,base:{id:p.enemyBaseCode??deck.base.id,count:1}}],scenario:scenario.name,fixtureConstruction:'At first natural action window stage disclosed real units, attachments and resources; focus is actually played or deliberately staged without a play receipt. All subsequent operations are normal recorded inputs, including actual phase advancement.',constructionParameters:p}];
 let started=false,played=!!p.staged,currentObserved=false,expiredObserved=false,settled=false,bodyStarted=false,bodyDeclared=false,step=0;
 const needsBody=p.activateReturn||p.activateDeath||p.activateResources||p.activateAura||p.activateSaboteur||p.activateRaid||p.activateCombat||p.activateAmbush;
 const declaredShields=targets[0].isInPlay()?(targets[0].upgrades??[]).filter(c=>c.isShield()).map(c=>eg.cardId(c.uuid)):[];
 eg.game.on('onCardPlayed',e=>{if(started&&!settled&&e.card===source&&!e.isCancelledOrReplaced)played=true;});
 for(const name of ['onUpgradeAttached','onCardDefeated','onCardReadied','onDamageDealt','onCardMoved'])eg.game.on(name,e=>{if(!settled&&!e.isCancelledOrReplaced){if(name==='onCardDefeated')witness.defeatedIds.push(eg.cardId(e.card.uuid));if(e.context?.source===source)witness.focusEvents.push({name,card:e.card?eg.cardId(e.card.uuid):null,upgrade:e.upgradeCard?eg.cardId(e.upgradeCard.uuid):null,amount:e.damageDealt??e.amount??null});}});
 eg.game.on('onAttackDeclared',e=>{if(bodyStarted&&!settled){bodyDeclared=true;witness.observations.push({stage:'body-declaration',source:snapshot(source,eg),targets:targets.map(c=>snapshot(c,eg)),ownUnits:own.getArenaUnits().length,exhaustedResources:own.getCardsInZone('resource').filter(c=>c.exhausted).length,baseDamage:own.base.damage,enemyBaseDamage:enemy.base.damage});}});
 eg.game.on('onAttackDamageResolved:preResolve',()=>{if(bodyDeclared&&!settled)witness.observations.push({stage:'before-body-damage',source:snapshot(source,eg),targets:targets.map(c=>snapshot(c,eg))});});
 function assertBody(){
  const before=witness.observations.find(o=>o.stage==='body-declaration');
  if(p.activateDeath){assert.equal(source.zoneName,'discard');assert.equal(targets[0].exhausted,true,'Printed death exhausts selected enemy');}
  if(p.activateReturn){assert.ok(bodyDeclared);assert.equal(source.zoneName,'hand');const delta=own.base.damage-before.baseDamage;assert.equal(delta,targets[0].hasSomeKeyword('overwhelm')?before.targets[0].power:0,'Departed defender leaves captured Overwhelm recipient');}
  if(p.activateAura){assert.equal(before.targets[0].power,Math.max(0,targets[0].cardData.power-3),'Printed attack aura changes actual defender power by signed constant');const combat=witness.observations.find(o=>o.stage==='before-body-damage');assert.ok(combat);assert.equal(combat.targets[0].power,before.targets[0].power,'Live attack aura is already active at declaration capture');}
  if(p.activateResources){assert.ok(bodyDeclared);assert.equal(own.getCardsInZone('resource').filter(c=>c.exhausted).length,Math.max(0,before.exhaustedResources-before.ownUnits),'Live friendly arena count readies actual own resources');}
  if(p.activateAmbush){assert.equal(source.wasPlayedDeployedOrCreatedThisPhase(),true,'Actual Ambush follows actual same-phase focus play');assert.equal(source.hasSomeKeyword('hidden'),true,'Ambush does not remove Hidden');}
  if(p.activateCombat){assert.ok(bodyDeclared);const power=source.cardData.power+(p.keywordValues.raid??0)+(p.keywordValues.grit?before.source.damage:0);assert.equal(before.source.power,power,'All printed attack power keywords are live');if(p.keywordValues.restore)assert.equal(own.base.damage,Math.max(0,before.baseDamage-p.keywordValues.restore),'Printed Restore heals actual own base');if(p.keywordValues.overwhelm)assert.equal(enemy.base.damage-before.enemyBaseDamage,Math.max(0,power-(before.targets[0].hp-before.targets[0].damage)),'Printed Overwhelm deals exact excess to defending base');}
  if(p.activateRaid){assert.equal(before.source.power,source.cardData.power+p.raidAmount,'Printed Raid applies actual attack power');}
  if(p.activateSaboteur){assert.equal(declaredShields.length,2);for(const id of declaredShields)assert.ok(witness.defeatedIds.includes(id),'Focus Saboteur defeats each disclosed Shield identity');}
 }
 try{while(!eg.over&&step<4000){
  const pid=eg.ids.find(id=>eg.legalActions(id).length);assert.ok(pid);const actions=expandActions(eg,eg.legalActions(pid)),window=eg.isActionWindow(pid),prompt=eg.player(pid).currentPrompt();let chosen;
  if(window){records.push({type:'state',step,state:fullState(eg,pid)});
   if(played&&source.isInPlay()&&!currentObserved&&p.kind==='initiative')assert.equal(source.getPower(),source.cardData.power+(own.hasInitiative()?2:0),'Printed initiative power uses actual initiative owner');
   if(expiredObserved&&!needsBody&&!settled){if(p.kind==='shield'&&!p.staged)assert.equal((targets[1].upgrades??[]).filter(c=>c.isShield()).length,1,'Actual When Played Shield attaches to other friendly unit');settled=true;}
   if(p.activateResources&&bodyStarted&&!bodyDeclared&&pid===own.id&&activation.zoneName==='discard'){chosen=actions.find(a=>a.cardUuid===source.uuid);assert.ok(chosen,'Source attacks after actual paid event');}
   if(!settled&&bodyStarted&&(p.activateDeath?source.zoneName==='discard'&&targets[0].isInPlay()&&targets[0].exhausted:bodyDeclared)&&!eg.game.currentAttack){assertBody();settled=true;}
   if(!settled&&!played&&pid===own.id){chosen=actions.find(a=>a.cardUuid===source.uuid);assert.ok(chosen,'Actual source play');started=true;}
   if(!settled&&played&&pid===enemy.id&&(!currentObserved||eg.round>initialRound&&!expiredObserved))chosen=actions.find(a=>a.cardUuid===targets[0].uuid);
   if(!settled&&expiredObserved&&needsBody&&!bodyStarted){
    if(pid===(p.activateReturn?enemy.id:own.id)){chosen=actions.find(a=>a.cardUuid===(p.activateReturn?targets[0]:p.activateDeath||p.activateResources?activation:source).uuid);assert.ok(chosen,'Actual source-body activation');bodyStarted=true;}
   }
   if(!settled&&!chosen){
    // A real quiet hand play yields the turn without marking a needed actor out.
    const needActor=!played?own.id:expiredObserved&&needsBody&&!bodyStarted?(p.activateReturn?enemy.id:own.id):null;
    if(needActor&&pid!==needActor)chosen=actions.find(a=>a.kind==='card'&&eg.player(pid).getCardsInZone('hand').some(c=>c.uuid===a.cardUuid&&!c.cardData.text));
    chosen??=actions.find(a=>a.arg==='pass');
   }
  }else if(!settled){
   if(p.activateAmbush&&played&&!bodyStarted&&pid===own.id){chosen=actions.find(a=>a.kind==='button'&&/trigger|resolve/i.test(a.label??''));if(chosen)bodyStarted=true;}
   if(played&&pid===enemy.id&&/target for attack/i.test(prompt.menuTitle??'')&&!bodyStarted){
    const current=eg.round===initialRound,offered=actions.some(a=>a.cardUuid===source.uuid);if(current&&p.keywordValues.shielded&&!p.staged)assert.equal(source.upgrades.filter(c=>c.isShield()).length,1,'Actual played Shielded generates and attaches one real Shield');assert.equal(offered,!!p.staged||!current,'Actual play receipt protects only current phase; Saboteur does not bypass Hidden');
    witness.observations.push({stage:current?'current-phase-targets':'expired-targets',actor:eg.seatOf(pid),source:snapshot(source,eg),actions:actions.map(a=>canonicalAction(eg,a)),state:fullState(eg,pid)});chosen=actions.find(a=>a.arg==='cancel');assert.ok(chosen);if(current)currentObserved=true;else expiredObserved=true;
   }else if(bodyStarted&&actions.some(a=>a.kind==='card')){chosen=actions.find(a=>a.cardUuid===(p.activateDeath?(source.isInPlay()?source:targets[0]):p.activateReturn?source:targets[0]).uuid);}
   else if(p.kind==='shield'&&pid===own.id&&actions.some(a=>a.cardUuid===targets[1].uuid)){assert.ok(!actions.some(a=>a.cardUuid===source.uuid));assert.ok(!actions.some(a=>a.cardUuid===targets[0].uuid));chosen=actions.find(a=>a.cardUuid===targets[1].uuid);}
   if(p.keywordValues.ambush&&!p.activateAmbush&&pid===own.id&&!bodyStarted)chosen??=actions.find(a=>['passAbility','pass'].includes(a.arg)||a.label==='Pass');
   chosen??=actions.find(a=>a.kind==='button'&&/trigger|resolve|play|yes/i.test(a.label??''));chosen??=actions.find(a=>a.arg==='done');
  }
  chosen??=bot.choose({game:eg,pid,actions,rng});assert.ok(chosen);records.push({type:'decision',step,actor:eg.seatOf(pid),prompt:{type:prompt.promptType??null,title:prompt.menuTitle??null,selected:(eg.player(pid).promptState.selectedCards??[]).map(c=>eg.cardId(c.uuid)),actionWindow:window},actions:actions.map(a=>canonicalAction(eg,a)),chosen:canonicalAction(eg,chosen).key,events:[]});eg.apply(pid,chosen,rng);step++;
 }
 assert.ok(p.activateAmbush||currentObserved&&expiredObserved,'Both current and expired legal menus witnessed');assert.ok(settled,'Focused source behavior settled');assert.ok(eg.over,'Full oracle terminal result');records.push({type:'result',step,winner:eg.winner,state:fullState(eg)});witness.coverageObligationIds=[...scenario.coverageObligationIds];return {records,witness};
 }finally{bot.close?.();}
}
module.exports={fixture,dependencies:['bot/cards/pipeline/hidden-keyword-probes.js','bot/cards/pipeline/hidden-keyword-probe-fixture.js','bot/cards/pipeline/probe-fixture.js','bot/env.js','bot/omni/rs/state.js','bot/players/index.js']};
