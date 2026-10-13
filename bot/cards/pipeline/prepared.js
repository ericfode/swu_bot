'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { sha256 } = require('../inventory');
const { compileCatalog } = require('../../card-compiler/build');
const { implementationSnapshot } = require('./review');
const reference = require('../reference/generate');
const repo = path.resolve(__dirname, '../../..');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function command(exe, args, env) { const r = spawnSync(exe, args, { cwd: repo, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); if (r.error)
    throw r.error; assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout; }
function packageHashes(dir) { const rows = []; for (const relative of fs.readdirSync(dir, { recursive: true }).sort()) {
    const file = path.join(dir, relative), stat = fs.lstatSync(file);
    assert.ok(!stat.isSymbolicLink(), 'Prepared Wasm files cannot be symlinks');
    if (stat.isFile())
        rows.push([relative.split(path.sep).join('/'), sha256(fs.readFileSync(file))]);
} return Object.fromEntries(rows); }
function executionSnapshot() {
    const files = new Set(['package.json', 'package-lock.json', 'bot/omni-wasm/build.js']);
    for(const file of fs.readdirSync(path.join(repo,'bot')).filter(f=>/\.(js|mjs)$/.test(f)))files.add('bot/'+file);
    for(const file of fs.readdirSync(path.join(repo,'bot/omni')).filter(f=>/\.(js|mjs)$/.test(f)))files.add('bot/omni/'+file);
    for (const dir of ['bot/cards/reference', 'bot/omni/wasm', 'bot/omni/rs', 'bot/card-compiler', 'bot/players', 'bot/examples', 'bot/eval', 'bot/learned'])
        for (const f of fs.readdirSync(path.join(repo, dir), { recursive: true }).filter(f => /\.(?:js|mjs|json)$/.test(f) && !f.startsWith('generated' + path.sep) && !(dir === 'bot/cards/reference' && f.startsWith('fixtures' + path.sep))))
            files.add(dir + '/' + f);
    return [...files].sort().map(file => ({ path: file, sha256: sha256(fs.readFileSync(path.join(repo, file))) }));
}
function artifact(root, relative) { assert.equal(typeof relative, 'string'); const file = path.resolve(root, relative); assert.ok(file.startsWith(root + path.sep), 'Prepared artifact escaped directory'); assert.equal(fs.realpathSync(file), file, 'Prepared artifacts cannot be symlinks'); return file; }
function loadPrepared(input) {
    const resolved = path.resolve(input), file = fs.statSync(resolved).isDirectory() ? path.join(resolved, 'manifest.json') : resolved, root = fs.realpathSync(path.dirname(file)), bytes = fs.readFileSync(file), m = JSON.parse(bytes);
    assert.equal(m.schema, 'swu-card-pipeline-prepared/v1');
    assert.deepEqual(Object.keys(m.artifacts).sort(), ['admission', 'catalogue', 'native', 'pool', 'rules']);
    assert.ok(m.wasmPackage.files['omni_wasm.js'] && m.wasmPackage.files['omni_wasm_bg.wasm'], 'Prepared Wasm loader/binary missing');
    assert.equal(m.nodeVersion, process.version, 'Prepared Node version differs');
    const paths = {};
    for (const [key, row] of Object.entries(m.artifacts)) {
        const p = artifact(root, row.path);
        assert.equal(sha256(fs.readFileSync(p)), row.sha256, 'Prepared ' + key + ' changed');
        paths[key] = p;
    }
    const wasmPackage = artifact(root, m.wasmPackage.path);
    assert.deepEqual(packageHashes(wasmPackage), m.wasmPackage.files, 'Prepared Wasm package changed');
    assert.deepEqual(executionSnapshot(), m.executionInputs, 'Prepared execution inputs changed');
    assert.equal(sha256(Buffer.from(JSON.stringify(JSON.parse(fs.readFileSync(paths.catalogue))))), m.catalogueSemanticSha256, 'Prepared semantic catalogue differs');
    assert.deepEqual(implementationSnapshot(), m.implementationBefore, 'Implementation changed since preparation');
    reference.verifyPreparedEngine(m.engineBuild);
    assert.deepEqual(reference.sourceIdentity(), m.sourceIdentity, 'Reference inputs changed since preparation');
    return { directory: root, cataloguePath: paths.catalogue, catalogueSha256: m.artifacts.catalogue.sha256, catalogue: JSON.parse(fs.readFileSync(paths.catalogue)), admission: JSON.parse(fs.readFileSync(paths.admission)), pool: JSON.parse(fs.readFileSync(paths.pool)), rules: JSON.parse(fs.readFileSync(paths.rules)), native: paths.native, wasmPackage, implementationBefore: m.implementationBefore, engineBuild: m.engineBuild, buildMode: m.buildMode, sourceIdentity: m.sourceIdentity, manifestSha256: sha256(bytes), manifestPath: file };
}
function acquireBuildCache({ out, cache, full = false } = {}) {
    assert.equal(typeof full, 'boolean', 'full must be a boolean checkpoint option');
    if(full)assert.ok(out,'Full checkpoint needs a fresh output directory');
    const directory = full ? path.resolve(out) : path.resolve(cache ?? path.join(repo, 'target/card-pipeline-cache'));
    fs.mkdirSync(directory, { recursive: true });
    const lock = path.join(directory, 'build.lock'), token = require('node:crypto').randomUUID();
    try { write(lock, { token, pid: process.pid, host: require('node:os').hostname() }); }
    catch(error) { if(error.code === 'EEXIST') throw new Error('Pipeline build cache is locked; never steal a stale lock automatically: '+lock); throw error; }
    const target = full ? path.join(path.resolve(out), 'build-target') : cache === undefined ? path.join(repo, 'target') : path.join(directory, 'target');
    const catalogue = full ? path.join(path.resolve(out), 'catalog.json') : path.join(directory, 'catalog.json');
    return { target, catalogue, mode: full ? 'full-checkpoint' : 'incremental', release() { assert.equal(JSON.parse(fs.readFileSync(lock)).token, token, 'Build cache lock ownership changed'); fs.unlinkSync(lock); } };
}
async function prepare({ out, cache, full = false } = {}) {
    assert.ok(out, 'prepare needs --out NEW_DIRECTORY');
    out = path.resolve(out);
    assert.ok(!fs.existsSync(out), 'Use a fresh preparation directory');
    const implementationBefore = implementationSnapshot(), executionInputs = executionSnapshot(), referenceBefore = reference.sourceIdentity(), catalogue = compileCatalog();
    fs.mkdirSync(out, { recursive: true });
    const catalogFile = path.join(out, 'catalog.json');
    write(catalogFile, catalogue);
    const lease = acquireBuildCache({out,cache,full});
    try {
    const target = lease.target;
    if(lease.catalogue !== catalogFile && (!fs.existsSync(lease.catalogue) || !fs.readFileSync(lease.catalogue).equals(fs.readFileSync(catalogFile))))fs.copyFileSync(catalogFile,lease.catalogue);
    const env = { ...process.env, CARGO_TARGET_DIR: target, SWU_RULES_CATALOGUE: lease.catalogue };
    console.error('Preparing reference engine, native and Wasm once…');
    const engineBuild = reference.prepareEngine();
    command('cargo', ['build', '--locked', '--release', '-p', 'omni-rs'], env);
    command(process.execPath, ['bot/omni-wasm/build.js', '--target', 'node', '--out-dir', path.join(out, 'wasm')], env);
    const native = path.join(out, process.platform === 'win32' ? 'omni-rs.exe' : 'omni-rs');
    fs.copyFileSync(path.join(target, 'release', path.basename(native)), native);
    fs.chmodSync(native, 0o755);
    const poolFile = path.join(out, 'pool.json');
    write(path.join(out, 'admission.json'), JSON.parse(command(native, ['catalogue', catalogFile, '--out-pool', poolFile], env)));
    write(path.join(out, 'rules.json'), JSON.parse(command(native, ['rules', '--catalogue', catalogFile, '--pool', poolFile], env)));
    assert.deepEqual(implementationSnapshot(), implementationBefore, 'Implementation changed during preparation');
    reference.verifyPreparedEngine(engineBuild);
    const sourceIdentity = reference.sourceIdentity();
    for (const [key, value] of Object.entries(referenceBefore))
        if (key !== 'engineBuildSha256')
            assert.deepEqual(sourceIdentity[key], value, 'Reference input changed during preparation: ' + key);
    assert.deepEqual(executionSnapshot(), executionInputs, 'Execution input changed during preparation');
    const artifacts = {};
    for (const [key, name] of Object.entries({ catalogue: 'catalog.json', admission: 'admission.json', pool: 'pool.json', rules: 'rules.json', native: path.basename(native) }))
        artifacts[key] = { path: name, sha256: sha256(fs.readFileSync(path.join(out, name))) };
    const manifest = { schema: 'swu-card-pipeline-prepared/v1', nodeVersion: process.version, buildMode: lease.mode, implementationBefore, executionInputs, catalogueSemanticSha256: sha256(Buffer.from(JSON.stringify(catalogue))), engineBuild, sourceIdentity, artifacts, wasmPackage: { path: 'wasm/node', files: packageHashes(path.join(out, 'wasm/node')) } };
    write(path.join(out, 'manifest.json'), manifest);
    const verified = loadPrepared(out);
    return { ...verified, manifest: path.join(out, 'manifest.json'), cards: catalogue.cards.length };
    } finally { lease.release(); }
}
module.exports = { prepare, loadPrepared, packageHashes, executionSnapshot, acquireBuildCache };
