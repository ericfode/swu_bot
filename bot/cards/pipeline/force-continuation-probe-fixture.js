'use strict';
const assert = require('node:assert/strict');
const { constructProbeFixture } = require('./probe-fixture');
const { fullState, expandActions, canonicalAction } = require('../../omni/rs/state');
function forceObject(player) {
    const cards = [...player.baseZone.cards, ...player.outsideTheGameZone.getCards()].filter(c => c.isForceToken());
    assert.equal(cards.length, 1);
    return cards[0];
}
function summary(eg, c) {
    return { id: eg.cardId(c.uuid), zone: c.zoneName, ...(c.isUnit?.() && c.isInPlay?.() ? {
            damage: c.damage, hp: c.getHp(), power: c.getPower(), upgrades: c.upgrades.map(u => eg.cardId(u.uuid))
        } : {}) };
}
async function fixture(env, pool, scenario, seed) {
    const p = scenario.probe;
    assert.equal(p.family, 'force-continuation');
    const reverse = p.sourceSeat === 2;
    const construction = { ...p, initiative: reverse ? 'opponent' : 'self', targets: [
            ...p.targets.map(t => ({ ...t, owner: reverse ? (t.owner === 'self' ? 'opponent' : 'self') : t.owner })),
            ...(reverse ? [{ code: p.cardId, owner: 'opponent', zone: 'hand' }] : [])
        ] };
    const setup = await constructProbeFixture(env, pool, { ...scenario, probe: construction }, seed);
    const { eg, rng, bot, deck } = setup;
    const targets = setup.targets.slice(), own = reverse ? setup.enemy : setup.own, enemy = reverse ? setup.own : setup.enemy;
    const source = reverse ? targets.pop() : setup.source;
    const ownForce = forceObject(own), enemyForce = forceObject(enemy);
    if (p.held)
        ownForce.moveTo('base');
    if (p.enemyHeld)
        enemyForce.moveTo('base');
    own.base.damage = p.baseDamage ?? 0;
    eg.game.resolveGameState(true);
    eg.game.continue();
    const witness = { coverageObligationIds: [], observations: [], events: [], preludeInputs: [] };
    // These support cards are normally played before the initial exported boundary.
    // The recipient wound is a disclosed legal construction, not an unrecorded focus effect.
    for (const i of p.preludeIndices ?? []) {
        const card = targets[i];
        let started = false, played = false;
        const listener = e => { if (e.card === card && !e.isCancelledOrReplaced)
            played = true; };
        eg.game.on('onCardPlayed', listener);
        for (let n = 0; n < 200; n++) {
            const pid = eg.ids.find(id => eg.legalActions(id).length), actions = expandActions(eg, eg.legalActions(pid));
            if (played && eg.isActionWindow(pid))
                break;
            let action;
            if (eg.isActionWindow(pid)) {
                action = !started && pid === own.id ? actions.find(a => a.cardUuid === card.uuid) : actions.find(a => a.arg === 'pass');
                if (action?.cardUuid === card.uuid)
                    started = true;
            }
            action ??= actions.find(a => /trigger|resolve/i.test(a.label ?? ''));
            action ??= bot.choose({ game: eg, pid, actions, rng });
            assert.ok(action, 'Normal support-card play input');
            witness.preludeInputs.push({ actor: eg.seatOf(pid), action: canonicalAction(eg, action) });
            eg.apply(pid, action, rng);
        }
        eg.game.removeListener('onCardPlayed', listener);
        assert.ok(played && card.isInPlay(), 'Actual support entered before focused trace');
    }
    if (p.stageBoundary) {
        const card = targets[p.boundaryRecipientIndex];
        assert.ok(p.boundaryDamage < card.getHp());
        card.damage = p.boundaryDamage;
        eg.game.resolveGameState(true);
        eg.game.continue();
    }
    const initialForceIds = [eg.cardId(ownForce.uuid), eg.cardId(enemyForce.uuid)];
    const initialNext = eg.game.state.allCards.length;
    const initial = new Map(targets.map(c => [c, summary(eg, c)]));
    const records = [{ type: 'meta', schema: 'omni-rs-trace-v1', pool: pool.provenance, seed,
            bots: ['force-continuation-probe', 'force-continuation-probe'], decks: [deck, deck], scenario: scenario.name,
            constructionParameters: p, fixtureConstruction: 'Disclosed printed recipients and Force state; actual focus/gain/use/regain inputs. Cached-HP supporting constants normally played before initial boundary, followed by a disclosed legal wound.' }];
    let step = 0, settled = false, started = false, played = false, optionalMenus = 0, click = 0;
    let selected = false, selectedOrder = [], targetBefore = null, originalShields = [], sourceReady = null, focusReady = null;
    const sequence = p.actualGain ? (p.mode === 'inline-damage-gain' ? [targets[p.gainIndex], targets[p.useIndex], source] : [targets[p.gainIndex], source, targets[p.regainIndex]]) : [source];
    let sequenceIndex = 0, restorePending = false, attackStarted = false, attackEnded = false, ownBaseBeforeAttack, enemyBaseBeforeAttack;
    const active = () => sequence[sequenceIndex];
    const cost = card => {
        const aspects = [...own.getAspectsForCosts()];
        let value = card.cardData.cost;
        for (const a of card.cardData.aspects) {
            const i = aspects.indexOf(a);
            if (i < 0)
                value += 2;
            else
                aspects.splice(i, 1);
        }
        return value;
    };
    const ready = () => own.getCardsInZone('resource').filter(c => !c.exhausted).length;
    const observe = name => witness.observations.push({ name, state: fullState(eg), targets: targets.map(c => summary(eg, c)) });
    eg.game.on('onCardPlayed', e => { if (started && !settled && !e.isCancelledOrReplaced && e.card === active())
        played = true; });
    for (const name of ['onForceUsed', 'onTokensCreated', 'onUpgradeAttached', 'onCardDefeated', 'onAttackEnd']) {
        eg.game.on(name, e => {
            if ((!started && !restorePending) || settled)
                return;
            if (name === 'onAttackEnd')
                attackEnded = true;
            const w = eg.game.currentEventWindow;
            witness.events.push({ name, card: e.card?.uuid ? eg.cardId(e.card.uuid) : null,
                tokens: (e.generatedTokens ?? []).map(t => eg.cardId(t.uuid)), cards: (e.cards ?? []).map(t => eg.cardId(t.uuid)),
                upgrade: e.upgradeCard?.uuid ? eg.cardId(e.upgradeCard.uuid) : null,
                parent: e.parentCard?.uuid ? eg.cardId(e.parentCard.uuid) : null,
                tokenType: e.tokenType, mode: w?.triggerHandlingMode, ownHeld: own.hasTheForce,
                source: summary(eg, source), targets: targets.map(c => summary(eg, c)) });
        });
    }
    function assertFocus() {
        assert.equal(ready(), focusReady - cost(source), 'Exact printed/aspect focus cost');
        const used = p.mode !== 'inline-damage-gain' && !!(p.held || p.actualGain) && !p.decline;
        assert.equal(enemy.hasTheForce, !!p.enemyHeld || !!p.acolyteDeath && targets[0].owner === enemy, 'Opponent Force independent except actual death gain');
        if (p.mode === 'inline-damage-gain') {
            assert.equal(own.hasTheForce, true);
            assert.equal(selected, !p.empty, 'Inline selection iff actual unit domain exists');
            if (selected) {
                const target = targets[p.selectedIndex];
                if (p.shielded) {
                    assert.ok(target.isInPlay());
                    assert.equal(target.damage, targetBefore.damage);
                    assert.equal(target.upgrades.length, targetBefore.upgrades.length - 1, 'Exactly one original Shield consumed');
                    const removed = originalShields.filter(c => !target.upgrades.includes(c));
                    assert.equal(removed.length, 1);
                    assert.equal(removed[0].zoneName, 'outsideTheGame');
                    assert.equal(removed[0].isAttached(), false);
                    for (const c of originalShields.filter(c => !removed.includes(c)))
                        assert.ok(target.upgrades.includes(c));
                }
                else if (p.lethal || p.stageBoundary)
                    assert.equal(target.zoneName, 'discard');
                else {
                    assert.ok(target.isInPlay());
                    assert.equal(target.damage, Math.min(targetBefore.hp, targetBefore.damage + p.amount));
                }
                if (p.lethal || p.stageBoundary) {
                    const departure = witness.events.findIndex(e => e.name === 'onCardDefeated' && e.card === eg.cardId(target.uuid));
                    assert.ok(departure >= 0);
                    assert.equal(witness.events[departure].ownHeld, true, 'Own gain resolved before physical primary-damage death');
                    if (p.stageBoundary)
                        assert.equal(witness.events[departure].targets[p.selectedIndex].zone, 'discard');
                }
                if (p.hevyDeath)
                    assert.equal(targets[1].damage, initial.get(targets[1]).damage + 1, 'Captured Hevy mandatory damage updates actual opposing ground');
            }
        }
        else {
            assert.equal(own.hasTheForce, !used && !!p.held);
            assert.equal(optionalMenus > 0, !!p.held || !!p.actualGain);
            if (p.mode === 'five-shields-after-use') {
                assert.equal(selected, used, 'Held accepted primary presents the actual entering-source domain');
                assert.equal(selectedOrder.length, used ? p.pickCount : 0);
                const generated = witness.events.filter(e => e.name === 'onTokensCreated' && e.tokenType === 'shield');
                assert.equal(generated.length, selectedOrder.length ? 1 : 0, 'One token batch spans all selected recipients');
                if (generated.length) {
                    assert.equal(generated[0].tokens.length, selectedOrder.length);
                    assert.deepEqual(generated[0].cards, selectedOrder.map(c => eg.cardId(c.uuid)), 'Batch recipients retain final click order');
                    const attached = witness.events.filter(e => e.name === 'onUpgradeAttached');
                    assert.deepEqual(attached.map(e => e.upgrade), generated[0].tokens, 'All token identities allocate before ordered attachments');
                    assert.deepEqual(attached.map(e => e.parent), generated[0].cards);
                }
                for (const card of [...targets.filter(c => c.isInPlay()), ...(source.isInPlay() ? [source] : [])]) {
                    const old = initial.get(card)?.upgrades ?? [];
                    assert.equal(card.upgrades.length, old.length + (selectedOrder.includes(card) ? 1 : 0));
                    for (const id of old)
                        assert.ok(card.upgrades.some(u => eg.cardId(u.uuid) === id));
                    for (const u of card.upgrades)
                        assert.equal(u.owner, card.controller);
                }
                assert.equal(eg.game.state.allCards.length, initialNext + selectedOrder.length);
            }
            else {
                for (const card of targets.filter(c => initial.get(c).hp !== undefined)) {
                    const before = initial.get(card);
                    const eligible = !card.cardData.traits.includes(p.excludedTrait) && before.hp - before.damage <= p.threshold;
                    if (used && eligible)
                        assert.ok(!card.isInPlay(), 'Every captured nonimmune threshold recipient departed');
                    if (!used) {
                        assert.ok(card.isInPlay());
                        assert.equal(card.damage, before.damage);
                    }
                    else if (!eligible && card !== targets[p.oldIndex]) {
                        assert.ok(card.isInPlay(), 'Immune/nonthreshold recipient survives');
                        const extra = p.hevyDeaths && card.cardData.arena === 'ground' ? 1 : 0;
                        assert.equal(card.damage, before.damage + extra, 'Only actual opposing Hevy death adds damage');
                    }
                }
                if (p.stageBoundary && used) {
                    const deaths = witness.events.filter(e => e.name === 'onCardDefeated');
                    assert.equal(deaths[0].card, eg.cardId(targets[p.boundaryRecipientIndex].uuid), 'Force-loss framework death precedes later defeat child');
                }
            }
        }
        assert.deepEqual([eg.cardId(ownForce.uuid), eg.cardId(enemyForce.uuid)], initialForceIds);
        observe('focused-source-settled');
    }
    try {
        while (!eg.over && step < 4000) {
            const pid = eg.ids.find(id => eg.legalActions(id).length);
            assert.ok(pid);
            const actions = expandActions(eg, eg.legalActions(pid)), window = eg.isActionWindow(pid), prompt = eg.player(pid).currentPrompt();
            let chosen;
            if (window) {
                records.push({ type: 'state', step, state: fullState(eg, pid) });
                if (!settled && started && played) {
                    assert.equal(ready(), sourceReady - cost(active()));
                    if (active() === source)
                        assertFocus();
                    if (p.actualGain) {
                        const held = p.mode === 'inline-damage-gain' ? [true, false, true][sequenceIndex] : [true, false, true][sequenceIndex];
                        assert.equal(own.hasTheForce, held);
                    }
                    sequenceIndex++;
                    started = false;
                    played = false;
                    if (sequenceIndex === sequence.length) {
                        if (p.restoreCombat) {
                            restorePending = true;
                            sequenceIndex--;
                        }
                        else {
                            settled = true;
                            witness.coverageObligationIds = [...scenario.coverageObligationIds];
                        }
                    }
                }
                if (!settled && restorePending) {
                    if (attackEnded) {
                        assert.equal(own.base.damage, Math.max(0, ownBaseBeforeAttack - p.restore));
                        assert.equal(enemy.base.damage, Math.min(enemy.base.getHp(), enemyBaseBeforeAttack + source.getPower()));
                        observe('actual-restore-combat');
                        settled = true;
                        witness.coverageObligationIds = [...scenario.coverageObligationIds];
                    }
                    else if (pid === own.id && !source.exhausted && !attackStarted) {
                        chosen = actions.find(a => a.cardUuid === source.uuid);
                        assert.ok(chosen, 'Natural next-phase readiness yields actual source attack');
                        attackStarted = true;
                        ownBaseBeforeAttack = own.base.damage;
                        enemyBaseBeforeAttack = enemy.base.damage;
                    }
                    else
                        chosen = actions.find(a => a.arg === 'pass');
                }
                else if (!settled) {
                    chosen = pid === own.id && !started ? actions.find(a => a.cardUuid === active().uuid) : actions.find(a => a.arg === 'pass');
                    if (chosen?.cardUuid === active().uuid) {
                        started = true;
                        sourceReady = ready();
                        if (active() === source)
                            focusReady = ready();
                    }
                    assert.ok(chosen, 'Normal focus/lifecycle play selectable');
                }
            }
            else if (!settled && restorePending && attackStarted) {
                chosen = actions.find(a => a.cardUuid === enemy.base.uuid);
                chosen ??= actions.find(a => /trigger|resolve/i.test(a.label ?? ''));
            }
            else if (!settled && started) {
                if (actions.some(a => a.label === 'You') && actions.some(a => a.label === 'Opponent')) {
                    const first = p.enemyFirst ? enemy : own;
                    chosen = actions.find(a => a.label === (pid === first.id ? 'You' : 'Opponent'));
                    observe('actual-death-owner-order');
                }
                else if (p.uniqueReplacement && actions.some(a => a.cardUuid === source.uuid) && actions.some(a => a.cardUuid === targets[p.oldIndex].uuid)) {
                    assert.equal(pid, own.id);
                    chosen = actions.find(a => a.cardUuid === (p.keepOld ? source.uuid : targets[p.oldIndex].uuid));
                }
                else if (actions.some(a => a.label === 'Pass') && actions.some(a => a.label === 'Trigger')) {
                    assert.equal(pid, own.id);
                    optionalMenus++;
                    chosen = actions.find(a => a.label === (active() === source && p.decline ? 'Pass' : 'Trigger'));
                }
                else if (active() === source && p.mode === 'inline-damage-gain' && actions.some(a => a.kind === 'card')) {
                    assert.equal(prompt.menuTitle, p.inlineTitle);
                    assert.equal(source.zoneName, 'discard');
                    assert.equal(ready(), focusReady - cost(source));
                    assert.ok(!actions.some(a => /cancel/i.test(a.label ?? '')));
                    const target = targets[p.selectedIndex];
                    targetBefore = summary(eg, target);
                    originalShields = target.upgrades.filter(c => c.isShield()).slice();
                    chosen = actions.find(a => a.cardUuid === target.uuid);
                    selected = true;
                    assert.ok(chosen, 'Chosen printed inline damage recipient');
                }
                else if (active() === source && p.mode === 'five-shields-after-use' && actions.some(a => a.kind === 'card')) {
                    assert.equal(own.hasTheForce, false, 'Force consumed before secondary targets');
                    assert.equal(eg.game.state.allCards.length, initialNext, 'No Shield identity before Done');
                    selected = true;
                    const clicks = p.clickIndices ?? Array.from({ length: p.pickCount }, (_, i) => p.selectSource ? 'source' : (p.selectedIndex ?? 0) + i);
                    if (click < clicks.length) {
                        const i = clicks[click++], target = i === 'source' ? source : targets[i];
                        chosen = actions.find(a => a.cardUuid === target.uuid);
                        assert.ok(chosen);
                        if (selectedOrder.includes(target))
                            selectedOrder.splice(selectedOrder.indexOf(target), 1);
                        else
                            selectedOrder.push(target);
                    }
                    else {
                        if (selectedOrder.length === 5) {
                            assert.deepEqual(actions.filter(a => a.kind === 'card').map(a => a.cardUuid).sort(),
                                selectedOrder.map(c => c.uuid).sort(), 'At maximum every chosen toggle remains legal and no sixth recipient is selectable');
                        }
                        chosen = actions.find(a => a.arg === 'done' || a.label === 'Done');
                        assert.ok(chosen, 'Explicit Done required, including fifth target');
                    }
                }
                chosen ??= actions.find(a => /trigger|resolve|play anyway/i.test(a.label ?? ''));
                chosen ??= actions.find(a => a.arg === 'done');
            }
            chosen ??= bot.choose({ game: eg, pid, actions, rng });
            assert.ok(chosen);
            records.push({ type: 'decision', step, actor: eg.seatOf(pid), prompt: { type: prompt.promptType ?? null, title: prompt.menuTitle ?? null,
                    selected: (eg.player(pid).promptState.selectedCards ?? []).map(c => eg.cardId(c.uuid)), actionWindow: window },
                actions: actions.map(a => canonicalAction(eg, a)), chosen: canonicalAction(eg, chosen).key, events: [] });
            eg.apply(pid, chosen, rng);
            step++;
        }
        assert.ok(settled, 'Actual source behavior settled');
        assert.ok(eg.over, 'Full terminal game');
        records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
        return { records, witness };
    }
    finally {
        bot.close?.();
    }
}
module.exports = { fixture, dependencies: ['bot/cards/pipeline/force-continuation-probes.js', 'bot/cards/pipeline/force-continuation-probe-fixture.js',
        'bot/cards/pipeline/probe-fixture.js', 'bot/cards/make-pool.js', 'bot/env.js', 'bot/omni/rs/state.js', 'bot/players/index.js'] };
