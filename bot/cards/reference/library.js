'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
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
// Keep storage evidence separate from the unchanged v1 document.
function manifestArtifact(directory = defaultCorpus) {
    const files = ['manifest.json', 'manifest.json.gz'].map(name => path.join(directory, name)).filter(file => fs.existsSync(file));
    assert.equal(files.length, 1, 'Reference corpus needs exactly one manifest.json or manifest.json.gz');
    const file = files[0], bytes = fs.readFileSync(file);
    const decodedBytes = file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes;
    const document = JSON.parse(decodedBytes.toString('utf8'));
    assert.equal(document.schema, 'swu-reference-corpus/v1');
    assert.ok(Array.isArray(document.recordings) && document.recordings.length, 'Empty reference corpus');
    return { path: file, bytes, decodedBytes, document };
}
function corpus(directory = defaultCorpus) { return manifestArtifact(directory).document; }
function writeManifest(directory, document) {
    assert.equal(document.schema, 'swu-reference-corpus/v1');
    assert.ok(Array.isArray(document.recordings) && document.recordings.length, 'Empty reference corpus');
    const existing = ['manifest.json', 'manifest.json.gz'].filter(name => fs.existsSync(path.join(directory, name)));
    assert.ok(existing.length <= 1, 'Ambiguous reference manifests');
    // Existing corpus format is stable; newly generated corpora use gzip.
    const file = path.join(directory, existing[0] ?? 'manifest.json.gz');
    const decoded = Buffer.from(JSON.stringify(document, null, 2) + '\n');
    const bytes = file.endsWith('.gz') ? zlib.gzipSync(decoded) : decoded;
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
        fs.writeFileSync(temporary, bytes, { flag: 'wx' });
        fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return manifestArtifact(directory);
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
module.exports = { root, defaultCorpus, read, registry, definition, corpus, manifestArtifact, writeManifest, artifact, checkedArtifact, selectCases, verify };
