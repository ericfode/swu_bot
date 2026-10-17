'use strict';
// Canonical packing and trusted metadata only; the inert wasm is never executed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-round-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const imageId = (name, fallback) => {
    try { return fs.readFileSync(path.join(repo, name), 'utf8').trim(); }
    catch (e) { if (e.code !== 'ENOENT') throw e; return fallback; }
};
const build = imageId('BUILD_SHA', 'b'.repeat(40)), cards = imageId('CARDS_SHA', 'c'.repeat(64));
const context = require('../arena/identity').contextFor({ arenaId: 'v2', build, cards });
const { bundleDigest, verification } = require('../arena/compatibility');
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const fixture = (name) => {
    const data = path.join(tmp, name), version = path.join(data, 'arenas/v2/arena/versions/fixturebot-v1');
    const bundle = path.join(version, 'bundle');
    fs.mkdirSync(bundle, { recursive: true });
    fs.mkdirSync(path.join(data, 'bundles'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'bot.wasm'), Buffer.from('0061736d0100000001040160000003020100070a01065f737461727400000a040102000b', 'hex'));
    put(path.join(bundle, 'arena.json'), { schema: 'swu-arena-bot/1', protocol: 2, kind: 'wasm',
        platform: 'wasm32-wasip1', runtime: 'wasi-p1', run: { cmd: './bot.wasm' } });
    const digest = bundleDigest(bundle);
    const meta = { name: 'fixturebot-v1', agent: 'fixturebot', version: 1, bot: { kind: 'wasm' }, bundleSha256: digest,
        compatibility: verification({ negotiatedProtocol: 2 }, digest, build, context) };
    put(path.join(version, 'SUBMISSION.json'), meta);
    return { data, version, bundle, digest, meta };
};
const verify = (f) => spawnSync(process.execPath, ['bot/arena/gamesctl.js', 'verify-round', '--arena', 'v2', '--round', '7', '--bots', 'fixturebot-v1'], {
    cwd: repo, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', ARENA_ID: 'v2', GAMES_DATA: f.data,
        GAMES_BUILD: build, GAMES_CARDS: cards }, encoding: 'utf8', timeout: 15000
});

test('frozen round verifier binds current admission and final canonical bytes without round mutations', () => {
    const f = fixture('valid'), r = verify(f);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { round: 7, bots: ['fixturebot-v1'], arena: 'v2', requiredProtocol: 2,
        context, bundles: { 'fixturebot-v1': f.digest } });
    assert.equal(fs.existsSync(path.join(f.data, 'arenas/v2/results')), false);
    assert.equal(fs.existsSync(path.join(f.data, 'arenas/v2/server')), false);
});

test('frozen round verifier refuses changed bytes and stale context while preserving admission evidence', () => {
    for (const mutation of ['bytes', 'context']) {
        const f = fixture(mutation);
        if (mutation === 'bytes') fs.writeFileSync(path.join(f.bundle, 'fixture.txt'), 'changed after admission');
        else { f.meta.compatibility.context.engineRevision = '0'.repeat(64); put(path.join(f.version, 'SUBMISSION.json'), f.meta); }
        const before = fs.readFileSync(path.join(f.version, 'SUBMISSION.json'), 'utf8');
        const r = verify(f);
        assert.notEqual(r.status, 0, `${mutation} must be refused`);
        assert.match(r.stderr, /compatibility rejected|verified admission/);
        assert.equal(fs.readFileSync(path.join(f.version, 'SUBMISSION.json'), 'utf8'), before);
        assert.deepEqual(fs.readdirSync(path.join(f.data, 'bundles')), []);
    }
});
