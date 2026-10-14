'use strict';
const assert = require('node:assert/strict');
const { constructProbeFixture } = require('./probe-fixture');
const { fullState, canonicalAction, expandActions, phaseStats } = require('../../omni/rs/state');
async function fixture(env, pool, scenario, seed) {
    const p = scenario.probe;
    assert.equal(p.family, 'weakness');
    const { eg, rng, bot, deck, own, enemy, source, activation, targets } = await constructProbeFixture(env, pool, scenario, seed);
    for (const player of [own, enemy]) {
        const resources = player.getCardsInZone('resource');
        for (const c of resources.slice(p.resourceCount)) c.moveTo('deckBottom');
        assert.equal(player.getCardsInZone('resource').length, p.resourceCount, 'Disclosed exact resource boundary');
    }
    eg.game.resolveGameState(true);
    eg.game.continue();
    const live = c => c.isUnit?.() && c.isInPlay?.();
    const target = p.selectSource ? source : targets[p.selectedIndex];
    const initial = target ? { power: live(target) ? target.getPower() : target.cardData.power,
        hp: live(target) ? target.getHp() : target.cardData.hp,
        upgrades: live(target) ? [...target.upgrades] : [] } : null;
    const before = targets.map(c => ({ card: c, hp: c.getHp(), power: c.getPower(), upgrades: [...c.upgrades] }));
    const witness = { coverageObligationIds: [], observations: [], created: [], attached: [], defeated: [] };
    const records = [{ type: 'meta', schema: 'omni-rs-trace-v1', pool: pool.provenance, seed,
        bots: ['weakness-probe', 'weakness-probe'], decks: [deck, deck], scenario: scenario.name,
        fixtureConstruction: 'Stage disclosed real quiet/token/deployed-leader recipients and native preexisting Weakness attachments/resources at first action window; normally play focus and real defeat event where needed. Record all later decisions and terminal result.', constructionParameters: p }];
    let started = false, played = false, deathStarted = false, sourceDefeated = false;
    let selected = false, declined = false, settled = false, step = 0;
    eg.game.on('onCardPlayed', e => {
        if (started && !settled && !e.isCancelledOrReplaced && e.card === source) played = true;
    });
    eg.game.on('onCardDefeated', e => {
        if (!settled) {
            if (e.card === source && deathStarted) sourceDefeated = true;
            if (e.card === source || e.card === target) witness.defeated.push({ id: eg.cardId(e.card.uuid), zone: e.card.zoneName });
        }
    });
    eg.game.on('onTokensCreated', e => {
        if (settled || !started || e.context?.source !== source) return;
        for (const token of e.generatedTokens ?? []) {
            assert.equal(token.isWeakness(), true, 'Actual native Weakness factory');
            assert.equal(token.owner, target.controller, 'Token owner is recipient controller, not source controller');
            assert.equal(token.cardData.upgradePower, -1);
            assert.equal(token.cardData.upgradeHp, -1);
            witness.created.push({ id: eg.cardId(token.uuid), owner: eg.seatOf(token.owner.id), token });
        }
    });
    eg.game.on('onUpgradeAttached', e => {
        if (settled || e.context?.source !== source || !e.upgradeCard?.isWeakness?.()) return;
        assert.equal(e.parentCard, target);
        assert.equal(e.upgradeCard.parentCard, target);
        assert.equal(e.upgradeCard.controller, target.controller);
        assert.equal(e.upgradeCard.owner, target.controller);
        witness.attached.push({ id: eg.cardId(e.upgradeCard.uuid), parent: eg.cardId(target.uuid),
            order: target.upgrades.map(c => eg.cardId(c.uuid)), hp: target.getHp(), power: target.getPower() });
    });
    function observe(stage, pid, actions) {
        witness.observations.push({ stage, actor: pid ? eg.seatOf(pid) : undefined,
            actions: actions?.map(a => canonicalAction(eg, a)), sourceZone: source.zoneName,
            target: target ? { id: eg.cardId(target.uuid), zone: target.zoneName,
                ...(live(target) ? phaseStats(target) : {}) } : null, state: fullState(eg) });
    }
    function assertOutcome() {
        const effective = !p.decline && !p.noEligible;
        assert.equal(witness.created.length, effective ? 1 : 0, 'Exactly one actual token or none on decline/ineligible');
        assert.equal(witness.attached.length, effective ? 1 : 0);
        for (const row of before) {
            if (row.card === target && effective) continue;
            if (live(row.card)) {
                assert.equal(row.card.getHp(), row.hp);
                assert.equal(row.card.getPower(), row.power);
                assert.deepEqual(row.card.upgrades, row.upgrades);
            }
        }
        if (effective) {
            assert.equal(selected, true);
            const receipt = witness.created[0], attached = witness.attached[0];
            assert.equal(attached.id, receipt.id, 'Created identity retained through attachment');
            assert.deepEqual(attached.order, [...initial.upgrades.map(c => eg.cardId(c.uuid)), receipt.id], 'Native token appended after prior attachments');
            assert.equal(attached.hp, initial.hp - 1);
            assert.equal(attached.power, Math.max(0, initial.power - 1), 'Negative power clamps at zero');
            if (p.lethal) {
                assert.equal(live(target), false, 'HP-collapse recipient remains defeated after negative upgrade cleanup');
                assert.equal(target.zoneName, target.isToken() ? 'outsideTheGame' : target.isLeader() ? 'base' : 'discard');
                assert.equal(receipt.token.zoneName, 'outsideTheGame');
                assert.ok(witness.defeated.some(d => d.id === eg.cardId(target.uuid)));
            } else {
                assert.equal(target.getHp(), initial.hp - 1);
                assert.equal(target.getPower(), Math.max(0, initial.power - 1));
                assert.equal(receipt.token.parentCard, target);
            }
        }
        if (p.decline) assert.ok(declined, 'Optional source trigger explicitly declined');
        if (p.trigger === 'whenDefeated') assert.equal(source.zoneName, 'discard');
        observe('resolved');
        settled = true;
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
                if (!settled && (p.trigger === 'whenPlayed' ? played : sourceDefeated)) assertOutcome();
                if (!settled && !started && pid === own.id) {
                    chosen = actions.find(a => a.cardUuid === source.uuid);
                    assert.ok(chosen, 'Normally play actual focus');
                    started = true;
                } else if (!settled && played && p.trigger === 'whenDefeated' && !deathStarted && pid === own.id) {
                    chosen = actions.find(a => a.cardUuid === activation.uuid);
                    assert.ok(chosen, 'Actual defeat event captures printed death ability');
                    deathStarted = true;
                } else if (!settled) chosen = actions.find(a => a.arg === 'pass');
            } else if (!settled && started) {
                if (deathStarted && !sourceDefeated && actions.some(a => a.cardUuid === source.uuid)) {
                    chosen = actions.find(a => a.cardUuid === source.uuid);
                } else if (actions.some(a => a.kind === 'card') &&
                    (p.trigger === 'whenPlayed' || sourceDefeated)) {
                    const expected = eg.game.getArenaUnits().filter(c => !p.damagedOnly || c.damage !== 0);
                    assert.equal(pid, own.id);
                    assert.deepEqual(actions.filter(a => a.kind === 'card').map(a => a.cardUuid).sort(),
                        expected.map(c => c.uuid).sort(), 'Exact any-owner unit/damaged domain');
                    assert.deepEqual(actions.filter(a => a.kind === 'button').map(a => a.label), ['Pass'], 'Optional printed source offers Pass without Cancel');
                    assert.equal(!!p.noEligible, false, 'No eligible source condition cannot offer target prompt');
                    observe('weakness-selector', pid, actions);
                    if (p.decline) {
                        chosen = actions.find(a => a.label === 'Pass');
                        declined = true;
                    } else {
                        chosen = actions.find(a => a.cardUuid === target.uuid);
                        selected = true;
                    }
                    assert.ok(chosen);
                } else if (actions.some(a => a.label === 'Pass') && (p.trigger === 'whenPlayed' || sourceDefeated)) {
                    observe('optional-trigger', pid, actions);
                    assert.equal(pid, own.id);
                    chosen = p.decline ? actions.find(a => a.label === 'Pass') :
                        actions.find(a => a.kind === 'button' && a.label !== 'Pass');
                    declined = !!p.decline;
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
        assert.ok(settled, 'Actual weakness source behavior settled');
        assert.ok(eg.over);
        records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
        witness.created = witness.created.map(({ token, ...row }) => row);
        witness.coverageObligationIds = [...scenario.coverageObligationIds];
        return { records, witness };
    } finally { bot.close?.(); }
}
module.exports = { fixture, dependencies: ['bot/cards/pipeline/weakness-probes.js',
    'bot/cards/pipeline/weakness-probe-fixture.js', 'bot/cards/pipeline/probe-fixture.js',
    'bot/env.js', 'bot/omni/rs/state.js', 'bot/players/index.js'] };
