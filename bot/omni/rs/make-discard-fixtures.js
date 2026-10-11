'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { Env } = require('../../env'), { loadPool } = require('./pool'), { canonicalAction } = require('./state'), { tokenFixture: fixture } = require('./make-token-unit-fixtures');
const unit = (key, code, owner = 'own') => ({ key, code, owner });
function initial(c) {
    if (!c.observed.postAction && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card' && c.scratch.hand === undefined) {
        c.scratch.hand = c.own.getCardsInZone('hand').length;
        c.scratch.enemyHand = c.enemy.getCardsInZone('hand').length;
        c.scratch.next = c.eg.game.state.allCards.length;
        c.scratch.deck = c.own.drawDeck.map(x => c.eg.cardId(x.uuid));
    }
}
function choices(c) {
    const title = c.eg.player(c.pid).currentPrompt().menuTitle;
    c.observed.menus ??= [];
    c.observed.menus.push({ actor: c.eg.seatOf(c.pid), title, ownHand: c.own.getCardsInZone('hand').length, enemyHand: c.enemy.getCardsInZone('hand').length, actions: c.actions.map(a => canonicalAction(c.eg, a)) });
    if (title === 'Choose a target for attack')
        return c.actions.find(a => a.cardUuid === c.enemy.base.uuid);
    if (title === 'Defeat a unit with 5 or less remaining HP')
        return c.actions.find(a => a.cardUuid === c.targets.source.uuid);
    if (c.actions.some(a => a.arg === 'trigger'))
        return c.actions.find(a => a.arg === (c.scratch.decline ? 'pass' : 'trigger'));
    const cards = c.actions.filter(a => a.kind === 'card');
    if (cards.length) {
        const hand = c.eg.player(c.pid).getCardsInZone('hand');
        assert.deepEqual(c.actions.map(a => a.kind), hand.map(() => 'card'), 'Amount1 discard has only hand cards, no Done or Cancel');
        assert.deepEqual(cards.map(a => a.cardUuid).sort(), hand.map(x => x.uuid).sort(), 'Complete owner-hand menu');
        if (c.scratch.simultaneous) {
            assert.equal(c.pid, c.enemy.id);
            assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - 1, 'Draw does not execute before opponent discard choice');
            c.observed.choiceBeforeSimultaneousDraw = true;
        }
        if (c.scratch.drawBeforeDiscard)
            assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - c.scratch.played + c.scratch.drawBeforeDiscard, 'Draw precedes own discard choice');
        c.observed.discardChooser = c.eg.seatOf(c.pid);
        c.observed.discardMenu = true;
        c.scratch.selectedDiscard = c.eg.cardId(cards[0].cardUuid);
        return cards[0];
    }
    return c.actions.find(a => a.arg === 'done');
}
function sc(name, code, opt = {}) {
    return { name, actualScriptedCardIds: [code], family: 'scalar-owner-hand-discard', units: opt.units ?? [], baseDamage: 0, emptyOwnHand: !!opt.empty, plan: opt.attack ? [{ from: 'source', code }] : opt.death ? [{ code: 'SOR_077', target: 'source' }] : [{ code }], beforeApply: c => { initial(c); Object.assign(c.scratch, { decline: !!opt.decline, simultaneous: !!opt.simultaneous, drawBeforeDiscard: opt.drawBeforeDiscard ?? 0, played: opt.attack ? 0 : 1 }); }, choose: choices, assertAfter: c => {
            assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand + (opt.ownDelta ?? 0));
            assert.equal(c.enemy.getCardsInZone('hand').length, c.scratch.enemyHand + (opt.enemyDelta ?? 0));
            if (opt.discards) {
                assert.ok(c.observed.discardMenu);
                const owner = opt.enemyDelta ? c.enemy : c.own;
                assert.ok(owner.getCardsInZone('discard').some(x => c.eg.cardId(x.uuid) === c.scratch.selectedDiscard), 'Chosen owner hand card discarded');
            }
            else
                assert.ok(!c.observed.discardMenu);
            if (opt.simultaneous)
                assert.ok(c.observed.choiceBeforeSimultaneousDraw);
            if (opt.spy) {
                const uuid = c.eg.game.state.allCards[c.scratch.next], token = c.eg.game.findAnyCardInAnyList(uuid);
                assert.equal(c.eg.cardId(uuid), 'c' + c.scratch.next);
                assert.equal(token.internalName, 'spy');
                assert.equal(token.zoneName, 'groundArena');
            }
            if (opt.empty) {
                assert.equal(c.own.drawDeck.length, c.scratch.deck.length, 'No discard success means no ifYouDo draw');
                c.observed.emptyHandDidNotDraw = true;
            }
        } };
}
const scenarios = [sc('mos-espa-draw-then-discard', 'ASH_260', { discards: true, drawBeforeDiscard: 1, ownDelta: -1 }), sc('mos-espa-optional-pass', 'ASH_260', { decline: true, ownDelta: -1 }), sc('proof-draw-two-then-discard-one', 'IBH_074', { discards: true, drawBeforeDiscard: 2, ownDelta: 0 }), sc('ozzel-death-opponent-chooses-hand-discard', 'IBH_082', { death: true, units: [unit('source', 'IBH_082')], discards: true, ownDelta: -1, enemyDelta: -1 }), sc('handmaiden-attack-discard-then-draw', 'SEC_197', { attack: true, units: [unit('source', 'SEC_197')], discards: true }), sc('handmaiden-attack-optional-pass', 'SEC_197', { attack: true, units: [unit('source', 'SEC_197')], decline: true }), sc('handmaiden-empty-hand-no-if-you-do', 'SEC_197', { attack: true, units: [unit('source', 'SEC_197')], empty: true }), sc('bail-attack-discard-creates-spy', 'SEC_198', { attack: true, units: [unit('source', 'SEC_198')], discards: true, ownDelta: -1, spy: true }), sc('no-bargain-discard-choice-before-draw', 'SHD_244', { discards: true, ownDelta: 0, enemyDelta: -1, simultaneous: true })];
for (const mode of ['positive', 'pass', 'high-cost', 'source-only'])
    scenarios.push({ name: 'outland-vanguard-printed-cost-' + mode, family: 'printed-cost-target-filter', units: mode === 'source-only' ? [] : [...(mode === 'high-cost' ? [] : [unit('eligible', 'ASH_261')]), unit('tooHigh', 'ASH_061', 'enemy')], baseDamage: 0, plan: [{ code: 'SHD_082' }], beforeApply: initial, choose: c => { assert.equal(c.eg.player(c.pid).currentPrompt().menuTitle, 'Give an experience to another unit that costs 3 or less'); assert.ok(!c.actions.some(a => a.cardUuid === c.scratch.incoming.uuid), 'Incoming source excluded despite cost2'); assert.ok(!c.actions.some(a => a.cardUuid === c.targets.tooHigh?.uuid), 'Printed cost5 excluded'); assert.deepEqual(c.actions.map(a => [a.kind, a.arg, a.label]), [['button', 'passAbility', 'Pass'], ['card', undefined, 'noti-mobile-pod']]); c.observed.costThreeMenu = true; return mode === 'pass' ? c.actions.find(a => a.arg === 'passAbility') : c.actions.find(a => a.cardUuid === c.targets.eligible.uuid); }, assertAfter: c => {
            if (mode === 'positive' || mode === 'pass') {
                assert.ok(c.observed.costThreeMenu);
                assert.equal(c.targets.eligible.upgrades.filter(x => x.internalName === 'experience').length, mode === 'positive' ? 1 : 0);
                assert.equal(c.targets.eligible.getHp(), mode === 'positive' ? 5 : 4);
            }
            else
                assert.ok(!c.observed.costThreeMenu, 'No legal target prunes optional ability');
            assert.equal(c.scratch.incoming.upgrades.length, 0);
        } });
for (const opponent of [false, true])
    scenarios.push({ name: 'SYNTHETIC-discard-two-' + (opponent ? 'opponent' : 'own') + '-hand', family: 'SYNTHETIC-owner-hand-amount-two-diagnostic', diagnosticOnly: true, units: [], baseDamage: 0, plan: [{ code: 'SOR_077' }], beforeApply: c => {
            initial(c);
            if (!c.scratch.registered && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card') {
                const h = require('../../../forceteki/build/server/game/AbilityHelper').getAbilityHelper(c.eg.game);
                c.scratch.incoming.setEventAbility({ title: 'SYNTHETIC discard two owner-hand cards', immediateEffect: h.immediateEffects.discardCardsFromOwnHand({ amount: 2, target: opponent ? c.enemy : c.own }) });
                c.scratch.registered = true;
            }
        }, choose: c => {
            assert.equal(c.pid, (opponent ? c.enemy : c.own).id);
            const title = c.eg.player(c.pid).currentPrompt().menuTitle, selected = c.eg.player(c.pid).promptState.selectedCards ?? [];
            c.observed.menus ??= [];
            c.observed.menus.push({ actor: c.eg.seatOf(c.pid), title, selected: selected.map(x => c.eg.cardId(x.uuid)), actions: c.actions.map(a => canonicalAction(c.eg, a)) });
            if (selected.length === 2) {
                assert.deepEqual(c.actions.filter(a => a.kind === 'button').map(a => [a.arg, a.label]), [['done', 'Done']]);
                assert.deepEqual(c.actions.filter(a => a.kind === 'card').map(a => a.cardUuid).sort(), selected.map(x => x.uuid).sort());
                return c.actions.find(a => a.arg === 'done');
            }
            assert.ok(c.actions.every(a => a.kind === 'card'), 'No Done before exact quota selected');
            const choice = c.actions.find(a => a.kind === 'card' && !selected.some(x => x.uuid === a.cardUuid));
            assert.ok(choice);
            c.observed.clickedIds ??= [];
            c.observed.clickedIds.push(c.eg.cardId(choice.cardUuid));
            return choice;
        }, assertAfter: c => {
            assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - (opponent ? 1 : 3));
            assert.equal(c.enemy.getCardsInZone('hand').length, c.scratch.enemyHand - (opponent ? 2 : 0));
            assert.equal(c.observed.clickedIds.length, 2);
            for (const id of c.observed.clickedIds)
                assert.ok((opponent ? c.enemy : c.own).getCardsInZone('discard').some(x => c.eg.cardId(x.uuid) === id));
        } });
for (const code of ['LOF_194', 'TWI_208']) {
    scenarios.push(sc(code.toLowerCase() + '-death-own-hand-discard', code, { death: true, units: [unit('source', code)], discards: true, ownDelta: -2 }));
    const play = sc(code.toLowerCase() + '-played-actual-draw', code, { ownDelta: 0 });
    scenarios.push({ ...play, assertAfter: c => { play.assertAfter(c); assert.equal(c.own.drawDeck.length, c.scratch.deck.length - 1); assert.ok(c.own.getCardsInZone('hand').some(x => c.eg.cardId(x.uuid) === c.scratch.deck[0])); c.observed.actualPrintedWhenPlayedDraw = true; } });
}
scenarios.push(sc('twi148-death-opponent-hand-discard', 'TWI_148', { death: true, units: [unit('source', 'TWI_148')], discards: true, ownDelta: -1, enemyDelta: -1 }));
for (const decline of [false, true]) {
    const fatigue = sc('mos-espa-empty-deck-' + (decline ? 'optional-pass' : 'fatigue-then-discard'), 'ASH_260', {
        decline, discards: !decline, ownDelta: decline ? -1 : -2
    });
    scenarios.push({ ...fatigue, emptyOwnDeck: true, assertAfter: c => {
        fatigue.assertAfter(c);
        assert.equal(c.own.drawDeck.length, 0);
        assert.equal(c.own.base.damage, decline ? 0 : 3, 'Accepted draw resolves through fatigue with no card drawn');
        assert.equal(c.eg.over, false, 'This witness observes the completed nonlethal continuation');
        c.observed.emptyDeckDrawResolved = !decline;
        c.observed.fatigueDamage = c.own.base.damage;
        c.observed.actualCardsDrawn = 0;
        c.observed.ifYouDoDiscardAfterFatigue = !decline;
    } });
}
scenarios.push({ ...sc('mos-espa-empty-deck-lethal-fatigue-pending-discard', 'ASH_260'), emptyOwnDeck: true, baseDamage: 29,
    assertAfter: c => {
        assert.equal(c.eg.winner, 'p2');
        assert.equal(c.own.base.damage, 30, 'Lethal fatigue is capped at printed base HP');
        assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - 1, 'No external discard input is sent after the winner is latched');
        assert.ok(!c.observed.discardMenu);
        const actions = c.eg.legalActions(c.own.id);
        assert.deepEqual(actions.map(a => a.kind), c.own.getCardsInZone('hand').map(() => 'card'));
        assert.deepEqual(actions.map(a => a.cardUuid).sort(), c.own.getCardsInZone('hand').map(x => x.uuid).sort(), 'Resolved draw reaches the internal mandatory discard prompt');
        c.observed.terminalDiscardPrompt = actions.map(a => canonicalAction(c.eg, a));
        c.observed.winnerLatchedBeforeExternalDiscard = true;
        c.observed.actualCardsDrawn = 0;
    } });
async function main([poolFile, out, filter]) {
    assert.ok(poolFile && out);
    assert.ok(!fs.existsSync(out));
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(poolFile, path.join(out, 'pool.json'));
    const pool = loadPool(path.join(out, 'pool.json')), env = new Env(), witnesses = [];
    for (const [i, s] of scenarios.entries()) {
        if (s.diagnosticOnly && !filter)
            continue;
        if (filter && !s.name.includes(filter))
            continue;
        const r = await fixture(env, pool, s, 21001 + i);
        if (s.diagnosticOnly) {
            r.records[0].evidenceStatus = 'SYNTHETIC ENGINE DIAGNOSTIC; not printed-card conformance';
            r.records[0].syntheticRegistration = 'At initial script input, replace Takedown event ability with exact discardOwnHand amount2 for specified owner.';
        }
        const file = s.name + '.jsonl.gz', bytes = zlib.gzipSync(r.records.map(x => JSON.stringify(x)).join('\n') + '\n');
        fs.writeFileSync(path.join(out, file), bytes);
        witnesses.push({ ...r.witness, file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), actualScriptedCardIds: s.diagnosticOnly ? [] : s.actualScriptedCardIds ?? ['SHD_082'], sharedRelatedCardIds: [], synthetic: !!s.diagnosticOnly });
        fs.writeFileSync(path.join(out, 'discard-witnesses.json'), JSON.stringify({ evidenceStatus: pool.oracleOnly ? 'PROTOTYPE real engine' : 'real engine observations', conformance: 'unassessed; fresh native and Wasm comparison required', pool: pool.provenance, generatorSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), witnesses }, null, 2) + '\n');
        console.log(s.name);
    }
}
if (require.main === module)
    main(process.argv.slice(2)).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { main, scenarios };
