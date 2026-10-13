'use strict';
const assert = require('node:assert/strict');
const { constructProbeFixture } = require('./probe-fixture');
const { fullState, canonicalAction, expandActions } = require('../../omni/rs/state');
function forceObject(player) {
    const rows = [...player.baseZone.cards, ...player.outsideTheGameZone.getCards()].filter(c => c.isForceToken());
    assert.equal(rows.length, 1); return rows[0];
}
async function fixture(env, pool, scenario, seed) {
    const p = scenario.probe;
    const { eg, rng, bot, deck, own, enemy, source, activation, targets } = await constructProbeFixture(env, pool, scenario, seed);
    const ownForce = forceObject(own), enemyForce = forceObject(enemy), round = eg.round;
    if (p.held) ownForce.moveTo('base');
    if (p.enemyHeld) enemyForce.moveTo('base');
    own.base.damage = p.ownBaseDamage; enemy.base.damage = p.enemyBaseDamage;
    if (p.emptyEnemyHand) for (const c of enemy.getCardsInZone('hand')) c.moveTo('discard');
    eg.game.resolveGameState(true); eg.game.continue();
    const live = c => c?.isUnit?.() && c.isInPlay();
    const ready = () => own.getCardsInZone('resource').filter(c => !c.exhausted).length;
    function printedCost(card) {
        const available = [...own.getAspectsForCosts()];
        let cost = card.cardData.cost;
        for (const aspect of card.cardData.aspects) {
            const index = available.indexOf(aspect);
            if (index < 0) cost += 2;
            else available.splice(index, 1);
        }
        return cost;
    }
    const expectedPaid = printedCost(source) + (p.trigger === 'whenDefeated' ? printedCost(activation) : 0);
    const initial = { ownId: eg.cardId(ownForce.uuid), enemyId: eg.cardId(enemyForce.uuid), nextCardId: eg.game.state.allCards.length,
        enemyHand: enemy.getCardsInZone('hand').length, ownBase: own.base.damage, enemyBase: enemy.base.damage, ready: ready() };
    const before = new Map([...targets, source].filter(c => c.isUnit?.()).map(c => [c, {
        power: live(c) ? c.getPower() : c.cardData.power, hp: live(c) ? c.getHp() : c.cardData.hp,
        damage: live(c) ? c.damage : 0, shieldIds: live(c) ? c.upgrades.filter(u => u.isShield()).map(u => eg.cardId(u.uuid)) : [] }]));
    const chosenTarget = () => p.targetType === 'base' ? (p.chooseEnemyBase ? enemy.base : own.base) :
        p.selectSource || !targets.length && p.trigger === 'whenPlayed' ? source : targets[p.selectedIndex ?? 0];
    const target = chosenTarget();
    const records = [{ type: 'meta', schema: 'omni-rs-trace-v1', pool: pool.provenance, seed,
        bots: ['force-followon-probe', 'force-followon-probe'], decks: [deck, deck], scenario: scenario.name,
        fixtureConstruction: 'Stage disclosed real units/native attachments/resources/Force identities/base wounds at natural action window. Focus/death donor plays, all source trigger order/use/continuation/attack/expiry inputs and terminal results are recorded normal engine actions.', constructionParameters: p }];
    const witness = { coverageObligationIds: [], observations: [], uses: [], shields: [], heals: [], damage: [], combat: [] };
    let started = false, played = false, deathStarted = false, dead = false, settled = false, cancelled = false;
    let optional = false, selected = false, discardSelected = false, scalarCandidatesAtUse = [], handAtUse = [], resolved = false, hiddenObserved = false, hiddenAttacking = false;
    let combatStarted = false, combatPicked = false, step = 0, combatBase = 0, combatHp = 0;
    eg.game.on('onCardPlayed', e => { if (started && !settled && !e.isCancelledOrReplaced && e.card === source) played = true; });
    eg.game.on('onCardDefeated', e => { if (!settled && e.card === source) dead = true; });
    function scalarCandidates() {
        if (!p.targetType) return [];
        const rows = p.targetType === 'base' ? [own.base, enemy.base] : eg.game.getArenaUnits();
        return rows.filter(c => (p.owner === 'any' || c.controller === own) && (p.effectKind !== 'heal' || c.damage > 0));
    }
    eg.game.on('onForceUsed', e => {
        if (!settled && started) {
            witness.uses.push({ owner: eg.seatOf(e.player.id), id: eg.cardId(ownForce.uuid) });
            scalarCandidatesAtUse = scalarCandidates().map(c => c.uuid);
            handAtUse = enemy.getCardsInZone('hand').map(c => c.uuid);
        }
    });
    eg.game.on('onTokensCreated', e => {
        if (!settled && started && e.context?.source === source && e.tokenType === 'shield') {
            witness.shields.push(...(e.generatedTokens ?? []).map(c => eg.cardId(c.uuid)));
        }
    });
    eg.game.on('onDamageHealed', e => {
        if (!settled && e.context?.source === source) witness.heals.push({ id: eg.cardId(e.card.uuid), amount: e.damageHealed });
    });
    eg.game.on('onDamageDealt', e => {
        if (!settled && e.context?.source === source) witness.damage.push({ id: eg.cardId(e.card.uuid), amount: e.damageDealt });
    });
    eg.game.on('onAttackDeclared', e => {
        if (!settled && combatStarted && e.attack.attacker === source) witness.combat.push({ power: source.getPower(),
            defenderHp: e.attack.getSingleTarget().getHp(), defenderDamage: e.attack.getSingleTarget().damage });
    });
    function identity() {
        assert.equal(eg.cardId(ownForce.uuid), initial.ownId); assert.equal(eg.cardId(enemyForce.uuid), initial.enemyId);
        const state = fullState(eg);
        assert.equal(state.forceStateVersion, 1);
        assert.deepEqual(state.players.p1.forceToken, { id: initial.ownId, held: own.hasTheForce });
        assert.deepEqual(state.players.p2.forceToken, { id: initial.enemyId, held: enemy.hasTheForce });
        assert.equal(eg.game.state.allCards.length, initial.nextCardId + witness.shields.length);
    }
    function observe(stage, pid, actions) {
        identity();
        witness.observations.push({ stage, actor: pid ? eg.seatOf(pid) : undefined,
            actions: actions?.map(a => canonicalAction(eg, a)), state: fullState(eg) });
    }
    function assertResolved() {
        const used = !!p.held && !p.decline && !cancelled;
        assert.equal(own.hasTheForce, !!p.held && !used); assert.equal(enemy.hasTheForce, !!p.enemyHeld);
        assert.equal(witness.uses.length, used ? 1 : 0);
        assert.equal(selected, used && p.effectKind !== 'discard' && scalarCandidatesAtUse.length > 0,
            'Every effective scalar continuation must present and complete actual selection');
        assert.equal(discardSelected, used && p.effectKind === 'discard' && handAtUse.length > 0,
            'Mandatory opposing hand choice witnessed exactly when cards exist');
        for (const [c, b] of before) {
            if (used && selected && c === target) continue;
            if (c === source && (p.trigger === 'whenDefeated' || cancelled || !played)) continue;
            assert.ok(live(c), 'Nonselected staged recipient must remain in play, including inactive/declined source outcomes');
            assert.equal(c.getPower(), b.power); assert.equal(c.getHp(), b.hp); assert.equal(c.damage, b.damage);
        }
        if (!(used && selected && p.effectKind === 'heal' && p.targetType === 'base')) {
            assert.equal(own.base.damage, initial.ownBase); assert.equal(enemy.base.damage, initial.enemyBase);
        } else assert.equal((target === own.base ? enemy : own).base.damage, target === own.base ? initial.enemyBase : initial.ownBase);
        if (p.trigger !== 'event') assert.equal(optional, !!p.held, 'Optional primary prompt iff held, independent of beneficiary');
        if (p.keywords.shielded) {
            assert.equal(witness.shields.length, 1);
            assert.equal(source.upgrades.filter(u => u.isShield()).length, 1);
        }
        if (!cancelled) assert.equal(ready(), initial.ready - expectedPaid, 'Exact printed/aspect payment before continuation resolution');
        if (cancelled) {
            assert.equal(source.zoneName, 'hand'); assert.equal(ready(), initial.ready);
        } else if (p.trigger === 'event' || p.trigger === 'whenDefeated') assert.equal(source.zoneName, 'discard');
        if (used && selected && p.effectKind === 'stats') {
            const b = before.get(target);
            if (p.lethal || b.hp + p.hp <= b.damage) assert.equal(target.zoneName, 'discard');
            else {
                assert.equal(target.getPower(), Math.max(0, b.power + p.power));
                assert.equal(target.getHp(), b.hp + p.hp);
            }
        }
        if (used && selected && p.effectKind === 'damage') {
            const b = before.get(target);
            if (p.lethal || b.damage + (p.shield ? 0 : p.amount) >= b.hp) assert.equal(target.zoneName, 'discard');
            else {
                assert.equal(target.damage, b.damage + (p.shield ? 0 : p.amount));
                if (p.shield) assert.equal(target.upgrades.filter(u => u.isShield()).length, b.shieldIds.length - 1);
            }
        }
        if (used && selected && p.effectKind === 'heal') {
            const damage = target.isBase() ? (target === own.base ? initial.ownBase : initial.enemyBase) : before.get(target).damage;
            assert.equal(target.damage, Math.max(0, damage - p.amount));
            assert.deepEqual(witness.heals, [{ id: eg.cardId(target.uuid), amount: Math.min(damage, p.amount) }]);
        }
        if (p.effectKind === 'discard') assert.equal(enemy.getCardsInZone('hand').length,
            initial.enemyHand - (used && initial.enemyHand ? 1 : 0));
        if (p.trigger === 'whenDefeated' && p.targetType === 'unit') assert.equal(live(source), false);
        observe('force-and-continuation-resolved'); resolved = true;
        if (!(p.waitForExpiry || p.overwhelmCombat)) settled = true;
    }
    try {
        while (!eg.over && step < 4000) {
            const pid = eg.ids.find(id => eg.legalActions(id).length); assert.ok(pid);
            const actions = expandActions(eg, eg.legalActions(pid)), prompt = eg.player(pid).currentPrompt(), window = eg.isActionWindow(pid);
            let chosen;
            if (window) {
                records.push({ type: 'state', step, state: fullState(eg, pid) });
                if (!settled && !resolved && (cancelled || (p.trigger === 'whenDefeated' ? dead : played))) assertResolved();
                if (!settled && resolved && p.waitForExpiry && eg.round > round) {
                    if (live(target)) { const b = before.get(target); assert.equal(target.getPower(), b.power); assert.equal(target.getHp(), b.hp); }
                    observe('natural-phase-expiry'); settled = true;
                }
                if (!settled && combatPicked && !eg.game.currentAttack) {
                    const row = witness.combat.at(-1); assert.ok(row);
                    assert.equal(row.power, source.cardData.power);
                    assert.equal(enemy.base.damage, combatBase + Math.max(0, row.power - combatHp), 'Printed Overwhelm produces persistent exact excess');
                    observe('actual-overwhelm-combat'); settled = true;
                }
                if (!settled && !started && pid === own.id) {
                    chosen = actions.find(a => a.cardUuid === source.uuid); assert.ok(chosen); started = true;
                } else if (!settled && played && p.hiddenMenu && !hiddenObserved && pid === enemy.id) {
                    chosen = actions.find(a => a.cardUuid === targets[1].uuid); assert.ok(chosen); hiddenAttacking = true;
                } else if (!settled && played && p.trigger === 'whenDefeated' && !deathStarted &&
                    (!p.hiddenMenu || hiddenObserved) && pid === own.id) {
                    chosen = actions.find(a => a.cardUuid === activation.uuid); assert.ok(chosen); deathStarted = true;
                } else if (!settled && resolved && p.overwhelmCombat && eg.round > round && !combatStarted && pid === own.id) {
                    chosen = actions.find(a => a.cardUuid === source.uuid); assert.ok(chosen); combatStarted = true;
                } else if (!settled) chosen = actions.find(a => a.arg === 'pass');
            } else if (!settled && started) {
                if (hiddenAttacking && /target for attack/i.test(prompt.menuTitle ?? '')) {
                    assert.equal(targets[1].zoneName, source.zoneName, 'Attack arena must make source otherwise eligible');
                    assert.equal(source.hasSomeKeyword('hidden'), true);
                    assert.equal(source.wasPlayedDeployedOrCreatedThisPhase(), true);
                    assert.ok(!actions.some(a => a.cardUuid === source.uuid), 'Actual same-phase Hidden source cannot be attacked');
                    observe('actual-hidden-attack-legality', pid, actions);
                    chosen = actions.find(a => a.arg === 'cancel'); assert.ok(chosen); hiddenObserved = true; hiddenAttacking = false;
                } else if (combatStarted && /target for attack/i.test(prompt.menuTitle ?? '')) {
                    const defender = targets[0]; combatBase = enemy.base.damage; combatHp = defender.getHp() - defender.damage;
                    chosen = actions.find(a => a.cardUuid === defender.uuid); assert.ok(chosen); combatPicked = true;
                } else if (deathStarted && !dead && actions.some(a => a.cardUuid === source.uuid)) {
                    chosen = actions.find(a => a.cardUuid === source.uuid);
                } else if (p.keywords.shielded && actions.some(a => a.label === 'Shielded') && actions.some(a => a.label === p.title)) {
                    assert.equal(pid, own.id); observe('shared-shielded-force-trigger-order', pid, actions);
                    chosen = actions.find(a => a.label === (p.shieldFirst ? 'Shielded' : p.title)); assert.ok(chosen);
                } else if (/no effect/i.test(prompt.menuTitle ?? '')) {
                    assert.equal(pid, own.id); assert.deepEqual(actions.map(a => a.label), ['Play anyway', 'Cancel']);
                    assert.equal(source.zoneName, 'hand'); assert.equal(ready(), initial.ready);
                    observe('absent-force-event-confirmation', pid, actions);
                    chosen = actions.find(a => a.label === (p.cancel ? 'Cancel' : 'Play anyway')); cancelled = !!p.cancel;
                } else if (actions.some(a => a.label === 'Pass')) {
                    assert.equal(pid, own.id); assert.deepEqual(actions.map(a => a.label), ['Trigger', 'Pass']);
                    optional = true; observe('optional-primary-force-use', pid, actions);
                    chosen = actions.find(a => a.label === (p.decline ? 'Pass' : 'Trigger'));
                } else if (!resolved && actions.some(a => a.kind === 'card')) {
                    assert.equal(own.hasTheForce, false, 'Primary Force spent before continuation targeting');
                    if (p.effectKind === 'discard') {
                        assert.equal(pid, enemy.id); assert.deepEqual(actions.map(a => a.cardUuid).sort(), enemy.getCardsInZone('hand').map(c => c.uuid).sort());
                        chosen = actions.find(a => a.kind === 'card'); discardSelected = true;
                    } else {
                        assert.equal(pid, own.id);
                        const expected = scalarCandidates();
                        assert.deepEqual(expected.map(c => c.uuid).sort(), [...scalarCandidatesAtUse].sort(), 'Independent selector domain captured after primary use');
                        assert.deepEqual(actions.filter(a => a.kind === 'card').map(a => a.cardUuid).sort(), expected.map(c => c.uuid).sort());
                        assert.ok(!actions.some(a => a.arg === 'cancel'), 'Postpayment continuation has no Cancel');
                        if (p.trigger === 'whenDefeated') assert.ok(!actions.some(a => a.cardUuid === source.uuid));
                        chosen = actions.find(a => a.cardUuid === target?.uuid); assert.ok(chosen); selected = true;
                    }
                    observe('continuation-selector-after-use', pid, actions);
                }
                chosen ??= actions.find(a => a.kind === 'button' && /trigger|resolve|yes/i.test(a.label ?? ''));
                chosen ??= actions.find(a => a.arg === 'done');
            }
            chosen ??= bot.choose({ game: eg, pid, actions, rng }); assert.ok(chosen);
            records.push({ type: 'decision', step, actor: eg.seatOf(pid), prompt: { type: prompt.promptType ?? null,
                title: prompt.menuTitle ?? null, selected: (eg.player(pid).promptState.selectedCards ?? []).map(c => eg.cardId(c.uuid)), actionWindow: window },
                actions: actions.map(a => canonicalAction(eg, a)), chosen: canonicalAction(eg, chosen).key, events: [] });
            eg.apply(pid, chosen, rng); step++;
        }
        assert.ok(settled); assert.ok(eg.over);
        records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
        witness.coverageObligationIds = [...scenario.coverageObligationIds]; return { records, witness };
    } finally { bot.close?.(); }
}
module.exports = { fixture, dependencies: ['bot/cards/pipeline/force-followon-probes.js', 'bot/cards/pipeline/force-followon-probe-fixture.js',
    'bot/cards/pipeline/force-probes.js', 'bot/cards/pipeline/probe-fixture.js', 'bot/env.js', 'bot/omni/rs/state.js', 'bot/players/index.js'] };
