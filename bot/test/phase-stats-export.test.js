'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { phaseStats } = require('../omni/rs/state');
const effect = (power, hp, duration = 'untilEndOfPhase', type = 'modifyStats') => ({ duration, type, getValue: () => ({ power, hp }) });
const card = (effects) => ({ internalName: 'fixture', getOngoingEffects: () => effects });
test('phase stats preserve signed stacked modifiers independently of visible stat floors', () => {
    assert.deepEqual(phaseStats(card([effect(-4, 0), effect(2, 2)])), { phaseStats: { power: -2, hp: 2 } });
    assert.deepEqual(phaseStats(card([])), {});
    assert.deepEqual(phaseStats(card([effect(2, 2), effect(-2, -2)])), {});
});
test('unknown durations, mechanics and out-of-bound values cannot silently lose state', () => {
    assert.throws(() => phaseStats(card([effect(1, 1, 'untilEndOfRound')])), /duration/);
    assert.throws(() => phaseStats(card([effect(0, 0, 'untilEndOfPhase', 'gainKeyword')])), /phase effect/);
    assert.throws(() => phaseStats(card([effect(65535, 0), effect(1, 0)])), /bounds/);
    assert.throws(() => phaseStats(card([effect(1.5, 0)])), /value/);
});
test('registered constant stats are derived while persistent lasting effects remain rejected', () => {
    const constant = effect(2, 2, 'persistent');
    constant.source = { getConstantAbilities: () => [{ registeredEffects: [constant] }] };
    assert.deepEqual(phaseStats(card([constant, effect(-1, 0)])), { phaseStats: { power: -1, hp: 0 } });
    assert.throws(() => phaseStats(card([effect(2, 2, 'persistent')])), /duration/);
});
