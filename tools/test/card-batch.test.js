'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { select, report, validatePool } = require('../card-batch');
const before = { revision: 'before', hashes: { 'catalog.json': 'old' }, cards: [
    { setCode: 'A', internalName: 'a', admitted: false, converted: false },
    { setCode: 'B', internalName: 'b', admitted: false, converted: true },
    { setCode: 'C', internalName: 'c', admitted: true, converted: true },
    { setCode: 'D', internalName: 'd', admitted: false, converted: false },
] };
test('batch separates queued, source-only, runtime gains, collateral gains and regressions', () => {
    const manifest = select(before, 2, ['B', 'A']);
    const after = { ...before, revision: 'after', cards: before.cards.map((card) => ({ ...card,
        admitted: card.setCode === 'A' || card.setCode === 'D', converted: true, reason: 'unsupported-runtime' })) };
    const value = report(before, after, manifest);
    assert.equal(value.queued, 2);
    assert.equal(value.newlyAdmittedInBatch, 1);
    assert.equal(value.blockedInBatch, 1);
    assert.equal(value.targetMetByAdmission, false);
    assert.deepEqual(value.newlyAdmittedOutsideBatch, ['D']);
    assert.deepEqual(value.admissionRegressions, ['C']);
    assert.equal(value.outcomes[1].conformance, 'unassessed');
    assert.equal(value.outcomes[1].blocker, 'unsupported-runtime');
});
test('stale pools fail even when catalogue and admission agree', () => {
    const catalogue = { cards: [{ setCode: 'A', card: { internalName: 'a', power: 2 } }] };
    const admission = { runtimeAdmittedCards: [{ setCode: 'A' }] };
    const pool = { schema: 'omni-rs-pool-v1', cards: [{ setCode: 'A', internalName: 'a', power: 2 }] };
    validatePool(catalogue, admission, pool);
    assert.throws(() => validatePool(catalogue, admission, { ...pool, cards: [] }), /inventory mismatch/);
    assert.throws(() => validatePool(catalogue, admission, { ...pool, cards: [{ ...pool.cards[0], power: 3 }] }), /metadata mismatch/);
    assert.throws(() => validatePool(catalogue, admission, { ...pool, cards: [pool.cards[0], pool.cards[0]] }), /Duplicate/);
});
test('invalid manifests cannot manufacture progress', () => {
    assert.throws(() => select(before, 2, ['A', 'A']), /Duplicate/);
    assert.throws(() => select(before, 1, ['C']), /already admitted/);
    assert.throws(() => select(before, 100), /Not enough/);
    const manifest = select(before, 1);
    assert.throws(() => report(before, before, { ...manifest, baselineCatalogueHash: 'other' }), /baseline/);
    assert.throws(() => report(before, before, { ...manifest, ids: ['missing'] }), /Unknown/);
});
