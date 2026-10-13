'use strict';
const assert=require('node:assert/strict');
const {constructProbeFixture}=require('./probe-fixture');
const {fullState,canonicalAction,expandActions}=require('../../omni/rs/state');
function observe(card,eg){return {id:eg.cardId(card.uuid),zone:card.zoneName,exhausted:card.isUnit?.()&&card.isInPlay()?card.exhausted:null,parent:card.isUpgrade?.()&&card.isInPlay()?eg.cardId(card.parentCard.uuid):null,hp:card.isUnit?.()&&card.isInPlay()?card.getHp():null,power:card.isUnit?.()&&card.isInPlay()?card.getPower():null};}
async function fixture(env,pool,scenario,seed){
    const p=scenario.probe;assert.equal(p.family,'cost-query');
    const {eg,rng,bot,deck,own,enemy,source,activation,targets}=await constructProbeFixture(env,pool,scenario,seed);
    const attachments=targets.flatMap(c=>c.upgrades??[]),chosenAttachment=p.chosenAttachment?targets[p.chosenAttachment.target].upgrades[p.chosenAttachment.index]:null;
    const before={source:observe(source,eg),targets:targets.map(c=>observe(c,eg)),attachments:attachments.map(c=>observe(c,eg)),handCounts:[own.getCardsInZone('hand').length,enemy.getCardsInZone('hand').length],resources:own.getCardsInZone('resource').filter(c=>!c.exhausted).length};
    const witness={scenario:scenario.name,coverageObligationIds:[],initial:before,observations:[],played:false,selected:false,declined:false};
    const records=[{type:'meta',schema:'omni-rs-trace-v1',pool:pool.provenance,seed,bots:['cost-query-probe','cost-query-probe'],decks:[deck,deck],scenario:scenario.name,fixtureConstruction:'Shared metadata-selected probe constructor establishes real deck source/targets, actual deployed leaders, declared generated tokens and attached real upgrades, resources and exhaustion before capture. Thereafter only recorded ordinary legal engine inputs.',constructionParameters:p}];
    let activated=false,settled=false,step=0,activationTargetChosen=false;
    eg.game.on('onCardPlayed',event=>{if(activated&&!settled&&event.card===activation&&!event.isCancelledOrReplaced)witness.played=true;});
    function expectedCandidates(){
        if(p.shape==='attach')return [...own.getArenaUnits(),...enemy.getArenaUnits()].filter(c=>c.hasCost()&&c.cost<=p.threshold);
        if(p.shape==='upgrade-defeat')return [...own.getArenaUnits(),...enemy.getArenaUnits()].flatMap(c=>c.upgrades).filter(c=>c.hasCost()&&c.cost<=p.threshold);
        if(p.shape==='death-ready')return [...own.getArenaUnits(),...enemy.getArenaUnits()].filter(c=>c.hasCost()&&c.cost<=p.threshold&&c.exhausted);
        return [];
    }
    function assertAfter(){
        const after={source:observe(source,eg),targets:targets.map(c=>observe(c,eg)),attachments:attachments.map(c=>observe(c,eg)),handCounts:[own.getCardsInZone('hand').length,enemy.getCardsInZone('hand').length]};
        witness.observations.push({stage:'after-resolution',...after});
        assert.ok(witness.played||p.negativeOnly||(p.shape==='attach'&&witness.declined),'Actual activating card must have played');
        if(p.shape==='discard'){
            assert.equal(after.handCounts[1],before.handCounts[1]-(p.expectedDiscard?1:0),'Printed-source conditional enemy discard amount');
            assert.equal(after.handCounts[0],before.handCounts[0]-1,'Playing source leaves own hand without an own discard');
            if(p.expectedDiscard)assert.notEqual(after.handCounts[1],before.handCounts[1],'Positive discard must change enemy hand');
        }else if(p.shape==='attach'){
            if(p.expectedAttach){assert.equal(source.parentCard?.uuid,targets[p.chosenTarget].uuid);assert.ok(targets[p.chosenTarget].upgrades.includes(source));assert.ok(witness.selected);assert.equal(after.targets[p.chosenTarget].power,before.targets[p.chosenTarget].power+p.upgradePower);assert.equal(after.targets[p.chosenTarget].hp,before.targets[p.chosenTarget].hp+p.upgradeHp);assert.ok(own.getCardsInZone('resource').filter(c=>!c.exhausted).length<before.resources,'Ordinary attachment spends real resources');assert.notDeepEqual(after.source,before.source,'Actual attachment changes source location');}
            else {assert.equal(source.zoneName,'hand');assert.equal(own.getCardsInZone('resource').filter(c=>!c.exhausted).length,before.resources,'Cancellation/no target does not spend play cost');}
        }else if(p.shape==='upgrade-defeat'){
            if(p.expectedDefeat){assert.ok(witness.selected);assert.ok(!targets.filter(c=>c.isInPlay()).flatMap(c=>c.upgrades).includes(chosenAttachment));assert.notEqual(chosenAttachment.zoneName,before.attachments.find(c=>c.id===eg.cardId(chosenAttachment.uuid)).zone,'Defeat moves selected upgrade');}
            else assert.deepEqual(after.attachments,before.attachments,'Optional decline preserves upgrades');
            if(p.expectedDefeat)for(const attachment of after.attachments.filter(c=>c.id!==eg.cardId(chosenAttachment.uuid))){const initial=before.attachments.find(c=>c.id===attachment.id);assert.equal(attachment.parent,initial.parent,'Unselected attachment preserves original parent');assert.equal(attachment.zone,initial.zone,'Unselected attachment preserves original zone');}
            if(p.expectedHostDeath){assert.equal(targets[0].zoneName,'discard');assert.equal(after.handCounts[0],before.handCounts[0]-1+p.expectedDeathDraw,'Actual defeated host draws after upgrade HP loss');}
        }else{
            assert.equal(source.zoneName,'discard','Actual activating event defeated focus source');
            if(p.expectedReady){assert.ok(witness.selected);assert.equal(targets[p.chosenTarget].exhausted,false);assert.equal(before.targets[p.chosenTarget].exhausted,true,'Positive ready changed exhausted state');}
            else for(let i=0;i<targets.length;i++)assert.equal(targets[i].exhausted,before.targets[i].exhausted,'Decline/ineffective branch preserves readiness');
        }
        if(p.decline)assert.ok(witness.declined,'Actual decline/cancel input required');
    }
    try{while(!eg.over&&step<4000){
        const pid=eg.ids.find(id=>eg.legalActions(id).length);assert.ok(pid,'No actor');
        const actions=expandActions(eg,eg.legalActions(pid)),atWindow=eg.isActionWindow(pid);assert.ok(actions.length);
        if(atWindow){records.push({type:'state',step,state:fullState(eg,pid)});if(activated&&(witness.played||(p.shape==='attach'&&witness.declined))&&!settled){assertAfter();settled=true;}}
        let chosen;
        if(atWindow&&!activated&&pid===own.id){chosen=actions.find(a=>a.cardUuid===activation.uuid);if(!chosen&&p.negativeOnly){witness.observations.push({stage:'unplayable',sourceLegal:false});activated=true;assertAfter();settled=true;}else {assert.ok(chosen,'Activating card must be playable');activated=true;}}
        if(atWindow&&!settled)chosen??=actions.find(a=>a.arg==='pass');
        if(!atWindow&&activated&&!settled){
            if(p.shape==='death-ready'&&!activationTargetChosen&&actions.some(a=>a.cardUuid===source.uuid)) {chosen=actions.find(a=>a.cardUuid===source.uuid);activationTargetChosen=true;witness.observations.push({stage:'actual-death-selection',sourceId:eg.cardId(source.uuid)});}
            else if(p.shape==='discard'){
                if(actions.some(a=>a.kind==='card')){assert.equal(pid,enemy.id,'Target opponent chooses discard from own hand');const cards=enemy.getCardsInZone('hand');for(const a of actions.filter(a=>a.kind==='card'))assert.ok(cards.some(c=>c.uuid===a.cardUuid),'Only opponent hand candidates');witness.observations.push({stage:'opponent-discard-prompt',candidateIds:actions.filter(a=>a.kind==='card').map(a=>eg.cardId(a.cardUuid))});chosen=actions.find(a=>a.kind==='card');}
            }else if(actions.some(a=>a.kind==='card')){
                const candidateIds=actions.filter(a=>a.kind==='card').map(a=>eg.cardId(a.cardUuid)).sort();
                const expected=expectedCandidates().map(c=>eg.cardId(c.uuid)).sort();assert.deepEqual(candidateIds,expected,'Exact printed-source cost/type candidate set');
                for(const base of [own.base,enemy.base])assert.ok(!actions.some(a=>a.cardUuid===base.uuid),'Base excluded from unit/upgrade selector');
                witness.observations.push({stage:'cost-target-prompt',candidateIds,expectedCandidateIds:expected});
                if(p.decline){chosen=actions.find(a=>a.arg==='cancel'||a.arg==='passAbility'||a.arg==='done'&&/nothing/i.test(a.label??''));assert.ok(chosen,'Actual optional decline action');witness.declined=true;}
                else {const target=chosenAttachment??targets[p.chosenTarget??0];chosen=actions.find(a=>a.cardUuid===target?.uuid);assert.ok(chosen,'Intended source-derived eligible candidate missing');witness.selected=true;}
            }
            if(p.decline&&!chosen){chosen=actions.find(a=>a.arg==='passAbility'||a.arg==='cancel');if(chosen)witness.declined=true;}
            chosen??=actions.find(a=>a.kind==='button'&&/trigger|resolve|play|yes/i.test(a.label??''));
            chosen??=actions.find(a=>a.arg==='done');
        }
        chosen??=bot.choose({game:eg,pid,actions,rng});assert.ok(chosen);
        const prompt=eg.player(pid).currentPrompt();records.push({type:'decision',step,actor:eg.seatOf(pid),prompt:{type:prompt.promptType??null,title:prompt.menuTitle??null,selected:(eg.player(pid).promptState.selectedCards??[]).map(c=>eg.cardId(c.uuid)),actionWindow:atWindow},actions:actions.map(a=>canonicalAction(eg,a)),chosen:canonicalAction(eg,chosen).key,events:[]});eg.apply(pid,chosen,rng);step++;
    }
    assert.ok(eg.over,'Oracle game completes');assert.ok(settled,'Source activation observed');records.push({type:'result',step,winner:eg.winner,state:fullState(eg)});witness.coverageObligationIds=[...scenario.coverageObligationIds];return {records,witness};
    }finally{bot.close?.();}
}
module.exports={fixture,dependencies:['bot/cards/pipeline/cost-probes.js','bot/cards/pipeline/cost-probe-fixture.js','bot/cards/pipeline/probe-fixture.js','bot/env.js','bot/omni/rs/state.js','bot/players/index.js']};
