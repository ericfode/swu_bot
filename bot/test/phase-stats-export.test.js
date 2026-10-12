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
    assert.throws(() => phaseStats(card([effect(0, 0, 'untilEndOfPhase', 'gainKeyword')])), /phase keyword/);
    assert.throws(() => phaseStats(card([effect(65535, 0), effect(1, 0)])), /bounds/);
    assert.throws(() => phaseStats(card([effect(1.5, 0)])), /value/);
});
test('registered constant stats are derived while persistent lasting effects remain rejected', () => {
    const constant = effect(2, 2, 'persistent');
    constant.source = { getConstantAbilities: () => [{ registeredEffects: [constant] }] };
    assert.deepEqual(phaseStats(card([constant, effect(-1, 0)])), { phaseStats: { power: -1, hp: 0 } });
    assert.throws(() => phaseStats(card([effect(2, 2, 'persistent')])), /duration/);
});

const keywordEffect = (value, type = 'gainKeyword', duration = 'untilEndOfPhase') => ({ type, duration, getValue: () => value });
test('phase keyword ledger preserves gains under loss and aggregates numeric stacks', () => {
    assert.deepEqual(phaseStats(card([keywordEffect({ keyword: 'sentinel' }), keywordEffect([{ keyword: 'sentinel' }, { keyword: 'raid', amount: 2 }]), keywordEffect({ keyword: 'raid', amount: 3 }), keywordEffect(['raid', 'sentinel'], 'loseKeyword') ])), {
        phaseKeywords: { raid: 5, sentinel: 1 }, phaseLostKeywords: ['sentinel', 'raid']
    });
    assert.deepEqual(phaseStats(card([keywordEffect({ keyword: 'restore', amount: 0 })])), { phaseKeywords: { restore: 0 } });
});
test('phase keyword export rejects unsupported mechanics, malformed values and lasting effects', () => {
    for (const value of ['hidden', { keyword: 'raid', amount: -1 }, { keyword: 'raid', amount: 1.5 }, { keyword: 'sentinel', amount: 1 }, { keyword: 'restore', amount: 1, extra: true }]) {
        assert.throws(() => phaseStats(card([keywordEffect(value)])), /keyword/);
    }
    assert.throws(() => phaseStats(card([keywordEffect('sentinel', 'gainKeyword', 'untilEndOfRound')])), /duration/);
    const constant = keywordEffect('sentinel', 'gainKeyword', 'persistent');
    constant.source = { getConstantAbilities: () => [{ registeredEffects: [constant] }] };
    assert.deepEqual(phaseStats(card([constant])), {});
    assert.throws(() => phaseStats(card([keywordEffect('sentinel', 'gainKeyword', 'persistent')])), /duration/);
});


test('arena order preserves engine entry order across controllers and affects receipt hashes', () => {
    const { arenaUnitOrder, stateHash } = require('../omni/rs/state');
    const calls = [];
    const eg = { cardId: (uuid) => uuid, game: { getArenaUnits: ({ arena }) => {
        calls.push(arena);
        return (arena === 'groundArena' ? ['c53', 'c2', 'c51'] : ['c91', 'c30']).map((uuid) => ({ uuid }));
    } } };
    const order = arenaUnitOrder(eg);
    assert.deepEqual(calls, ['groundArena', 'spaceArena']);
    assert.deepEqual(order, { ground: ['c53', 'c2', 'c51'], space: ['c91', 'c30'] });
    assert.notEqual(stateHash({ arenaUnitOrder: order }), stateHash({ arenaUnitOrder: { ...order, ground: ['c2', 'c53', 'c51'] } }));
});
