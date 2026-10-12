'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { Env } = require('../../../env');
const { loadPool } = require('../../../omni/rs/pool');
const { fixture } = require('./phase-stats');
const scenarios = [
    { name: 'kanan-shield-and-creature-aura', leaderCode: 'LOF_004', extraCodes: ['ASH_131'], ownCode: 'ASH_131',
        plan: [['LOF_004', 'own', 'leaderAction'], ['LOF_004', 'own', 'deploy']],
        observeInitial: ({ own, targets }) => !own.getAllDeckLeaders()[0].deployed && targets.own.upgrades.length === 0,
        observeAfter: ({ own, targets }) => { const l = own.getAllDeckLeaders()[0]; return l.deployed && l.getPower() === 5 && l.getSummary(own, true).hp === 8 && l.upgrades.some((c) => c.internalName === 'shield') && targets.own.upgrades.some((c) => c.internalName === 'shield'); } },
    { name: 'c3po-action-and-on-attack', leaderCode: 'SEC_015', exhaustedOwn: true,
        plan: [['SEC_015', 'enemy', 'leaderAction'], ['SEC_015', 'own', 'deploy'], ['SEC_015', 'enemy', 'attack']],
        observeInitial: ({ own, targets }) => !own.getAllDeckLeaders()[0].deployed && targets.own.exhausted && !targets.enemy.exhausted,
        observeAfter: ({ own, targets }) => own.getAllDeckLeaders()[0].deployed && own.getAllDeckLeaders()[0].exhausted && targets.enemy.exhausted && targets.enemy.damage === 1 },
];
module.exports = { scenarios, fixture };
