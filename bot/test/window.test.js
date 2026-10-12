'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'window-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// a scratch arena for anything that loads home.js (server.js, which window.js uses, loads api.js): never the project's
Object.assign(process.env, { ARENA_HOME: path.join(tmp, 'arena-home'), ARENA_RESULTS: path.join(tmp, 'arena-results'), ARENA_DASH: path.join(tmp, 'no-dash') });

const { createWindow, Store, storeReader, scrub } = require('../arena/window');
const { createAuth } = require('../arena/auth');

const ENV = { ARENA_PUSH_TOKEN: 'push-secret', ARENA_ADMIN_TOKEN: 'admin-secret', ARENA_FEED_TOKEN_KARABAST: 'feed-secret', ARENA_ADMINS: 'ericfode', ARENA_INVITES: 'pal', GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', ARENA_PUBLIC_URL: 'https://swu-arena.fly.dev' };

async function serve(w) {
    const srv = http.createServer((req, res) => w.handle(req, res)).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const base = () => `http://127.0.0.1:${srv.address().port}`;
    const go = (p, { method = 'GET', token, cookie, body, type = 'application/json', origin } = {}) => fetch(base() + p, {
        method, redirect: 'manual', body,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': type } : {}), ...(origin ? { origin } : {}) }
    });
    return { srv, go, close: () => new Promise((r) => srv.close(r)) };
}

function makeWindow(name, { fetchImpl } = {}) {
    const home = path.join(tmp, name);
    const store = new Store(home);
    const auth = createAuth({ dir: path.join(home, 'auth'), env: ENV, fetch: fetchImpl, invites: () => JSON.parse(store.getDoc('admin', 'invites') ?? '{"logins":[]}').logins });
    const app = path.join(tmp, `${name}-app.html`);
    fs.writeFileSync(app, '<!doctype html><title>app</title>');
    return createWindow({ home, auth, app, minMs: 0 });
}

test('store: a replay grows only at its current size, and reads back whole across gzip members', () => {
    const s = new Store(path.join(tmp, 'store'));
    assert.deepStrictEqual(s.appendReplay('run-1', 'g1', 0, Buffer.from('{"t":"header"}\n')), { size: 15 });
    assert.throws(() => s.appendReplay('run-1', 'g1', 0, Buffer.from('again\n')), (e) => e.code === 'conflict' && e.size === 15);
    s.appendReplay('run-1', 'g1', 15, Buffer.from('{"t":"step"}\n'));
    assert.strictEqual(s.readReplay('run-1', 'g1').toString(), '{"t":"header"}\n{"t":"step"}\n');
    const fresh = new Store(s.dir); // sizes come back from disk after a restart
    assert.strictEqual(fresh.replaySize('run-1', 'g1'), 28);
    assert.deepStrictEqual(fresh.listReplays('run-1'), ['g1']);
    // appends cannot grow a replay past the size a whole PUT may have (32 MB)
    s.sizes.set('run-1/long', 32e6 - 5);
    assert.throws(() => s.appendReplay('run-1', 'long', 32e6 - 5, Buffer.from('0123456789')), (e) => e.code === 'too_large');
    assert.throws(() => s.putDoc('nope', 'x', '{}'), (e) => e.code === 'not_found');
    assert.throws(() => s.putDoc('runs', '../x', '{}'), (e) => e.code === 'bad_request');
});

test('the loaders\' reader finds each collection where the project folder had it', async () => {
    const s = new Store(path.join(tmp, 'reader'));
    s.putDoc('runs', 'arena-t1-r1', JSON.stringify({ id: 'arena-t1-r1', games: [] }));
    s.putDoc('ladders', 'arena-t1-r1', JSON.stringify({ status: 'done' }));
    s.putDoc('panels', 'p1', JSON.stringify({ id: 'p1' }));
    s.putDoc('meta', 'ratings', JSON.stringify({ bots: {} }));
    s.putDoc('arena', 'report-2', JSON.stringify({ round: 2, markdown: '# Round 2' }));
    s.putDoc('arena', 'versions-duel_opus', JSON.stringify([{ v: 0, note: 'start' }, { v: 1, note: 'faster' }]));
    s.appendReplay('arena-t1-r1', 'g7', 0, Buffer.from('{"t":"end"}\n'));
    const r = storeReader(s);
    assert.deepStrictEqual((await r.list('results')).map((e) => [e.name, e.isDirectory]), [['arena-t1-r1', true]]);
    assert.strictEqual(JSON.parse(await r.text('results/arena-t1-r1/index.json')).id, 'arena-t1-r1');
    assert.strictEqual(JSON.parse(await r.text('results/arena-t1-r1/ladder.json')).status, 'done');
    assert.deepStrictEqual((await r.list('results/arena-t1-r1/games')).map((e) => e.name), ['g7.jsonl']);
    assert.strictEqual(await r.text('results/arena-t1-r1/games/g7.jsonl'), '{"t":"end"}\n');
    assert.deepStrictEqual((await r.list('dashboard/panels')).map((e) => e.name), ['p1.json']);
    assert.ok(await r.text('meta/ratings.json'));
    assert.deepStrictEqual((await r.list('arena/rounds')).map((e) => e.name), ['r2.md']);
    assert.strictEqual(await r.text('arena/rounds/r2.md'), '# Round 2');
    assert.deepStrictEqual((await r.list('arena/versions')).map((e) => e.name), ['duel_opus-v0', 'duel_opus-v1']);
    assert.strictEqual(JSON.parse(await r.text('arena/versions/duel_opus-v1/SUBMISSION.json')).note, 'faster');
    assert.strictEqual(await r.text('arena/nothing.json'), null);
});

test('scrub drops builder and thread names at any depth', () => {
    assert.deepStrictEqual(scrub({ a: 1, owner: 'x', list: [{ thread: 't', name: 'n' }], deep: { tokenHash: 'h', ok: true } }), { a: 1, list: [{ name: 'n' }], deep: { ok: true } });
});

test('auth: bearer tokens give roles, a wrong one is refused, and a session cookie cannot be forged or kept past expiry', () => {
    let now = Date.now();
    const auth = createAuth({ dir: path.join(tmp, 'auth1'), env: ENV, now: () => now });
    const req = (h) => ({ headers: h });
    assert.deepStrictEqual(auth.who(req({ authorization: 'Bearer push-secret' })), { role: 'project', via: 'bearer' });
    assert.deepStrictEqual(auth.who(req({ authorization: 'Bearer admin-secret' })), { role: 'admin', via: 'bearer' });
    assert.deepStrictEqual(auth.who(req({ authorization: 'Bearer guess' })), { role: 'bad', via: 'bearer' });
    assert.deepStrictEqual(auth.who(req({ authorization: 'Bearer feed-secret' })), { role: 'feed', feed: 'karabast', via: 'bearer' });
    const two = createAuth({ dir: path.join(tmp, 'auth1b'), env: { ARENA_FEED_TOKEN_FOO: 'foo-secret', ARENA_FEED_TOKEN_FOO_BAR: 'foo-bar-secret' } });
    assert.deepStrictEqual(two.who(req({ authorization: 'Bearer foo-secret' })), { role: 'feed', feed: 'foo', via: 'bearer' });
    assert.deepStrictEqual(two.who(req({ authorization: 'Bearer foo-bar-secret' })), { role: 'bad', via: 'bearer' }, 'a feed name is letters and digits, so FOO_BAR never owns foo-<id> names');
    assert.deepStrictEqual(auth.who(req({})), { role: 'anon', via: 'cookie' });
    const pal = auth.sign({ l: 'pal', exp: now + 60000 });
    assert.deepStrictEqual(auth.who(req({ cookie: `swu_session=${pal}` })), { role: 'friend', login: 'pal', via: 'cookie' });
    assert.strictEqual(auth.who(req({ cookie: `swu_session=${auth.sign({ l: 'EricFode', exp: now + 60000 })}` })).role, 'admin');
    assert.strictEqual(auth.who(req({ cookie: `swu_session=${auth.sign({ l: 'stranger', exp: now + 60000 })}` })).role, 'anon');
    const [body, sig] = pal.split('.');
    const forged = Buffer.from(JSON.stringify({ l: 'ericfode', exp: now + 60000 })).toString('base64url');
    assert.strictEqual(auth.who(req({ cookie: `swu_session=${forged}.${sig}` })).role, 'anon');
    assert.strictEqual(auth.who(req({ cookie: `swu_session=${body}.${sig}` })).role, 'friend');
    now += 120000;
    assert.strictEqual(auth.who(req({ cookie: `swu_session=${pal}` })).role, 'anon', 'expired');
    // the key survives a restart: a new instance on the same folder accepts the old cookie
    const again = createAuth({ dir: path.join(tmp, 'auth1'), env: ENV, now: () => now - 120000 });
    assert.strictEqual(again.who(req({ cookie: `swu_session=${pal}` })).role, 'friend');
});

test('window: friends read, only the project token pushes, and friends never see builder names', async () => {
    const w = makeWindow('w1');
    const { go, close } = await serve(w);
    try {
        const friend = `swu_session=${w.auth.sign({ l: 'pal', exp: Date.now() + 60000 })}`;
        assert.strictEqual((await go('/healthz')).status, 200);
        const page = await go('/');
        assert.strictEqual(page.status, 200);
        assert.match(await page.text(), /Sign in with GitHub/);
        assert.strictEqual((await go('/api/status')).status, 401);
        assert.strictEqual((await go('/api/status', { token: 'nope' })).status, 401);

        const status = { round: 3, phase: 'work', competitors: [{ name: 'duel_opus', owner: 'some thread', harness: { kind: 'claude-code' } }] };
        assert.strictEqual((await go('/api/docs/arena/status', { method: 'PUT', token: 'push-secret', body: JSON.stringify(status) })).status, 200);
        assert.strictEqual((await go('/api/docs/arena/status', { method: 'PUT', cookie: friend, body: '{}' })).status, 403);
        // signing in only reads, even for an admin
        const eric = `swu_session=${w.auth.sign({ l: 'ericfode', exp: Date.now() + 60000 })}`;
        assert.strictEqual((await go('/api/docs/arena/status', { method: 'PUT', cookie: eric, body: '{}' })).status, 403);
        assert.strictEqual((await go('/api/replays/r/g?at=0', { method: 'POST', cookie: eric, body: '{}\n' })).status, 403);
        assert.strictEqual((await go('/api/docs/arena/status', { cookie: eric })).status, 200);
        assert.strictEqual((await go('/api/docs/arena/status', { method: 'PUT', token: 'push-secret', body: 'not json' })).status, 400);

        const seen = await (await go('/api/status', { cookie: friend })).json();
        assert.deepStrictEqual(seen.result.competitors, [{ name: 'duel_opus', harness: { kind: 'claude-code' } }]);
        const raw = await (await go('/api/status', { token: 'push-secret' })).json();
        assert.strictEqual(raw.result.competitors[0].owner, 'some thread');
        assert.strictEqual((await go('/api/docs/panels', { cookie: friend })).status, 403, 'panels reach friends through the app model only');
        assert.strictEqual((await go('/', { cookie: friend })).status, 200);
        assert.match(await (await go('/', { cookie: friend })).text(), /<title>app<\/title>/);
        assert.strictEqual((await go('/api/register', { method: 'POST', token: 'push-secret', body: '{}' })).status, 501);
        assert.strictEqual((await go('/api/wait', { cookie: friend })).status, 501);
    } finally {
        await close();
    }
});

test('window: replays grow by appends at the right offset, and readers can tail them', async () => {
    const w = makeWindow('w2');
    const { go, close } = await serve(w);
    try {
        const friend = `swu_session=${w.auth.sign({ l: 'pal', exp: Date.now() + 60000 })}`;
        const append = (at, text) => go(`/api/replays/arena-t1-r1/g%231?at=${at}`, { method: 'POST', token: 'push-secret', body: text, type: 'application/x-ndjson' });
        assert.strictEqual((await append(0, '{"t":"header"}\n')).status, 200);
        const stale = await append(0, '{"t":"header"}\n');
        assert.strictEqual(stale.status, 409);
        assert.strictEqual((await stale.json()).error.size, 15);
        assert.strictEqual((await append(15, '{"t":"step"}\n')).status, 200);
        const all = await go('/api/replays/arena-t1-r1/g%231', { cookie: friend });
        assert.strictEqual(all.headers.get('x-size'), '28');
        assert.strictEqual(await all.text(), '{"t":"header"}\n{"t":"step"}\n');
        const tail = await go('/api/replays/arena-t1-r1/g%231?from=15', { cookie: friend });
        assert.strictEqual(await tail.text(), '{"t":"step"}\n');
        assert.deepStrictEqual((await (await go('/api/replays/arena-t1-r1', { cookie: friend })).json()).result, ['g#1']);
        // the arena page's own replay links
        assert.strictEqual(await (await go('/replays/arena-t1-r1/games/g%231.jsonl', { cookie: friend })).text(), '{"t":"header"}\n{"t":"step"}\n');
        // a whole game replaces what was there
        assert.strictEqual((await go('/api/replays/arena-t1-r1/g%231', { method: 'PUT', token: 'push-secret', body: '{"t":"end"}\n', type: 'application/x-ndjson' })).status, 200);
        assert.strictEqual(await (await go('/api/replays/arena-t1-r1/g%231', { cookie: friend })).text(), '{"t":"end"}\n');
    } finally {
        await close();
    }
});

test('window: the arena\'s read methods answer from what the arena pushed, in the arena\'s shapes', async () => {
    const w = makeWindow('w3');
    const { go, close } = await serve(w);
    try {
        const put = (ns, id, doc) => go(`/api/docs/${ns}/${id}`, { method: 'PUT', token: 'push-secret', body: JSON.stringify(doc) });
        await put('arena', 'report-1', { round: 1, markdown: '# one' });
        await put('arena', 'report-2', { round: 2, markdown: '# two' });
        await put('arena', 'standings', { rounds: [{ round: 2, ladderId: 'arena-t9-r2' }], global: {} });
        await put('runs', 'arena-t9-r2', { id: 'arena-t9-r2', games: [{ id: 'g1' }] });
        const get = async (p) => (await (await go(p, { token: 'push-secret' })).json()).result;
        assert.strictEqual((await get('/api/report')).markdown, '# two');
        assert.strictEqual((await get('/api/report?round=1')).markdown, '# one');
        assert.deepStrictEqual(await get('/api/games'), { round: 2, ladderId: 'arena-t9-r2', replayBase: 'replays/arena-t9-r2/games/', games: [{ id: 'g1' }] });
        assert.strictEqual((await go('/api/versions?name=nobody', { token: 'push-secret' })).status, 404);
    } finally {
        await close();
    }
});

test('sign-in: GitHub confirms the login, invited people get a session, others see who to ask', async () => {
    const fakeGithub = (login) => async (url) => ({ json: async () => (url.includes('access_token') ? { access_token: 'gh-token' } : { login, id: 7 }) });
    for (const [login, invited] of [['pal', true], ['stranger', false]]) {
        const w = makeWindow(`w-${login}`, { fetchImpl: fakeGithub(login) });
        const { go, close } = await serve(w);
        try {
            const start = await go('/auth/github?next=%2F%23%2Farena');
            assert.strictEqual(start.status, 302);
            const to = new URL(start.headers.get('location'));
            assert.strictEqual(to.host, 'github.com');
            assert.strictEqual(to.searchParams.get('redirect_uri'), 'https://swu-arena.fly.dev/auth/github/callback');
            const oauth = start.headers.get('set-cookie').split(';')[0];
            assert.strictEqual((await go(`/auth/github/callback?code=c&state=wrong`, { cookie: oauth })).status, 400);
            const back = await go(`/auth/github/callback?code=c&state=${to.searchParams.get('state')}`, { cookie: oauth });
            assert.strictEqual(back.status, 302);
            assert.strictEqual(back.headers.get('location'), invited ? '/#/arena' : '/');
            const session = back.headers.getSetCookie().find((c) => c.startsWith('swu_session=')).split(';')[0];
            const home = await go('/', { cookie: session });
            assert.strictEqual(home.status, invited ? 200 : 403);
            assert.match(await home.text(), invited ? /<title>app/ : /not on the invite list/);
        } finally {
            await close();
        }
    }
});

test('share: an admin invites and removes people from the Share page, and no one else can', async () => {
    const w = makeWindow('w-share');
    const { go, close } = await serve(w);
    try {
        const eric = `swu_session=${w.auth.sign({ l: 'ericfode', exp: Date.now() + 60000 })}`;
        const pal = `swu_session=${w.auth.sign({ l: 'pal', exp: Date.now() + 60000 })}`;
        const kim = `swu_session=${w.auth.sign({ l: 'kim-b', exp: Date.now() + 60000 })}`;
        const site = 'https://swu-arena.fly.dev';
        const post = (body, opts = {}) => go('/api/share', { method: 'POST', cookie: eric, origin: site, body: JSON.stringify(body), ...opts });
        assert.deepStrictEqual((await (await go('/api/share', { cookie: eric })).json()).result, { invites: [], admins: ['ericfode'], fromEnv: ['pal'] });
        assert.strictEqual((await go('/api/share', { cookie: pal })).status, 403, 'a friend cannot see the list');
        assert.strictEqual((await go('/api/share', { cookie: kim })).status, 401);
        assert.strictEqual((await go('/', { cookie: kim })).status, 403);

        // a page elsewhere: no Origin, another origin, or a plain form never changes the list
        assert.strictEqual((await post({ add: 'kim-b' }, { origin: null })).status, 403);
        assert.strictEqual((await post({ add: 'kim-b' }, { origin: 'https://evil.fly.dev' })).status, 403);
        assert.strictEqual((await post({ add: 'kim-b' }, { type: 'text/plain' })).status, 400);
        assert.strictEqual((await go('/api/share', { method: 'POST', cookie: eric, origin: site, type: 'application/x-www-form-urlencoded', body: 'add=kim-b' })).status, 400);
        assert.strictEqual((await post({ add: 'kim-b' }, { cookie: pal })).status, 403, 'a friend cannot invite');
        assert.strictEqual((await go('/', { cookie: kim })).status, 403, 'still not invited');

        for (const bad of [{}, { add: '' }, { add: 'no spaces' }, { add: '-dash' }, { add: 'a'.repeat(40) }, { add: 'x', remove: 'y' }, { add: 7 }]) {
            assert.strictEqual((await post(bad)).status, 400, JSON.stringify(bad));
        }
        assert.deepStrictEqual((await (await post({ add: '@Kim-B ' })).json()).result.invites, ['kim-b']);
        assert.deepStrictEqual((await (await post({ add: 'kim-b' })).json()).result.invites, ['kim-b'], 'no duplicates');
        assert.strictEqual((await go('/', { cookie: kim })).status, 200, 'invited at once');
        assert.strictEqual((await go('/api/share', { cookie: kim })).status, 403);
        assert.deepStrictEqual((await (await post({ remove: 'kim-b' })).json()).result.invites, []);
        assert.strictEqual((await go('/', { cookie: kim })).status, 403, 'removed at once');
        // the admin token works from a program, with no Origin
        assert.strictEqual((await go('/api/share', { method: 'POST', token: 'admin-secret', body: '{"add":"kim-b"}' })).status, 200);
        assert.strictEqual((await go('/api/share', { method: 'POST', token: 'push-secret', body: '{"add":"x"}' })).status, 403, 'the project token cannot');
        assert.deepStrictEqual(JSON.parse(w.store.getDoc('admin', 'invites')).logins, ['kim-b']);
    } finally {
        await close();
    }
});

test('sign-in page: a shared link keeps its #/page through sign-in', async () => {
    const w = makeWindow('w-hash');
    const { go, close } = await serve(w);
    try {
        const html = await (await go('/')).text();
        assert.match(html, /location\.hash/);
        assert.match(html, /searchParams\.set\('next'/);
    } finally {
        await close();
    }
});

test('a feed token writes only what carries its name, and reads like a friend', async () => {
    const w = makeWindow('w-feed');
    const { go, close } = await serve(w);
    try {
        const doc = (ns, id, method = 'PUT', body = JSON.stringify({ id, createdAt: '2026-10-11T21:00:00Z', games: [] })) => go(`/api/docs/${ns}/${id}`, { method, token: 'feed-secret', body });
        assert.strictEqual((await doc('runs', 'karabast')).status, 200);
        assert.strictEqual((await doc('runs', 'karabast', 'PUT', '{"id":"arena-t1-r1","createdAt":"2026-10-11T21:00:00Z","games":[]}')).status, 400, 'the run inside must carry the same name');
        assert.strictEqual((await doc('runs', 'karabast', 'PUT', '{"games":[]}')).status, 400);
        assert.strictEqual((await doc('runs', 'karabast', 'PUT', '{"id":"karabast","createdAt":"2026-10-11T21:00:00Z","games":[null]}')).status, 400, 'games the loaders cannot read');
        assert.strictEqual((await doc('runs', 'karabast', 'PUT', '{"id":"karabast","createdAt":"2026-10-11T21:00:00Z","games":[{"id":"karabast-1","p1":"c-clock","outcome":"running"}]}')).status, 400);
        assert.strictEqual((await doc('runs', 'karabast', 'PUT', '{"id":"karabast","createdAt":"2026-10-11T21:00:00Z","bots":[1],"games":[]}')).status, 400);
        for (const bad of ['__proto__', 'constructor', 'toString']) {
            assert.strictEqual((await doc('runs', 'karabast', 'PUT', JSON.stringify({ id: 'karabast', createdAt: '2026-10-11T21:00:00Z', games: [{ id: 'karabast-1', p1: bad, p2: 'opponent', outcome: 'running' }] }))).status, 400, `${bad} as a seat`);
        }
        assert.strictEqual((await doc('runs', 'karabast', 'PUT', JSON.stringify({ id: 'karabast', createdAt: '2026-10-11T21:00:00Z', games: [{ id: 'g1', p1: 'c-clock', p2: 'opponent', outcome: 'running' }] }))).status, 400, 'game ids carry the feed name');
        const row = { id: 'karabast-1', p1: 'c-clock', p2: 'opponent', outcome: 'running' };
        for (const [bad, why] of [[{ outcome: 'ERROR', error: { toString: null } }, 'an error that is not text'], [{ outcome: 'ERROR', by: 'p1' }, 'an outcome feeds do not send'], [{ outcome: 'won', winnerSeat: 'p3' }, 'a seat that does not exist'], [{ outcome: 'won' }, 'a won game with no winner'], [{ outcome: undefined }, 'no outcome']]) {
            assert.strictEqual((await doc('runs', 'karabast', 'PUT', JSON.stringify({ id: 'karabast', createdAt: '2026-10-11T21:00:00Z', games: [{ ...row, ...bad }] }))).status, 400, why);
        }
        assert.strictEqual((await doc('runs', 'karabast', 'PUT', JSON.stringify({ id: 'karabast', createdAt: 12, games: [] }))).status, 400, 'createdAt is a date string');
        assert.strictEqual((await doc('runs', 'karabast', 'PUT', JSON.stringify({ id: 'karabast', games: [] }))).status, 400, 'and is required, since runs are ordered by it');
        assert.strictEqual((await doc('runs', 'karabast', 'PUT', JSON.stringify({ id: 'karabast', createdAt: '2026-10-11T21:00:00Z', games: [row, row] }))).status, 400, 'game ids are distinct');
        // the shape bot/karabast/feed.js sends; the window keeps only the fields the app reads
        const sent = { id: 'karabast', createdAt: '2026-10-11T21:00:00Z', engine: null, bots: ['c-clock'], gamesPerPairing: 1, games: [
            { ...row, seed: 0, winner: null, winnerSeat: null, rounds: 2, steps: 40, error: null, ms: 0, timing: { p1: { n: 1, ms: 5 } } },
            { id: 'karabast-2', seed: 0, p1: 'opponent', p2: 'c-clock', winner: 'c-clock', winnerSeat: 'p2', rounds: 7, steps: 300, outcome: 'won', error: null, ms: 0 },
            { id: 'karabast-3', seed: 0, p1: 'c-clock', p2: 'opponent', winner: null, winnerSeat: 'draw', rounds: 0, steps: 1, outcome: 'abandoned', error: 'no result', ms: 0 },
            { id: 'karabast-4', p1: 'c-clock', p2: 'opponent', winnerSeat: null, rounds: 9, steps: 500, outcome: 'draw' },
        ] };
        assert.strictEqual((await doc('runs', 'karabast', 'PUT', JSON.stringify(sent))).status, 200);
        assert.deepStrictEqual((await (await go('/api/docs/runs/karabast', { token: 'feed-secret' })).json()).result, { id: 'karabast', feed: 'karabast', createdAt: '2026-10-11T21:00:00Z', bots: ['c-clock'], gamesPerPairing: 1, games: [
            { id: 'karabast-1', p1: 'c-clock', p2: 'opponent', outcome: 'running', winnerSeat: null, winner: null, rounds: 2, steps: 40, error: null },
            { id: 'karabast-2', p1: 'opponent', p2: 'c-clock', outcome: 'won', winnerSeat: 'p2', winner: 'c-clock', rounds: 7, steps: 300, error: null },
            { id: 'karabast-3', p1: 'c-clock', p2: 'opponent', outcome: 'abandoned', winnerSeat: null, winner: null, rounds: 0, steps: 1, error: 'no result' },
            { id: 'karabast-4', p1: 'c-clock', p2: 'opponent', outcome: 'draw', winnerSeat: 'draw', winner: 'draw', rounds: 9, steps: 500, error: null },
        ] }, 'rebuilt from the fields the app reads; timing, seed and the rest are dropped');
        assert.strictEqual((await doc('lens', 'karabast-g1')).status, 200);
        assert.strictEqual((await doc('runs', 'karabastx')).status, 403, 'a name that only starts the same is not its own');
        assert.strictEqual((await doc('runs', 'arena-t1-r1')).status, 403);
        assert.strictEqual((await doc('panels', 'karabast')).status, 403, 'only runs, lens and replays');
        assert.strictEqual((await doc('admin', 'karabast')).status, 403);
        const append = (run) => go(`/api/replays/${run}/g1?at=0`, { method: 'POST', token: 'feed-secret', body: '{"t":"header"}\n', type: 'application/x-ndjson' });
        assert.strictEqual((await append('karabast')).status, 200);
        assert.strictEqual((await append('arena-t1-r1')).status, 403);
        assert.deepStrictEqual((await (await go('/api/replays/karabast?sizes=1', { token: 'feed-secret' })).json()).result, [{ id: 'g1', size: 15 }]);
        assert.strictEqual((await go('/api/docs/panels', { token: 'feed-secret' })).status, 403, 'reads like a friend');
    } finally {
        await close();
    }
});

test('the invite list can change without a deploy', async () => {
    const w = makeWindow('w4');
    const { go, close } = await serve(w);
    try {
        const newcomer = `swu_session=${w.auth.sign({ l: 'newcomer', exp: Date.now() + 60000 })}`;
        assert.strictEqual((await go('/api/status', { cookie: newcomer })).status, 401);
        // the proxy adds the project token to every process in the project, so it cannot change who may sign in
        const invite = (token) => go('/api/docs/admin/invites', { method: 'PUT', token, body: JSON.stringify({ logins: ['Newcomer'] }) });
        assert.strictEqual((await invite('push-secret')).status, 403);
        assert.strictEqual((await go('/api/docs/admin/invites', { token: 'push-secret' })).status, 403);
        assert.strictEqual((await go('/api/docs/admin/invites', { method: 'DELETE', token: 'push-secret' })).status, 403);
        assert.strictEqual((await go('/api/status', { cookie: newcomer })).status, 401);
        assert.strictEqual((await invite('admin-secret')).status, 200);
        assert.strictEqual((await go('/api/status', { cookie: newcomer })).status, 200);
    } finally {
        await close();
    }
});

test('the app data is built from the collections with the app\'s own loaders', { skip: !fs.existsSync('/mnt/project-files/dashboard/site/core.cjs') && !fs.existsSync(path.join(__dirname, '..', '..', 'dashboard', 'site', 'core.cjs')) }, async () => {
    if (!fs.existsSync(path.join(__dirname, '..', '..', 'dashboard', 'site', 'core.cjs'))) {
        process.env.APP_CORE = '/mnt/project-files/dashboard/site/core.cjs';
    }
    const w = makeWindow('w5');
    const { go, close } = await serve(w);
    try {
        const game = (id, p1, p2, winner) => ({ id, p1, p2, seed: 1, outcome: 'won', winner, winnerSeat: winner === p1 ? 'p1' : 'p2', rounds: 6 });
        const idx = { id: 'test-ladder', createdAt: '2026-10-11T20:00:00Z', bots: ['rush', 'heuristic'], gamesPerPairing: 2, games: [game('g1', 'rush', 'heuristic', 'heuristic'), game('g2', 'heuristic', 'rush', 'heuristic')] };
        await go('/api/docs/runs/test-ladder', { method: 'PUT', token: 'push-secret', body: JSON.stringify(idx) });
        await go('/api/docs/panels/line-1', { method: 'PUT', token: 'push-secret', body: JSON.stringify({ id: 'line-1', title: 'A line', thread: 'secret thread name', updatedAt: '2026-10-11T20:00:00Z' }) });
        const res = await go('/api/app', { token: 'push-secret' });
        assert.strictEqual(res.status, 200);
        const d = (await res.json()).result;
        assert.strictEqual(d.audience, 'public');
        assert.ok(d.model.runs.some((r) => r.id === 'test-ladder'));
        assert.strictEqual(d.model.games.length, 2);
        assert.ok(!JSON.stringify(d).includes('secret thread name'), 'friends never get thread names');
    } finally {
        await close();
    }
});

test('push: a ladder run reaches the window as it plays: whole lines while running, the whole file once finished', async () => {
    const w = makeWindow('w6');
    const { srv, go, close } = await serve(w);
    try {
        process.env.SWU_WINDOW = `http://127.0.0.1:${srv.address().port}`;
        process.env.SWU_WINDOW_TOKEN = 'push-secret';
        delete require.cache[require.resolve('../arena/push')];
        const { pushRunOnce } = require('../arena/push');
        const dir = path.join(tmp, 'runs', 'live-ladder');
        fs.mkdirSync(path.join(dir, 'games'), { recursive: true });
        const index = (outcome) => fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ id: 'live-ladder', games: [{ id: 'g1', outcome }] }));
        const file = path.join(dir, 'games', 'g1.jsonl');
        const replay = async () => (await go('/api/replays/live-ladder/g1', { token: 'push-secret' })).text();
        index('running');
        fs.writeFileSync(file, '{"t":"header"}\n{"t":"st');
        const mem = { docs: new Map(), replays: new Map() };
        assert.strictEqual((await pushRunOnce(dir, mem)).going, true);
        assert.strictEqual(await replay(), '{"t":"header"}\n', 'only whole lines');
        assert.strictEqual(JSON.parse(w.store.getDoc('runs', 'live-ladder')).games[0].outcome, 'running');
        fs.appendFileSync(file, 'ep"}\n');
        await pushRunOnce(dir, { docs: new Map(), replays: new Map() }); // a restarted pusher sends only what the window lacks
        assert.strictEqual(await replay(), '{"t":"header"}\n{"t":"step"}\n');
        fs.appendFileSync(file, '{"t":"end"}\n');
        index('won');
        assert.strictEqual((await pushRunOnce(dir, mem)).going, false);
        assert.strictEqual(await replay(), '{"t":"header"}\n{"t":"step"}\n{"t":"end"}\n');
        fs.writeFileSync(file, '{"t":"header","key":"k"}\n{"t":"step"}\n{"t":"end"}\n'); // ladder.js adds the key in place
        await pushRunOnce(dir, mem);
        assert.match(await replay(), /"key":"k"/);
    } finally {
        delete process.env.SWU_WINDOW;
        delete process.env.SWU_WINDOW_TOKEN;
        await close();
    }
});

test('push: the arena uplink sends the roster without token hashes, the bench included', async () => {
    const home = process.env.ARENA_HOME;
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'roster.json'), JSON.stringify({ thinkCapMs: 60000, baselines: ['rush'],
        agents: [{ name: 'aa', title: 'aa', philosophy: '', start: 'rush', tokenHash: 'h1' }], bench: [{ name: 'bb', title: 'bb', tokenHash: 'h2' }] }));
    const w = makeWindow('w7');
    const { srv, close } = await serve(w);
    try {
        process.env.SWU_WINDOW = `http://127.0.0.1:${srv.address().port}`;
        process.env.SWU_WINDOW_TOKEN = 'push-secret';
        delete require.cache[require.resolve('../arena/push')];
        await require('../arena/push').pushArena({ once: true });
        const roster = JSON.parse(w.store.getDoc('arena', 'roster'));
        assert.deepStrictEqual([roster.agents[0].name, roster.bench[0].name], ['aa', 'bb']);
        assert.doesNotMatch(JSON.stringify(roster), /tokenHash/);
    } finally {
        delete process.env.SWU_WINDOW;
        delete process.env.SWU_WINDOW_TOKEN;
        await close();
    }
});

/** Runs bot/arena/mcp.js with these arguments and answers each JSON-RPC request in turn. */
async function mcpSession(args, env = {}) {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'arena', 'mcp.js'), ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const waiting = new Map();
    let buf = '';
    child.stdout.on('data', (d) => {
        buf += d;
        for (let i; (i = buf.indexOf('\n')) >= 0;) {
            const msg = JSON.parse(buf.slice(0, i));
            buf = buf.slice(i + 1);
            waiting.get(msg.id)?.(msg);
        }
    });
    let n = 0;
    const ask = (method, params = {}) => new Promise((resolve) => {
        const id = ++n;
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const tool = async (name, a = {}) => {
        const r = (await ask('tools/call', { name, arguments: a })).result;
        return { error: r.isError, value: JSON.parse(r.content[0].text) };
    };
    return { ask, tool, close: () => child.kill() };
}

test('mcp: pointed at the window, it reads with GET and uploads a run and documents with the push token', async () => {
    const w = makeWindow('w8');
    const { srv, close } = await serve(w);
    const base = `http://127.0.0.1:${srv.address().port}`;
    const dir = path.join(tmp, 'mcp-runs', 'mcp-ladder');
    fs.mkdirSync(path.join(dir, 'games'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ id: 'mcp-ladder', games: [{ id: 'g1', outcome: 'won' }, { id: 'g2', outcome: 'won' }] }));
    fs.writeFileSync(path.join(dir, 'games', 'g1.jsonl'), '{"t":"header"}\n{"t":"end"}\n');
    fs.writeFileSync(path.join(dir, 'games', 'g2.jsonl'), '{"t":"header"}\n');
    const docFile = path.join(tmp, 'mcp-doc.json');
    fs.writeFileSync(docFile, JSON.stringify({ id: 'arena-x', title: 'x' }));
    w.store.putDoc('arena', 'status', JSON.stringify({ tournament: null, round: 3, phase: 'work', competitors: [] }));
    const project = await mcpSession(['--remote', base, '--token', 'push-secret']);
    const friendless = await mcpSession(['--remote', base]);
    const competitor = await mcpSession(['--remote', base, '--token', 'push-secret'], { ARENA_COMPETITOR: 'aa' });
    try {
        await project.ask('initialize');
        const names = (await project.ask('tools/list')).result.tools.map((t) => t.name);
        assert.ok(names.includes('arena_status') && !names.includes('arena_submit'), 'only the arena reads the window answers');
        assert.ok(['window_docs', 'window_replays', 'window_put_doc', 'window_put_dir', 'window_put_run'].every((x) => names.includes(x)));
        assert.deepStrictEqual(await project.tool('arena_status'), { error: false, value: { tournament: null, round: 3, phase: 'work', competitors: [] } });

        const r = await project.tool('window_put_run', { path: dir });
        assert.deepStrictEqual(r.value, { run: 'mcp-ladder', replays: 2, onWindow: 2, missing: [], stillPlaying: false });
        assert.strictEqual(w.store.readReplay('mcp-ladder', 'g1').toString(), '{"t":"header"}\n{"t":"end"}\n');
        assert.strictEqual(JSON.parse(w.store.getDoc('runs', 'mcp-ladder')).games.length, 2);
        assert.strictEqual((await project.tool('window_put_doc', { collection: 'panels', id: 'arena-x', path: docFile })).value.uploaded, 'panels/arena-x');
        assert.strictEqual((await project.tool('window_docs', { collection: 'panels', id: 'arena-x' })).value.title, 'x');
        assert.strictEqual((await project.tool('window_put_doc', { collection: 'panels', id: 'y', path: '/etc/hostname' })).error, true, 'only .json files');
        assert.strictEqual((await project.tool('window_put_doc', { collection: 'admin', id: 'invites', doc: { logins: ['z'] } })).error, true, 'the invite list needs the admin token');

        // no token: still the window's tools (it answers /healthz), and every call is refused by the window itself
        const plain = (await friendless.ask('tools/list')).result.tools.map((t) => t.name);
        assert.ok(plain.includes('window_put_run') && plain.includes('arena_status') && !plain.includes('arena_register'));
        assert.strictEqual((await friendless.tool('arena_status')).error, true);
        // a competitor's server reads, and never changes the window
        const mine = (await competitor.ask('tools/list')).result.tools.map((t) => t.name);
        assert.ok(mine.includes('arena_status') && !mine.some((x) => x.startsWith('window_')));
        assert.strictEqual((await competitor.tool('window_put_doc', { collection: 'panels', id: 'p', doc: {} })).error, true);
    } finally {
        project.close();
        friendless.close();
        competitor.close();
        await close();
    }
});
