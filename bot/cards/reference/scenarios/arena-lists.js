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
    if (scenario.noReadyResources) for (const p of [own, enemy]) for (const c of p.getCardsInZone('resource')) c.exhausted = true;
    // Disclosed pre-capture native token construction, not a scripted-card claim.
    for (const t of scenario.tokens ?? []) {
        const p=t.owner==='enemy'?enemy:own, card=eg.game.generateToken(p,t.name);
        card.moveTo(t.arena==='space'?'spaceArena':'groundArena'); card.exhausted=!!t.exhausted;
        targets[t.key]=card;
    }
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
            evidenceStatus: pool.oracleOnly ? 'PROTOTYPE engine observation; admission/conformance unassessed' : 'Engine observation; native/Wasm conformance unassessed', fixtureConstruction: (scenario.emptyOwnDeck ? 'Empty-deck scenario additionally moves all remaining p1 draw-deck cards into discard before initial state capture. ' : '') + (scenario.emptyOwnHand ? 'Empty-hand scenario additionally moves every initial p1 hand card into ready resources before initial state capture. ' : '') + 'At first natural action window, move specified real deck units into their printed arenas with specified exhaustion, move script cards into p1 hand, move24 remaining deck cards perplayer into ready resources, ready all resources, set bases damage24(orprintedHP-1 forbothLethal), resolve game state, then set disclosed survivingunitdamage and refreshprompts. Specified initial Shields are created with pinned game.generateToken and attached before state resolution. Native token units from scenario.tokens are generated and moved into declared arenas before capture. No later state edits.', constructionParameters: { emptyOwnDeck: !!scenario.emptyOwnDeck, emptyOwnHand: !!scenario.emptyOwnHand, units: scenario.units ?? plain, tokens: scenario.tokens ?? [], plan: scenario.plan, bothLethal: !!scenario.bothLethal, leaderCode: scenario.leaderCode, deployedLeader: !!scenario.deployedLeader, baseDamage: scenario.baseDamage, initiative: scenario.initiative } }];
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
// Assertions below derive from the pinned source and cover global and controller-relative lists.
function start(c){if(c.scratch.started)return;c.scratch.started=true;c.scratch.incoming=c.scratch.incoming;c.scratch.before=Object.fromEntries(Object.entries(c.targets).filter(([,t])=>t.isUnit?.()).map(([k,t])=>[k,{damage:t.damage,sentinel:t.hasSomeKeyword('sentinel'),saboteur:t.hasSomeKeyword('saboteur'),raid:t.getNumericKeywordTotal('raid')??0}]));c.scratch.effectEvents=[];for(const name of ['onEffectApplied','onCardDefeated','onDamageDealt','onCardReadied'])c.eg.game.on(name,e=>{if(!c.observed.postAction)c.scratch.effectEvents.push({name,id:e.card?c.eg.cardId(e.card.uuid):null});});}
function before(c){if(c.atWindow&&c.chosen.kind==='card')start(c);}
const scenarios=[];
for(const enemies of [0,1,2])scenarios.push({name:'savage-opress-count-'+enemies,family:'arena-count-alias',actualScriptedCardIds:['TWI_137'],units:enemies?[unit('enemySpace','JTL_212','enemy'),...(enemies===2?[unit('enemyGround','ASH_261','enemy')]:[])]:[],baseDamage:0,plan:[{code:'TWI_137'}],beforeApply:before,assertAfter:c=>{const s=c.scratch.incoming;assert.equal(s.internalName,'savage-opress#monster');assert.equal(s.zoneName,'groundArena');assert.equal(s.exhausted,enemies<=1);assert.equal(c.own.getArenaUnits().length,1);assert.equal(c.enemy.getArenaUnits().length,enemies);c.observed.sourceReady=enemies===2;c.observed.counts=[1,enemies];}});
scenarios.push({name:'savage-opress-token-and-leader-count-boundary',family:'arena-count-unit-kinds',actualScriptedCardIds:['TWI_137'],units:[unit('enemySpace','JTL_212','enemy'),unit('enemyGround','ASH_261','enemy')],tokens:[{key:'token',name:'battleDroid',owner:'own'}],deployedLeader:true,baseDamage:0,plan:[{code:'TWI_137'}],beforeApply:before,assertAfter:c=>{assert.equal(c.scratch.incoming.exhausted,true);assert.equal(c.own.getArenaUnits().length,3);assert.equal(c.enemy.getArenaUnits().length,2);c.observed.tokenAndLeaderIncluded=true;}});
for(const defender of [false,true])scenarios.push({name:'summa-verminoth-space-sweep-'+(defender?'defender':'base'),family:'arena-global-defeat',actualScriptedCardIds:['ASH_083'],units:[unit('source','ASH_083'),unit('ownSpace','JTL_212'),unit('enemySpace','JTL_212','enemy'),unit('ownGround','ASH_261'),unit('enemyGround','ASH_261','enemy')],tokens:[{key:'spaceToken',name:'xwing',arena:'space',owner:'enemy'},{key:'groundToken',name:'battleDroid'}],baseDamage:0,plan:[{code:'ASH_083',from:'source',target:defender?'enemySpace':'enemyBase'}],beforeApply:before,choose:c=>{if(c.eg.player(c.pid).currentPrompt().menuTitle==='Choose a target for attack'){const expected=[c.targets.enemySpace.uuid,c.targets.enemyBase.uuid,c.targets.spaceToken.uuid].sort();assert.deepEqual(c.actions.filter(a=>a.kind==='card').map(a=>a.cardUuid).sort(),expected);c.observed.exactAttackTargets=true;return c.actions.find(a=>a.cardUuid===c.targets[defender?'enemySpace':'enemyBase'].uuid);}},assertAfter:c=>{assert.equal(c.targets.source.zoneName,'spaceArena');assert.equal(c.targets.source.damage,0);for(const key of ['ownSpace','enemySpace'])assert.equal(c.targets[key].zoneName,'discard');assert.equal(c.targets.spaceToken.zoneName,'outsideTheGame');for(const key of ['ownGround','enemyGround','groundToken'])assert.equal(c.targets[key].zoneName,'groundArena');assert.equal(c.enemy.base.damage,defender?0:15);assert.ok(c.observed.exactAttackTargets);c.observed.otherSpaceUnitsDefeated=true;}});
function heatChecks(c,expiry=false){for(const [k,b] of Object.entries(c.scratch.before)){const t=c.targets[k];if(t.isUnit()&&t.isInPlay()){assert.equal(t.hasSomeKeyword('sentinel'),expiry?b.sentinel:true,k);assert.equal(t.hasSomeKeyword('saboteur'),expiry?b.saboteur:false,k);}}}
scenarios.push({name:'heat-of-battle-all-current-units-and-expiry',family:'arena-global-phase-keywords',actualScriptedCardIds:['JTL_077'],units:[unit('ownSaboteur','JTL_166'),unit('enemySpace','JTL_212','enemy'),unit('ownGround','ASH_261'),unit('enemyGround','ASH_261','enemy')],tokens:[{key:'token',name:'battleDroid',owner:'enemy'}],deployedLeader:true,baseDamage:0,plan:[{code:'JTL_077'}],beforeApply:before,assertAfter:c=>{heatChecks(c);c.observed.currentUnitsAffected=Object.keys(c.scratch.before).length;},chooseLater:c=>{if(c.atWindow&&!c.observed.laterRoundAssertion)return c.actions.find(a=>a.arg==='pass');},assertLater:c=>{heatChecks(c,true);c.observed.phaseKeywordsExpired=true;}});
scenarios.push({name:'heat-of-battle-later-arrival-excluded',family:'arena-global-phase-snapshot',actualScriptedCardIds:['JTL_077','ASH_261'],units:[unit('old','JTL_212')],baseDamage:0,plan:[{code:'JTL_077'},{code:'ASH_261'}],beforeApply:before,assertAfter:c=>{assert.equal(c.targets.old.hasSomeKeyword('sentinel'),true);assert.equal(c.scratch.incoming.hasSomeKeyword('sentinel'),false);c.observed.laterArrivalExcluded=true;}});
const stressCodes=['ASH_061','ASH_131','ASH_190','ASH_201','ASH_242','ASH_261','HMW_082','HMW_093','HMW_116','HMW_135','HMW_155','HMW_163'];
scenarios.push({name:'heat-of-battle-34-current-unit-stress',family:'arena-target-multiplicity',actualScriptedCardIds:['JTL_077'],units:Array.from({length:34},(_,i)=>unit('u'+i,stressCodes[Math.floor(i/3)],i%2?'enemy':'own')),baseDamage:0,plan:[{code:'JTL_077'}],beforeApply:before,assertAfter:c=>{assert.equal(c.eg.game.getArenaUnits().length,34);heatChecks(c);c.observed.targetCount=34;}});
for(const stacked of [false,true])scenarios.push({name:'sword-shield-traits-'+(stacked?'stacked':'single'),family:'arena-controller-trait-phase-groups',actualScriptedCardIds:['TWI_250'],units:[unit('trooper','ASH_061'),unit('jediGround','HMW_128'),unit('jediSpace','JTL_251'),unit('none','ASH_261'),unit('enemyTrooper','ASH_061','enemy'),unit('enemyJedi','HMW_128','enemy')],tokens:[{key:'trooperToken',name:'battleDroid'}],baseDamage:0,plan:Array.from({length:stacked?2:1},()=>({code:'TWI_250'})),beforeApply:before,assertAfter:c=>{for(const key of ['trooper','trooperToken'])assert.equal(c.targets[key].getNumericKeywordTotal('raid'),stacked?2:1);for(const key of ['jediGround','jediSpace'])assert.equal(c.targets[key].hasSomeKeyword('sentinel'),true);for(const key of ['none','enemyTrooper','enemyJedi']){assert.equal(c.targets[key].hasSomeKeyword('sentinel'),false);assert.equal(c.targets[key].getNumericKeywordTotal('raid')??0,0);}c.observed.phaseGrantsApplied=true;},chooseLater:c=>{if(c.atWindow&&!c.observed.laterRoundAssertion)return c.actions.find(a=>a.arg==='pass');},assertLater:c=>{for(const key of ['trooper','trooperToken'])assert.equal(c.targets[key].getNumericKeywordTotal('raid')??0,0);for(const key of ['jediGround','jediSpace'])assert.equal(c.targets[key].hasSomeKeyword('sentinel'),false);c.observed.expired=true;}});
scenarios.push({name:'sword-shield-partial-trooper-group',family:'arena-empty-sibling-group',actualScriptedCardIds:['TWI_250'],units:[unit('trooper','ASH_061'),unit('enemyJedi','HMW_128','enemy')],baseDamage:0,plan:[{code:'TWI_250'}],beforeApply:before,assertAfter:c=>{assert.equal(c.targets.trooper.getNumericKeywordTotal('raid'),1);assert.equal(c.targets.enemyJedi.hasSomeKeyword('sentinel'),false);c.observed.emptyJediGroupDidNotBlockTrooper=true;}});
for(const empty of [false,true])scenarios.push({name:'assassin-probe-death-'+(empty?'no-eligible':'exhausted-ground-shield-lethal'),family:'arena-death-controller-exhaustion',actualScriptedCardIds:['ASH_067'],actualTriggeredCardIds:['SEC_263'],units:[unit('source','SEC_263','own',0,1),unit('friendly','ASH_261'),unit('ready','ASH_261','enemy'),unit('space','JTL_212','enemy'),...(!empty?[{...unit('exhausted','ASH_261','enemy'),exhausted:true},{...unit('lethal','SEC_028','enemy',3),exhausted:true},{...unit('shield','HMW_082','enemy',0,1),exhausted:true}]:[])],tokens:empty?[]:[{key:'token',name:'battleDroid',owner:'enemy',exhausted:true}],baseDamage:0,plan:[{code:'ASH_067',target:'source'}],beforeApply:before,assertAfter:c=>{assert.equal(c.targets.source.zoneName,'discard');for(const key of ['friendly','ready','space'])assert.equal(c.targets[key].damage,0);if(!empty){assert.equal(c.targets.exhausted.damage,1);assert.equal(c.targets.lethal.zoneName,'discard');assert.equal(c.targets.token.zoneName,'outsideTheGame');assert.equal(c.targets.shield.damage,0);assert.equal(c.targets.shield.upgrades.length,0);}c.observed.deathTriggered=true;c.observed.eligibleTargets=empty?0:4;}});
for(const code of ['JTL_077','TWI_250'])for(const cancel of [false,true])scenarios.push({name:'arena-empty-event-'+code+'-'+(cancel?'cancel':'play'),family:'arena-empty-query-confirmation',actualScriptedCardIds:[code],units:[],baseDamage:0,plan:[{code}],beforeApply:c=>{before(c);if(c.atWindow&&!c.scratch.readyBefore)c.scratch.readyBefore=c.own.getCardsInZone('resource').filter(t=>!t.exhausted).length;},choose:c=>{const title=c.eg.player(c.pid).currentPrompt().menuTitle;if(!title?.includes('will have no effect'))return;assert.deepEqual(c.actions.map(a=>a.label),['Play anyway','Cancel']);c.observed.exactNoEffectActions=c.actions.map(a=>canonicalAction(c.eg,a));return c.actions.find(a=>a.label===(cancel?'Cancel':'Play anyway'));},assertAfter:c=>{assert.ok(c.observed.exactNoEffectActions);assert.equal(c.scratch.incoming.zoneName,cancel?'hand':'discard');const ready=c.own.getCardsInZone('resource').filter(t=>!t.exhausted).length;assert.equal(ready===c.scratch.readyBefore,cancel);assert.equal(c.eg.game.getArenaUnits().length,0);c.observed.cancelled=cancel;}});
module.exports = { scenarios, fixture };
