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
    const deck = deckFor(pool, scenario), eg = env.newGame({ selectionToggles: true, seed, deck1: deck, deck2: deck }), rng = seededRng('group-fixture-' + seed), bot = makeBot('random');
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
    if (scenario.finalResourceCounts) for (const [i,p] of [own,enemy].entries()) { const count=scenario.finalResourceCounts[i]; assert.ok(Number.isInteger(count)&&count>=0&&count<=50); for(const card of p.getCardsInZone('resource').slice(count)) card.moveTo('discard'); while(p.getCardsInZone('resource').length<count) { const card=p.drawDeck[0]; assert.ok(card); card.moveTo('resource'); card.exhausted=false; } }
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
    records[0].fixtureConstruction += ' Additional disclosed constructor options: finalResourceCounts moves excess resources into discard or deck cards into ready resources to establish exact initial per-controller totals BEFORE initial state capture.  initialHandCodes moves specified real cards into p1 hand before resource allocation; noReadyResources exhausts all resources before initial capture. Plans actor=enemy script normal p2 inputs. No later direct state edits.';
    Object.assign(records[0].constructionParameters, {finalResourceCounts: scenario.finalResourceCounts ?? null, initialHandCodes: scenario.initialHandCodes ?? [], noReadyResources: !!scenario.noReadyResources});
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
const u=(key,code,owner='own',damage=0,exhausted=false)=>({key,code,owner,damage,exhausted});
function before(c){if(c.observed.postAction||!c.atWindow||c.chosen.kind!=='card')return;c.scratch.initialPowers??=Object.fromEntries(Object.entries(c.targets).filter(([,t])=>t?.isUnit?.()&&t.isInPlay()).map(([k,t])=>[k,t.getPower()]));}
function addOneOwnResource(c){const title=c.eg.player(c.pid).currentPrompt().menuTitle??'';if(!/resource/i.test(title)||!c.actions.some(a=>a.kind==='card'))return;const selected=c.eg.player(c.pid).promptState.selectedCards??[];if(c.pid===c.own.id&&!selected.length)return c.actions.find(a=>a.kind==='card');return c.actions.find(a=>a.arg==='done');}
const scenarios=[];
for(const ownCount of [3,4])scenarios.push({name:'wroshyr-resource-pairs-'+ownCount+'-to-'+(ownCount+1),family:'live-controller-resource-floor-half',actualScriptedCardIds:['HMW_133'],baseCode:'HMW_019',units:[u('ownSource','HMW_133'),u('enemySource','HMW_133','enemy')],finalResourceCounts:[ownCount,5],baseDamage:0,plan:[{code:'SOR_073',target:'ownSource'}],beforeApply:c=>{before(c);if(!c.observed.postAction&&c.atWindow&&c.chosen.kind==='card'){assert.equal(c.targets.ownSource.getPower(),Math.floor(ownCount/2));assert.equal(c.targets.enemySource.getPower(),2);}},assertAfter:c=>{assert.equal(c.own.getCardsInZone('resource').length,ownCount);assert.equal(c.targets.ownSource.getPower(),Math.floor(ownCount/2));assert.equal(c.targets.enemySource.getPower(),2);assert.ok(c.own.getCardsInZone('resource').some(t=>t.exhausted));c.observed.spentResourceDidNotChangeTotalBonus=true;},chooseLater:addOneOwnResource,assertLater:c=>{assert.equal(c.own.getCardsInZone('resource').length,ownCount+1);assert.equal(c.enemy.getCardsInZone('resource').length,5);assert.equal(c.targets.ownSource.getPower(),Math.floor((ownCount+1)/2));assert.equal(c.targets.enemySource.getPower(),2);c.observed.resourcePairReevaluated=true;}});
scenarios.push({name:'chirpa-other-ewok-entry-removal',family:'live-affected-exclusion-nested-trait-count',actualScriptedCardIds:['HMW_164'],units:[u('source','HMW_164'),u('other','HMW_116'),u('opponent','HMW_116','enemy'),u('nonEwok','ASH_261')],baseDamage:0,plan:[{code:'HMW_116'},{code:'TWI_226',target:'other'}],beforeApply:c=>{before(c);if(!c.observed.postAction&&c.atWindow&&c.chosen.kind==='card'&&c.pending?.code==='HMW_116')assert.equal(c.targets.source.getPower(),2);if(!c.observed.postAction&&c.atWindow&&c.chosen.kind==='card'&&c.pending?.code==='TWI_226'){assert.equal(c.targets.source.getPower(),3);c.observed.entryIncreasedCount=true;}},assertAfter:c=>{assert.ok(c.observed.entryIncreasedCount);assert.equal(c.targets.other.zoneName,'hand');assert.equal(c.targets.source.getPower(),2);c.observed.excludedSourceOpponentAndNonEwok=true;}});
for(const [code,base,factor]of [['JTL_052',6,-1],['LOF_153',3,2]])scenarios.push({name:code.toLowerCase()+'-live-damage-heal-phase-interaction',family:'live-damage-signed-stat-expression',actualScriptedCardIds:[code],units:[u('source',code)],baseDamage:0,plan:[{code:'TWI_170',target:'source'},{code:'JTL_075',target:'source'},{code:'TWI_124',target:'source'}],beforeApply:c=>{before(c);if(c.observed.postAction||!c.atWindow||c.chosen.kind!=='card')return;if(c.pending?.code==='TWI_170')assert.equal(c.targets.source.getPower(),base);if(c.pending?.code==='JTL_075'){assert.equal(c.targets.source.damage,2);assert.equal(c.targets.source.getPower(),base+2*factor);c.observed.damagedPower=base+2*factor;}if(c.pending?.code==='TWI_124'){assert.equal(c.targets.source.damage,0);assert.equal(c.targets.source.getPower(),base);c.observed.healReevaluated=true;}},assertAfter:c=>{assert.ok(c.observed.healReevaluated);assert.equal(c.targets.source.getPower(),base+2);assert.equal(c.targets.source.damage,0);c.observed.phaseAndPersistentStatsCompose=true;}});
scenarios.push({name:'clone-squadron-space-count-removal-lethal',family:'live-space-count-hp-dependency',actualScriptedCardIds:['JTL_115'],units:[u('source','JTL_115','own',3),u('spaceOther','JTL_212'),u('groundOther','ASH_261'),u('opponentSpace','JTL_212','enemy')],baseDamage:0,plan:[{code:'JTL_212'},{code:'HMW_207',target:'source'},{code:'TWI_226',target:'spaceOther'}],beforeApply:c=>{before(c);if(c.observed.postAction||!c.atWindow||c.chosen.kind!=='card')return;if(c.pending?.code==='JTL_212'){assert.equal(c.targets.source.getHp(),4);assert.equal(c.targets.source.getPower(),4);}if(c.pending?.code==='HMW_207'){assert.equal(c.targets.source.getHp(),5);c.observed.spaceEntryRaisedHp=true;}if(c.pending?.code==='TWI_226'){assert.equal(c.targets.source.getHp(),5);assert.equal(c.targets.source.damage,4);assert.equal(c.targets.source.zoneName,'spaceArena');c.observed.damagedAliveBeforeCountDrop=true;}},assertAfter:c=>{assert.ok(c.observed.spaceEntryRaisedHp&&c.observed.damagedAliveBeforeCountDrop);assert.equal(c.targets.source.zoneName,'discard');assert.equal(c.targets.spaceOther.zoneName,'hand');assert.equal(c.targets.opponentSpace.damage,0);c.observed.countDropCausedHpDeath=true;}});
for(const zero of [false,true])scenarios.push({name:'kino-exhausted-other-count-'+(zero?'zero':'ready-transition'),family:'live-source-exclusion-exhausted-count',actualScriptedCardIds:['SEC_114'],units:[u('source','SEC_114','own',0,true),...(zero?[]:[u('ground','ASH_261','own',0,true),u('space','JTL_212','own',0,true)]),u('opponent','ASH_261','enemy',0,true)],baseDamage:0,plan:zero?[{code:'SOR_169',target:'source'}]:[{code:'SOR_169',target:'ground'},{code:'SOR_169',target:'source'}],beforeApply:c=>{before(c);if(!c.observed.postAction&&c.atWindow&&c.chosen.kind==='card'&&!c.scratch.checked){assert.equal(c.targets.source.getPower(),zero?1:3);c.scratch.checked=true;}},assertAfter:c=>{assert.equal(c.targets.source.exhausted,false);assert.equal(c.targets.source.getPower(),zero?1:2);c.observed.sourceAndOpponentExcluded=true;}});
scenarios.push({name:'pryce-ready-token-controller-active-interval',family:'live-ready-token-count',actualScriptedCardIds:['SEC_011','TWI_145','ASH_111'],leaderCode:'SEC_011',deployedLeader:true,units:[u('ordinary','ASH_261')],baseDamage:0,plan:[{code:'TWI_145'},{code:'SOR_169',target:'enemyToken'},{code:'ASH_111'},{code:'SOR_169',target:'ownToken'},{code:'SEC_011',from:'leader',target:'enemyBase'}],beforeWindow:c=>{c.targets.enemyToken??=c.enemy.getArenaUnits().find(t=>t.isTokenUnit());c.targets.ownToken??=c.own.getArenaUnits().find(t=>t.isTokenUnit());},beforeApply:c=>{before(c);if(c.observed.postAction||!c.atWindow||c.chosen.kind!=='card')return;if(c.pending?.code==='ASH_111'){assert.equal(c.targets.enemyToken.exhausted,false);assert.equal(c.targets.leader.getPower(),4);c.observed.enemyReadyTokenExcluded=true;}if(c.pending?.code==='SOR_169'&&c.pending.target==='ownToken'){assert.equal(c.targets.leader.getPower(),4);assert.equal(c.targets.ownToken.exhausted,true);}if(c.pending?.from==='leader'){assert.equal(c.targets.leader.getPower(),5);c.observed.ownReadyTokenCounted=true;}},assertAfter:c=>{assert.ok(c.observed.enemyReadyTokenExcluded&&c.observed.ownReadyTokenCounted);assert.equal(c.enemy.base.damage,5);assert.equal(c.targets.leader.getPower(),5);const spies=c.own.getArenaUnits().filter(t=>t.internalName==='spy');assert.equal(spies.length,1);assert.equal(spies[0].exhausted,true);c.observed.exhaustedSpyDidNotAddPower=true;}});
scenarios.push({name:'legion-controller-total-resource-regroup',family:'live-resource-hp-power',actualScriptedCardIds:['SOR_118'],units:[u('ownSource','SOR_118','own',2),u('enemySource','SOR_118','enemy',2)],finalResourceCounts:[3,5],initiative:'own',baseDamage:0,plan:[],assertAfter:c=>{assert.equal(c.targets.ownSource.getPower(),3);assert.equal(c.targets.ownSource.getHp(),3);assert.equal(c.targets.enemySource.getPower(),5);assert.equal(c.targets.enemySource.getHp(),5);c.observed.controllerRelativeTotals=true;},chooseLater:addOneOwnResource,assertLater:c=>{assert.equal(c.own.getCardsInZone('resource').length,4);assert.equal(c.targets.ownSource.getHp(),4);assert.equal(c.targets.ownSource.getPower(),4);assert.equal(c.targets.enemySource.getHp(),5);c.observed.liveHpReevaluated=true;}});
scenarios.push({name:'grievous-resource-sentinel-damage-heal',family:'live-resource-stats-keyword-interaction',actualScriptedCardIds:['TS26_050'],leaderCode:'TWI_015',baseCode:'HMW_019',units:[u('source','TS26_050')],finalResourceCounts:[4,7],baseDamage:0,plan:[{code:'HMW_207',target:'source'},{code:'JTL_075',target:'source'}],beforeApply:c=>{before(c);if(c.observed.postAction||!c.atWindow||c.chosen.kind!=='card')return;if(c.pending?.code==='HMW_207'){assert.equal(c.targets.source.getPower(),4);assert.equal(c.targets.source.getHp(),4);assert.equal(c.targets.source.hasSomeKeyword('sentinel'),true);}if(c.pending?.code==='JTL_075'){assert.equal(c.targets.source.damage,1);assert.equal(c.targets.source.hasSomeKeyword('sentinel'),false);c.observed.damageRemovedSentinel=true;}},assertAfter:c=>{assert.ok(c.observed.damageRemovedSentinel);assert.equal(c.targets.source.damage,0);assert.equal(c.targets.source.hasSomeKeyword('sentinel'),true);assert.equal(c.targets.source.getPower(),4);assert.equal(c.targets.source.getHp(),4);}});
module.exports = { scenarios, fixture };
