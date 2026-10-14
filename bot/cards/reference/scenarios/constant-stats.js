'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Env } = require('../../../env');
const { loadPool } = require('../../../omni/rs/pool');
const { fixture } = require('./phase-stats');
const summary = (c) => c.getSummary(c.controller, true);
const scenarios = [
    { name: 'veers-aura-source-leave-lethal', extraCodes: ['SOR_230', 'ASH_242'], ownCode: 'ASH_242', constant: { code: 'SOR_230', owner: 'own' }, initialOwnDamage: 4,
        plan: [['TWI_226', 'constant']],
        observeInitial: ({ targets }) => targets.own.zoneName === 'groundArena' && summary(targets.own).hp === 5 && summary(targets.own).power === 6 && summary(targets.constant).hp === targets.constant.cardData.hp,
        observeAfter: ({ targets }) => targets.constant.zoneName === 'hand' && targets.own.zoneName === 'discard' },
    { name: 'snoke-aura-source-bounce-restores', extraCodes: ['SHD_037'], constant: { code: 'SHD_037', owner: 'enemy' },
        plan: [['TWI_226', 'constant']],
        observeInitial: ({ targets }) => summary(targets.own).hp === 2 && summary(targets.own).power === 1,
        observeAfter: ({ targets }) => targets.constant.zoneName === 'hand' && summary(targets.own).hp === 4 && summary(targets.own).power === 3 },
    { name: 'snoke-entry-defeats-low-hp', extraCodes: ['SHD_037'], enemyCode: 'ASH_190', plan: [['SHD_037', 'own']],
        observeInitial: ({ targets }) => targets.own.zoneName === 'groundArena',
        observeAfter: ({ targets, own, enemy }) => targets.enemy.zoneName === 'discard' && own.getCardsInZone('groundArena').some((c) => c.internalName === 'supreme-leader-snoke#shadow-ruler') && enemy.getCardsInZone('groundArena').length === 0 },
    { name: 'scimitar-damage-enables-power', extraCodes: ['LOF_233'], constant: { code: 'LOF_233', owner: 'own' }, plan: [['TWI_170', 'constant']],
        observeInitial: ({ targets }) => targets.constant.damage === 0 && summary(targets.constant).power === targets.constant.cardData.power,
        observeAfter: ({ targets }) => targets.constant.damage === 2 && summary(targets.constant).power === targets.constant.cardData.power + 3 },
    ...[['IBH_002', 20], ['IBH_054', 20], ['JTL_031', 34]].map(([baseCode, hp]) => ({ name: `base-${baseCode}-${hp}-hp-terminal`, baseCode, terminalBase: true, plan: [['TWI_170', 'enemyBase']],
        observeInitial: ({ enemy }) => enemy.base.cardData.hp === hp && enemy.base.damage === hp - 1,
        observeAfter: ({ eg, enemy }) => eg.over && eg.winner === 'p1' && enemy.base.damage >= hp })),
];
module.exports = { scenarios, fixture };
