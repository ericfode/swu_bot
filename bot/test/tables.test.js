'use strict';
// The window's open tables (bot/arena/tables.js, lobby.js, swudb.js): who may play, the bots from the arena's latest
// round, SWUDB decks, linking two browsers (invite codes, the queue, the relay), finished games kept for training, and
// the open log API read with a reader token. No engine: the games themselves run in a tab (bot/test/open-table.test.js).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tables-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
Object.assign(process.env, { ARENA_HOME: path.join(tmp, 'arena-home'), ARENA_RESULTS: path.join(tmp, 'arena-results'), ARENA_DASH: path.join(tmp, 'no-dash') });

const { createWindow, Store } = require('../arena/window');
const { createAuth } = require('../arena/auth');
const { createSwarmRelay } = require('../arena/swarm-relay');
const { checkReplay, isoWeek, pageOf } = require('../arena/tables');
const { createLobby, QUEUE_BYTES, KEEP_BYTES } = require('../arena/lobby');
const { swudbId, fromSwudbApi, deckFromJson, fetchSwudb } = require('../arena/swudb');

const ENV = { ARENA_PUSH_TOKEN: 'push-secret', ARENA_ADMIN_TOKEN: 'admin-secret', ARENA_ADMINS: 'ericfode', ARENA_INVITES: 'pal,pal2', GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', ARENA_PUBLIC_URL: 'https://swu-arena.fly.dev' };
const ORIGIN = 'https://swu-arena.fly.dev';
const TAR = Buffer.from('a bot bundle, as the games machine keeps it');
const HEX = crypto.createHash('sha256').update(TAR).digest('hex');

/** SWUDB's deck API answer for a small Vader list (its own card numbers, unpadded). */
const card = (set, n, name = 'a card') => ({ cardName: name, defaultExpansionAbbreviation: set, defaultCardNumber: n });
const SWUDB = {
    deckId: 'CnASlfGsnzRHe', deckName: 'Vader Aggro', authorName: 'someone', deckFormat: 1, leader: card('JTL', 9, 'Darth Vader'), secondLeader: null, base: card('SOR', 23),
    shuffledDeck: [{ card: card('SOR', 10), count: 3, sideboardCount: 0 }, { card: card('JTL', 120), count: 2, sideboardCount: 1 }, { card: card('SOR', 99), count: 0, sideboardCount: 2 }]
};

/** A games machine with build b1, a lineup of one bot version, and its bundle; or asleep (every request fails). */
function machine() {
    const m = { awake: true, asked: [] };
    m.fetchImpl = async (url) => {
        const u = new URL(url);
        m.asked.push(u.pathname);
        if (!m.awake) {
            throw new TypeError('fetch failed');
        }
        let status = 200;
        let body = `// ${u.pathname}`;
        if (u.pathname === '/v1/swarm/manifest.json') {
            body = JSON.stringify({ build: 'b1', cards: 'c1' });
        } else if (u.pathname === '/v1/swarm/lineup.json') {
            body = JSON.stringify({ round: 7, bots: [{ name: 'tinybot-v2', bundle: HEX, bytes: TAR.length }, { name: 'Bad Name', bundle: HEX }] });
        } else if (u.pathname.startsWith('/v1/swarm/bot/')) {
            [status, body] = u.pathname.endsWith(HEX) ? [200, TAR] : [404, '{}'];
        }
        return { status, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from(body) };
    };
    return m;
}

function makeWindow(name, { mode, deckFetch, swarmOn = true } = {}) {
    const home = path.join(tmp, name);
    const store = new Store(home);
    let tablesOpen = () => false;
    const auth = createAuth({ dir: path.join(home, 'auth'), env: ENV, openTo: (n) => tablesOpen(n), invites: () => [], links: () => [] });
    const m = machine();
    const swarm = createSwarmRelay({ token: swarmOn ? 'swarm-secret' : null, machine: 'http://games', cacheDir: path.join(home, 'swarm'), botDir: path.join(home, 'swarm-bots'), fetchImpl: m.fetchImpl });
    const kit = path.join(tmp, `${name}-kit.js`);
    fs.writeFileSync(kit, 'window.SWUViewer = {};');
    const w = createWindow({ home, auth, swarm, kit, app: path.join(tmp, 'none.html'), minMs: 0, wakeGames: () => undefined, tables: mode, tablesFetch: deckFetch });
    tablesOpen = (n) => w.tables.openTo(n);
    // the arena's documents the bot list reads: who is competing, and each version's submission
    store.putDoc('arena', 'status', JSON.stringify({ competitors: [{ name: 'tinybot', title: 'Tiny Bot', owner: 'github:pal2', latest: 'tinybot-v2', elo: 1234.4 }] }));
    store.putDoc('arena', 'versions-tinybot', JSON.stringify([{ v: 2, name: 'tinybot-v2', note: 'small and quick', files: ['arena.json', 'bot.py'], bot: { kind: 'wasm' } }]));
    return { w, m, store, home };
}

async function serve(w) {
    const srv = http.createServer((req, res) => w.handle(req, res)).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const go = (p, { method = 'GET', cookie, body, type = 'application/json', origin, headers = {}, signal } = {}) => fetch(`${base}${p}`, {
        method, redirect: 'manual', body, signal, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': type } : {}), ...(origin ? { origin } : {}), ...headers }
    });
    const post = (p, cookie, body = {}) => go(p, { method: 'POST', cookie, origin: ORIGIN, body: JSON.stringify(body) });
    return { go, post, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

const session = (w, login) => `swu_session=${w.auth.sign({ l: login, exp: Date.now() + 60000 })}`;
const result = async (r) => {
    const j = await r.json();
    assert.ok(r.ok, `HTTP ${r.status}: ${JSON.stringify(j)}`);
    return j.result;
};

/** The server-sent events of a response, one parsed {id, data} at a time; next() gives null once the stream ends. */
function events(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const queue = [];
    let buf = '';
    let ended = false;
    let wake = null;
    (async () => {
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                buf += dec.decode(value, { stream: true });
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, i).split('\n');
                    buf = buf.slice(i + 2);
                    const data = block.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
                    if (data) {
                        queue.push({ id: block.find((l) => l.startsWith('id: '))?.slice(4) ?? null, data: JSON.parse(data) });
                        wake?.();
                    }
                }
            }
        } catch {
            // cancelled
        }
        ended = true;
        wake?.();
    })();
    return {
        async next(ms = 3000) {
            const until = Date.now() + ms;
            while (!queue.length && !ended) {
                const left = until - Date.now();
                assert.ok(left > 0, 'no event came');
                await new Promise((r) => {
                    wake = r;
                    setTimeout(r, left);
                });
            }
            return queue.shift() ?? null;
        },
        cancel: () => reader.cancel().catch(() => undefined)
    };
}

/** A finished open-table game as tables-worker.js writes it. */
function replay({ seed = 11, p1 = 'pl_aaaaaa', p2 = 'tinybot-v2', l1 = 'person', l2 = 'wasm', winner = 'p2', outcome = 'won', by = null, error = null, steps = 3 } = {}) {
    const header = { t: 'header', v: 1, seed, key: 'k', engine: null, players: [{ id: 'p1', bot: p1, deck: 'Vader Aggro', lang: l1 }, { id: 'p2', bot: p2, deck: 'luke-skywalker_jtl_data-vault', lang: l2 }],
        decks: { p1: { metadata: { name: 'Vader Aggro' } }, p2: { metadata: { name: 'luke-skywalker_jtl_data-vault' } } } };
    const lines = [header, ...Array.from({ length: steps }, (_, n) => ({ t: 'step', n, state: {} })), { t: 'end', winner, round: 4, steps, outcome, error, by }];
    return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** The files of a ustar archive: {name: Buffer}. */
function untar(buf) {
    const out = {};
    for (let off = 0; off + 512 <= buf.length;) {
        const h = buf.subarray(off, off + 512);
        if (h.every((b) => b === 0)) {
            break;
        }
        const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
        const size = parseInt(h.subarray(124, 136).toString('utf8'), 8);
        out[name] = buf.subarray(off + 512, off + 512 + size);
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
}

test('SWUDB links and deck lists: the id from any link form, the API answer and the JSON export as the arena\'s deck form', async () => {
    for (const s of ['https://swudb.com/deck/CnASlfGsnzRHe', 'swudb.com/deck/CnASlfGsnzRHe', 'https://www.swudb.com/deck/CnASlfGsnzRHe?tab=1', 'https://swudb.com/deck/view/CnASlfGsnzRHe', ' CnASlfGsnzRHe ']) {
        assert.strictEqual(swudbId(s), 'CnASlfGsnzRHe', s);
    }
    for (const s of ['https://example.com/deck/CnASlfGsnzRHe', 'https://swudb.com/user/x', '', 'a b']) {
        assert.strictEqual(swudbId(s), null, s);
    }
    const want = { metadata: { name: 'Vader Aggro' }, leader: { id: 'JTL_009', count: 1 }, base: { id: 'SOR_023', count: 1 }, deck: [{ id: 'SOR_010', count: 3 }, { id: 'JTL_120', count: 2 }] };
    assert.deepStrictEqual(fromSwudbApi(SWUDB), want, 'no author, no sideboard, padded set codes');
    assert.deepStrictEqual(deckFromJson(JSON.stringify(SWUDB)), want);
    assert.throws(() => fromSwudbApi({ ...SWUDB, secondLeader: card('SOR', 5), deckFormat: 2 }), /Twin Suns/);
    assert.throws(() => fromSwudbApi({ ...SWUDB, base: null }), /leader and a base/);
    assert.throws(() => fromSwudbApi({ ...SWUDB, shuffledDeck: [{ card: { cardName: 'x' }, count: 1 }] }), /no set code \(x\)/);
    // SWUDB's export (Export, then JSON)
    const exported = { metadata: { name: 'Vader Aggro', author: 'someone' }, leader: { id: 'JTL_9', count: 1 }, base: { id: 'SOR_023', count: 1 }, deck: [{ id: 'SOR_010', count: 3 }, { id: 'JTL_120', count: 2 }], sideboard: [{ id: 'SOR_099', count: 2 }] };
    assert.deepStrictEqual(deckFromJson(JSON.stringify(exported)), want);
    assert.throws(() => deckFromJson('not json'), /paste a SWUDB link/);
    assert.throws(() => deckFromJson('{"leader": {"id": "JTL_009"}}'), /needs leader.id, base.id and a deck/);

    const answers = [];
    const fake = (status, body) => async (url) => (answers.push(url), { status, ok: status === 200, arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
    assert.deepStrictEqual(await fetchSwudb('CnASlfGsnzRHe', { fetchImpl: fake(200, SWUDB) }), want);
    assert.strictEqual(answers[0], 'https://www.swudb.com/api/deck/CnASlfGsnzRHe');
    await assert.rejects(fetchSwudb('CnASlfGsnzRHe', { fetchImpl: fake(404, '') }), /no public deck with that link/);
    await assert.rejects(fetchSwudb('CnASlfGsnzRHe', { fetchImpl: fake(500, '') }), /HTTP 500; paste the deck as JSON/);
    await assert.rejects(fetchSwudb('CnASlfGsnzRHe', { fetchImpl: fake(200, '<html>') }), /did not send a deck/);
    await assert.rejects(fetchSwudb('CnASlfGsnzRHe', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), /SWUDB did not answer/);
    await assert.rejects(fetchSwudb('../x', { fetchImpl: fake(200, SWUDB) }), /not a SWUDB deck link/);
});

test('who may play: invited people by default, anyone with GitHub in github mode, no one when off; the logs page for anyone signed in', async () => {
    for (const mode of [undefined, 'github', 'off']) {
        const { w } = makeWindow(`who-${mode}`, { mode });
        const { go, close } = await serve(w);
        try {
            const logs = await go('/tables/logs', { cookie: session(w, 'stranger') });
            assert.strictEqual(logs.status, 200);
            assert.match(await logs.text(), /Make my reader token/, 'reader tokens are for anyone with GitHub, whatever the mode');
            assert.ok(w.tables.openTo('/tables/logs'), 'sign-in may come back to the logs page with no role');
            assert.strictEqual(w.tables.openTo('/tables'), mode === 'github');
            if (mode === 'off') {
                assert.strictEqual((await go('/tables', { cookie: session(w, 'pal') })).status, 404);
                assert.strictEqual((await go('/api/tables/info', { cookie: session(w, 'pal') })).status, 404);
                continue;
            }
            const anon = await go('/tables');
            assert.strictEqual(anon.status, 200);
            assert.match(await anon.text(), /\/auth\/github\?next=%2Ftables/);
            const pal = await go('/tables', { cookie: session(w, 'pal') });
            assert.strictEqual(pal.status, 200);
            assert.strictEqual(pal.headers.get('cross-origin-opener-policy'), 'same-origin');
            assert.strictEqual(pal.headers.get('cross-origin-embedder-policy'), 'credentialless', 'isolated, and the CDN card art still loads');
            assert.match(await pal.text(), /mountPlay/);
            const stranger = await go('/tables', { cookie: session(w, 'stranger') });
            assert.strictEqual(stranger.status, mode === 'github' ? 200 : 403);
            if (mode !== 'github') {
                assert.match(await stranger.text(), /stranger.*is not on the list yet/s);
            }
            assert.strictEqual((await go('/api/tables/info')).status, 401);
            assert.strictEqual((await go('/api/tables/info', { cookie: session(w, 'stranger') })).status, mode === 'github' ? 200 : 403);
            assert.strictEqual((await go('/tables/kit.js', { cookie: session(w, 'pal') })).status, 200);
        } finally {
            await close();
        }
    }
});

test("the bots come from the arena's latest round, joined with the arena's own documents, and their bundles are kept on the window", async () => {
    const { w, m, home } = makeWindow('bots');
    const { go, close } = await serve(w);
    try {
        const pal = session(w, 'pal');
        const info = await result(await go('/api/tables/info', { cookie: pal }));
        assert.match(info.you, /^pl_[0-9a-f]{6}$/);
        assert.strictEqual((await result(await go('/api/tables/info', { cookie: pal }))).you, info.you, 'the same id every time');
        assert.notStrictEqual((await result(await go('/api/tables/info', { cookie: session(w, 'pal2') }))).you, info.you);
        assert.deepStrictEqual([info.ready, info.build, info.files.worker, info.files.pack], [true, 'b1', '/tables/tables-worker.js?b=b1', '/tables/engine.json?b=b1']);
        assert.deepStrictEqual(info.people, ['lobby', 'invite', 'join', 'direct']);
        assert.ok(info.decks.length > 10 && info.decks.every((d) => d.name && d.leader && d.base), 'the tournament lists');
        assert.deepStrictEqual(info.bots.map((b) => [b.name, b.title, b.owner, b.elo, b.runtime, b.url]), [
            ['jepa-tx-gate', "Eric's JEPA bot", 'ericfode', null, 'js', null],
            ['tinybot-v2', 'Tiny Bot', 'pal2', 1234, 'python', `/tables/bot/${HEX}.tar`]
        ], 'a lineup entry with a bad name is dropped');
        assert.strictEqual(info.bots[1].note, 'small and quick');

        await new Promise((r) => setTimeout(r, 50)); // the lineup's bundles are fetched in the background
        assert.ok(fs.existsSync(path.join(home, 'swarm-bots', `${HEX}.tar`)), 'kept on the window');
        const tar = await go(`/tables/bot/${HEX}.tar`, { cookie: pal, headers: { 'accept-encoding': 'identity' } });
        assert.strictEqual(tar.status, 200);
        assert.strictEqual(tar.headers.get('cross-origin-embedder-policy'), 'require-corp');
        assert.deepStrictEqual(Buffer.from(await tar.arrayBuffer()), TAR);
        assert.strictEqual((await go(`/tables/bot/${'0'.repeat(64)}.tar`, { cookie: pal })).status, 404, 'only bundles of the lineup');
        assert.strictEqual((await go('/tables/play-worker.js?b=b1', { cookie: pal })).status, 404, 'only the tables files');
        assert.strictEqual(await (await go('/tables/tables-worker.js?b=b1', { cookie: pal })).text(), '// /v1/swarm/tables-worker.js');

        // asleep: the window still has the lineup and the bundle
        m.awake = false;
        const again = await go(`/tables/bot/${HEX}.tar`, { cookie: pal, headers: { 'accept-encoding': 'gzip' } });
        assert.strictEqual(again.status, 200);
        assert.deepStrictEqual(Buffer.from(await again.arrayBuffer()), TAR, 'fetch undoes the gzip');
        assert.deepStrictEqual((await result(await go('/api/tables/info', { cookie: pal }))).bots.map((b) => b.name), ['jepa-tx-gate', 'tinybot-v2']);
    } finally {
        await close();
    }
});

test('with no games machine the page says why, and lists only the JEPA bot', async () => {
    const { w } = makeWindow('off-machine', { swarmOn: false });
    const { go, close } = await serve(w);
    try {
        const info = await result(await go('/api/tables/info', { cookie: session(w, 'pal') }));
        assert.strictEqual(info.ready, false);
        assert.match(info.why, /SWARM_HELPER_TOKEN/);
        assert.deepStrictEqual(info.bots.map((b) => b.name), ['jepa-tx-gate']);
    } finally {
        await close();
    }
});

test('decks: a SWUDB link is read on the window (and cached), a pasted list is converted, and bad input says why', async () => {
    const asked = [];
    const deckFetch = async (url) => {
        asked.push(url);
        const ok = url.endsWith('/CnASlfGsnzRHe');
        return { status: ok ? 200 : 404, ok, arrayBuffer: async () => Buffer.from(ok ? JSON.stringify(SWUDB) : '') };
    };
    const { w } = makeWindow('decks', { deckFetch });
    const { go, post, close } = await serve(w);
    try {
        const pal = session(w, 'pal');
        const r = await result(await post('/api/tables/deck', pal, { text: 'https://swudb.com/deck/CnASlfGsnzRHe' }));
        assert.deepStrictEqual([r.source, r.deck.metadata.name, r.deck.leader.id, r.deck.deck.length], ['swudb', 'Vader Aggro', 'JTL_009', 2]);
        await result(await post('/api/tables/deck', pal, { text: 'swudb.com/deck/CnASlfGsnzRHe' }));
        assert.deepStrictEqual(asked, ['https://www.swudb.com/api/deck/CnASlfGsnzRHe'], 'the second read comes from the cache');
        const missing = await post('/api/tables/deck', pal, { text: 'https://swudb.com/deck/NoSuchDeck1' });
        assert.strictEqual(missing.status, 400);
        assert.match((await missing.json()).error.message, /no public deck/);
        const pasted = await result(await post('/api/tables/deck', pal, { text: JSON.stringify({ metadata: { name: 'Mine', author: 'x' }, leader: { id: 'SOR_5' }, base: { id: 'SOR_23' }, deck: [{ id: 'SOR_10', count: 3 }] }) }));
        assert.deepStrictEqual([pasted.source, pasted.deck.metadata, pasted.deck.leader.id], ['json', { name: 'Mine' }, 'SOR_005']);
        for (const text of ['', 'hello there', '{"broken"']) {
            assert.strictEqual((await post('/api/tables/deck', pal, { text })).status, 400, text);
        }
        const other = await go('/api/tables/deck', { method: 'POST', cookie: pal, origin: 'https://evil.example', body: JSON.stringify({ text: 'CnASlfGsnzRHe' }) });
        assert.strictEqual(other.status, 403, "only from the site's own page");
    } finally {
        await close();
    }
});

test('an invite links two people: the host hears the guest join, messages go both ways, a lost stream gets what it missed', async () => {
    const { w } = makeWindow('invite');
    const { go, post, close } = await serve(w);
    const streams = [];
    const open = async (q, cookie, headers = {}) => {
        const r = await go(`/api/tables/stream?${new URLSearchParams(q)}`, { cookie, headers });
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /^text\/event-stream/);
        const s = events(r);
        streams.push(s);
        return s;
    };
    try {
        const pal = session(w, 'pal');
        const pal2 = session(w, 'pal2');
        const ids = { pal: (await result(await go('/api/tables/info', { cookie: pal }))).you, pal2: (await result(await go('/api/tables/info', { cookie: pal2 }))).you };
        const inv = await result(await post('/api/tables/invite', pal));
        assert.match(inv.code, /^[A-HJ-NP-Z2-9]{6}$/);
        const host = await open({ room: inv.room, side: 'host', k: inv.k }, pal);
        const send = (side, k, msg) => post(`/api/tables/send?${new URLSearchParams({ room: inv.room, side, k })}`, side === 'host' ? pal : pal2, { msg });
        assert.strictEqual((await send('host', inv.k, 'hello?')).status, 409, 'nobody has joined yet');
        assert.strictEqual((await post('/api/tables/join', pal2, { code: 'ZZZZZZ' })).status, 404);
        const join = await result(await post('/api/tables/join', pal2, { code: inv.code.toLowerCase() }));
        assert.strictEqual(join.peer, ids.pal);
        assert.strictEqual((await post('/api/tables/join', pal2, { code: inv.code })).status, 404, 'a code is used once');
        assert.deepStrictEqual((await host.next()).data, { room: 'joined', peer: ids.pal2 });
        // the guest's messages wait for its stream
        await result(await send('host', inv.k, { t: 'offer', sdp: 'x' }));
        await result(await send('host', inv.k, { t: 'hi', n: 2 }));
        const guest = await open({ room: join.room, side: 'guest', k: join.k }, pal2);
        const first = await guest.next();
        assert.deepStrictEqual(first.data, { msg: { t: 'offer', sdp: 'x' } });
        assert.deepStrictEqual((await guest.next()).data, { msg: { t: 'hi', n: 2 } });
        await result(await send('guest', join.k, { t: 'answer' }));
        assert.deepStrictEqual((await host.next()).data, { msg: { t: 'answer' } });
        assert.strictEqual((await send('guest', inv.k, 'x')).status, 404, "a side's messages need its own key");
        // the guest's stream drops and comes back after the first message: only the second comes again
        await guest.cancel();
        const back = await open({ room: join.room, side: 'guest', k: join.k }, pal2, { 'last-event-id': first.id });
        assert.deepStrictEqual((await back.next()).data, { msg: { t: 'hi', n: 2 } });
        // the host leaves: the guest is told, and its messages go nowhere
        await result(await post(`/api/tables/leave?${new URLSearchParams({ room: inv.room, side: 'host', k: inv.k })}`, pal));
        assert.deepStrictEqual((await back.next()).data, { room: 'left' });
        assert.strictEqual((await send('guest', join.k, 'still there?')).status, 409);
        assert.strictEqual((await go(`/api/tables/stream?${new URLSearchParams({ room: inv.room, side: 'host', k: 'nope' })}`, { cookie: pal })).status, 404);
    } finally {
        for (const s of streams) {
            await s.cancel();
        }
        await close();
    }
});

test('the queue pairs the two people who waited longest, and the one who waited longer hosts', async () => {
    const { w } = makeWindow('queue');
    const { go, post, close } = await serve(w);
    const streams = [];
    try {
        const [a, b] = [session(w, 'pal'), session(w, 'pal2')];
        const ta = await result(await post('/api/tables/queue', a));
        const sa = events(await go(`/api/tables/stream?${new URLSearchParams({ ticket: ta.ticket, k: ta.k })}`, { cookie: a }));
        streams.push(sa);
        assert.deepStrictEqual((await sa.next()).data, { t: 'waiting', people: 1 });
        assert.strictEqual(w.tables.lobby.stats().waiting, 1);
        const tb = await result(await post('/api/tables/queue', b));
        const sb = events(await go(`/api/tables/stream?${new URLSearchParams({ ticket: tb.ticket, k: tb.k })}`, { cookie: b }));
        streams.push(sb);
        const pa = (await sa.next()).data;
        const pb = (await sb.next()).data;
        assert.deepStrictEqual([pa.t, pa.side, pb.t, pb.side, pa.room], ['paired', 'host', 'paired', 'guest', pb.room]);
        assert.strictEqual(await sa.next(), null, 'a paired ticket stream ends');
        assert.deepStrictEqual(w.tables.lobby.stats(), { rooms: 1, waiting: 0 });
        // the paired room works like an invite's
        const guest = events(await go(`/api/tables/stream?${new URLSearchParams({ room: pb.room, side: 'guest', k: pb.k })}`, { cookie: b }));
        streams.push(guest);
        await result(await post(`/api/tables/send?${new URLSearchParams({ room: pa.room, side: 'host', k: pa.k })}`, a, { msg: 'go' }));
        assert.deepStrictEqual((await guest.next()).data, { msg: 'go' });
    } finally {
        for (const s of streams) {
            await s.cancel();
        }
        await close();
    }
});

test('a page of the open API never splits games played at the same time', () => {
    const rows = ['a', 'b', 'b', 'b', 'c'].map((t, i) => ({ id: `g${i}`, playedAt: t }));
    const pages = [];
    for (let since = null, guard = 0; guard < 9; guard++) {
        const p = pageOf(rows, since, 2);
        pages.push(p.games.map((g) => g.id));
        if (!p.next) {
            break;
        }
        since = p.next;
    }
    assert.deepStrictEqual(pages, [['g0', 'g1', 'g2', 'g3'], ['g4']]);
    assert.deepStrictEqual(pageOf(rows, 'b', 200), { games: [rows[4]], next: null });
});

test('the lobby counts only what waits for a side: a side that reads takes a long game, a stalled stream does not', () => {
    const lobby = createLobby({ setTimer: () => ({ unref() {} }), clearTimer: () => undefined });
    /** A response the side reads at once; `stall` bytes sit unread in its socket. */
    const reader = (stall = 0) => ({ got: [], writableLength: stall, writeHead() {}, on() {}, end() {}, write(t) { this.got.push(...[...t.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))); return true; } });
    const inv = lobby.invite({ login: 'a', pid: 'pl_aaaaaa' });
    const join = lobby.join(inv.code, { login: 'b', pid: 'pl_bbbbbb' });
    const res = reader();
    lobby.stream({ headers: {} }, res, { room: inv.room, side: 'guest', k: join.k });
    const big = 'z'.repeat(200000);
    const n = Math.ceil((3 * QUEUE_BYTES) / big.length);
    for (let i = 0; i < n; i++) {
        assert.strictEqual(lobby.send(inv.room, 'host', inv.k, big), null, `message ${i + 1} of ${n}`);
    }
    assert.deepStrictEqual([res.got.length, res.got.at(-1)], [n, n]);
    // a stream that comes back gets what it missed, from the last KEEP_BYTES it was sent
    const back = reader();
    lobby.stream({ headers: { 'last-event-id': String(n - 2) } }, back, { room: inv.room, side: 'guest', k: join.k });
    assert.deepStrictEqual(back.got, [n - 1, n]);
    const again = reader();
    lobby.stream({ headers: {} }, again, { room: inv.room, side: 'guest', k: join.k });
    assert.ok(again.got.length * big.length <= KEEP_BYTES && again.got.length >= 2, `kept ${again.got.length}`);
    // a stream whose socket takes nothing stops taking messages
    lobby.stream({ headers: {} }, reader(QUEUE_BYTES), { room: inv.room, side: 'guest', k: join.k });
    assert.match(lobby.send(inv.room, 'host', inv.k, big), /not reading/);
    lobby.close();
});

test('the lobby drops idle rooms and tickets whose stream never came, and caps what waits for one side', () => {
    const clock = { t: 0 };
    const lobby = createLobby({ now: () => clock.t, setTimer: () => ({ unref() {} }), clearTimer: () => undefined });
    const inv = lobby.invite({ login: 'a', pid: 'pl_aaaaaa' });
    const join = lobby.join(inv.code, { login: 'b', pid: 'pl_bbbbbb' });
    assert.strictEqual(join.room, inv.room);
    assert.strictEqual(lobby.send(inv.room, 'host', inv.k, 'x'.repeat(200)), null);
    let full = null;
    for (let i = 0; i < 100 && !full; i++) {
        full = lobby.send(inv.room, 'host', inv.k, 'y'.repeat(200000));
    }
    assert.match(full, /not reading/, 'a side that never reads stops taking messages');
    lobby.queue({ login: 'c', pid: 'pl_cccccc' });
    clock.t = 61000;
    lobby.sweep();
    assert.deepStrictEqual(lobby.stats(), { rooms: 1, waiting: 0 }, 'a ticket with no stream goes after a minute');
    clock.t = 31 * 60000;
    lobby.sweep();
    assert.deepStrictEqual(lobby.stats(), { rooms: 0, waiting: 0 }, 'a room nobody reads goes after 30 minutes');
    assert.throws(() => lobby.send(inv.room, 'host', inv.k, 'x'), /that table is gone/);
    lobby.close();
});

test('finished games are kept once for training, each player adds their seat, and players read only their own', async () => {
    const { w, store } = makeWindow('games');
    const { go, post, close } = await serve(w);
    try {
        const pal = session(w, 'pal');
        const pal2 = session(w, 'pal2');
        const me = (await result(await go('/api/tables/info', { cookie: pal }))).you;
        const them = (await result(await go('/api/tables/info', { cookie: pal2 }))).you;
        const people = replay({ seed: 300, p1: me, p2: them, l2: 'person', winner: 'p1' });
        assert.strictEqual((await post('/api/tables/games', pal, { replay: people, seat: 'p2' })).status, 400, 'your seat is the one with your id');
        assert.strictEqual((await post('/api/tables/games', pal, { replay: replay({ p1: 'someone' }), seat: 'p1' })).status, 400);
        // a replay under the limit whose JSON string is over it (each quote takes two bytes) reaches the replay check
        const quoted = await post('/api/tables/games', pal, { replay: '"'.repeat(9e6), seat: 'p1' });
        assert.deepStrictEqual([quoted.status, (await quoted.json()).error.code], [400, 'bad_request']);
        const kept = await result(await post('/api/tables/games', pal, { replay: people, seat: 'p1' }));
        assert.match(kept.id, /^open-0000012c-[0-9a-f]{8}$/);
        assert.deepStrictEqual(await result(await post('/api/tables/games', pal2, { replay: people, seat: 'p2' })), kept, 'the same game from the other player');
        const bot = await result(await post('/api/tables/games', pal, { replay: replay({ seed: 301, p1: me, outcome: 'ERROR', winner: 'p2', by: 'p1', error: 'p1: conceded' }), seat: 'p1' }));

        const run = JSON.parse(store.getDoc('runs', 'tables'));
        assert.deepStrictEqual([run.feed, run.bots, run.games.length], ['tables', ['tinybot-v2'], 2]);
        assert.deepStrictEqual(run.games.map((g) => [g.p1, g.p2, g.outcome, g.winner, g.conceded, g.concededBy, g.error]),
            [[me, them, 'won', me, false, null, null], [me, 'tinybot-v2', 'won', 'tinybot-v2', true, 'p1', null]]);
        assert.ok(!store.getDoc('runs', 'tables').includes('pal'), 'the run never names a GitHub login');
        assert.deepStrictEqual(JSON.parse(store.getDoc('admin', 'tables-people')).games, { [kept.id]: { p1: '@pal', p2: '@pal2' }, [bot.id]: { p1: '@pal' } });

        const mine = await result(await go('/api/tables/games', { cookie: pal }));
        assert.deepStrictEqual(mine.games.map((g) => [g.id, g.seat, g.opponent, g.won]), [[bot.id, 'p1', 'tinybot-v2', false], [kept.id, 'p1', them, true]]);
        assert.strictEqual(mine.all, undefined);
        assert.strictEqual(await (await go(`/api/tables/games/${kept.id}.jsonl`, { cookie: pal2 })).text(), people);
        assert.strictEqual((await go(`/api/tables/games/${bot.id}.jsonl`, { cookie: pal2 })).status, 404, "another player's game");
        const eric = await result(await go('/api/tables/games', { cookie: session(w, 'ericfode') }));
        assert.deepStrictEqual(eric.all.map((g) => g.people), [{ p1: '@pal' }, { p1: '@pal', p2: '@pal2' }]);
        // a new id for the next games; the old games keep the old one
        const renewed = (await result(await post('/api/tables/me', pal, { renew: true }))).you;
        assert.notStrictEqual(renewed, me);
        assert.strictEqual((await result(await go('/api/tables/info', { cookie: pal }))).you, renewed);
    } finally {
        await close();
    }
});

test('the open log API: a reader token for anyone with GitHub, the games oldest first, one game, and a week as a folder', async () => {
    const { w } = makeWindow('open');
    const { go, post, close } = await serve(w);
    try {
        const pal = session(w, 'pal');
        const me = (await result(await go('/api/tables/info', { cookie: pal }))).you;
        const ids = [];
        for (const seed of [500, 501]) {
            ids.push((await result(await post('/api/tables/games', pal, { replay: replay({ seed, p1: me }), seat: 'p1' }))).id);
        }
        assert.strictEqual((await go('/api/open/games')).status, 401);
        assert.strictEqual((await go('/api/open/games', { headers: { authorization: 'Bearer swu_r_nope' } })).status, 401);
        assert.strictEqual((await go('/api/tables/token', { method: 'POST', cookie: session(w, 'stranger'), origin: 'https://evil.example', body: '{}' })).status, 403);
        const token = (await result(await post('/api/tables/token', session(w, 'stranger')))).token;
        assert.match(token, /^swu_r_[0-9a-f]{48}$/, 'anyone signed in with GitHub, invited or not');
        const read = (p, t = token) => go(p, { headers: { authorization: `Bearer ${t}` } });
        const page = await result(await read('/api/open/games?limit=1'));
        assert.deepStrictEqual([page.games.map((g) => g.id), page.games[0].p1, page.games[0].week], [[ids[0]], me, isoWeek(page.games[0].playedAt)]);
        const rest = await result(await read(`/api/open/games?since=${encodeURIComponent(page.next)}`));
        assert.deepStrictEqual([rest.games.map((g) => g.id), rest.next], [[ids[1]], null]);
        assert.strictEqual(await (await read(`/api/open/games/${ids[0]}.jsonl`)).text(), replay({ seed: 500, p1: me }));
        assert.strictEqual((await read('/api/open/games/open-ffffffff-ffffffff.jsonl')).status, 404);
        const weeks = await result(await read('/api/open/weeks'));
        assert.strictEqual(weeks.length, 1);
        assert.strictEqual(weeks[0].games, 2);
        const gz = await read(weeks[0].file);
        assert.strictEqual(gz.status, 200);
        const files = untar(zlib.gunzipSync(Buffer.from(await gz.arrayBuffer())));
        const dir = `tables-${weeks[0].week}`;
        assert.deepStrictEqual(Object.keys(files).sort(), [`${dir}/games/${ids[0]}.jsonl`, `${dir}/games/${ids[1]}.jsonl`, `${dir}/index.json`]);
        assert.deepStrictEqual(JSON.parse(files[`${dir}/index.json`]).games.map((g) => g.id), ids);
        // a signed-in person reads without a token too; a new token ends the old one
        assert.strictEqual((await go('/api/open/weeks', { cookie: session(w, 'stranger') })).status, 200);
        const second = (await result(await post('/api/tables/token', session(w, 'stranger')))).token;
        assert.strictEqual((await read('/api/open/weeks')).status, 401);
        assert.strictEqual((await read('/api/open/weeks', second)).status, 200);
    } finally {
        await close();
    }
});

test("the replay check takes the tables worker's games: people by id, arena bots by version, at least one person", () => {
    assert.strictEqual(checkReplay(replay()).steps, 3);
    assert.strictEqual(checkReplay(replay({ p2: 'pl_bbbbbb', l2: 'person' })).steps, 3);
    assert.strictEqual(checkReplay(replay({ p2: 'jepa-tx-gate', l2: 'js' })).steps, 3);
    assert.throws(() => checkReplay(replay({ p1: 'tinybot-v1', l1: 'wasm' })), /at least one seat is a person/);
    assert.throws(() => checkReplay(replay({ p2: 'rush', l2: 'js' })), /p2 is a player id .* or an arena bot/);
    assert.throws(() => checkReplay(replay({ p1: '@pal' })), /p1 is a player id/);
    assert.throws(() => checkReplay(replay({ steps: 0 })), /a header, steps and an end line/);
    assert.throws(() => checkReplay(replay().replace('"seed":11', '"seed":-1')), /seed/);
    assert.throws(() => checkReplay(replay().replace('Vader Aggro"}', '<b>"}')), /deck lists/);
    assert.strictEqual(isoWeek('2026-10-16T12:00:00Z'), '2026-W42');
    assert.strictEqual(isoWeek('2027-01-01T00:00:00Z'), '2026-W53');
});
