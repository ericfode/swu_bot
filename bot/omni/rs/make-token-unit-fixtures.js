'use strict';
// Real printed-card token creation/removal witnesses; generation is not conformance.
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { Env, seededRng } = require('../../env'), { loadPool } = require('./pool'), { canonicalAction, fullState, expandActions } = require('./state'), { makeBot } = require('../../players');
const unit = (key, code, owner = 'own', damage = 0) => ({ key, code, owner, damage });
const matches = (c, code) => [c.cardData.setId, ...(c.cardData.setCodes ?? [])].some(s => s.set + '_' + String(s.number).padStart(3, '0') === code);
const arena = c => c.cardData.arena === 'space' ? 'spaceArena' : 'groundArena';
const plain = [];
function deckFor(pool, scenario) {
    const codes = [...new Set([...(scenario.units ?? plain).map((u) => u.code), ...scenario.plan.filter((s) => s.from !== 'leader').map((s) => s.code), ...(scenario.extraCodes ?? [])])];
    assert.ok(codes.length <= 17);
    for (const code of [...codes, scenario.leaderCode ?? 'SOR_014', scenario.baseCode ?? 'SOR_023'])
        assert.ok(pool.cards.some((c) => c.setCode === code), `Missing ${code} in oracle input pool`);
    const filler = pool.cards.filter((c) => c.types.includes('unit') && !c.text && !codes.includes(c.setCode)).slice(0, 17 - codes.length).map((c) => c.setCode);
    assert.equal(filler.length, 17 - codes.length);
    return { metadata: { name: 'Event group oracle', author: 'omni-rs fixture' }, leader: { id: scenario.leaderCode ?? 'SOR_014', count: 1 }, base: { id: scenario.baseCode ?? 'SOR_023', count: 1 }, deck: [...codes, ...filler].map((id, i) => ({ id, count: i === 16 ? 2 : 3 })), isPresentInDb: false };
}
async function tokenFixture(env, pool, scenario, seed) {
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
    for (const code of new Set(scenario.plan.filter((s) => !s.from).map((s) => s.code))) {
        const count = scenario.plan.filter((s) => !s.from && s.code === code).length;
        while (own.getCardsInZone('hand').filter((c) => matches(c, code)).length < count) {
            const c = all(own).find((c) => matches(c, code) && c.zoneName !== 'hand');
            assert.ok(c, `Not enough real script copies ${code}`);
            c.moveTo('hand');
        }
    }
    for (const p of [own, enemy]) {
        for (const c of p.drawDeck.slice(0, 12)) {
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
            evidenceStatus: pool.oracleOnly ? 'PROTOTYPE engine observation; admission/conformance unassessed' : 'Engine observation; native/Wasm conformance unassessed', fixtureConstruction: (scenario.emptyOwnDeck ? 'Empty-deck scenario additionally moves all remaining p1 draw-deck cards into discard before initial state capture. ' : '') + (scenario.emptyOwnHand ? 'Empty-hand scenario additionally moves every initial p1 hand card into ready resources before initial state capture. ' : '') + 'At first natural action window, move specified real deck units into their printed arenas with specified exhaustion, move script cards into p1 hand, move12 remaining deck cards perplayer into ready resources, ready all resources, set bases damage24(orprintedHP-1 forbothLethal), resolve game state, then set disclosed survivingunitdamage and refreshprompts. Specified initial Shields are created with pinned game.generateToken and attached before state resolution. No later state edits.', constructionParameters: { emptyOwnDeck: !!scenario.emptyOwnDeck, emptyOwnHand: !!scenario.emptyOwnHand, units: scenario.units ?? plain, plan: scenario.plan, bothLethal: !!scenario.bothLethal, leaderCode: scenario.leaderCode, deployedLeader: !!scenario.deployedLeader, baseDamage: scenario.baseDamage, initiative: scenario.initiative } }];
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
                if (pid === own.id && index < scenario.plan.length) {
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
                if (!chosen && pid === own.id && pending.target)
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
    finally {
        bot.close?.();
    }
}
const definitions = {
    'battle-droid': { power: 1, hp: 1, arena: 'groundArena', traits: ['separatist', 'droid', 'trooper'], aspects: ['villainy'], keywords: [] },
    'clone-trooper': { power: 2, hp: 2, arena: 'groundArena', traits: ['republic', 'clone', 'trooper'], aspects: ['heroism'], keywords: [] },
    xwing: { power: 2, hp: 2, arena: 'spaceArena', traits: ['vehicle', 'fighter'], aspects: ['heroism'], keywords: [] },
    'tie-fighter': { power: 1, hp: 1, arena: 'spaceArena', traits: ['vehicle', 'fighter'], aspects: ['villainy'], keywords: [] },
    spy: { power: 0, hp: 2, arena: 'groundArena', traits: ['official'], aspects: [], keywords: ['raid'] },
    beast: { power: 3, hp: 3, arena: 'groundArena', traits: ['creature'], aspects: [], keywords: [] },
};
function initial(c) {
    if (!c.observed.postAction && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card' && c.scratch.start === undefined) {
        c.scratch.start = c.eg.game.state.allCards.length;
        c.scratch.hand = c.own.getCardsInZone('hand').length;
        c.scratch.top = c.eg.cardId(c.own.drawDeck[0].uuid);
    }
}
function tokens(c) { return c.eg.game.state.allCards.slice(c.scratch.start).map(uuid => c.eg.game.findAnyCardInAnyList(uuid)); }
function assertCreated(c, s) {
    const created = tokens(c), def = definitions[s.token];
    assert.equal(created.length, s.amount, 'Exact number of newly allocated cards');
    assert.equal(new Set(created.map(x => x.uuid)).size, s.amount);
    const owner = s.opponent ? c.enemy : c.own;
    for (const [i, t] of created.entries()) {
        assert.equal(c.eg.cardId(t.uuid), 'c' + (c.scratch.start + i), 'Global append token ID order');
        assert.equal(t.internalName, s.token);
        assert.equal(t.owner.id, owner.id);
        assert.equal(t.controller.id, owner.id);
        assert.equal(t.zoneName, def.arena);
        assert.equal(t.exhausted, !s.ready);
        assert.equal(t.getPower(), def.power + (s.cody ? 1 : 0));
        assert.equal(t.getHp(), def.hp + (s.cody ? 1 : 0));
        assert.deepEqual(t.cardData.traits, def.traits);
        assert.deepEqual(t.cardData.aspects, def.aspects);
        assert.deepEqual(t.cardData.keywords, def.keywords);
        assert.equal(t.getTriggeredAbilities().filter(a => a.properties.when?.whenPlayed).length, 0, 'Created token has no printed whenPlayed trigger');
    }
    c.observed.createdIds = created.map(t => c.eg.cardId(t.uuid));
    c.observed.owner = s.opponent ? 'p2' : 'p1';
    c.observed.tokenDefinition = def;
    c.observed.ready = !!s.ready;
    return created;
}
function creation(name, code, token, amount, opt = {}) {
    return { name, actualScriptedCardIds: [code, ...(opt.coordinate ? ['TWI_090'] : []), ...(opt.cody ? ['TWI_114'] : [])], family: 'create-token-unit', units: opt.units ?? [], baseDamage: 0, plan: opt.plan ?? (opt.death ? [{ code: 'SOR_077', target: 'source' }] : opt.attack ? [{ from: 'source', code }] : [{ code }]), beforeApply: c => {
            initial(c);
            if (opt.coordinate && !c.observed.postAction && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card') {
                assert.equal(c.targets.echo.getHp(), 2);
                assert.equal(c.targets.echo.getPower(), 2);
                c.observed.initialCoordinateInactive = true;
            }
        }, choose: c => opt.attack ? c.actions.find(a => a.cardUuid === c.enemy.base.uuid) : undefined, assertAfter: c => {
            assertCreated(c, { token, amount, ...opt });
            if (opt.death)
                assert.equal(c.targets.source.zoneName, 'discard');
            if (opt.coordinate) {
                assert.equal(c.targets.echo.getHp(), 4);
                assert.equal(c.targets.echo.getPower(), 4);
                c.observed.tokenEntryActivatedCoordinate = true;
            }
        } };
}
const scenarios = [creation('droid-deployment-two-exhausted', 'TWI_237', 'battle-droid', 2), creation('on-the-doorstep-three-ready', 'TWI_190', 'battle-droid', 3, { ready: true }), creation('jesse-two-opponent-droids', 'TWI_145', 'battle-droid', 2, { opponent: true }), creation('babwa-opponent-beast', 'HMW_152', 'beast', 1, { opponent: true }), creation('senate-five-spies', 'SEC_092', 'spy', 5), creation('executor-three-ties-when-played', 'JTL_090', 'tie-fighter', 3), creation('draven-xwing-when-played', 'JTL_117', 'xwing', 1), creation('draven-xwing-on-attack', 'JTL_117', 'xwing', 1, { attack: true, units: [unit('source', 'JTL_117')] }), creation('drop-in-two-clones', 'TWI_251', 'clone-trooper', 2), ...[
        ['wartime-official-death-droid', 'TWI_032', 'battle-droid', 1, 0], ['occupier-death-spy', 'SEC_132', 'spy', 1, 0], ['howler-death-beast', 'HMW_144', 'beast', 1, 0], ['atte-death-two-clones', 'TWI_247', 'clone-trooper', 2, 4]
    ].map(([name, code, token, count, damage]) => creation(name, code, token, count, { death: true, units: [unit('source', code, 'own', damage)] })), creation('droid-tokens-activate-coordinate-two-to-four', 'TWI_237', 'battle-droid', 2, { coordinate: true, units: [unit('echo', 'TWI_090'), unit('other', 'HMW_082')] }), creation('cody-aura-includes-created-space-ties', 'JTL_090', 'tie-fighter', 3, { cody: true, units: [unit('cody', 'TWI_114'), unit('other', 'HMW_082')] })];
for (const bounce of [false, true])
    scenarios.push({ name: 'created-token-' + (bounce ? 'bounce' : 'defeat') + '-does-not-enter-normal-zone', family: 'token-unit-leave-play', units: [], baseDamage: 0, plan: [{ code: 'TWI_237' }, { code: bounce ? 'TWI_226' : 'SOR_077' }], beforeApply: c => {
            initial(c);
            if (!c.observed.postAction && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card' && c.pending.code !== 'TWI_237') {
                c.scratch.created = assertCreated(c, { token: 'battle-droid', amount: 2 });
                c.observed.preLeaveTokenIds = c.scratch.created.map(t => c.eg.cardId(t.uuid));
            }
        }, choose: c => c.scratch.created ? c.actions.find(a => a.cardUuid === c.scratch.created[0].uuid) : undefined, assertAfter: c => { assert.equal(c.eg.game.state.allCards.length, c.scratch.start + 2); const [first, second] = c.scratch.created; assert.equal(second.zoneName, 'groundArena'); assert.ok(!c.own.getCardsInZone('hand').includes(first)); assert.ok(!c.own.getCardsInZone('discard').includes(first)); assert.notEqual(first.zoneName, 'groundArena'); c.observed.removedTokenZone = first.zoneName; c.observed.ordinaryHandAndDiscardExcludeToken = true; } });
scenarios.push(creation('single-droid-token-entry-activates-coordinate-two-to-three', 'TWI_073', 'battle-droid', 1, { coordinate: true, units: [unit('echo', 'TWI_090'), unit('other', 'HMW_082', 'own', 3)], plan: [{ code: 'TWI_073', target: 'other' }] }));
scenarios.push({ name: 'SYNTHETIC-created-units-do-not-emit-card-played', family: 'SYNTHETIC-token-entry-played-event-diagnostic', diagnosticOnly: true, units: [unit('observer', 'ASH_261')], baseDamage: 0, plan: [{ code: 'TWI_237' }], beforeApply: c => {
        initial(c);
        if (!c.scratch.registered && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card') {
            const h = require('../../../forceteki/build/server/game/AbilityHelper').getAbilityHelper(c.eg.game);
            c.targets.observer.addGainedTriggeredAbility({ title: 'SYNTHETIC draw when token unit is played', when: { onCardPlayed: event => event.card.isToken() }, immediateEffect: h.immediateEffects.draw() });
            c.scratch.registered = true;
        }
    }, assertAfter: c => { assertCreated(c, { token: 'battle-droid', amount: 2 }); assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - 1, 'Creation emits no token card-played draw'); c.observed.createdTokenUnitsDidNotEmitPlayedEvent = true; } });
scenarios.push({ ...creation('death-by-droids-tokens-visible-at-optional-death', 'TWI_076', 'battle-droid', 2, { units: [unit('source', 'JTL_060')] }), choose: c => {
        const title = c.eg.player(c.pid).currentPrompt().menuTitle;
        if (title === 'Give a unit -1/-1 for this phase') {
            const made = assertCreated(c, { token: 'battle-droid', amount: 2 });
            assert.equal(c.targets.source.zoneName, 'discard');
            assert.deepEqual(c.actions.filter(a => a.kind === 'card').map(a => a.cardUuid).sort(), made.map(t => t.uuid).sort(), 'Both new droids legal in pending death ability');
            c.observed.tokensVisibleAtDeathPrompt = true;
            return c.actions.find(a => a.arg === 'passAbility');
        }
        return c.actions.find(a => a.cardUuid === c.targets.source.uuid);
    }, assertAfter: c => { assertCreated(c, { token: 'battle-droid', amount: 2 }); assert.ok(c.observed.tokensVisibleAtDeathPrompt); } });
scenarios.push({ ...creation('drop-in-cody-snoke-all-token-entries-before-sweep', 'TWI_251', 'clone-trooper', 2, { units: [unit('cody', 'TWI_114'), unit('snoke', 'SHD_037', 'enemy')] }), beforeApply: c => {
        initial(c);
        if (!c.observed.postAction && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card') {
            assert.equal(c.targets.cody.zoneName, 'groundArena');
            assert.equal(c.targets.cody.getHp(), 2);
            c.observed.codyAliveBeforeTokenBatch = true;
        }
    }, assertAfter: c => {
        const made = tokens(c);
        assert.equal(made.length, 2);
        for (const [i, t] of made.entries()) {
            assert.equal(c.eg.cardId(t.uuid), 'c' + (c.scratch.start + i));
            assert.equal(t.zoneName, 'groundArena');
            assert.equal(t.getHp(), 1);
            assert.equal(t.getPower(), 1);
            assert.equal(t.exhausted, true);
        }
        assert.equal(c.targets.cody.getHp(), 2);
        assert.ok(c.observed.codyAliveBeforeTokenBatch);
        c.observed.bothTokensSurviveAfterCompleteBatch = true;
    } });
scenarios.push({ name: 'contempt-spy-entry-versus-primary-lethal-under-cody-snoke', family: 'token-entry-primary-damage-order', units: [unit('cody', 'TWI_114'), unit('victim', 'HMW_082', 'own', 3), unit('snoke', 'SHD_037', 'enemy')], baseDamage: 0, plan: [{ code: 'SEC_246', target: 'victim' }], beforeApply: c => {
        initial(c);
        if (!c.observed.postAction && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card') {
            assert.equal(c.targets.victim.getHp(), 5);
            assert.equal(c.targets.victim.damage, 3);
            assert.equal(c.targets.cody.getHp(), 2);
            c.observed.initialTwoFriendlyNoAura = true;
        }
    }, assertAfter: c => { const made = tokens(c); assert.equal(made.length, 1); c.observed.result = { victimZone: c.targets.victim.zoneName, victimHp: c.targets.victim.zoneName === 'groundArena' ? c.targets.victim.getHp() : null, victimDamage: c.targets.victim.zoneName === 'groundArena' ? c.targets.victim.damage : null, spyZone: made[0].zoneName, spyHp: made[0].zoneName === 'groundArena' ? made[0].getHp() : null }; assert.equal(c.targets.victim.zoneName, 'discard'); assert.equal(made[0].zoneName, 'outsideTheGame'); assert.equal(c.targets.cody.getHp(), 2); assert.ok(c.observed.initialTwoFriendlyNoAura); c.observed.primaryDamageDefeatBeforeSpyEntry = true; } });
for (const space of [false, true]) {
    const token = space ? 'xwing' : 'spy', code = space ? 'JTL_117' : 'SEC_092', amount = space ? 1 : 5;
    scenarios.push({ name: space ? 'created-xwing-space-only-combat' : 'created-spy-raid-two-combat', family: 'created-token-combat', units: space ? [unit('enemySpace', 'JTL_212', 'enemy'), unit('enemyGround', 'ASH_261', 'enemy')] : [], baseDamage: 0, plan: [{ code }, { code: 'SOR_169', target: 'created' }, { from: 'created', code }], beforeApply: initial, beforeWindow: c => {
            if (c.scratch.start !== undefined && c.eg.game.state.allCards.length > c.scratch.start && !c.targets.created) {
                c.targets.created = assertCreated(c, { token, amount })[0];
                c.observed.tokenBoundBeforeReady = true;
            }
        }, choose: c => {
            const title = c.eg.player(c.pid).currentPrompt().menuTitle;
            if (title === 'Choose a target for attack') {
                if (space) {
                    assert.ok(c.actions.some(a => a.cardUuid === c.targets.enemySpace.uuid));
                    assert.ok(!c.actions.some(a => a.cardUuid === c.targets.enemyGround.uuid));
                    c.observed.spaceTargetFilter = true;
                    return c.actions.find(a => a.cardUuid === c.targets.enemySpace.uuid);
                }
                assert.equal(c.targets.created.getPower(), 0, 'Printed Spy power before attack declaration');
                c.observed.raidAttackTargetChosen = true;
                return c.actions.find(a => a.cardUuid === c.enemy.base.uuid);
            }
            return c.actions.find(a => a.cardUuid === c.targets.created.uuid);
        }, assertAfter: c => {
            assert.ok(c.observed.tokenBoundBeforeReady);
            assert.equal(c.targets.created.exhausted, true);
            if (space) {
                assert.ok(c.observed.spaceTargetFilter);
                assert.equal(c.targets.enemySpace.damage, 2);
                assert.equal(c.targets.created.damage, 1);
                assert.equal(c.targets.enemyGround.damage, 0);
            }
            else {
                assert.ok(c.observed.raidAttackTargetChosen);
                assert.equal(c.enemy.base.damage, 2, 'Raid 2 causes two actual combat damage');
                c.observed.raidActualCombatDamageTwo = true;
                assert.equal(c.targets.created.getPower(), 0, 'Raid expires after attack');
            }
        } });
}
for (const scenario of scenarios) {
    if (scenario.name === 'drop-in-cody-snoke-all-token-entries-before-sweep')
        scenario.actualScriptedCardIds = ['TWI_251', 'TWI_114', 'SHD_037'];
    if (scenario.name === 'death-by-droids-tokens-visible-at-optional-death')
        scenario.actualScriptedCardIds = ['TWI_076', 'JTL_060'];
}
async function main([poolFile, out, filter]) {
    assert.ok(poolFile && out);
    assert.ok(!fs.existsSync(out));
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(poolFile, path.join(out, 'pool.json'));
    const pool = loadPool(path.join(out, 'pool.json')), env = new Env(), witnesses = [], skippedScenarios = [];
    for (const [i, s] of scenarios.entries()) {
        if (s.diagnosticOnly && !filter)
            continue;
        if (filter && !s.name.includes(filter))
            continue;
        const missingCodes = [...s.units.map(u => u.code), ...s.plan.map(p => p.code)].filter(code => !pool.cards.some(x => x.setCode === code));
        if (missingCodes.length && !filter) {
            skippedScenarios.push({ scenario: s.name, reason: 'Required card absent from this pool; conformance not established', missingCodes });
            continue;
        }
        const r = await tokenFixture(env, pool, s, 20001 + i);
        if (s.diagnosticOnly) {
            r.records[0].evidenceStatus = 'SYNTHETIC ENGINE REGISTRATION DIAGNOSTIC; not printed-card conformance';
            r.records[0].syntheticRegistration = 'Initial action boundary: real Noti Mobile Pod gains global token onCardPlayed draw observer. Only detects event emission, not native/Wasm agreement.';
        }
        const file = s.name + '.jsonl.gz', bytes = zlib.gzipSync(r.records.map(x => JSON.stringify(x)).join('\n') + '\n');
        fs.writeFileSync(path.join(out, file), bytes);
        witnesses.push({ ...r.witness, file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), actualScriptedCardIds: s.diagnosticOnly ? [] : s.actualScriptedCardIds ?? (s.name.startsWith('created-token-') ? ['TWI_237'] : s.name.startsWith('contempt') ? ['SEC_246'] : s.name.startsWith('created-spy') ? ['SEC_092', 'TOKEN_SPY'] : s.name.startsWith('created-xwing') ? ['JTL_117', 'TOKEN_XWING'] : []), sharedRelatedCardIds: [], synthetic: !!s.diagnosticOnly });
        fs.writeFileSync(path.join(out, 'token-unit-witnesses.json'), JSON.stringify({ evidenceStatus: pool.oracleOnly ? 'PROTOTYPE real engine' : 'real engine observations', conformance: 'unassessed; fresh native and Wasm comparison required', pool: pool.provenance, generatorSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), skippedScenarios, witnesses }, null, 2) + '\n');
        console.log(s.name);
    }
}
if (require.main === module)
    main(process.argv.slice(2)).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { main, scenarios, definitions, tokenFixture };
