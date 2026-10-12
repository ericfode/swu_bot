'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const lib = require('../../../cards/reference/library');
const { createSimulator } = require('../node');
const { records, checkRecords } = require('../check');
const cataloguePath = path.resolve(__dirname, '../../../card-compiler/generated/catalog.json');
test('all reference cases match current Wasm programs and immutable engine recordings', async () => {
    lib.verify();
    const rows = lib.corpus().recordings;
    for (const pool of new Set(rows.map(r => r.poolSha256))) {
        const simulator = await createSimulator({ cataloguePath, poolPath: lib.checkedArtifact(lib.defaultCorpus, 'pool', pool) });
        try {
            for (const row of rows.filter(r => r.poolSha256 === pool)) {
                const file = lib.checkedArtifact(lib.defaultCorpus, 'trace', row.traceSha256);
                const result = checkRecords(simulator, records(file), row.caseId);
                assert.ok(result.matched); assert.equal(result.decisions, row.decisions); assert.equal(result.windows, row.windows);
            }
        } finally { simulator.free(); }
    }
});
