'use strict';
const assert = require('node:assert/strict');
const { constructProbeFixture } = require('./probe-fixture');
const { fullState, canonicalAction, expandActions, phaseStats } = require('../../omni/rs/state');
async function fixture(env, pool, scenario, seed) {
    const p = scenario.probe;
    assert.equal(p.family, 'named-target');
    const { eg, rng, bot, deck, own, enemy, source, targets } = await constructProbeFixture(env, pool, scenario, seed);
    const round = eg.round;
    const availableAspects = [...own.getAspectsForCosts()];
    let expectedCost = source.cardData.cost;
    for (const aspect of source.cardData.aspects) {
        const index = availableAspects.indexOf(aspect);
        if (index < 0) expectedCost += 2;
        else availableAspects.splice(index, 1);
    }
    const ready = () => own.getCardsInZone('resource').filter(c => !c.exhausted).length;
    const live = c => c.isUnit?.() && c.isInPlay?.();
    const eligible = (c, d) => live(c) && (!d.arena || c.zoneName === d.arena + 'Arena') &&
        (!d.trait || c.hasSomeTrait(d.trait));
    const baseline = new Map([...targets, source].filter(c => c.isUnit?.()).map(c =>
        [c, { power: live(c) ? c.getPower() : c.cardData.power, hp: live(c) ? c.getHp() : c.cardData.hp }]));
    const witness = { coverageObligationIds: [], observations: [] };
    const records = [{ type: 'meta', schema: 'omni-rs-trace-v1', pool: pool.provenance,
        seed, bots: ['named-target-probe', 'named-target-probe'], decks: [deck, deck],
        scenario: scenario.name, fixtureConstruction: 'Stage disclosed quiet real units and resources at first natural action window; normally play focus, record every target/cancel/payment input and continue to terminal result.', constructionParameters: p }];
    let activated = false, settled = false, played = false, cancelled = false;
    let step = 0, initialReady = 0, descriptorIndex = 0, selections = [];
    const prompted = new Set();
    const expectedPrompts = p.descriptors.map((d, i) =>
        targets.some(c => eligible(c, d)) || p.trigger === 'whenPlayed' &&
        (!d.arena || p.sourceArena === d.arena) && (!d.trait || source.cardData.traits.includes(d.trait)) ? i : -1
    ).filter(i => i >= 0);
    eg.game.on('onCardPlayed', e => {
        if (activated && !settled && !e.isCancelledOrReplaced && e.card === source) played = true;
    });
    function assertStats(expired = false) {
        for (const [c, initial] of baseline) {
            if (!live(c)) continue;
            const additions = expired ? [] : selections.filter(s => s.card === c);
            assert.equal(c.getPower(), initial.power + additions.reduce((n, s) => n + s.descriptor.power, 0));
            assert.equal(c.getHp(), initial.hp + additions.reduce((n, s) => n + s.descriptor.hp, 0));
        }
    }
    function observe(stage, pid, actions) {
        witness.observations.push({ stage, actor: pid ? eg.seatOf(pid) : undefined,
            actions: actions?.map(a => canonicalAction(eg, a)), sourceZone: source.zoneName,
            readyResources: ready(), selections: selections.map(s => ({ card: eg.cardId(s.card.uuid), name: s.descriptor.name })),
            targets: [...baseline.keys()].filter(live).map(c => ({ id: eg.cardId(c.uuid), ...phaseStats(c) })),
            state: fullState(eg) });
    }
    try {
        while (!eg.over && step < 4000) {
            const pid = eg.ids.find(id => eg.legalActions(id).length);
            assert.ok(pid);
            const actions = expandActions(eg, eg.legalActions(pid));
            const window = eg.isActionWindow(pid), prompt = eg.player(pid).currentPrompt();
            let chosen;
            if (window) {
                records.push({ type: 'state', step, state: fullState(eg, pid) });
                if (activated && !settled && cancelled) {
                    assert.equal(source.zoneName, 'hand');
                    assert.equal(ready(), initialReady);
                    selections = [];
                    assertStats();
                    observe('cancelled');
                    settled = true;
                } else if (activated && !settled && played) {
                    if (eg.round === round) assert.equal(ready(), initialReady - expectedCost, 'Exact printed cost plus absent-aspect penalties');
                    assert.deepEqual([...prompted], expectedPrompts, 'Missing descriptors skip individually; all eligible descriptors prompt');
                    assertStats(p.waitForExpiry && eg.round > round);
                    if (!p.waitForExpiry) {
                        observe('resolved');
                        settled = true;
                    } else if (eg.round > round) {
                        assertStats(true);
                        observe('phase-expired');
                        settled = true;
                    }
                }
                if (!settled && !activated && pid === own.id) {
                    initialReady = ready();
                    chosen = actions.find(a => a.cardUuid === source.uuid);
                    assert.ok(chosen, 'Actual focus normal play');
                    activated = true;
                } else if (!settled) {
                    chosen = actions.find(a => a.arg === 'pass');
                }
            } else if (activated && !settled) {
                if (/no effect/i.test(prompt.menuTitle ?? '')) {
                    assert.equal(pid, own.id);
                    assert.deepEqual(actions.map(a => a.label), ['Play anyway', 'Cancel']);
                    assert.equal(source.zoneName, 'hand');
                    assert.equal(ready(), initialReady);
                    observe('empty-confirmation', pid, actions);
                    chosen = actions.find(a => a.label === (p.cancelEmpty ? 'Cancel' : 'Play anyway'));
                    cancelled = !!p.cancelEmpty;
                } else {
                    const index = p.descriptors.findIndex(d => d.promptTitle === prompt.menuTitle);
                    if (index >= 0) {
                        assert.ok(index >= descriptorIndex, 'Ordered named descriptor prompts');
                        descriptorIndex = index + 1;
                        prompted.add(index);
                        const d = p.descriptors[index];
                        assert.equal(pid, own.id);
                        const candidates = eg.game.getArenaUnits().filter(c => eligible(c, d));
                        const targetActions = actions.filter(a => a.kind === 'card');
                        assert.deepEqual(targetActions.map(a => a.cardUuid).sort(), candidates.map(c => c.uuid).sort(),
                            'Exact candidate domain includes both owners and excludes wrong trait/arena');
                        const prepaid = p.trigger === 'event' && !played;
                        assert.deepEqual(actions.filter(a => a.kind === 'button').map(a => a.label),
                            prepaid ? ['Choose nothing', 'Cancel'] : ['Choose nothing']);
                        if (prepaid) {
                            assert.equal(ready(), initialReady);
                            for (const [c, initial] of baseline) if (live(c)) {
                                assert.equal(c.getPower(), initial.power, 'Selections wait until all descriptors complete');
                                assert.equal(c.getHp(), initial.hp);
                            }
                        } else {
                            assert.equal(ready(), initialReady - expectedCost, 'Exact focus payment precedes postcost targeting');
                            assert.equal(source.zoneName, p.trigger === 'event' ? 'discard' : p.sourceArena + 'Arena');
                        }
                        observe('descriptor-' + (index + 1), pid, actions);
                        const choice = p.choices[index];
                        if (choice === 'cancel') {
                            chosen = actions.find(a => a.arg === 'cancel');
                            assert.ok(chosen);
                            cancelled = true;
                        } else if (choice === 'decline') {
                            chosen = actions.find(a => a.arg === 'done');
                        } else {
                            const card = choice === 'source' ? source : candidates.find(c =>
                                c.controller === (choice === 'enemy' ? enemy : own));
                            assert.ok(card, 'Metadata-selected recipient exists');
                            chosen = actions.find(a => a.cardUuid === card.uuid);
                            assert.ok(chosen);
                            selections.push({ card, descriptor: d });
                        }
                    }
                }
                chosen ??= actions.find(a => a.kind === 'button' && /trigger|resolve|play|yes/i.test(a.label ?? ''));
                chosen ??= actions.find(a => a.arg === 'done');
            }
            chosen ??= bot.choose({ game: eg, pid, actions, rng });
            assert.ok(chosen);
            records.push({ type: 'decision', step, actor: eg.seatOf(pid),
                prompt: { type: prompt.promptType ?? null, title: prompt.menuTitle ?? null,
                    selected: (eg.player(pid).promptState.selectedCards ?? []).map(c => eg.cardId(c.uuid)), actionWindow: window },
                actions: actions.map(a => canonicalAction(eg, a)), chosen: canonicalAction(eg, chosen).key, events: [] });
            eg.apply(pid, chosen, rng);
            step++;
        }
        assert.ok(settled, 'Focused named selection settled');
        assert.ok(eg.over);
        records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
        witness.coverageObligationIds = [...scenario.coverageObligationIds];
        return { records, witness };
    } finally { bot.close?.(); }
}
module.exports = { fixture, dependencies: ['bot/cards/pipeline/named-target-probes.js',
    'bot/cards/pipeline/named-target-probe-fixture.js', 'bot/cards/pipeline/probe-fixture.js',
    'bot/env.js', 'bot/omni/rs/state.js', 'bot/players/index.js'] };
