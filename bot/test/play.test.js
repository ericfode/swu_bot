'use strict';
// The window's play page (bot/arena/play.js): who may play in each mode, the page's files from the games machine
// (through the swarm relay, kept on the window's disk), and finished games coming back to the window as a people run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'play-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
Object.assign(process.env, { ARENA_HOME: path.join(tmp, 'arena-home'), ARENA_RESULTS: path.join(tmp, 'arena-results'), ARENA_DASH: path.join(tmp, 'no-dash') });

const { createWindow, Store } = require('../arena/window');
const { createAuth } = require('../arena/auth');
const { createSwarmRelay } = require('../arena/swarm-relay');
const { checkReplay } = require('../arena/play');

const ENV = { ARENA_PUSH_TOKEN: 'push-secret', ARENA_ADMIN_TOKEN: 'admin-secret', ARENA_ADMINS: 'ericfode', ARENA_INVITES: 'pal,pal2', GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', ARENA_PUBLIC_URL: 'https://swu-arena.fly.dev' };
const ORIGIN = 'https://swu-arena.fly.dev';

/**
 * A games machine that is awake (build b1) or asleep (every request fails). m.lineup is its latest round's bots
 * (HelperApi.ts GET /v1/swarm/lineup.json) and m.tars their bundles by sha256 (GET /v1/swarm/bot/<hex>), when a test
 * sets them.
 */
function machine() {
    const m = { awake: true, asked: [], lineup: null, tars: {}, sizes: undefined };
    const answer = (status, body) => ({ status, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from(body) });
    m.fetchImpl = async (url) => {
        const u = new URL(url);
        m.asked.push(u.pathname);
        if (!m.awake) {
            throw new TypeError('fetch failed');
        }
        if (u.pathname === '/v1/swarm/lineup.json') {
            return answer(200, JSON.stringify(m.lineup ?? { bots: [], capMs: null, round: null }));
        }
        const tar = /^\/v1\/swarm\/bot\/([0-9a-f]{64})$/.exec(u.pathname);
        if (tar) {
            return m.tars[tar[1]] ? answer(200, m.tars[tar[1]]) : answer(404, '');
        }
        return answer(200, u.pathname === '/v1/swarm/manifest.json' ? JSON.stringify({ build: 'b1', cards: 'c1', sizes: m.sizes }) : `// ${u.pathname}`);
    };
    return m;
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** A bundle's tar (ustar, as bot/compiled/bundle.py writes it) holding these files: {name: text}. */
function tarOf(files) {
    const parts = [];
    for (const [name, text] of Object.entries(files)) {
        const body = Buffer.from(text);
        const h = Buffer.alloc(512);
        h.write(name, 0, 'latin1');
        h.write('0000644\0', 100, 'latin1');
        h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
        h.write('0', 156, 'latin1');
        h.write('ustar\0' + '00', 257, 'latin1');
        parts.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
    return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

function makeWindow(name, { mode, fetchImpl, wake = () => undefined, clock = { t: Date.now() } } = {}) {
    const home = path.join(tmp, name);
    const store = new Store(home);
    let play = null;
    const auth = createAuth({ dir: path.join(home, 'auth'), env: ENV, fetch: fetchImpl, openTo: (n) => play?.(n) ?? false, invites: () => [], links: () => JSON.parse(store.getDoc('admin', 'links') ?? '{"links":[]}').links });
    const m = machine();
    const swarm = createSwarmRelay({ token: 'swarm-secret', machine: 'http://games', cacheDir: path.join(home, 'swarm'), botDir: path.join(home, 'swarm-bots'), fetchImpl: m.fetchImpl, now: () => clock.t });
    const kit = path.join(tmp, `${name}-kit.js`);
    fs.writeFileSync(kit, `window.SWUViewer = {}; // ${'x'.repeat(2000)}`);
    const w = createWindow({ home, auth, swarm, kit, app: path.join(tmp, 'none.html'), minMs: 0, wakeGames: wake, play: mode });
    play = (n) => /^\/play/.test(n) && mode === 'github';
    return { w, m, store };
}

async function serve(w) {
    const srv = http.createServer((req, res) => w.handle(req, res)).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const go = (p, { method = 'GET', cookie, body, type = 'application/json', origin } = {}) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, {
        method, redirect: 'manual', body, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': type } : {}), ...(origin ? { origin } : {}) }
    });
    return { go, close: () => new Promise((r) => srv.close(r)) };
}

const session = (w, login) => `swu_session=${w.auth.sign({ l: login, exp: Date.now() + 60000 })}`;

/** A finished game as the play worker writes it: the person in seat 1, the JEPA bot in seat 2. */
function replay({ seed = 11, winner = 'p2', outcome = 'won', by = null, error = null, bot = 'jepa-tx-gate', steps = 3 } = {}) {
    const header = { t: 'header', v: 1, seed, engine: null, players: [{ id: 'p1', bot: 'person', deck: 'darth-vader_jtl_yellow', lang: 'person' }, { id: 'p2', bot, deck: 'luke-skywalker_jtl_data-vault', lang: 'js' }],
        decks: { p1: { metadata: { name: 'darth-vader_jtl_yellow' } }, p2: { metadata: { name: 'luke-skywalker_jtl_data-vault' } } } };
    const lines = [header, ...Array.from({ length: steps }, (_, n) => ({ t: 'step', n, state: {} })), { t: 'end', winner, round: 4, steps, outcome, error, by }];
    return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

test('who may play: invited people by default, anyone with GitHub in github mode, no one when off', async () => {
    for (const mode of [undefined, 'github', 'off']) {
        const { w } = makeWindow(`who-${mode}`, { mode });
        const { go, close } = await serve(w);
        try {
            const page = async (cookie) => {
                const r = await go('/play', { cookie });
                return [r.status, await r.text()];
            };
            if (mode === 'off') {
                assert.strictEqual((await page(session(w, 'pal')))[0], 404);
                assert.strictEqual((await go('/api/play/info', { cookie: session(w, 'pal') })).status, 404);
                continue;
            }
            const [anonStatus, anon] = await page();
            assert.strictEqual(anonStatus, 200);
            assert.match(anon, /Sign in with GitHub/);
            assert.match(anon, /\/auth\/github\?next=%2Fplay/);
            assert.match(anon, mode === 'github' ? /Anyone with a GitHub account/ : /people Eric invited/);
            const [palStatus, pal] = await page(session(w, 'pal'));
            assert.strictEqual(palStatus, 200);
            assert.match(pal, /SWUViewer\.mountPlay/);
            // isolated, so an arena bot's stdin (a SharedArrayBuffer) works; credentialless, so the card art still loads
            const headers = (await go('/play', { cookie: session(w, 'pal') })).headers;
            assert.deepStrictEqual([headers.get('cross-origin-opener-policy'), headers.get('cross-origin-embedder-policy')], ['same-origin', 'credentialless']);
            const [strangerStatus, stranger] = await page(session(w, 'stranger'));
            assert.strictEqual(strangerStatus, mode === 'github' ? 200 : 403);
            assert.match(stranger, mode === 'github' ? /mountPlay/ : /stranger.*is not on the list yet/s);
            // the page's kit, for people who may play but cannot read the arena
            assert.strictEqual((await go('/play/kit.js', { cookie: session(w, 'stranger') })).status, mode === 'github' ? 200 : 403);
            assert.strictEqual((await go('/kit.js', { cookie: session(w, 'stranger') })).status, 403, 'the arena itself stays for invited people');
            assert.strictEqual((await go('/api/play/info')).status, 401);
            assert.strictEqual((await go('/api/play/info', { cookie: session(w, 'stranger') })).status, mode === 'github' ? 200 : 403);
        } finally {
            await close();
        }
    }
});

test("the kit's license list is open to anyone, next to /kit.js and /play/kit.js", async () => {
    const { w } = makeWindow('licenses');
    const licenses = path.join(tmp, 'swu-viewer-kit.licenses.txt');
    const { go, close } = await serve(w);
    try {
        assert.strictEqual((await go('/swu-viewer-kit.licenses.txt')).status, 404, 'no list next to the kit, none served');
        fs.writeFileSync(licenses, 'Third-party software in the Holotable viewer kit\n');
        for (const p of ['/swu-viewer-kit.licenses.txt', '/play/swu-viewer-kit.licenses.txt']) {
            const r = await go(p);
            assert.strictEqual(r.status, 200, p);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(await r.text(), /Third-party software/);
        }
    } finally {
        await close();
        fs.rmSync(licenses, { force: true });
    }
});

test("a view link's guest has no GitHub login, so the play page asks them to sign in", async () => {
    const { w, store } = makeWindow('guest');
    store.putDoc('admin', 'links', JSON.stringify({ links: [{ id: 'l1', key: 'k'.repeat(24) }] }));
    const { go, close } = await serve(w);
    try {
        const guest = `swu_session=${w.auth.sign({ v: 'l1', exp: Date.now() + 60000 })}`;
        const r = await go('/play', { cookie: guest });
        assert.strictEqual(r.status, 200);
        assert.match(await r.text(), /Sign in with GitHub/);
        assert.strictEqual((await go('/api/play/info', { cookie: guest })).status, 401);
    } finally {
        await close();
    }
});

test('github mode: signing in from the play page comes back to it, even with no invite', async () => {
    const fakeGithub = async (url) => ({ json: async () => (url.includes('access_token') ? { access_token: 't' } : { login: 'stranger', id: 9 }) });
    for (const mode of ['github', 'invited']) {
        const { w } = makeWindow(`signin-${mode}`, { mode, fetchImpl: fakeGithub });
        const { go, close } = await serve(w);
        try {
            const start = await go('/auth/github?next=%2Fplay');
            const state = new URL(start.headers.get('location')).searchParams.get('state');
            const back = await go(`/auth/github/callback?code=c&state=${state}`, { cookie: start.headers.get('set-cookie').split(';')[0] });
            assert.strictEqual(back.headers.get('location'), mode === 'github' ? '/play' : '/');
        } finally {
            await close();
        }
    }
});

test("the page's files come from the games machine and stay on the window's disk while it sleeps", async () => {
    let woke = 0;
    const clock = { t: Date.now() };
    const { w, m } = makeWindow('files', { wake: () => woke++, clock });
    const { go, close } = await serve(w);
    try {
        const pal = session(w, 'pal');
        const info = (await (await go('/api/play/info', { cookie: pal })).json()).result;
        assert.deepStrictEqual([info.ready, info.build], [true, 'b1']);
        assert.deepStrictEqual(Object.fromEntries(Object.entries(info.files).map(([k, f]) => [k, f.url])), { pack: '/play/engine.json?b=b1', worker: '/play/play-worker.js?b=b1', botWorker: '/play/bot-worker.js?b=b1' });
        const worker = await go('/play/play-worker.js?b=b1', { cookie: pal });
        assert.strictEqual(worker.status, 200);
        assert.strictEqual(worker.headers.get('x-raw-length'), String('// /v1/swarm/play-worker.js'.length), 'the unzipped size, for the progress bar');
        assert.strictEqual(await worker.text(), '// /v1/swarm/play-worker.js');
        const again = (await (await go('/api/play/info', { cookie: pal })).json()).result;
        assert.strictEqual(again.files.worker.bytes, '// /v1/swarm/play-worker.js'.length, "a file on the window's disk has its size");
        assert.strictEqual((await go('/play/referee-worker.js?b=b1', { cookie: pal })).status, 404, 'only the play files');
        await new Promise((r) => setTimeout(r, 50)); // the info call keeps both files in the background
        assert.ok(m.asked.includes('/v1/swarm/engine.json'));
        // asleep, past the minute the window trusts the machine's build: the window still has build b1's files
        m.awake = false;
        clock.t += 120000;
        const asleep = (await (await go('/api/play/info', { cookie: pal })).json()).result;
        assert.deepStrictEqual([asleep.ready, asleep.build], [true, 'b1']);
        const pack = await go('/play/engine.json?b=b1', { cookie: pal });
        assert.strictEqual(pack.status, 200);
        assert.strictEqual(await pack.text(), '// /v1/swarm/engine.json');
        assert.strictEqual(woke, 0, 'nothing to wake it for');
    } finally {
        await close();
    }
});

test("the bots a person may pick: the JEPA bot, then the latest round's versions by rating, with their bundles", async () => {
    const clock = { t: Date.now() };
    let woke = 0;
    const { w, m, store } = makeWindow('bots', { clock, wake: () => woke++ });
    const nova = tarOf({ 'arena.json': '{"runtime":"wasi-p1"}', 'bot.wasm': 'nova' });
    const ember = tarOf({ 'arena.json': '{"runtime":"python-3.14-wasi"}', 'main.py': 'print(1)' });
    const pyro = tarOf({ 'arena.json': '{"runtime":"wasi-p1"}', 'bot.wasm': 'pyro' });
    m.lineup = { round: 21, capMs: 45000, bots: [
        { bundle: sha256(nova), bytes: nova.length, name: 'nova-v3' },
        { bundle: sha256(ember), bytes: ember.length, name: 'ember-v2' },
        { bundle: sha256(pyro), bytes: pyro.length, name: 'pyro-v1' },
        { bundle: sha256(nova), bytes: nova.length, name: 'Not A Version' }
    ] };
    // pyro's tar on the machine is not the one its sha256 names
    m.tars = { [sha256(nova)]: nova, [sha256(ember)]: ember, [sha256(pyro)]: Buffer.from('something else') };
    // this build has Python for bots (Dockerfile.games packs it): its sizes are in the machine's manifest
    m.sizes = { 'python-lib.json': 9000, 'python.wasm': 14000 };
    store.putDoc('arena', 'standings', JSON.stringify({ rounds: [], global: { 'nova-v3': 1500.4, 'pyro-v1': 1610 } }));
    // Eric's time per bot per game has changed since that round: a version plays under its round's
    store.putDoc('admin', 'arena-settings', JSON.stringify({ settings: { thinkCapSec: 90 } }));
    const { go, close } = await serve(w);
    try {
        const pal = session(w, 'pal');
        const bots = async () => (await (await go('/api/play/bots', { cookie: pal })).json()).result;
        const first = await bots();
        assert.deepStrictEqual([first.ready, first.round, first.capMs], [true, 21, 45000]);
        assert.deepStrictEqual(first.bots.map((b) => [b.name, b.title, b.kind, b.elo]), [['jepa-tx-gate', "Eric's JEPA bot", 'jepa', null], ['pyro-v1', 'pyro', 'arena', 1610], ['nova-v3', 'nova', 'arena', 1500], ['ember-v2', 'ember', 'arena', null]]);
        assert.deepStrictEqual(first.bots[0].files.map((f) => [f.url, f.path]), [['/play/tx-t10.safetensors?b=b1', '/app/vendor/jepa/tx-t10.safetensors'], ['/play/tx-t10-e.safetensors?b=b1', '/app/vendor/jepa/tx-t10-e.safetensors']]);
        assert.deepStrictEqual(first.runtimes, { 'python-3.14-wasi': { lib: { url: '/play/python-lib.json?b=b1', bytes: 9000, wire: null }, wasm: { url: '/play/python.wasm?b=b1', bytes: 14000, wire: null } } });
        assert.strictEqual((await go('/api/play/bots')).status, 401);
        // the window keeps the lineup's bundles as soon as it learns it, before anyone asks for one
        const kept = (b) => path.join(tmp, 'bots', 'swarm-bots', `${sha256(b)}.tar`);
        for (let i = 0; i < 100 && !(fs.existsSync(`${kept(nova)}.gz`) && fs.existsSync(`${kept(ember)}.gz`)); i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(fs.existsSync(kept(nova)) && fs.existsSync(`${kept(ember)}.gz`) && !fs.existsSync(kept(pyro)));

        // with its bundle here, a bot's runtime (its arena.json) and what it downloads (the bundle's gzip) are known
        const r = await bots();
        const nv = r.bots.find((b) => b.name === 'nova-v3');
        assert.deepStrictEqual([nv.bundle, nv.runtime, nv.capMs], [{ url: `/play/bundle/${sha256(nova)}`, hex: sha256(nova), bytes: nova.length, wire: fs.statSync(`${kept(nova)}.gz`).size }, 'wasi-p1', 45000]);
        assert.strictEqual(r.bots.find((b) => b.name === 'ember-v2').runtime, 'python-3.14-wasi');
        assert.deepStrictEqual([r.bots.find((b) => b.name === 'pyro-v1').runtime, r.bots.find((b) => b.name === 'pyro-v1').bundle.wire], [null, null], 'not here: not known yet');

        const tar = await go(`/play/bundle/${sha256(nova)}`, { cookie: pal });
        assert.strictEqual(tar.status, 200);
        assert.deepStrictEqual([tar.headers.get('content-type'), tar.headers.get('x-raw-length'), tar.headers.get('cross-origin-resource-policy')], ['application/x-tar', String(nova.length), 'same-origin']);
        assert.deepStrictEqual(Buffer.from(await tar.arrayBuffer()), nova);
        assert.match((await go(`/play/bundle/${sha256(nova)}`)).headers.get('content-type'), /^text\/html/, 'signed out: the sign-in page');
        assert.strictEqual(woke, 0);
        const bad = await go(`/play/bundle/${sha256(pyro)}`, { cookie: pal });
        assert.strictEqual(bad.status, 503, 'a tar that is not what its sha256 names is not served');
        assert.strictEqual(woke, 1, 'a bundle the window does not have wakes the machine');
        assert.strictEqual((await go(`/play/bundle/${sha256(Buffer.from('x'))}`, { cookie: pal })).status, 404, "only the latest round's bundles");

        // asleep: the window answers from the lineup and the bundles it kept
        m.awake = false;
        clock.t += 10 * 60000;
        assert.deepStrictEqual((await bots()).bots.map((b) => b.name), ['jepa-tx-gate', 'pyro-v1', 'nova-v3', 'ember-v2']);
        const again = await go(`/play/bundle/${sha256(nova)}`, { cookie: pal });
        assert.deepStrictEqual([again.status, Buffer.from(await again.arrayBuffer())], [200, nova]);
    } finally {
        await close();
    }
});

test('before any round, the JEPA bot is the only one to pick', async () => {
    const { w } = makeWindow('no-round');
    const { go, close } = await serve(w);
    try {
        const r = (await (await go('/api/play/bots', { cookie: session(w, 'pal') })).json()).result;
        assert.deepStrictEqual([r.round, r.capMs, r.bots.map((b) => b.name)], [null, null, ['jepa-tx-gate']]);
        assert.deepStrictEqual(r.runtimes, {}, 'a build with no Python offers none');
    } finally {
        await close();
    }
});

test('a sleeping games machine with no files on the window is woken, once, and the page waits', async () => {
    let woke = 0;
    const { w, m } = makeWindow('asleep', { wake: () => woke++ });
    m.awake = false;
    const { go, close } = await serve(w);
    try {
        for (let i = 0; i < 2; i++) {
            const info = (await (await go('/api/play/info', { cookie: session(w, 'pal') })).json()).result;
            assert.strictEqual(info.ready, false);
            assert.match(info.why, /starting/);
        }
        assert.strictEqual(woke, 1);
    } finally {
        await close();
    }
});

test('finished games come back to the window: kept once, unrated, the person named only to admins', async () => {
    const { w, store } = makeWindow('games');
    const { go, close } = await serve(w);
    try {
        const pal = session(w, 'pal');
        const send = (body, opts = {}) => go('/api/play/games', { method: 'POST', cookie: pal, origin: ORIGIN, body: JSON.stringify(body), ...opts });
        assert.strictEqual((await send({ replay: replay() }, { origin: 'https://evil.example' })).status, 403, "only from the site's own page");
        assert.strictEqual((await send({ replay: replay() }, { type: 'text/plain' })).status, 400, 'JSON only');
        for (const bad of [{ bot: 'rush' }, { steps: 0 }]) {
            const r = await send({ replay: replay(bad) });
            assert.strictEqual(r.status, 400, JSON.stringify(bad));
        }
        assert.strictEqual((await send({ replay: replay().replace('"t":"end"', '"t":"nope"') })).status, 400);
        const first = await send({ replay: replay() });
        assert.strictEqual(first.status, 200);
        const { id } = (await first.json()).result;
        assert.match(id, /^play-0000000b-[0-9a-f]{8}$/);
        assert.deepStrictEqual((await (await send({ replay: replay() })).json()).result, { id, again: true }, 'a resend keeps one game');
        const conceded = (await (await send({ replay: replay({ seed: 12, winner: 'p2', outcome: 'ERROR', by: 'p1', error: 'p1: conceded' }) })).json()).result.id;
        // a game against an arena version
        const won = (await (await send({ replay: replay({ seed: 13, winner: 'p1', bot: 'nova-v3' }) })).json()).result.id;

        const run = JSON.parse(store.getDoc('runs', 'play'));
        assert.deepStrictEqual([run.feed, run.bots, run.games.length], ['play', ['jepa-tx-gate', 'nova-v3'], 3]);
        assert.deepStrictEqual(run.games.map((g) => [g.p1, g.p2, g.outcome, g.winnerSeat, g.winner, g.conceded, g.error]),
            [['opponent', 'jepa-tx-gate', 'won', 'p2', 'jepa-tx-gate', false, null], ['opponent', 'jepa-tx-gate', 'won', 'p2', 'jepa-tx-gate', true, null], ['opponent', 'nova-v3', 'won', 'p1', 'opponent', false, null]]);
        assert.ok(!store.getDoc('runs', 'play').includes('pal'), 'the run never names the person');
        assert.deepStrictEqual(JSON.parse(store.getDoc('admin', 'people')).names, { [id]: '@pal', [conceded]: '@pal', [won]: '@pal' });

        // the person reads their own games back; another invited person does not
        const mine = (await (await go('/api/play/info', { cookie: pal })).json()).result;
        assert.deepStrictEqual(mine.games.map((g) => [g.id, g.bot, g.winner, g.conceded]), [[won, 'nova-v3', 'you', false], [conceded, 'jepa-tx-gate', 'jepa-tx-gate', true], [id, 'jepa-tx-gate', 'jepa-tx-gate', false]]);
        assert.strictEqual(mine.all, undefined);
        assert.strictEqual(await (await go(`/api/play/games/${id}.jsonl`, { cookie: pal })).text(), replay());
        assert.strictEqual((await go(`/api/play/games/${id}.jsonl`, { cookie: session(w, 'pal2') })).status, 404);
        // Eric sees every game and who played it
        const eric = (await (await go('/api/play/info', { cookie: session(w, 'ericfode') })).json()).result;
        assert.deepStrictEqual(eric.all.map((g) => g.person), ['@pal', '@pal', '@pal']);
        assert.strictEqual((await go(`/api/play/games/${id}.jsonl`, { cookie: session(w, 'ericfode') })).status, 200);
        // readers of the arena see a people run: "opponent", and "a person" in the replay
        const read = await (await go('/api/docs/runs/play', { cookie: session(w, 'pal2') })).json();
        assert.deepStrictEqual(read.result.games.map((g) => g.p1), ['opponent', 'opponent', 'opponent']);
        assert.match(await (await go(`/replays/play/games/${id}.jsonl`, { cookie: session(w, 'pal2') })).text(), /"bot":"a person"/);
    } finally {
        await close();
    }
});

test('the replay check takes the play worker\'s games and nothing else', () => {
    assert.strictEqual(checkReplay(replay()).steps, 3);
    assert.strictEqual(checkReplay(replay({ bot: 'nova-v3' })).bot, 'nova-v3', 'an arena version');
    assert.throws(() => checkReplay(replay({ bot: 'heuristic' })), /jepa-tx-gate or an arena version in seat 2/);
    assert.throws(() => checkReplay(''), /JSON Lines/);
    assert.throws(() => checkReplay(replay({ seed: -1 })), /seed/);
    assert.throws(() => checkReplay(replay().replace('{"t":"step","n":1', '{"t":"header","n":1')), /a step/);
    assert.throws(() => checkReplay(replay().replace('{"t":"step","n":1', '{"t":"step"not-json,"n":1')), /line 3: not a replay event/);
    assert.throws(() => checkReplay(replay().replace('darth-vader_jtl_yellow"}', '<b>"}')), /deck lists/);
});
