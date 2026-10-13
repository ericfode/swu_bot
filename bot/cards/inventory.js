'use strict';

// Accounting only: runtime admission is not differential conformance.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// serde_json's default object map is key-sorted; its admission hash is compact JSON, not file bytes.
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    return value;
}

function snapshot(directory, revision) {
    const names = ['catalog.json', 'coverage.json', 'runtime-admission.json', 'runtime-pool.json'];
    const bytes = Object.fromEntries(names.map((name) => [name, fs.readFileSync(path.join(directory, name))]));
    const coverage = JSON.parse(bytes['coverage.json']);
    const admission = JSON.parse(bytes['runtime-admission.json']);
    const catalogue = JSON.parse(bytes['catalog.json']);
    const pool = JSON.parse(bytes['runtime-pool.json']);
    assert.equal(admission.catalogueHash, sha256(JSON.stringify(canonical(catalogue))), 'Admission/catalogue hash mismatch');
    validatePool(catalogue, admission, pool);
    assert.equal(coverage.converted, admission.irConvertedCount, 'Conversion reports disagree');
    assert.equal(coverage.sourceTreeHash, catalogue.sourceTreeHash, 'Coverage/catalogue source hash mismatch');
    assert.equal(coverage.compilerHash, catalogue.compilerHash, 'Coverage/catalogue compiler hash mismatch');
    const converted = new Set(coverage.convertedCards);
    const cards = [...admission.runtimeAdmittedCards.map((card) => ({ ...card, admitted: true })),
        ...admission.runtimeRejectedCards.map((card) => ({ ...card, admitted: false }))]
        .map((card) => ({ ...card, converted: converted.has(card.setCode) }))
        .sort((a, b) => a.setCode.localeCompare(b.setCode));
    assert.equal(new Set(cards.map((card) => card.setCode)).size, cards.length, 'Duplicate card IDs');
    assert.equal(cards.length, admission.knownCards, 'Incomplete admission inventory');
    assert.equal(cards.filter((card) => card.admitted).length, admission.runtimeAdmittedCount);
    assert.equal(cards.filter((card) => card.converted).length, coverage.converted);
    return { schema: 'swu-card-inventory/v1', revision,
        hashes: Object.fromEntries(names.map((name) => [name, sha256(bytes[name])])),
        sourceTreeHash: coverage.sourceTreeHash, compilerHash: coverage.compilerHash,
        sourceAstConverted: coverage.sourceAstConverted, dataOnlyConverted: coverage.dataOnlyConverted, cards };
}

function validatePool(catalogue, admission, pool) {
    assert.equal(pool.schema, 'omni-rs-pool-v1', 'Wrong runtime pool schema');
    const definitions = new Map(catalogue.cards.map((card) => [card.setCode, card.card]));
    const admitted = admission.runtimeAdmittedCards.map((card) => card.setCode).sort();
    assert.equal(new Set(pool.cards.map((card) => card.setCode)).size, pool.cards.length, 'Duplicate pool IDs');
    assert.deepEqual(pool.cards.map((card) => card.setCode).sort(), admitted, 'Runtime pool/admission inventory mismatch');
    for (const { setCode, ...metadata } of pool.cards) {
        assert.ok(definitions.has(setCode), `Pool card missing from catalogue: ${setCode}`);
        assert.deepEqual(canonical(metadata), canonical(definitions.get(setCode)), `Runtime pool/catalogue metadata mismatch: ${setCode}`);
    }
}

module.exports = { snapshot, validatePool, canonical, sha256 };
