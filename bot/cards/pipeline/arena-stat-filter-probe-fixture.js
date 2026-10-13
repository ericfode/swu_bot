'use strict';
const assert = require('node:assert/strict');
const { constructProbeFixture } = require('./probe-fixture');
const { fullState, canonicalAction, expandActions, phaseStats } = require('../../omni/rs/state');
async function fixture(env, pool, scenario, seed) {
    const p = scenario.probe;
    assert.equal(p.family, 'arena-stat-filter');
    const { eg, rng, bot, deck, own, enemy, source, activation, targets } = await constructProbeFixture(env, pool, scenario, seed);
    const round = eg.round;
    const availableAspects = [...own.getAspectsForCosts()];
    let expectedCost = source.cardData.cost;
    for (const aspect of source.cardData.aspects) {
        const index = availableAspects.indexOf(aspect);
        if (index < 0) expectedCost += 2;
        else availableAspects.splice(index, 1);
    }
    const live = c => c.isUnit?.() && c.isInPlay?.();
    const matches = c => c.controller === own && (!p.trait || c.hasSomeTrait(p.trait)) && (!p.excludeSource || c !== source);
    const ready = () => own.getCardsInZone('resource').filter(c => !c.exhausted).length;
    const baseline = new Map(targets.filter(live).map(c => [c, { power: c.getPower(), hp: c.getHp(),
        damage: c.damage, applies: matches(c) }]));
    const witness = { coverageObligationIds: [], observations: [], defeated: [] };
    const records = [{ type: 'meta', schema: 'omni-rs-trace-v1', pool: pool.provenance, seed,
        bots: ['arena-stat-filter-probe', 'arena-stat-filter-probe'], decks: [deck, deck], scenario: scenario.name,
        fixtureConstruction: 'Stage disclosed real ordinary/token/deployed-leader recipients and resources at first natural action window. Normally play focus, later entrant/copy/damage/defeat donors; advance natural phase entirely via recorded inputs.', constructionParameters: p }];
    let started = false, played = false, settled = false, observed = false, cancelled = false, confirmed = false;
    let secondaryStarted = false, secondaryPlayed = false, step = 0, initialReady = 0;
    eg.game.on('onCardPlayed', e => {
        if (settled || e.isCancelledOrReplaced) return;
        if (started && e.card === source) played = true;
        if (secondaryStarted && e.card === (p.sourceDeparture || p.expiryLethal ? activation : targets.at(-1))) secondaryPlayed = true;
    });
    eg.game.on('onCardDefeated', e => {
        if (!settled && baseline.has(e.card)) witness.defeated.push(eg.cardId(e.card.uuid));
    });
    function observe(stage, pid, actions) {
        witness.observations.push({ stage, actor: pid ? eg.seatOf(pid) : undefined,
            actions: actions?.map(a => canonicalAction(eg, a)), readyResources: ready(), sourceZone: source.zoneName,
            targets: targets.map(c => ({ id: eg.cardId(c.uuid), zone: c.zoneName, ...(live(c) ? phaseStats(c) : {}) })),
            source: live(source) ? phaseStats(source) : null, state: fullState(eg) });
    }
    function assertStats(multiplier = 1, expired = false) {
        for (const [c, initial] of baseline) {
            if (!live(c)) continue;
            const count = !expired && initial.applies ? multiplier : 0;
            assert.equal(c.getPower(), initial.power + p.power * count, 'Captured owner/arena/trait power membership');
            assert.equal(c.getHp(), initial.hp + p.hp * count, 'Captured owner/arena/trait HP membership');
        }
        if (p.excludeSource && live(source)) {
            assert.equal(source.getPower(), source.cardData.power, 'Entering source excluded from its own grant');
            assert.equal(source.getHp(), source.cardData.hp);
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
                if (!settled && cancelled) {
                    assert.equal(source.zoneName, 'hand');
                    assert.equal(ready(), initialReady);
                    assertStats(0);
                    observe('cancelled');
                    settled = true;
                }
                if (!settled && played && !observed) {
                    assertStats();
                    assert.equal(ready(), initialReady - expectedCost, 'Exact printed focus cost plus missing-aspect penalties');
                    if (p.empty && p.trigger === 'event') assert.ok(confirmed, 'Empty list requires actual Play anyway');
                    observe('captured-list-resolved');
                    observed = true;
                    if (!(p.waitForExpiry || p.stack || p.sourceDeparture || p.newEntrant || p.expiryLethal)) settled = true;
                }
                if (!settled && secondaryPlayed) {
                    if (p.stack) {
                        assertStats(2);
                        observe('actual-second-cast-stacked');
                        settled = true;
                    } else if (p.newEntrant) {
                        const c = targets.at(-1);
                        assert.ok(live(c));
                        assert.equal(c.getPower(), c.cardData.power);
                        assert.equal(c.getHp(), c.cardData.hp, 'New entrant receives no old captured modifier');
                        assertStats();
                        observe('actual-new-entrant-excluded');
                        settled = true;
                    } else if (p.sourceDeparture) {
                        assert.equal(source.zoneName, 'discard');
                        assertStats();
                        observe('actual-source-departure-retains-modifiers');
                        settled = true;
                    } else if (p.expiryLethal && eg.round === round) {
                        assert.ok(live(targets[0]), 'Damaged recipient survives because actual phase HP grant remains');
                        assert.equal(targets[0].damage, baseline.get(targets[0]).damage + p.damageAmount);
                        assertStats();
                    }
                }
                if (!settled && observed && eg.round > round && (p.waitForExpiry || p.expiryLethal && secondaryPlayed)) {
                    assertStats(1, true);
                    if (p.expiryLethal) {
                        assert.equal(targets[0].zoneName, 'discard', 'Natural phase expiry causes actual damaged recipient defeat');
                        assert.ok(witness.defeated.includes(eg.cardId(targets[0].uuid)));
                    }
                    observe(p.expiryLethal ? 'damaged-recipient-defeated-at-expiry' : 'natural-phase-expired');
                    settled = true;
                }
                if (!settled && !started && pid === own.id) {
                    initialReady = ready();
                    chosen = actions.find(a => a.cardUuid === source.uuid);
                    assert.ok(chosen, 'Actual focus normal play');
                    started = true;
                } else if (!settled && observed && !secondaryStarted &&
                    (p.stack || p.sourceDeparture || p.newEntrant || p.expiryLethal) && pid === own.id) {
                    const c = p.sourceDeparture || p.expiryLethal ? activation : targets.at(-1);
                    chosen = actions.find(a => a.cardUuid === c.uuid);
                    assert.ok(chosen, 'Actual metadata-selected secondary play');
                    secondaryStarted = true;
                } else if (!settled) chosen = actions.find(a => a.arg === 'pass');
            } else if (!settled && started) {
                if (!played && /no effect/i.test(prompt.menuTitle ?? '')) {
                    assert.equal(pid, own.id);
                    assert.deepEqual(actions.map(a => a.label), ['Play anyway', 'Cancel']);
                    assert.equal(source.zoneName, 'hand');
                    assert.equal(ready(), initialReady);
                    observe('empty-list-confirmation', pid, actions);
                    chosen = actions.find(a => a.label === (p.cancel ? 'Cancel' : 'Play anyway'));
                    cancelled = !!p.cancel;
                    confirmed = !p.cancel;
                } else if (secondaryStarted && !secondaryPlayed && (p.sourceDeparture || p.expiryLethal)) {
                    const c = p.sourceDeparture ? source : targets[0];
                    chosen = actions.find(a => a.cardUuid === c.uuid);
                    assert.ok(chosen, 'Actual defeat/damage selector recipient');
                    assert.equal(pid, own.id);
                    observe('secondary-selector', pid, actions);
                }
                chosen ??= actions.find(a => a.kind === 'button' && /trigger|resolve|play|yes/i.test(a.label ?? ''));
                chosen ??= actions.find(a => a.arg === 'done');
            }
            chosen ??= bot.choose({ game: eg, pid, actions, rng });
            assert.ok(chosen);
            records.push({ type: 'decision', step, actor: eg.seatOf(pid), prompt: {
                type: prompt.promptType ?? null, title: prompt.menuTitle ?? null,
                selected: (eg.player(pid).promptState.selectedCards ?? []).map(c => eg.cardId(c.uuid)), actionWindow: window },
                actions: actions.map(a => canonicalAction(eg, a)), chosen: canonicalAction(eg, chosen).key, events: [] });
            eg.apply(pid, chosen, rng);
            step++;
        }
        assert.ok(settled, 'Actual filtered arena stat behavior settled');
        assert.ok(eg.over);
        records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
        witness.coverageObligationIds = [...scenario.coverageObligationIds];
        return { records, witness };
    } finally { bot.close?.(); }
}
module.exports = { fixture, dependencies: ['bot/cards/pipeline/arena-stat-filter-probes.js',
    'bot/cards/pipeline/arena-stat-filter-probe-fixture.js', 'bot/cards/pipeline/probe-fixture.js',
    'bot/env.js', 'bot/omni/rs/state.js', 'bot/players/index.js'] };
