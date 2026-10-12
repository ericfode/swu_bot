'use strict';
// Actual-pool attack selection and additional source-derived witnesses.
// Root-authored after Sol worker usage exhaustion; not a low-effort skill trial.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Env } = require('../../../env');
const { loadPool } = require('../../../omni/rs/pool');
const { fixture } = require('./upgrades');
const { scenarios: attackScenarios } = require('./attack-context');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const unit = (key, code, owner = 'own', shields = 0) => ({ key, code, owner, shields });
const excluded = [
    { scenario: 'scion-defender-hp-threshold-death-before-combat', code: 'ASH_046', reason: 'Support is not implemented; whole card remains rejected.' },
    { scenario: 'exogorth-associated-defender-not-opponent-wide', code: 'HMW_233', reason: 'Hidden is not implemented; whole card remains rejected.' },
    { scenario: 'exogorth-raid-retained-during-corona-death-selector', code: 'HMW_233', reason: 'Hidden is not implemented; replacement witness uses admitted Clone Dive Trooper.' },
];
const extras = [{
    name: 'clone-raid-retained-during-skyway-death-selector',
    family: 'active-attack-during-different-source-nested-death',
    actualScriptedCardIds: ['LAW_182', 'TWI_205'],
    actualTriggeredCardIds: ['LAW_182', 'JTL_220'],
    units: [unit('attacker', 'TWI_205', 'own', 1), unit('raidSource', 'LAW_182'), unit('friend', 'ASH_261'), unit('prepVictim', 'HMW_082', 'enemy'), unit('defender', 'JTL_220', 'enemy')],
    baseDamage: 0,
    plan: [{ code: 'LAW_182', from: 'raidSource', target: 'prepVictim' }, { code: 'TWI_205', from: 'attacker', target: 'defender' }],
    choose(c) {
        const title = c.eg.player(c.pid).currentPrompt().menuTitle ?? '';
        if (title === 'Choose a target for attack') return c.actions.find(a => a.cardUuid === c.targets[c.pending.from === 'raidSource' ? 'prepVictim' : 'defender'].uuid);
        if (/Give Raid 2/.test(title)) return c.actions.find(a => a.cardUuid === c.targets.attacker.uuid);
        if (title === "Return a non-leader unit with 2 or less power to its owner's hand") {
            assert.equal(c.pid, c.enemy.id);
            assert.equal(c.targets.defender.zoneName, 'discard');
            assert.equal(c.targets.attacker.isAttacking(), true);
            assert.equal(c.targets.attacker.getPower(), 4);
            assert.equal(c.targets.attacker.getNumericKeywordTotal('raid'), 2);
            assert.equal(c.targets.attacker.damage, 0);
            assert.equal(c.targets.attacker.upgrades.length, 0);
            const eligible = c.actions.filter(a => a.kind === 'card').map(a => a.cardUuid);
            assert.ok(!eligible.includes(c.targets.attacker.uuid));
            assert.ok(eligible.includes(c.targets.prepVictim.uuid));
            c.observed.nestedDeathRetainedRaidAndAttack = true;
            c.observed.nestedEligibleIds = eligible.map(id => c.eg.cardId(id));
            const skip = c.actions.find(a => a.arg === 'passAbility');
            assert.ok(skip);
            return skip;
        }
    },
    assertAfter(c) {
        assert.ok(c.observed.nestedDeathRetainedRaidAndAttack);
        assert.equal(c.targets.attacker.zoneName, 'groundArena');
        assert.equal(c.targets.attacker.isAttacking(), false);
        assert.equal(c.targets.attacker.getPower(), 2);
        assert.equal(c.targets.friend.damage, 0);
        c.observed.powerReturnedAtCleanup = true;
    },
}, {
    name: 'shaak-token-unit-owner-entry-and-source-leave',
    family: 'friendly-token-unit-aura-plus-on-attack-create',
    actualScriptedCardIds: ['TWI_094', 'TWI_226'],
    actualTriggeredCardIds: ['TWI_094'],
    units: [unit('ownShaak', 'TWI_094'), unit('enemyShaak', 'TWI_094', 'enemy'), unit('nonToken', 'HMW_082', 'own', 1)],
    baseDamage: 0,
    plan: [{ code: 'TWI_094', from: 'ownShaak', target: 'enemyBase' }, { code: 'TWI_094', from: 'enemyShaak', actor: 'enemy', target: 'ownBase' }, { code: 'TWI_226', target: 'ownShaak' }],
    beforeApply(c) {
        if (c.observed.postAction || !c.atWindow || c.chosen.kind !== 'card' || c.pending?.code !== 'TWI_226') return;
        const own = c.own.getArenaUnits().filter(x => x.internalName === 'clone-trooper');
        const enemy = c.enemy.getArenaUnits().filter(x => x.internalName === 'clone-trooper');
        assert.equal(own.length, 1); assert.equal(enemy.length, 1);
        for (const token of [...own, ...enemy]) { assert.equal(token.getPower(), 3); assert.equal(token.getHp(), 2); assert.equal(token.exhausted, true); }
        assert.equal(c.targets.nonToken.getPower(), 1);
        c.scratch.ownClone = own[0]; c.scratch.enemyClone = enemy[0];
        c.observed.createdCloneIds = [...own, ...enemy].map(x => c.eg.cardId(x.uuid));
        c.observed.createdClonesExhaustedAndBuffed = true;
    },
    assertAfter(c) {
        assert.ok(c.observed.createdClonesExhaustedAndBuffed);
        assert.equal(c.targets.ownShaak.zoneName, 'hand');
        assert.equal(c.targets.enemyShaak.zoneName, 'groundArena');
        assert.equal(c.scratch.ownClone.getPower(), 2);
        assert.equal(c.scratch.enemyClone.getPower(), 3);
        assert.equal(c.targets.nonToken.getPower(), 1);
        c.observed.ownerFilteredLiveAura = true;
    },
}];
module.exports = { scenarios: extras, fixture };
