'use strict';
const assert = require('node:assert/strict');
const { constructProbeFixture } = require('./probe-fixture');
const { fullState, canonicalAction, expandActions } = require('../../omni/rs/state');
function forceObject(player) {
    const cards = [...player.baseZone.cards, ...player.outsideTheGameZone.getCards()].filter(c => c.isForceToken());
    assert.equal(cards.length, 1, 'Exactly one precreated Force identity per player');
    return cards[0];
}
async function fixture(env, pool, scenario, seed) {
    const p = scenario.probe;
    assert.equal(p.family, 'force');
    const { eg, rng, bot, deck, own, enemy, source, targets } = await constructProbeFixture(env, pool, scenario, seed);
    const ownForce = forceObject(own), enemyForce = forceObject(enemy);
    if (p.held) ownForce.moveTo('base');
    if (p.enemyHeld) enemyForce.moveTo('base');
    if (p.deckSize !== undefined) {
        for (const c of own.drawDeck.slice(p.deckSize)) c.moveTo('discard');
        assert.equal(own.drawDeck.length, p.deckSize);
    }
    own.base.damage = p.baseDamage ?? 0;
    eg.game.resolveGameState(true); eg.game.continue();
    const initial = { hand: own.getCardsInZone('hand').length, deck: own.drawDeck.length,
        baseDamage: own.base.damage, ownId: eg.cardId(ownForce.uuid), enemyId: eg.cardId(enemyForce.uuid),
        nextCardId: eg.game.state.allCards.length, readyResources: own.getCardsInZone('resource').filter(c => !c.exhausted).length };
    const availableAspects = [...own.getAspectsForCosts()];
    let focusCost = source.cardData.cost;
    for (const aspect of source.cardData.aspects) {
        const index = availableAspects.indexOf(aspect);
        if (index < 0) focusCost += 2;
        else availableAspects.splice(index, 1);
    }
    const witness = { coverageObligationIds: [], observations: [], forceEvents: [], checkpoints: [] };
    const records = [{ type: 'meta', schema: 'omni-rs-trace-v1', pool: pool.provenance, seed,
        bots: ['force-probe', 'force-probe'], decks: [deck, deck], scenario: scenario.name,
        fixtureConstruction: 'Stage disclosed precreated native Force tokens, optional exhausted old unique copy/resources and deck boundaries at first action window. All focus/donor gain/use/regain and uniqueness decisions are normal recorded inputs. Versioned fullState includes both actual token IDs and held states.', constructionParameters: p }];
    const sequence = p.lifecycle ? [source, targets[2], targets[0], targets[3], targets[1]] : [source];
    let index = 0, started = false, played = false, settled = false, declined = false, optionalMenus = 0, step = 0;
    eg.game.on('onCardPlayed', e => {
        if (!settled && started && !e.isCancelledOrReplaced && e.card === sequence[index]) played = true;
    });
    eg.game.on('onCardLeavesPlay', e => {
        if (!settled && started && e.card.isForceToken()) witness.forceEvents.push({ kind: 'leave',
            owner: eg.seatOf(e.card.owner.id), id: eg.cardId(e.card.uuid), zone: e.card.zoneName });
    });
    eg.game.on('onForceUsed', e => {
        if (!settled && started) witness.forceEvents.push({ kind: 'use', owner: eg.seatOf(e.player.id) });
    });
    eg.game.on('onTokensCreated', e => {
        if (!settled && started && e.tokenType === 'the-force') witness.forceEvents.push({ kind: 'gain',
            owner: eg.seatOf(e.player.id), ids: (e.generatedTokens ?? []).map(t => eg.cardId(t.uuid)) });
    });
    function assertIdentity() {
        assert.equal(eg.game.state.allCards.length, initial.nextCardId, 'Gain/use reuses existing token, never allocates card identity');
        assert.equal(eg.cardId(ownForce.uuid), initial.ownId);
        assert.equal(eg.cardId(enemyForce.uuid), initial.enemyId);
        const state = fullState(eg);
        assert.equal(state.forceStateVersion, 1);
        assert.deepEqual(state.players.p1.forceToken, { id: initial.ownId, held: own.hasTheForce });
        assert.deepEqual(state.players.p2.forceToken, { id: initial.enemyId, held: enemy.hasTheForce });
    }
    function observe(stage, pid, actions) {
        assertIdentity();
        witness.observations.push({ stage, actor: pid ? eg.seatOf(pid) : undefined,
            actions: actions?.map(a => canonicalAction(eg, a)), sourceZone: source.zoneName,
            sourceExhausted: source.isInPlay() ? source.exhausted : null, state: fullState(eg) });
    }
    function assertSingleOutcome() {
        assert.equal(own.getCardsInZone('resource').filter(c => !c.exhausted).length, initial.readyResources - focusCost, 'Exact printed focus play cost plus absent-aspect penalties');
        const used = p.kind !== 'gain' && p.held && !p.decline;
        assert.equal(own.hasTheForce, p.kind === 'gain' || !!p.held && !used);
        assert.equal(enemy.hasTheForce, !!p.enemyHeld, 'Acting-player Force is independent of opponent');
        assert.equal(witness.forceEvents.filter(e => e.kind === 'use').length, used ? 1 : 0);
        assert.equal(optionalMenus, p.kind !== 'gain' && p.held ? 1 : 0, 'Optional prompt iff acting player actually holds Force');
        if (used) assert.deepEqual(witness.forceEvents.map(e => e.kind), ['leave', 'use']);
        if (p.kind === 'gain') {
            const gains = witness.forceEvents.filter(e => e.kind === 'gain');
            assert.equal(gains.length, p.held ? 0 : 1);
            if (!p.held) assert.deepEqual(gains[0], { kind: 'gain', owner: 'p1', ids: [initial.ownId] });
        }
        if (p.decline && p.held) assert.ok(declined);
        if (p.kind === 'draw') {
            assert.equal(own.getCardsInZone('hand').length, initial.hand - 1 + (used ? Math.min(p.drawAmount, initial.deck) : 0));
            assert.equal(own.base.damage, initial.baseDamage + (used ? 3 * Math.max(0, p.drawAmount - initial.deck) : 0));
        }
        if (p.kind === 'ready' && source.isInPlay()) assert.equal(source.exhausted, !used);
        if (p.uniqueReplacement) {
            assert.equal(source.zoneName, p.keepOld ? 'discard' : p.sourceArena + 'Arena');
            assert.equal(targets[0].zoneName, p.keepOld ? p.sourceArena + 'Arena' : 'discard');
            if (p.keepOld) assert.equal(targets[0].exhausted, true, 'Ready cannot retarget surviving old copy');
        }
        if (p.lethalFatigue) { assert.ok(eg.over); assert.equal(eg.winner, 'p2'); }
        observe('source-resolved');
        settled = true;
    }
    function assertLifecycleCheckpoint() {
        assertIdentity();
        if (index === 0) assert.equal(own.getCardsInZone('resource').filter(c => !c.exhausted).length, initial.readyResources - focusCost);
        const expectedOwn = [true, true, false, false, true][index];
        const expectedEnemy = index === 0 ? !!p.enemyHeld : true;
        assert.equal(own.hasTheForce, expectedOwn);
        assert.equal(enemy.hasTheForce, expectedEnemy);
        if (index === 2) assert.equal(targets[0].exhausted, false);
        if (index === 3) assert.equal(targets[3].exhausted, true, 'Second use without regain has no effect');
        witness.checkpoints.push({ index, played: eg.cardId(sequence[index].uuid), state: fullState(eg) });
        index++; started = false; played = false;
        if (index === sequence.length) {
            assert.equal(witness.forceEvents.filter(e => e.kind === 'use').length, 1);
            assert.equal(optionalMenus, 1, 'Absent repeated use skips optional registration');
            const gains = witness.forceEvents.filter(e => e.kind === 'gain');
            assert.deepEqual(gains.map(e => [e.owner, e.ids]), [['p1', [initial.ownId]],
                ...(!p.enemyHeld ? [['p2', [initial.enemyId]]] : []), ['p1', [initial.ownId]]]);
            observe('actual-gain-use-absent-repeat-regain');
            settled = true;
        }
    }
    try {
        while (!eg.over && step < 4000) {
            const pid = eg.ids.find(id => eg.legalActions(id).length);
            assert.ok(pid);
            const actions = expandActions(eg, eg.legalActions(pid)), window = eg.isActionWindow(pid);
            const prompt = eg.player(pid).currentPrompt();
            let chosen;
            if (window) {
                records.push({ type: 'state', step, state: fullState(eg, pid) });
                if (!settled && started && played) {
                    if (p.lifecycle) assertLifecycleCheckpoint();
                    else assertSingleOutcome();
                }
                if (!settled && !started && pid === sequence[index].controller.id) {
                    chosen = actions.find(a => a.cardUuid === sequence[index].uuid);
                    assert.ok(chosen, 'Normal actual focus/gain/use/regain card play');
                    started = true;
                } else if (!settled) chosen = actions.find(a => a.arg === 'pass');
            } else if (!settled && started) {
                if (p.uniqueReplacement && actions.some(a => a.cardUuid === source.uuid) &&
                    actions.some(a => a.cardUuid === targets[0].uuid)) {
                    assert.equal(pid, own.id);
                    assert.match(prompt.menuTitle, /Choose which copy.*to defeat/);
                    observe('unique-copy-defeat-choice', pid, actions);
                    chosen = actions.find(a => a.cardUuid === (p.keepOld ? source.uuid : targets[0].uuid));
                } else if (actions.some(a => a.label === 'Pass')) {
                    assert.equal(pid, own.id);
                    assert.deepEqual(actions.map(a => a.label), ['Trigger', 'Pass']);
                    observe('optional-force-use', pid, actions);
                    optionalMenus++;
                    chosen = actions.find(a => a.label === (p.decline ? 'Pass' : 'Trigger'));
                    declined = !!p.decline;
                }
                chosen ??= actions.find(a => a.kind === 'button' && /trigger|resolve|yes/i.test(a.label ?? ''));
                chosen ??= actions.find(a => a.arg === 'done');
            }
            chosen ??= bot.choose({ game: eg, pid, actions, rng });
            assert.ok(chosen);
            records.push({ type: 'decision', step, actor: eg.seatOf(pid), prompt: {
                type: prompt.promptType ?? null, title: prompt.menuTitle ?? null,
                selected: (eg.player(pid).promptState.selectedCards ?? []).map(c => eg.cardId(c.uuid)), actionWindow: window },
                actions: actions.map(a => canonicalAction(eg, a)), chosen: canonicalAction(eg, chosen).key, events: [] });
            eg.apply(pid, chosen, rng); step++;
        }
        if (!settled && p.lethalFatigue && played) assertSingleOutcome();
        assert.ok(settled, 'Focused actual Force source behavior settled');
        assert.ok(eg.over);
        records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
        witness.coverageObligationIds = [...scenario.coverageObligationIds];
        return { records, witness };
    } finally { bot.close?.(); }
}
module.exports = { fixture, dependencies: ['bot/cards/pipeline/force-probes.js',
    'bot/cards/pipeline/force-probe-fixture.js', 'bot/cards/pipeline/probe-fixture.js',
    'bot/env.js', 'bot/omni/rs/state.js', 'bot/players/index.js'] };
