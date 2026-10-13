'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { sha256 } = require('../inventory');
const root = __dirname;
const defaultCorpus = path.join(root, 'fixtures');
const read = file => JSON.parse(fs.readFileSync(file));
function registry() { return read(path.join(root, 'cases.json')); }
function definition(id, index = registry(), recordedDefinition = null) {
    const entry = index.cases.find(c => c.id === id);
    if (entry) return entry;
    if (/^card-play\/[A-Z][A-Z0-9]{2,3}_\d{3}$/.test(id)) {
        const setCode = id.split('/')[1];
        return { id, behaviorIds: ['card-play'], kind: 'play', source: { module: './scenarios/card-play.js', scenario: 'play-' + setCode },
            focusCardIds: [setCode], setupCardIds: [setCode], assertionStages: ['onCardPlayed'],
            assertionScope: 'The card was played; this does not prove every printed ability.' };
    }
    if (/^auto\/[A-Z][A-Z0-9]{2,3}_\d{3}\/[a-z0-9-]+$/.test(id)) {
        const entry = recordedDefinition ?? corpus().recordings.find(r => r.caseId === id)?.caseDefinition;
        assert.ok(entry && entry.id === id && entry.kind === 'probe', 'Automatic case needs its immutable definition: ' + id);
        assert.deepEqual(entry.focusCardIds, [id.split('/')[1]]);
        assert.equal(entry.source?.module, '../pipeline/probe-fixture.js');
        return entry;
    }
    throw new Error('Unknown reference case: ' + id);
}
function corpus(directory = defaultCorpus) {
    const value = read(path.join(directory, 'manifest.json'));
    assert.equal(value.schema, 'swu-reference-corpus/v1');
    assert.ok(Array.isArray(value.recordings) && value.recordings.length, 'Empty reference corpus');
    return value;
}
function artifact(directory, kind, hash) {
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.ok(['pool', 'trace'].includes(kind));
    return path.join(directory, kind === 'pool' ? 'pools' : 'traces', hash + (kind === 'pool' ? '.json' : '.jsonl.gz'));
}
function checkedArtifact(directory, kind, hash) {
    const file = artifact(directory, kind, hash);
    assert.equal(sha256(fs.readFileSync(file)), hash, `Changed ${kind}: ${file}`);
    return file;
}
function selectCases(options = {}, index = registry(), recordings = []) {
    const candidates = [...index.cases];
    for (const id of new Set([...recordings.map(r => r.caseId), ...(options.case ? [options.case] : []), ...(options.play && options.card ? ['card-play/' + options.card] : [])])) {
        if (!candidates.some(c => c.id === id)) candidates.push(definition(id, index, recordings.find(r => r.caseId === id)?.caseDefinition));
    }
    const selected = candidates.filter(c => (!options.case || c.id === options.case) &&
        (!options.behavior || c.behaviorIds.includes(options.behavior)) &&
        (!options.card || c.focusCardIds.includes(options.card) || (options.includeSetup && c.setupCardIds.includes(options.card))) &&
        (options.diagnostics || c.kind !== 'diagnostic'));
    if (!selected.length) throw new Error('No matching reference cases');
    return selected.sort((a, b) => a.id.localeCompare(b.id));
}
function verify(directory = defaultCorpus) {
    const index = registry(), manifest = corpus(directory);
    assert.equal(index.schema, 'swu-reference-cases/v1');
    assert.equal(new Set(index.cases.map(c => c.id)).size, index.cases.length, 'Duplicate case ID');
    for (const [file, expected] of Object.entries(index.sources)) assert.equal(sha256(fs.readFileSync(path.resolve(root, file))), expected, 'Stale case index: run cards:reference index');
    const pools = new Set(), traces = new Set(), keys = new Set();
    for (const row of manifest.recordings) {
        const entry = definition(row.caseId, index, row.caseDefinition);
        const bytes = fs.readFileSync(checkedArtifact(directory, 'trace', row.traceSha256));
        const rows = require('node:zlib').gunzipSync(bytes).toString('utf8').trim().split('\n').map(JSON.parse);
        const meta = rows[0];
        assert.equal(meta.type, 'meta'); assert.equal(meta.schema, 'omni-rs-trace-v1');
        assert.equal(meta.pool.sha256, row.poolSha256, 'Manifest pool differs from trace');
        assert.equal(meta.seed, row.seed, 'Manifest seed differs from trace');
        assert.equal(rows.at(-1).type, 'result', 'Nonterminal reference trace');
        assert.equal(rows.filter(r => r.type === 'decision').length, row.decisions, 'Decision count differs');
        assert.equal(rows.filter(r => r.type === 'state').length, row.windows, 'Window count differs');
        if (meta.referenceCase) assert.equal(meta.referenceCase.id, entry.id, 'Reference case differs');
        if (entry.kind === 'probe') assert.equal(meta.referenceCase.definitionSha256, sha256(Buffer.from(JSON.stringify(entry))), 'Automatic probe definition changed');
        const scenario = meta.scenario?.replace(/^low-proof-/, '');
        assert.equal(scenario, entry.source.scenario, 'Scenario differs from case definition');
        const key = row.caseId + ':' + row.traceSha256;
        assert.ok(!keys.has(key), 'Duplicate reference recording'); keys.add(key);
        assert.ok(row.decisions > 0 && row.windows > 0, 'Empty reference recording');
        pools.add(row.poolSha256); traces.add(row.traceSha256);
    }
    for (const [kind, hashes, dir, suffix] of [['pool', pools, 'pools', '.json'], ['trace', traces, 'traces', '.jsonl.gz']]) {
        for (const hash of hashes) checkedArtifact(directory, kind, hash);
        assert.deepEqual(fs.readdirSync(path.join(directory, dir)).sort(), [...hashes].map(h => h + suffix).sort(), `Unindexed ${kind} files`);
    }
    return { cases: new Set(manifest.recordings.map(r => r.caseId)).size, recordings: manifest.recordings.length, pools: pools.size, traces: traces.size };
}
module.exports = { root, defaultCorpus, read, registry, definition, corpus, artifact, checkedArtifact, selectCases, verify };
