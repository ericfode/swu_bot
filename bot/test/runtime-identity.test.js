'use strict';
// Data-only image fixtures: no rules engine, submitted program, checker or deployment is executed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runtime = require('../arena/runtime-identity');
const identity = require('../arena/identity');
const { initialize } = require('../arena/provision');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-lineage-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function put(dir, name, value) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), value); }
function fixture() {
    const dir = fs.mkdtempSync(path.join(root, 'case-')), old = path.join(dir, 'old'), source = path.join(dir, 'source'), image = path.join(dir, 'image');
    for (const r of [old, source]) {
        for (const d of ['server/src', 'bot', 'vendor/kessel', 'vendor/jepa']) fs.mkdirSync(path.join(r, d), { recursive: true });
        for (const f of ['package.json', 'server/package.json', 'server/package-lock.json']) put(r, f, '{}');
        put(r, 'bot/match.js', 'unchanged execution fixture'); put(r, 'bot/arena/adapter.js', r === old ? 'old adapter' : 'reviewed adapter');
    }
    put(old, 'BUILD_SHA', 'a'.repeat(40)); put(old, 'CARDS_SHA', 'b'.repeat(64));
    const policy = { schema: 'swu-compatible-runtime/1', baseBuild: 'a'.repeat(40), cards: 'b'.repeat(64),
        baseImage: 'registry.fly.io/swu-arena-games@sha256:' + 'c'.repeat(64), engineRef: 'd'.repeat(40),
        baseSourceSha256: runtime.hash(runtime.sourceFiles(old)), requiredCore: ['bot/match.js'], changes: {
            'bot/arena/adapter.js': { before: runtime.hash('old adapter'), after: runtime.hash('reviewed adapter') }
        } };
    const baseline = runtime.capture(old, policy);
    fs.cpSync(old, image, { recursive: true }); fs.cpSync(source, image, { recursive: true });
    const seal = () => runtime.seal(image, source, baseline, { build: 'e'.repeat(40), engineRef: policy.engineRef, policy });
    return { old, source, image, policy, baseline, seal };
}

test('only an exact reviewed controller overlay retains the immutable engine lineage', () => {
    const f = fixture(); const proof = f.seal();
    assert.equal(proof.controllerBuild, 'e'.repeat(40)); assert.equal(proof.engineBuild, 'a'.repeat(40));
    assert.equal(runtime.engineBuild(f.image, proof.controllerBuild, proof.cards, { full: true, policy: f.policy }), f.policy.baseBuild);
    assert.equal(fs.readFileSync(path.join(f.image, 'bot/match.js'), 'utf8'), 'unchanged execution fixture');
});
for (const [name, mutate, why] of [
    ['engine changes', (f) => { put(f.source, 'bot/match.js', 'changed engine'); put(f.image, 'bot/match.js', 'changed engine'); }, /unreviewed runtime/],
    ['unknown source additions', (f) => { put(f.source, 'bot/new-engine.js', 'new'); put(f.image, 'bot/new-engine.js', 'new'); }, /unreviewed runtime/],
    ['deleted source retained by COPY', (f) => fs.unlinkSync(path.join(f.source, 'bot/match.js')), /overlay differs/],
    ['unapproved adapter bytes', (f) => { put(f.source, 'bot/arena/adapter.js', 'different adapter'); put(f.image, 'bot/arena/adapter.js', 'different adapter'); }, /controller transition differs/],
    ['changed card identity', (f) => put(f.image, 'CARDS_SHA', 'f'.repeat(64)), /card data identity changed/],
    ['modified baseline', (f) => { f.baseline.files['bot/match.js'].sha256 = 'f'.repeat(64); }, /baseline differs/]
]) test(`rollout refuses ${name} before sealing`, () => {
    const f = fixture(); mutate(f); assert.throws(f.seal, why); assert.equal(fs.existsSync(path.join(f.image, 'ENGINE_IDENTITY.json')), false);
});
test('an engine-pin change and unknown controller provenance cannot reuse the namespace', () => {
    const f = fixture();
    for (const args of [{ build: 'unknown', engineRef: f.policy.engineRef }, { build: 'e'.repeat(40), engineRef: 'f'.repeat(40) }]) {
        assert.throws(() => runtime.seal(f.image, f.source, f.baseline, { ...args, policy: f.policy }), /unchanged engine pin/);
    }
    f.policy.requiredCore.push('bot/arena/adapter.js'); assert.throws(f.seal, /execution component/);
});
test('runtime verification rejects post-seal changes and contradictory provenance', () => {
    const f = fixture(); f.seal();
    assert.throws(() => runtime.engineBuild(f.image, 'f'.repeat(40), f.policy.cards, { policy: f.policy }), /actual image/);
    assert.throws(() => runtime.engineBuild(f.image, 'e'.repeat(40), 'f'.repeat(64), { policy: f.policy }), /actual image/);
    const proofFile = path.join(f.image, 'ENGINE_IDENTITY.json'), proof = JSON.parse(fs.readFileSync(proofFile));
    for (const patch of [{ schema: 'unknown' }, { engineBuild: 'f'.repeat(40) }, { baseImage: f.policy.baseImage + '-foreign' }, { policySha256: 'f'.repeat(64) }]) {
        fs.writeFileSync(proofFile, JSON.stringify({ ...proof, ...patch }));
        assert.throws(() => runtime.engineBuild(f.image, 'e'.repeat(40), f.policy.cards, { policy: f.policy }), /actual image/);
    }
    fs.writeFileSync(proofFile, JSON.stringify(proof));
    put(f.image, 'bot/match.js', 'tampered');
    assert.throws(() => runtime.engineBuild(f.image, 'e'.repeat(40), f.policy.cards, { policy: f.policy, full: true }), /execution source differs/);
    put(f.image, 'bot/arena/adapter.js', 'tampered');
    assert.throws(() => runtime.engineBuild(f.image, 'e'.repeat(40), f.policy.cards, { policy: f.policy }), /controller source differs/);
});

test('the actual reviewed source retains the occupied context and historical bytes without restamping', (t) => {
    const app = path.resolve(__dirname, '../..'), policy = require('../arena/compatible-runtime.json');
    if (spawnSync('git', ['cat-file', '-e', `${policy.baseBuild}^{commit}`], { cwd: app, stdio: 'ignore' }).status !== 0) {
        t.skip('requires the historical source commit; synthetic transition guards still run in source-only snapshots'); return;
    }
    const old = path.join(root, 'historical-source'), image = path.join(root, 'actual-source');
    const runGit = (args) => { const r = spawnSync('git', args, { cwd: app, maxBuffer: 64 << 20 }); assert.equal(r.status, 0, String(r.stderr)); return r.stdout; };
    // Git objects are trusted source data. File contents are hashed/copied only, never imported or executed.
    const rows = runGit(['ls-tree', '-r', policy.baseBuild, '--', ...runtime.ROOTS]).toString().trim().split('\n');
    for (const row of rows) {
        const [meta, name] = row.split('\t'); if (runtime.ignored(name)) continue;
        const [mode, kind, sha] = meta.split(' '); assert.equal(kind, 'blob');
        put(old, name, runGit(['cat-file', 'blob', sha])); fs.chmodSync(path.join(old, name), mode === '100755' ? 0o755 : 0o644);
    }
    put(old, 'BUILD_SHA', policy.baseBuild); put(old, 'CARDS_SHA', policy.cards);
    const baseline = runtime.capture(old);
    fs.cpSync(old, image, { recursive: true });
    for (const name of Object.keys(runtime.sourceFiles(app))) { put(image, name, fs.readFileSync(path.join(app, name))); fs.chmodSync(path.join(image, name), fs.statSync(path.join(app, name)).mode & 0o777); }
    // Policy is immutable build metadata rather than a runtime component; COPY it as Docker does.
    put(image, 'bot/arena/compatible-runtime.json', fs.readFileSync(path.join(app, 'bot/arena/compatible-runtime.json')));
    runtime.seal(image, app, baseline, { build: 'e'.repeat(40), engineRef: policy.engineRef });
    const expected = identity.contextFor({ arenaId: 'v2', build: policy.baseBuild, cards: policy.cards });
    assert.deepEqual(identity.imageContext({ root: image, arenaId: 'v2', build: 'e'.repeat(40), cards: policy.cards }), expected);
    const configFile = require('node:url').pathToFileURL(path.join(app, 'server/src/games/Config.ts')).href;
    const read = spawnSync(process.execPath, ['--input-type=module', '-e', `const {readConfig}=await import(${JSON.stringify(configFile)}); const c=readConfig({ARENA_ID:'v2',GAMES_APP:process.argv[1]}); process.stdout.write(JSON.stringify({context:c.context,build:c.build}));`, image], { encoding: 'utf8' });
    assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout), { context: expected, build: 'e'.repeat(40) }, 'TS config uses the same engine context and keeps the actual controller build');
    const data = path.join(root, 'occupied'); const before = initialize({ data, context: expected });
    const rosterFile = path.join(before.home, 'roster.json'), standingsFile = path.join(before.home, 'standings.json');
    fs.writeFileSync(rosterFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(rosterFile)), agents: [{ name: 'kim' }] }));
    fs.writeFileSync(standingsFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(standingsFile)), rounds: [{ round: 0, context: expected }], global: { 'kim-v1': 1500 } }));
    put(before.home, 'versions/kim-v1/SUBMISSION.json', JSON.stringify({ name: 'kim-v1', compatibility: { negotiatedProtocol: 2, context: expected } }));
    put(before.results, 'old/game.jsonl', JSON.stringify({ t: 'end', context: expected, requiredProtocol: 2, protocols: { p1: 2, p2: 2 } }));
    const files = ['ARENA.json', 'roster.json', 'standings.json', 'versions/kim-v1/SUBMISSION.json'].map((n) => path.join(before.home, n));
    files.push(path.join(before.results, 'old/game.jsonl'));
    const snapshots = files.map((p) => fs.readFileSync(p));
    initialize({ data, context: identity.imageContext({ root: image, arenaId: 'v2', build: 'e'.repeat(40), cards: policy.cards }) });
    files.forEach((p, n) => assert.deepEqual(fs.readFileSync(p), snapshots[n]));
    fs.unlinkSync(path.join(image, 'ENGINE_IDENTITY.json'));
    const foreign = identity.imageContext({ root: image, arenaId: 'v2', build: 'e'.repeat(40), cards: policy.cards });
    assert.equal(identity.contextMatches(foreign, expected), false, 'without a sealed lineage a new build retains the original conservative boundary');
    assert.throws(() => initialize({ data, context: foreign }), /another or unavailable/);
    files.forEach((p, n) => assert.deepEqual(fs.readFileSync(p), snapshots[n]));
});
