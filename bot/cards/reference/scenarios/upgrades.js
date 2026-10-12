'use strict';
// Printed-source upgrade oracle generator. The constructor is copied from the
// token-unit primitive to disclose additional initial hand/exhaustion positions
// and to script ordinary actions by either seat. No post-capture state edits.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Env,seededRng}=require('../../../env'),{loadPool}=require('../../../omni/rs/pool'),{canonicalAction,fullState,expandActions}=require('../../../omni/rs/state'),{makeBot}=require('../../../players');
const unit=(key,code,owner='own',damage=0,shields=0)=>({key,code,owner,damage,shields});
const matches=(c,code)=>[c.cardData.setId,...(c.cardData.setCodes??[])].some(s=>s.set+'_'+String(s.number).padStart(3,'0')===code);
const arena=c=>c.cardData.arena==='space'?'spaceArena':'groundArena';const plain=[];
function deckFor(pool, scenario) {
    const codes = [...new Set([...(scenario.units ?? plain).map((u) => u.code), ...scenario.plan.filter((s) => s.from !== 'leader').map((s) => s.code), ...(scenario.initialHandCodes ?? []), ...(scenario.extraCodes ?? [])])];
    assert.ok(codes.length <= 17);
    for (const code of [...codes, scenario.leaderCode ?? 'SOR_014', scenario.baseCode ?? 'SOR_023'])
        assert.ok(pool.cards.some((c) => c.setCode === code), `Missing ${code} in oracle input pool`);
    const filler = pool.cards.filter((c) => c.types.includes('unit') && !c.text && !codes.includes(c.setCode)).slice(0, 17 - codes.length).map((c) => c.setCode);
    assert.equal(filler.length, 17 - codes.length);
    return { metadata: { name: 'Event group oracle', author: 'omni-rs fixture' }, leader: { id: scenario.leaderCode ?? 'SOR_014', count: 1 }, base: { id: scenario.baseCode ?? 'SOR_023', count: 1 }, deck: [...codes, ...filler].map((id, i) => ({ id, count: i === 16 ? 2 : 3 })), isPresentInDb: false };
}
async function fixture(env, pool, scenario, seed) {
    const deck = deckFor(pool, scenario), eg = env.newGame({ seed, deck1: deck, deck2: deck }), rng = seededRng('group-fixture-' + seed), bot = makeBot('random');
    await eg.start();
    while (!eg.ids.some((pid) => eg.isActionWindow(pid))) {
        const pid = eg.ids.find((id) => eg.legalActions(id).length), actions = expandActions(eg, eg.legalActions(pid));
        const initiativeChoice = scenario.initiative && actions.find(a => a.label === (pid === eg.ids[scenario.initiative === 'own' ? 0 : 1] ? 'Yourself' : 'Opponent'));
        eg.apply(pid, initiativeChoice ?? bot.choose({ game: eg, pid, actions, rng }), rng);
    }
    const own = eg.player(eg.ids[0]), enemy = eg.player(eg.ids[1]), targets = { ownBase: own.base, enemyBase: enemy.base };
    targets.leader = own.getAllDeckLeaders()[0];
    if (scenario.deployedLeader) {
        targets.leader.deploy({ type: 'leaderUnit' });
        targets.leader.deployEpicActionLimit.increment(own);
        targets.leader.exhausted = false;
    }
    const all = (p) => [...p.drawDeck, ...p.getCardsInZone('hand'), ...p.getCardsInZone('resource')];
    const take = (p, code) => { const c = all(p).find((c) => matches(c, code)); assert.ok(c, `No real ${code}`); return c; };
    for (const u of scenario.units ?? plain) {
        const p = u.owner === 'enemy' ? enemy : own, c = take(p, u.code);
        c.moveTo(arena(c));
        c.exhausted = !!u.exhausted;
        targets[u.key] = c;
        for (let i = 0; i < (u.shields ?? 0); i++)
            eg.game.generateToken(p, 'shield').attachTo(c);
    }
    for (const code of new Set([...scenario.plan.filter((s) => !s.from).map((s) => s.code), ...(scenario.initialHandCodes ?? [])])) {
        const count = Math.max(1, scenario.plan.filter((s) => !s.from && s.code === code).length);
        while (own.getCardsInZone('hand').filter((c) => matches(c, code)).length < count) {
            const c = all(own).find((c) => matches(c, code) && c.zoneName !== 'hand');
            assert.ok(c, `Not enough real script copies ${code}`);
            c.moveTo('hand');
        }
    }
    for (const p of [own, enemy]) {
        for (const c of p.drawDeck.slice(0, 24)) {
            c.moveTo('resource');
            c.exhausted = false;
        }
        for (const c of p.getCardsInZone('resource'))
            c.exhausted = false;
        p.base.damage = scenario.baseDamage ?? (scenario.bothLethal ? p.base.cardData.hp - 1 : Math.min(24, p.base.cardData.hp - 6));
    }
    if (scenario.ownBaseUndamaged)
        own.base.damage = 0;
    if (scenario.emptyOwnHand) {
        for (const c of own.getCardsInZone('hand')) {
            c.moveTo('resource');
            c.exhausted = false;
        }
    }
    if (scenario.emptyOwnDeck) {
        for (const c of own.drawDeck.slice())
            c.moveTo('discard');
    }
    if (scenario.noReadyResources) for (const p of [own, enemy]) for (const c of p.getCardsInZone('resource')) c.exhausted = true;
    eg.game.resolveGameState(true);
    for (const u of scenario.units ?? plain)
        if (u.damage)
            targets[u.key].damage = u.damage;
    eg.game.continue();
    for (const u of scenario.units ?? plain)
        if (u.shields) {
            assert.equal(targets[u.key].upgrades.length, u.shields);
            assert.ok(targets[u.key].damage < targets[u.key].getHp(), 'Constructed Shield unit must survive initial damage');
        }
    const initialRound = eg.round, observed = {}, scratch = {}, initialState = fullState(eg), records = [{ type: 'meta', schema: 'omni-rs-trace-v1', pool: pool.provenance, seed, bots: ['scripted-group-fixture', 'scripted-group-fixture'], decks: [deck, deck], scenario: scenario.name,
            evidenceStatus: pool.oracleOnly ? 'PROTOTYPE engine observation; admission/conformance unassessed' : 'Engine observation; native/Wasm conformance unassessed', fixtureConstruction: (scenario.emptyOwnDeck ? 'Empty-deck scenario additionally moves all remaining p1 draw-deck cards into discard before initial state capture. ' : '') + (scenario.emptyOwnHand ? 'Empty-hand scenario additionally moves every initial p1 hand card into ready resources before initial state capture. ' : '') + 'At first natural action window, move specified real deck units into their printed arenas with specified exhaustion, move script cards into p1 hand, move24 remaining deck cards perplayer into ready resources, ready all resources, set bases damage24(orprintedHP-1 forbothLethal), resolve game state, then set disclosed survivingunitdamage and refreshprompts. Specified initial Shields are created with pinned game.generateToken and attached before state resolution. No later state edits.', constructionParameters: { emptyOwnDeck: !!scenario.emptyOwnDeck, emptyOwnHand: !!scenario.emptyOwnHand, units: scenario.units ?? plain, plan: scenario.plan, bothLethal: !!scenario.bothLethal, leaderCode: scenario.leaderCode, deployedLeader: !!scenario.deployedLeader, baseDamage: scenario.baseDamage, initiative: scenario.initiative } }];
    records[0].fixtureConstruction += ' Additional disclosed constructor options: initialHandCodes moves specified real cards into p1 hand before resource allocation; noReadyResources exhausts all resources before initial capture. Plans actor=enemy script normal p2 inputs. No later direct state edits.';
    Object.assign(records[0].constructionParameters, {initialHandCodes: scenario.initialHandCodes ?? [], noReadyResources: !!scenario.noReadyResources});
    let step = 0, index = 0, pending = null, scriptObserved = false, laterObserved = false;
    try {
        while (!eg.over && step < 4000) {
            const pid = eg.ids.find((id) => eg.legalActions(id).length), actions = expandActions(eg, eg.legalActions(pid)), atWindow = eg.isActionWindow(pid), ctx = { eg, own, enemy, targets, actions, pid, atWindow, index, pending, step, observed, scratch, initialState };
            if (atWindow && scriptObserved && !laterObserved && eg.round > initialRound && scenario.assertLater) {
                scenario.assertLater(ctx);
                observed.laterRoundAssertion = true;
                laterObserved = true;
            }
            scenario.beforeWindow?.(ctx);
            if (atWindow) {
                records.push({ type: 'state', step, state: fullState(eg, pid) });
                if (!scriptObserved && index === scenario.plan.length && eg.round === initialRound) {
                    scenario.assertAfter(ctx);
                    observed.postAction = true;
                    scriptObserved = true;
                }
            }
            let chosen;
            if (eg.round === initialRound && atWindow) {
                if (index < scenario.plan.length && pid === (scenario.plan[index].actor === 'enemy' ? enemy.id : own.id)) {
                    pending = scenario.plan[index++];
                    ctx.pending = pending;
                    ctx.index = index;
                    const c = pending.from ? targets[pending.from] : own.getCardsInZone('hand').find((c) => matches(c, pending.code));
                    assert.ok(c, `Missing script ${pending.code}`);
                    chosen = actions.find((a) => a.cardUuid === c.uuid);
                    assert.ok(chosen, `Illegal script ${pending.code}`);
                    scratch.incoming = c;
                }
                else
                    chosen = actions.find((a) => a.arg === 'pass');
            }
            else if (eg.round === initialRound && !atWindow && pending && !scriptObserved) {
                chosen = scenario.choose?.(ctx);
                if (!chosen && pid === (pending.actor === 'enemy' ? enemy.id : own.id) && pending.target)
                    chosen = actions.find((a) => a.cardUuid === targets[pending.target]?.uuid);
                chosen ??= actions.find((a) => a.kind === 'button' && /trigger|resolve|play|deal|heal|give/i.test(a.label ?? '') && !/pass|cancel|no/i.test(a.label ?? ''));
            }
            chosen ??= scenario.chooseLater?.(ctx);
            chosen ??= bot.choose({ game: eg, pid, actions, rng });
            assert.ok(chosen);
            const prompt = eg.player(pid).currentPrompt();
            records.push({ type: 'decision', step, actor: eg.seatOf(pid), prompt: { type: prompt.promptType ?? null, title: prompt.menuTitle ?? null, selected: (eg.player(pid).promptState.selectedCards ?? []).map((c) => eg.cardId(c.uuid)), actionWindow: atWindow }, actions: actions.map((a) => canonicalAction(eg, a)), chosen: canonicalAction(eg, chosen).key, events: [] });
            if (process.env.GROUP_FIXTURE_DEBUG && step < 35)
                console.error(JSON.stringify({ step, actor: eg.seatOf(pid), title: prompt.menuTitle, selected: (eg.player(pid).promptState.selectedCards ?? []).map(c => eg.cardId(c.uuid)), chosen: canonicalAction(eg, chosen) }));
            scenario.beforeApply?.({ ...ctx, chosen });
            eg.apply(pid, chosen, rng);
            step++;
        }
        assert.ok(eg.over, 'Oracle game did not complete');
        assert.equal(index, scenario.plan.length, 'Script incomplete');
        if (!scriptObserved) {
            scenario.assertAfter({ eg, own, enemy, targets, observed, scratch, initialState });
            observed.postAction = true;
        }
        if (scenario.assertLater)
            assert.ok(laterObserved, 'Missing later-round assertion');
        scenario.assertWitness?.({ observed, scratch, records, eg, own, enemy, targets, initialState });
        records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
        return { records, witness: { scenario: scenario.name, family: scenario.family, observed, decisions: step, winner: eg.winner } };
    }
    catch(error) {
        const failure = {type:'failure',step,index,error:String(error.stack ?? error),observed,boundaries:scratch.boundaries,attachmentIds:scratch.chain?.map(t=>eg.cardId(t.uuid)),discardIds:own.getCardsInZone('discard').map(t=>eg.cardId(t.uuid))};
        if(scenario.failureOut) fs.writeFileSync(path.join(scenario.failureOut,scenario.name+'.failed.jsonl.gz'),zlib.gzipSync([...records,failure].map(x=>JSON.stringify(x)).join('\n')+'\n'));
        console.error(JSON.stringify(failure)); throw error;
    }
    finally {
        bot.close?.();
    }
}
function record(c){if(c.observed.postAction)return;if(!c.observed.postAction&&c.atWindow&&c.chosen.kind==='card'){if(!c.scratch.initial){c.scratch.initial=true;c.scratch.baseline=Object.fromEntries(Object.entries(c.targets).filter(([,t])=>t.isUnit?.()&&t.isInPlay()).map(([k,t])=>[k,{power:t.getPower(),hp:t.getHp(),damage:t.damage}]));c.scratch.ready=c.own.getCardsInZone('resource').filter(t=>!t.exhausted).length;c.scratch.upgradeCards=[];c.scratch.boundaries=[];for(const name of ['onUpgradeAttached','onCardDefeated','onCardExhausted'])c.eg.game.on(name,e=>{if(c.observed.postAction)return;const t=e.upgradeCard??e.card;if(t)c.scratch.boundaries.push({name,id:c.eg.cardId(t.uuid),internalName:t.internalName,zone:t.zoneName});});}if(c.scratch.incoming.isUpgrade?.())c.scratch.upgradeCards.push(c.scratch.incoming);}}
function attached(c,u,parent){assert.equal(u.parentCard.uuid,parent.uuid);assert.equal(u.controller.id,c.own.id);assert.equal(u.owner.id,c.own.id);assert.equal(u.zoneName,parent.zoneName);assert.ok(parent.upgrades.includes(u));}
const scenarios=[];
for(const owner of ['own','enemy'])for(const space of [false,true])scenarios.push({name:'protector-'+owner+'-'+(space?'space':'ground')+'-parent',family:'ordinary-upgrade-attachment-matrix',actualScriptedCardIds:['SOR_057'],units:[unit('parent',space?'JTL_212':'ASH_261',owner)],baseDamage:0,plan:[{code:'SOR_057',target:'parent'}],beforeApply:record,assertAfter:c=>{const u=c.scratch.upgradeCards[0],p=c.targets.parent,b=c.scratch.baseline.parent;attached(c,u,p);assert.equal(p.controller.id,owner==='own'?c.own.id:c.enemy.id);assert.equal(p.getPower(),b.power+1);assert.equal(p.getHp(),b.hp+1);assert.equal(p.hasSomeKeyword('sentinel'),true);assert.equal(c.eg.game.getArenaUnits().includes(u),false);c.observed.upgradeId=c.eg.cardId(u.uuid);c.observed.hostController=c.eg.seatOf(p.controller.id);}});
scenarios.push({name:'nameless-valor-actual-created-mandalorian-parent',family:'ordinary-upgrade-token-parent',actualScriptedCardIds:['ASH_111','TWI_119'],units:[],baseDamage:0,plan:[{code:'ASH_111'},{code:'TWI_119',target:'token'}],beforeApply:record,beforeWindow:c=>{if(c.scratch.initial&&!c.targets.token){const t=c.own.getArenaUnits().find(t=>t.internalName==='mandalorian');if(t)c.targets.token=t;}},assertAfter:c=>{const p=c.targets.token,u=c.scratch.upgradeCards[0];attached(c,u,p);assert.equal(p.getPower(),4);assert.equal(p.getHp(),4);assert.equal(p.hasSomeKeyword('overwhelm'),true);assert.equal(p.hasSomeKeyword('shielded'),true);assert.deepEqual(p.upgrades.map(t=>t.internalName),['shield','nameless-valor']);c.observed.attachmentIds=p.upgrades.map(t=>c.eg.cardId(t.uuid));}});
scenarios.push({name:'protector-deployed-leader-undeploy-cleanup',family:'ordinary-upgrade-leader-cleanup',actualScriptedCardIds:['SOR_057','SOR_014'],units:[],deployedLeader:true,baseDamage:0,plan:[{code:'SOR_057',target:'leader'},{code:'TWI_170',target:'leader'},{code:'SOR_077',target:'leader'}],beforeApply:c=>{record(c);if(!c.observed.postAction&&c.atWindow&&c.pending?.code==='SOR_077'){assert.equal(c.targets.leader.getHp(),6);assert.equal(c.targets.leader.damage,2);c.observed.deployedLeaderWithPrintedBonus=true;}},assertAfter:c=>{assert.ok(c.observed.deployedLeaderWithPrintedBonus);assert.equal(c.targets.leader.deployed,false);assert.equal(c.targets.leader.zoneName,'base');assert.equal(c.scratch.upgradeCards[0].zoneName,'discard');assert.ok(c.targets.leader.deployEpicActionLimit.isAtMax(c.own));c.observed.leaderUndeployedUpgradeDiscarded=true;}});
scenarios.push({name:'mark-my-words-damaged-attach-candidates',family:'ordinary-upgrade-attach-predicate',actualScriptedCardIds:['ASH_181'],units:[unit('ownDamaged','ASH_261','own',1),unit('enemyDamaged','ASH_261','enemy',1),unit('invalid','ASH_261')],baseDamage:0,plan:[{code:'ASH_181',target:'enemyDamaged'}],beforeApply:record,choose:c=>{if(!c.eg.player(c.pid).currentPrompt().menuTitle?.startsWith('Attach Mark'))return;assert.deepEqual(c.actions.filter(a=>a.kind==='card').map(a=>a.cardUuid).sort(),[c.targets.ownDamaged.uuid,c.targets.enemyDamaged.uuid].sort());c.observed.exactDamagedCandidateSet=true;return c.actions.find(a=>a.cardUuid===c.targets.enemyDamaged.uuid);},assertAfter:c=>{assert.ok(c.observed.exactDamagedCandidateSet);attached(c,c.scratch.upgradeCards[0],c.targets.enemyDamaged);assert.equal(c.targets.enemyDamaged.hasSomeKeyword('overwhelm'),true);}});
scenarios.push({name:'ascension-cable-nonvehicle-trait-boundary',family:'ordinary-upgrade-attach-trait',actualScriptedCardIds:['LOF_215'],units:[unit('valid','SEC_028'),unit('invalid','ASH_261','enemy')],baseDamage:0,plan:[{code:'LOF_215',target:'valid'}],beforeApply:record,choose:c=>{if(!c.eg.player(c.pid).currentPrompt().menuTitle?.startsWith('Attach Ascension'))return;assert.deepEqual(c.actions.filter(a=>a.kind==='card').map(a=>a.cardUuid),[c.targets.valid.uuid]);c.observed.vehicleExcluded=true;return c.actions.find(a=>a.cardUuid===c.targets.valid.uuid);},assertAfter:c=>{assert.ok(c.observed.vehicleExcluded);attached(c,c.scratch.upgradeCards[0],c.targets.valid);assert.equal(c.targets.valid.hasSomeKeyword('saboteur'),true);}});
scenarios.push({name:'protector-cancel-preserves-card-and-resources',family:'ordinary-upgrade-cancel',actualScriptedCardIds:['SOR_057'],units:[unit('parent','ASH_261')],baseDamage:0,plan:[{code:'SOR_057'}],beforeApply:record,choose:c=>{if(!c.eg.player(c.pid).currentPrompt().menuTitle?.startsWith('Attach Protector'))return;const a=c.actions.find(a=>a.arg==='cancel');assert.ok(a);c.observed.cancelled=true;return a;},assertAfter:c=>{assert.ok(c.observed.cancelled);assert.equal(c.scratch.upgradeCards[0].zoneName,'hand');assert.equal(c.targets.parent.upgrades.length,0);assert.equal(c.own.getCardsInZone('resource').filter(t=>!t.exhausted).length,c.scratch.ready);}});
for(const poor of [false,true])scenarios.push({name:poor?'protector-no-affordable-attachment':'ascension-cable-no-eligible-vehicle-parent',family:'ordinary-upgrade-play-legality',actualScriptedCardIds:[poor?'SOR_057':'LOF_215'],units:[unit('parent','ASH_261')],initiative:'own',baseDamage:0,initialHandCodes:[poor?'SOR_057':'LOF_215'],noReadyResources:poor,plan:[],assertAfter:c=>{const code=poor?'SOR_057':'LOF_215',u=c.own.getCardsInZone('hand').find(u=>matches(u,code));assert.ok(u);assert.equal(c.pid,c.own.id);assert.ok(!c.eg.legalActions(c.own.id).some(a=>a.cardUuid===u.uuid));if(poor)assert.equal(c.own.getCardsInZone('resource').filter(t=>!t.exhausted).length,0);c.observed.upgradeNotPlayable=true;}});
scenarios.push({name:'devotion-stacked-on-enemy-host-restores-enemy-base',family:'ordinary-upgrade-numeric-controller',actualScriptedCardIds:['HMW_096'],units:[unit('parent','ASH_261','enemy'),unit('defender','HMW_082')],baseDamage:24,plan:[{code:'HMW_096',target:'parent'},{code:'HMW_096',target:'parent'},{code:'ASH_261',from:'parent',actor:'enemy',target:'defender'}],beforeApply:c=>{record(c);if(!c.observed.postAction&&c.atWindow&&c.pending?.actor==='enemy'){assert.equal(c.targets.parent.getNumericKeywordTotal('restore'),4);c.observed.restoreTotalBeforeAttack=4;}},choose:c=>{if(c.eg.player(c.pid).currentPrompt().menuTitle==='Choose a target for attack')return c.actions.find(a=>a.cardUuid===c.targets.defender.uuid);},assertAfter:c=>{assert.equal(c.observed.restoreTotalBeforeAttack,4);assert.equal(c.enemy.base.damage,20);assert.equal(c.own.base.damage,24);for(const u of c.scratch.upgradeCards)attached(c,u,c.targets.parent);assert.equal(c.targets.parent.controller.id,c.enemy.id);c.observed.hostControllerReceivedRestore=true;}});
for(const bounce of [false,true])scenarios.push({name:'mixed-attachment-order-parent-'+(bounce?'bounce':'defeat'),family:'ordinary-upgrade-framework-cleanup',actualScriptedCardIds:['SOR_057','HMW_096'],units:[unit('parent','ASH_261','own',0,1)],baseDamage:0,plan:[{code:'SOR_057',target:'parent'},{code:'LAW_165',target:'parent'},{code:'HMW_096',target:'parent'},{code:bounce?'TWI_226':'ASH_067',target:'parent'}],beforeApply:c=>{record(c);if(!c.observed.postAction&&c.atWindow&&['TWI_226','ASH_067'].includes(c.pending?.code)){assert.deepEqual(c.targets.parent.upgrades.map(t=>t.internalName),['shield','protector','experience','experience','devotion']);c.scratch.chain=c.targets.parent.upgrades.slice();c.observed.initialAttachmentIds=c.scratch.chain.map(t=>c.eg.cardId(t.uuid));}},assertAfter:c=>{assert.equal(c.targets.parent.zoneName,bounce?'hand':'discard');assert.equal(c.scratch.chain.length,5);for(const t of c.scratch.chain)assert.equal(t.zoneName,t.isToken()?'outsideTheGame':'discard');const ordinary=c.scratch.chain.filter(t=>!t.isToken());assert.deepEqual(c.own.getCardsInZone('discard').filter(t=>ordinary.includes(t)).map(t=>c.eg.cardId(t.uuid)),ordinary.slice().reverse().map(t=>c.eg.cardId(t.uuid)));const defeated=c.scratch.boundaries.filter(e=>e.name==='onCardDefeated'&&c.observed.initialAttachmentIds.includes(e.id));assert.deepEqual(defeated.map(e=>e.id),c.observed.initialAttachmentIds.slice().reverse(),'Pinned negative-order comparator reverses framework attachment defeat insertion');c.observed.orderedCleanupIds=defeated.map(e=>e.id);}});
for(const keep of ['same-parent','old','new'])scenarios.push({name:'revans-lightsabers-unique-'+keep,family:'ordinary-upgrade-uniqueness',actualScriptedCardIds:['LOF_238'],units:[unit('first','SEC_028','own',1),...(keep==='same-parent'?[]:[unit('second','SEC_028','own',2)])],baseDamage:0,plan:[{code:'LOF_238',target:'first'},{code:'LOF_238',target:keep==='same-parent'?'first':'second'}],beforeApply:record,choose:c=>{const title=c.eg.player(c.pid).currentPrompt().menuTitle;if(!title?.startsWith('Choose which'))return;assert.notEqual(keep,'same-parent','Same parent uniqueness auto-defeats oldest');assert.equal(c.pid,c.own.id);const [old,incoming]=c.scratch.upgradeCards;assert.deepEqual(c.actions.filter(a=>a.kind==='card').map(a=>a.cardUuid).sort(),[old.uuid,incoming.uuid].sort());assert.equal(c.targets.first.getHp(),6);assert.equal(c.targets.first.getPower(),5);assert.equal(c.targets.first.hasSomeKeyword('grit'),true);assert.equal(c.targets.second.getHp(),6,'Incoming printed HP is visible before uniqueness');assert.equal(c.targets.second.getPower(),4,'Incoming printed power visible without pending Grit');assert.equal(c.targets.second.hasSomeKeyword('grit'),false,'Incoming conditional ongoing grant waits for state resolution');c.observed.uniquePendingPrintedVsConstant=true;return c.actions.find(a=>a.cardUuid===(keep==='old'?incoming.uuid:old.uuid));},assertAfter:c=>{const [old,incoming]=c.scratch.upgradeCards;if(keep==='same-parent'){assert.equal(old.zoneName,'discard');attached(c,incoming,c.targets.first);assert.equal(c.targets.first.upgrades.length,1);assert.equal(c.targets.first.getHp(),6);assert.equal(c.targets.first.getPower(),5);c.observed.automaticOldestDefeat=true;}else{assert.ok(c.observed.uniquePendingPrintedVsConstant);const kept=keep==='old'?old:incoming,removed=keep==='old'?incoming:old,p=keep==='old'?c.targets.first:c.targets.second;assert.equal(removed.zoneName,'discard');attached(c,kept,p);assert.equal(p.hasSomeKeyword('grit'),true);assert.equal(p.getPower(),4+p.damage);c.observed.keptId=c.eg.cardId(kept.uuid);}}});
scenarios.push({name:'confiscate-ordinary-hp-grant-lethal-host',family:'ordinary-upgrade-removal-stat-death',actualScriptedCardIds:['SOR_057','SHD_262'],units:[unit('parent','ASH_261','own',2)],baseDamage:0,plan:[{code:'SOR_057',target:'parent'},{code:'TWI_170',target:'parent'},{code:'SHD_262',target:'upgrade'}],beforeApply:c=>{record(c);if(!c.observed.postAction&&c.atWindow&&c.pending?.code==='SHD_262'){c.targets.upgrade=c.scratch.upgradeCards[0];assert.equal(c.targets.parent.getHp(),5);assert.equal(c.targets.parent.damage,4);assert.equal(c.targets.parent.zoneName,'groundArena');c.observed.damagedHostAliveWithGrant=true;}},assertAfter:c=>{assert.ok(c.observed.damagedHostAliveWithGrant);assert.equal(c.targets.upgrade.zoneName,'discard');assert.equal(c.targets.parent.zoneName,'discard');c.observed.removalCausedStatDeath=true;}});
scenarios.push({name:'perilous-position-negative-hp-entry-before-parent-exhaust',family:'ordinary-upgrade-negative-hp-onplay',actualScriptedCardIds:['TWI_070'],units:[unit('parent','SEC_028','own',2)],baseDamage:0,plan:[{code:'TWI_070',target:'parent'}],beforeApply:record,assertAfter:c=>{assert.equal(c.targets.parent.zoneName,'discard');assert.equal(c.scratch.upgradeCards[0].zoneName,'discard');assert.ok(!c.scratch.boundaries.some(e=>e.name==='onCardExhausted'&&e.id===c.eg.cardId(c.targets.parent.uuid)),'Dead parent is not exhausted by guarded source onplay');c.observed.hpDeathBeforeGuardedOnPlay=true;}});
scenarios.push({name:'perilous-position-surviving-host-captured-onplay-exhaust',family:'ordinary-upgrade-negative-hp-onplay',actualScriptedCardIds:['TWI_070'],units:[unit('parent','HMW_082')],baseDamage:0,plan:[{code:'TWI_070',target:'parent'}],beforeApply:record,assertAfter:c=>{assert.equal(c.targets.parent.zoneName,'groundArena');attached(c,c.scratch.upgradeCards[0],c.targets.parent);assert.equal(c.targets.parent.getHp(),5);assert.equal(c.targets.parent.getPower(),0);assert.equal(c.targets.parent.exhausted,true);assert.ok(c.scratch.boundaries.some(e=>e.name==='onCardExhausted'&&e.id===c.eg.cardId(c.targets.parent.uuid)));c.observed.survivingHostReceivedCapturedExhaust=true;}});
module.exports = { scenarios, fixture };
