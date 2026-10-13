'use strict';
// Existing-card regressions: actual Sabine registration, never a replacement ability.
const assert=require('node:assert/strict');
const {constructProbeFixture}=require('../../pipeline/probe-fixture');
const {fullState,expandActions,canonicalAction}=require('../../../omni/rs/state');
const scenarios=[0,1].flatMap(sourceSeat=>[false,true].map(command=>({
    name:`sabine-inline-upgrade-${command?'own-command':'no-own-command'}-p${sourceSeat+1}`,
    family:'conditional-inline-upgrade-selection-title',sourceSeat,command,
    actualScriptedCardIds:['LAW_078'],
    setupCardIds:['LOF_254','HMW_235','LOF_102',...(command?['LOF_112']:[])],
    plan:[{code:'LAW_078'}],
})));
async function fixture(env,pool,scenario,seed){
    assert.ok(scenarios.some(s=>s.name===scenario.name&&s.sourceSeat===scenario.sourceSeat&&s.command===scenario.command),'Unknown inline-upgrade construction');
    const reversed=scenario.sourceSeat===1;
    const probe={cardId:'LAW_078',resourceCount:20,initiative:'self',targets:[
        ...(reversed?[{code:'LAW_078',owner:'opponent',zone:'hand'}]:[]),
        {code:'LOF_254',owner:reversed?'self':'opponent',arena:'ground',exhausted:true,attachments:[{code:'HMW_235'},{code:'LOF_102'}]},
        ...(scenario.command?[{code:'LOF_112',owner:reversed?'opponent':'self',arena:'ground',exhausted:true}]:[]),
    ]};
    const c=await constructProbeFixture(env,pool,{name:scenario.name,probe},seed);
    const {eg,rng,bot,deck}=c,source=reversed?c.targets[0]:c.source,sourcePlayer=source.controller,otherPlayer=sourcePlayer===c.own?c.enemy:c.own;
    const host=c.targets[reversed?1:0],upgrades=host.upgrades.slice(),nonunique=upgrades.find(u=>!u.unique),unique=upgrades.find(u=>u.unique);
    assert.ok(nonunique&&unique);assert.equal(host.controller,otherPlayer);assert.equal(sourcePlayer.isAspectInPlay(['vigilance','command']),scenario.command);
    const expectedTitle=scenario.command?'Defeat an upgrade':'Defeat a non-unique upgrade',victim=scenario.command?unique:nonunique,survivor=scenario.command?nonunique:unique;
    const initial=fullState(eg),observed={sourceId:eg.cardId(source.uuid),sourceSeat:eg.seatOf(sourcePlayer.id),initialUpgradeIds:upgrades.map(u=>eg.cardId(u.uuid)),selected:false,ambushDeclined:false,settled:false};
    const records=[{type:'meta',schema:'omni-rs-trace-v1',pool:pool.provenance,seed,bots:['scripted-inline-upgrade-title','scripted-inline-upgrade-title'],decks:[deck,deck],scenario:scenario.name,
        fixtureConstruction:'At first natural action window use the shared constructor to reserve a real source hand copy, stage an opposing Porg with real Gaderffii Stick and unique Yoda Lightsaber legal attachments, and optionally a friendly Command Outer Rim Mystic. For source seat2, reserve a distinct opposing hand source copy; original seat1 source stays an ordinary untouched hand card. Stage20 real ready resources per seat. Then normal source play, exact printed optional defeat selection, decline printed Ambush, and normal seeded inputs to terminal. No owner/controller/trait/class overrides or later state edits.',constructionParameters:probe}];
    let played=false,step=0;
    try{
        while(!eg.over&&step<4000){
            const pid=eg.ids.find(id=>eg.legalActions(id).length),actions=expandActions(eg,eg.legalActions(pid)),prompt=eg.player(pid).currentPrompt(),window=eg.isActionWindow(pid);let chosen;
            if(played&&observed.selected&&!observed.settled&&window){
                assert.equal(victim.zoneName,'discard');assert.equal(victim.isAttached(),false);assert.ok(otherPlayer.getCardsInZone('discard').includes(victim));assert.equal(survivor.parentCard,host);assert.ok(host.upgrades.includes(survivor));assert.ok(!host.upgrades.includes(victim));assert.ok(observed.ambushDeclined);assert.ok(source.isInPlay());
                observed.settled=true;observed.victimId=eg.cardId(victim.uuid);observed.survivorId=eg.cardId(survivor.uuid);observed.postActionState=fullState(eg);
            }
            if(!observed.settled){
                if(window){chosen=pid===sourcePlayer.id&&!played?actions.find(a=>a.cardUuid===source.uuid):actions.find(a=>a.arg==='pass');if(chosen?.cardUuid===source.uuid)played=true;}
                else if(actions.some(a=>a.cardUuid===nonunique.uuid)){
                    assert.equal(pid,sourcePlayer.id);assert.equal(prompt.menuTitle,expectedTitle);assert.deepEqual(actions.filter(a=>a.kind==='card').map(a=>a.cardUuid).sort(),(scenario.command?[nonunique.uuid,unique.uuid]:[nonunique.uuid]).sort());
                    chosen=actions.find(a=>a.cardUuid===victim.uuid);observed.selected=true;observed.selectorStep=step;observed.selector={actor:eg.seatOf(pid),title:prompt.menuTitle,actions:actions.map(a=>canonicalAction(eg,a))};
                }else{
                    chosen=actions.find(a=>a.label===expectedTitle)??actions.find(a=>a.label===(observed.selected?'Pass':'Trigger'));
                    if(observed.selected&&chosen?.label==='Pass')observed.ambushDeclined=true;
                }
            }
            chosen??=bot.choose({game:eg,pid,actions,rng});assert.ok(chosen);
            if(window) records.push({type:'state',step,state:fullState(eg,pid)});
            records.push({type:'decision',step,actor:eg.seatOf(pid),prompt:{type:prompt.promptType??null,title:prompt.menuTitle??null,selected:(eg.player(pid).promptState.selectedCards??[]).map(c=>eg.cardId(c.uuid)),actionWindow:window},actions:actions.map(a=>canonicalAction(eg,a)),chosen:canonicalAction(eg,chosen).key,events:[]});
            eg.apply(pid,chosen,rng);step++;
        }
        assert.ok(eg.over,'Oracle must reach a terminal result');assert.ok(played&&observed.selected&&observed.settled,'Printed source selector must be exercised');records.push({type:'result',step,winner:eg.winner,state:fullState(eg)});
        return {records,witness:{scenario:scenario.name,family:scenario.family,observed,decisions:step,winner:eg.winner}};
    }finally{bot.close?.();}
}
function assertRecording(scenario,{records,witness}) {
    assert.equal(records.at(-1).type,'result');assert.ok(records.some(r=>r.type==='state'));
    const o=witness.observed;assert.ok(o.selected&&o.settled&&o.ambushDeclined);
    const decision=records.find(r=>r.type==='decision'&&r.step===o.selectorStep);assert.ok(decision);
    assert.equal(decision.prompt.title,scenario.command?'Defeat an upgrade':'Defeat a non-unique upgrade');assert.equal(decision.actor,`p${scenario.sourceSeat+1}`);
    assert.equal(decision.actions.find(a=>a.key===decision.chosen).card,o.victimId);
    assert.ok(o.initialUpgradeIds.includes(o.victimId)&&o.initialUpgradeIds.includes(o.survivorId));assert.notEqual(o.victimId,o.survivorId);
}
module.exports={scenarios,fixture,assertRecording,dependencies:['../../pipeline/probe-fixture.js','../../../omni/rs/state.js']};
