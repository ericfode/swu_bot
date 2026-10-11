'use strict';
// Per-card play coverage supplements semantic family witnesses; it does not replace them.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Env } = require('../../env');
const { loadPool } = require('./pool');
const { fixture } = require('./make-phase-fixtures');

async function main(args) {
    const [sourcePool, manifestFile, directory] = args;
    assert.ok(args.length === 3, 'Usage: make-batch-play-fixtures.js POOL_JSON IDS_JSON NEW_OUTPUT_DIRECTORY');
    assert.ok(!fs.existsSync(directory), 'Use a fresh output directory');
    fs.mkdirSync(directory, { recursive: true });
    const poolFile = path.join(directory, 'pool.json'); fs.copyFileSync(sourcePool, poolFile);
    const pool = loadPool(poolFile), env = new Env();
    const raw = JSON.parse(fs.readFileSync(manifestFile));
    const ids = raw.map((c) => typeof c === 'string' ? c : c.setCode);
    assert.equal(new Set(ids).size, ids.length, 'Duplicate card IDs');
    const outcomes = [];
    for (const [i, id] of ids.entries()) {
        const card = pool.cards.find((c) => c.setCode === id);
        assert.ok(card, `Card ${id} is not admitted`);
        if (card.types.includes('base') || card.types.includes('leader')) {
            outcomes.push({ id, outcome: 'requires-dedicated-setup-witness', reason: 'Not a hand-play card' });
            continue;
        }
        const scenario = { name: 'play-' + id, expectedPlayed: id, extraCodes: [id], plan: [[id, id === 'ASH_236' ? 'own' : 'enemy']] };
        try {
            const { records, witness } = await fixture(env, pool, scenario, 10001 + i);
            const file = id + '.jsonl.gz', bytes = zlib.gzipSync(records.map((r) => JSON.stringify(r)).join('\n') + '\n');
            fs.writeFileSync(path.join(directory, file), bytes);
            outcomes.push({ id, outcome: 'engine-play-witness', file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
                decisions: records.filter((r) => r.type === 'decision').length, playedCodes: witness.playedCodes,
                conformance: 'unassessed; requires native and Wasm check', semanticCoverage: 'Play witnessed; family semantics require separate targeted assertions' });
            console.log(`${id}: engine play witnessed`);
        } catch (error) {
            outcomes.push({ id, outcome: 'blocked', reason: error.stack ?? String(error) });
            console.error(`${id}: ${error.message}`);
        }
    }
    fs.writeFileSync(path.join(directory, 'card-play-witnesses.json'), JSON.stringify({ poolSha256: pool.provenance.sha256, requested: ids.length, outcomes }, null, 2) + '\n');
    if (outcomes.some((c) => c.outcome === 'blocked')) process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
