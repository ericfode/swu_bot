"use strict";
const assert=require("node:assert/strict");
const {constructProbeFixture}=require("./probe-fixture");
const {fullState,expandActions,canonicalAction}=require("../../omni/rs/state");
async function fixture(env,pool,scenario,seed){
 const p=scenario.probe,reverse=p.sourceSeat===2,relative=x=>reverse?x==="self"?"opponent":"self":x;
 assert.equal(p.family,"arena-query");
 const specs=[],add=(code,owner,arena,fields={})=>{const i=specs.length;specs.push({code,owner:relative(owner),...(arena?{arena}:{}),...fields});return i;};
 const v=p.variant,sly=p.mode==="spy-query",ambush=p.mode==="ambush-query";
 let sourceIndex=null,recipientIndex=null,candidateIndex=null,entrantIndex=null,secondEntrantIndex=null,fireIndex=null,smallIndex=null,oldIndex=null;
 if(!sly){sourceIndex=add(p.cardId,"opponent",null,{zone:"hand"});specs[sourceIndex].owner="opponent";}
 if(!sly&&v!=="no-enemy-unit")recipientIndex=add(p.groundCode,"opponent","ground",{exhausted:v==="all-exhausted"});
 if(!sly){
  let code=null,owner="self",arena="space",fields={exhausted:true};
  if(["own-ground-accept","own-ground-only"].includes(v)){code=p.groundCode;arena="ground";}
  else if(["own-space-accept","enemy-ground-target","own-ground-target","space-target","decline","ineffective-self","no-enemy-unit","shield-combat","all-exhausted"].includes(v))code=p.spaceCode;
  else if(v==="enemy-space-only"){code=p.spaceCode;owner="opponent";}
  else if(["own-offboard-only","own-offboard-space"].includes(v)){code=p.spaceCode;arena=null;fields={zone:"hand"};}
  else if(v==="own-unique-only"){code=p.uniqueGroundCode;arena="ground";}
  else if(v==="own-unique-space")code=p.uniqueSpaceCode;
  else if(["own-token","own-space-token"].includes(v)){code=p.spaceTokenCode;fields={token:"tie-fighter",exhausted:true};}
  else if(v==="same-definition"){code=p.cardId;arena=ambush?"ground":"space";}
  if(code)candidateIndex=add(code,owner,arena,fields);
  if(v==="own-ground-target")recipientIndex=add(p.groundCode,"self","ground",{exhausted:false});
  if(v==="space-target")recipientIndex=add(p.spaceCode,"opponent","space",{exhausted:false});
  if(["late-arrival","loss-regain"].includes(v))entrantIndex=add(p.spaceCode,"self",null,{zone:"hand"});
  if(v==="loss-regain"){fireIndex=add(p.fireCode,"self",null,{zone:"hand"});secondEntrantIndex=add(p.spaceCode,"self",null,{zone:"hand"});}
 }
 let count=0;
 if(sly){
  count=v.startsWith("three")||["offboard-exclusions","live-threshold"].includes(v)?3:["four-mixed","token-deployed-count","spy-combat"].includes(v)?4:v==="five-mixed"?5:0;
  for(let i=0;i<count;i++)add(i%2?p.spaceCode:p.groundCode,i%3?"opponent":"self",i%2?"space":"ground",{exhausted:true});
  if(v==="live-threshold")recipientIndex=add(p.groundCode,"self","ground",{exhausted:false});
  if(v==="token-deployed-count"){specs.pop();specs.pop();add(p.spaceTokenCode,"opponent","space",{token:"tie-fighter",exhausted:true});}
  if(v.startsWith("deployed")||v==="self-lethal"){
   recipientIndex=add(p.groundCode,"opponent","ground",{exhausted:true});fireIndex=add(p.fireCode,"self",null,{zone:"hand"});smallIndex=add(p.smallFireCode,"self",null,{zone:"hand"});
  }
 }
 if(v==="shield-combat")specs[recipientIndex].attachments=[{code:p.shieldCode,token:"shield"}];
 const construction={...scenario,probe:{...p,cardId:sly?p.fillerCode:p.cardId,leaderCode:reverse?p.ordinaryLeaderCode:sly?p.cardId:p.ordinaryLeaderCode,enemyLeaderCode:reverse&&sly?p.cardId:p.ordinaryLeaderCode,initiative:relative("self"),targets:specs,
  ...(v==="shield-combat"?{attachments:[{code:p.shieldCode,token:"shield",targetIndex:recipientIndex}]}:{})}};
 const setup=await constructProbeFixture(env,pool,construction,seed),{eg,rng,bot,targets}=setup;
 const own=reverse?setup.enemy:setup.own,enemy=reverse?setup.own:setup.enemy,source=sly?own.getAllDeckLeaders()[0]:reverse?targets[sourceIndex]:setup.source;
 const id=c=>eg.cardId(c.uuid),live=c=>c.isUnit?.()&&c.isInPlay(),recipient=recipientIndex==null?null:targets[recipientIndex];
 const baseline=targets.filter(live).map(c=>({card:c,damage:c.damage,exhausted:c.exhausted,power:c.getPower(),hp:c.getHp()}));
 if(v==="offboard-exclusions"){for(const c of own.resources.slice(0,2))c.exhausted=true;}
 const initial=fullState(eg),initialRound=eg.round,initialSource=id(source),played=new Set(),events=[],payments=[],tasks=[];
 const witness={coverageObligationIds:[],observations:[],events};let settled=false,taskAt=0,step=0,payment=null,attacks=0,selections=0;
 const ready=player=>player.resources.filter(c=>!c.exhausted).length;
 const play=(card,target=null)=>tasks.push({role:"play",player:own,card,target});
 const phase=()=>tasks.push({role:"phase",round:null});
 const attack=(player,card,target,oaTarget=null,decline=false)=>tasks.push({role:"attack",player,card,target,oaTarget,decline,ended:false});
 const deploy=player=>tasks.push({role:"deploy",player,card:player.getAllDeckLeaders()[0]});
 if(!sly){
  play(source);tasks.at(-1).target=v==="ineffective-self"?source:recipient;tasks.at(-1).decline=v==="decline";
  if(entrantIndex!=null){play(targets[entrantIndex]);tasks.at(-1).queryStage="gain";}
  if(v==="loss-regain"){play(targets[fireIndex],targets[entrantIndex]);tasks.at(-1).queryStage="loss";play(targets[secondEntrantIndex]);tasks.at(-1).queryStage="regain";}
 }else{
  if(v==="token-deployed-count"){deploy(enemy);attack(enemy,enemy.getAllDeckLeaders()[0],own.base);}
  if(v==="live-threshold")attack(own,recipient,enemy.base);
  if(v.startsWith("deployed")||v==="self-lethal"){
   deploy(own);
   if(v==="self-lethal")play(targets[fireIndex],source);
   attack(own,source,enemy.base,v==="deployed-enemy"?recipient:source,v==="deployed-decline");
   if(v!=="self-lethal"){play(targets[fireIndex],source);if(v!=="deployed-self")play(targets[smallIndex],source);}
  }else{
   tasks.push({role:"front",player:own,card:source,cancel:v.endsWith("cancel")});
   if(v==="paid-then-epic")deploy(own);
   if(v==="spy-combat"){phase();tasks.push({role:"spy-attack",player:own,ended:false});}
  }
 }
 const records=[{type:"meta",schema:"omni-rs-trace-v1",pool:pool.provenance,seed,bots:["arena-query-probe","arena-query-probe"],decks:setup.decks??[setup.deck,setup.deck],scenario:scenario.name,constructionParameters:p,fixtureConstruction:"Genuine source seats and normal source play/front activation/deployment; disclosed quiet arena donors, real paid effects and complete terminal continuation"}];
 const shields=recipient&&live(recipient)?recipient.upgrades.filter(c=>c.cardData.internalName==="shield").map(c=>({card:c,id:id(c)})):[];
 const spyTokens=[];
 eg.game.on("onTokensCreated",event=>{if(!settled)for(const c of event.generatedTokens??[])if(c.cardData.internalName==="spy"){assert.equal(c.zoneName,"outsideTheGame");assert.equal(c.controller,own);spyTokens.push(c);}});
 eg.game.on("onCardPlayed",event=>{if(settled||event.isCancelledOrReplaced)return;played.add(event.card);if(payment?.card===event.card){const expected=event.card.cost+2*payment.player.getPenaltyAspects(event.card.aspects).length;assert.equal(payment.before-ready(payment.player),expected);payments.push({card:id(event.card),amount:expected});payment=null;}});
 eg.game.on("onAttackDeclared",event=>{if(settled)return;const t=tasks[taskAt];if(t?.card===event.attack.attacker){t.before={targetDamage:t.target.damage,targetHp:t.target.getHp(),power:event.attack.getAttackerCombatDamage(event.context)};events.push({name:"onAttackDeclared",attacker:id(t.card),target:id(t.target),...t.before});}});
 eg.game.on("onAttackEnd",event=>{if(settled)return;if(event.attack.attacker===source)attacks++;const t=tasks[taskAt];if(t?.card===event.attack.attacker)t.ended=true;events.push({name:"onAttackEnd",attacker:id(event.attack.attacker)});});
 function complete(t){if(t.role==="phase")return t.round!=null&&eg.round>t.round;if(t.role==="deploy")return t.card.deployed;if(t.role==="attack"||t.role==="spy-attack")return t.ended||t.card===source&&v==="self-lethal"&&t.before&&source.zoneName==="base";if(t.role==="front")return t.started;return played.has(t.card);}
 function checkTask(t){
  if(t.role==="play"&&t.card===source){
   assert.ok(live(source));assert.equal(id(source),initialSource);assert.equal(source.exhausted,true);
   const positive=ambush?["own-ground-accept","own-space-accept","own-token","decline","no-enemy-unit","shield-combat","same-definition"].includes(v):["enemy-ground-target","own-ground-target","space-target","own-unique-space","own-space-token","decline","ineffective-self","same-definition","all-exhausted"].includes(v);
   if(ambush){assert.equal(source.hasSomeKeyword("ambush"),positive);assert.equal(attacks,positive&&!['decline','no-enemy-unit'].includes(v)?1:0);if(attacks){assert.equal(source.damage,1);assert.equal(recipient.damage,v==="shield-combat"?0:4);}else{assert.equal(source.damage,0);if(recipient)assert.equal(recipient.damage,0);}
    if(v==="same-definition"){assert.equal(targets[candidateIndex].hasSomeKeyword("ambush"),true);assert.ok(!events.some(e=>e.name==="onAttackDeclared"&&e.attacker===id(targets[candidateIndex])));}}
   else{const chosen=positive&&!['decline','all-exhausted'].includes(v);assert.equal(selections,chosen?1:0);if(chosen&&v!=="ineffective-self")assert.equal(recipient.exhausted,true);if(v==="ineffective-self")assert.equal(recipient.exhausted,false);if(!chosen&&recipient)assert.equal(recipient.exhausted,v==="all-exhausted");}
  }
  if(t.queryStage&&!ambush){assert.equal(selections,0);assert.equal(recipient.exhausted,false);}
  if(t.queryStage&&ambush){assert.equal(source.hasSomeKeyword("ambush"),t.queryStage!=="loss");assert.equal(attacks,0,"Late keyword changes never create entry attack");if(t.queryStage==="loss")assert.equal(t.target.zoneName,"discard");}
  if(t.role==="front"){
   const n=eg.game.getArenaUnits({condition:c=>c.isUnit()&&c.exhausted}).length;
   const expected=v.startsWith('zero')||v.startsWith('three')||v==="offboard-exclusions"||v==="paid-then-epic"?0:1;
   assert.equal(ready(own),t.before-(t.cancel?0:1));assert.equal(source.exhausted,!t.cancel);assert.equal(spyTokens.length,expected);assert.equal(fullState(eg).nextCardId,t.nextId+expected);if(t.cancel)assert.deepEqual(fullState(eg).players,t.beforePlayers);
   if(expected){const c=spyTokens[0];assert.equal(c.controller,own);assert.equal(c.exhausted,true);assert.equal(c.getKeywordsWithNumericValues('raid').reduce((n,k)=>n+k.value,0),2);}
   witness.observations.push({stage:"front-settled",exhaustedUnitCount:n,spyIds:spyTokens.map(id),cancel:t.cancel});
  }
  if(t.role==="deploy"){assert.equal(t.card.deployed,true);assert.equal(t.card.exhausted,false);}
  if(t.role==="attack"||t.role==="spy-attack"){
   assert.ok(t.before);if(t.card===source&&v==="self-lethal"){assert.equal(source.zoneName,"base");assert.equal(source.deployed,false);assert.equal(enemy.base.damage,t.before.targetDamage,"Departed attacker causes no combat");}
   else if(t.target.isBase()){const extra=t.card===enemy.getAllDeckLeaders()[0]?1:t.card===source&&!t.decline&&t.oaTarget===t.target?2:0;assert.equal(t.target.damage,Math.min(t.before.targetHp,t.before.targetDamage+t.before.power+extra));}
   if(t.card===source&&v==="deployed-enemy")assert.equal(recipient.damage,2);
   if(t.card===source&&v==="deployed-self")assert.equal(source.damage,2);
   if(t.role==="spy-attack")assert.equal(t.before.power,2);
  }
 }
 function finish(){
  if(sly&&["deployed-enemy","deployed-self","deployed-decline","self-lethal"].includes(v)){assert.equal(source.zoneName,"base");assert.equal(source.deployed,false);assert.equal(source.exhausted,true);assert.equal(id(source),initialSource);}
  if(v==="shield-combat"){assert.equal(shields.length,1);assert.equal(shields[0].card.zoneName,"outsideTheGame");assert.equal(shields[0].card.isAttached(),false);assert.equal(recipient.upgrades.some(c=>id(c)===shields[0].id),false);}
  for(const r of baseline){if(r.card===recipient||r.card===targets[entrantIndex]||r.card===source)continue;assert.ok(live(r.card));assert.equal(r.card.damage,r.damage);assert.equal(r.card.getHp(),r.hp);assert.equal(r.card.getPower(),r.power);if(v!=="spy-combat")assert.equal(r.card.exhausted,r.exhausted);}
  witness.observations.push({stage:"focused-settled",payments,source:id(source),zone:source.zoneName,attacks,selections});settled=true;
 }
 try{
  while(!eg.over&&step<5000){
   const pid=eg.ids.find(id=>eg.legalActions(id).length);assert.ok(pid);const actions=expandActions(eg,eg.legalActions(pid)),window=eg.isActionWindow(pid),prompt=eg.player(pid).currentPrompt();
   if(window&&!settled){while(taskAt<tasks.length&&complete(tasks[taskAt])){checkTask(tasks[taskAt]);taskAt++;}if(taskAt===tasks.length)finish();}
   if(window)records.push({type:"state",step,actor:eg.seatOf(pid),state:fullState(eg,pid)});
   let chosen,t=tasks[taskAt];
   if(!settled){
    if(t?.role==="phase"&&t.round==null)t.round=eg.round;
    if(t?.role==="spy-attack"&&!t.card){t.card=spyTokens[0];t.target=enemy.base;assert.ok(t.card);}
    if(window){
     if(t?.player?.id===pid&&t.role!=="phase"&&(!(t.role==="attack"||t.role==="spy-attack")||!t.card.exhausted)){
      chosen=actions.find(a=>a.cardUuid===t.card.uuid);
      if(chosen){if(t.role==="play")payment={card:t.card,player:t.player,before:ready(t.player)};if(t.role==="front"){t.before=ready(own);t.nextId=fullState(eg).nextCardId;t.beforePlayers=structuredClone(fullState(eg).players);t.started=true;}}
     }
     chosen??=actions.find(a=>a.arg==="pass");
    }else{
     if(t?.role==="front"){
      chosen=/will have no effect/.test(prompt.menuTitle??"")?actions.find(a=>a.label===(t.cancel?"Cancel":"Use it anyway")):actions.find(a=>a.label?.includes(p.titles.leader[0]));
     }else if(t?.role==="deploy")chosen=actions.find(a=>/deploy/i.test(a.label??""));
     else{
      if(t?.decline)chosen=actions.find(a=>a.arg==="passAbility"||a.label==="Pass"||a.label==="Choose nothing");
      const target=t?.role==="attack"||t?.role==="spy-attack"?(!t.before?t.target:t.oaTarget):t?.target;
      if(!chosen&&target)chosen=actions.find(a=>a.cardUuid===target.uuid);
      if(chosen?.cardUuid&&t?.card===source&&p.mode==="exhaust-query")selections++;
      chosen??=actions.find(a=>a.label==="Trigger"||a.label==="Resolve"||a.label==="Attack");
     }
     chosen??=actions.find(a=>a.arg==="done");chosen??=actions.length===1?actions[0]:undefined;
    }
   }else chosen=bot.choose({game:eg,pid,actions,rng});
   assert.ok(chosen,JSON.stringify({case:scenario.id,task:t?.role,title:prompt.menuTitle,actions:actions.map(a=>canonicalAction(eg,a))}));
   records.push({type:"decision",step,actor:eg.seatOf(pid),prompt:{type:prompt.promptType??null,title:prompt.menuTitle??null,selected:(eg.player(pid).promptState.selectedCards??[]).map(id),actionWindow:window},actions:actions.map(a=>canonicalAction(eg,a)),chosen:canonicalAction(eg,chosen).key,events:[]});eg.apply(pid,chosen,rng);step++;
  }
  assert.ok(settled);assert.ok(eg.over,"Complete real terminal continuation required");witness.coverageObligationIds=scenario.coverageObligationIds;
  records.push({type:"result",winner:eg.winner,step,state:fullState(eg)});return {records,witness};
 }catch(e){e.diagnostic={records,witness,state:fullState(eg),taskAt};throw e;}finally{bot.close?.();}
}
module.exports={fixture,dependencies:["bot/cards/pipeline/arena-query-probes.js","bot/cards/pipeline/arena-query-probe-fixture.js","bot/cards/pipeline/probe-fixture.js","bot/cards/pipeline/base-zone-probes.js","bot/cards/pipeline/arena-token-probes.js","bot/cards/pipeline/arena-damage-probes.js","bot/omni/rs/make-pool.js","bot/omni/rs/state.js","bot/env.js","bot/players/index.js"]};
