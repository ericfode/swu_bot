'use strict';
const assert = require('node:assert/strict');
const { seededRng } = require('../../env');
const { makeBot } = require('../../players');
const { fullState, canonicalAction, expandActions } = require('../../omni/rs/state');
function matches(card, code) {
    return [card.cardData.setId, ...(card.cardData.setCodes ?? [])].some(
        (s) => s.set + '_' + String(s.number).padStart(3, '0') === code,
    );
}
function buildDeck(pool, probe) {
    const codes = [
        ...new Set([
            probe.cardId,
            ...(probe.activationCode ? [probe.activationCode] : []),
            ...probe.targets.map((t) => t.code),
        ]),
    ];
    const leaders = pool.cards
        .filter((c) => c.types.includes('leader'))
        .sort((a, b) => a.setCode.localeCompare(b.setCode));
    const bases = pool.cards
        .filter((c) => c.types.includes('base') && !c.text)
        .sort((a, b) => a.setCode.localeCompare(b.setCode));
    // Quiet filler is selected deterministically from portable card metadata.
    const filler = pool.cards
        .filter(
            (c) =>
                c.types.includes('unit') &&
                !c.types.includes('leader') &&
                !c.text &&
                !c.keywords?.length &&
                !c.unique &&
                !codes.includes(c.setCode),
        )
        .sort((a, b) => a.setCode.localeCompare(b.setCode));
    assert.ok(leaders.length && bases.length, 'Probe requires an available leader and plain base');
    for (const code of codes)
        assert.ok(
            pool.cards.some((c) => c.setCode === code),
            'Probe card missing from pool: ' + code,
        );
    const deckCodes = [...codes, ...filler.map((c) => c.setCode)].slice(0, 17);
    assert.equal(deckCodes.length, 17, 'Probe requires seventeen distinct deck cards');
    return {
        metadata: { name: 'Automatic IR probe', author: 'card pipeline' },
        leader: { id: leaders[0].setCode, count: 1 },
        base: { id: bases[0].setCode, count: 1 },
        deck: deckCodes.map((id, i) => ({ id, count: i === 16 ? 2 : 3 })),
        isPresentInDb: false,
    };
}
async function constructProbeFixture(env, pool, scenario, seed) {
    const p = scenario.probe;
    assert.ok(p, 'Missing pure probe construction');
    const deck = buildDeck(pool, p),
        eg = env.newGame({ seed, deck1: deck, deck2: deck });
    const rng = seededRng('automatic-probe-' + seed),
        bot = makeBot('random');
    await eg.start();
    for (let i = 0; !eg.ids.some((id) => eg.isActionWindow(id)); i++) {
        assert.ok(i < 100, 'Startup did not reach action window');
        const pid = eg.ids.find((id) => eg.legalActions(id).length),
            actions = expandActions(eg, eg.legalActions(pid));
        eg.apply(pid, bot.choose({ game: eg, pid, actions, rng }), rng);
    }
    const own = eg.player(eg.ids[0]),
        enemy = eg.player(eg.ids[1]);
    const take = (player, code) => {
        const card = [...player.drawDeck, ...player.getCardsInZone('hand'), ...player.getCardsInZone('resource')].find(
            (c) => matches(c, code),
        );
        assert.ok(card, 'Cannot construct ' + code);
        return card;
    };
    const source = take(own, p.cardId);
    source.moveTo(p.sourceInPlay ? p.sourceArena + 'Arena' : 'hand');
    if (p.sourceInPlay) {
        source.exhausted = true;
        source.damage = p.sourceDamage ?? 0;
    }
    const activation = p.activationCode ? take(own, p.activationCode) : source;
    if (p.activationCode) activation.moveTo('hand');
    const targets = p.targets.map((t) => {
        const card = take(t.owner === 'self' ? own : enemy, t.code);
        card.moveTo(t.zone ?? t.arena + 'Arena');
        if (!t.zone) {
            card.exhausted = true;
            card.damage = t.damage ?? 0;
        }
        return card;
    });
    for (const player of [own, enemy]) {
        for (const card of player.drawDeck.slice(0, 12)) {
            card.moveTo('resource');
            card.exhausted = false;
        }
        for (const card of player.getCardsInZone('resource')) card.exhausted = false;
    }
    eg.game.resolveGameState(true);
    eg.game.continue();
    for (let i = 0; i < targets.length; i++) {
        if (!p.targets[i].zone)
            assert.equal(targets[i].damage, p.targets[i].damage ?? 0, 'Initial damage must survive construction');
        assert.equal(targets[i].zoneName, p.targets[i].zone ?? p.targets[i].arena + 'Arena');
    }
    if (p.sourceInPlay) {
        assert.equal(source.zoneName, p.sourceArena + 'Arena');
        assert.equal(source.damage, p.sourceDamage ?? 0);
    }
    return { eg, rng, bot, deck, own, enemy, source, activation, targets };
}
function observe(card, eg) {
    const active = ['groundArena', 'spaceArena', 'base'].includes(card.zoneName);
    return {
        id: eg.cardId(card.uuid),
        zone: card.zoneName,
        damage: active ? card.damage ?? 0 : null,
        power: active && card.isUnit?.() ? card.getPower() : null,
        hp: active && card.isUnit?.() ? card.getHp() : null,
    };
}
async function fixture(env, pool, scenario, seed) {
    const setup = await constructProbeFixture(env, pool, scenario, seed);
    const { eg, rng, bot, deck, own, enemy, source, activation, targets } = setup,
        p = scenario.probe;
    const records = [
        {
            type: 'meta',
            schema: 'omni-rs-trace-v1',
            pool: pool.provenance,
            seed,
            bots: ['automatic-probe', 'automatic-probe'],
            decks: [deck, deck],
            scenario: scenario.name,
            fixtureConstruction:
                'Deterministic metadata-selected deck; at first natural action window move real source/target deck cards to specified zones, initialize disclosed damage, twelve real cards to resources; thereafter normal engine inputs only.',
            constructionParameters: p,
        },
    ];
    const witness = {
        scenario: scenario.name,
        coverageObligationIds: [],
        initial: {
            source: observe(source, eg),
            targets: targets.map((c) => observe(c, eg)),
            bases: [observe(own.base, eg), observe(enemy.base, eg)],
        },
        observations: [],
        played: false,
        targetSelected: false,
        negativeChecked: false,
        expired: false,
    };
    const round = eg.round;
    let step = 0,
        activated = false,
        settled = false,
        selectionObserved = false;
    eg.game.on('onCardPlayed', (event) => {
        if (event.card === activation && !event.isCancelledOrReplaced) witness.played = true;
    });
    try {
        while (!eg.over && step < 4000) {
            const pid = eg.ids.find((id) => eg.legalActions(id).length);
            assert.ok(pid, 'No actor');
            const actions = expandActions(eg, eg.legalActions(pid));
            assert.ok(actions.length);
            const atWindow = eg.isActionWindow(pid);
            if (atWindow) {
                const state = fullState(eg, pid);
                records.push({ type: 'state', step, state });
                if (p.observeOnly && !settled) {
                    witness.observations.push({ stage: 'initial-live-stats', source: observe(source, eg) });
                    settled = true;
                }
                if (activated && witness.played && !settled) {
                    if (p.negativeOnly && !selectionObserved) {
                        witness.negativeChecked = true;
                        witness.observations.push({
                            stage: 'resolved-without-target-selector',
                            targetSelectionSeen: selectionObserved,
                        });
                    }
                    witness.observations.push({
                        stage: 'after-resolution',
                        source: observe(source, eg),
                        targets: targets.map((c) => observe(c, eg)),
                        bases: [observe(own.base, eg), observe(enemy.base, eg)],
                    });
                    settled = true;
                }
                if (settled && p.waitForExpiry && eg.round > round && !witness.expired) {
                    witness.observations.push({ stage: 'after-expiry', targets: targets.map((c) => observe(c, eg)) });
                    witness.expired = true;
                }
            }
            let chosen;
            if (atWindow && eg.round === round) {
                if (pid === own.id && !activated && !p.observeOnly) {
                    const play = actions.find((a) => a.cardUuid === activation.uuid);
                    if (!play && p.negativeOnly) {
                        witness.negativeChecked = true;
                        settled = true;
                        activated = true;
                        witness.observations.push({ stage: 'unplayable-with-no-eligible-target', sourceLegal: false });
                    } else {
                        assert.ok(play, 'Probe source not playable');
                        chosen = play;
                        activated = true;
                    }
                }
                chosen ??= actions.find((a) => a.arg === 'pass');
            } else if (!atWindow && pid === own.id && activated && !settled) {
                const target = p.mutateSource
                    ? source
                    : p.chosenBase
                    ? p.chosenBase === 'self'
                        ? own.base
                        : enemy.base
                    : targets[p.chosenTarget ?? 0];
                // Candidate observations come directly from the oracle's action protocol.
                if (actions.some((a) => a.kind === 'card') && !selectionObserved) {
                    selectionObserved = true;
                    witness.observations.push({
                        stage: 'target-prompt',
                        candidateIds: actions.filter((a) => a.kind === 'card').map((a) => eg.cardId(a.cardUuid)),
                        targets: targets.map((c) => observe(c, eg)),
                    });
                    if (p.negativeOnly) {
                        for (const card of targets)
                            assert.ok(
                                !actions.some((a) => a.cardUuid === card.uuid),
                                'Invalid target was offered by engine',
                            );
                        if (p.inspectBaseInvalid)
                            for (const base of [own.base, enemy.base])
                                assert.ok(
                                    !actions.some((a) => a.cardUuid === base.uuid),
                                    'Base offered to unit-only probe',
                                );
                        witness.negativeChecked = true;
                    } else {
                        assert.ok(
                            target && actions.some((a) => a.cardUuid === target.uuid),
                            'Constructed positive target was not offered',
                        );
                    }
                }
                if (!p.negativeOnly && target) {
                    chosen = actions.find((a) => a.cardUuid === target.uuid);
                    if (chosen) witness.targetSelected = true;
                }
                chosen ??= actions.find((a) => a.kind === 'button' && /play|resolve|trigger/i.test(a.label ?? ''));
                chosen ??= actions.find((a) => a.arg === 'done');
                if (p.negativeOnly) chosen ??= actions.find((a) => a.kind === 'card' && a.cardUuid !== source.uuid);
            }
            chosen ??= bot.choose({ game: eg, pid, actions, rng });
            assert.ok(chosen);
            const prompt = eg.player(pid).currentPrompt();
            records.push({
                type: 'decision',
                step,
                actor: eg.seatOf(pid),
                prompt: {
                    type: prompt.promptType ?? null,
                    title: prompt.menuTitle ?? null,
                    selected: (eg.player(pid).promptState.selectedCards ?? []).map((c) => eg.cardId(c.uuid)),
                    actionWindow: atWindow,
                },
                actions: actions.map((a) => canonicalAction(eg, a)),
                chosen: canonicalAction(eg, chosen).key,
                events: [],
            });
            eg.apply(pid, chosen, rng);
            step++;
        }
        assert.ok(eg.over, 'Automatic probe game did not complete');
        records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
        assert.ok(settled, 'No post-activation experiment observation');
        if (!p.observeOnly && !p.negativeOnly) {
            assert.ok(witness.played, 'Missing actual source onCardPlayed');
            assert.ok(witness.targetSelected, 'Missing positive target selection');
        }
        if (p.negativeOnly) assert.ok(witness.negativeChecked, 'No invalidity observation');
        if (p.waitForExpiry) assert.ok(witness.expired, 'Phase expiry not reached');
        if (!p.observeOnly && !p.negativeOnly) {
            const after = witness.observations.find((o) => o.stage === 'after-resolution');
            const before = p.mutateSource
                ? witness.initial.source
                : p.chosenBase
                ? witness.initial.bases[p.chosenBase === 'self' ? 0 : 1]
                : witness.initial.targets[p.chosenTarget ?? 0];
            const observed = p.mutateSource
                ? after.source
                : p.chosenBase
                ? after.bases[p.chosenBase === 'self' ? 0 : 1]
                : after.targets[p.chosenTarget ?? 0];
            assert.notDeepEqual(observed, before, 'Positive experiment must change observed target state');
            if (p.mutateSource) {
                assert.notEqual(observed.damage, before.damage, 'Live mutation must change source damage');
                assert.notEqual(observed.power, before.power, 'Live damage expression must change observed power');
            }
            if (p.waitForExpiry) {
                const expiry = witness.observations.find((o) => o.stage === 'after-expiry');
                assert.notDeepEqual(
                    expiry.targets,
                    after.targets,
                    'Expiry must change the post-effect target observation',
                );
            }
        }
        witness.coverageObligationIds = [...scenario.coverageObligationIds];
        return { records, witness };
    } finally {
        bot.close?.();
    }
}
module.exports = {
    fixture,
    constructProbeFixture,
    buildDeck,
    dependencies: [
        'bot/cards/pipeline/probes.js',
        'bot/cards/pipeline/probe-fixture.js',
        'bot/env.js',
        'bot/omni/rs/state.js',
        'bot/players/index.js',
    ],
};
