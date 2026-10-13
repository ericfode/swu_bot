'use strict';
// Additional actual-source witnesses for incidental admissions; no count claims.
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { Env } = require('../../../env'), { loadPool } = require('../../../omni/rs/pool'), { canonicalAction } = require('../../../omni/rs/state'), { tokenFixture: fixture } = require('./unit-tokens');
const unit = (key, code, owner = 'own', damage = 0) => ({ key, code, owner, damage });
function initial(c) {
    if (!c.observed.postAction && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card' && c.scratch.hand === undefined) {
        c.scratch.hand = c.own.getCardsInZone('hand').length;
        c.scratch.deck = c.own.drawDeck.map(x => c.eg.cardId(x.uuid));
        c.scratch.next = c.eg.game.state.allCards.length;
    }
}
const scenarios = [];
for (const damaged of [false, true])
    scenarios.push({ name: 'growth-beast-draw-' + (damaged ? 'actual-heal' : 'full-health-zero-heal'), family: 'group-token-heal-draw', actualScriptedCardIds: ['HMW_272'], units: [], baseDamage: damaged ? 3 : 0, plan: [{ code: 'HMW_272' }], beforeApply: initial, assertAfter: c => { assert.equal(c.own.base.damage, 0); assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand); assert.equal(c.own.drawDeck.length, c.scratch.deck.length - 1); assert.ok(c.own.getCardsInZone('hand').some(x => c.eg.cardId(x.uuid) === c.scratch.deck[0])); assert.equal(c.eg.game.state.allCards.length, c.scratch.next + 1); const token = c.eg.game.findAnyCardInAnyList(c.eg.game.state.allCards[c.scratch.next]); assert.equal(token.internalName, 'beast'); assert.equal(token.zoneName, 'groundArena'); assert.equal(token.getPower(), 3); assert.equal(token.getHp(), 3); assert.equal(token.exhausted, true); assert.equal(token.owner.id, c.own.id); c.observed.beastId = c.eg.cardId(token.uuid); c.observed.actualHeal = damaged ? 3 : 0; c.observed.actualDraw = 1; } });
for (const target of [false, true])
    scenarios.push({ name: 'knowledge-defense-' + (target ? 'stat-modifier-and-draw' : 'no-unit-still-draw'), family: 'group-phase-stats-draw', actualScriptedCardIds: ['SEC_075'], units: target ? [unit('target', 'ASH_261')] : [], baseDamage: 0, plan: [{ code: 'SEC_075' }], beforeApply: initial, choose: c => { assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - 1, 'Nested selection before group draw'); assert.ok(c.actions.some(a => a.cardUuid === c.targets.target.uuid)); c.observed.selectionBeforeDraw = true; c.observed.targetMenu = c.actions.map(a => canonicalAction(c.eg, a)); return c.actions.find(a => a.cardUuid === c.targets.target.uuid); }, assertAfter: c => {
            assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand);
            assert.equal(c.own.drawDeck.length, c.scratch.deck.length - 1);
            assert.ok(c.own.getCardsInZone('hand').some(x => c.eg.cardId(x.uuid) === c.scratch.deck[0]));
            if (target) {
                assert.ok(c.observed.selectionBeforeDraw);
                assert.equal(c.targets.target.getHp(), 2);
                assert.equal(c.targets.target.getPower(), 1);
            }
            else
                assert.ok(!c.observed.selectionBeforeDraw);
            c.observed.actualDraw = 1;
        }, ...(target ? { assertLater: c => { assert.equal(c.targets.target.getHp(), 4); assert.equal(c.targets.target.getPower(), 3); c.observed.phaseModifierExpired = true; } } : {}) });
for (const targetKind of ['force', 'non-force', 'none'])
    scenarios.push({ name: 'obiwan-death-two-experience-' + targetKind, family: 'death-targeted-group-tokens-conditional-draw', actualScriptedCardIds: ['SOR_049'], units: [unit('source', 'SOR_049', 'own', 1), ...(targetKind === 'none' ? [] : [unit('target', targetKind === 'force' ? 'HMW_128' : 'ASH_261')]), unit('enemyForce', 'HMW_128', 'enemy')], baseDamage: 0, plan: [{ code: 'SOR_077', target: 'source' }], beforeApply: initial, choose: c => {
            const title = c.eg.player(c.pid).currentPrompt().menuTitle;
            if (title === 'Defeat a unit with 5 or less remaining HP')
                return c.actions.find(a => a.cardUuid === c.targets.source.uuid);
            assert.ok(!c.actions.some(a => a.cardUuid === c.targets.source.uuid));
            assert.ok(!c.actions.some(a => a.cardUuid === c.targets.enemyForce.uuid));
            assert.deepEqual(c.actions.filter(a => a.kind === 'card').map(a => a.cardUuid), [c.targets.target.uuid]);
            assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - 1);
            assert.equal(c.eg.game.state.allCards.length, c.scratch.next, 'No Experience or draw before chosen target');
            c.observed.friendlyTargetOnlyBeforeGroup = true;
            return c.actions.find(a => a.cardUuid === c.targets.target.uuid);
        }, assertAfter: c => {
            assert.equal(c.targets.source.zoneName, 'discard');
            assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - 1 + (targetKind === 'force' ? 1 : 0));
            assert.equal(c.own.drawDeck.length, c.scratch.deck.length - (targetKind === 'force' ? 1 : 0));
            if (targetKind === 'none') {
                assert.equal(c.eg.game.state.allCards.length, c.scratch.next);
                assert.ok(!c.observed.friendlyTargetOnlyBeforeGroup);
            }
            else {
                assert.ok(c.observed.friendlyTargetOnlyBeforeGroup);
                const tokens = c.targets.target.upgrades.filter(x => x.internalName === 'experience');
                assert.equal(tokens.length, 2);
                assert.deepEqual(tokens.map(x => c.eg.cardId(x.uuid)), ['c' + c.scratch.next, 'c' + (c.scratch.next + 1)]);
                assert.equal(c.targets.target.getHp(), targetKind === 'force' ? 7 : 6);
                assert.equal(c.targets.target.getPower(), targetKind === 'force' ? 6 : 5);
            }
            c.observed.experienceCount = targetKind === 'none' ? 0 : 2;
            c.observed.actualDraw = targetKind === 'force' ? 1 : 0;
        } });
scenarios.push({ name: 'growth-heal-before-empty-deck-fatigue-survives', family: 'group-heal-draw-fatigue-order', actualScriptedCardIds: ['HMW_272'], units: [], emptyOwnDeck: true, baseDamage: 29, plan: [{ code: 'HMW_272' }], beforeApply: initial, assertAfter: c => { assert.equal(c.scratch.deck.length, 0); assert.equal(c.own.drawDeck.length, 0); assert.equal(c.own.base.damage, 29, 'Heal3 precedes fatigue3; reverse order would latch lethal base damage'); assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand - 1, 'Empty draw adds no card'); assert.equal(c.eg.over, false, 'Fatigue cannot latch a loss before the earlier group heal'); assert.equal(c.eg.game.state.allCards.length, c.scratch.next + 1); const token = c.eg.game.findAnyCardInAnyList(c.eg.game.state.allCards[c.scratch.next]); assert.equal(token.internalName, 'beast'); assert.equal(token.zoneName, 'groundArena'); c.observed.heal3BeforeFatigue3 = true; c.observed.beastCreatedAndNoPrematureWinner = true; } });
module.exports = { scenarios, fixture };
