'use strict';
// The opponent catalog reads trusted synthetic bundles and fake downloads only; no WASM is started here.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createOpponents } = require('../arena/opponents');
const { createSwarmRelay } = require('../arena/swarm-relay');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-opponents-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const BUNDLE_PY = path.join(__dirname, '../compiled/bundle.py');
const WASM = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const MAX_TAR_BYTES = (64 << 20) + (4 << 20);
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const at = '2026-10-17T12:00:00.000Z';
const CONTEXT = { schema: 1, arenaId: 'v2', protocol: 2, engineRevision: 'e'.repeat(64), runnerRevision: 'swu-arena-v2/1' };
const evidence = (hex, change = {}) => ({ schema: 'swu-arena-compatibility/1', negotiatedProtocol: 2, bundleSha256: hex,
    checkerBuild: 'c'.repeat(40), checkedAt: at, context: { ...CONTEXT }, ...change });

function fixture(overrides = {}, files = {}) {
    const dir = fs.mkdtempSync(path.join(tmp, 'fixture-'));
    const manifest = { schema: 'swu-arena-bot/1', protocol: 2, kind: 'wasm', platform: 'wasm32-wasip1', runtime: 'wasi-p1',
        run: { cmd: './bot.wasm', args: [], env: {} }, entry_sha256: hash(WASM), network: 'none',
        build: { commit: 'a'.repeat(40), toolchain: 'javy 8.0.0', source: 'private-source-marker', owner: 'private-owner-marker', token: 'private-token-marker' },
        ...overrides };
    for (const [name, bytes] of Object.entries({ 'arena.json': JSON.stringify(manifest), 'bot.wasm': WASM, ...files })) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), bytes);
    }
    // Reuse the established packer, without running the fixture's entry point.
    const tar = execFileSync('python3', ['-I', BUNDLE_PY, 'tar', dir]);
    return { tar, sha256: hash(tar) };
}

function catalog(entries, { allowed = (who) => who === 'pal', compatibility, context = () => CONTEXT } = {}) {
    const state = { reads: [], lineupReads: 0, data: { round: 7, capMs: 30000, at,
        bots: entries.map((f, i) => ({ name: `fixture${i}-v1`, bundle: f.sha256, bytes: f.tar.length })) },
        evidence: new Map(entries.map((f, i) => [`fixture${i}-v1`, evidence(f.sha256)])) };
    const swarm = { lineup: async () => { state.lineupReads++; return state.data; },
        readBot: async (hex) => { state.reads.push(hex); return entries.find((f) => f.sha256 === hex)?.tar ?? null; } };
    const arena = new Proxy({}, { get() { throw new Error('private arena history must never be read'); } });
    return { state, swarm, opponents: createOpponents({ swarm, allowed, arena, context,
        compatibility: compatibility ?? ((name) => state.evidence.get(name)) }) };
}

function rewriteHeader(tar, offset, change) {
    const next = Buffer.from(tar);
    const h = next.subarray(offset, offset + 512);
    change(h);
    h.fill(32, 148, 156);
    h.write(`${h.reduce((sum, n) => sum + n, 0).toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    return next;
}

test('opponents: authorization precedes all lineup and bundle reads', async () => {
    const { opponents, state } = catalog([fixture()]);
    for (const call of [() => opponents.list('stranger'), () => opponents.get('stranger', { sha256: 'a'.repeat(64) }),
        () => opponents.bytes('stranger', 'a'.repeat(64))]) await assert.rejects(call, { code: 'forbidden' });
    assert.equal(state.lineupReads, 0);
    assert.deepEqual(state.reads, []);
    await assert.rejects(createOpponents({ swarm: {} }).list('pal'), { code: 'forbidden' });
});

test('opponents: current canonical bundles have exact hash URLs and only whitelisted provenance', async () => {
    const f = fixture();
    const { opponents } = catalog([f]);
    const descriptor = { name: 'fixture0-v1', sha256: f.sha256, bytes: f.tar.length, protocol: 2, runtime: 'wasi-p1',
        context: CONTEXT, compatibility: evidence(f.sha256),
        url: `/api/opponents/${f.sha256}.tar`, provenance: { source: 'latest_round', round: 7, commit: 'a'.repeat(40), toolchain: 'javy 8.0.0' } };
    assert.deepEqual(await opponents.list('pal'), { context: CONTEXT, round: 7, capMs: 30000, at, opponents: [descriptor] });
    assert.deepEqual(await opponents.get('pal', { sha256: f.sha256, name: descriptor.name }), descriptor);
    assert.deepEqual(await opponents.bytes('pal', f.sha256), f.tar);
    assert.doesNotMatch(JSON.stringify(descriptor), /private-|owner|token|source-marker/);
    // The established canonical unpacker agrees with this synthetic fixture, without loading its program.
    const tarFile = path.join(tmp, 'fixture.tar');
    fs.writeFileSync(tarFile, f.tar);
    execFileSync('python3', ['-I', BUNDLE_PY, 'unpack', tarFile, path.join(tmp, 'unpacked'), f.sha256]);
});

test('opponents: exact-digest observed v2 evidence and matching arena context are required before any bundle read', async () => {
    const f = fixture();
    const { opponents, state } = catalog([f]);
    const invalid = [null, { checked: true }, evidence(f.sha256, { schema: 'other' }), evidence(f.sha256, { negotiatedProtocol: 1 }),
        evidence(f.sha256, { negotiatedProtocol: '2' }), evidence('0'.repeat(64)), evidence(f.sha256, { checkerBuild: 'unknown' }),
        evidence(f.sha256, { checkedAt: 'not a date' }), evidence(f.sha256, { context: null }),
        evidence(f.sha256, { context: { ...CONTEXT, arenaId: 'open' } }),
        evidence(f.sha256, { context: { ...CONTEXT, engineRevision: 'f'.repeat(64) } }),
        evidence(f.sha256, { context: { ...CONTEXT, runnerRevision: 'another-runner' } })];
    for (const observed of invalid) {
        state.evidence.set('fixture0-v1', observed);
        assert.deepEqual((await opponents.list('pal')).opponents, []);
        await assert.rejects(opponents.get('pal', { sha256: f.sha256 }), { code: 'unavailable' });
    }
    assert.deepEqual(state.reads, []);
    const defaultGate = catalog([f]);
    const noEvidence = createOpponents({ swarm: defaultGate.swarm, allowed: () => true, context: () => CONTEXT });
    assert.deepEqual((await noEvidence.list('pal')).opponents, []);
    assert.deepEqual(defaultGate.state.reads, []);
    for (const active of [null, {}, { ...CONTEXT, arenaId: 'open' }, { ...CONTEXT, protocol: 1 },
        { ...CONTEXT, engineRevision: 'not-a-verified-hash' }, { ...CONTEXT, engineRevision: 'E'.repeat(64) }]) {
        const invalidContext = catalog([f], { context: () => active });
        await assert.rejects(invalidContext.opponents.list('pal'), { code: 'unavailable' });
        assert.equal(invalidContext.state.lineupReads, 0);
    }
    state.evidence.set('fixture0-v1', { ...evidence(f.sha256), context: { ...CONTEXT, token: 'private-token-marker' }, owner: 'private-owner-marker', token: 'private-token-marker' });
    assert.deepEqual((await opponents.get('pal', { sha256: f.sha256 })).compatibility, evidence(f.sha256));
});

test('opponents: lookup cannot enumerate private, retired, or mismatched versions', async () => {
    const current = fixture();
    const hidden = fixture({ build: { commit: 'b'.repeat(40) } });
    const { opponents, state } = catalog([current, hidden]);
    state.data.bots.pop();
    await assert.rejects(opponents.get('pal', { sha256: hidden.sha256 }), { code: 'not_found' });
    await assert.rejects(opponents.get('pal', { sha256: current.sha256, name: 'other-v2' }), { code: 'not_found' });
    for (const input of [{ sha256: '../secret' }, { sha256: 'A'.repeat(64) }, { sha256: current.sha256, name: '../private-v1' }, {}, null]) {
        await assert.rejects(opponents.get('pal', input), { code: 'bad_request' });
    }
    assert.deepEqual(state.reads, []);
    state.data.bots = [];
    await assert.rejects(opponents.bytes('pal', current.sha256), { code: 'not_found' });
});

test('opponents: only numeric v2 WASI bundles with supported manifests are listed', async () => {
    const invalid = [
        { protocol: 1 }, { protocol: '2' }, { schema: 'other' }, { kind: 'native' }, { platform: 'linux/amd64' },
        { runtime: 'unknown' }, { network: 'host' }, { cards: { use: 'mount' } },
        { run: { cmd: '../bot.wasm' } }, { run: { cmd: './missing.wasm' } }, { run: { cmd: './bot.wasm', args: [1] } },
        { run: { cmd: './bot.wasm', env: { HTTPS_PROXY: 'private-marker' } } }, { entry_sha256: '0'.repeat(64) }
    ].map((m) => fixture(m));
    const valid = fixture();
    const { opponents } = catalog([valid, ...invalid]);
    assert.deepEqual((await opponents.list('pal')).opponents.map((x) => x.sha256), [valid.sha256]);
    for (const f of invalid) await assert.rejects(opponents.get('pal', { sha256: f.sha256 }), { code: 'unavailable' });
});

test('opponents: pinned interpreter runtime is discoverable without executing its source', async () => {
    const source = 'raise RuntimeError("this fixture must never be run")\n';
    const f = fixture({ runtime: 'python-3.14-wasi', run: { cmd: 'python3', args: ['bot.py'], env: {} }, entry_sha256: hash(source) }, { 'bot.py': source });
    const { opponents } = catalog([f]);
    assert.equal((await opponents.get('pal', { sha256: f.sha256 })).runtime, 'python-3.14-wasi');
});

test('opponents: hash mismatches and malformed archives fail closed', async () => {
    const f = fixture();
    const badName = (name) => (h) => { h.fill(0, 0, 100); h.write(name, 0, 'utf8'); };
    const entryOffset = 512 + Math.ceil(Number.parseInt(f.tar.subarray(124, 136).toString('ascii'), 8) / 512) * 512;
    const changed = [
        rewriteHeader(f.tar, 0, badName('../arena.json')),
        rewriteHeader(f.tar, 0, (h) => { h[156] = 50; }), // symlink, not a regular manifest
        rewriteHeader(f.tar, 0, (h) => { h[156] = 49; }), // hardlink
        rewriteHeader(f.tar, 0, (h) => { h.write('00000000001\0', 136, 12); }), // noncanonical mtime
        rewriteHeader(f.tar, entryOffset, badName('../escape.wasm')),
        rewriteHeader(f.tar, entryOffset, badName('arena.json')),
        f.tar.subarray(0, 1024),
        Buffer.from(f.tar)
    ];
    changed.at(-1)[0] ^= 1; // invalid header checksum
    const invalid = changed.map((tar) => ({ tar, sha256: hash(tar) }));
    invalid.push(fixture({}, { 'arena.json': '{bad json' }));
    invalid.push({ tar: Buffer.from(f.tar), sha256: '0'.repeat(64) });
    const { opponents } = catalog(invalid);
    assert.deepEqual((await opponents.list('pal')).opponents, []);
});

test('opponents: unavailable data and untrusted metadata do not leak errors or arbitrary fields', async () => {
    const f = fixture({ build: { commit: 'not a commit/private-marker', toolchain: 'https://user:password@private-marker' } });
    const { opponents, state, swarm } = catalog([f]);
    state.data.bots.push({ name: '../private-v1', bundle: '0'.repeat(64), bytes: 10 });
    state.data.bots.push({ name: 'oversized-v1', bundle: '1'.repeat(64), bytes: MAX_TAR_BYTES + 1 });
    const listed = await opponents.list('pal');
    assert.deepEqual(listed.opponents[0].provenance, { source: 'latest_round', round: 7 });
    assert.equal(listed.opponents.length, 1);
    swarm.readBot = async () => { throw new Error('private-token-marker'); };
    await assert.rejects(opponents.get('pal', { sha256: f.sha256 }), { code: 'unavailable' });
    assert.deepEqual((await opponents.list('pal')).opponents, []);
    swarm.lineup = async () => { throw new Error('private-token-marker'); };
    await assert.rejects(opponents.list('pal'), { code: 'unavailable', message: 'the latest arena lineup is unavailable; try again later' });
});

function relayMachine(f) {
    const state = { now: 1, bots: [{ name: 'fixture-v1', bundle: f.sha256, bytes: f.tar.length }], asked: [] };
    state.fetch = async (url, options) => {
        const p = new URL(url).pathname;
        state.asked.push(p);
        if (p === '/v1/swarm/lineup.json') return new Response(JSON.stringify({ round: 7, bots: state.bots }));
        assert.equal(p, `/v1/swarm/bot/${f.sha256}`);
        assert.equal(options.redirect, 'error', 'a bundle cannot redirect the helper token');
        return new Response(f.tar);
    };
    return state;
}

test('relay readBot: only current hashes are fetched; disk cache bytes are rehashed and never follow links', async () => {
    const f = fixture();
    const machine = relayMachine(f);
    const botDir = fs.mkdtempSync(path.join(tmp, 'relay-cache-'));
    const relay = createSwarmRelay({ token: 'fake-helper-token', machine: 'http://fake-games', botDir, fetchImpl: machine.fetch, now: () => machine.now });
    assert.deepEqual(await relay.readBot(f.sha256), f.tar);
    const raw = path.join(botDir, `${f.sha256}.tar`);
    fs.writeFileSync(raw, Buffer.alloc(f.tar.length, 1));
    assert.equal(await relay.readBot(f.sha256), null, 'cache corruption is not returned under a trusted hash');
    fs.unlinkSync(raw);
    const outside = path.join(tmp, 'outside.tar');
    fs.writeFileSync(outside, f.tar);
    fs.symlinkSync(outside, raw);
    assert.equal(await relay.readBot(f.sha256), null, 'cache links are not followed');
    fs.unlinkSync(raw);
    fs.writeFileSync(raw, f.tar);
    fs.truncateSync(raw, MAX_TAR_BYTES + 1);
    assert.equal(await relay.readBot(f.sha256), null, 'oversized cache file is rejected before reading');
    machine.bots = [];
    machine.now += 61000;
    assert.equal(await relay.readBot(f.sha256), null, 'an old cached hash becomes ineligible with the next lineup');
    assert.equal(await relay.readBot('../private'), null);
    assert.equal(await relay.readBot('0'.repeat(64)), null);
    assert.equal(machine.asked.filter((p) => p.startsWith('/v1/swarm/bot/')).length, 1);
});

test('relay readBot: declared size and transport hash must match', async () => {
    const f = fixture();
    const machine = relayMachine(f);
    machine.bots[0].bytes++;
    const relay = createSwarmRelay({ token: 'fake', fetchImpl: machine.fetch });
    assert.equal(await relay.readBot(f.sha256), null);
    const wrong = relayMachine(f);
    const fetchImpl = async (url, options) => new URL(url).pathname.endsWith('lineup.json')
        ? wrong.fetch(url, options) : new Response(Buffer.from('wrong bytes'));
    assert.equal(await createSwarmRelay({ token: 'fake', fetchImpl }).readBot(f.sha256), null);
    const botDir = fs.mkdtempSync(path.join(tmp, 'invalid-lineup-'));
    fs.writeFileSync(path.join(botDir, 'lineup.json'), JSON.stringify({ round: 7, bots: {} }));
    assert.equal(await createSwarmRelay({ token: null, botDir }).readBot(f.sha256), null, 'a malformed saved lineup is unavailable');
});

test('relay readBot: an oversized advertised response is cancelled before buffering', async () => {
    const f = fixture();
    let cancelled = false;
    let buffered = false;
    const fetchImpl = async (url) => new URL(url).pathname.endsWith('lineup.json')
        ? new Response(JSON.stringify({ round: 7, bots: [{ name: 'fixture-v1', bundle: f.sha256, bytes: f.tar.length }] }))
        : { status: 200, headers: { get: (key) => key === 'content-length' ? String(MAX_TAR_BYTES + 1) : null },
            body: { cancel: async () => { cancelled = true; } }, arrayBuffer: async () => { buffered = true; return f.tar; } };
    assert.equal(await createSwarmRelay({ token: 'fake', fetchImpl }).readBot(f.sha256), null);
    assert.equal(cancelled, true);
    assert.equal(buffered, false);
});

test('relay readBot: streamed responses without a length are bounded and cancelled', async () => {
    const f = fixture();
    let cancelled = false;
    const chunk = new Uint8Array(MAX_TAR_BYTES + 1);
    const fetchImpl = async (url) => new URL(url).pathname.endsWith('lineup.json')
        ? new Response(JSON.stringify({ round: 7, bots: [{ name: 'fixture-v1', bundle: f.sha256, bytes: f.tar.length }] }))
        : { status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ value: chunk, done: false }),
            cancel: async () => { cancelled = true; }, releaseLock: () => {} }) } };
    assert.equal(await createSwarmRelay({ token: 'fake', fetchImpl }).readBot(f.sha256), null);
    assert.equal(cancelled, true);
});
