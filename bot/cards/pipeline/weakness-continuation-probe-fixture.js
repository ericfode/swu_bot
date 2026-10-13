'use strict';
const assert = require('node:assert/strict');
const { constructProbeFixture } = require('./probe-fixture');
const { fullState, expandActions, canonicalAction } = require('../../omni/rs/state');
function summary(eg, c) { return c ? { id: eg.cardId(c.uuid), name: c.internalName, zone: c.zoneName, owner: eg.seatOf(c.owner.id), controller: eg.seatOf(c.controller.id), ...(c.isUnit?.() && c.isInPlay?.() ? { exhausted: c.exhausted, damage: c.damage, hp: c.getHp(), power: c.getPower(), upgrades: c.upgrades.map(u => ({ id: eg.cardId(u.uuid), name: u.internalName, zone: u.zoneName })) } : {}) } : null; }
async function fixture(env, pool, scenario, seed) {
    const c = scenario.probe;
    assert.equal(c.family, 'weakness-continuation');
    const reverse = c.sourceSeat === 2;
    const p = { ...c, initiative: reverse ? 'opponent' : 'self', baseCode: reverse ? c.enemyBaseCode : c.baseCode, enemyBaseCode: reverse ? c.baseCode : c.enemyBaseCode,
        targets: [...c.targets.map(t => ({ ...t, owner: reverse ? (t.owner === 'self' ? 'opponent' : 'self') : t.owner })), ...(reverse ? [{ code: c.cardId, owner: 'opponent', zone: 'hand' }] : []), ...(reverse && c.activationCode ? [{ code: c.activationCode, owner: 'opponent', zone: 'hand' }] : [])] };
    const setup = await constructProbeFixture(env, pool, { ...scenario, probe: p }, seed), { eg, rng, bot, deck } = setup;
    const targets = setup.targets.slice(), own = reverse ? setup.enemy : setup.own, enemy = reverse ? setup.own : setup.enemy;
    const kill = reverse && c.activationCode ? targets.pop() : setup.activation, source = reverse ? targets.pop() : setup.source, donor = targets[c.selectedIndex];
    const unique = donor?.cardData.unique === true;
    const witness = { coverageObligationIds: [], observations: [] }, records = [{ type: 'meta', schema: 'omni-rs-trace-v1', pool: pool.provenance, seed, bots: ['weakness-continuation-probe', 'weakness-continuation-probe'], decks: [deck, deck], scenario: scenario.name, constructionParameters: c,
            fixtureConstruction: 'Disclosed printed recipients, normal source play, actual defeat event for death registration, real generated token and negative stat cleanup; full terminal source recording.' }];
    let step = 0;
    let selectedTarget = c.variant === 'source' ? source : c.variant === 'created-beast' ? null : donor;
    const before = fullState(eg), beforeDonor = summary(eg, donor), beforeReady = own.getCardsInZone('resource').filter(c => !c.exhausted).length;
    const cost = card => {
        const aspects = [...own.getAspectsForCosts()];
        let amount = card.cardData.cost;
        for (const a of card.cardData.aspects) {
            const i = aspects.indexOf(a);
            if (i < 0)
                amount += 2;
            else
                aspects.splice(i, 1);
        }
        return amount;
    };
    const initialTargets = new Map(targets.map(t => [t, summary(eg, t)]));
    const originalShields = donor?.isInPlay?.() ? donor.upgrades.filter(t => t.isShield()).slice() : [];
    let playCostChecked = false;
    const created = [], attached = [], events = [], inputs = [];
    let prerequisiteStarted = false, prerequisitePlayed = false;
    let started = false, played = false, deathStarted = false, sourceDead = false, cancelled = false, declined = false, settled = false, selected = false, initialSelection = null;
    const observe = (name, e) => {
        if (started && !settled) {
            const w = eg.game.currentEventWindow;
            events.push({ name, source: e.context?.source?.internalName, sourceId: e.context?.source?.uuid ? eg.cardId(e.context.source.uuid) : null, cancelled: e.isCancelledOrReplaced, window: w ? { triggerHandlingMode: w.triggerHandlingMode, subwindowEventHandlingMode: w.subwindowEventHandlingMode, eventNames: w.events.map(e => e.name) } : null, card: summary(eg, e.card?.uuid ? e.card : null), target: summary(eg, selectedTarget), sourceZone: source.zoneName, state: fullState(eg) });
        }
    };
    eg.game.on('onCardPlayed', e => {
        if (c.snokeEntry && e.card === targets[c.prerequisiteIndex] && !e.isCancelledOrReplaced)
            prerequisitePlayed = true;
        if (started && !settled && e.card === source && !e.isCancelledOrReplaced)
            played = true;
        observe('onCardPlayed', e);
    });
    eg.game.on('onCardDefeated', e => {
        if (e.card === source && deathStarted && !e.isCancelledOrReplaced)
            sourceDead = true;
        observe('onCardDefeated', e);
    });
    eg.game.on('onTokensCreated', e => {
        if (started && !settled && (e.context?.source === source || c.uniqueReplacement && e.context?.source === targets[1]) && !e.isCancelledOrReplaced) {
            created.push(...(e.generatedTokens ?? []));
            if (c.variant === 'created-beast')
                selectedTarget ??= (e.generatedTokens ?? []).find(t => t.internalName === 'beast');
        }
        observe('onTokensCreated', e);
    });
    eg.game.on('onUpgradeAttached', e => {
        if (started && !settled && (e.context?.source === source || c.uniqueReplacement && e.context?.source === targets[1]) && e.upgradeCard?.isWeakness?.())
            attached.push({ id: eg.cardId(e.upgradeCard.uuid), parent: eg.cardId(e.parentCard.uuid), state: summary(eg, e.parentCard) });
        observe('onUpgradeAttached', e);
    });
    for (const name of ['onDamageDealt', 'onCardExhausted'])
        eg.game.on(name, e => observe(name, e));
    try {
        for (; step < 100 && !settled; step++) {
            const pid = eg.ids.find(id => eg.legalActions(id).length);
            assert.ok(pid, 'No actor before settlement');
            const actions = expandActions(eg, eg.legalActions(pid)), window = eg.isActionWindow(pid), prompt = eg.player(pid).currentPrompt();
            if (window && played && !playCostChecked) {
                assert.equal(own.getCardsInZone('resource').filter(c => !c.exhausted).length, beforeReady - cost(source), 'Exact printed/aspect source payment');
                playCostChecked = true;
            }
            if (window && started && (cancelled || (c.trigger === 'death' ? sourceDead : played))) {
                settled = true;
                break;
            }
            if (window)
                records.push({ type: 'state', step, state: fullState(eg, pid) });
            let chosen;
            if (window) {
                if (c.snokeEntry && !prerequisitePlayed) {
                    if (pid === enemy.id && !prerequisiteStarted) {
                        chosen = actions.find(a => a.cardUuid === targets[c.prerequisiteIndex].uuid);
                        assert.ok(chosen, 'Normally play actual enemy -2/-2 source');
                        prerequisiteStarted = true;
                    }
                    else
                        chosen = actions.find(a => a.arg === 'pass');
                }
                else if (pid === own.id && !started) {
                    chosen = actions.find(a => a.cardUuid === source.uuid);
                    assert.ok(chosen, 'Ordinary source play available');
                    started = true;
                }
                else if (pid === own.id && played && c.trigger === 'death' && !deathStarted) {
                    chosen = actions.find(a => a.cardUuid === kill.uuid);
                    assert.ok(chosen, 'Ordinary defeat event available');
                    deathStarted = true;
                }
                else
                    chosen = actions.find(a => a.arg === 'pass');
            }
            else if (started) {
                if (c.uniqueReplacement && actions.some(a => a.cardUuid === source.uuid) && actions.some(a => a.cardUuid === targets[1].uuid)) {
                    assert.equal(source.getHp(), source.cardData.hp);
                    assert.equal(source.getPower(), source.cardData.power);
                    assert.equal(targets[1].getHp(), source.cardData.hp);
                    assert.equal(targets[1].getPower(), source.cardData.power);
                    chosen = actions.find(a => a.cardUuid === (c.keepOld ? source.uuid : targets[1].uuid));
                    assert.ok(chosen);
                }
                if (['cancel', 'empty-cancel'].includes(c.variant) && !played) {
                    chosen = actions.find(a => a.arg === 'cancel' || a.label === 'Cancel');
                    if (chosen)
                        cancelled = true;
                }
                if (deathStarted && !sourceDead)
                    chosen ??= actions.find(a => a.cardUuid === source.uuid);
                const declineThis = c.variant === 'decline' || c.trigger === 'death' && !deathStarted;
                if (!chosen && declineThis) {
                    chosen = actions.find(a => a.label === 'Pass');
                    if (chosen && !(c.trigger === 'death' && !deathStarted))
                        declined = true;
                }
                if (!chosen && (!deathStarted || sourceDead) && selectedTarget) {
                    chosen = actions.find(a => a.cardUuid === selectedTarget.uuid);
                    if (chosen) {
                        assert.equal(pid, own.id);
                        const domain = eg.game.getArenaUnits().filter(card => c.mode !== 'beast-then' || card.controller === own);
                        assert.deepEqual(actions.filter(a => a.kind === 'card').map(a => a.cardUuid).sort(), domain.map(card => card.uuid).sort(), 'Exact friendly or any-unit continuation legality');
                        if (!initialSelection)
                            initialSelection = summary(eg, selectedTarget);
                        selected = true;
                    }
                }
                chosen ??= actions.find(a => a.kind === 'button' && !/pass|cancel|no|decline/i.test(a.label ?? '') && /play|trigger|resolve|give|create|use|yes|shield/i.test(a.label ?? ''));
            }
            chosen ??= actions.length === 1 ? actions[0] : undefined;
            assert.ok(chosen, JSON.stringify({ prompt: prompt.menuTitle, actions: actions.map(a => canonicalAction(eg, a)) }));
            records.push({ type: 'decision', step, actor: eg.seatOf(pid), prompt: { type: prompt.promptType ?? null, title: prompt.menuTitle ?? null, selected: (eg.player(pid).promptState.selectedCards ?? []).map(card => eg.cardId(card.uuid ?? card)), actionWindow: window }, actions: actions.map(a => canonicalAction(eg, a)), chosen: canonicalAction(eg, chosen).key, events: [] });
            inputs.push({ step, actor: eg.seatOf(pid), prompt: prompt.menuTitle, actions: actions.map(a => canonicalAction(eg, a)), chosen: canonicalAction(eg, chosen), state: fullState(eg, pid) });
            eg.apply(pid, chosen, rng);
        }
        assert.ok(settled, 'Ability did not settle');
        assert.equal(cancelled, ['cancel', 'empty-cancel'].includes(c.variant));
        if (cancelled) {
            assert.deepEqual(fullState(eg), before, 'Event cancellation preserves entire state');
        }
        else {
            assert.ok(played);
            if (c.uniqueReplacement) {
                assert.equal(source.zoneName, c.keepOld ? 'discard' : source.cardData.arena + 'Arena');
                assert.equal(targets[1].zoneName, c.keepOld ? source.cardData.arena + 'Arena' : 'discard');
                const tokenSources = events.filter(e => e.name === 'onTokensCreated' && e.source === source.internalName).map(e => e.sourceId).sort();
                assert.deepEqual(tokenSources, [eg.cardId(source.uuid), eg.cardId(c.keepOld ? source.uuid : targets[1].uuid)].sort(), 'Both original printed WP and WD registrations resolve exactly once');
            }
            if (c.trigger === 'death') {
                assert.ok(sourceDead);
                assert.equal(own.getCardsInZone('resource').filter(card => !card.exhausted).length, beforeReady - cost(source) - cost(kill), 'Exact actual defeat-event printed/aspect payment');
            }
            if (c.variant === 'decline')
                assert.ok(declined);
            const weak = created.filter(t => t.isWeakness?.()), beasts = created.filter(t => t.internalName === 'beast');
            const expectedWeak = c.variant === 'decline' ? 0 : c.expectedWeak ?? 1;
            // This exact simultaneous shape attaches its generated token before delayed damage defeat.
            const expectedAlloc = expectedWeak + (c.mode === 'beast-then' ? 1 : 0);
            assert.equal(fullState(eg).nextCardId, before.nextCardId + expectedAlloc, 'Exact token identity allocation');
            assert.equal(beasts.length, c.mode === 'beast-then' ? 1 : 0);
            if (c.forceDeath)
                assert.equal(selectedTarget.owner.hasTheForce, true, 'Captured actual recipient death grants own Force');
            assert.equal(weak.length, expectedWeak, 'Actual token-created event amount');
            assert.equal(attached.length, expectedWeak, 'Each generated Weakness attaches before state-based departure');
            assert.deepEqual(attached.map(e => e.id), weak.map(t => eg.cardId(t.uuid)), 'All generated token IDs attach in allocation order');
            assert.deepEqual(weak.map(t => eg.cardId(t.uuid)), Array.from({ length: expectedWeak }, (_, i) => 'c' + (before.nextCardId + (c.mode === 'beast-then' ? 1 : 0) + i)), 'Exact fresh physical Weakness identities');
            for (const token of weak) {
                assert.equal(token.owner, selectedTarget.controller);
                assert.equal(token.cardData.upgradePower, -1);
                assert.equal(token.cardData.upgradeHp, -1);
            }
            if (c.variant !== 'decline' && !c.empty)
                assert.ok(selected, 'Selected intended physical target');
            if (c.variant === 'decline')
                assert.deepEqual(summary(eg, donor), beforeDonor);
            else if (c.snokeEntry) {
                assert.equal(source.zoneName, 'discard', 'Entering focus physically dies before captured WP');
                assert.equal(selectedTarget.zoneName, 'outsideTheGame', 'Created Beast dies under reduced HP plus Weakness');
                assert.equal(initialSelection.hp, 1);
                const sourceDeath = events.findIndex(e => e.name === 'onCardDefeated' && e.card?.id === eg.cardId(source.uuid)), create = events.findIndex(e => e.name === 'onTokensCreated'), attach = events.findIndex(e => e.name === 'onUpgradeAttached'), beastDeath = events.findIndex(e => e.name === 'onCardDefeated' && e.card?.id === eg.cardId(selectedTarget.uuid));
                assert.ok(sourceDeath >= 0 && sourceDeath < create && create < attach && attach < beastDeath, 'Physical source death precedes captured Beast creation then attachment/death');
            }
            else if (['damage-lethal', 'hp-lethal', 'unique-lethal', 'lethal', 'death-force', 'death-hevy'].includes(c.variant))
                assert.equal(selectedTarget.zoneName, 'discard', 'Damage or negative HP defeats target');
            else if (!c.empty) {
                assert.equal(selectedTarget.getHp(), initialSelection.hp - expectedWeak);
                assert.equal(selectedTarget.getPower(), Math.max(0, initialSelection.power - expectedWeak));
                assert.equal(selectedTarget.damage, initialSelection.damage + (c.mode === 'damage-pair' && c.variant !== 'shield' ? expectedWeak : 0));
                assert.equal(attached.length, expectedWeak);
                if (c.mode === 'weakness-exhaust')
                    assert.equal(selectedTarget.exhausted, unique || initialSelection.exhausted);
            }
            if (c.variant === 'shield') {
                assert.equal(originalShields.length, 1);
                assert.equal(originalShields[0].zoneName, 'outsideTheGame');
                assert.equal(originalShields[0].isAttached(), false);
                assert.equal(selectedTarget.upgrades.filter(t => t.isShield()).length, 0);
            }
            if (selectedTarget && !selectedTarget.isInPlay())
                for (const t of weak) {
                    assert.equal(t.zoneName, 'outsideTheGame');
                    assert.equal(t.isAttached(), false);
                }
            if (c.deathDamage) {
                const friendly = targets[1], initial = initialTargets.get(friendly);
                assert.ok(friendly.isInPlay());
                assert.equal(friendly.damage, initial.damage + 1, 'Captured actual ground death deals1 to opposing friendly unit');
                assert.equal(friendly.getHp(), initial.hp);
                assert.equal(friendly.getPower(), initial.power);
                if (source.isInPlay?.())
                    assert.equal(source.damage, source.cardData.arena === 'ground' ? 1 : 0, 'Actual death damage respects ground source arena');
                const deathIndex = events.findIndex(e => e.name === 'onCardDefeated' && e.card?.id === eg.cardId(selectedTarget.uuid)), effectIndex = events.findIndex(e => e.name === 'onDamageDealt' && e.sourceId === eg.cardId(selectedTarget.uuid));
                assert.ok(deathIndex >= 0 && effectIndex > deathIndex, 'Captured actual death effect resolves after physical departure');
            }
            for (const [t, initial] of initialTargets)
                if (t !== selectedTarget && !(c.deathDamage && t === targets[1]) && !(c.uniqueReplacement && t === targets[1]) && !(c.snokeEntry && t === targets[c.prerequisiteIndex]))
                    assert.deepEqual(summary(eg, t), initial, 'Nonselected physical recipient preserved');
            if (c.variant !== 'decline' && !c.empty) {
                const id = eg.cardId(selectedTarget.uuid), local = events.filter(e => e.source === source.internalName);
                const tokens = local.filter(e => e.name === 'onTokensCreated'), attachments = local.filter(e => e.name === 'onUpgradeAttached');
                for (const e of [...tokens, ...attachments])
                    assert.equal(e.window.triggerHandlingMode, 'passesTriggersToParentWindow');
                if (c.mode === 'damage-pair') {
                    const names = local.map(e => e.name), attachmentIndex = events.findIndex(e => e.name === 'onUpgradeAttached' && e.source === source.internalName), departureIndex = events.findIndex(e => e.name === 'onCardDefeated' && e.card?.id === id);
                    assert.ok(names.indexOf('onTokensCreated') < names.indexOf('onUpgradeAttached'));
                    assert.deepEqual(attachments[0].window.eventNames.filter(n => ['onDamageDealt', 'onTokensCreated', 'onUpgradeAttached'].includes(n)), c.variant === 'shield' ? ['onTokensCreated', 'onUpgradeAttached'] : ['onDamageDealt', 'onTokensCreated', 'onUpgradeAttached']);
                    if (departureIndex !== -1)
                        assert.ok(attachmentIndex < departureIndex, 'Weakness attachment precedes selected-unit departure even after lethal primary damage');
                }
                if (c.mode === 'weakness-exhaust') {
                    const exhaust = local.filter(e => e.name === 'onCardExhausted' && e.card?.id === id);
                    assert.equal(exhaust.length, c.variant === 'unique-ready' ? 1 : 0, 'Only a surviving ready unique recipient resolves exhaustion');
                    assert.deepEqual(attachments[0].window.eventNames, ['onTokensCreated', 'onUpgradeAttached']);
                    if (exhaust.length)
                        assert.deepEqual(exhaust[0].window.eventNames, ['onCardExhausted']);
                }
                if (c.mode === 'base-amount' && expectedWeak === 2) {
                    assert.deepEqual(attached.map(e => e.state.hp), [initialSelection.hp - 1, initialSelection.hp - 2]);
                    assert.ok(attached.every(e => e.state.zone === initialSelection.zone), 'Both token contingents attach before lethal sweep');
                }
            }
        }
        witness.observations.push({ stage: 'source-effects', created: created.map(t => summary(eg, t)), attached, events });
        while (!eg.over && step < 4000) {
            const pid = eg.ids.find(id => eg.legalActions(id).length);
            assert.ok(pid);
            const actions = expandActions(eg, eg.legalActions(pid)), prompt = eg.player(pid).currentPrompt(), window = eg.isActionWindow(pid);
            if (window)
                records.push({ type: 'state', step, state: fullState(eg, pid) });
            const chosen = bot.choose({ game: eg, pid, actions, rng });
            assert.ok(chosen);
            records.push({ type: 'decision', step, actor: eg.seatOf(pid), prompt: { type: prompt.promptType ?? null, title: prompt.menuTitle ?? null, selected: (eg.player(pid).promptState.selectedCards ?? []).map(card => eg.cardId(card.uuid ?? card)), actionWindow: window }, actions: actions.map(a => canonicalAction(eg, a)), chosen: canonicalAction(eg, chosen).key, events: [] });
            eg.apply(pid, chosen, rng);
            step++;
        }
        assert.ok(eg.over, 'Full terminal source recording');
        records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
        witness.coverageObligationIds = [...scenario.coverageObligationIds];
        return { records, witness };
    }
    catch (e) {
        e.diagnostic = { case: c, inputs, events, records, witness, initial: before, final: fullState(eg) };
        throw e;
    }
    finally {
        bot.close?.();
    }
}
module.exports = { fixture, dependencies: ['bot/omni/rs/make-pool.js', 'bot/cards/pipeline/weakness-continuation-probes.js', 'bot/cards/pipeline/weakness-continuation-probe-fixture.js', 'bot/cards/pipeline/weakness-upgrade-probes.js', 'bot/cards/pipeline/arena-damage-probes.js', 'bot/cards/pipeline/force-trigger-probes.js', 'bot/cards/pipeline/force-probes.js', 'bot/cards/pipeline/probe-fixture.js', 'bot/env.js', 'bot/omni/rs/state.js', 'bot/players/index.js'] };
