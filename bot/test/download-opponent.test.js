'use strict';
// Download and validate data only. The fixture has no WASI start function, and no bot or runner is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { downloadOpponent, arenaUrl, parseArgs, MAX_BYTES } = require('../arena/download-opponent');

const BUNDLE = path.join(__dirname, '..', 'compiled', 'bundle.py');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'download-opponent-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const WASM = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const TOKEN = 'fixture-existing-oauth-token';
const ORIGIN = 'https://arena.example';
let n = 0;
const fresh = () => path.join(tmp, `out-${++n}`);

function python(args) {
    const r = spawnSync('python3', ['-I', ...args], { maxBuffer: 80 << 20 });
    assert.equal(r.status, 0, String(r.stderr));
    return r.stdout;
}

function fixture(change = {}) {
    const folder = path.join(tmp, `fixture-${++n}`);
    fs.mkdirSync(folder);
    const manifest = { schema: 'swu-arena-bot/1', protocol: 2, kind: 'wasm', platform: 'wasm32-wasip1',
        runtime: 'wasi-p1', run: { cmd: './bot.wasm', args: [] }, network: 'none', entry_sha256: hash(WASM), ...change };
    fs.writeFileSync(path.join(folder, 'arena.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(folder, 'bot.wasm'), WASM);
    const tar = python([BUNDLE, 'tar', folder]);
    return { tar, hex: hash(tar) };
}

const good = fixture();
const descriptor = (bundle = good, change = {}) => ({ name: 'fixture-v1', sha256: bundle.hex, bytes: bundle.tar.length,
    protocol: 2, runtime: 'wasi-p1', url: `/api/opponents/${bundle.hex}.tar`,
    provenance: { source: 'latest_round', round: 12, commit: '123abcd', toolchain: 'fixture 1' }, ...change });

function fakeDownload({ bundle = good, desc = descriptor(bundle), descriptorResponse, bundleResponse } = {}) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 1) return descriptorResponse ?? new Response(JSON.stringify({ result: desc }));
        assert.equal(calls.length, 2, 'only the descriptor and exact hash bundle are requested');
        return bundleResponse ?? new Response(bundle.tar);
    };
    return { calls, fetchImpl };
}

function download(fake = fakeDownload(), options = {}) {
    return downloadOpponent({ arena: ORIGIN, name: 'fixture-v1', sha256: good.hex, out: fresh(), token: TOKEN,
        fetchImpl: fake.fetchImpl, ...options });
}

async function refused(fake, expected, options = {}) {
    const out = fresh();
    await assert.rejects(download(fake, { out, ...options }), expected);
    assert.equal(fs.existsSync(out), false, 'network and validation failure leaves no output');
}

test('opponent download verifies and unpacks canonical bytes with hash provenance, without executing them', async () => {
    const fake = fakeDownload();
    const out = fresh();
    const before = Date.now();
    const result = await download(fake, { out });
    assert.equal(result.origin, ORIGIN);
    assert.equal(result.name, 'fixture-v1');
    assert.equal(result.sha256, good.hex);
    assert.equal(result.bytes, good.tar.length);
    assert.equal(result.protocol, 2);
    assert.equal(result.executed, false);
    assert.ok(Date.parse(result.downloadedAt) >= before);
    assert.deepEqual(result.provenance, descriptor().provenance);
    const expected = path.join(fs.realpathSync(out), `fixture-v1-${good.hex}`);
    assert.equal(result.folder, path.join(expected, 'fixture-v1'));
    assert.equal(result.record, path.join(expected, 'provenance.json'));
    assert.deepEqual(fs.readdirSync(out), [`fixture-v1-${good.hex}`]);
    assert.deepEqual(fs.readFileSync(path.join(result.folder, 'bot.wasm')), WASM);
    assert.deepEqual(python([BUNDLE, 'tar', result.folder]), good.tar, 'saved files retain the canonical bundle hash');
    const { folder, record, ...provenance } = result;
    assert.deepEqual(JSON.parse(fs.readFileSync(record)), provenance);
    assert.equal(fs.statSync(record).mode & 0o777, 0o600);
    assert.equal(fake.calls.length, 2);
    for (const { url, options } of fake.calls) {
        assert.equal(new URL(url).origin, ORIGIN);
        assert.equal(url.includes(TOKEN), false, 'credentials never enter a URL');
        assert.deepEqual(options.headers, { authorization: `Bearer ${TOKEN}` });
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
    }
    assert.equal(new URL(fake.calls[0].url).searchParams.get('name'), 'fixture-v1');
    assert.equal(new URL(fake.calls[0].url).searchParams.get('sha256'), good.hex);
    assert.equal(new URL(fake.calls[1].url).pathname, `/api/opponents/${good.hex}.tar`);
    assert.equal(JSON.stringify(result).includes(TOKEN), false, 'credentials are not recorded as provenance');
});

test('download refuses changed descriptors and external or ambiguous bundle URLs before fetching bytes', async () => {
    for (const change of [{ name: 'other-v1' }, { sha256: 'a'.repeat(64) }, { protocol: 1 }, { bytes: 0 },
        { bytes: MAX_BYTES + 1 }, { bytes: 1.5 }, { url: `https://outside.example/${good.hex}.tar` },
        { url: `//outside.example/api/opponents/${good.hex}.tar` }, { url: `/api/opponents/${good.hex}.tar?token=x` }]) {
        const fake = fakeDownload({ desc: descriptor(good, change) });
        await refused(fake, /descriptor changed|expected same-origin bundle path/);
        assert.equal(fake.calls.length, 1);
    }
});

test('download verifies both the exact bytes and descriptor size before writing anything', async () => {
    await refused(fakeDownload({ bundleResponse: new Response(Buffer.from('different bytes')) }), /size or SHA256 mismatch/);
    await refused(fakeDownload({ desc: descriptor(good, { bytes: good.tar.length + 1 }) }), /size or SHA256 mismatch/);
    const changed = Buffer.from(good.tar);
    changed[changed.length - 1] ^= 1;
    await refused(fakeDownload({ bundleResponse: new Response(changed) }), /size or SHA256 mismatch/);
});

test('download refuses malformed, legacy or incompatible manifests and invalid entry declarations', async () => {
    const cases = [
        [{ protocol: 1 }, /not a protocol 2 WASI bundle/],
        [{ protocol: '2' }, /not a protocol 2 WASI bundle/],
        [{ runtime: 'unknown-wasm' }, /runtime is unsupported/],
        [{ cards: { use: 'mount' } }, /unavailable network or mounted cards/],
        [{ network: 'host' }, /bundle validation failed/],
        [{ run: { cmd: './missing.wasm' } }, /entry missing.wasm is not in the bundle/],
        [{ run: { cmd: './../outside.wasm' } }, /must stay inside the bundle/],
        [{ entry_sha256: '0'.repeat(64) }, /does not match entry_sha256/],
        [{ run: null }, /bundle validation failed/]
    ];
    for (const [change, expected] of cases) {
        const bundle = fixture(change);
        const out = fresh();
        await assert.rejects(download(fakeDownload({ bundle }), { sha256: bundle.hex, out }), expected);
        assert.deepEqual(fs.readdirSync(out), [], 'invalid bundles leave no partial download');
    }
    const folder = path.join(tmp, `malformed-${++n}`);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'arena.json'), '{invalid JSON');
    const tar = python([BUNDLE, 'tar', folder]);
    const bundle = { tar, hex: hash(tar) };
    const out = fresh();
    await assert.rejects(download(fakeDownload({ bundle }), { sha256: bundle.hex, out }), /bundle validation failed/);
    assert.deepEqual(fs.readdirSync(out), []);
});

// A plain ustar with a hostile member is correctly hashed; it must still fail before extraction.
function hostileTar(name, type = 'file') {
    const script = `import io, sys, tarfile
with tarfile.open(fileobj=sys.stdout.buffer, mode="w|", format=tarfile.USTAR_FORMAT) as tar:
    info = tarfile.TarInfo(sys.argv[1])
    info.mode = 0o644
    if sys.argv[2] != "file":
        info.type = tarfile.SYMTYPE if sys.argv[2] == "symlink" else tarfile.LNKTYPE
        info.linkname = "../outside"
        tar.addfile(info)
    else:
        info.size = 1
        tar.addfile(info, io.BytesIO(b"x"))
`;
    const tar = python(['-c', script, name, type]);
    return { tar, hex: hash(tar) };
}

test('correctly hashed traversal, symlink and hardlink archives are refused and cleaned up', async () => {
    for (const bundle of [hostileTar('../outside'), hostileTar('/outside'), hostileTar('link', 'symlink'), hostileTar('link', 'hardlink')]) {
        const out = fresh();
        await assert.rejects(download(fakeDownload({ bundle }), { sha256: bundle.hex, out }), /bundle validation failed/);
        assert.deepEqual(fs.readdirSync(out), []);
    }
    assert.equal(fs.existsSync(path.join(tmp, 'outside')), false);
});

test('download never replaces an existing output or follows an output symlink', async () => {
    const out = fresh();
    const first = await download(fakeDownload(), { out });
    const original = fs.readFileSync(first.record);
    await assert.rejects(download(fakeDownload(), { out }), /already exists/);
    assert.deepEqual(fs.readFileSync(first.record), original);
    const target = fresh();
    fs.mkdirSync(target);
    const linked = fresh();
    fs.symlinkSync(target, linked);
    await assert.rejects(download(fakeDownload(), { out: linked }), /out must not be a symlink/);
    assert.deepEqual(fs.readdirSync(target), []);
    const occupied = fresh();
    fs.mkdirSync(occupied);
    fs.symlinkSync(target, path.join(occupied, `fixture-v1-${good.hex}`));
    await assert.rejects(download(fakeDownload(), { out: occupied }), /already exists|EEXIST/);
    assert.deepEqual(fs.readdirSync(target), []);
});

test('invalid names, hashes, credentials and origins are refused without any fetch', async () => {
    const fetchImpl = async () => assert.fail('invalid input must not contact an arena');
    for (const options of [{ name: '../escape-v1' }, { name: 'fixture-v1/escape' }, { name: 'UPPER-v1' },
        { name: `${'a'.repeat(33)}-v1` }, { sha256: 'A'.repeat(64) }, { sha256: 'a'.repeat(63) },
        { sha256: '../x' }, { token: '' }, { token: 'token\r\nInjected: yes' }, { out: '' }]) {
        await assert.rejects(download({ fetchImpl }, options), /name and sha256|existing OAuth token|local opponents directory/);
    }
    for (const arena of ['http://arena.example', 'https://user:secret@arena.example', 'https://arena.example/path',
        'https://arena.example?token=secret', 'https://arena.example/#fragment', 'file:///tmp/']) {
        await assert.rejects(download({ fetchImpl }, { arena }), /HTTPS|origin without/);
    }
    assert.equal(arenaUrl('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
    assert.equal(arenaUrl('http://localhost:1234'), 'http://localhost:1234');
    assert.equal(arenaUrl('http://[::1]:1234'), 'http://[::1]:1234');
});

test('HTTP failures, oversized headers and streamed data are bounded before saving', async () => {
    await refused(fakeDownload({ descriptorResponse: new Response('denied', { status: 403 }) }), /HTTP 403/);
    await refused(fakeDownload({ bundleResponse: new Response('missing', { status: 404 }) }), /HTTP 404/);
    await refused(fakeDownload({ descriptorResponse: new Response('{broken') }), SyntaxError);
    for (const length of [String(MAX_BYTES + 1), '-1', 'not-a-number']) {
        let cancelled = false;
        const bundleResponse = { ok: true, headers: new Headers({ 'content-length': length }),
            body: { cancel: async () => { cancelled = true; } } };
        await refused(fakeDownload({ bundleResponse }), /size limit/);
        assert.equal(cancelled, true);
    }
    const chunk = Buffer.alloc(1 << 20);
    const bundleResponse = { ok: true, headers: new Headers(), body: (async function* () {
        for (let size = 0; size <= MAX_BYTES; size += chunk.length) yield chunk;
    })() };
    await refused(fakeDownload({ bundleResponse }), /size limit/);
    await refused(fakeDownload({ descriptorResponse: new Response('x'.repeat((256 << 10) + 1)) }), /size limit/);
});

test('descriptor and bundle redirects are refused without making a request to the target', async () => {
    for (const stage of ['descriptorResponse', 'bundleResponse']) {
        const fake = fakeDownload({ [stage]: new Response(null, { status: 302,
            headers: { location: 'https://outside.example/redirect-target' } }) });
        await refused(fake, /HTTP 302/);
        assert.equal(fake.calls.length, stage === 'descriptorResponse' ? 1 : 2);
        assert.ok(fake.calls.every(({ url, options }) => new URL(url).origin === ORIGIN
            && !url.includes(TOKEN) && options.redirect === 'error'));
    }
});

test('download command accepts only the documented exact argument names', () => {
    assert.equal(parseArgs(['--help']), null);
    const args = ['--arena', ORIGIN, '--name', 'fixture-v1', '--sha256', good.hex, '--out', 'opponents'];
    assert.deepEqual(parseArgs(args), { arena: ORIGIN, name: 'fixture-v1', sha256: good.hex, out: 'opponents' });
    for (const bad of [[], [...args, '--name', 'other-v1'], [...args, '--token', TOKEN], args.slice(0, -1),
        ['arena', ORIGIN, ...args.slice(2)]]) assert.throws(() => parseArgs(bad), /download-opponent.js/);
});
