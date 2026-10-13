"use strict";
const assert = require("node:assert/strict");
const {constructProbeFixture} = require("./probe-fixture");
const {fullState, expandActions, canonicalAction} = require("../../omni/rs/state");
function entryChoice(actions, probe) {
    const plain = value => (value ?? "").replace(/<[^>]*>/g, "");
    const title = probe.entryOrder === "bulk" ? probe.registrations.find(r=>r.trigger==="whenPlayed")?.title : "Shielded";
    return actions.find(a=>a.kind==="button" && plain(a.label)===plain(title));
}
async function fixture(env, pool, scenario, seed) {
    const p = scenario.probe;
    assert.equal(p.family,"arena-token");
    const reverse = p.sourceSeat === 2;
    const relative = owner => reverse ? owner === "self" ? "opponent" : "self" : owner;
    const specs = p.targets.map(t => ({...t, owner:relative(t.owner), attachments:t.attachments?.map(a => ({...a,
        ...(a.owner ? {owner:relative(a.owner)} : {})}))}));
    const sourceIndex = specs.length;
    if (reverse) specs.push({code:p.cardId,owner:"opponent",zone:"hand",arena:p.sourceArena});
    const setup = await constructProbeFixture(env,pool,{...scenario,probe:{...p,targets:specs}},seed);
    const {eg,rng,bot,deck} = setup;
    const own = reverse ? setup.enemy : setup.own, enemy = reverse ? setup.own : setup.enemy;
    const source = reverse ? setup.targets[sourceIndex] : setup.source;
    const targets = setup.targets.slice(0,p.targets.length), old = p.oldSourceIndex != null ? targets[p.oldSourceIndex] : null;
    const id = card => eg.cardId(card.uuid), live = card => card.isUnit?.() && card.isInPlay();
    const ready = () => own.resources.filter(c => !c.exhausted).length;
    const queue = [];
    if (p.prepareOldSource) queue.push({card:old,role:"prepare-old"});
    for (const event of p.eventCards.filter(e => e.role === "before")) queue.push({...event,card:targets[event.index],target:targets[event.targetIndex]});
    queue.push({card:source,role:"focus"});
    if (p.laterEntrantIndex != null) queue.push({card:targets[p.laterEntrantIndex],role:"new-entrant"});
    for (const event of p.eventCards.filter(e => e.role !== "before")) queue.push({...event,card:targets[event.index],target:event.targetIndex == null ? source : targets[event.targetIndex]});
    const recipients = targets.filter((c,i) => !p.targets[i].zone && i !== p.oldSourceIndex);
    const acceptedSources = new Set([source,...(old ? [old] : [])]);
    const creations = [], attachments = [], payments = [], deaths = [], shieldDeaths = [];
    const tokenObjects = new Map();
    const witness = {coverageObligationIds:[],observations:[],events:[]};
    const records = [{type:"meta",schema:"omni-rs-trace-v1",pool:pool.provenance,seed,
        bots:["arena-token-probe","arena-token-probe"],decks:[deck,deck],scenario:scenario.name,
        constructionParameters:p,fixtureConstruction:"Normally play actual source and hand donors; staged ordinary/native recipients preserve printed identity. Independently assert token batches, actual unique/death/combat lifecycle before complete terminal continuation"}];
    let step=0, queueAt=0, pending=null, payBefore=null, armed=false, settled=false, baseline=null;
    let attackStarted=false, attackEnded=false, menuChecked=false, combatBefore=null, oldBefore=null;
    const qualified = (card, physicalSource) => {
        if (p.mode === "shielded") return card.hasSomeKeyword("shielded");
        if (p.mode === "other-friendly") return card !== physicalSource;
        if (p.mode === "rebel-death") return card.hasSomeTrait("rebel");
        return card.damage > 0;
    };
    const snapshot = card => ({card,zone:card.zoneName,power:card.getPower(),hp:card.getHp(),damage:card.damage,
        upgrades:card.upgrades.slice(),ids:card.upgrades.map(id),eligible:card.controller===own && qualified(card,source)});
    eg.game.on("onCardPlayed",event => {
        if (settled || event.isCancelledOrReplaced || !pending || event.card !== pending.card) return;
        assert.ok(payBefore != null);
        const expected = event.card.cost + 2*own.getPenaltyAspects(event.card.aspects).length;
        assert.equal(payBefore-ready(),expected,"Exact printed/aspect payment for source and every actual donor");
        payments.push({card:id(event.card),role:pending.role,expected}); payBefore=null;
        queueAt++; pending=null;
    });
    eg.game.on("onTokensCreated",event => {
        if (!armed || settled || !acceptedSources.has(event.context.source)) return;
        const title = event.context.ability?.getTitle(event.context) ?? null;
        const intrinsic = (title ?? "").replace(/<[^>]*>/g, "") === "Shielded";
        witness.events.push({name:"onTokensCreated",title,intrinsic,source:id(event.context.source),targets:event.cards.map(id)});
        const expected = intrinsic ? live(event.context.source) ? [event.context.source] : []
            : own.getArenaUnits().filter(c => qualified(c,event.context.source));
        const tokens = event.generatedTokens ?? [];
        assert.ok(expected.length > 0,"An empty token system creates no allocation event");
        assert.deepEqual(event.cards.map(id),expected.map(id),"Source-derived recipient order and physical exclusion");
        assert.equal(tokens.length,expected.length,"Literal one token per recipient");
        const numbers = tokens.map(t => Number(id(t).slice(1)));
        for (let i=0;i<tokens.length;i++) {
            assert.equal(tokens[i].zoneName,"outsideTheGame"); assert.equal(tokens[i].isAttached(),false);
            assert.equal(tokens[i].owner,expected[i].controller); tokenObjects.set(id(tokens[i]),tokens[i]);
            if (i) assert.equal(numbers[i],numbers[i-1]+1,"All batch identities allocated contiguously before attachments");
        }
        creations.push({source:id(event.context.source),title,intrinsic,cause:event.context.event?.name ?? null,
            targets:expected.map(id),tokens:tokens.map(id),type:event.tokenType});
    });
    eg.game.on("onUpgradeAttached",event => {
        if (armed && !settled && acceptedSources.has(event.context.source))
            attachments.push({source:id(event.context.source),token:id(event.upgradeCard),host:id(event.parentCard)});
    });
    eg.game.on("onCardDefeated",event => {
        if (!armed || settled) return;
        deaths.push({card:id(event.card),zone:event.card.zoneName});
        if (event.card.isShield?.()) shieldDeaths.push(event.card);
    });
    eg.game.on("onAttackDeclared",event => {
        if (settled || !attackStarted) return;
        combatBefore = {attacker:event.attack.attacker,defender:event.attack.targets[0],
            power:event.attack.attacker.getPower(),retaliation:event.attack.targets[0].isUnit?.() ? event.attack.targets[0].getPower() : 0,
            attackerDamage:event.attack.attacker.damage,defenderDamage:event.attack.targets[0].damage,
            attackerHp:event.attack.attacker.getHp(),defenderHp:event.attack.targets[0].isUnit?.() ? event.attack.targets[0].getHp() : event.attack.targets[0].getHp()};
    });
    eg.game.on("onAttackEnd",() => {if (attackStarted && !settled) attackEnded=true;});
    function checkEntry() {
        const allocated=creations.flatMap(c => c.tokens);
        assert.equal(new Set(allocated).size,allocated.length);
        assert.deepEqual(attachments,creations.flatMap(c => c.tokens.map((token,i) => ({source:c.source,token,host:c.targets[i]}))));
        if (p.uniqueChoice) {
            const survivor=p.uniqueChoice === "old" ? old : source, dead=p.uniqueChoice === "old" ? source : old;
            assert.equal(dead.zoneName,"discard"); assert.ok(live(survivor));
            const printed=pool.cards.find(c=>c.setCode===p.cardId);
            const before=p.uniqueChoice === "old" ? oldBefore : {power:printed.power,hp:printed.hp,damage:0};
            const xp=p.mode === "other-friendly" ? p.uniqueChoice === "old" ? 2 : 1 : p.mode === "rebel-death" ? 1 : 0;
            assert.equal(survivor.getPower(),before.power+xp,"Exact surviving physical source power");
            assert.equal(survivor.getHp(),before.hp+xp,"Exact surviving physical source HP");
            assert.equal(survivor.damage,before.damage);
            if (p.mode === "shielded") assert.equal(survivor.upgrades.filter(c=>c.internalName==="shield").length,p.uniqueChoice==="old"?3:2);
            if (dead === old && oldBefore) for (const token of oldBefore.upgrades) {
                assert.equal(token.isAttached(),false);assert.equal(token.zoneName,"outsideTheGame");
            }
            if (p.mode === "other-friendly") {
                assert.equal(creations.filter(c => c.source === id(source)).length,own.getArenaUnits().some(c => c !== source) ? p.uniqueChoice === "old" ? 2 : 1 : 0);
                assert.equal(survivor.upgrades.filter(c => c.internalName === "experience").length,p.uniqueChoice === "old" ? 2 : 1);
                for (const c of creations) assert.ok(!c.targets.includes(c.source));
            }
            if (p.mode === "rebel-death") assert.equal(survivor.upgrades.filter(c => c.internalName === "experience").length,1);
            if (p.mode === "shielded") {
                assert.equal(creations.filter(c => c.intrinsic).length,p.uniqueChoice === "old" ? 0 : 1,
                    "Captured discarded NEW cannot allocate its intrinsic self Shield");
                assert.equal(creations.filter(c => !c.intrinsic).length,1);
            }
        } else if (p.mode === "shielded") {
            assert.equal(creations.length,2); assert.equal(creations.filter(c => c.intrinsic).length,1);
            assert.deepEqual(creations.map(c => c.intrinsic),p.entryOrder === "bulk" ? [false,true] : [true,false]);
            assert.equal(source.upgrades.filter(c => c.internalName === "shield").length,2);
        } else {
            const ordinaryBatches=p.mode === "other-friendly" && p.defeatSource ? 2 : 1;
            const eligible=baseline.some(b => b.eligible);
            assert.equal(creations.length,eligible ? ordinaryBatches : 0);
        }
        for (const before of baseline) {
            const card=before.card;
            if (!live(card)) {
                assert.ok(p.cleanupRecipient && card === recipients[0],"Only the deliberate cleanup recipient can depart");
                for (const upgrade of [...before.upgrades,...attachments.filter(a => a.host === id(card)).map(a => tokenObjects.get(a.token))]) {
                    assert.ok(upgrade,"Every attached observed token retains an exact object");
                    assert.equal(upgrade.isAttached(),false);
                    if (upgrade.isToken?.()) assert.equal(upgrade.zoneName,"outsideTheGame");
                    else assert.ok(upgrade.owner.discard.includes(upgrade));
                }
                continue;
            }
            const tokens=attachments.filter(a => a.host === id(card)).map(a => a.token);
            const consumed=shieldDeaths.filter(t => before.ids.includes(id(t)) || tokens.includes(id(t))).map(id);
            assert.deepEqual(card.upgrades.map(id),[...before.ids,...tokens].filter(x => !consumed.includes(x)),"Exact appended identities and surviving attachment order");
            const n=creations.reduce((sum,c) => sum+c.targets.filter(x => x === id(card)).length,0);
            assert.equal(card.getPower(),before.power+(p.token === "experience" ? n : 0));
            assert.equal(card.getHp(),before.hp+(p.token === "experience" ? n : 0));
            if (!p.recipientCombat || card !== recipients[0] && card !== recipients[2]) assert.equal(card.damage,before.damage);
        }
        if (p.defeatSource) assert.equal(source.zoneName,"discard");
        if (p.consumePriorShield) assert.equal(baseline[0].ids.length,0,"Actual prior Shield was consumed while Shielded stayed present");
        if (p.cleanupRecipient) {
            assert.ok(!live(recipients[0]));
            assert.ok(deaths.some(d => d.card === id(recipients[0])));
            if (p.mode === "shielded") {
                const original=baseline.find(b=>b.card===recipients[0]);
                const ids=[...original.ids,...attachments.filter(a=>a.host===id(recipients[0])).map(a=>a.token)];
                assert.equal(ids.length,3,"Two existing Shields plus the actual bulk Shield");
                assert.deepEqual(shieldDeaths.filter(c=>ids.includes(id(c))).map(id),ids,"Each exact Shield consumed in attachment order before host death");
            }
        }
        if (p.recipientCombat) {
            assert.ok(attackEnded && combatBefore);
            const b=combatBefore;
            assert.equal(b.power,baseline.find(x => x.card === b.attacker).power+creations.reduce((n,c)=>n+c.targets.filter(x=>x===id(b.attacker)).length,0));
            if (live(b.attacker)) assert.equal(b.attacker.damage,b.attackerDamage+b.retaliation);
            if (b.defender.isBase()) assert.equal(b.defender.damage,Math.min(b.defenderHp,b.defenderDamage+b.power),"Experience changes persistent base combat damage");
            else if (live(b.defender)) assert.equal(b.defender.damage,b.defenderDamage+b.power);
        }
        if (p.laterEntrantIndex != null) {
            const entrant=targets[p.laterEntrantIndex];assert.ok(live(entrant));
            const entry=pool.cards.find(c=>c.setCode===p.targets[p.laterEntrantIndex].code);
            assert.equal(entrant.upgrades.filter(c=>c.internalName==="experience").length,1,"Late entrant gets only the captured death batch");
            assert.equal(entrant.getPower(),entry.power+1);assert.equal(entrant.getHp(),entry.hp+1);assert.equal(entrant.damage,0);
        }
        witness.observations.push({creations,attachments,payments,deaths,shieldDeaths:shieldDeaths.map(id)});
    }
    try {
        while (!eg.over && step<5000) {
            const pid=eg.ids.find(id => eg.legalActions(id).length); assert.ok(pid);
            const actions=expandActions(eg,eg.legalActions(pid)),window=eg.isActionWindow(pid),prompt=eg.player(pid).currentPrompt();
            if (window && queueAt === queue.length && !settled && (!p.recipientCombat || attackEnded) && (!p.sentinelMenu || menuChecked)) {checkEntry();settled=true;}
            if (window) records.push({type:"state",step,actor:eg.seatOf(pid),state:fullState(eg,pid)});
            let chosen;
            if (!settled) {
                if (window) {
                    if (queueAt<queue.length) {
                        const item=queue[queueAt];
                        if (pid===own.id) chosen=actions.find(a=>a.cardUuid===item.card.uuid);
                        if (chosen) {
                            pending=item;payBefore=ready();
                            if (item.role === "focus") {armed=true;baseline=recipients.map(snapshot);oldBefore=old && live(old) ? snapshot(old) : null;}
                        }
                    } else if (p.recipientCombat && !attackStarted && pid===own.id && !recipients[0].exhausted) {
                        chosen=actions.find(a=>a.cardUuid===recipients[0].uuid);if(chosen) attackStarted=true;
                    } else if (p.sentinelMenu && !attackStarted && pid===enemy.id) {
                        const attacker=recipients[p.sentinelMenu === "ground" ? 2 : 3];
                        chosen=actions.find(a=>a.cardUuid===attacker.uuid);if(chosen) attackStarted=true;
                    }
                    chosen ??= actions.find(a=>a.arg==="pass") ?? actions.find(a=>a.arg==="claimInitiative");
                } else {
                    if (p.uniqueChoice && /unique|copy|defeat/i.test(prompt.menuTitle ?? "")) {
                        const victim=p.uniqueChoice === "old" ? source : old;
                        chosen=actions.find(a=>a.cardUuid===victim.uuid);
                    }
                    if (attackStarted && !attackEnded && /target for attack/i.test(prompt.menuTitle ?? "")) {
                        if (p.sentinelMenu) {
                            const exposed=actions.filter(a=>a.kind==="card").map(a=>a.cardUuid);
                            if (p.sentinelMenu === "ground") assert.deepEqual(exposed,[source.uuid],"Actual ground Sentinel excludes friendly other units and base");
                            else {assert.ok(exposed.includes(own.base.uuid));assert.ok(exposed.includes(recipients[1].uuid));assert.ok(!exposed.includes(source.uuid));}
                            chosen=actions.find(a=>a.arg==="cancel"); assert.ok(chosen);menuChecked=true;
                        } else chosen=actions.find(a=>a.cardUuid===enemy.base.uuid);
                    }
                    if (!chosen && p.mode === "shielded") chosen=entryChoice(actions,p);
                    if (!chosen && pending?.target) chosen=actions.find(a=>a.cardUuid===pending.target.uuid);
                    chosen ??= actions.find(a=>a.kind==="button" && /trigger|resolve/i.test(a.label ?? "") && !/pass|cancel/i.test(a.label ?? ""));
                    chosen ??= actions.find(a=>a.arg==="done");
                    chosen ??= actions.length===1 ? actions[0] : undefined;
                }
            }
            chosen ??= bot.choose({game:eg,pid,actions,rng});assert.ok(chosen);
            records.push({type:"decision",step,actor:eg.seatOf(pid),prompt:{type:prompt.promptType ?? null,title:prompt.menuTitle ?? null,
                selected:(eg.player(pid).promptState.selectedCards ?? []).map(id),actionWindow:window},
                actions:actions.map(a=>canonicalAction(eg,a)),chosen:canonicalAction(eg,chosen).key,events:[]});
            eg.apply(pid,chosen,rng);step++;
        }
        assert.ok(settled,"Source-focused behavior settled");assert.ok(eg.over,"Complete terminal trace");
        records.push({type:"result",step,winner:eg.winner,state:fullState(eg)});
        witness.coverageObligationIds=[...scenario.coverageObligationIds];return {records,witness};
    } catch(error) {error.diagnostic={records,witness};throw error;}
    finally {bot.close?.();}
}
module.exports={fixture,entryChoice,dependencies:["bot/cards/pipeline/arena-token-probes.js","bot/cards/pipeline/arena-token-probe-fixture.js",
    "bot/cards/pipeline/arena-damage-probes.js","bot/cards/pipeline/weakness-continuation-probes.js","bot/cards/pipeline/probe-fixture.js",
    "bot/omni/rs/make-pool.js","bot/env.js","bot/omni/rs/state.js","bot/players/index.js"]};
