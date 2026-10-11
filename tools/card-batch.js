'use strict';

// Accounting only: runtime admission is not differential conformance.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
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
    return { schema: 'swu-card-batch-snapshot/v1', revision,
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

function select(before, count = 100, chosenIds) {
    assert.ok(Number.isSafeInteger(count) && count > 0, 'Count must be a positive integer');
    const eligible = new Set(before.cards.filter((card) => !card.admitted).map((card) => card.setCode));
    const ids = chosenIds ? [...chosenIds].sort() : [...eligible].sort().slice(0, count);
    assert.equal(new Set(ids).size, ids.length, 'Duplicate chosen IDs');
    for (const id of ids) assert.ok(eligible.has(id), `Unknown or already admitted card ${id}`);
    assert.equal(ids.length, count, 'Not enough rejected cards for a full batch');
    return { schema: 'swu-card-batch-manifest/v1', requestedExecutableCount: count, selectionTiming: 'unspecified; record whether chosen before implementation or after exploratory family prototypes',
        baselineCatalogueHash: before.hashes['catalog.json'], ids };
}

function report(before, after, manifest) {
    assert.equal(manifest.baselineCatalogueHash, before.hashes['catalog.json'], 'Manifest baseline mismatch');
    assert.ok(Array.isArray(manifest.ids) && manifest.ids.length > 0, 'Empty batch');
    assert.equal(new Set(manifest.ids).size, manifest.ids.length, 'Duplicate queued IDs');
    const old = new Map(before.cards.map((card) => [card.setCode, card]));
    const next = new Map(after.cards.map((card) => [card.setCode, card]));
    const outcomes = manifest.ids.map((id) => {
        assert.ok(old.has(id) && next.has(id), `Unknown or removed card ${id}`);
        assert.equal(old.get(id).admitted, false, `Queued card already admitted: ${id}`);
        const card = next.get(id);
        return { id, internalName: card.internalName, sourceConvertedBefore: old.get(id).converted,
            sourceConvertedAfter: card.converted, runtimeAdmitted: card.admitted,
            outcome: card.admitted ? 'newly-admitted' : 'blocked', blocker: card.reason ?? null,
            conformance: 'unassessed' };
    });
    const admitted = (value) => value.cards.filter((card) => card.admitted).map((card) => card.setCode);
    const added = admitted(after).filter((id) => !old.get(id)?.admitted);
    const removed = admitted(before).filter((id) => !next.get(id)?.admitted);
    return { schema: 'swu-card-batch-report/v1', beforeRevision: before.revision, afterRevision: after.revision,
        beforeHashes: before.hashes, afterHashes: after.hashes, requestedExecutableCount: manifest.requestedExecutableCount,
        queued: outcomes.length, targetMetByAdmission: outcomes.filter((card) => card.runtimeAdmitted).length >= manifest.requestedExecutableCount,
        newlyAdmittedInBatch: outcomes.filter((card) => card.runtimeAdmitted).length,
        blockedInBatch: outcomes.filter((card) => !card.runtimeAdmitted).length,
        sourceConverted: { before: before.cards.filter((card) => card.converted).length,
            after: after.cards.filter((card) => card.converted).length },
        sourceAstConverted: { before: before.sourceAstConverted, after: after.sourceAstConverted },
        dataOnlyConverted: { before: before.dataOnlyConverted, after: after.dataOnlyConverted },
        selectionTiming: manifest.selectionTiming,
        runtimeAdmitted: { before: admitted(before).length, after: admitted(after).length },
        newlyAdmittedOutsideBatch: added.filter((id) => !manifest.ids.includes(id)), admissionRegressions: removed,
        conformance: 'Requires separate family witnesses and passing native/Wasm trace checks', outcomes };
}

function main(args) {
    const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    let result;
    if (args[0] === 'snapshot' && args.length === 2) {
        result = snapshot(args[1], execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    } else if (args[0] === 'select' && args.length >= 2 && args.length <= 4) {
        result = select(read(args[1]), args[2] === undefined ? 100 : Number(args[2]), args[3] ? read(args[3]) : undefined);
    } else if (args[0] === 'report' && args.length === 4) {
        result = report(read(args[1]), read(args[2]), read(args[3]));
    } else throw new Error('Usage: card-batch.js snapshot GENERATED_DIR | select BEFORE_JSON [COUNT [IDS_JSON]] | report BEFORE_JSON AFTER_JSON MANIFEST_JSON');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { snapshot, select, report, validatePool };
