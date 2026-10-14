'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodePath = require('path').posix;

const { createRuntime, makePath, sha256, sha1, hmacSha256, toHex } = require('../swarm/runtime');
const { unpack } = require('../swarm/tar');
const { WasiHost, stdinPipe, StdinWriter, StdinReader, E } = require('../swarm/wasi');
const { createSwarmRelay } = require('../arena/swarm-relay');

const enc = new TextEncoder();

test('hashes match Node crypto', () => {
    for (const t of ['', 'abc', 'x'.repeat(200), 'é漢']) {
        assert.strictEqual(toHex(sha256(enc.encode(t))), crypto.createHash('sha256').update(t).digest('hex'));
        assert.strictEqual(toHex(sha1(enc.encode(t))), crypto.createHash('sha1').update(t).digest('hex'));
    }
    for (const k of ['k', 'k'.repeat(100)]) {
        assert.strictEqual(toHex(hmacSha256(enc.encode(k), enc.encode('data'))), crypto.createHmac('sha256', k).update('data').digest('hex'));
    }
});

test('paths match Node\'s POSIX paths', () => {
    const p = makePath(() => '/app');
    const cases = [['resolve', ['a/../b', './c']], ['resolve', ['/x', 'y']], ['join', ['/a/', '../b', 'c/']], ['relative', ['/a/b/c', '/a/d']],
        ['dirname', ['/a/b/']], ['basename', ['/a/b.js', '.js']], ['extname', ['/a/.b']], ['extname', ['x.tar.gz']], ['normalize', ['a//b/../c/.']]];
    for (const [f, a] of cases) {
        assert.strictEqual(p[f](...a), f === 'resolve' ? nodePath.resolve('/app', ...a) : nodePath[f](...a), `${f}(${a.join(', ')})`);
    }
});

test('the runtime loads modules, packages and JSON from its files only', () => {
    const files = new Map([
        ['/app/a.js', "const b = require('./b'); const pkg = require('lib'); exports.out = b.x + pkg.y + require('./data.json').z + require('path').basename(__filename);"],
        ['/app/b.js', 'module.exports = { x: 1 };'],
        ['/app/data.json', '{"z": 2}'],
        ['/app/node_modules/lib/package.json', '{"name": "lib", "exports": {".": {"require": "./cjs.js", "import": "./esm.js"}}}'],
        ['/app/node_modules/lib/cjs.js', 'exports.y = 10;'],
        // the runtime's own Buffer and EventEmitter come from these packages in the files
        ...['buffer', 'base64-js', 'ieee754', 'events'].flatMap((name) => {
            const dir = path.join(__dirname, '..', '..', 'forceteki', 'node_modules', name);
            return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(js|json)$/.test(f)).map((f) => [`/app/forceteki/node_modules/${name}/${f}`, fs.readFileSync(path.join(dir, f), 'utf8')]) : [];
        })
    ]);
    if (!files.has('/app/forceteki/node_modules/buffer/index.js')) {
        return; // no engine checkout here (forceteki/node_modules), so no Buffer to load
    }
    const rt = createRuntime({ files, cwd: '/app' });
    assert.strictEqual(rt.require('/app/a.js').out, '13a.js');
    rt.fs.mkdirSync('/work/x', { recursive: true });
    rt.fs.writeFileSync('/work/x/f.txt', 'hi');
    rt.fs.appendFileSync('/work/x/f.txt', '!');
    assert.strictEqual(rt.fs.readFileSync('/work/x/f.txt', 'utf8'), 'hi!');
    assert.deepStrictEqual(rt.fs.readdirSync('/work'), ['x']);
    assert.throws(() => rt.fs.readFileSync('/etc/passwd'), { code: 'ENOENT' });
    assert.throws(() => rt.require('/app/nope.js'), { code: 'MODULE_NOT_FOUND' });
    const v8 = rt.require('v8');
    const snap = { m: new Map([[1, { a: [1, 2] }]]) };
    const back = v8.deserialize(v8.serialize(snap));
    assert.deepStrictEqual(back, snap);
    assert.notStrictEqual(back.m, snap.m);
});

/** A ustar archive of [name, type, text]: what bundle.py's canonical tar looks like, for unpack. */
function tarOf(entries) {
    const blocks = [];
    for (const [name, type, text = ''] of entries) {
        const h = Buffer.alloc(512);
        h.write(name, 0);
        h.write('0000644\0', 100);
        h.write('0000000\0', 108);
        h.write('0000000\0', 116);
        h.write(`${Buffer.byteLength(text).toString(8).padStart(11, '0')}\0`, 124);
        h.write('00000000000\0', 136);
        h.write('        ', 148);
        h.write(type, 156);
        h.write('ustar\x0000', 257);
        let sum = 0;
        for (const b of h) {
            sum += b;
        }
        h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
        blocks.push(h);
        if (text) {
            const body = Buffer.alloc(Math.ceil(Buffer.byteLength(text) / 512) * 512);
            body.write(text);
            blocks.push(body);
        }
    }
    blocks.push(Buffer.alloc(1024));
    return new Uint8Array(Buffer.concat(blocks));
}

test('a bundle tar unpacks only when it is the bundle the job names, with plain files inside it', () => {
    const tar = tarOf([['src', '5'], ['src/bot.py', '0', 'print(1)\n'], ['arena.json', '0', '{}']]);
    const hex = crypto.createHash('sha256').update(tar).digest('hex');
    const files = unpack(tar, hex);
    assert.deepStrictEqual(files.map(([p, b]) => [p, Buffer.from(b).toString()]), [['src/bot.py', 'print(1)\n'], ['arena.json', '{}']]);
    assert.throws(() => unpack(tar, 'f'.repeat(64)), /sha256/);
    const evil = tarOf([['../x', '0', 'no']]);
    assert.throws(() => unpack(evil, crypto.createHash('sha256').update(evil).digest('hex')), /bad entry/);
    const link = tarOf([['l', '2']]);
    assert.throws(() => unpack(link, crypto.createHash('sha256').update(link).digest('hex')), /not a file or a folder/);
});

test('the stdin pipe carries bytes in order, wraps around, and ends', () => {
    const sab = stdinPipe(16);
    const w = new StdinWriter(sab);
    const r = new StdinReader(sab);
    assert.strictEqual(w.write(enc.encode('hello world, this is long')), 16);
    assert.strictEqual(Buffer.from(r.read(10)).toString(), 'hello worl');
    assert.strictEqual(w.write(enc.encode('hello world, this is long').subarray(16)), 9);
    assert.strictEqual(Buffer.from(r.read(100)).toString(), 'd, this is long');
    assert.strictEqual(r.ready(), false);
    w.close();
    assert.strictEqual(r.read(10), null);
});

test('the WASI host gives argv, env and read-only folders as wasmtime would', () => {
    const out = [];
    const host = new WasiHost({
        args: ['bot', '--x'], env: { A: '1' }, preopens: [{ guest: '/bot', files: new Map([['a/b.txt', enc.encode('data')]]) }],
        stdin: null, stdout: (b) => out.push(Buffer.from(b).toString()), stderr: () => undefined, now: () => 0, mono: () => 0, random: (a) => a.fill(4)
    });
    host.memory = new WebAssembly.Memory({ initial: 1 });
    const w = host.imports().wasi_snapshot_preview1;
    const v = () => new DataView(host.memory.buffer);
    const mem = () => new Uint8Array(host.memory.buffer);
    assert.strictEqual(w.args_sizes_get(0, 4), E.SUCCESS);
    assert.deepStrictEqual([v().getUint32(0, true), v().getUint32(4, true)], [2, 8]);
    // preopen 3 is /bot; open a/b.txt read-only and read it
    mem().set(enc.encode('a/b.txt'), 100);
    assert.strictEqual(w.path_open(3, 0, 100, 7, 0, 0n, 0n, 0, 200), E.SUCCESS);
    const fd = v().getUint32(200, true);
    v().setUint32(300, 400, true);
    v().setUint32(304, 10, true);
    assert.strictEqual(w.fd_read(fd, 300, 1, 500), E.SUCCESS);
    assert.strictEqual(Buffer.from(mem().subarray(400, 400 + v().getUint32(500, true))).toString(), 'data');
    // creating, leaving the folder and writing are refused
    assert.strictEqual(w.path_open(3, 0, 100, 7, 1, 0n, 0n, 0, 200), E.ROFS);
    mem().set(enc.encode('../etc'), 100);
    assert.strictEqual(w.path_open(3, 0, 100, 6, 0, 0n, 0n, 0, 200), E.NOTCAPABLE);
    assert.strictEqual(w.fd_write(fd, 300, 1, 500), E.ROFS);
    // stdout goes to the referee
    mem().set(enc.encode('ok\n'), 600);
    v().setUint32(300, 600, true);
    v().setUint32(304, 3, true);
    assert.strictEqual(w.fd_write(1, 300, 1, 500), E.SUCCESS);
    assert.deepStrictEqual(out, ['ok\n']);
    assert.throws(() => w.proc_exit(3), (e) => e.code === 3);
});

/** A stand-in games machine for the relay: records what it was asked, answers like the helper API. */
function fakeMachine() {
    const calls = [];
    const fetchImpl = async (url, opts) => {
        const u = new URL(url);
        const body = opts.body ? JSON.parse(Buffer.from(opts.body).toString()) : null;
        calls.push({ path: u.pathname, auth: opts.headers.authorization, build: opts.headers['x-helper-build'], body });
        const reply = (status, json) => ({ status, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from(json === undefined ? '' : JSON.stringify(json)) });
        if (u.pathname === '/v1/swarm/manifest.json') {
            return reply(200, { build: 'b1', cards: 'c1' });
        }
        if (u.pathname === '/v1/claim') {
            return body.slot.endsWith('-2') ? reply(204) : reply(200, { lease: 'L1', job: { seed: 1 }, bundles: ['a'.repeat(64)], deadlineMs: 1 });
        }
        if (u.pathname.startsWith('/v1/lease/')) {
            return reply(200, { continue: true });
        }
        if (u.pathname.startsWith('/v1/bundle/')) {
            return { status: 200, headers: { get: () => 'application/x-tar' }, arrayBuffer: async () => Buffer.from('tar') };
        }
        return reply(200, { ok: true });
    };
    return { calls, fetchImpl };
}

function fakeRes() {
    const res = { status: null, headers: {}, body: '' };
    res.writeHead = (s, h = {}) => {
        res.status = s;
        Object.assign(res.headers, h);
    };
    res.end = (b) => {
        res.body = b === undefined ? '' : Buffer.from(b).toString();
    };
    return res;
}

async function ask(relay, method, p, who, body = '') {
    const res = fakeRes();
    const req = { method, headers: {} };
    const helpers = {
        sendJson: (r, code, json) => r.writeHead(code) || r.end(JSON.stringify(json)),
        sendText: (r, _req, code, type, text, headers = {}) => r.writeHead(code, { 'content-type': type, ...headers }) || r.end(text),
        readBody: async () => Buffer.from(body)
    };
    const handled = await relay.route(req, res, new URL(p, 'http://w'), who, helpers);
    return { handled, status: res.status, json: res.body ? (() => {
        try {
            return JSON.parse(res.body);
        } catch {
            return null;
        }
    })() : null, headers: res.headers };
}

test('the window relays a signed-in person\'s seeds, and only theirs', async () => {
    const m = fakeMachine();
    const relay = createSwarmRelay({ token: 'T', machine: 'http://games', fetchImpl: m.fetchImpl, page: __filename });
    const eric = { via: 'cookie', login: 'Eric', role: 'admin' };
    const bob = { via: 'cookie', login: 'bob', role: 'friend' };
    assert.strictEqual((await ask(relay, 'GET', '/arena', eric)).handled, false);
    // guests, apps and the uninvited are refused
    for (const who of [{ via: 'cookie', role: 'friend', guest: 'v1' }, { via: 'oauth', login: 'x', role: 'friend' }, { via: 'cookie', login: 'y', role: 'anon' }]) {
        assert.strictEqual((await ask(relay, 'POST', '/api/swarm/claim', who, '{"slot":"1"}')).status, 403);
    }
    const page = await ask(relay, 'GET', '/swarm', eric);
    assert.strictEqual(page.headers['cross-origin-embedder-policy'], 'require-corp');
    const info = await ask(relay, 'GET', '/api/swarm/info', eric);
    assert.deepStrictEqual([info.json.ready, info.json.build, info.json.files.pack], [true, 'b1', '/swarm/engine.json?b=b1']);
    const claim = await ask(relay, 'POST', '/api/swarm/claim', eric, '{"slot":"1"}');
    assert.strictEqual(claim.json.lease, 'L1');
    assert.deepStrictEqual(m.calls.at(-1), { path: '/v1/claim', auth: 'Bearer T', build: 'b1', body: { slot: 'eric-1' } });
    assert.strictEqual((await ask(relay, 'POST', '/api/swarm/claim', eric, '{"slot":"2"}')).status, 204);
    // bob holds nothing: no heartbeat, result or bundle of eric's seed
    assert.strictEqual((await ask(relay, 'POST', '/api/swarm/lease/L1/heartbeat', bob)).status, 410);
    assert.strictEqual((await ask(relay, 'GET', `/api/swarm/bundle/${'a'.repeat(64)}`, bob)).status, 404);
    assert.strictEqual((await ask(relay, 'GET', `/api/swarm/bundle/${'a'.repeat(64)}`, eric)).status, 200);
    assert.strictEqual((await ask(relay, 'POST', '/api/swarm/lease/L1/heartbeat', eric)).status, 200);
    assert.strictEqual((await ask(relay, 'POST', '/api/swarm/lease/L1/result', eric, '{"failed":"x"}')).status, 200);
    // a result ends the lease on the window too
    assert.strictEqual((await ask(relay, 'POST', '/api/swarm/lease/L1/heartbeat', eric)).status, 410);
});

test('without a token the swarm is off', async () => {
    const relay = createSwarmRelay({ token: null, page: __filename });
    const r = await ask(relay, 'GET', '/api/swarm/info', { via: 'cookie', login: 'eric', role: 'admin' });
    assert.strictEqual(r.status, 503);
});
