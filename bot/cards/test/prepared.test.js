'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { sha256 } = require('../inventory');
const { loadPrepared, packageHashes, executionSnapshot } = require('../pipeline/prepared');
const { implementationSnapshot } = require('../pipeline/review');
const reference = require('../reference/generate');
const repo = path.resolve(__dirname, '../../..');
function currentEngineReceipt() {
    const engine = path.dirname(fs.realpathSync(path.join(repo, 'forceteki/server')));
    return { inputs: { sourceSha256: reference.treeHash(path.join(engine, 'server')), scriptsSha256: reference.treeHash(path.join(engine, 'scripts')), config: Object.fromEntries(fs.readdirSync(engine).filter(f => /^(?:tsconfig.*\.json|package(?:-lock)?\.json)$/.test(f)).sort().map(f => [f, sha256(fs.readFileSync(path.join(engine, f)))])) }, buildSha256: reference.treeHash(path.join(engine, 'build/server')) };
}
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swu-prepared-test-'));
    const catalogue = { cards: [], schema: 'synthetic-test-only' }, artifacts = {};
    for (const [key, name, value] of [['catalogue', 'catalog.json', JSON.stringify(catalogue)], ['admission', 'admission.json', '{}'], ['pool', 'pool.json', '{}'], ['rules', 'rules.json', '{}'], ['native', 'omni-rs', 'synthetic test binary']]) {
        fs.writeFileSync(path.join(root, name), value);
        artifacts[key] = { path: name, sha256: sha256(Buffer.from(value)) };
    }
    fs.mkdirSync(path.join(root, 'wasm'));
    for (const [name, value] of [['omni_wasm.js', 'synthetic loader'], ['omni_wasm_bg.wasm', 'synthetic wasm'], ['package.json', '{}']])
        fs.writeFileSync(path.join(root, 'wasm', name), value);
    const manifest = { schema: 'swu-card-pipeline-prepared/v1', nodeVersion: process.version, implementationBefore: implementationSnapshot(), executionInputs: executionSnapshot(), catalogueSemanticSha256: sha256(Buffer.from(JSON.stringify(catalogue))), engineBuild: currentEngineReceipt(), sourceIdentity: reference.sourceIdentity(), artifacts, wasmPackage: { path: 'wasm', files: packageHashes(path.join(root, 'wasm')) } };
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    return { root, manifest };
}
test('prepared snapshot accepts canonicalized temp root and rejects artifact/package tampering', () => { const { root } = fixture(); try {
    const p = loadPrepared(root);
    assert.equal(p.directory, fs.realpathSync(root));
    assert.equal(p.catalogueSha256, sha256(fs.readFileSync(path.join(root, 'catalog.json'))));
    assert.equal(p.manifestPath, path.join(root, 'manifest.json'));
    fs.appendFileSync(path.join(root, 'omni-rs'), 'changed');
    assert.throws(() => loadPrepared(root), /Prepared native changed/);
    fs.writeFileSync(path.join(root, 'omni-rs'), 'synthetic test binary');
    fs.writeFileSync(path.join(root, 'wasm/package.json'), 'changed');
    assert.throws(() => loadPrepared(root), /Prepared Wasm package changed/);
}
finally {
    fs.rmSync(root, { recursive: true, force: true });
} });
test('prepared snapshot rejects path escapes, source identity drift and artifact symlinks', () => { const { root, manifest } = fixture(); const file = path.join(root, 'manifest.json'); try {
    manifest.artifacts.native.path = '../outside';
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => loadPrepared(root), /escaped/);
    manifest.artifacts.native.path = 'omni-rs';
    manifest.executionInputs[0].sha256 = 'changed';
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => loadPrepared(root), /execution inputs changed/);
    manifest.executionInputs = executionSnapshot();
    fs.writeFileSync(file, JSON.stringify(manifest));
    fs.renameSync(path.join(root, 'omni-rs'), path.join(root, 'real-native'));
    fs.symlinkSync('real-native', path.join(root, 'omni-rs'));
    assert.throws(() => loadPrepared(root), /symlinks/);
}
finally {
    fs.rmSync(root, { recursive: true, force: true });
} });
test('prepared snapshot binds semantic catalogue and reference build without rebuilding', () => { const { root, manifest } = fixture(); const file = path.join(root, 'manifest.json'), receiptFile = path.join(repo, 'forceteki/build/.swu-reference-build.json'), beforeReceipt = fs.existsSync(receiptFile) ? fs.readFileSync(receiptFile) : null; try {
    manifest.catalogueSemanticSha256 = 'wrong';
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => loadPrepared(root), /semantic catalogue/);
    manifest.catalogueSemanticSha256 = sha256(Buffer.from(JSON.stringify({ cards: [], schema: 'synthetic-test-only' })));
    manifest.engineBuild.buildSha256 = 'wrong';
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => loadPrepared(root), /Prepared engine build changed/);
    assert.deepEqual(fs.existsSync(receiptFile) ? fs.readFileSync(receiptFile) : null, beforeReceipt, 'Verifier must not create or rewrite the engine build receipt');
}
finally {
    fs.rmSync(root, { recursive: true, force: true });
} });
test('Wasm package hashes include nested files and reject file or directory symlinks', () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swu-wasm-package-test-')); try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'loader.js'), 'initial');
    const before = packageHashes(root);
    assert.equal(before['nested/loader.js'], sha256(Buffer.from('initial')));
    fs.writeFileSync(path.join(root, 'nested', 'loader.js'), 'changed');
    assert.notDeepEqual(packageHashes(root), before);
    fs.symlinkSync('loader.js', path.join(root, 'nested', 'linked.js'));
    assert.throws(() => packageHashes(root), /symlinks/);
    fs.unlinkSync(path.join(root, 'nested', 'linked.js'));
    fs.symlinkSync('nested', path.join(root, 'linked-directory'));
    assert.throws(() => packageHashes(root), /symlinks/);
}
finally {
    fs.rmSync(root, { recursive: true, force: true });
} });
test('incremental cache reuses one target, excludes concurrent builders, and full checkpoints leave cache intact',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'swu-cache-test-')),cache=path.join(root,'cache'),out=path.join(root,'prepared');try{fs.mkdirSync(out);const acquire=require('../pipeline/prepared').acquireBuildCache;const first=acquire({out,cache});assert.equal(first.mode,'incremental');assert.equal(first.target,path.join(cache,'target'));fs.mkdirSync(first.target);fs.writeFileSync(path.join(first.target,'sentinel'),'cached artifact');assert.throws(()=>acquire({out,cache}),/locked/);first.release();const second=acquire({out,cache});assert.equal(second.target,first.target);assert.equal(second.catalogue,first.catalogue);second.release();const full=acquire({out,cache,full:true});assert.equal(full.mode,'full-checkpoint');assert.equal(full.target,path.join(out,'build-target'));assert.equal(fs.readFileSync(path.join(first.target,'sentinel'),'utf8'),'cached artifact');full.release();}finally{fs.rmSync(root,{recursive:true,force:true});}});

test('asynchronous full checkpoint lease does not contend with the warm cache lease',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'swu-full-cache-test-')),cache=path.join(root,'cache'),out=path.join(root,'full');try{fs.mkdirSync(out);const acquire=require('../pipeline/prepared').acquireBuildCache;const warm=acquire({out,cache});const full=acquire({out,cache,full:true});assert.notEqual(full.target,warm.target);assert.throws(()=>acquire({out,cache}),/locked/);full.release();assert.throws(()=>acquire({out,cache}),/locked/);warm.release();}finally{fs.rmSync(root,{recursive:true,force:true});}});
