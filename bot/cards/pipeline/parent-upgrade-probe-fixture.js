'use strict';
const assert = require('node:assert/strict');
const { constructProbeFixture } = require('./probe-fixture');
const { fullState, expandActions, canonicalAction } = require('../../omni/rs/state');
function summary(eg, card) {
    return { id: eg.cardId(card.uuid), zone: card.zoneName, owner: eg.seatOf(card.owner.id), controller: eg.seatOf(card.controller.id),
        ...(card.isUnit?.() && card.isInPlay?.() ? { hp: card.getHp(), power: card.getPower(), damage: card.damage, exhausted: card.exhausted, upgrades: card.upgrades.map(u => eg.cardId(u.uuid)) } : {}) };
}
async function fixture(env, pool, scenario, seed) {
    const p = scenario.probe;
    assert.equal(p.family, 'parent-upgrade');
    const reverse = p.sourceSeat === 2;
    const constructed = { ...p, initiative: reverse ? 'opponent' : 'self', targets: [
            ...p.targets.map(t => ({ ...t, owner: reverse ? (t.owner === 'self' ? 'opponent' : 'self') : t.owner })),
            ...(reverse ? [{ code: p.cardId, owner: 'opponent', zone: 'hand' }] : [])
        ] };
    const setup = await constructProbeFixture(env, pool, { ...scenario, probe: constructed }, seed);
    const { eg, rng, bot, deck } = setup;
    const targets = setup.targets.slice(), own = reverse ? setup.enemy : setup.own, enemy = reverse ? setup.own : setup.enemy;
    const source = reverse ? targets.pop() : setup.source, host = targets[p.hostIndex];
    const sequence = p.removal ? [source, targets[p.torrentIndex], targets[p.returnIndex]] : [source];
    const initial = fullState(eg), beforeHost = summary(eg, host), originalUpgrades = host.upgrades.slice();
    const otherUnits = new Map(eg.game.getArenaUnits().filter(c => c !== host).map(c => [c, summary(eg, c)]));
    const created = [], attachments = [], events = [], titles = [];
    const witness = { coverageObligationIds: [], observations: [], events, titles };
    const records = [{ type: 'meta', schema: 'omni-rs-trace-v1', pool: pool.provenance, seed, bots: ['parent-upgrade-probe', 'parent-upgrade-probe'],
            decks: [deck, deck], scenario: scenario.name, constructionParameters: p,
            fixtureConstruction: 'Disclosed actual unit/token/deployed-leader recipients and existing native Shield; normal upgrade attachment/cancellation and optional actual Naboo Torrent plus Criminal Muscle return. Every macro input and terminal result recorded; no synthetic parent fallback.' }];
    let index = 0, started = false, played = false, cancelled = false, settled = false, step = 0, readyBefore, focusBefore;
    const ready = () => own.getCardsInZone('resource').filter(c => !c.exhausted).length;
    const cost = card => {
        const aspects = [...own.getAspectsForCosts()];
        let amount = card.cardData.cost;
        for (const aspect of card.cardData.aspects) {
            const i = aspects.indexOf(aspect);
            if (i < 0)
                amount += 2;
            else
                aspects.splice(i, 1);
        }
        return amount;
    };
    const observe = name => witness.observations.push({ name, source: summary(eg, source), host: summary(eg, host), created: created.map(c => summary(eg, c)), state: fullState(eg) });
    eg.game.on('onCardPlayed', event => {
        if (started && !settled && event.card === sequence[index] && !event.isCancelledOrReplaced)
            played = true;
        if (started && !settled && event.card === source && !event.isCancelledOrReplaced) {
            for (const ability of source.getTriggeredAbilities())
                titles.push(ability.getTitle(ability.createContext(own, event)));
        }
    });
    for (const name of ['onCardPlayed', 'onTokensCreated', 'onUpgradeAttached', 'onCardDefeated', 'onCardLeavesPlay']) {
        eg.game.on(name, event => {
            if (!started || settled)
                return;
            const window = eg.game.currentEventWindow;
            if (name === 'onTokensCreated' && !event.isCancelledOrReplaced)
                created.push(...event.generatedTokens ?? []);
            if (name === 'onUpgradeAttached' && !event.isCancelledOrReplaced)
                attachments.push({ id: eg.cardId(event.upgradeCard.uuid), parent: eg.cardId(event.parentCard.uuid) });
            events.push({ name, index, sourceId: event.context?.source?.uuid ? eg.cardId(event.context.source.uuid) : null, cardId: event.card?.uuid ? eg.cardId(event.card.uuid) : null,
                cards: (event.cards ?? []).map(c => eg.cardId(c.uuid)), tokens: (event.generatedTokens ?? []).map(c => eg.cardId(c.uuid)), player: event.player?.id ? eg.seatOf(event.player.id) : null,
                mode: window?.triggerHandlingMode, eventNames: window?.events.map(e => e.name), source: summary(eg, source), host: summary(eg, host), state: fullState(eg) });
        });
    }
    function assertUnchangedOthers() {
        for (const [card, before] of otherUnits) {
            assert.ok(card.isInPlay(), 'Unselected original unit remains in play');
            assert.deepEqual(summary(eg, card), before);
        }
        assert.equal(own.base.damage, initial.players[eg.seatOf(own.id)].base.damage);
        assert.equal(enemy.base.damage, initial.players[eg.seatOf(enemy.id)].base.damage);
        for (const player of ['p1', 'p2'])
            assert.deepEqual(fullState(eg).players[player].forceToken, initial.players[player].forceToken);
    }
    function assertFocus() {
        assert.equal(source.parentCard, host);
        assert.equal(source.controller, own);
        assert.equal(source.owner, own);
        assert.equal(source.zoneName, host.zoneName);
        assert.equal(host.getHp(), beforeHost.hp + source.cardData.upgradeHp);
        assert.equal(host.getPower(), beforeHost.power + source.cardData.upgradePower);
        assert.equal(host.damage, beforeHost.damage);
        assert.equal(host.exhausted, beforeHost.exhausted);
        assert.equal(created.length, p.positive ? 1 : 0);
        assert.equal(fullState(eg).nextCardId, initial.nextCardId + (p.positive ? 1 : 0));
        assert.deepEqual(attachments[0], { id: eg.cardId(source.uuid), parent: eg.cardId(host.uuid) });
        assert.deepEqual(host.upgrades.slice(0, originalUpgrades.length), originalUpgrades, 'Existing attachment identities/order preserved');
        const attach = events.findIndex(e => e.name === 'onUpgradeAttached' && e.index === 0), play = events.findIndex(e => e.name === 'onCardPlayed' && e.cardId === eg.cardId(source.uuid));
        assert.ok(attach >= 0 && play > attach, 'Physical ordinary attachment precedes source played event');
        if (p.mode === 'parent-aspect-shield')
            assert.deepEqual(titles, [p.titlePrefix + host.title], 'Actual captured ability context evaluates exact host title');
        if (p.positive) {
            const token = created[0];
            assert.equal(eg.cardId(token.uuid), 'c' + initial.nextCardId);
            const create = events.findIndex(e => e.name === 'onTokensCreated' && e.index === 0);
            assert.ok(create > play, 'Condition/token creation occurs after attached source play');
            assert.equal(events[create].player, eg.seatOf(own.id), 'Event creator is the caster');
            if (p.mode === 'parent-trait-beast') {
                assert.equal(token.internalName, 'beast');
                assert.equal(token.owner, own);
                assert.equal(token.controller, own);
                assert.equal(token.zoneName, 'groundArena');
                assert.equal(token.exhausted, true);
                assert.equal(token.getHp(), 3);
                assert.equal(token.getPower(), 3);
                assert.equal(host.upgrades.length, originalUpgrades.length + 1);
            }
            else {
                assert.ok(token.isShield());
                assert.equal(token.parentCard, host);
                assert.equal(token.owner, host.controller);
                assert.equal(token.controller, host.controller);
                assert.equal(host.upgrades.length, originalUpgrades.length + 2);
                assert.deepEqual(attachments[1], { id: eg.cardId(token.uuid), parent: eg.cardId(host.uuid) });
            }
        }
        else
            assert.equal(host.upgrades.length, originalUpgrades.length + 1, 'False condition still applies printed upgrade stats');
        assertUnchangedOthers();
        observe('actual-parent-conditioned-source-settled');
    }
    function assertStage() {
        if (cancelled) {
            assert.deepEqual(fullState(eg), focusBefore, 'Prepayment Cancel restores exact source action-window state');
            assert.equal(created.length, 0);
            assert.equal(attachments.length, 0);
            observe('actual-prepayment-cancel');
            return;
        }
        assert.equal(ready(), readyBefore - cost(sequence[index]), 'Exact printed/aspect payment for each actually played macro card');
        if (index === 0)
            assertFocus();
        else if (index === 1) {
            assert.ok(host.isInPlay());
            assert.equal(host.getHp(), beforeHost.hp + 2 - 2);
            assert.equal(host.damage, 2);
            const weakness = created.filter(c => c.isWeakness());
            assert.equal(weakness.length, 2);
            assert.equal(host.upgrades.filter(c => c.isWeakness()).length, 2);
            assert.deepEqual(weakness.map(c => eg.cardId(c.uuid)), ['c' + (initial.nextCardId + (p.positive ? 1 : 0)), 'c' + (initial.nextCardId + (p.positive ? 1 : 0) + 1)]);
            observe('actual-two-weakness-nonlethal');
        }
        else {
            assert.equal(source.zoneName, 'hand');
            assert.equal(source.owner, own);
            assert.equal(source.isAttached(), false);
            assert.equal(host.zoneName, 'discard', 'Loss of positive HP kills wounded host');
            for (const token of created.filter(c => !c.isUnit())) {
                assert.equal(token.zoneName, 'outsideTheGame');
                assert.equal(token.isAttached(), false);
            }
            for (const upgrade of originalUpgrades) {
                assert.equal(upgrade.zoneName, 'outsideTheGame');
                assert.equal(upgrade.isAttached(), false);
            }
            if (p.mode === 'parent-trait-beast') {
                const beast = created.find(c => c.isUnit());
                assert.ok(beast.isInPlay());
                assert.equal(beast.controller, own);
                assert.equal(beast.getHp(), 3);
            }
            assert.throws(() => source.parentCard, 'Pinned detached getter asserts; no captured detached WP invoked');
            assertUnchangedOthers();
            observe('actual-return-hp-death-cleanup');
        }
    }
    try {
        while (!eg.over && step < 4000) {
            const pid = eg.ids.find(id => eg.legalActions(id).length);
            assert.ok(pid);
            const actions = expandActions(eg, eg.legalActions(pid)), window = eg.isActionWindow(pid), prompt = eg.player(pid).currentPrompt();
            let chosen;
            if (window) {
                records.push({ type: 'state', step, state: fullState(eg, pid) });
                if (!settled && started && (played || cancelled)) {
                    assertStage();
                    index++;
                    started = false;
                    played = false;
                    if (cancelled || index === sequence.length) {
                        settled = true;
                        witness.coverageObligationIds = [...scenario.coverageObligationIds];
                    }
                }
                if (!settled) {
                    chosen = pid === own.id && !started ? actions.find(a => a.cardUuid === sequence[index].uuid) : actions.find(a => a.arg === 'pass');
                    assert.ok(chosen, 'Normal actual source/macro card selectable');
                    if (chosen.cardUuid === sequence[index].uuid) {
                        started = true;
                        readyBefore = ready();
                        if (index === 0)
                            focusBefore = fullState(eg);
                    }
                }
            }
            else if (!settled && started) {
                if (index === 0 && actions.some(a => a.cardUuid === host.uuid)) {
                    assert.equal(pid, own.id, 'Caster chooses attachment host even on enemy unit');
                    assert.equal(source.zoneName, 'hand');
                    assert.equal(ready(), readyBefore);
                    assert.equal(fullState(eg).nextCardId, initial.nextCardId);
                    assert.deepEqual(actions.filter(a => a.kind === 'card').map(a => a.cardUuid).sort(), eg.game.getArenaUnits().map(c => c.uuid).sort(), 'All actual arena units and no bases/upgrades are normal legal hosts');
                    chosen = p.cancel ? actions.find(a => a.arg === 'cancel') : actions.find(a => a.cardUuid === host.uuid);
                    assert.ok(chosen);
                    if (p.cancel)
                        cancelled = true;
                }
                else if (index === 1 && actions.some(a => a.cardUuid === host.uuid))
                    chosen = actions.find(a => a.cardUuid === host.uuid);
                else if (index === 2 && actions.some(a => a.cardUuid === source.uuid))
                    chosen = actions.find(a => a.cardUuid === source.uuid);
                chosen ??= actions.find(a => a.label === 'Trigger');
                chosen ??= actions.find(a => a.kind === 'button' && /trigger|resolve|play anyway/i.test(a.label ?? ''));
            }
            chosen ??= bot.choose({ game: eg, pid, actions, rng });
            assert.ok(chosen);
            records.push({ type: 'decision', step, actor: eg.seatOf(pid), prompt: { type: prompt.promptType ?? null, title: prompt.menuTitle ?? null,
                    selected: (eg.player(pid).promptState.selectedCards ?? []).map(c => eg.cardId(c.uuid)), actionWindow: window },
                actions: actions.map(a => canonicalAction(eg, a)), chosen: canonicalAction(eg, chosen).key, events: [] });
            eg.apply(pid, chosen, rng);
            step++;
        }
        assert.ok(settled, 'Bounded actual source behavior settled');
        assert.ok(eg.over, 'Full terminal game recorded');
        records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
        return { records, witness };
    }
    finally {
        bot.close?.();
    }
}
module.exports = { fixture, dependencies: ['bot/cards/pipeline/parent-upgrade-probes.js', 'bot/cards/pipeline/parent-upgrade-probe-fixture.js',
        'bot/cards/pipeline/probe-fixture.js', 'bot/omni/rs/make-pool.js', 'bot/env.js', 'bot/omni/rs/state.js', 'bot/players/index.js'] };
