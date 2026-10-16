'use strict';
// Files the window sends as they are (bot/arena/static.js): compressed once, brotli or gzip as the browser takes it,
// and 304 when it already has them; the app, the kit on /kit.js and /tables/kit.js; and the engine pack and
// bot bundles of the swarm relay, kept a year when their URL names them, with a brotli copy made in the background.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'static-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
Object.assign(process.env, { ARENA_HOME: path.join(tmp, 'arena-home'), ARENA_RESULTS: path.join(tmp, 'arena-results'), ARENA_DASH: path.join(tmp, 'no-dash') });

const { createStatic, accepts, matches } = require('../arena/static');
const { createWindow } = require('../arena/window');
const { createAuth } = require('../arena/auth');
const { createSwarmRelay } = require('../arena/swarm-relay');

const ENV = { ARENA_PUSH_TOKEN: 'push-secret', ARENA_ADMINS: 'ericfode', ARENA_INVITES: 'pal', GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', ARENA_PUBLIC_URL: 'https://swu-arena.fly.dev' };

/** A server answering every request with `handler`; get() asks it with raw headers and returns the body undecoded. */
async function serve(handler) {
    const srv = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch((e) => {
        res.writeHead(500);
        res.end(String(e.stack));
    })).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const get = (p, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: p, method, headers }, (res) => {
            const parts = [];
            res.on('data', (d) => parts.push(d));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
        });
        req.on('error', reject);
        req.end();
    });
    return { get, close: () => new Promise((r) => srv.close(r)) };
}

const bytesOf = (r) => (r.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(r.body) : r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body);
const decode = (r) => bytesOf(r).toString('utf8');

test('accept-encoding: brotli only when named, gzip also for *, and never at q=0', () => {
    assert.strictEqual(accepts('gzip, deflate, br', ['br'], false), true);
    assert.strictEqual(accepts('gzip, br;q=0', ['br'], false), false);
    assert.strictEqual(accepts('*', ['br'], false), false, 'brotli is sent only to who names it');
    assert.strictEqual(accepts('*', ['gzip']), true);
    assert.strictEqual(accepts('identity', ['gzip']), false);
    assert.strictEqual(accepts('GZIP;q=0.5', ['gzip']), true);
    assert.strictEqual(accepts(undefined, ['gzip']), false);
    assert.strictEqual(matches('W/"abc", "def"', 'W/"def"'), true, 'a weak comparison');
    assert.strictEqual(matches('*', 'W/"x"'), true);
    assert.strictEqual(matches('"abc"', 'W/"abd"'), false);
    assert.strictEqual(matches(undefined, 'W/"x"'), false);
});

test('a file is compressed once, sent as the browser takes it, and answered 304 when the browser has it', async () => {
    const file = path.join(tmp, 'kit.js');
    const text = `window.Kit = ${JSON.stringify('card '.repeat(4000))};\n`;
    fs.writeFileSync(file, text);
    const statics = createStatic();
    const { get, close } = await serve(async (req, res) => {
        if (!(await statics.send(req, res, file, 'text/javascript', { headers: { 'x-extra': 'yes' } }))) {
            res.writeHead(404);
            res.end();
        }
    });
    try {
        const gz = await get('/', { 'accept-encoding': 'gzip' });
        assert.strictEqual(gz.status, 200);
        assert.strictEqual(gz.headers['content-encoding'], 'gzip');
        assert.strictEqual(decode(gz), text);
        assert.strictEqual(gz.headers['content-length'], String(gz.body.length));
        assert.strictEqual(gz.headers['cache-control'], 'no-cache');
        assert.strictEqual(gz.headers.vary, 'accept-encoding');
        assert.strictEqual(gz.headers['x-extra'], 'yes');
        const etag = gz.headers.etag;
        assert.match(etag, /^W\/"[\w-]{27}"$/);

        await statics.ready(file);
        const br = await get('/', { 'accept-encoding': 'gzip, deflate, br' });
        assert.strictEqual(br.headers['content-encoding'], 'br', 'brotli once it is made');
        assert.ok(br.body.length < gz.body.length);
        assert.strictEqual(decode(br), text);
        assert.strictEqual(br.headers.etag, etag, 'one ETag for the content, whatever its coding');
        const plain = await get('/', {});
        assert.strictEqual(plain.headers['content-encoding'], undefined);
        assert.strictEqual(plain.body.toString('utf8'), text);

        const again = await get('/', { 'accept-encoding': 'br', 'if-none-match': etag });
        assert.strictEqual(again.status, 304);
        assert.strictEqual(again.body.length, 0);
        assert.strictEqual(again.headers.etag, etag);
        assert.strictEqual(again.headers['x-extra'], 'yes', 'a 304 carries the same headers');
        const head = await get('/', { 'accept-encoding': 'br' }, 'HEAD');
        assert.strictEqual(head.status, 200);
        assert.strictEqual(head.body.length, 0);

        // a new version is read again, and the old ETag no longer matches
        fs.writeFileSync(file, `${text}// v2\n`);
        const v2 = await get('/', { 'accept-encoding': 'gzip', 'if-none-match': etag });
        assert.strictEqual(v2.status, 200);
        assert.notStrictEqual(v2.headers.etag, etag);
        assert.match(decode(v2), /\/\/ v2\n$/);

        fs.rmSync(file);
        assert.strictEqual((await get('/', {})).status, 404, 'no file: send() says so');
    } finally {
        await close();
    }
});

test('a small file goes as it is; transform runs once per version', async () => {
    const file = path.join(tmp, 'page.html');
    fs.writeFileSync(file, '<p>hi</p></body>');
    let runs = 0;
    const transform = (t) => {
        runs++;
        return t.replace('</body>', '<script src="/feedback.js"></script></body>');
    };
    const statics = createStatic();
    const { get, close } = await serve((req, res) => statics.send(req, res, file, 'text/html', { transform }));
    try {
        for (let i = 0; i < 3; i++) {
            const r = await get('/', { 'accept-encoding': 'gzip, br' });
            assert.strictEqual(r.headers['content-encoding'], undefined, 'under 1 KB: not worth compressing');
            assert.strictEqual(r.body.toString(), '<p>hi</p><script src="/feedback.js"></script></body>');
        }
        assert.strictEqual(runs, 1);
    } finally {
        await close();
    }
});

test('the window sends the app and the kit compressed once, with 304 on a reload, the same kit on all three paths', async () => {
    const home = path.join(tmp, 'window');
    const auth = createAuth({ dir: path.join(home, 'auth'), env: ENV, invites: () => [], links: () => [] });
    const app = path.join(tmp, 'app.html');
    fs.writeFileSync(app, `<!doctype html><title>app</title><script>${'let a = 1;\n'.repeat(500)}</script></body>`);
    const kit = path.join(tmp, 'window-kit.js');
    fs.writeFileSync(kit, `window.SWUViewer = {}; // ${'x'.repeat(5000)}`);
    const w = createWindow({ home, auth, app, kit, minMs: 0, wakeGames: () => undefined, play: 'github', tables: 'github' });
    const { get, close } = await serve((req, res) => w.handle(req, res));
    try {
        const pal = { cookie: `swu_session=${auth.sign({ l: 'pal', exp: Date.now() + 60000 })}`, 'accept-encoding': 'gzip, deflate, br' };
        const first = await get('/', pal);
        assert.strictEqual(first.status, 200);
        assert.match(first.headers['content-encoding'], /^(br|gzip)$/);
        const html = decode(first);
        assert.strictEqual(html.match(/feedback\.js/g)?.length, 1, 'the feedback widget, once');
        const reload = await get('/', { ...pal, 'if-none-match': first.headers.etag });
        assert.strictEqual(reload.status, 304);

        const stranger = { cookie: `swu_session=${auth.sign({ l: 'stranger', exp: Date.now() + 60000 })}`, 'accept-encoding': 'gzip' };
        const kits = [await get('/kit.js', pal), await get('/tables/kit.js', stranger)];
        assert.deepStrictEqual(kits.map((r) => r.status), [200, 200]);
        assert.deepStrictEqual(kits.map(decode), kits.map(() => fs.readFileSync(kit, 'utf8')));
        assert.strictEqual(new Set(kits.map((r) => r.headers.etag)).size, 1, 'one kit, one ETag');
        assert.strictEqual(kits[1].headers['cross-origin-resource-policy'], 'same-origin', 'the play page is isolated');
        assert.strictEqual((await get('/tables/kit.js', { ...stranger, 'if-none-match': kits[0].headers.etag })).status, 304);
        assert.strictEqual((await get('/kit.js', { ...stranger, 'if-none-match': kits[0].headers.etag })).status, 403, 'the arena itself stays for invited people');
    } finally {
        await close();
    }
});

test("the engine pack and bundles: brotli once it is made, kept a year when the URL names them, the .br dropped with its bundle", async () => {
    const home = path.join(tmp, 'relay');
    const pack = Buffer.from(JSON.stringify({ build: 'b1', files: { '/app/x.js': 'module.exports = 1;\n'.repeat(3000) } }));
    const tar = Buffer.alloc(8192, 7);
    const hex = crypto.createHash('sha256').update(tar).digest('hex');
    const m = { lineup: { round: 3, capMs: 30000, bots: [{ name: 'tiny-v1', bundle: hex, bytes: tar.length }] } };
    const answer = (status, body) => ({ status, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from(body) });
    const fetchImpl = async (url) => {
        const p = new URL(url).pathname;
        if (p === '/v1/swarm/manifest.json') {
            return answer(200, JSON.stringify({ build: 'b1', cards: 'c1' }));
        }
        if (p === '/v1/swarm/lineup.json') {
            return answer(200, JSON.stringify(m.lineup));
        }
        if (p === `/v1/swarm/bot/${hex}`) {
            return answer(200, tar);
        }
        return p === '/v1/swarm/engine.json' ? answer(200, pack) : answer(404, '');
    };
    const swarm = createSwarmRelay({ token: 't', machine: 'http://games', cacheDir: path.join(home, 'swarm'), botDir: path.join(home, 'bots'), fetchImpl });
    const fail = (res, status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    const { get, close } = await serve(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const b = /^\/bundle\/(\w+)$/.exec(url.pathname);
        if (b) {
            return swarm.sendBot(req, res, b[1], { sendJson: (r, s, body) => fail(r, s, body) });
        }
        return swarm.sendFile(req, res, url, url.pathname.slice(1), { sendJson: (r, s, body) => fail(r, s, body), sendText: (r, q, s) => fail(r, s, {}) });
    });
    const until = async (cond) => {
        for (let i = 0; i < 200 && !cond(); i++) {
            await new Promise((r) => setTimeout(r, 10));
        }
        assert.ok(cond());
    };
    try {
        const first = await get('/engine.json?b=b1', { 'accept-encoding': 'gzip, br' });
        assert.strictEqual(first.status, 200);
        assert.strictEqual(first.headers['content-encoding'], 'gzip', 'gzip until the brotli is made');
        assert.strictEqual(first.headers['cache-control'], 'private, max-age=31536000, immutable');
        assert.strictEqual(first.headers['x-raw-length'], String(pack.length));
        assert.strictEqual(decode(first), pack.toString());
        await until(() => fs.existsSync(path.join(home, 'swarm', 'b1', 'engine.json.br')));
        const br = await get('/engine.json?b=b1', { 'accept-encoding': 'gzip, br' });
        assert.strictEqual(br.headers['content-encoding'], 'br');
        assert.strictEqual(br.headers['x-raw-length'], String(pack.length), 'the unzipped size, as before');
        assert.strictEqual(decode(br), pack.toString());
        assert.strictEqual(swarm.fileSize('b1', 'engine.json', { gz: true }), br.body.length, 'the play page shows what a browser downloads');
        assert.strictEqual((await get('/engine.json', { 'accept-encoding': 'gzip' })).headers['cache-control'], 'private, no-cache', 'without ?b= the build can change');

        await swarm.lineup();
        await until(() => swarm.botHere(hex));
        const tar1 = await get(`/bundle/${hex}`, { 'accept-encoding': 'br' });
        assert.strictEqual(tar1.headers['cache-control'], 'private, max-age=31536000, immutable');
        assert.deepStrictEqual(bytesOf(tar1), tar);
        await until(() => fs.existsSync(path.join(home, 'bots', `${hex}.tar.br`)));
        assert.strictEqual(swarm.botHere(hex).br, path.join(home, 'bots', `${hex}.tar.br`));
        const tar2 = await get(`/bundle/${hex}`, { 'accept-encoding': 'br' });
        assert.strictEqual(tar2.headers['content-encoding'], 'br');
        assert.deepStrictEqual(bytesOf(tar2), tar);
        // a new lineup without the bot drops all three copies
        m.lineup = { round: 4, capMs: 30000, bots: [] };
        await new Promise((r) => setTimeout(r, 0));
        const later = createSwarmRelay({ token: 't', machine: 'http://games', cacheDir: path.join(home, 'swarm'), botDir: path.join(home, 'bots'), fetchImpl });
        await later.lineup();
        await until(() => !fs.readdirSync(path.join(home, 'bots')).some((f) => f.startsWith(hex)));
    } finally {
        await close();
    }
});
