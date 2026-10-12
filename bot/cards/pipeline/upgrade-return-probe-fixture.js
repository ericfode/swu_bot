'use strict';
const assert=require('node:assert/strict');
const {constructProbeFixture}=require('./probe-fixture');
const {fullState,canonicalAction,expandActions}=require('../../omni/rs/state');
function observe(c,eg){const arena=c.isInPlay?.();return {id:eg.cardId(c.uuid),zone:c.zoneName,parent:c.isUpgrade?.()&&arena?eg.cardId(c.parentCard.uuid):null,owner:eg.seatOf(c.owner.id),controller:eg.seatOf(c.controller.id),hp:c.isUnit?.()&&arena?c.getHp():null,power:c.isUnit?.()&&arena?c.getPower():null};}
async function fixture(env,pool,scenario,seed){
    const p=scenario.probe;assert.equal(p.family,'upgrade-return');
    const {eg,rng,bot,deck,own,enemy,source,activation,targets}=await constructProbeFixture(env,pool,scenario,seed);
    const hosts=targets.filter(c=>c.isUnit?.()&&c.isInPlay()),attachments=hosts.flatMap(c=>c.upgrades),standalone=targets.filter(c=>c.isUpgrade?.()),allUpgrades=[...attachments,...standalone];
    const intended=p.chosenSource?source:p.chosenStandalone!==undefined?targets[p.chosenStandalone]:p.chosenAttachment?targets[p.chosenAttachment.target].upgrades[p.chosenAttachment.index]:null;
    const hands=()=>[own.getCardsInZone('hand').map(c=>eg.cardId(c.uuid)),enemy.getCardsInZone('hand').map(c=>eg.cardId(c.uuid))];
    const before={source:observe(source,eg),targets:targets.map(c=>observe(c,eg)),upgrades:allUpgrades.map(c=>observe(c,eg)),hands:hands()};
    const witness={scenario:scenario.name,coverageObligationIds:[],initial:before,observations:[],played:false,selected:false,declined:false,attachmentHostSelected:false,defeatedIds:[],movedIds:[],leftPlayIds:[],unattachedIds:[]};
    const enemyDeck={...deck,base:{id:p.enemyBaseCode??deck.base.id,count:1}};
    const records=[{type:'meta',schema:'omni-rs-trace-v1',pool:pool.provenance,seed,bots:['upgrade-return-probe','upgrade-return-probe'],decks:[deck,enemyDeck],scenario:scenario.name,fixtureConstruction:'Disclosed metadata-selected source, legal ordinary/token attachments and standalone discard upgrades, host damage, own/enemy base choices, twelve real resource cards at first natural action window; afterward only recorded normal inputs. Actual focus upgrade is played and attached through normal prompts.',constructionParameters:p}];
    let activated=false,settled=false,step=0;
    eg.game.on('onCardPlayed',e=>{if(activated&&!settled&&e.card===activation&&!e.isCancelledOrReplaced)witness.played=true;});
    eg.game.on('onCardDefeated',e=>{if(activated&&!settled&&!e.isCancelledOrReplaced)witness.defeatedIds.push(eg.cardId(e.card.uuid));});
    eg.game.on('onCardMoved',e=>{if(activated&&!settled&&!e.isCancelledOrReplaced)witness.movedIds.push(eg.cardId(e.card.uuid));});
    eg.game.on('onCardLeavesPlay',e=>{if(activated&&!settled&&!e.isCancelledOrReplaced)witness.leftPlayIds.push(eg.cardId(e.card.uuid));});
    eg.game.on('onUpgradeUnattached',e=>{if(activated&&!settled&&!e.isCancelledOrReplaced)witness.unattachedIds.push(eg.cardId(e.upgradeCard.uuid));});
    // Expected target domains follow the five full pinned source definitions,
    // not the backend's legal-target implementation.
    const expectedCandidates=()=>{
        const cards=p.discard?own.getCardsInZone('discard').filter(c=>c.isUpgrade()):[...own.getArenaUnits(),...enemy.getArenaUnits()].flatMap(c=>c.upgrades);
        return cards.filter(c=>(!p.nonUnique||!c.unique)&&(p.threshold===null||c.cost<=p.threshold));
    };
    function assertAfter(){
        const after={source:observe(source,eg),targets:targets.map(c=>observe(c,eg)),upgrades:allUpgrades.map(c=>observe(c,eg)),hands:hands()};witness.observations.push({stage:'after-resolution',...after});
        assert.ok(witness.played,'Focus card must actually play');
        if(p.sourceUpgrade)assert.ok(witness.attachmentHostSelected,'Focus upgrade must attach via real host input');
        if(p.expectedReturn){
            assert.ok(witness.selected,'Real chosen upgrade input required');assert.ok(intended,'Missing chosen upgrade identity');
            const id=eg.cardId(intended.uuid),isToken=intended.cardData.types.includes('token');
            assert.equal(intended.zoneName,isToken?'outsideTheGame':'hand','Ordinary upgrade goes owner hand; token leaves game');
            assert.ok(!hosts.filter(c=>c.isInPlay()).flatMap(c=>c.upgrades).includes(intended),'Selected upgrade detached exactly once');
            for(const [i,hand]of after.hands.entries())assert.equal(hand.includes(id),!isToken&&i===eg.ids.indexOf(intended.owner.id),'Returned identity belongs only to owner hand');
            if(!isToken)assert.equal(intended.controller,intended.owner,'Hidden-zone return resets controller to owner');
            if(!p.expectedHostDeath)for(const upgrade of allUpgrades.filter(c=>c!==intended))assert.deepEqual(observe(upgrade,eg),before.upgrades.find(u=>u.id===eg.cardId(upgrade.uuid)),'Unselected upgrade identity and parent stay unchanged');
            assert.ok(!witness.defeatedIds.includes(id),'Returning an upgrade does not defeat it');
            if(p.discard){assert.ok(!witness.leftPlayIds.includes(id),'Discard recovery does not leave play');assert.ok(!witness.unattachedIds.includes(id),'Discard recovery does not unattach');}else{assert.ok(witness.leftPlayIds.includes(id),'Attached upgrade has leaves-play event');assert.ok(witness.unattachedIds.includes(id),'Attached upgrade has unattachment contingent');}
        }else assert.deepEqual(after.upgrades,before.upgrades,'Decline/no-target/base-condition-false preserves staged upgrade links and zones');
        if(p.expectedHostDeath){assert.equal(targets[0].zoneName,'discard','Losing printed upgrade HP defeats damaged host');assert.equal(after.hands[0].length,before.hands[0].length-1+1+p.expectedDeathDraw,'Returned ordinary card and captured host death draw both reach hand');assert.ok(witness.defeatedIds.includes(eg.cardId(targets[0].uuid)));for(const upgrade of allUpgrades.filter(c=>c!==intended))assert.equal(upgrade.zoneName,'outsideTheGame','Remaining token attachments clean up after host dies');}
        if(p.decline)assert.ok(witness.declined,'Optional decline input required');
    }
    try{while(!eg.over&&step<4000){
        const pid=eg.ids.find(id=>eg.legalActions(id).length);assert.ok(pid);const actions=expandActions(eg,eg.legalActions(pid)),atWindow=eg.isActionWindow(pid);let chosen;
        if(atWindow){records.push({type:'state',step,state:fullState(eg,pid)});if(activated&&witness.played&&!settled){assertAfter();settled=true;}}
        if(atWindow&&!activated&&pid===own.id){chosen=actions.find(a=>a.cardUuid===activation.uuid);assert.ok(chosen,'Actual focus source playable');activated=true;}
        if(atWindow&&!settled)chosen??=actions.find(a=>a.arg==='pass');
        if(!atWindow&&activated&&!settled){
            if(p.sourceUpgrade&&!witness.attachmentHostSelected&&actions.some(a=>a.kind==='card')){
                const host=targets[p.sourceAttachTarget??0];chosen=actions.find(a=>a.cardUuid===host?.uuid);assert.ok(chosen,'Real focus upgrade attachment host eligible');witness.attachmentHostSelected=true;witness.observations.push({stage:'source-attach-prompt',candidateIds:actions.filter(a=>a.kind==='card').map(a=>eg.cardId(a.cardUuid))});
            }else if(actions.some(a=>a.kind==='card')){
                const actual=actions.filter(a=>a.kind==='card').map(a=>eg.cardId(a.cardUuid)).sort(),expected=expectedCandidates().map(c=>eg.cardId(c.uuid)).sort();assert.deepEqual(actual,expected,'Exact source-defined upgrade candidate domain');
                witness.observations.push({stage:'upgrade-target-prompt',candidateIds:actual,expectedCandidateIds:expected});
                if(p.decline){chosen=actions.find(a=>['passAbility','cancel'].includes(a.arg)||a.arg==='done'&&/nothing/i.test(a.label??''));assert.ok(chosen);witness.declined=true;}
                else if(intended){chosen=actions.find(a=>a.cardUuid===intended.uuid);assert.ok(chosen,'Chosen eligible upgrade offered');witness.selected=true;}
                else assert.fail('Unexpected target selection for no-return construction');
            }
            if(p.decline&&!chosen){chosen=actions.find(a=>['passAbility','cancel'].includes(a.arg));if(chosen)witness.declined=true;}
            chosen??=actions.find(a=>a.kind==='button'&&/trigger|resolve|play|yes/i.test(a.label??''));chosen??=actions.find(a=>a.arg==='done');
        }
        chosen??=bot.choose({game:eg,pid,actions,rng});const prompt=eg.player(pid).currentPrompt();records.push({type:'decision',step,actor:eg.seatOf(pid),prompt:{type:prompt.promptType??null,title:prompt.menuTitle??null,selected:(eg.player(pid).promptState.selectedCards??[]).map(c=>eg.cardId(c.uuid)),actionWindow:atWindow},actions:actions.map(a=>canonicalAction(eg,a)),chosen:canonicalAction(eg,chosen).key,events:[]});eg.apply(pid,chosen,rng);step++;
    }
    assert.ok(eg.over);assert.ok(settled);records.push({type:'result',step,winner:eg.winner,state:fullState(eg)});witness.coverageObligationIds=[...scenario.coverageObligationIds];return {records,witness};
    }finally{bot.close?.();}
}
module.exports={fixture,dependencies:['bot/cards/pipeline/upgrade-return-probes.js','bot/cards/pipeline/upgrade-return-probe-fixture.js','bot/cards/pipeline/probe-fixture.js','bot/env.js','bot/omni/rs/state.js','bot/players/index.js']};
