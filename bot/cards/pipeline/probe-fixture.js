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
            ...probe.targets.flatMap(t => (t.attachments ?? []).map(a => a.code)),
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
    const deckCodes = [...codes.filter(code => !pool.cards.find(c => c.setCode===code).types.some(t => ['token','leader'].includes(t))), ...filler.map((c) => c.setCode)].slice(0, 17);
    assert.equal(deckCodes.length, 17, 'Probe requires seventeen distinct deck cards');
    return {
        metadata: { name: 'Automatic IR probe', author: 'card pipeline' },
        leader: { id: probe.leaderCode ?? leaders[0].setCode, count: 1 },
        base: { id: probe.baseCode ?? bases[0].setCode, count: 1 },
        deck: deckCodes.map((id, i) => ({ id, count: i === 16 ? 2 : 3 })),
        isPresentInDb: false,
    };
}
async function constructProbeFixture(env, pool, scenario, seed) {
    const p = scenario.probe;
    assert.ok(p, 'Missing pure probe construction');
    const deck = buildDeck(pool, p),
        eg = env.newGame({ seed, deck1: deck, deck2: {...deck,base:{id:p.enemyBaseCode ?? deck.base.id,count:1}} });
    const rng = seededRng('automatic-probe-' + seed),
        bot = makeBot('random');
    await eg.start();
    for (let i = 0; !eg.ids.some((id) => eg.isActionWindow(id)); i++) {
        assert.ok(i < 100, 'Startup did not reach action window');
        const pid = eg.ids.find((id) => eg.legalActions(id).length),
            actions = expandActions(eg, eg.legalActions(pid));
        const desiredInitiative=p.initiative==='self'?eg.ids[0]:eg.ids[1];
        const initiativeChoice=p.initiative&&actions.find(a=>a.label===(pid===desiredInitiative?'Yourself':'Opponent'));
        eg.apply(pid, initiativeChoice??bot.choose({ game: eg, pid, actions, rng }), rng);
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
    const token = (player, name) => {
        const keys = Object.keys(eg.game.tokenFactories).filter(key => key.replace(/-/g,'').toLowerCase() === name.replace(/-/g,'').toLowerCase());
        assert.equal(keys.length,1,'Token metadata name must resolve exactly one engine factory');
        return eg.game.generateToken(player,keys[0]);
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
        const player = t.owner === 'self' ? own : enemy;
        const card = (t.deployedLeader || t.leader) ? player.getAllDeckLeaders().find(c=>matches(c,t.code)) : t.token ? token(player,t.token) : take(player,t.code);
        if (t.deployedLeader || t.leader) {
            assert.ok(card,'Missing chosen deck leader');
            card.deploy({type:'leaderUnit'});
            card.deployEpicActionLimit.increment(player);
        } else card.moveTo(t.zone ?? t.arena + 'Arena');
        if (!t.zone) {
            card.exhausted = t.exhausted ?? true;
            card.damage = t.damage ?? 0;
        }
        for (const attachment of t.attachments ?? []) {
            const owner = attachment.owner === 'opponent' ? enemy : attachment.owner === 'self' ? own : player;
            const upgrade = attachment.token ? token(owner,attachment.token) : take(owner,attachment.code);
            upgrade.attachTo(card);
        }
        return card;
    });
    for (const player of [own, enemy]) {
        for (const card of player.drawDeck.slice(0, p.resourceCount ?? 12)) {
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
    const active = ['groundArena', 'spaceArena'].includes(card.zoneName) || (card.zoneName === 'base' && card.isBase?.());
    return {
        id: eg.cardId(card.uuid),
        zone: card.zoneName,
        damage: active ? card.damage ?? 0 : null,
        power: active && card.isUnit?.() ? card.getPower() : null,
        hp: active && card.isUnit?.() ? card.getHp() : null,
    };
}
async function fixture(env, pool, scenario, seed) {
    if (scenario.probe?.family === 'named-target') return require('./named-target-probe-fixture').fixture(env, pool, scenario, seed);
    if (scenario.probe?.family === 'arena-keyword') return require('./arena-keyword-probe-fixture').fixture(env, pool, scenario, seed);
    if (scenario.probe?.family === 'hidden') return require('./hidden-probe-fixture').fixture(env, pool, scenario, seed);
    if (scenario.probe?.family === 'hidden-keyword-only') return require('./hidden-keyword-probe-fixture').fixture(env, pool, scenario, seed);
    if (scenario.probe?.family === 'on-defense') return require('./on-defense-probe-fixture').fixture(env, pool, scenario, seed);
    if (scenario.probe?.family === 'upgrade-return') return require('./upgrade-return-probe-fixture').fixture(env, pool, scenario, seed);
    if (scenario.probe?.family === 'cost-query') return require('./cost-probe-fixture').fixture(env, pool, scenario, seed);
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
                'Deterministic metadata-selected deck; at first natural action window move real source/target deck cards to specified zones, initialize disclosed damage and exhausted state; create declared unit/upgrade tokens with game.generateToken and attach declared real upgrades, deploy declared leaders with spent epic action before capture; twelve real cards to resources; thereafter normal engine inputs only.',
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
            handCounts: [own.getCardsInZone('hand').length, enemy.getCardsInZone('hand').length],
            attachments: targets.flatMap(c => (['groundArena','spaceArena'].includes(c.zoneName) ? c.upgrades : []).map(u => observe(u,eg))),
        },
        observations: [],
        played: false,
        targetSelected: false,
        negativeChecked: false,
        expired: false,
        defeatedIds: [],
        drawnCounts: [0,0],
    };
    const attachmentIdsByTarget = targets.map(card => (['groundArena','spaceArena'].includes(card.zoneName) ? card.upgrades : []).map(u => eg.cardId(u.uuid)));
    const round = eg.round;
    let step = 0,
        activated = false,
        settled = false,
        selectionObserved = false;
    eg.game.on('onCardDefeated', event => { if (activated && !settled && !event.isCancelledOrReplaced) witness.defeatedIds.push(eg.cardId(event.card.uuid)); });
    eg.game.on('onCardsDrawn', event => { if (activated && !settled && !event.isCancelledOrReplaced) {
        const seat = eg.ids.indexOf(event.player?.id); if (seat >= 0) witness.drawnCounts[seat] += event.amount ?? event.cards?.length ?? 0;
    }});
    eg.game.on('onCardPlayed', (event) => {
        if (activated && !settled && event.card === activation && !event.isCancelledOrReplaced) witness.played = true;
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
                        handCounts: [own.getCardsInZone('hand').length,enemy.getCardsInZone('hand').length],
                        attachments: targets.flatMap(c => (['groundArena','spaceArena'].includes(c.zoneName) ? c.upgrades : []).map(u => observe(u,eg))),
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
            if (p.resolveDeathDraws && activated && !settled && !atWindow) chosen = actions.find(a => a.kind === 'button' && /resolve all|trigger|draw a card|yes/i.test(a.label ?? '')) ?? chosen;
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
            if (!p.autoTargets) assert.ok(witness.targetSelected, 'Missing positive target selection');
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
            if (p.autoTargets) {
                for (const [i, initial] of witness.initial.targets.entries()) {
                    const current = after.targets[i];
                    if (p.selectedTargetIndices.includes(i)) {
                        assert.notDeepEqual(current, initial, 'Selected auto-target must change');
                        if (p.expectDefeated) assert.equal(current.zone, p.targets[i].deployedLeader ? 'base' : p.targets[i].token ? 'outsideTheGame' : 'discard', 'Explicit defeat must leave arena');
                    }
                    else assert.deepEqual(current, initial, 'Excluded auto-target must stay unchanged');
                }
            } else assert.notDeepEqual(observed, before, 'Positive experiment must change observed target state');
            if (p.expectDraws) {
                // Each selected mandatory donor registers draw1; event is discarded from p1 hand during play.
                assert.deepEqual(after.handCounts, witness.initial.handCounts.map((n,i) => n + p.expectDraws[i] - (i === 0 ? 1 : 0)), 'All selected death draws resolve before the next action window');
            }
            if (p.expectDefeated && witness.initial.attachments.length) {
                const selectedUnits = p.selectedTargetIndices.map(i => witness.initial.targets[i].id);
                const attachmentIds = p.selectedTargetIndices.flatMap(i => attachmentIdsByTarget[i]);
                // CardTargetSystem creates all upgrade contingents before parent handlers; negative-order comparator reverses their combined entry order.
                assert.deepEqual(witness.defeatedIds.filter(id => attachmentIds.includes(id)), attachmentIds.toReversed(), 'Complete attachment batch reverses combined insertion order');
                for (const attachmentId of attachmentIds) assert.ok(witness.defeatedIds.indexOf(attachmentId) < Math.min(...selectedUnits.map(id => witness.defeatedIds.indexOf(id))), 'Every attachment resolves before any parent');
            }
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
        'bot/cards/pipeline/named-target-probes.js',
        'bot/cards/pipeline/named-target-probe-fixture.js',
        'bot/cards/pipeline/arena-keyword-probes.js',
        'bot/cards/pipeline/arena-keyword-probe-fixture.js',
        'bot/cards/pipeline/probe-fixture.js',
        'bot/cards/pipeline/hidden-probes.js',
        'bot/cards/pipeline/hidden-probe-fixture.js',
        'bot/cards/pipeline/hidden-source-fixture.js',
        'bot/cards/pipeline/hidden-keyword-probes.js',
        'bot/cards/pipeline/hidden-keyword-probe-fixture.js',
        'bot/cards/pipeline/on-defense-probes.js',
        'bot/cards/pipeline/on-defense-probe-fixture.js',
        'bot/cards/pipeline/cost-probes.js',
        'bot/cards/pipeline/cost-probe-fixture.js',
        'bot/cards/pipeline/upgrade-return-probes.js',
        'bot/cards/pipeline/upgrade-return-probe-fixture.js',
        'bot/env.js',
        'bot/omni/rs/state.js',
        'bot/players/index.js',
    ],
};
