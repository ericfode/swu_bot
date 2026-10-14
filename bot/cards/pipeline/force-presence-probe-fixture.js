'use strict';
const assert = require('node:assert/strict');
const { constructProbeFixture } = require('./probe-fixture');
const { fullState, canonicalAction, expandActions } = require('../../omni/rs/state');
function forceObject(player) {
    const rows = [...player.baseZone.cards, ...player.outsideTheGameZone.getCards()].filter(c => c.isForceToken());
    assert.equal(rows.length, 1);
    return rows[0];
}
async function fixture(env, pool, scenario, seed) {
    const p = scenario.probe;
    const { eg, rng, bot, deck, own, enemy, source, targets } = await constructProbeFixture(env, pool, scenario, seed);
    const force = forceObject(own), enemyForce = forceObject(enemy);
    if (p.held) force.moveTo('base');
    if (p.enemyHeld) enemyForce.moveTo('base');
    eg.game.resolveGameState(true); eg.game.continue();
    const round = eg.round, initialCardCount = eg.game.state.allCards.length;
    const ids = [eg.cardId(force.uuid), eg.cardId(enemyForce.uuid)];
    const sequence = [...(p.sourceInPlay ? [] : [source]), ...(p.lifecycle ? [targets[p.gainIndex], targets[p.useIndex], targets[p.regainIndex]] : []), ...(p.sourceDeparture ? [targets[p.defeatIndex]] : [])];
    const witness = { observations: [], forceEvents: [], attacks: [], coverageObligationIds: [] };
    const records = [{ type: 'meta', schema: 'omni-rs-trace-v1', pool: pool.provenance, seed,
        bots: ['force-presence-probe', 'force-presence-probe'], decks: [deck, deck], scenario: scenario.name,
        fixtureConstruction: 'Stage disclosed quiet units, native Force identities, resources and optional damaged constant-source incarnation. Focus and gain/use/regain donor plays, triggered keyword order, combat/attack-menu inputs and full terminal result are normal recorded actions.', constructionParameters: p }];
    const playedSources = new Set();
    let index = 0, started = false, played = false, settled = false, checked = false;
    let attackMenuStarted = false, menus = 0, sourceOptional = 0, orderMenus = 0, combatStarted = false, step = 0;
    let expectedHeld = !!p.held, waitingExpiry = false, createdShields = 0;
    let readyBefore = 0, expectedCost = 0;
    function printedCost(c) {
        let n = c.cardData.cost; const aspects = [...own.getAspectsForCosts()];
        for (const a of c.cardData.aspects) {
            const i = aspects.indexOf(a); if (i < 0) n += 2; else aspects.splice(i, 1);
        }
        return n;
    }
    eg.game.on('onCardPlayed', e => {
        if (!settled && started && !e.isCancelledOrReplaced && e.card === sequence[index]) { played = true; playedSources.add(e.card); }
    });
    eg.game.on('onForceUsed', e => {
        if (!settled) witness.forceEvents.push({ kind: 'use', owner: eg.seatOf(e.player.id) });
    });
    eg.game.on('onTokensCreated', e => {
        if (!settled && e.tokenType === 'shield') createdShields += e.generatedTokens.length;
        if (!settled && e.tokenType === 'the-force') witness.forceEvents.push({ kind: 'gain',
            owner: eg.seatOf(e.player.id), ids: e.generatedTokens.map(t => eg.cardId(t.uuid)) });
    });
    eg.game.on('onAttackDeclared', e => {
        if (!settled && e.attack.attacker === source) {
            combatStarted = true;
            witness.attacks.push({ attacker: eg.cardId(source.uuid), defender: eg.cardId(e.attack.getSingleTarget().uuid), power: source.getPower() });
        }
    });
    function identity() {
        assert.deepEqual([eg.cardId(force.uuid), eg.cardId(enemyForce.uuid)], ids);
        const state = fullState(eg);
        assert.equal(state.forceStateVersion, 1);
        assert.deepEqual(state.players.p1.forceToken, { id: ids[0], held: own.hasTheForce });
        assert.deepEqual(state.players.p2.forceToken, { id: ids[1], held: enemy.hasTheForce });
        assert.equal(enemy.hasTheForce, !!p.enemyHeld);
        assert.equal(eg.game.state.allCards.length, initialCardCount + createdShields, 'Only actual printed Shielded allocates a new card; Force changes preserve existing IDs');
    }
    function observe(stage, pid, actions) {
        identity();
        witness.observations.push({ stage, actor: pid ? eg.seatOf(pid) : undefined,
            actions: actions?.map(a => canonicalAction(eg, a)), state: fullState(eg) });
    }
    function assertLive() {
        identity(); assert.equal(own.hasTheForce, expectedHeld);
        if (p.sourceDeparture && sequence[index] === targets[p.defeatIndex]) {
            assert.equal(source.zoneName, 'discard');
            assert.equal(own.base.damage, 0); assert.equal(enemy.base.damage, 0);
            for (let i = 0; i < targets.length; i++) {
                if (p.targets[i].zone === 'hand') continue;
                assert.ok(targets[i].isInPlay(), 'Source defeat preserves every unselected staged unit');
                assert.equal(targets[i].damage, p.targets[i].damage ?? 0);
            }
            for (const c of eg.game.getArenaUnits()) {
                assert.equal(c.getPower(), c.cardData.power); assert.equal(c.getHp(), c.cardData.hp);
            }
            observe('actual-source-departure-removes-aura'); return;
        }
        assert.ok(source.isInPlay());
        if (p.kind === 'keyword') {
            assert.equal(source.hasSomeKeyword(p.keyword), expectedHeld);
            assert.equal(source.getPower(), source.cardData.power + (p.keyword === 'grit' && expectedHeld ? source.damage : 0));
            assert.equal(source.getHp(), source.cardData.hp);
        } else {
            for (const c of eg.game.getArenaUnits()) {
                assert.equal(c.getPower(), Math.max(0, c.cardData.power + (c.controller === own && expectedHeld ? p.power : 0)));
                assert.equal(c.getHp(), c.cardData.hp);
            }
        }
        assert.equal(own.base.damage, 0); assert.equal(enemy.base.damage, 0);
        if (!waitingExpiry) assert.equal(source.exhausted, true, 'Gain later changes live keyword but does not invent another entry attack');
        if (p.lifecycle && p.keyword === 'ambush') assert.equal(witness.attacks.length, 0, 'Actual later Force gain never replays Ambush registration');
        for (let i = 0; i < targets.length; i++) {
            const t = targets[i];
            if (p.targets[i].zone === 'hand') continue;
            assert.ok(t.isInPlay(), 'Unselected staged members remain in play');
            assert.equal(t.damage, combatStarted && i === 2 ? source.cardData.power : p.targets[i].damage ?? 0);
        }
        if (p.keywords.shielded) {
            assert.equal(createdShields, 1);
            const shieldConsumed = combatStarted && p.shieldFirst;
            assert.equal(source.upgrades.filter(u => u.isShield()).length, shieldConsumed ? 0 : 1);
            assert.equal(source.damage, combatStarted && !p.shieldFirst ? targets[2].cardData.power : 0);
        }
        if (p.keyword === 'ambush' && index === 0 && !p.sourceInPlay) {
            const shouldAttack = !!p.held && !p.decline && targets.some(t => t.controller === enemy && t.zoneName === source.zoneName);
            assert.equal(combatStarted, shouldAttack);
            assert.equal(witness.attacks.length, shouldAttack ? 1 : 0);
            const eligible = !!p.held && targets.some(t => t.controller === enemy && t.zoneName === source.zoneName);
            assert.equal(sourceOptional, eligible ? 1 : 0, 'Entry optional Ambush exists only with held own Force and a legal enemy');
            assert.equal(orderMenus, eligible && p.keywords.shielded ? 1 : 0, 'Both printed Shielded and captured conditional Ambush offer an order choice');
            if (shouldAttack) assert.equal(targets[2].damage, source.cardData.power);
        }
        observe('live-presence-checkpoint-' + index);
    }
    function advance() {
        checked = false; attackMenuStarted = false; index++; started = false; played = false;
        if (index === sequence.length) {
            if (p.lifecycle) assert.deepEqual(witness.forceEvents.map(e => e.kind), ['gain', 'use', 'gain']);
            if (p.waitForExpiry) waitingExpiry = true;
            else settled = true;
        }
    }
    try {
        while (!eg.over && step < 5000) {
            const pid = eg.ids.find(id => eg.legalActions(id).length);
            assert.ok(pid);
            const actions = expandActions(eg, eg.legalActions(pid)), window = eg.isActionWindow(pid);
            const prompt = eg.player(pid).currentPrompt();
            let chosen;
            if (window) {
                records.push({ type: 'state', step, state: fullState(eg, pid) });
                if (!settled && waitingExpiry && eg.round > round) {
                    index = sequence.length - 1; assertLive(); observe('natural-phase-preserves-constant'); settled = true;
                }
                if (!settled && !waitingExpiry && (started && played || !sequence.length) && !checked) {
                    if (started && played) assert.equal(own.getCardsInZone('resource').filter(c => !c.exhausted).length, readyBefore - expectedCost); 
                    if (p.lifecycle && sequence[index] !== source) {
                        expectedHeld = sequence[index] === targets[p.useIndex] ? false : true;
                    }
                    assertLive(); checked = true;
                    if (p.keyword !== 'sentinel') {
                        if (!sequence.length) settled = true;
                        else advance();
                    }
                }
                if (!settled && !waitingExpiry && checked && p.keyword === 'sentinel' && pid === enemy.id && !attackMenuStarted) {
                    chosen = actions.find(a => a.cardUuid === targets[2].uuid);
                    assert.ok(chosen, 'Quiet opposing attacker remains ready for legal-domain menu');
                    attackMenuStarted = true;
                } else if (!settled && !waitingExpiry && !started && !checked && pid === own.id) {
                    readyBefore = own.getCardsInZone('resource').filter(c => !c.exhausted).length;
                    expectedCost = printedCost(sequence[index]);
                    chosen = actions.find(a => a.cardUuid === sequence[index].uuid);
                    assert.ok(chosen, 'Actual focus/gain/use/regain source play index=' + index + ' zone=' + sequence[index].zoneName + ' ready=' + own.getCardsInZone('resource').filter(c => !c.exhausted).length + ' actions=' + JSON.stringify(actions.map(a => [a.kind,a.label,a.cardUuid]))); started = true;
                } else if (!settled) chosen = actions.find(a => a.arg === 'pass');
            } else if (!settled) {
                if (p.sourceDeparture && sequence[index] === targets[p.defeatIndex] && actions.some(a => a.cardUuid === source.uuid)) {
                    assert.equal(pid, own.id); chosen = actions.find(a => a.cardUuid === source.uuid);
                } else if (attackMenuStarted && /target for attack/i.test(prompt.menuTitle ?? '')) {
                    assert.equal(pid, enemy.id);
                    if (p.hiddenGrant) {
                        assert.equal(source.hasSomeKeyword('hidden'), true);
                        assert.equal(source.wasPlayedDeployedOrCreatedThisPhase(), true);
                    }
                    const expected = expectedHeld ? [source] : [own.base, ...eg.game.getArenaUnits().filter(c => c.controller === own && c.zoneName === targets[2].zoneName && (!p.hiddenGrant || !playedSources.has(c)))];
                    assert.deepEqual(actions.filter(a => a.kind === 'card').map(a => a.cardUuid).sort(), expected.map(c => c.uuid).sort());
                    observe('actual-sentinel-target-domain-' + index, pid, actions); menus++;
                    chosen = actions.find(a => a.arg === 'cancel'); assert.ok(chosen); advance();
                } else if (actions.some(a => a.label === 'Shielded') && actions.some(a => a.label === 'Ambush')) {
                    orderMenus++; assert.equal(pid, own.id); observe('shielded-ambush-registration-order', pid, actions);
                    chosen = actions.find(a => a.label === (p.shieldFirst ? 'Shielded' : 'Ambush'));
                } else if (/target for attack/i.test(prompt.menuTitle ?? '') && p.keyword === 'ambush') {
                    assert.equal(pid, own.id);
                    chosen = actions.find(a => a.cardUuid === targets[2]?.uuid); assert.ok(chosen);
                } else if (actions.some(a => a.label === 'Pass')) {
                    assert.equal(pid, own.id);
                    assert.deepEqual(actions.map(a => a.label), ['Trigger', 'Pass']);
                    observe('optional-keyword-or-use', pid, actions);
                    if (sequence[index] === source) sourceOptional++;
                    const decline = sequence[index] === source && p.decline;
                    chosen = actions.find(a => a.label === (decline ? 'Pass' : 'Trigger'));
                }
                chosen ??= actions.find(a => a.kind === 'button' && /trigger|resolve|yes/i.test(a.label ?? ''));
                chosen ??= actions.find(a => a.arg === 'done');
            }
            chosen ??= bot.choose({ game: eg, pid, actions, rng }); assert.ok(chosen);
            records.push({ type: 'decision', step, actor: eg.seatOf(pid), prompt: {
                type: prompt.promptType ?? null, title: prompt.menuTitle ?? null,
                selected: (eg.player(pid).promptState.selectedCards ?? []).map(c => eg.cardId(c.uuid)), actionWindow: window },
                actions: actions.map(a => canonicalAction(eg, a)), chosen: canonicalAction(eg, chosen).key, events: [] });
            eg.apply(pid, chosen, rng); step++;
        }
        assert.ok(settled, 'All presence source checkpoints settled');
        if (p.keyword === 'sentinel') assert.ok(menus > 0);
        assert.ok(eg.over); records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
        witness.coverageObligationIds = [...scenario.coverageObligationIds];
        return { records, witness };
    } finally { bot.close?.(); }
}
module.exports = { fixture, dependencies: ['bot/cards/pipeline/force-presence-probes.js',
    'bot/cards/pipeline/force-presence-probe-fixture.js', 'bot/cards/pipeline/force-probes.js',
    'bot/cards/pipeline/probe-fixture.js', 'bot/env.js', 'bot/omni/rs/state.js', 'bot/players/index.js'] };
