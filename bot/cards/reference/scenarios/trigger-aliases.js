'use strict';
const path = require('node:path'), fs = require('node:fs'), zlib = require('node:zlib'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { Env } = require('../../../env'), { loadPool } = require('../../../omni/rs/pool'), { fixture } = require('./event-groups');
const scenarios = [];
for (const hook of ['play', 'attack'])
    for (const mode of ['heal', 'pass', 'no-effect'])
        scenarios.push({ name: 'rho-medical-shuttle-alias-' + hook + '-' + mode, family: 'standard-when-alias', baseDamage: mode === 'no-effect' ? 0 : 3, units: hook === 'attack' ? [{ key: 'source', code: 'HMW_063', owner: 'own' }] : [], plan: [hook === 'attack' ? { from: 'source', code: 'HMW_063' } : { code: 'HMW_063' }], choose: c => { const title = c.eg.player(c.pid).currentPrompt().menuTitle; if (title === 'Choose a target for attack')
                return c.actions.find(a => a.cardUuid === c.enemy.base.uuid); if (title === 'Heal 1 damage from another unit or base') {
                assert.ok(!c.actions.some(a => a.cardUuid === c.scratch.incoming.uuid));
                assert.ok(c.actions.some(a => a.arg === 'passAbility'));
                c.observed.aliasHealPrompt = true;
                return c.actions.find(a => mode === 'pass' ? a.arg === 'passAbility' : a.cardUuid === c.own.base.uuid);
            } }, assertAfter: c => { assert.equal(c.own.base.damage, mode === 'heal' ? 2 : mode === 'pass' ? 3 : 0); c.observed.actualScriptedCard = 'HMW_063 Rho Medical Shuttle'; c.observed.actualScriptedEffect = 'Heal 1 damage from another unit or base via ' + hook; if (mode === 'no-effect')
                assert.ok(!c.observed.aliasHealPrompt);
            else
                assert.ok(c.observed.aliasHealPrompt); } });
module.exports = { scenarios, fixture };
