'use strict';
// Card art through the window (bot/arena/art.js), for the isolated /play and /tables pages: who may ask, what the CDN is
// asked and how often, the headers that let a require-corp page show the image, and the smaller WebPs it makes once.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'art-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
Object.assign(process.env, { ARENA_HOME: path.join(tmp, 'arena-home'), ARENA_RESULTS: path.join(tmp, 'arena-results'), ARENA_DASH: path.join(tmp, 'no-dash') });

const { createArt, imageSize, cwebp } = require('../arena/art');
const { createWindow } = require('../arena/window');
const { createAuth } = require('../arena/auth');

const PNG = (n, fill = 1) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(n - 4, fill)]);
const WEBP = (n, fill = 3) => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), Buffer.alloc(n - 12, fill)]);
// what Chrome asks with for an <img>; Firefox and Safari 16+ name image/webp too
const TAKES_WEBP = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

/** swu-db's CDN: cdn.files[path] is an image, cdn.status[path] an error status; cdn.asked lists every request. */
function cdn() {
    const c = { files: {}, status: {}, asked: [], type: 'image/png', hold: null };
    c.fetchImpl = async (url) => {
        const u = new URL(url);
        assert.strictEqual(u.origin, 'https://cdn.swu-db.com');
        const p = u.pathname.replace('/images/cards/', '');
        c.asked.push(p);
        if (c.hold) {
            await c.hold;
        }
        const status = c.status[p] ?? (c.files[p] ? 200 : 403);
        const body = c.files[p] ?? Buffer.from('<Error>AccessDenied</Error>');
        return { status, headers: { get: (h) => (h === 'content-type' ? (status === 200 ? c.type : 'application/xml') : null) }, arrayBuffer: async () => body, body: { cancel: async () => undefined } };
    };
    return c;
}

/** One request to art.route as `who`: {handled, status, headers, body}. */
async function ask(art, p, { who = { role: 'anon', login: 'stranger' }, method = 'GET', accept } = {}) {
    const res = { status: 0, headers: {}, body: null, writeHead(code, h) { this.status = code; this.headers = h; }, end(b) { this.body = b ?? null; } };
    const handled = await art.route({ method, headers: accept ? { accept } : {} }, res, new URL(p, 'http://x'), who);
    return { handled, ...res };
}

test('an image comes from the CDN once, with the headers a require-corp page needs', async () => {
    const c = cdn();
    c.files['SOR/010.png'] = PNG(5000);
    c.files['SOR/010-b.png'] = PNG(6000, 2);
    const art = createArt({ fetchImpl: c.fetchImpl });
    const r = await ask(art, '/art/SOR/010.png');
    assert.strictEqual(r.handled, true);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, c.files['SOR/010.png']);
    assert.strictEqual(r.headers['content-type'], 'image/png');
    assert.strictEqual(r.headers['cross-origin-resource-policy'], 'same-origin');
    assert.match(r.headers['cache-control'], /immutable/);
    assert.strictEqual(r.headers['content-length'], '5000');
    assert.deepStrictEqual((await ask(art, '/art/SOR/010-b.png')).body, c.files['SOR/010-b.png'], "a leader's deployed side");
    await ask(art, '/art/SOR/010.png');
    assert.deepStrictEqual(c.asked, ['SOR/010.png', 'SOR/010-b.png'], 'kept in memory after the first time');
    const head = await ask(art, '/art/SOR/010.png', { method: 'HEAD' });
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.body, null);
    assert.strictEqual((await ask(art, '/art/SOR/010.png', { method: 'POST' })).status, 405);
});

test('only people signed in with GitHub, guests and tokens may ask', async () => {
    const c = cdn();
    c.files['SOR/010.png'] = PNG(100);
    const art = createArt({ fetchImpl: c.fetchImpl });
    assert.strictEqual((await ask(art, '/art/SOR/010.png', { who: { role: 'anon', via: 'cookie' } })).status, 401);
    assert.deepStrictEqual(c.asked, [], 'no one signed in: the CDN is not asked');
    assert.strictEqual((await ask(art, '/art/SOR/010.png', { who: { role: 'anon', login: 'stranger', via: 'cookie' } })).status, 200);
    assert.strictEqual((await ask(art, '/art/SOR/010.png', { who: { role: 'friend', guest: 'v1', via: 'cookie' } })).status, 200);
    assert.strictEqual((await ask(art, '/art/SOR/010.png', { who: { role: 'project', via: 'bearer' } })).status, 200);
});

test('only card image paths are asked for: anything else is not this route', async () => {
    const c = cdn();
    const art = createArt({ fetchImpl: c.fetchImpl });
    for (const p of ['/art', '/art/', '/art/sor/010.png', '/art/SOR/10.png', '/art/SOR/0100.png', '/art/SOR/010.jpg', '/art/SOR/010-c.png',
        '/art/SOR/../010.png', '/art/SORSORS/010.png', '/art/SOR/010.png/x', '/play/art/SOR/010.png']) {
        assert.strictEqual((await ask(art, p)).handled, false, p);
    }
    assert.strictEqual((await ask(art, '/art/TS26/084.png')).handled, true);
    assert.deepStrictEqual(c.asked, ['TS26/084.png']);
});

test('a card with no art is remembered for an hour; a CDN failure is not remembered', async () => {
    const c = cdn();
    const clock = { t: 1e12 };
    const art = createArt({ fetchImpl: c.fetchImpl, now: () => clock.t });
    const miss = await ask(art, '/art/TS26/001.png');
    assert.strictEqual(miss.status, 404, 'S3 answers 403 for a file it does not have');
    await ask(art, '/art/TS26/001.png');
    assert.deepStrictEqual(c.asked, ['TS26/001.png']);
    clock.t += 3600e3;
    await ask(art, '/art/TS26/001.png');
    assert.deepStrictEqual(c.asked, ['TS26/001.png', 'TS26/001.png'], 'asked again after an hour');

    c.status['SOR/011.png'] = 503;
    const errors = [];
    const log = console.error;
    console.error = (m) => errors.push(m);
    try {
        assert.strictEqual((await ask(art, '/art/SOR/011.png')).status, 502);
        c.files['SOR/012.png'] = Buffer.from('<html>');
        c.type = 'text/html';
        assert.strictEqual((await ask(art, '/art/SOR/012.png')).status, 502, 'only PNG images are passed on');
    } finally {
        console.error = log;
    }
    assert.strictEqual(errors.length, 2);
    delete c.status['SOR/011.png'];
    c.type = 'image/png';
    c.files['SOR/011.png'] = PNG(100);
    assert.strictEqual((await ask(art, '/art/SOR/011.png')).status, 200, 'a failure is tried again on the next request');
});

test('one image asked for twice at once is fetched once; memory keeps the latest images up to maxBytes', async () => {
    const c = cdn();
    for (const n of ['001', '002', '003']) {
        c.files[`SOR/${n}.png`] = PNG(400);
    }
    const art = createArt({ fetchImpl: c.fetchImpl, maxBytes: 1000 });
    let go;
    c.hold = new Promise((r) => (go = r));
    const both = Promise.all([ask(art, '/art/SOR/001.png'), ask(art, '/art/SOR/001.png')]);
    await new Promise((r) => setImmediate(r));
    go();
    c.hold = null;
    assert.deepStrictEqual((await both).map((r) => r.status), [200, 200]);
    assert.deepStrictEqual(c.asked, ['SOR/001.png']);
    await ask(art, '/art/SOR/002.png');
    await ask(art, '/art/SOR/001.png'); // used again: now the newest
    await ask(art, '/art/SOR/003.png'); // over 1000 bytes: 002 goes
    assert.deepStrictEqual(art.stats(), { kept: 2, bytes: 800, missing: 0, disk: null, diskBytes: 0 });
    c.asked.length = 0;
    await ask(art, '/art/SOR/001.png');
    await ask(art, '/art/SOR/002.png');
    assert.deepStrictEqual(c.asked, ['SOR/002.png']);
});

test('the window answers /art/ for a signed-in person, before the arena asks for an invite', async () => {
    const c = cdn();
    c.files['JTL/005.png'] = PNG(2000);
    const home = path.join(tmp, 'window');
    const env = { ARENA_PUSH_TOKEN: 'push-secret', ARENA_ADMINS: 'ericfode', GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', ARENA_PUBLIC_URL: 'https://swu-arena.fly.dev' };
    const auth = createAuth({ dir: path.join(home, 'auth'), env, invites: () => [], links: () => [] });
    const w = createWindow({ home, auth, app: path.join(tmp, 'none.html'), minMs: 0, wakeGames: () => undefined, art: createArt({ fetchImpl: c.fetchImpl }) });
    const srv = http.createServer((req, res) => w.handle(req, res)).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    try {
        const go = (p, cookie) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, { headers: cookie ? { cookie } : {} });
        const cookie = `swu_session=${auth.sign({ l: 'stranger', exp: Date.now() + 60000 })}`;
        const r = await go('/art/JTL/005.png', cookie);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cross-origin-resource-policy'), 'same-origin');
        assert.strictEqual(r.headers.get('content-encoding'), null, 'images are sent as they are');
        assert.deepStrictEqual(Buffer.from(await r.arrayBuffer()), c.files['JTL/005.png']);
        assert.strictEqual((await go('/art/JTL/005.png')).status, 401);
    } finally {
        await new Promise((r) => srv.close(r));
    }
});

/** A stand-in for cwebp: a WebP of `size(src)` bytes, or what `fail(src)` throws; made lists every image it was given. */
function converter({ size = () => 1000, fail = () => null } = {}) {
    const c = { made: [] };
    c.toWebp = async (src) => {
        c.made.push(src.length);
        const e = fail(src);
        if (e) {
            throw e;
        }
        return WEBP(size(src));
    };
    return c;
}

test('a browser that takes WebP gets the CDN image first, then the WebP made once and kept on disk', async () => {
    const c = cdn();
    c.files['SOR/010.png'] = PNG(5000);
    const w = converter();
    const dir = path.join(tmp, 'webp-1');
    const art = createArt({ fetchImpl: c.fetchImpl, dir, toWebp: w.toWebp });
    const first = await ask(art, '/art/SOR/010.png', { accept: TAKES_WEBP });
    assert.strictEqual(first.headers['content-type'], 'image/png', 'no WebP yet: the CDN image at once');
    assert.strictEqual(first.headers.vary, 'accept');
    assert.deepStrictEqual(first.body, c.files['SOR/010.png']);
    await art.settled();
    assert.deepStrictEqual(w.made, [5000]);

    const r = await ask(art, '/art/SOR/010.png', { accept: TAKES_WEBP });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'image/webp');
    assert.strictEqual(r.headers['content-length'], '1000');
    assert.strictEqual(r.headers['cross-origin-resource-policy'], 'same-origin');
    assert.match(r.headers['cache-control'], /immutable/);
    assert.strictEqual(r.headers.vary, 'accept');
    assert.deepStrictEqual(r.body, WEBP(1000));
    assert.ok(fs.existsSync(path.join(dir, 'SOR', '010.webp')));
    assert.deepStrictEqual(art.stats(), { kept: 1, bytes: 1000, missing: 0, disk: 1, diskBytes: 1000 }, 'the CDN image left memory');

    const old = await ask(art, '/art/SOR/010.png', { accept: 'image/png,image/*;q=0.8,*/*;q=0.5' });
    assert.strictEqual(old.headers['content-type'], 'image/png', 'a browser that does not name WebP gets the CDN image');
    assert.strictEqual((await ask(art, '/art/SOR/010.png', { accept: 'image/webp;q=0, image/png' })).headers['content-type'], 'image/png', 'nor one that refuses it');
    assert.deepStrictEqual(c.asked, ['SOR/010.png', 'SOR/010.png']);
    assert.strictEqual((await ask(art, '/art/SOR/010.png', { accept: 'image/png, IMAGE/WEBP;q=0.9' })).headers['content-type'], 'image/webp');

    // a new window process: the WebP comes from the disk, with no CDN request and nothing made again
    const next = createArt({ fetchImpl: c.fetchImpl, dir, toWebp: w.toWebp });
    assert.deepStrictEqual((await ask(next, '/art/SOR/010.png', { accept: TAKES_WEBP })).body, WEBP(1000));
    assert.deepStrictEqual([c.asked.length, w.made.length], [2, 1]);
    assert.strictEqual((await ask(next, '/art/SOR/010.png', { accept: TAKES_WEBP, method: 'HEAD' })).body, null);
});

test('a WebP that fails or is no smaller is tried again only after an hour; with no cwebp every image goes as it is', async () => {
    const c = cdn();
    c.files['SOR/011.png'] = PNG(5000, 1);
    c.files['SOR/012.png'] = PNG(5000, 2);
    const clock = { t: 1e12 };
    const w = converter({ size: (src) => (src[4] === 2 ? 6000 : 1000), fail: (src) => (src[4] === 1 ? new Error('cwebp ended 1') : null) });
    const art = createArt({ fetchImpl: c.fetchImpl, toWebp: w.toWebp, now: () => clock.t });
    const errors = [];
    const log = console.error;
    console.error = (m) => errors.push(m);
    try {
        for (let i = 0; i < 2; i++) {
            for (const n of ['011', '012']) {
                assert.strictEqual((await ask(art, `/art/SOR/${n}.png`, { accept: TAKES_WEBP })).headers['content-type'], 'image/png');
            }
            await art.settled();
        }
        assert.deepStrictEqual(w.made, [5000, 5000], 'tried once each');
        assert.strictEqual(errors.length, 1);
        clock.t += 3600e3;
        await ask(art, '/art/SOR/011.png', { accept: TAKES_WEBP });
        await art.settled();
        assert.strictEqual(w.made.length, 3, 'an hour later');

        const missing = converter({ fail: () => Object.assign(new Error('spawn cwebp ENOENT'), { code: 'ENOENT' }) });
        const bare = createArt({ fetchImpl: c.fetchImpl, toWebp: missing.toWebp });
        await ask(bare, '/art/SOR/011.png', { accept: TAKES_WEBP });
        await bare.settled();
        const r = await ask(bare, '/art/SOR/012.png', { accept: TAKES_WEBP });
        assert.strictEqual(r.headers['content-type'], 'image/png');
        assert.strictEqual(r.headers.vary, undefined, 'no WebPs: the answer no longer depends on Accept');
        await bare.settled();
        assert.strictEqual(missing.made.length, 1, 'not tried again');
        assert.match(errors[errors.length - 1], /cwebp is not installed/);
    } finally {
        console.error = log;
    }
});

test('the disk keeps WebPs up to maxDiskBytes, oldest out first, and none when the volume is short of room', async () => {
    const c = cdn();
    for (const n of ['001', '002', '003']) {
        c.files[`SOR/${n}.png`] = PNG(5000);
    }
    const dir = path.join(tmp, 'webp-cap');
    const art = createArt({ fetchImpl: c.fetchImpl, dir, toWebp: converter().toWebp, maxDiskBytes: 2500 });
    for (const n of ['001', '002', '003']) {
        await ask(art, `/art/SOR/${n}.png`, { accept: TAKES_WEBP });
        await art.settled();
    }
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'SOR')).sort(), ['002.webp', '003.webp']);
    assert.strictEqual(art.stats().diskBytes, 2000);

    const full = path.join(tmp, 'webp-full');
    const none = createArt({ fetchImpl: c.fetchImpl, dir: full, toWebp: converter().toWebp, minFreeBytes: Number.MAX_SAFE_INTEGER });
    await ask(none, '/art/SOR/001.png', { accept: TAKES_WEBP });
    await none.settled();
    assert.deepStrictEqual(fs.readdirSync(full).flatMap((s) => fs.readdirSync(path.join(full, s))), [], 'nothing written');
    assert.strictEqual((await ask(none, '/art/SOR/001.png', { accept: TAKES_WEBP })).headers['content-type'], 'image/webp', 'still made, in memory');
});

const JPEG = fs.readFileSync(path.join(__dirname, 'fixtures', 'card-1120x1560.jpg'));

test('image sizes come from the JPEG or PNG header', () => {
    assert.deepStrictEqual(imageSize(JPEG), { w: 1120, h: 1560 });
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(png);
    png.write('IHDR', 12, 'latin1');
    png.writeUInt32BE(1560, 16);
    png.writeUInt32BE(1120, 20);
    assert.deepStrictEqual(imageSize(png), { w: 1560, h: 1120 });
    assert.strictEqual(imageSize(Buffer.from('<Error>')), null);
});

test('cwebp makes a WebP of at most 1000 px on the long side', { skip: spawnSync('cwebp', ['-version']).status !== 0 ? 'cwebp is not installed (Debian package webp, in the window image)' : false }, async () => {
    const out = await cwebp(JPEG);
    assert.strictEqual(out.toString('latin1', 8, 12), 'WEBP');
    // a lossy WebP's frame header: 14-bit width and height at bytes 26 and 28
    assert.strictEqual(out.toString('latin1', 12, 16), 'VP8 ');
    const [w, h] = [out.readUInt16LE(26) & 0x3fff, out.readUInt16LE(28) & 0x3fff];
    assert.strictEqual(h, 1000);
    assert.ok(Math.abs(w - 718) <= 1, `width ${w}`);
    await assert.rejects(cwebp(Buffer.from('not an image')), /cwebp ended/);
});
