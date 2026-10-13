'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const lib = require('./library');
const { sha256 } = require('../inventory');
const repo = path.resolve(__dirname, '../../..');
async function check(options = {}) {
    const directory = path.resolve(options.corpus ?? lib.defaultCorpus);
    lib.verify(directory);
    const manifest = lib.corpus(directory), index = lib.registry();
    const cases = new Set(lib.selectCases(options, index, manifest.recordings).map(c => c.id));
    const rows = manifest.recordings.filter(r => cases.has(r.caseId)); assert.ok(rows.length, 'No matching recordings');
    const cataloguePath = path.resolve(options.catalogue ?? path.join(repo, 'bot/card-compiler/generated/catalog.json'));
    const runtime = options.runtime ?? 'both'; assert.ok(['native', 'wasm', 'both'].includes(runtime), 'Use native, wasm or both');
    const results = [];
    const native = path.resolve(options.native ?? path.join(repo, 'target/release/omni-rs'));
        const identities = { catalogueSha256: sha256(fs.readFileSync(cataloguePath)) };
    if (runtime !== 'wasm') identities.nativeSha256 = sha256(fs.readFileSync(native));
    // Node loader resolves the exact Wasm package; its files are hashed below when present.
    if (runtime !== 'native') {
        const pkg = path.resolve(options.wasmPackage ?? path.join(repo, 'bot/omni-wasm/pkg/node'));
        identities.wasmPackage = Object.fromEntries(fs.readdirSync(pkg).filter(f => /\.(wasm|js)$/.test(f)).sort().map(f => [f, sha256(fs.readFileSync(path.join(pkg, f)))]));
    }
    for (const poolSha256 of new Set(rows.map(r => r.poolSha256))) {
        const poolPath = lib.checkedArtifact(directory, 'pool', poolSha256), group = rows.filter(r => r.poolSha256 === poolSha256);
        const files = group.map(r => lib.checkedArtifact(directory, 'trace', r.traceSha256));
        if (runtime !== 'wasm') {
            const run = spawnSync(native, ['check', ...files, '--pool', poolPath, '--catalogue', cataloguePath, ...(options.backend ? ['--backend', options.backend] : []), ...(options.dispatchDir ? ['--rules-receipt', path.join(options.dispatchDir, poolSha256 + '-native-' + (options.backend ?? 'auto') + '.json')] : [])], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
            if (run.error) throw run.error;
            assert.equal(run.status, 0, run.stderr || run.stdout);
            const checked = run.stdout.trim().split('\n').map(JSON.parse); assert.equal(checked.length, group.length);
            checked.forEach((r, i) => { assert.ok(r.matched); assert.equal(r.decisions, group[i].decisions); assert.equal(r.windows, group[i].windows); results.push({ caseId: group[i].caseId, traceSha256: group[i].traceSha256, runtime: 'native', ...r }); });
        }
        if (runtime !== 'native') {
            const { createSimulator } = require('../../omni/wasm/node'), { records, checkRecords } = require('../../omni/wasm/check');
            const simulator = await createSimulator({ cataloguePath, poolPath, packagePath: options.wasmPackage ? path.join(path.resolve(options.wasmPackage), 'omni_wasm.js') : undefined, backend: options.backend, instrumentation: !!options.dispatchDir });
            try { files.forEach((file, i) => { const r = checkRecords(simulator, records(file), file); assert.equal(r.decisions, group[i].decisions); assert.equal(r.windows, group[i].windows); results.push({ caseId: group[i].caseId, traceSha256: group[i].traceSha256, ...r }); }); }
            finally { if (options.dispatchDir) fs.writeFileSync(path.join(options.dispatchDir, poolSha256 + '-wasm-' + (options.backend ?? 'auto') + '.json'), JSON.stringify(simulator.rulesBackendReport(), null, 2) + '\n', {flag:'wx'}); simulator.free(); }
        }
    }
    assert.equal(sha256(fs.readFileSync(cataloguePath)), identities.catalogueSha256, 'Catalogue changed during checks');
    if (identities.nativeSha256) assert.equal(sha256(fs.readFileSync(native)), identities.nativeSha256, 'Native binary changed during checks');
    if (identities.wasmPackage) for (const [file, hash] of Object.entries(identities.wasmPackage)) assert.equal(sha256(fs.readFileSync(path.join(path.resolve(options.wasmPackage ?? path.join(repo, 'bot/omni-wasm/pkg/node')), file))), hash, 'Wasm package changed during checks');
    const receipt = { schema: 'swu-reference-check/v1', identities, recordings: rows.length, results };
    if (options.receipt) fs.writeFileSync(options.receipt, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    return { recordings: rows.length, comparisons: results.length, decisions: results.reduce((n, r) => n + r.decisions, 0), runtime, matched: true, identities };
}
async function adopt(options) {
    assert.ok(options.corpus, 'import needs --corpus GENERATED_DIRECTORY');
    // Import into the accepted corpus only after both current runtimes agree.
    const verification = await check({ corpus: options.corpus, native: options.native, runtime: 'both', diagnostics: true });
    const incoming = lib.corpus(options.corpus), current = lib.corpus(), keys = new Set(current.recordings.map(r => r.caseId + ':' + r.traceSha256));
    for (const row of incoming.recordings) {
        if (keys.has(row.caseId + ':' + row.traceSha256)) continue;
        for (const [kind, hash] of [['pool', row.poolSha256], ['trace', row.traceSha256]]) {
            const src = lib.checkedArtifact(options.corpus, kind, hash), dest = lib.artifact(lib.defaultCorpus, kind, hash);
            if (fs.existsSync(dest)) lib.checkedArtifact(lib.defaultCorpus, kind, hash); else fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
        }
        current.recordings.push(row); keys.add(row.caseId + ':' + row.traceSha256);
    }
    current.recordings.sort((a,b) => a.caseId.localeCompare(b.caseId) || a.traceSha256.localeCompare(b.traceSha256));
    const dest = path.join(lib.defaultCorpus, 'manifest.json');
    fs.writeFileSync(dest + '.tmp', JSON.stringify(current, null, 2) + '\n'); fs.renameSync(dest + '.tmp', dest);
    return { ...lib.verify(), verification };
}
module.exports = { check, adopt };
