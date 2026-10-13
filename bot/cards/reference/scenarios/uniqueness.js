'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Env } = require('../../../env');
const { loadPool } = require('../../../omni/rs/pool');
const { fixture } = require('./phase-stats');
const scenarios = ['old', 'new'].map((keep) => ({
    name: `duplicate-snoke-keep-${keep}`, extraCodes: ['SHD_037'], enemyCode: 'ASH_261', constant: { code: 'SHD_037', owner: 'own' },
    uniqueKeep: keep, plan: [['SHD_037', 'own']], expectedPlayed: 'SHD_037',
    observeInitial: ({ targets, enemy }) => targets.constant.zoneName === 'groundArena' && targets.enemy.zoneName === 'groundArena' && targets.enemy.getSummary(enemy, true).hp === 2,
    observeAfter: ({ targets, enemy }) => targets.incoming && targets.enemy.zoneName === 'groundArena' && targets.enemy.getSummary(enemy, true).hp === 2 &&
        targets.constant.zoneName === (keep === 'old' ? 'groundArena' : 'discard') && targets.incoming.zoneName === (keep === 'new' ? 'groundArena' : 'discard'),
}));
scenarios.push(...['old', 'new'].map((keep) => ({
    name: `duplicate-two-hp-unit-keep-${keep}`, extraCodes: ['SHD_037', 'SOR_094'], ownCode: 'SOR_094',
    constant: { code: 'SHD_037', owner: 'enemy' }, constantInHand: true, enemyWaitForOwnPhase: true,
    uniqueKeep: keep, uniqueExistingOwn: true, plan: [['TWI_124', 'own'], ['SOR_094', 'own']], expectedPlayed: 'SOR_094',
    observeInitial: ({ targets }) => targets.own.zoneName === 'groundArena' && targets.own.cardData.hp === 2,
    observeAfter: ({ targets }) => targets.constant.zoneName === 'groundArena' && targets.incoming &&
        targets.incoming.zoneName === 'discard' && targets.own.zoneName === (keep === 'old' ? 'groundArena' : 'discard'),
})));
for (const code of ['LAW_055', 'TWI_107']) {
    const scenario = { name: `normal-${code}-under-snoke`, extraCodes: ['SHD_037', code],
        constant: { code: 'SHD_037', owner: 'enemy' }, trackIncoming: true, plan: [[code, 'own']], expectedPlayed: code };
    scenario.observeAfter = ({ targets, own }) => {
        if (!targets.incoming) return false;
        assert.equal(targets.incoming.zoneName, 'discard', 'Printed two-HP incoming unit dies under Snoke');
        const drawCount = own.getCardsInZone('hand').length - targets.handBeforePlay + 1;
        assert.equal(drawCount, code === 'TWI_107' ? 1 : 0, 'Observe enter-trigger after stat death');
        scenario.observedOutcome ??= { zone: targets.incoming.zoneName, upgrades: [], handCountBeforePlay: targets.handBeforePlay, handCountAfterPlay: own.getCardsInZone('hand').length, drawCount };
        return true;
    };
    scenarios.push(scenario);
}
scenarios.push({ name: 'duplicate-c3po-defeated-incoming-still-draws', extraCodes: ['IBH_019'], ownCode: 'IBH_019', extraOwnUnits: ['ASH_190'],
    uniqueKeep: 'old', uniqueExistingOwn: true, plan: [['IBH_019', 'own']], expectedPlayed: 'IBH_019',
    observeAfter: ({ targets, own }) => targets.incoming?.zoneName === 'discard' && targets.own.zoneName === 'groundArena' &&
        own.getCardsInZone('hand').length === targets.handBeforePlay,
});
module.exports = { scenarios, fixture };
