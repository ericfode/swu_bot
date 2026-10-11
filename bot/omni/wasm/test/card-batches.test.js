'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createSimulator } = require('../node');
const { records, checkRecords } = require('../check');
const root = path.resolve(__dirname, '../../../omni-rs/tests/card-batches');
const cataloguePath = path.resolve(__dirname, '../../../card-compiler/generated/catalog.json');
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('all card batches match current Wasm programs and immutable engine receipts', async () => {
    const batches = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    assert.ok(batches.length, 'Missing card batch receipts');
    for (const batch of batches) {
        const index = JSON.parse(fs.readFileSync(path.join(root, batch, 'receipt-index.json')));
        assert.equal(index.schema, 'swu-card-batch-receipts/v1');
        for (const corpus of index.corpora) {
            const directory = path.join(root, batch, corpus.directory), poolPath = path.join(directory, 'pool.json');
            assert.equal(sha(poolPath), corpus.poolSha256, 'Pool receipt changed');
            assert.ok(corpus.fixtures.length);
            assert.deepEqual(fs.readdirSync(directory).filter((file) => file.endsWith('.gz')).sort(), corpus.fixtures.map((row) => row.file).sort());
            const simulator = await createSimulator({ cataloguePath, poolPath });
            try {
                for (const row of corpus.fixtures) {
                    const file = path.join(directory, row.file); assert.equal(sha(file), row.sha256, 'Engine receipt changed');
                    const result = checkRecords(simulator, records(file), file);
                    assert.ok(result.matched && result.decisions > 0 && result.windows > 0);
                }
            } finally { simulator.free(); }
        }
    }
});
