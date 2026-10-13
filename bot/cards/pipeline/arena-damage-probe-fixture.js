'use strict';
const assert = require('node:assert/strict');
const { constructProbeFixture } = require('./probe-fixture');
const { fullState, canonicalAction, expandActions } = require('../../omni/rs/state');
async function fixture(env, pool, scenario, seed) {
    const p = scenario.probe;
    assert.equal(p.family, 'arena-damage');
    const reverse = p.sourceSeat === 2;
    const extra = reverse ? [{ code: p.cardId, owner: 'opponent', zone: 'hand', arena: p.sourceArena }, ...(p.activationCode ? [{ code: p.activationCode, owner: 'opponent', zone: 'hand' }] : [])] : [];
    const construction = reverse ? { ...scenario, probe: { ...p, targets: [...p.targets.map(t => ({ ...t, owner: t.owner === 'self' ? 'opponent' : 'self', attachments: t.attachments?.map(a => ({ ...a, ...(a.owner ? { owner: a.owner === 'self' ? 'opponent' : 'self' } : {}) })) })), ...extra] } } : scenario;
    const setup = await constructProbeFixture(env, pool, construction, seed);
    const { eg, rng, bot, deck } = setup;
    const own = reverse ? setup.enemy : setup.own, enemy = reverse ? setup.own : setup.enemy;
    const targets = setup.targets.slice();
    const activation = reverse && p.activationCode ? targets.pop() : setup.activation;
    const source = reverse ? targets.pop() : setup.source;
    if (p.condition) {
        own.base.damage = p.initialBaseDamage ?? 0;
        enemy.base.damage = p.initialEnemyBaseDamage ?? 0;
        eg.game.resolveGameState(true);
        eg.game.continue();
    }
    const id = c => eg.cardId(c.uuid), live = c => c.isUnit?.() && c.isInPlay();
    const ready = () => own.getCardsInZone('resource').filter(c => !c.exhausted).length;
    const forceToken = player => [...player.baseZone.cards, ...player.outsideTheGameZone.getCards()].find(c => c.isForceToken());
    const forceBefore = [own, enemy].map(player => ({ player, token: forceToken(player), held: player.hasTheForce }));
    const witness = { coverageObligationIds: [], observations: [], events: [] };
    const records = [{ type: 'meta', schema: 'omni-rs-trace-v1', pool: pool.provenance, seed, bots: ['arena-damage-probe', 'arena-damage-probe'], decks: [deck, deck], scenario: scenario.name, constructionParameters: p,
            fixtureConstruction: 'Stage actual quiet recipients and existing native Shield identities, normally play source, naturally ready attack sources and use actual hand defeat event for death registrations. Record complete terminal game.' }];
    let step = 0, started = false, played = false, playChecked = false, deathStarted = false, sourceDefeated = false;
    let attacking = false, attackPicked = false, attackEnded = false, listArmed = false, listChecked = false, settled = false, initialReady = 0;
    let baseline = null, initialOrder = [], selectedDomain = [], defender = null;
    let conditionValue = true, uniqueChosen = false, devotionPlayed = false, devotionStarted = false, devotionReady = 0, restoreOrderChosen = false;
    const damageEvents = [], defeatedEvents = [], shieldEvents = [], tokenEvents = [];
    function recordEvent(name, e) {
        if (settled || !started)
            return;
        const row = { name, card: e.card ? id(e.card) : null, source: e.context?.source ? id(e.context.source) : e.damageSource?.card ? id(e.damageSource.card) : null, amount: e.damageDealt ?? null, type: e.damageSource?.type ?? null, zone: e.card?.zoneName ?? null };
        witness.events.push(row);
    }
    eg.game.on('onCardPlayed', e => {
        if (!started || settled || e.isCancelledOrReplaced)
            return;
        if (e.card === source) {
            played = true;
            if (p.condition && p.trigger === 'whenPlayed')
                capture();
        }
        if (p.devotionIndex != null && e.card === targets[p.devotionIndex])
            devotionPlayed = true;
    });
    eg.game.on('onAttackDeclared', () => { if (p.condition && !settled && attacking && live(source) && baseline?.has(source))
        baseline.get(source).attackPower = source.getPower(); });
    eg.game.on('onDamageHealed', e => {
        if (!p.condition || !started || settled || e.isCancelledOrReplaced)
            return;
        recordEvent('onDamageHealed', e);
        if (p.restoreOrder === 'restore-first' && e.card === own.base) {
            conditionValue = false;
            selectedDomain = [];
            witness.selectedDomain = [];
        }
    });
    eg.game.on('onCardDefeated', e => {
        if (settled || !started || e.isCancelledOrReplaced)
            return;
        if (p.condition && p.oldIndex != null && (e.card === source || e.card === targets[p.oldIndex]))
            capture();
        recordEvent('onCardDefeated', e);
        if (e.card === source && deathStarted)
            sourceDefeated = true;
        if (listArmed) {
            if (selectedDomain.includes(e.card) && baseline) {
                for (const other of selectedDomain)
                    if (other !== e.card && live(other) && !baseline.get(other).shields.length)
                        assert.equal(other.damage, baseline.get(other).damage + p.amount, 'All primary list damage applied before first physical recipient departure');
                witness.observations.push({ stage: 'physical-recipient-death', id: id(e.card), remaining: selectedDomain.filter(live).map(c => ({ id: id(c), damage: c.damage })) });
            }
            defeatedEvents.push(e.card);
            if (e.card.isShield?.())
                shieldEvents.push(e.card);
        }
    });
    eg.game.on('onDamageDealt', e => {
        if (settled || !started || e.isCancelledOrReplaced)
            return;
        recordEvent('onDamageDealt', e);
        if (listArmed)
            damageEvents.push({ card: e.card, amount: e.damageDealt, type: e.damageSource?.type, source: e.damageSource?.card });
    });
    eg.game.on('onTokensCreated', e => {
        if (settled || !started || e.isCancelledOrReplaced)
            return;
        recordEvent('onTokensCreated', e);
        if (listArmed)
            tokenEvents.push(e);
    });
    eg.game.on('onAttackEnd', e => {
        if (attacking && !settled) {
            attackEnded = true;
            recordEvent('onAttackEnd', e);
        }
    });
    function observe(stage, pid, actions) {
        witness.observations.push({ stage, actor: pid ? eg.seatOf(pid) : null, actions: actions?.map(a => canonicalAction(eg, a)), state: fullState(eg, pid) });
    }
    function capture() {
        const arena = eg.game.getArenaUnits();
        if (p.condition) {
            conditionValue = p.condition === 'own-arena-count' ? own.getArenaUnits().length >= p.threshold : own.base.damage >= p.threshold;
            witness.observations.push({ stage: 'condition-capture', condition: p.condition, value: conditionValue, ownCount: own.getArenaUnits().length, ownBaseDamage: own.base.damage, source: id(source), sourceZone: source.zoneName });
        }
        initialOrder = arena.slice();
        selectedDomain = arena.filter(c => (!p.condition || conditionValue) && (p.receiver === 'game' || c.controller === (p.receiver === 'player' ? own : enemy)) && (!p.arena || c.cardData.arena === p.arena) && (!p.excludeSource || c !== source) && (!p.exhaustedOnly || c.exhausted));
        baseline = new Map([...arena, own.base, enemy.base].map(c => [c, { damage: c.damage, hp: c.getHp?.() ?? c.cardData.hp, power: c.isUnit?.() ? c.getPower() : 0,
                shields: c.upgrades?.filter(u => u.isShield?.()).slice() ?? [], zone: c.zoneName }]));
        witness.capturedOrder = initialOrder.map(id);
        witness.selectedDomain = selectedDomain.map(id);
        listArmed = true;
    }
    function checkList() {
        assert.ok(baseline, 'Captured list before actual ability window');
        if (p.restoreOrder)
            assert.ok(restoreOrderChosen, 'Explicit actual Restore/conditional-wave ordering choice witnessed');
        if (p.trigger === 'whenDefeated')
            assert.equal(source.zoneName, 'discard', 'Actual defeated source context survives departure');
        const ability = damageEvents.filter(e => e.source === source && e.type === 'ability');
        const expectedDamaged = selectedDomain.filter(c => !baseline.get(c).shields.length);
        assert.deepEqual(ability.map(e => id(e.card)), expectedDamaged.map(id), 'One shared damage event in captured global target order for every unshielded recipient');
        for (const event of ability)
            assert.equal(event.amount, p.amount, 'Printed damage amount');
        const lethal = [];
        for (const [card, b] of baseline) {
            if (card === source && p.trigger === 'whenDefeated')
                continue;
            const hit = selectedDomain.includes(card);
            const consumed = hit && b.shields.length ? 1 : 0;
            if (consumed) {
                const lost = b.shields.filter(t => shieldEvents.includes(t));
                const totalConsumed = p.condition && p.shieldCombat && card === defender ? 2 : 1;
                assert.equal(lost.length, totalConsumed, 'Exactly one original Shield consumed by list damage');
                const owners = [...new Set(selectedDomain.filter(c => baseline.get(c).shields.length).map(c => c.controller))];
                const preferred = p.ownerFirst === 'opponent' ? enemy : own;
                const first = owners.includes(preferred) ? preferred : owners[0];
                const index = p.sameOwnerShields ? (card === targets[0] ? 0 : 1) : owners.length > 1 && card.controller !== first ? 1 : 0;
                assert.equal(id(lost[0]), id(b.shields[index]), 'Exact retained/alternate Shield identity after owner-priority consolidation');
                assert.equal(lost[0].zoneName, 'outsideTheGame');
                assert.equal(lost[0].isAttached(), false);
                if (totalConsumed === 2) {
                    assert.deepEqual(shieldEvents.filter(t => b.shields.includes(t)).map(id), b.shields.map(id), 'Wave consumes first Shield then combat consumes second exact identity');
                    assert.equal(id(lost[1]), id(b.shields[1]));
                    assert.equal(lost[1].zoneName, 'outsideTheGame');
                    assert.equal(lost[1].isAttached(), false);
                }
                assert.deepEqual(card.upgrades.filter(t => t.isShield?.()).map(id), b.shields.filter(t => !lost.includes(t)).map(id), 'Other original Shields survive in attachment order');
            }
            else if (b.shields.length && live(card))
                assert.deepEqual(card.upgrades.filter(t => t.isShield?.()).map(id), b.shields.map(id), 'Nonrecipient Shields unchanged');
            let expected = b.damage + (hit && !b.shields.length ? p.amount : 0);
            if (p.trigger === 'onAttack' && attackEnded) {
                if (card === enemy.base && defender === enemy.base)
                    expected += baseline.get(source).attackPower ?? baseline.get(source).power;
                if (p.defenderSurvivesWave && card === defender)
                    expected += baseline.get(source).attackPower ?? baseline.get(source).power;
                if (p.defenderSurvivesWave && card === source)
                    expected += baseline.get(defender).power;
            }
            if (p.condition && attackEnded && p.conditionalUnitAttack && card === defender && !b.shields.length)
                expected += baseline.get(source).attackPower;
            if (p.condition && attackEnded && p.conditionalUnitAttack && card === source)
                expected += baseline.get(defender).power;
            if (p.condition && p.deathDamage && card.isUnit?.() && card.controller === own && card.cardData.arena === 'ground')
                expected += 1;
            if (p.condition && p.restoreOrder && card === own.base)
                expected -= 2;
            if (p.condition && card === enemy.base) expected = Math.min(b.hp, expected);
            if (card.isUnit?.() && expected >= b.hp) {
                lethal.push(card);
                assert.equal(card.zoneName, card.isToken?.() ? 'outsideTheGame' : card.isLeader?.() ? 'base' : 'discard', 'Captured lethal recipient moves to correct zone');
            }
            else {
                if (card.isUnit?.())
                    assert.ok(live(card), 'Nonlethal and ineligible units remain in play');
                assert.equal(card.damage, expected, 'Every recipient and nonrecipient exact damage after list');
                if (card.isUnit?.()) {
                    assert.equal(card.getHp(), b.hp);
                    assert.equal(card.getPower(), b.power, 'No lasting stat modification from damage');
                }
            }
        }
        const waveLethal = selectedDomain.filter(c => !baseline.get(c).shields.length && baseline.get(c).damage + p.amount >= baseline.get(c).hp);
        assert.deepEqual(defeatedEvents.filter(c => waveLethal.includes(c)).map(id), waveLethal.map(id), 'Physical primary damage defeats preserve captured target order');
        if (p.deathGain)
            for (const f of forceBefore) {
                assert.equal(forceToken(f.player), f.token, 'Persistent native Force identity');
                assert.equal(f.player.hasTheForce, lethal.some(c => c.controller === f.player) || f.held, 'Captured death gain belongs to defeated recipient controller');
            }
        if (p.trigger === 'whenPlayed' && (!p.condition || live(source)))
            assert.equal(source.damage, 0, 'Entering source excluded from its own other-units list');
        if (p.defenseToken) {
            const created = tokenEvents.flatMap(e => e.generatedTokens ?? []).filter(c => c.isUnit?.() && c.cardData.internalName === 'clone-trooper');
            assert.equal(created.length, 1, 'Captured printed OnDefense creates exactly one Clone after defender dies');
            assert.equal(created[0].controller, enemy);
            assert.equal(created[0].damage, 0, 'Later token not included in earlier damage list');
            const dead = witness.events.findIndex(e => e.name === 'onCardDefeated' && e.card === id(defender));
            const token = witness.events.findIndex(e => e.name === 'onTokensCreated');
            assert.ok(dead >= 0 && token > dead, 'Defender physical departure precedes captured defense token');
        }
        observe('resolved-list');
        listChecked = true;
    }
    function playedCost(card = source) {
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
    }
    function checkCombat() {
        if (p.condition && p.restoreCombat) {
            assert.ok(attackPicked && attackEnded);
            assert.equal(own.base.damage, Math.max(0, p.initialBaseDamage - p.restore));
            assert.equal(enemy.base.damage, Math.min(enemy.base.cardData.hp, source.cardData.power));
            assert.equal(source.getPower(), source.cardData.power);
            const heals = witness.events.filter(e => e.name === 'onDamageHealed' && e.card === id(own.base));
            assert.equal(heals.length, p.initialBaseDamage ? 1 : 0);
            observe('printed-restore-combat');
            return;
        }
        assert.ok(attackPicked && attackEnded, 'Actual attack reaches end with preserved combat context');
        if (p.coordinateCombat) {
            assert.equal(enemy.base.damage, Math.min(enemy.base.cardData.hp, source.cardData.power + (p.friendlyCount >= 3 ? p.coordinateRaid : 0)), 'Coordinate live Raid attack damage');
            assert.equal(source.getPower(), source.cardData.power, 'Raid removed outside attack');
            assert.equal(source.hasSomeKeyword('raid'), p.friendlyCount >= 3, 'Coordinate presence persists according to current friendly count');
        }
        if (p.combatAfterPlay) {
            const b = baseline.get(defender), combat = damageEvents.filter(e => e.type === 'attack');
            const prevented = b.shields.length > 1;
            assert.equal(enemy.base.damage, prevented ? 0 : source.cardData.power - (b.hp - (b.damage + p.amount)), 'Persistent actual printed Overwhelm excess');
            if (prevented) {
                assert.ok(live(defender));
                assert.equal(defender.damage, b.damage);
                assert.equal(defender.upgrades.filter(u => u.isShield?.()).length, 0, 'One Shield for list and one for combat');
            }
            else
                assert.equal(defender.zoneName, 'discard');
            assert.ok(combat.length || prevented, 'Ordinary combat or actual Shield prevention witnessed');
        }
    }
    try {
        while (!eg.over && step < 4000) {
            const pid = eg.ids.find(pid => eg.legalActions(pid).length);
            assert.ok(pid);
            const actions = expandActions(eg, eg.legalActions(pid)), window = eg.isActionWindow(pid), prompt = eg.player(pid).currentPrompt();
            let chosen;
            if (window) {
                records.push({ type: 'state', step, state: fullState(eg, pid) });
                if (!settled && played && !playChecked) {
                    assert.equal(source.controller, own);
                    if (p.condition && p.oldIndex != null && p.keep === 'old')
                        assert.equal(source.zoneName, 'discard');
                    else
                        assert.ok(live(source), 'Normally played source enters arena');
                    if (p.condition && p.friendlyCount != null) {
                        assert.equal(own.getArenaUnits().length, p.friendlyCount, 'Count after entry/unique replacement includes only surviving own units');
                        if (p.oldIndex != null) {
                            assert.ok(uniqueChosen);
                            assert.equal(targets[p.oldIndex].zoneName, p.keep === 'old' ? p.sourceArena + 'Arena' : 'discard');
                        }
                    }
                    assert.equal(ready(), initialReady - playedCost(), 'Exact focus printed/aspect payment');
                    playChecked = true;
                    observe('normally-played');
                    if (p.trigger === 'whenPlayed') {
                        checkList();
                        if (!p.combatAfterPlay && !p.restoreCombat)
                            settled = true;
                    }
                }
                if (!settled && sourceDefeated && p.trigger === 'whenDefeated') {
                    checkList();
                    settled = true;
                }
                if (!settled && attackEnded) {
                    if (p.trigger === 'onAttack')
                        checkList();
                    if (p.combatAfterPlay || p.coordinateCombat || p.restoreCombat)
                        checkCombat();
                    if (p.coordinateCombat) {
                        attacking = false;
                        attackEnded = false;
                        listArmed = false;
                    }
                    else
                        settled = true;
                }
                if (!settled && p.devotionIndex != null && devotionPlayed) {
                    assert.equal(ready(), devotionReady - playedCost(targets[p.devotionIndex]));
                    assert.equal(targets[p.devotionIndex].parentCard, source);
                    assert.equal(source.getHp(), source.cardData.hp + 1);
                    assert.equal(source.getPower(), source.cardData.power + 1);
                    devotionPlayed = false;
                    observe('normally-attached-devotion');
                }
                if (!settled && !started && pid === own.id) {
                    chosen = actions.find(a => a.cardUuid === source.uuid);
                    assert.ok(chosen, 'Normal focus hand play');
                    initialReady = ready();
                    started = true;
                    if (p.trigger === 'whenPlayed')
                        capture();
                }
                else if (!settled && playChecked && p.devotionIndex != null && !devotionStarted && pid === own.id) {
                    chosen = actions.find(a => a.cardUuid === targets[p.devotionIndex].uuid);
                    assert.ok(chosen);
                    devotionReady = ready();
                    devotionStarted = true;
                }
                else if (!settled && playChecked && p.coordinateCombat && !attacking && !deathStarted && pid === own.id && source.exhausted === false) {
                    const friends = eg.game.getArenaUnits().filter(c => c.controller === own).length;
                    assert.equal(friends, p.friendlyCount, 'Exact live Coordinate threshold before attack');
                    chosen = actions.find(a => a.cardUuid === source.uuid);
                    assert.ok(chosen);
                    attacking = true;
                }
                else if (!settled && playChecked && p.trigger === 'whenDefeated' && !deathStarted && (!p.coordinateCombat || attackPicked) && pid === own.id) {
                    chosen = actions.find(a => a.cardUuid === activation.uuid);
                    assert.ok(chosen, 'Actual normal defeat-event hand play');
                    deathStarted = true;
                    capture();
                }
                else if (!settled && playChecked && (p.trigger === 'onAttack' || p.combatAfterPlay || p.restoreCombat) && !attacking && pid === own.id && !source.exhausted) {
                    chosen = actions.find(a => a.cardUuid === source.uuid);
                    assert.ok(chosen, 'Naturally readied source attacks');
                    attacking = true;
                }
                else if (!settled)
                    chosen = actions.find(a => a.arg === 'pass');
            }
            else if (!settled && started) {
                if (p.oldIndex != null && actions.some(a => a.cardUuid === source.uuid) && actions.some(a => a.cardUuid === targets[p.oldIndex].uuid)) {
                    assert.equal(pid, own.id);
                    assert.equal(source.getHp(), source.cardData.hp);
                    assert.equal(targets[p.oldIndex].getHp(), source.cardData.hp);
                    chosen = actions.find(a => a.cardUuid === (p.keep === 'old' ? source.uuid : targets[p.oldIndex].uuid));
                    uniqueChosen = true;
                    observe('unique-source-choice', pid, actions);
                }
                else if (p.devotionIndex != null && devotionStarted && !attacking && actions.some(a => a.cardUuid === source.uuid))
                    chosen = actions.find(a => a.cardUuid === source.uuid);
                else if (attacking && p.restoreOrder && !restoreOrderChosen && actions.some(a => a.label === 'Restore 2')) {
                    assert.equal(pid, own.id, 'Source controller selects own competing declaration abilities');
                    assert.ok(actions.some(a => a.label === p.conditionalTitle));
                    chosen = p.restoreOrder === 'restore-first' ? actions.find(a => a.label === 'Restore 2') : actions.find(a => a.label === p.conditionalTitle);
                    assert.ok(chosen);
                    restoreOrderChosen = true;
                    observe('restore-wave-order', pid, actions);
                }
                else if (deathStarted && !sourceDefeated && actions.some(a => a.cardUuid === source.uuid))
                    chosen = actions.find(a => a.cardUuid === source.uuid);
                else if (attacking && /target for attack/i.test(prompt.menuTitle ?? '')) {
                    defender = Number.isInteger(p.attackTargetIndex) ? targets[p.attackTargetIndex] : enemy.base;
                    chosen = actions.find(a => a.cardUuid === defender.uuid);
                    assert.ok(chosen, 'Legal actual declared defender');
                    attackPicked = true;
                    if (p.trigger === 'onAttack')
                        capture();
                    if (p.coordinateCombat) {
                        const count = eg.game.getArenaUnits().filter(c => c.controller === own).length;
                        assert.equal(count, p.friendlyCount, 'Exact planned live count before Coordinate attack');
                    }
                }
                else if (actions.some(a => a.label === 'You') && actions.some(a => a.label === 'Opponent')) {
                    assert.equal(pid, own.id, 'Original action source controller chooses owner priority');
                    const first = p.ownerFirst === 'opponent' ? enemy : own;
                    chosen = actions.find(a => a.label === (pid === first.id ? 'You' : 'Opponent'));
                    observe('owner-priority', pid, actions);
                }
                else if (actions.some(a => a.cardUuid)) {
                    const choices = actions.filter(a => a.cardUuid);
                    const oldest = targets.flatMap(c => c.upgrades ?? []).find(u => u.isShield?.() && choices.some(a => a.cardUuid === u.uuid));
                    if (oldest) {
                        chosen = choices.find(a => a.cardUuid === oldest.uuid);
                        observe('shield-identity-choice', pid, actions);
                    }
                }
                if (p.sameOwnerShields && !chosen) {
                    const firstTarget = targets.find(c => c.upgrades?.some(t => t.isShield?.()) && !shieldEvents.some(t => baseline?.get(c)?.shields.includes(t)));
                    if (firstTarget)
                        chosen = actions.find(a => (a.label ?? '').includes('Defeat Shield') && (a.label ?? '').includes(firstTarget.cardData.title));
                    if (chosen) {
                        assert.equal(pid, enemy.id, 'Recipient owner chooses replacement contexts');
                        observe('same-owner-replacement-order', pid, actions);
                    }
                }
                chosen ??= actions.find(a => a.kind === 'button' && /trigger|resolve|play|yes/i.test(a.label ?? ''));
                chosen ??= actions.find(a => a.arg === 'done');
            }
            chosen ??= bot.choose({ game: eg, pid, actions, rng });
            assert.ok(chosen);
            records.push({ type: 'decision', step, actor: eg.seatOf(pid), prompt: { type: prompt.promptType ?? null, title: prompt.menuTitle ?? null, selected: (eg.player(pid).promptState.selectedCards ?? []).map(id), actionWindow: window }, actions: actions.map(a => canonicalAction(eg, a)), chosen: canonicalAction(eg, chosen).key, events: [] });
            eg.apply(pid, chosen, rng);
            step++;
        }
        assert.ok(settled && listChecked, 'Actual full source-focused list behavior settled');
        assert.ok(eg.over, 'Complete terminal source trace');
        records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
        witness.coverageObligationIds = [...scenario.coverageObligationIds];
        return { records, witness };
    }
    catch (error) {
        error.diagnostic = { records, witness };
        throw error;
    }
    finally {
        bot.close?.();
    }
}
module.exports = { fixture, dependencies: ['bot/cards/pipeline/arena-damage-probes.js', 'bot/cards/pipeline/arena-damage-probe-fixture.js', 'bot/cards/pipeline/probe-fixture.js', 'bot/cards/pipeline/force-probes.js', 'bot/cards/pipeline/keyword-inventory-probes.js', 'bot/cards/pipeline/weakness-continuation-probes.js', 'bot/cards/pipeline/parent-upgrade-probes.js', 'bot/omni/rs/make-pool.js', 'bot/env.js', 'bot/omni/rs/state.js', 'bot/players/index.js'] };
