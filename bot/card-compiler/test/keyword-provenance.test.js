'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { keywordValues } = require('../build');

test('Coordinate registration marker follows pinned printed-text parsing, not keyword mentions', () => {
    const card = { types: ['unit'], keywords: ['coordinate', 'sentinel'], internalName: 'new-unit' };
    assert.deepEqual(keywordValues({ ...card, text: 'Coordinate — This unit gains Sentinel.' }), { coordinate: 1 });
    assert.deepEqual(keywordValues({ ...card, text: 'When Played: Another unit gains Coordinate.' }), {});
    assert.deepEqual(keywordValues({ ...card, text: ' coordinate — This unit gains Sentinel.' }), {});
    assert.deepEqual(keywordValues({ ...card, keywords: [], text: 'Coordinate — This unit gains Sentinel.' }), {});
    assert.throws(() => keywordValues({ ...card, text: 'Coordinate — Draw.\nCoordinate — Heal.' }), /Multiple printed coordinate/);
});
