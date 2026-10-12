'use strict';
// Real pinned-engine death observations. Prototype pools are not admission claims.
const root = require('node:path').resolve(__dirname, '../../../..');
const crypto = require('node:crypto');
const fs = require('fs'), zlib = require('zlib'), assert = require('assert/strict');
const { Env } = require(root + '/bot/env');
const { loadPool } = require(root + '/bot/omni/rs/pool');
const { canonicalAction } = require(root + '/bot/omni/rs/state');
const { fixture } = require(root + '/bot/cards/reference/scenarios/event-groups');
function choose(c) {
    const { actions: a, eg, pid, targets: t, scratch: s, observed: o } = c;
    o.menus ??= [];
    if (a.some(x => x.label === 'You') && a.some(x => x.label === 'Opponent')) {
        assert.deepEqual(a.map(x => [x.kind, x.arg, x.label]), [['button', 0, 'You'], ['button', 1, 'Opponent']]);
        if (s.initiative === 'enemy')
            assert.equal(c.own.hasInitiative(), false);
        assert.equal(pid, c.own.id);
    }
    if (eg.player(pid).currentPrompt().menuTitle === 'Resolve \"Draw a card\"')
        assert.deepEqual(a.map(x => [x.kind, x.arg, x.label]), [['button', 'next', 'Resolve next'], ['button', 'all', 'Resolve all (2)']]);
    if (eg.player(pid).currentPrompt().menuTitle === 'You have multiple triggers to resolve. Choose which to resolve first:') {
        const titles = s.scenarioName === 'different-title-death-sources' ? ['Give a unit -1/-1 for this phase', 'Draw a card'] : ['Draw a card', 'Draw a card'];
        assert.deepEqual(a.map(x => [x.kind, x.arg, x.label]), titles.map((title, i) => ['button', String(i), title]));
    }
    if (eg.player(pid).currentPrompt().menuTitle === 'You may trigger this ability')
        assert.deepEqual(a.map(x => [x.kind, x.arg, x.label]), [['button', 'trigger', 'Trigger'], ['button', 'pass', 'Pass']]);
    o.menus.push({ actor: eg.seatOf(pid), title: eg.player(pid).currentPrompt().menuTitle, actions: a.map(x => canonicalAction(eg, x)) });
    if (a.some(x => x.label === 'You') && a.some(x => x.label === 'Opponent'))
        return a.find(x => x.label === (s.youFirst ? 'You' : 'Opponent'));
    if (a.some(x => x.arg === 'done')) {
        const selected = eg.player(pid).promptState.selectedCards ?? [];
        for (const k of ['first', 'second'])
            if (t[k] && !selected.includes(t[k]))
                return a.find(x => x.cardUuid === t[k].uuid);
        return a.find(x => x.arg === 'done');
    }
    if (c.pending?.target && a.some(x => x.cardUuid === t[c.pending.target].uuid) && !a.some(x => x.arg === 'trigger'))
        return a.find(x => x.cardUuid === t[c.pending.target].uuid);
    if (s.decline && a.some(x => x.label === 'Pass'))
        return a.find(x => x.label === 'Pass');
    return a.find(x => x.cardUuid === (t.second ?? t.first).uuid) ?? a.find(x => x.arg === 'all') ?? a.find(x => x.kind === 'button' && !/pass|cancel/i.test(x.label ?? ''));
}
const unit = (key, code, owner = 'own', damage = 0) => ({ key, code, owner, damage });
function sc(name, units, plan, opt = {}) {
    return { name, family: 'self-when-defeated', units, plan, baseDamage: 0, initiative: opt.initiative, choose, beforeApply: c => {
            if (c.atWindow && c.scratch.hand === undefined)
                Object.assign(c.scratch, opt, { scenarioName: name, hand: c.own.getCardsInZone('hand').length, preIds: Object.fromEntries(units.map(u => [u.key, c.eg.cardId(c.targets[u.key].uuid)])), drawDeck: c.own.drawDeck.map(x => c.eg.cardId(x.uuid)), enemyDrawDeck: c.enemy.drawDeck.map(x => c.eg.cardId(x.uuid)), enemyHand: c.enemy.getCardsInZone('hand').length, played: !plan[0].from });
        }, assertAfter: c => {
            for (const k of ['first', 'second'])
                if (c.targets[k])
                    assert.equal(c.targets[k].zoneName, opt.bounce ? 'hand' : 'discard');
            assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - (c.scratch.played ? 1 : 0) + (opt.bounce ? 1 : 0) + (opt.drawOwn ?? 1));
            assert.equal(c.enemy.getCardsInZone('hand').length, c.scratch.enemyHand + (opt.drawEnemy ?? 0));
            c.observed.preDefeatIds = c.scratch.preIds;
            c.observed.discardOrder = c.own.getCardsInZone('discard').map(x => c.eg.cardId(x.uuid));
            c.observed.drawnIds = c.scratch.drawDeck.slice(0, opt.drawOwn ?? 1);
            for (const id of c.observed.drawnIds)
                assert.ok(c.own.getCardsInZone('hand').some(x => c.eg.cardId(x.uuid) === id), 'Expected top-deck card drawn');
        } };
}
const scenarios = [sc('both-player-active-vs-initiative', [unit('first', 'ASH_116'), unit('second', 'ASH_116', 'enemy')], [{ code: 'SEC_155' }], { drawOwn: 1, drawEnemy: 1, initiative: 'enemy' }), sc('ant-and-landing-same-player', [unit('first', 'ASH_116', 'own', 1), unit('second', 'JTL_063', 'own', 3)], [{ code: 'JTL_140' }], { drawOwn: 2 }), sc('ant-effect-defeat-draw', [unit('first', 'ASH_116')], [{ code: 'SOR_077', target: 'first' }]), sc('ant-bounce-no-death', [unit('first', 'ASH_116')], [{ code: 'TWI_226', target: 'first' }], { bounce: true, drawOwn: 0 }), ...[false, true].map(decline => sc('landing-effect-' + (decline ? 'pass' : 'accept'), [unit('first', 'JTL_063')], [{ code: 'SOR_077', target: 'first' }], { decline, drawOwn: decline ? 0 : 1 })), sc('two-ant-same-player-order', [unit('first', 'ASH_116'), unit('second', 'ASH_116')], [{ code: 'SEC_155' }], { drawOwn: 2 }), ...[false, true].map(youFirst => sc('two-ant-both-players-' + (youFirst ? 'you' : 'opponent') + '-first', [unit('first', 'ASH_116'), unit('second', 'ASH_116', 'enemy')], [{ code: 'SEC_155' }], { youFirst, drawOwn: 1, drawEnemy: 1 })), sc('ant-combat-mutual-death', [unit('first', 'ASH_116', 'own', 1), unit('second', 'ASH_116', 'enemy', 1)], [{ from: 'first', code: 'ASH_116', target: 'second' }], { drawOwn: 1, drawEnemy: 1 })];
scenarios.push({ ...sc('pryce-nested-sacrifice-ant', [unit('first', 'SEC_136'), unit('second', 'ASH_116')], [{ code: 'SOR_077', target: 'first' }]), assertAfter: c => { assert.equal(c.targets.first.zoneName, 'discard'); assert.equal(c.targets.second.zoneName, 'discard'); assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand); assert.equal(c.enemy.base.damage, 4); c.observed.nestedDrawAndBaseDamage = true; } });
for (const decline of [false, true])
    scenarios.push({ ...sc('pryce-' + (decline ? 'pass' : 'no-friendly-target'), [unit('first', 'SEC_136'), ...(decline ? [unit('second', 'ASH_116')] : [])], [{ code: 'SOR_077', target: 'first' }], { decline }), assertAfter: c => {
            assert.equal(c.targets.first.zoneName, 'discard');
            if (decline)
                assert.equal(c.targets.second.zoneName, 'groundArena');
            assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - 1);
            assert.equal(c.enemy.base.damage, 0);
        } });
for (const owner of ['own', 'enemy'])
    scenarios.push({ ...sc('commando-secondary-ant-death-' + owner, [unit('first', 'JTL_060'), unit('second', 'ASH_116', owner, 1)], [{ code: 'SOR_077', target: 'first' }]), assertAfter: c => { assert.equal(c.targets.first.zoneName, 'discard'); assert.equal(c.targets.second.zoneName, 'discard'); assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - 1 + (owner === 'own' ? 1 : 0)); assert.equal(c.enemy.getCardsInZone('hand').length, c.scratch.enemyHand + (owner === 'enemy' ? 1 : 0)); c.observed.secondaryStatDeathDraw = true; } });
scenarios.push({ ...sc('ant-phase-hp-expiry-draw', [unit('first', 'ASH_116', 'own', 1)], [{ code: 'LOF_126', target: 'first' }, { code: 'JTL_140' }]), assertAfter: c => { assert.equal(c.targets.first.zoneName, 'groundArena'); assert.equal(c.targets.first.damage, 2); assert.equal(c.targets.first.getHp(), 5); c.observed.aliveWithPhaseBonus = true; }, assertLater: c => { assert.equal(c.targets.first.zoneName, 'discard'); assert.ok([...c.own.getCardsInZone('hand'), ...c.own.getCardsInZone('resource')].some(x => c.eg.cardId(x.uuid) === c.scratch.drawDeck[0])); assert.equal(c.own.drawDeck.length, c.scratch.drawDeck.length - 3, 'Death draw plus two regroup draws'); c.observed.expiryDeathAndTopDeckDraw = true; } });
scenarios.push({ ...sc('different-title-death-sources', [unit('first', 'JTL_060', 'own', 1), unit('second', 'ASH_116', 'own', 1)], [{ code: 'JTL_140' }]), assertAfter: c => { assert.equal(c.targets.first.zoneName, 'discard'); assert.equal(c.targets.second.zoneName, 'discard'); assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand); } });
for (const defeatIncoming of [false, true])
    scenarios.push({ ...sc('pryce-unique-replacement-defeat-' + (defeatIncoming ? 'incoming' : 'old'), [unit('first', 'SEC_136'), unit('second', 'ASH_116')], [{ code: 'SEC_136' }]), choose: c => {
            if (c.actions.some(a => a.cardUuid === c.targets.first.uuid) && c.actions.some(a => a.cardUuid === c.scratch.incoming.uuid)) {
                c.observed.uniqueBothCopiesOffered = true;
                return c.actions.find(a => a.cardUuid === (defeatIncoming ? c.scratch.incoming : c.targets.first).uuid);
            }
            return choose(c);
        }, assertAfter: c => { assert.ok(c.observed.uniqueBothCopiesOffered); assert.equal(c.targets.first.zoneName, defeatIncoming ? 'groundArena' : 'discard'); assert.equal(c.scratch.incoming.zoneName, defeatIncoming ? 'discard' : 'groundArena'); assert.equal(c.targets.second.zoneName, 'discard'); assert.equal(c.enemy.base.damage, 4); assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand); } });
for (const defeatIncoming of [false, true])
    scenarios.push({ ...sc('highsinger-unique-defeat-' + (defeatIncoming ? 'incoming' : 'old') + '-preserves-play', [unit('first', 'LAW_059'), unit('second', 'ASH_116')], [{ code: 'LAW_059' }]), choose: c => {
            const a = c.actions, t = c.eg.player(c.pid).currentPrompt().menuTitle;
            c.observed.menus ??= [];
            c.observed.menus.push({ actor: c.eg.seatOf(c.pid), title: t, actions: a.map(x => canonicalAction(c.eg, x)) });
            if (a.some(x => x.cardUuid === c.targets.first.uuid) && a.some(x => x.cardUuid === c.scratch.incoming.uuid)) {
                c.observed.uniqueBothCopiesOffered = true;
                return a.find(x => x.cardUuid === (defeatIncoming ? c.scratch.incoming : c.targets.first).uuid);
            }
            if (t === 'Give an Experience token to another friendly Command unit')
                return a.find(x => x.cardUuid === c.targets.second.uuid);
            if (t === 'Give an Experience token to a friendly Aggression unit')
                return a.find(x => x.cardUuid === (defeatIncoming ? c.targets.first : c.scratch.incoming).uuid);
            return a.find(x => x.kind === 'button' && x.arg === '0');
        }, assertAfter: c => { assert.ok(c.observed.uniqueBothCopiesOffered); assert.equal(c.targets.first.zoneName, defeatIncoming ? 'groundArena' : 'discard'); assert.equal(c.scratch.incoming.zoneName, defeatIncoming ? 'discard' : 'groundArena'); assert.equal(c.targets.second.upgrades.filter(x => x.internalName === 'experience').length, 1); assert.equal((defeatIncoming ? c.targets.first : c.scratch.incoming).upgrades.filter(x => x.internalName === 'experience').length, 1); assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - 1); c.observed.enterSurvivedUniqueDeathWindow = true; } });
scenarios.push({ ...sc('lethal-overwhelm-tauntaun-heal-cannot-rescue', [unit('first', 'LOF_164'), unit('second', 'IBH_015', 'enemy')], [{ from: 'first', code: 'LOF_164', target: 'second' }]), baseDamage: 29, choose: c => { const title = c.eg.player(c.pid).currentPrompt().menuTitle; assert.equal(title, 'Choose a target for attack', 'No death heal prompt may appear after lethal attack'); c.observed.onlyAttackTargetPrompt = true; return c.actions.find(a => a.cardUuid === c.targets.second.uuid); }, assertAfter: c => { assert.equal(c.eg.winner, 'p1'); assert.equal(c.targets.second.zoneName, 'discard'); assert.equal(c.enemy.base.damage, 28, 'Engine auto-resolves death heal after latching winner'); assert.equal(c.targets.first.damage, 2); assert.equal(c.targets.first.zoneName, 'groundArena'); assert.ok(c.observed.onlyAttackTargetPrompt); c.observed.lethalOverwhelmWinner = 'p1'; c.observed.tauntaunHealPromptNotOffered = true; c.observed.tauntaunAutoHealAfterVictory = true; } });
for (const decline of [false, true])
    scenarios.push({ ...sc('pryce-sacrifice-shuttle-continuation-before-' + (decline ? 'pass' : 'trigger'), [unit('first', 'SEC_136'), unit('second', 'JTL_063')], [{ code: 'SOR_077', target: 'first' }], { decline }), choose: c => {
            const title = c.eg.player(c.pid).currentPrompt().menuTitle;
            if (title === 'You may trigger this ability') {
                assert.equal(c.enemy.base.damage, 4, 'Parent ifYouDo damage precedes sacrificed shuttle optional trigger');
                c.observed.parentDamageBeforeChildTrigger = true;
                assert.deepEqual(c.actions.map(a => [a.kind, a.arg, a.label]), [['button', 'trigger', 'Trigger'], ['button', 'pass', 'Pass']]);
                return c.actions.find(a => a.arg === (decline ? 'pass' : 'trigger'));
            }
            if (title === 'Defeat a unit with 5 or less remaining HP')
                return c.actions.find(a => a.cardUuid === c.targets.first.uuid);
            const sacrifice = c.actions.find(a => a.cardUuid === c.targets.second.uuid);
            return sacrifice ?? choose(c);
        }, assertAfter: c => { assert.equal(c.targets.first.zoneName, 'discard'); assert.equal(c.targets.second.zoneName, 'discard'); assert.equal(c.enemy.base.damage, 4); assert.ok(c.observed.parentDamageBeforeChildTrigger); assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - (decline ? 1 : 0)); } });
scenarios.push({ ...sc('lethal-overwhelm-optional-commando-death', [unit('first', 'LOF_164'), unit('second', 'JTL_060', 'enemy')], [{ from: 'first', code: 'LOF_164', target: 'second' }]), baseDamage: 29, choose: c => { assert.equal(c.eg.player(c.pid).currentPrompt().menuTitle, 'Choose a target for attack'); return c.actions.find(a => a.cardUuid === c.targets.second.uuid); }, assertAfter: c => { assert.equal(c.eg.winner, 'p1'); assert.equal(c.targets.second.zoneName, 'discard'); assert.equal(c.enemy.base.damage, 30); c.observed.terminalPrompts = c.eg.ids.map(pid => ({ actor: c.eg.seatOf(pid), title: c.eg.player(pid).currentPrompt().menuTitle, actions: c.eg.legalActions(pid).map(a => canonicalAction(c.eg, a)) })); c.observed.attackerHp = c.targets.first.getHp(); assert.equal(c.targets.first.getHp(), 5); } });
for (const family of ['nested-then', 'sequential'])
    for (const decline of [false, true]) {
        const base = sc('SYNTHETIC-' + family + '-defeat-order-' + (decline ? 'pass' : 'trigger'), [unit('first', 'ASH_261'), unit('second', 'ASH_116'), unit('third', 'JTL_063')], [{ from: 'first', code: 'ASH_261' }]);
        scenarios.push({ ...base, family: 'SYNTHETIC-explicit-defeat-eventwindow-diagnostic', diagnosticOnly: true, beforeApply: c => {
                base.beforeApply(c);
                if (!c.scratch.registered && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card') {
                    const h = require('../../../../forceteki/build/server/game/AbilityHelper').getAbilityHelper(c.eg.game), properties = { title: 'SYNTHETIC ' + family + ' defeat ANT then Landing Shuttle', when: { onAttack: true } };
                    if (family === 'nested-then') {
                        properties.immediateEffect = h.immediateEffects.defeat({ target: c.targets.second });
                        properties.then = { title: 'SYNTHETIC nested child explicitly defeats Shuttle', immediateEffect: h.immediateEffects.defeat({ target: c.targets.third }) };
                    }
                    else
                        properties.immediateEffect = h.immediateEffects.sequential([h.immediateEffects.defeat({ target: c.targets.second }), h.immediateEffects.defeat({ target: c.targets.third })]);
                    c.targets.first.addGainedTriggeredAbility(properties);
                    c.scratch.registered = true;
                }
            }, choose: c => {
                const title = c.eg.player(c.pid).currentPrompt().menuTitle;
                c.observed.menus ??= [];
                c.observed.menus.push({ actor: c.eg.seatOf(c.pid), title, hand: c.own.getCardsInZone('hand').length, actions: c.actions.map(a => canonicalAction(c.eg, a)) });
                if (title === 'Choose a target for attack')
                    return c.actions.find(a => a.cardUuid === c.enemy.base.uuid);
                if (title === 'You have multiple triggers to resolve. Choose which to resolve first:') {
                    assert.deepEqual(c.actions.map(a => [a.kind, a.arg, a.label]), [['button', '0', 'Draw a card'], ['button', '1', 'Draw a card']]);
                    c.observed.outerAndChildDeathTriggersShareWindow = true;
                    return c.actions.find(a => a.arg === '1');
                }
                assert.equal(title, 'You may trigger this ability');
                assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand, 'Outer ANT draw timing distinguishes nested child from sequential sibling');
                assert.equal(c.targets.second.zoneName, 'discard');
                assert.equal(c.targets.third.zoneName, 'discard');
                assert.deepEqual(c.actions.map(a => [a.kind, a.arg, a.label]), [['button', 'trigger', 'Trigger'], ['button', 'pass', 'Pass']]);
                c.observed.outerDrawTimingAtChildPrompt = 'still pending (shared parent attack window)';
                return c.actions.find(a => a.arg === (decline ? 'pass' : 'trigger'));
            }, assertAfter: c => { assert.equal(c.targets.second.zoneName, 'discard'); assert.equal(c.targets.third.zoneName, 'discard'); assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand + (decline ? 1 : 2)); assert.ok(c.observed.outerDrawTimingAtChildPrompt); } });
    }
for (const family of ['nested-then', 'sequential'])
    for (const decline of [false, true]) {
        const base = sc('SYNTHETIC-event-' + family + '-defeat-order-' + (decline ? 'pass' : 'trigger'), [unit('first', 'ASH_261'), unit('second', 'ASH_116'), unit('third', 'JTL_063')], [{ code: 'SOR_077' }]);
        scenarios.push({ ...base, family: 'SYNTHETIC-explicit-defeat-eventwindow-diagnostic', diagnosticOnly: true, beforeApply: c => {
                base.beforeApply(c);
                if (!c.scratch.registered && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card') {
                    const h = require('../../../../forceteki/build/server/game/AbilityHelper').getAbilityHelper(c.eg.game), properties = { title: 'SYNTHETIC event ' + family + ' defeat ANT then Landing Shuttle' };
                    if (family === 'nested-then') {
                        properties.immediateEffect = h.immediateEffects.defeat({ target: c.targets.second });
                        properties.then = { title: 'SYNTHETIC nested child explicitly defeats Shuttle', immediateEffect: h.immediateEffects.defeat({ target: c.targets.third }) };
                    }
                    else
                        properties.immediateEffect = h.immediateEffects.sequential([h.immediateEffects.defeat({ target: c.targets.second }), h.immediateEffects.defeat({ target: c.targets.third })]);
                    c.scratch.incoming.setEventAbility(properties);
                    c.scratch.registered = true;
                }
            }, choose: c => {
                const title = c.eg.player(c.pid).currentPrompt().menuTitle;
                c.observed.menus ??= [];
                c.observed.menus.push({ actor: c.eg.seatOf(c.pid), title, hand: c.own.getCardsInZone('hand').length, actions: c.actions.map(a => canonicalAction(c.eg, a)) });
                if (title === 'You have multiple triggers to resolve. Choose which to resolve first:') {
                    c.observed.sharedWindow = true;
                    return c.actions.find(a => a.arg === '1');
                }
                assert.equal(title, 'You may trigger this ability');
                assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - 1, 'Event context deaths wait in shared parent window');
                c.observed.outerDrawTimingAtChildPrompt = 'still pending in shared event window';
                return c.actions.find(a => a.arg === (decline ? 'pass' : 'trigger'));
            }, assertAfter: c => { assert.equal(c.targets.second.zoneName, 'discard'); assert.equal(c.targets.third.zoneName, 'discard'); assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand + (decline ? 0 : 1)); assert.ok(c.observed.outerDrawTimingAtChildPrompt); } });
    }
for (const youFirst of [false, true])
    scenarios.push({ ...sc('phase-expiry-both-shuttles-initiative-opposite-final-passer-' + (youFirst ? 'you' : 'opponent') + '-first', [unit('first', 'JTL_063', 'own', 3), unit('second', 'JTL_063', 'enemy', 3)], [{ code: 'TWI_124', target: 'first' }, { code: 'TWI_124', target: 'second' }, { code: 'JTL_140' }], { initiative: 'enemy' }), phaseWitness: true, beforeApply: c => {
            if (c.atWindow && c.pid === c.own.id && c.scratch.hand === undefined) {
                c.scratch.hand = c.own.getCardsInZone('hand').length;
                c.scratch.enemyHand = c.enemy.getCardsInZone('hand').length;
                c.scratch.round = c.eg.round;
            }
            if (c.observed.postAction && c.atWindow && c.chosen.arg === 'pass' && c.eg.round === c.scratch.round)
                c.scratch.finalPasser = c.eg.seatOf(c.pid);
        }, assertAfter: c => { assert.equal(c.targets.first.zoneName, 'spaceArena'); assert.equal(c.targets.second.zoneName, 'spaceArena'); assert.equal(c.targets.first.getHp(), 6); assert.equal(c.targets.second.getHp(), 6); assert.equal(c.targets.first.damage, 4); assert.equal(c.targets.second.damage, 4); c.observed.bothAliveWithPhaseHp = true; }, chooseLater: c => {
            const title = c.eg.player(c.pid).currentPrompt().menuTitle;
            if (title === 'Both players have triggered abilities in response. Choose a player to resolve all of their abilities first:') {
                assert.equal(c.pid, c.enemy.id, 'Initiative holder chooses after phase expiry');
                assert.equal(c.scratch.finalPasser, 'p1');
                assert.equal(c.own.hasInitiative(), false);
                assert.deepEqual(c.actions.map(a => [a.kind, a.arg, a.label]), [['button', 0, 'You'], ['button', 1, 'Opponent']]);
                assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - 3);
                assert.equal(c.enemy.getCardsInZone('hand').length, c.scratch.enemyHand);
                assert.equal(c.targets.first.zoneName, 'discard');
                assert.equal(c.targets.second.zoneName, 'discard');
                c.observed.phaseOrder = { actor: c.eg.seatOf(c.pid), finalPasser: c.scratch.finalPasser, phase: c.eg.phase, round: c.eg.round };
                return c.actions.find(a => a.label === (youFirst ? 'You' : 'Opponent'));
            }
            if (title === 'You may trigger this ability' && c.observed.phaseOrder && !c.observed.expiryOptionalFinished) {
                assert.equal(c.eg.round, c.observed.phaseOrder.round);
                assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - 3);
                assert.equal(c.enemy.getCardsInZone('hand').length, c.scratch.enemyHand);
                c.observed.expiryOptionalActors ??= [];
                c.observed.expiryOptionalActors.push(c.eg.seatOf(c.pid));
                if (c.observed.expiryOptionalActors.length === 2)
                    c.observed.expiryOptionalFinished = true;
                return c.actions.find(a => a.arg === 'pass');
            }
        }, assertLater: c => { assert.ok(c.observed.bothAliveWithPhaseHp); assert.ok(c.observed.phaseOrder); assert.deepEqual(c.observed.expiryOptionalActors, youFirst ? ['p2', 'p1'] : ['p1', 'p2']); assert.equal(c.targets.first.zoneName, 'discard'); assert.equal(c.targets.second.zoneName, 'discard'); c.observed.regroupAdvancedOnlyAfterBothDeathPrompts = true; } });
module.exports = { scenarios, fixture };
module.exports.fixture = (env, pool, scenario, seed) => (scenario.phaseWitness ? require('./unit-tokens').tokenFixture : fixture)(env, pool, scenario, seed);
