"use strict";
const assert=require("node:assert/strict");
const {constructProbeFixture}=require("./probe-fixture");
const {fullState,expandActions,canonicalAction}=require("../../omni/rs/state");
async function fixture(env,pool,scenario,seed) {
    const p=scenario.probe;assert.equal(p.family,"base-zone");
    const reverse=p.sourceSeat===2,relative=o=>reverse?o==="self"?"opponent":"self":o;
    const ownBase=p.mode==="leader-raid"?p.ordinaryBaseCode:p.cardId;
    const ownLeader=p.mode==="leader-raid"?p.cardId:p.ordinaryLeaderCode;
    const construction={...scenario,probe:{...p,cardId:p.fillerCode,
        baseCode:reverse?p.ordinaryBaseCode:ownBase,enemyBaseCode:reverse?ownBase:p.ordinaryBaseCode,
        leaderCode:reverse?p.ordinaryLeaderCode:ownLeader,enemyLeaderCode:reverse?ownLeader:p.ordinaryLeaderCode,
        initiative:relative("self"),targets:p.targets.map(t=>({...t,owner:relative(t.owner)}))}};
    const setup=await constructProbeFixture(env,pool,construction,seed);
    const {eg,rng,bot,targets}=setup,own=reverse?setup.enemy:setup.own,enemy=reverse?setup.own:setup.enemy;
    const leader=own.getAllDeckLeaders()[0],other=enemy.getAllDeckLeaders()[0],source=p.mode==="leader-raid"?leader:own.base;
    const id=c=>eg.cardId(c.uuid),live=c=>c.isUnit?.()&&c.isInPlay();
    const raid=c=>c.getKeywordsWithNumericValues("raid").reduce((n,k)=>n+k.value,0);
    const printed=code=>pool.cards.find(c=>c.setCode===code);
    const initialRound=eg.round,leaderId=id(leader),baseId=id(own.base),enemyLeaderId=id(other),enemyBaseId=id(enemy.base);
    const unitRows=targets.map((c,i)=>p.targets[i].zone?null:{card:c,index:i,power:printed(p.targets[i].code).power,
        hp:printed(p.targets[i].code).hp,cost:printed(p.targets[i].code).cost,raid:p.mode==="leader-raid"&&i===p.raidIndex||i===p.enemyRaidIndex?1:0}).filter(Boolean);
    const tasks=[];
    const deploy=(player,card)=>tasks.push({role:"deploy",player,card});
    const attack=(player,card,target)=>tasks.push({role:"attack",player,card,target,started:false,ended:false});
    const play=(card,target=null)=>tasks.push({role:target?"damage":"play",player:own,card,target});
    if(p.lifecycle) {
        deploy(own,leader);deploy(enemy,other);
        if(p.mode!=="leader-hp")attack(own,leader,enemy.base);
        play(targets[p.damageCardIndices[0]],leader);
        if(p.mode==="leader-hp")attack(enemy,targets[8],leader);
        play(targets[p.damageCardIndices[1]],leader);
    } else if(p.offboard) deploy(enemy,other);
    else if(p.laterEntry) {if(p.mode!=="leader-raid"||p.deployedEntry)deploy(own,leader);play(targets[p.entrantIndex]);}
    else if(p.lethal) {
        if(p.lethal==="own") {own.base.damage=p.baseHp-1;attack(enemy,targets[8],own.base);}
        else {enemy.base.damage=enemy.base.getHp()-1;play(targets[p.quietOneIndex]);attack(own,targets[p.quietOneIndex],enemy.base);}
        eg.game.resolveGameState(true);eg.game.continue();
    } else if(p.thresholdCombat) {
        const index=p.thresholdCombat==="ground"?0:2;attack(own,targets[index],enemy.base);attack(own,targets[index+1],enemy.base);
    } else if(p.stackCombat) attack(own,targets[p.raidIndex],enemy.base);
    else if(p.phasePersistence)tasks.push({role:"phase"});
    else if(p.upgrade)play(targets[p.upgradeIndex],targets[0]);
    const records=[{type:"meta",schema:"omni-rs-trace-v1",pool:pool.provenance,seed,bots:["base-zone-probe","base-zone-probe"],
        decks:setup.decks,scenario:scenario.name,constructionParameters:p,
        fixtureConstruction:"Genuine asymmetric initial base/leader decks; disclosed quiet recipients. Actual deployment, paid hand donors, combat and same-ID real undeployment before complete terminal continuation"}];
    const witness={coverageObligationIds:[],observations:[],events:[]},payments=[],attacks=[];
    let taskAt=0,step=0,settled=false,pendingPayment=null;
    const played=new Set();
    function ongoing(stage) {
        assert.equal(id(leader),leaderId);assert.equal(id(own.base),baseId);assert.equal(id(other),enemyLeaderId);assert.equal(id(enemy.base),enemyBaseId);
        assert.equal(own.base.getHp(),p.mode==="leader-raid"?printed(p.ordinaryBaseCode).hp:p.baseHp);
        assert.equal(enemy.base.getHp(),printed(p.ordinaryBaseCode).hp);
        if(live(other)){assert.equal(other.getHp(),p.ordinaryLeaderHp);assert.equal(other.getPower(),p.ordinaryLeaderPower);}
        if(live(leader)) {
            const card=printed(ownLeader);assert.equal(leader.getHp(),card.hp+(p.hp??0));assert.equal(leader.getPower(),card.power+(p.power??0));
            if(p.mode==="leader-raid")assert.equal(raid(leader),1,"Printed source Raid only, no duplicate deployed aura");
        }
        for(const row of unitRows) {
            assert.ok(live(row.card),"Ordinary/native recipient remains live except actual one-power combat casualty");
            const expected=row.raid+(p.mode==="leader-raid"&&row.card.controller===own&&row.cost>=3?1:0);
            assert.equal(raid(row.card),expected,`Current source side recipient Raid at ${stage}`);
            const upgraded=p.upgrade&&row.card===targets[0]&&played.has(targets[p.upgradeIndex]);
            const upgrade=upgraded?printed(p.targets[p.upgradeIndex].code):null;
            assert.equal(row.card.getPower(),row.power+(upgrade?.upgradePower??0));
            assert.equal(row.card.getHp(),row.hp+(upgrade?.upgradeHp??0));
        }
        witness.observations.push({stage,leader:id(leader),leaderZone:leader.zoneName,leaderDeployed:leader.deployed,leaderExhausted:leader.exhausted,
            unitRaid:unitRows.map(r=>({id:id(r.card),raid:raid(r.card)})),baseHp:own.base.getHp()});
    }
    ongoing("initial");assert.equal(leader.deployed,false);assert.equal(other.deployed,false);
    eg.game.on("onCardPlayed",event=>{
        if(settled||event.isCancelledOrReplaced||!pendingPayment||event.card!==pendingPayment.card)return;
        const expected=event.card.cost+2*pendingPayment.player.getPenaltyAspects(event.card.aspects).length;
        assert.equal(pendingPayment.ready-pendingPayment.player.resources.filter(c=>!c.exhausted).length,expected,"Exact actual donor/entrant payment");
        payments.push({card:id(event.card),expected});played.add(event.card);pendingPayment=null;
    });
    eg.game.on("onAttackDeclared",event=>{
        const task=tasks[taskAt];if(settled||task?.role!=="attack"||event.attack.attacker!==task.card)return;
        task.before={power:task.offPower,raid:raid(task.card),attackingPower:event.attack.getAttackerCombatDamage(event.context),
            targetDamage:task.target.damage,targetHp:task.target.getHp(),sourceHp:task.card.getHp()};
        assert.equal(task.before.attackingPower,task.before.power+task.before.raid,"Live Raid applies once to actual combat");
        witness.events.push({name:"onAttackDeclared",attacker:id(task.card),target:id(task.target),...task.before});
    });
    eg.game.on("onAttackEnd",event=>{const task=tasks[taskAt];if(!settled&&task?.role==="attack"&&task.started)task.ended=true;});
    function complete(task) {
        if(task.role==="deploy")return task.card.deployed;
        if(task.role==="attack")return task.ended;
        if(task.role==="phase")return eg.round>initialRound;
        return played.has(task.card);
    }
    function checkTask(task) {
        if(task.role==="attack") {
            assert.ok(task.before);const b=task.before;
            if(task.target.isBase()) {
                const extra=task.card===leader&&p.mode!=="leader-raid"?1:0;
                assert.equal(task.target.damage,Math.min(b.targetHp,b.targetDamage+b.attackingPower+extra),"Exact printed onAttack plus live combat damage");
            }
            if(task.card===targets[8]&&task.target===leader&&p.mode==="leader-hp") {
                assert.ok(live(leader));assert.equal(leader.damage,5);assert.equal(leader.getHp(),6,"Paid4 plus real1 survival distinguishes Pau HP bonus");
                assert.ok(!live(task.card),"Real defender retaliation defeats one-HP attacker");
            }
            attacks.push({attacker:id(task.card),target:id(task.target),before:b});
        }
        if(task.role==="damage"&&task.card===targets[p.damageCardIndices[0]]) {assert.ok(live(leader));assert.equal(leader.damage,4);}
        if(task.role==="damage"&&task.card===targets[p.damageCardIndices[1]]) {
            assert.equal(leader.zoneName,"base");assert.equal(leader.deployed,false);assert.equal(leader.exhausted,true);assert.equal(id(leader),leaderId);
        }
        if(p.laterEntry&&task.card===targets[p.entrantIndex]) {
            const c=task.card,meta=printed(p.targets[p.entrantIndex].code);assert.ok(live(c));assert.equal(c.getPower(),meta.power);assert.equal(c.getHp(),meta.hp);
            assert.equal(raid(c),p.mode==="leader-raid"?1:0);
        }
        if(p.upgrade&&task.card===targets[p.upgradeIndex]) {assert.equal(targets[0].cost,2);assert.equal(raid(targets[0]),0);}
        if(!p.lethal) {
            if(task.card===targets[8]&&task.target===leader&&p.mode==="leader-hp") {
                const row=unitRows.find(r=>r.card===task.card);unitRows.splice(unitRows.indexOf(row),1);
            }
            ongoing(`after-${task.role}-${taskAt}`);
        }
    }
    function finishFocus() {
        if(p.lethal) {
            assert.ok(eg.over);assert.equal(eg.winner,eg.seatOf((p.lethal==="own"?enemy:own).id));
            const target=p.lethal==="own"?own.base:enemy.base;assert.equal(target.damage,target.getHp());
            assert.equal(id(own.base),baseId);assert.equal(id(enemy.base),enemyBaseId);
        } else {
            assert.equal(leader.deployed,p.lifecycle?false:p.mode!=="leader-raid"&&!p.offboard&&p.laterEntry||!!p.deployedEntry);
            if(p.lifecycle){assert.equal(leader.zoneName,"base");assert.equal(leader.exhausted,true);}
            ongoing("focused-settled");
        }
        witness.observations.push({payments,attacks});settled=true;
    }
    try {
        while(!eg.over&&step<5000) {
            const pid=eg.ids.find(id=>eg.legalActions(id).length);assert.ok(pid);
            const actions=expandActions(eg,eg.legalActions(pid)),window=eg.isActionWindow(pid),prompt=eg.player(pid).currentPrompt();
            if(window&&!settled) {
                while(taskAt<tasks.length&&complete(tasks[taskAt])){checkTask(tasks[taskAt]);taskAt++;}
                if(taskAt===tasks.length)finishFocus();
            }
            if(window)records.push({type:"state",step,actor:eg.seatOf(pid),state:fullState(eg,pid)});
            let chosen;
            if(!settled) {
                const task=tasks[taskAt];
                if(window) {
                    if(task?.player?.id===pid&&(task.role!=="attack"||!task.card.exhausted)) {
                        chosen=actions.find(a=>a.cardUuid===task.card.uuid);
                        if(chosen){if(task.role==="attack"){task.started=true;task.offPower=task.card.getPower();}
                            else if(["play","damage"].includes(task.role))pendingPayment={card:task.card,player:task.player,ready:task.player.resources.filter(c=>!c.exhausted).length};}
                    }
                    chosen??=actions.find(a=>a.arg==="pass");
                } else {
                    if(task?.target)chosen=actions.find(a=>a.cardUuid===task.target.uuid);
                    chosen??=actions.find(a=>a.kind==="button"&&/deploy/i.test(a.label??""));
                    chosen??=actions.find(a=>a.kind==="button"&&/trigger|resolve/i.test(a.label??"")&&!/pass|cancel/i.test(a.label??""));
                    chosen??=actions.find(a=>a.arg==="done");chosen??=actions.length===1?actions[0]:undefined;
                }
            }
            chosen??=bot.choose({game:eg,pid,actions,rng});assert.ok(chosen);
            records.push({type:"decision",step,actor:eg.seatOf(pid),prompt:{type:prompt.promptType??null,title:prompt.menuTitle??null,
                selected:(eg.player(pid).promptState.selectedCards??[]).map(id),actionWindow:window},actions:actions.map(a=>canonicalAction(eg,a)),chosen:canonicalAction(eg,chosen).key,events:[]});
            eg.apply(pid,chosen,rng);step++;
        }
        if(!settled&&p.lethal&&eg.over) {
            assert.ok(complete(tasks[taskAt]));checkTask(tasks[taskAt]);taskAt++;assert.equal(taskAt,tasks.length);finishFocus();
        }
        assert.ok(settled,"All actual source-focused stages completed");assert.ok(eg.over,"Complete terminal game");
        records.push({type:"result",step,winner:eg.winner,state:fullState(eg)});witness.coverageObligationIds=[...scenario.coverageObligationIds];return {records,witness};
    }catch(error){error.diagnostic={records,witness};throw error;}finally{bot.close?.();}
}
module.exports={fixture,dependencies:["bot/cards/pipeline/base-zone-probes.js","bot/cards/pipeline/base-zone-probe-fixture.js","bot/cards/pipeline/probe-fixture.js",
    "bot/cards/pipeline/arena-token-probes.js","bot/cards/pipeline/weakness-continuation-probes.js","bot/omni/rs/make-pool.js","bot/env.js","bot/omni/rs/state.js","bot/players/index.js"]};
