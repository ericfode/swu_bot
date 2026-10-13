'use strict';
const assert=require('node:assert/strict');
const {constructProbeFixture}=require('./probe-fixture');
const {fullState,canonicalAction,expandActions}=require('../../omni/rs/state');
async function fixture(env,pool,scenario,seed){
 const p=scenario.probe,{eg,rng,bot,deck,own,enemy,source,activation,targets}=await constructProbeFixture(env,pool,scenario,seed),round=eg.round;
 const records=[{type:'meta',schema:'omni-rs-trace-v1',pool:pool.provenance,seed,bots:['hidden-source-probe','hidden-source-probe'],decks:[deck,{...deck,base:{id:p.enemyBaseCode??deck.base.id,count:1}}],scenario:scenario.name,fixtureConstruction:'At first natural action window stage disclosed actual cards and resources. Source and hand donors are normally played; all subsequent phase advancement, selectors and attacks are recorded normal inputs.',constructionParameters:p}],witness={coverageObligationIds:[],observations:[],healing:[],damage:[]};
 let started=false,played=false,donorPlayed=!p.donorPlayed&&!p.queryAfterExpiry,donorStarted=false,settled=false,selected=0,actionStarted=false,actionUsed=false,step=0,auraObserved=false,departureStarted=false;
 eg.game.on('onCardPlayed',e=>{if(!settled&&!e.isCancelledOrReplaced){if(started&&e.card===source)played=true;if(donorStarted&&e.card===targets[0])donorPlayed=true;}});
 eg.game.on('onDamageHealed',e=>{if(actionStarted&&!settled)witness.healing.push({card:eg.cardId(e.card.uuid),amount:e.damageHealed});});
 eg.game.on('onDamageDealt',e=>{if(actionStarted&&!settled)witness.damage.push({card:eg.cardId(e.card.uuid),amount:e.damageDealt});});
 const observation=stage=>({stage,source:{id:eg.cardId(source.uuid),hidden:source.isInPlay?.()&&source.hasSomeKeyword('hidden'),qualified:source.isInPlay?.()&&source.wasPlayedDeployedOrCreatedThisPhase()},targets:targets.map(c=>({id:eg.cardId(c.uuid),zone:c.zoneName,hidden:c.isInPlay()&&c.hasSomeKeyword('hidden'),qualified:c.isInPlay()&&c.wasPlayedDeployedOrCreatedThisPhase(),damage:c.isInPlay()?c.damage:null})),state:fullState(eg)});
 try{while(!eg.over&&step<4000){
 const pid=eg.ids.find(id=>eg.legalActions(id).length),actions=expandActions(eg,eg.legalActions(pid)),window=eg.isActionWindow(pid),prompt=eg.player(pid).currentPrompt();let chosen;
 if(window){records.push({type:'state',step,state:fullState(eg,pid)});
  if(!settled&&p.kind==='query'&&played){for(const c of targets.filter(c=>c.controller===own&&c.isInPlay()&&c.hasSomeKeyword('hidden')))assert.equal(c.upgrades.filter(u=>u.isExperience()).length,p.decline||p.queryLimit&&targets.indexOf(c)>=3?0:1);witness.observations.push(observation('query-resolved'));settled=true;}
  if(!settled&&p.kind==='healing'&&actionUsed){assert.equal(targets[0].damage,0,'Requested healing resolves only actual damage');assert.equal(targets[1].damage,p.healDamage,'Continuation damage uses actual healing, not requested amount');assert.equal(source.exhausted,true);witness.observations.push(observation('healing-resolved'));settled=true;}
  if(!settled&&!donorPlayed&&pid===own.id){chosen=actions.find(a=>a.cardUuid===targets[0].uuid);assert.ok(chosen,'Actual donor normal play');donorStarted=true;}
  if(!settled&&donorPlayed&&!started&&pid===own.id&&(!p.queryAfterExpiry||eg.round>round)){chosen=actions.find(a=>a.cardUuid===source.uuid);if(p.noEligible&&!chosen){witness.observations.push(observation('no-eligible-unplayable'));settled=true;}else{assert.ok(chosen,'Actual source play');started=true;}}
  if(!settled&&played&&p.kind==='healing'&&!actionStarted&&pid===own.id&&eg.round>round){chosen=actions.find(a=>a.cardUuid===source.uuid);assert.ok(chosen,'Actual Grogu exhaust action');actionStarted=true;}
  if(!settled&&p.activateAuraDeparture&&auraObserved&&!departureStarted&&pid===own.id){chosen=actions.find(a=>a.cardUuid===activation.uuid);assert.ok(chosen,'Actual source-removal event play');departureStarted=true;}
  if(!settled&&played&&['grant-aura','base-grant'].includes(p.kind)&&pid===enemy.id&&(!p.activateAuraDeparture||!auraObserved||source.zoneName==='discard')){const attacker=targets[p.kind==='grant-aura'?1:0];chosen=actions.find(a=>a.cardUuid===attacker.uuid);assert.ok(chosen,'Actual aura attack attempt');}
  if(!settled&&!chosen){const needOwn=p.activateAuraDeparture&&auraObserved&&!departureStarted||(!donorPlayed||!started)&&!p.queryAfterExpiry||p.kind==='healing'&&played&&eg.round>round&&!actionStarted;if(needOwn&&pid===enemy.id)chosen=actions.find(a=>a.kind==='card'&&enemy.getCardsInZone('hand').some(c=>c.uuid===a.cardUuid&&!c.cardData.text));chosen??=actions.find(a=>a.arg==='pass');}
 }else if(!settled){
  if(p.kind==='query'&&started&&actions.some(a=>a.kind==='card')){
   const eligible=targets.filter(c=>c.controller===own&&c.isInPlay()&&c.hasSomeKeyword('hidden')),expected=(p.queryLimit&&selected>=3?eligible.slice(0,3):eligible).map(c=>eg.cardId(c.uuid)).sort();assert.deepEqual(actions.filter(a=>a.kind==='card').map(a=>eg.cardId(a.cardUuid)).sort(),expected,'Query respects live keyword and owner, independently of qualification');
   if(p.queryAfterExpiry)for(const c of eligible)assert.equal(c.wasPlayedDeployedOrCreatedThisPhase(),false);
   if(p.decline)chosen=actions.find(a=>a.arg==='done');else if(selected<Math.min(3,eligible.length)){chosen=actions.find(a=>a.cardUuid===eligible[selected].uuid);selected++;}else chosen=actions.find(a=>a.arg==='done');
   witness.observations.push({...observation('query-selector'),actor:eg.seatOf(pid),actions:actions.map(a=>canonicalAction(eg,a))});
  }else if(p.activateAuraDeparture&&departureStarted&&source.isInPlay?.()&&actions.some(a=>a.cardUuid===source.uuid)){chosen=actions.find(a=>a.cardUuid===source.uuid);}
  else if(['grant-aura','base-grant'].includes(p.kind)&&played&&pid===enemy.id&&/target for attack/i.test(prompt.menuTitle??'')){
   const recipient=p.kind==='grant-aura'?targets[0]:source,hidden=p.kind==='grant-aura'?source.isInPlay?.():p.baseMatches,qualified=recipient.wasPlayedDeployedOrCreatedThisPhase();assert.equal(recipient.hasSomeKeyword('hidden'),hidden);assert.equal(actions.some(a=>a.cardUuid===recipient.uuid),!hidden||!qualified,'Actual aura respects preserved donor qualification');
   if(p.kind==='grant-aura'&&source.isInPlay?.()){assert.equal(targets[3].hasSomeKeyword('hidden'),false,'Opposing matching donor excluded');if(p.trait)assert.equal(targets[2].hasSomeKeyword('hidden'),false,'Wrong-trait friendly excluded');if(targets[4])assert.equal(targets[4].hasSomeKeyword('hidden'),true,'Matching other-arena friendly gains Hidden');assert.equal(source.hasSomeKeyword('hidden'),!!p.intrinsic,'Aura excludes source');}
   witness.observations.push({...observation('aura-target-menu'),actor:eg.seatOf(pid),actions:actions.map(a=>canonicalAction(eg,a))});chosen=actions.find(a=>a.arg==='cancel');assert.ok(chosen);if(p.activateAuraDeparture&&!auraObserved)auraObserved=true;else {if(p.activateAuraDeparture){assert.equal(recipient.wasPlayedDeployedOrCreatedThisPhase(),true,'Aura departure preserves actual played qualification');assert.equal(recipient.hasSomeKeyword('hidden'),false,'Actual grant-source departure removes live Hidden');}settled=true;}
  }else if(p.kind==='healing'&&actionStarted){
   if(/Choose an ability/.test(prompt.menuTitle??''))chosen=actions.find(a=>/Heal up to/.test(a.label??''));
   else if(actions.some(a=>a.kind==='distribute')){chosen=actions.find(a=>p.healDamage===0?(a.split??[]).length===0:(a.split??[]).length===1&&a.split[0].id===targets[0].uuid&&a.split[0].amount===2);assert.ok(chosen,'Actual requested healing allocation');actionUsed=true;}
   else if(actions.some(a=>a.kind==='card')){chosen=actions.find(a=>a.cardUuid===targets[1].uuid);assert.ok(chosen,'Actual continuation target');}
  }
  chosen??=actions.find(a=>a.kind==='button'&&/trigger|resolve|play|yes/i.test(a.label??''));chosen??=actions.find(a=>a.arg==='done');
 }
 chosen??=bot.choose({game:eg,pid,actions,rng});assert.ok(chosen);records.push({type:'decision',step,actor:eg.seatOf(pid),prompt:{type:prompt.promptType??null,title:prompt.menuTitle??null,selected:(eg.player(pid).promptState.selectedCards??[]).map(c=>eg.cardId(c.uuid)),actionWindow:window},actions:actions.map(a=>canonicalAction(eg,a)),chosen:canonicalAction(eg,chosen).key,events:[]});eg.apply(pid,chosen,rng);step++;
 }
 assert.ok(settled,'Actual full source witness settled');assert.ok(eg.over);records.push({type:'result',step,winner:eg.winner,state:fullState(eg)});witness.coverageObligationIds=[...scenario.coverageObligationIds];return {records,witness};
 }finally{bot.close?.();}
}
module.exports={fixture};
