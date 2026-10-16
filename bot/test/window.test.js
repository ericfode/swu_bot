'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'window-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// a scratch arena for anything that loads home.js (window.js loads api.js): never the project's
Object.assign(process.env, { ARENA_HOME: path.join(tmp, 'arena-home'), ARENA_RESULTS: path.join(tmp, 'arena-results'), ARENA_DASH: path.join(tmp, 'no-dash') });

const { createWindow, wakeGamesAt, Store, storeReader, scrub } = require('../arena/window');
const { createAuth } = require('../arena/auth');

const ENV = { ARENA_PUSH_TOKEN: 'push-secret', ARENA_GAMES_TOKEN: 'games-secret', ARENA_ADMIN_TOKEN: 'admin-secret', ARENA_FEED_TOKEN_KARABAST: 'feed-secret', ARENA_ADMINS: 'ericfode', ARENA_INVITES: 'pal', GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', ARENA_PUBLIC_URL: 'https://swu-arena.fly.dev' };

async function serve(w) {
    const srv = http.createServer((req, res) => w.handle(req, res)).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const base = () => `http://127.0.0.1:${srv.address().port}`;
    const go = (p, { method = 'GET', token, cookie, body, type = 'application/json', origin, headers = {} } = {}) => fetch(base() + p, {
        method, redirect: 'manual', body,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': type } : {}), ...(origin ? { origin } : {}), ...headers }
    });
    return { srv, go, close: () => new Promise((r) => srv.close(r)) };
}

function makeWindow(name, { fetchImpl, wakeGames, staleMs, env = ENV, githubHas } = {}) {
    const home = path.join(tmp, name);
    const store = new Store(home);
    const auth = createAuth({ dir: path.join(home, 'auth'), env, fetch: fetchImpl, invites: () => JSON.parse(store.getDoc('admin', 'invites') ?? '{"logins":[]}').logins,
        blocked: () => JSON.parse(store.getDoc('admin', 'blocked') ?? '{"logins":[]}').logins, links: () => JSON.parse(store.getDoc('admin', 'links') ?? '{"links":[]}').links });
    const app = path.join(tmp, `${name}-app.html`);
    fs.writeFileSync(app, '<!doctype html><title>app</title>');
    return createWindow({ home, auth, app, minMs: 0, wakeGames, staleMs, githubHas });
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
    s.putDoc('arena', 'status', JSON.stringify({ tournament: null, round: 2, phase: 'ladder' }));
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
    assert.strictEqual(JSON.parse(await r.text('arena/status.json')).phase, 'ladder', 'the app reads the hosted arena\'s clock');
    assert.deepStrictEqual((await r.list('arena/rounds')).map((e) => e.name), ['r2.md']);
    assert.strictEqual(await r.text('arena/rounds/r2.md'), '# Round 2');
    assert.deepStrictEqual((await r.list('arena/versions')).map((e) => e.name), ['duel_opus-v0', 'duel_opus-v1']);
    assert.strictEqual(JSON.parse(await r.text('arena/versions/duel_opus-v1/SUBMISSION.json')).note, 'faster');
    assert.strictEqual(await r.text('arena/nothing.json'), null);
});

test('a run that stopped sending shows its unfinished games as stopped, not playing, and comes back when it sends again', async () => {
    const s = new Store(path.join(tmp, 'stale'));
    const row = (id, outcome) => ({ id, p1: 'rush', p2: 'random', outcome, winner: null, winnerSeat: null });
    s.putDoc('runs', 'killed', JSON.stringify({ id: 'killed', games: [row('done', 'won'), row('plain', 'running'), row('taped', 'running'), row('fresh', 'running')] }));
    s.putDoc('ladders', 'killed', JSON.stringify({ status: 'running' }));
    s.appendReplay('killed', 'taped', 0, Buffer.from('{"t":"header"}\n'));
    s.appendReplay('killed', 'fresh', 0, Buffer.from('{"t":"header"}\n'));
    const hour = Date.now() / 1000 - 3600;
    for (const f of ['docs/runs/killed.json', 'docs/ladders/killed.json', 'replays/killed/taped.jsonl.gz']) {
        fs.utimesSync(path.join(s.dir, f), hour, hour);
    }
    const r = storeReader(s, { staleMs: 20 * 60000 });
    const games = JSON.parse(await r.text('results/killed/index.json')).games;
    // a game with a replay goes by its replay; one without, by the run's documents
    assert.deepStrictEqual(games.map((g) => g.outcome), ['won', 'abandoned', 'abandoned', 'running']);
    assert.match(games[1].error, /^stopped: its run sent nothing for 60 min$/);
    const fresh = s.changedAt('killed', 'fresh');
    assert.ok(Math.abs(r.staleAt() - (fresh + 20 * 60000)) < 5, 'the reader says when the game still running goes stale');
    assert.strictEqual(JSON.parse(s.getDoc('runs', 'killed')).games[1].outcome, 'running', 'the stored document is left as it came');
    s.putDoc('runs', 'killed', s.getDoc('runs', 'killed')); // the sender is back
    assert.strictEqual(JSON.parse(await storeReader(s).text('results/killed/index.json')).games[1].outcome, 'running');
    s.putDoc('runs', 'quiet', JSON.stringify({ id: 'quiet', games: [row('g', 'won')] }));
    assert.strictEqual(await storeReader(s).text('results/quiet/index.json'), s.getDoc('runs', 'quiet'), 'a run with nothing running reads as stored');
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
    const games = createAuth({ dir: path.join(tmp, 'auth1c'), env: { ARENA_PUSH_TOKEN: 'push-secret', ARENA_GAMES_TOKEN: 'games-secret' } });
    assert.deepStrictEqual(games.who(req({ authorization: 'Bearer games-secret' })), { role: 'project', games: true, via: 'bearer' }, "the games machine's own token");
    assert.deepStrictEqual(games.who(req({ authorization: 'Bearer push-secret' })), { role: 'project', via: 'bearer' });
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
        // replay links in the replays-server shape
        assert.strictEqual(await (await go('/replays/arena-t1-r1/games/g%231.jsonl', { cookie: friend })).text(), '{"t":"header"}\n{"t":"step"}\n');
        // the old arena page's address opens the app
        const old = await go('/arena', { cookie: friend });
        assert.strictEqual(old.status, 302);
        assert.strictEqual(old.headers.get('location'), '/');
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
            assert.match(await home.text(), invited ? /<title>app/ : /is not on the list yet.*Send Eric your GitHub username/s);
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
        assert.deepStrictEqual((await (await go('/api/share', { cookie: eric })).json()).result, { invites: [], admins: ['ericfode'], fromEnv: ['pal'], links: [], signin: 'invited', blocked: [],
            limits: { botsPerPerson: 2, perDay: 10, outsideBots: 20, tables: 'invited' } });
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
        // a login the server already lets in is refused, and one already in the document never shows as an invite
        assert.strictEqual((await post({ add: 'Pal' })).status, 409, 'set by ARENA_INVITES');
        assert.strictEqual((await post({ add: 'ericfode' })).status, 409, 'an admin');
        w.store.putDoc('admin', 'invites', JSON.stringify({ logins: ['kim-b', 'pal'] }));
        assert.deepStrictEqual((await (await go('/api/share', { cookie: eric })).json()).result.invites, ['kim-b']);
        w.store.putDoc('admin', 'invites', JSON.stringify({ logins: ['kim-b'] }));
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

test('arena settings: an admin sets them from the site or with the admin token, the games machine reads them', async () => {
    const w = makeWindow('w-settings');
    const { go, close } = await serve(w);
    try {
        const eric = `swu_session=${w.auth.sign({ l: 'ericfode', exp: Date.now() + 60000 })}`;
        const pal = `swu_session=${w.auth.sign({ l: 'pal', exp: Date.now() + 60000 })}`;
        const site = 'https://swu-arena.fly.dev';
        const post = (body, opts = {}) => go('/api/arena-settings', { method: 'POST', cookie: eric, origin: site, body: JSON.stringify(body), ...opts });
        const read = async (opts) => (await (await go('/api/arena-settings', opts)).json()).result;
        assert.deepStrictEqual(await read({ cookie: eric }), { settings: {}, updatedAt: null, by: null }, 'nothing set: the machine\'s defaults');
        assert.deepStrictEqual((await read({ token: 'games-secret' })).settings, {});

        const r = await (await post({ set: { workers: 3, gamesPerPair: 4, thinkCapSec: 90, roundGapMin: 0 } })).json();
        assert.deepStrictEqual(r.result.settings, { workers: 3, gamesPerPair: 4, thinkCapSec: 90, roundGapMin: 0 });
        assert.strictEqual(r.result.by, 'ericfode');
        assert.deepStrictEqual((await read({ token: 'games-secret' })).settings, { workers: 3, gamesPerPair: 4, thinkCapSec: 90, roundGapMin: 0 });
        // null goes back to the default; the others stay
        assert.deepStrictEqual((await (await post({ set: { workers: null } })).json()).result.settings, { gamesPerPair: 4, thinkCapSec: 90, roundGapMin: 0 });
        assert.strictEqual((await go('/api/arena-settings', { method: 'POST', token: 'admin-secret', body: '{"set":{"workers":2}}' })).status, 200, 'the admin token, from a program');

        for (const bad of [{}, { set: {} }, { set: [] }, { set: { workers: 0 } }, { set: { workers: 17 } }, { set: { workers: 2.5 } }, { set: { workers: '3' } },
            { set: { gamesPerPair: 3 } }, { set: { gamesPerPair: 12 } }, { set: { thinkCapSec: 5 } }, { set: { roundGapMin: -1 } }, { set: { idleMin: 5 } },
            { set: { workers: 3, constructor: 1 } }, { set: { __proto__: 1 } }]) {
            assert.strictEqual((await post(bad)).status, 400, JSON.stringify(bad));
        }
        assert.deepStrictEqual((await read({ cookie: eric })).settings, { workers: 2, gamesPerPair: 4, thinkCapSec: 90, roundGapMin: 0 }, 'a refused change changes nothing');

        // only an admin changes them, and a browser only from this site's pages and as JSON
        assert.strictEqual((await post({ set: { workers: 4 } }, { origin: null })).status, 403);
        assert.strictEqual((await post({ set: { workers: 4 } }, { origin: 'https://evil.fly.dev' })).status, 403);
        assert.strictEqual((await post({ set: { workers: 4 } }, { type: 'text/plain' })).status, 400);
        assert.strictEqual((await post({ set: { workers: 4 } }, { cookie: pal })).status, 403, 'a friend cannot');
        assert.strictEqual((await go('/api/arena-settings', { cookie: pal })).status, 403, 'nor read them');
        assert.strictEqual((await go('/api/arena-settings', { method: 'POST', token: 'games-secret', body: '{"set":{"workers":4}}' })).status, 403, 'the games machine only reads');
        assert.strictEqual((await go('/api/arena-settings', { token: 'push-secret' })).status, 403, 'the project token cannot read them');
        assert.strictEqual((await read({ token: 'admin-secret' })).settings.workers, 2);

        // a doc with something else in it (an older shape, a hand edit) gives only the valid settings
        w.store.putDoc('admin', 'arena-settings', JSON.stringify({ settings: { workers: 99, gamesPerPair: 6, junk: 1 }, updatedAt: 7 }));
        assert.deepStrictEqual(await read({ token: 'games-secret' }), { settings: { gamesPerPair: 6 }, updatedAt: null, by: null });
    } finally {
        await close();
    }
});

test('view links: a guest reads with no sign-in while the link exists, and never writes', async () => {
    const w = makeWindow('w-links');
    const { go, close } = await serve(w);
    try {
        const eric = `swu_session=${w.auth.sign({ l: 'ericfode', exp: Date.now() + 60000 })}`;
        const pal = `swu_session=${w.auth.sign({ l: 'pal', exp: Date.now() + 60000 })}`;
        const site = 'https://swu-arena.fly.dev';
        const post = (body, opts = {}) => go('/api/share', { method: 'POST', cookie: eric, origin: site, body: JSON.stringify(body), ...opts });
        assert.strictEqual((await post({ addLink: 'for Sam' }, { cookie: pal })).status, 403, 'a friend cannot make one');
        assert.strictEqual((await post({ addLink: 'for Sam' }, { origin: 'https://evil.fly.dev' })).status, 403);
        for (const bad of [{ addLink: '' }, { addLink: 'x'.repeat(61) }, { addLink: 'a\u0007b' }, { addLink: 'x', add: 'y' }, { removeLink: 'nope' }]) {
            assert.strictEqual((await post(bad)).status, 400, JSON.stringify(bad));
        }
        const made = (await (await post({ addLink: '  for   Sam ' })).json()).result.links;
        assert.strictEqual(made.length, 1);
        const [{ id, key, label }] = made;
        assert.strictEqual(label, 'for Sam');
        assert.match(id, /^[0-9a-f]{12}$/);
        assert.match(key, /^[A-Za-z0-9_-]{32}$/);

        assert.strictEqual((await go('/v/not-a-real-key-at-all')).status, 404);
        const open = await go(`/v/${key}`);
        assert.strictEqual(open.status, 302);
        assert.strictEqual(open.headers.get('location'), '/');
        const guest = open.headers.getSetCookie().find((c) => c.startsWith('swu_session=')).split(';')[0];
        assert.match(open.headers.getSetCookie().join(), /Max-Age=2592000/);
        assert.strictEqual((await go('/', { cookie: guest })).status, 200);
        assert.match(await (await go('/', { cookie: guest })).text(), /<title>app/);
        assert.deepStrictEqual((await (await go('/api/me', { cookie: guest })).json()).result, { login: null, role: 'friend', signin: 'invited', guest: true });
        assert.strictEqual((await go('/api/app', { cookie: guest })).status, 200);
        assert.strictEqual((await go('/api/share', { cookie: guest })).status, 403, 'a guest never sees the links');
        assert.strictEqual((await go('/api/docs/runs/x', { method: 'PUT', cookie: guest, body: '{}' })).status, 403, 'a guest never writes');
        assert.strictEqual((await go('/api/share', { method: 'POST', cookie: guest, origin: site, body: '{"addLink":"me"}' })).status, 403);

        // someone already signed in keeps their own session when they open a link
        const mine = await go(`/v/${key}`, { cookie: eric });
        assert.strictEqual(mine.status, 302);
        assert.strictEqual(mine.headers.getSetCookie().length, 0);
        // a guest who opens a second link moves onto it
        const second = (await (await post({ addLink: 'Sam, second' })).json()).result.links.at(-1);
        const moved = (await go(`/v/${second.key}`, { cookie: guest })).headers.getSetCookie().find((c) => c.startsWith('swu_session=')).split(';')[0];

        // removing a link locks its guests out at once; the one who moved on stays in until their link goes too
        assert.deepStrictEqual((await (await post({ removeLink: id })).json()).result.links.map((l) => l.id), [second.id]);
        assert.strictEqual((await go('/api/app', { cookie: guest })).status, 401);
        assert.match(await (await go('/', { cookie: guest })).text(), /Sign in with GitHub/);
        assert.strictEqual((await go(`/v/${key}`)).status, 404);
        assert.strictEqual((await go('/api/app', { cookie: moved })).status, 200);
        await post({ removeLink: second.id });
        assert.strictEqual((await go('/api/app', { cookie: moved })).status, 401);
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
        // the shape a Karabast feed sends (bot/karabast/feed.js before the split); the window keeps only the fields the app reads
        const sent = { id: 'karabast', createdAt: '2026-10-11T21:00:00Z', engine: null, bots: ['c-clock'], gamesPerPairing: 1, games: [
            { ...row, seed: 0, winner: null, winnerSeat: null, rounds: 2, steps: 40, error: null, ms: 0, timing: { p1: { n: 1, ms: 5 } } },
            { id: 'karabast-2', seed: 0, p1: 'opponent', p2: 'c-clock', winner: 'c-clock', winnerSeat: 'p2', rounds: 7, steps: 300, outcome: 'won', error: null, ms: 0 },
            { id: 'karabast-3', seed: 0, p1: 'c-clock', p2: 'opponent', winner: null, winnerSeat: 'draw', rounds: 0, steps: 1, outcome: 'abandoned', error: 'no result', ms: 0 },
            { id: 'karabast-4', p1: 'c-clock', p2: 'opponent', winnerSeat: null, rounds: 9, steps: 500, outcome: 'draw' },
        ] };
        assert.strictEqual((await doc('runs', 'karabast', 'PUT', JSON.stringify({ ...sent, bots: undefined }))).status, 400, 'a run with games names its bots');
        assert.strictEqual((await doc('runs', 'karabast', 'PUT', JSON.stringify({ ...sent, bots: ['opponent'] }))).status, 400, '"opponent" is no bot');
        assert.strictEqual((await doc('runs', 'karabast', 'PUT', JSON.stringify({ ...sent, bots: ['rush'] }))).status, 400, 'every game seats one of its bots');
        // a seat outside the bots list is a person: stored as "opponent", the winner too, so no name is kept
        assert.strictEqual((await doc('runs', 'karabast', 'PUT', JSON.stringify({ ...sent, games: [{ id: 'karabast-9', p1: 'alice', p2: 'c-clock', outcome: 'won', winnerSeat: 'p1', error: 'alice left the lobby' }] }))).status, 200);
        const kept = JSON.stringify((await (await go('/api/docs/runs/karabast', { token: 'feed-secret' })).json()).result);
        assert.ok(!kept.includes('alice') && kept.includes('"p1":"opponent"') && kept.includes('"winner":"opponent"') && kept.includes('"error":"no result"'), kept);
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

test('a feed\'s person names go to admin/people, which only an admin reads; the run keeps "opponent"', async () => {
    const w = makeWindow('w-names');
    const { go, close } = await serve(w);
    try {
        const friend = `swu_session=${w.auth.sign({ l: 'pal', exp: Date.now() + 60000 })}`;
        const eric = `swu_session=${w.auth.sign({ l: 'ericfode', exp: Date.now() + 60000 })}`;
        const put = (games) => go('/api/docs/runs/karabast', { method: 'PUT', token: 'feed-secret', body: JSON.stringify({ id: 'karabast', createdAt: '2026-10-14T00:00:00Z', bots: ['c-clock'], games }) });
        const g = (id, person) => ({ id, p1: 'c-clock', p2: 'opponent', outcome: 'won', winnerSeat: 'p1', person });
        assert.strictEqual((await put([g('karabast-1', 'Zed Example'), g('karabast-2', 'x'.repeat(65)), g('karabast-3', 'a\nb'), g('karabast-4', '  '), g('karabast-5', 7)])).status, 200, 'a bad name is dropped, never the run');
        assert.ok(!w.store.getDoc('runs', 'karabast').includes('Zed'), 'the run document never holds a name');
        const names = async (who) => { const r = await go('/api/docs/admin/people', who); return r.status === 200 ? (await r.json()).result.names : r.status; };
        assert.deepStrictEqual(await names({ cookie: eric }), { 'karabast-1': 'Zed Example' }, "Eric's sign-in reads them");
        assert.deepStrictEqual(await names({ token: 'admin-secret' }), { 'karabast-1': 'Zed Example' });
        for (const who of [{ cookie: friend }, { token: 'push-secret' }, { token: 'feed-secret' }]) {
            assert.strictEqual(await names(who), 403, JSON.stringify(who));
        }
        // a later list keeps the names it no longer carries, and adds new ones
        assert.strictEqual((await put([g('karabast-6', 'Yan Example')])).status, 200);
        assert.deepStrictEqual(await names({ cookie: eric }), { 'karabast-1': 'Zed Example', 'karabast-6': 'Yan Example' });
    } finally {
        await close();
    }
});

test('people are never named to readers: writers read back their own bytes, everyone else reads "a person"', async () => {
    const w = makeWindow('w-people');
    const { go, close } = await serve(w);
    try {
        const friend = `swu_session=${w.auth.sign({ l: 'pal', exp: Date.now() + 60000 })}`;
        const eric = `swu_session=${w.auth.sign({ l: 'ericfode', exp: Date.now() + 60000 })}`;
        // pushed with the project token: a run against people must name our bots, and is stored with the person as "opponent"
        const run = { id: 'karabast-p', createdAt: '2026-10-12T00:00:00Z', bots: ['c-clock'], owner: 'x', games: [{ id: 'g1', p1: 'bob', p2: 'c-clock', outcome: 'won', winnerSeat: 'p1', winner: 'bob' },
            { id: 'g2', p1: 'c-clock', p2: 'bob', outcome: 'ERROR', error: 'bob disconnected' }, { id: 'g3', p1: 'c-clock', p2: 'bob', outcome: 'ERROR', error: 'TIME_FORFEIT bob' }] };
        const putRun = (doc) => go(`/api/docs/runs/${doc.id}`, { method: 'PUT', token: 'push-secret', body: JSON.stringify(doc) });
        assert.strictEqual((await putRun({ ...run, bots: undefined })).status, 400, 'no bots list');
        assert.strictEqual((await putRun({ ...run, bots: ['opponent'] })).status, 400);
        assert.strictEqual((await putRun({ ...run, id: 'other', feed: 'sprite', bots: [] })).status, 400, 'a run marked as a feed\'s is a people run too');
        assert.strictEqual((await putRun(run)).status, 200);
        const stored = JSON.parse(w.store.getDoc('runs', 'karabast-p'));
        assert.deepStrictEqual(stored.games.map((g) => [g.p1, g.p2, g.winner, g.error]), [['opponent', 'c-clock', 'opponent', undefined], ['c-clock', 'opponent', undefined, 'no result'], ['c-clock', 'opponent', undefined, 'TIME_FORFEIT opponent']]);
        assert.strictEqual((await putRun({ id: 'ladder-2', createdAt: '2026-10-12T00:00:00Z', games: [{ id: 'g1', p1: 'zed-bot', p2: 'rush' }] })).status, 200, 'bot runs are stored as sent');
        assert.match(w.store.getDoc('runs', 'ladder-2'), /"zed-bot"/);
        const lines = [{ t: 'header', players: [{ id: 'p1', bot: 'bob' }, { id: 'p2', bot: 'c-clock' }] }, { t: 'step', state: { players: { p1: { name: 'bob' }, p2: { name: 'c-clock' } } } }].map((x) => `${JSON.stringify(x)}\n`);
        const append = (at, body) => go(`/api/replays/karabast-p/g1?at=${at}`, { method: 'POST', token: 'push-secret', body, type: 'application/x-ndjson' });
        assert.strictEqual((await append(0, lines[0] + lines[1].slice(0, 20))).status, 200, 'the step line is still being written');
        const read = async (who, from = 0) => {
            const r = await go(`/api/replays/karabast-p/g1?from=${from}`, who);
            return { text: await r.text(), size: Number(r.headers.get('x-size')) };
        };
        const first = await read({ cookie: friend });
        assert.deepStrictEqual(first, { text: `${JSON.stringify({ t: 'header', players: [{ id: 'p1', bot: 'a person' }, { id: 'p2', bot: 'c-clock' }] })}\n`, size: first.text.length }, 'whole lines only');
        assert.strictEqual((await read({ token: 'push-secret' })).text, lines[0] + lines[1].slice(0, 20), 'the writer reads its own bytes');
        assert.strictEqual((await append(Buffer.byteLength(lines[0]) + 20, lines[1].slice(20))).status, 200);
        const next = await read({ cookie: eric }, first.size);
        assert.strictEqual(next.text, `${JSON.stringify({ t: 'step', state: { players: { p1: { name: 'a person' }, p2: { name: 'c-clock' } } } })}\n`, 'a reader tailing from its own offset gets the next whole line, masked; an admin\'s sign-in too');
        assert.strictEqual(next.size, first.size + next.text.length);
        assert.deepStrictEqual((await (await go('/api/replays/karabast-p?sizes=1', { cookie: friend })).json()).result, [{ id: 'g1', size: null }]);
        assert.deepStrictEqual((await (await go('/api/replays/karabast-p?sizes=1', { token: 'push-secret' })).json()).result, [{ id: 'g1', size: Buffer.byteLength(lines.join('')) }]);
        // the run document: the person's seat and win read "opponent"
        for (const who of [{ cookie: friend }, { cookie: eric }]) {
            const doc = JSON.stringify((await (await go('/api/docs/runs/karabast-p', who)).json()).result);
            assert.ok(!doc.includes('bob') && doc.includes('"p1":"opponent"') && doc.includes('"winner":"opponent"'), doc);
        }
        assert.ok(!JSON.stringify((await (await go('/api/docs/runs?full=1', { cookie: friend })).json()).result).includes('bob'));
        for (const p of ['/replays/karabast-p/index.json', '/replays/karabast-p/games/g1.jsonl']) {
            assert.ok(!(await (await go(p, { cookie: friend })).text()).includes('bob'), p);
        }
        // bot-vs-bot runs are served exactly as stored
        w.store.putReplay('ladder-1', 'g1', Buffer.from(lines[0]));
        assert.strictEqual(await (await go('/api/replays/ladder-1/g1', { cookie: friend })).text(), lines[0]);
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

test('the app data stops showing a game as playing once its run goes quiet, with nothing new pushed', { skip: !fs.existsSync(path.join(__dirname, '..', '..', 'dashboard', 'site', 'core.cjs')) }, async () => {
    const w = makeWindow('w5b', { staleMs: 300 });
    const { go, close } = await serve(w);
    try {
        const idx = { id: 'test-quiet', createdAt: '2026-10-13T14:00:00Z', bots: ['rush', 'random'], gamesPerPairing: 2, games: [{ id: 'g1', p1: 'rush', p2: 'random', seed: 1, outcome: 'running', winner: null, winnerSeat: null, rounds: 0 }] };
        await go('/api/docs/runs/test-quiet', { method: 'PUT', token: 'push-secret', body: JSON.stringify(idx) });
        const app = async () => (await (await go('/api/app', { token: 'push-secret' })).json()).result;
        const res = async () => (await app()).model.games.find((g) => g[1] === 'g1')[4];
        assert.strictEqual(await res(), 3, 'playing while its run sends');
        const before = (await app()).version;
        await new Promise((r) => setTimeout(r, 400));
        // a request that finds the build out of date starts a rebuild and gets the last build meanwhile
        let now = await res();
        for (let i = 0; i < 20 && now !== 5; i++) {
            await new Promise((r) => setTimeout(r, 50));
            now = await res();
        }
        assert.strictEqual(now, 5, 'stopped: the run sent nothing for longer than staleMs');
        assert.notStrictEqual((await app()).version, before, 'a new version, or open browsers (syncApi) would keep the old model');
        const run = (await (await go('/api/app', { token: 'push-secret' })).json()).result.model.runs.find((r) => r.id === 'test-quiet');
        assert.deepStrictEqual([run.running, run.abandoned, run.errors], [0, 1, 0]);
    } finally {
        await close();
    }
});

test('the app model keeps its ETag while it comes out the same, so the open tabs that ask every 15 s get a 304', { skip: !fs.existsSync(path.join(__dirname, '..', '..', 'dashboard', 'site', 'core.cjs')) }, async () => {
    const w = makeWindow('w-model-etag');
    const { go, close } = await serve(w);
    try {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const game = (id) => ({ id, p1: 'rush', p2: 'random', seed: 1, outcome: 'won', winner: 'rush', winnerSeat: 'p1', rounds: 5 });
        const put = (games) => go('/api/docs/runs/test-etag', { method: 'PUT', token: 'push-secret', body: JSON.stringify({ id: 'test-etag', createdAt: '2026-10-16T14:00:00Z', bots: ['rush', 'random'], gamesPerPairing: 2, games }) });
        const get = (headers = {}) => go('/api/app', { token: 'push-secret', headers });
        // a build until it shows what was sent (a request that finds the build out of date gets the last one meanwhile)
        const until = async (ok) => {
            for (let i = 0; i < 40; i++) {
                const r = await get();
                const j = await r.json();
                if (ok(j.result)) {
                    return { tag: r.headers.get('etag'), version: j.result.version };
                }
                await sleep(25);
            }
            throw new Error('the model never showed it');
        };
        const games = (m) => m.model.runs.find((r) => r.id === 'test-etag')?.n;
        await put([game('g1')]);
        const first = await until((m) => games(m) === 1);
        assert.match(first.tag, /^W\/"/);
        const same = await get({ 'if-none-match': first.tag });
        assert.strictEqual(same.status, 304);
        assert.strictEqual(await same.text(), '');
        // the same document again (the arena's uplink sends its documents every 20 s): the model is the same, so is the ETag
        await put([game('g1')]);
        await get();
        await sleep(50);
        assert.strictEqual((await get({ 'if-none-match': first.tag })).status, 304);
        // a real change is a new ETag and a new version
        await put([game('g1'), game('g2')]);
        const next = await until((m) => games(m) === 2);
        assert.notStrictEqual(next.tag, first.tag);
        assert.notStrictEqual(next.version, first.version);
        assert.strictEqual((await get({ 'if-none-match': first.tag })).status, 200);
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
        // nothing changed, but a game is running: the index goes again once the heartbeat is due, so the window sees the run alive
        const docFile = path.join(w.store.dir, 'docs', 'runs', 'live-ladder.json');
        const old = Date.now() / 1000 - 3600;
        fs.utimesSync(docFile, old, old);
        await pushRunOnce(dir, mem);
        assert.ok(fs.statSync(docFile).mtimeMs < Date.now() - 1800000, 'not before the heartbeat is due');
        await pushRunOnce(dir, mem, { heartbeatMs: 0 });
        assert.ok(fs.statSync(docFile).mtimeMs > Date.now() - 60000, 'sent again as a heartbeat');
        fs.appendFileSync(file, 'ep"}\n');
        await pushRunOnce(dir, { docs: new Map(), replays: new Map() }); // a restarted pusher sends only what the window lacks
        assert.strictEqual(await replay(), '{"t":"header"}\n{"t":"step"}\n');
        fs.appendFileSync(file, '{"t":"end"}\n');
        index('won');
        assert.strictEqual((await pushRunOnce(dir, mem)).going, false);
        assert.strictEqual(await replay(), '{"t":"header"}\n{"t":"step"}\n{"t":"end"}\n');
        fs.utimesSync(docFile, old, old);
        await pushRunOnce(dir, mem, { heartbeatMs: 0 });
        assert.ok(fs.statSync(docFile).mtimeMs < Date.now() - 1800000, 'a finished run sends no heartbeat');
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
    const had = process.env.ARENA_PUSH_TOKEN;
    try {
        process.env.SWU_WINDOW = `http://127.0.0.1:${srv.address().port}`;
        process.env.ARENA_PUSH_TOKEN = 'push-secret'; // how newer cloud sessions get the token
        delete require.cache[require.resolve('../arena/push')];
        assert.strictEqual(await require('../arena/push').arenaPusher().once(), true);
        const roster = JSON.parse(w.store.getDoc('arena', 'roster'));
        assert.deepStrictEqual([roster.agents[0].name, roster.bench[0].name], ['aa', 'bb']);
        assert.doesNotMatch(JSON.stringify(roster), /tokenHash/);
    } finally {
        delete process.env.SWU_WINDOW;
        if (had === undefined) delete process.env.ARENA_PUSH_TOKEN;
        else process.env.ARENA_PUSH_TOKEN = had;
        await close();
    }
});

test('push: the arena uplink\'s round pass sends only the playing round, and none of the arena\'s documents', async () => {
    const home = process.env.ARENA_HOME, results = process.env.ARENA_RESULTS;
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'roster.json'), JSON.stringify({ thinkCapMs: 60000, baselines: ['rush'], agents: [{ name: 'aa', title: 'aa', philosophy: '', start: 'rush' }] }));
    fs.writeFileSync(path.join(home, 'standings.json'), JSON.stringify({ rounds: [{ round: 1, ladderId: 'arena-r1' }] }));
    for (const [id, outcome] of [['arena-r1', 'won'], ['arena-r2', 'running']]) {
        fs.mkdirSync(path.join(results, id, 'games'), { recursive: true });
        fs.writeFileSync(path.join(results, id, 'index.json'), JSON.stringify({ id, games: [{ id: 'g1', p1: 'aa', p2: 'rush', outcome }] }));
        fs.writeFileSync(path.join(results, id, 'games', 'g1.jsonl'), '{"t":"header"}\n{"t":"step"}\n');
    }
    const w = makeWindow('w8');
    const { srv, close } = await serve(w);
    try {
        process.env.SWU_WINDOW = `http://127.0.0.1:${srv.address().port}`;
        process.env.SWU_WINDOW_TOKEN = 'push-secret';
        delete require.cache[require.resolve('../arena/push')];
        const pusher = require('../arena/push').arenaPusher();
        assert.strictEqual(await pusher.once({ only: 'round' }), true);
        assert.strictEqual(w.store.getDoc('arena', 'status'), null, 'no status');
        assert.strictEqual(w.store.getDoc('arena', 'roster'), null, 'no roster');
        assert.strictEqual(w.store.getDoc('runs', 'arena-r1'), null, 'not the round before');
        assert.strictEqual(JSON.parse(w.store.getDoc('runs', 'arena-r2')).games[0].outcome, 'running');
        fs.appendFileSync(path.join(results, 'arena-r2', 'games', 'g1.jsonl'), '{"t":"step"}\n');
        assert.strictEqual(await pusher.once({ only: 'round' }), true);
        assert.deepStrictEqual(w.store.listReplays('arena-r2'), ['g1']);
        // a full pass sends the rest, the round before included
        assert.strictEqual(await pusher.once(), true);
        assert.ok(w.store.getDoc('arena', 'roster') && w.store.getDoc('runs', 'arena-r1'));
    } finally {
        delete process.env.SWU_WINDOW;
        delete process.env.SWU_WINDOW_TOKEN;
        fs.rmSync(path.join(results, 'arena-r1'), { recursive: true, force: true });
        fs.rmSync(path.join(results, 'arena-r2'), { recursive: true, force: true });
        fs.rmSync(path.join(home, 'standings.json'), { force: true });
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

        // no token: the usual reads and the window's own tools, and the window itself refuses every call
        const plain = (await friendless.ask('tools/list')).result.tools.map((t) => t.name);
        assert.ok(plain.includes('window_put_run') && plain.includes('arena_status') && !plain.includes('arena_register'));
        assert.strictEqual((await friendless.tool('arena_status')).error, true);
    } finally {
        project.close();
        friendless.close();
        await close();
    }
});

test('mcp: a token argument never goes into a URL, nothing but reads goes to the window, and a remote that never answers does not hold up tools/list', async () => {
    const http = require('http');
    const seen = [];
    // a stand-in for the window: it lists its arena reads at /api and answers every read
    const win = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, body });
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ result: req.url === '/api' ? { arena: ['status', 'versions'], collections: ['arena'] } : { ok: true } }));
        });
    });
    const silent = http.createServer(() => undefined); // accepts, never answers
    await Promise.all([win, silent].map((s) => new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))));
    const url = (s) => `http://127.0.0.1:${s.address().port}`;
    const remote = await mcpSession(['--remote', url(win)]);
    const stuck = await mcpSession(['--remote', url(silent)], { ARENA_PROBE_MS: '1000' });
    try {
        await remote.ask('initialize');
        const names = (await remote.ask('tools/list')).result.tools.map((t) => t.name);
        assert.deepStrictEqual(names.filter((x) => x.startsWith('arena_')), ['arena_status', 'arena_versions'], 'the reads the window lists');
        await remote.tool('arena_status');
        await remote.tool('arena_versions', { name: 'aa', token: 'secret-token' });
        const status = seen.find((r) => r.url.startsWith('/api/status'));
        const versions = seen.find((r) => r.url.startsWith('/api/versions'));
        assert.deepStrictEqual([status.method, status.url], ['GET', '/api/status'], 'a read is a GET, and status takes no arguments');
        assert.deepStrictEqual([versions.method, versions.url], ['GET', '/api/versions?name=aa'], 'the token argument is left out');
        const submit = await remote.tool('arena_submit', { name: 'aa', note: 'n' });
        assert.deepStrictEqual([submit.error, submit.value.code], [true, 'unsupported']);
        assert.ok(seen.every((r) => r.method === 'GET' && !r.url.includes('secret-token')), 'only GETs, and no token in a URL');
        await stuck.ask('initialize');
        const t0 = Date.now();
        const fallback = (await stuck.ask('tools/list')).result.tools.map((t) => t.name);
        assert.ok(fallback.includes('arena_status') && fallback.includes('window_put_run') && !fallback.includes('arena_submit'), "falls back to the window's usual reads and its tools");
        assert.ok(Date.now() - t0 < 1800, `one probe deadline (took ${Date.now() - t0} ms)`);
    } finally {
        remote.close();
        stuck.close();
        win.close();
        silent.closeAllConnections?.();
        silent.close();
    }
});

/** An MCP access token for an invited login, through the window's real OAuth flow (consent page, PKCE, token). */
async function mcpToken(w, go, login) {
    const crypto = require('crypto');
    const site = 'https://swu-arena.fly.dev';
    const cb = 'https://claude.ai/api/mcp/auth_callback';
    const form = (o) => new URLSearchParams(o).toString();
    const post = (p, body, opts = {}) => go(p, { method: 'POST', body: form(body), type: 'application/x-www-form-urlencoded', ...opts });
    const cookie = `swu_session=${w.auth.sign({ l: login, exp: Date.now() + 60000 })}`;
    const client = await (await go('/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: 'Claude', redirect_uris: [cb] }) })).json();
    const verifier = crypto.randomBytes(40).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const ask = `/oauth/authorize?${form({ response_type: 'code', client_id: client.client_id, redirect_uri: cb, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${site}/mcp` })}`;
    const tx = /name="tx" value="([^"]+)"/.exec(await (await go(ask, { cookie })).text())[1].replace(/&#(\d+);/g, (m, c) => String.fromCharCode(c));
    const code = new URL((await post('/oauth/authorize', { tx, decision: 'allow' }, { cookie, origin: site })).headers.get('location')).searchParams.get('code');
    return (await (await post('/oauth/token', { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: cb, code_verifier: verifier })).json()).access_token;
}

test('mcp submit: a signed-in person submits a bot, reads only their own submissions, and the arena\'s result comes back', async () => {
    let wakes = 0;
    const w = makeWindow('w-submit', { wakeGames: () => wakes++ });
    const { go, close } = await serve(w);
    try {
        w.store.putDoc('admin', 'invites', JSON.stringify({ logins: ['Kim-B', 'lee', 'kim-b-x', 'house'] }));
        w.store.putDoc('arena', 'status', JSON.stringify({ competitors: [{ name: 'duel_opus', owner: null }, { name: 'kim_b_two', owner: 'github:kim-b' }, { name: 'kim_b_old', owner: 'github:someone' }] }));
        const kim = await mcpToken(w, go, 'Kim-B');
        const lee = await mcpToken(w, go, 'lee');
        const call = async (t, name, args = {}) => {
            const r = (await (await go('/mcp', { method: 'POST', token: t, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
            return { error: !!r.isError, value: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
        };
        assert.match((await call(kim, 'arena_guide')).value.text, /^# Build a bot for the SWU Arena/);
        assert.match((await call(kim, 'arena_guide', { topic: 'protocol' })).value.text, /^# Bot protocol/);

        const bot = { kind: 'js', note: 'first try', files: { 'bot.js': "require('./stdio').serve({ decide: (m) => ({ t: 'act', i: 0 }) });" } };
        for (const [args, why] of [
            [{ ...bot, kind: 'exe' }, /kind: one of js, python, wasm/],
            [{ ...bot, note: ' ' }, /note/],
            [{ ...bot, files: { '../bot.js': 'x' } }, /not a plain relative path/],
            [{ ...bot, files: { '/etc/x': 'x' } }, /not a plain relative path/],
            [{ ...bot, files: { 'bot.js': 7 } }, /must be a string/],
            [{ ...bot, files: { 'bot.js': 'x'.repeat(3e6 + 1) } }, /at most 3 MB/],
            [{ ...bot, base64: ['other.wasm'] }, /base64/],
            [{ ...bot, name: 'Bad-Name' }, /name: 1-32/],
            [{ ...bot, name: 'duel_opus' }, /is not yours/],
            [{ ...bot, name: 'lee' }, /is not yours: use your builder name kim_b/],
            [{ ...bot, name: 'kim_b_x' }, /is not yours/], // @kim-b-x's builder name
            [{ ...bot, name: 'kim_b_old' }, /another competitor's name/]
        ]) {
            const r = await call(kim, 'arena_submit', args);
            assert.ok(r.error && why.test(r.value), `${JSON.stringify(args).slice(0, 80)}: ${r.value}`);
        }
        assert.strictEqual(wakes, 0, 'a refused submission wakes nothing');
        const first = (await call(kim, 'arena_submit', bot)).value;
        assert.deepStrictEqual([first.name, first.kind, first.state], ['kim_b', 'js', 'pending']);
        assert.strictEqual(wakes, 1, 'a stored submission wakes the games machine');
        assert.match(first.id, /^kim-b\./);
        assert.strictEqual((await call(kim, 'arena_submit', { ...bot, name: 'kim_b_two' })).value.name, 'kim_b_two', 'a second competitor of their own');
        const stored = JSON.parse(w.store.getDoc('submissions', first.id));
        assert.deepStrictEqual([stored.owner, stored.files['bot.js'], stored.state], ['kim-b', bot.files['bot.js'], 'pending']);

        // only the arena reads the collection: never a friend, raw or through the tools
        assert.strictEqual((await go('/api/docs/submissions', { token: kim })).status, 403);
        assert.strictEqual((await go(`/api/docs/submissions/${first.id}`, { token: kim })).status, 403);
        assert.strictEqual((await (await go('/api/docs/submissions', { token: 'push-secret' })).json()).result.length, 2);
        assert.deepStrictEqual((await call(lee, 'arena_my_submissions')).value, []);
        const mine = (await call(kim, 'arena_my_submissions')).value;
        assert.deepStrictEqual(mine.map((x) => [x.name, x.state, x.files, x.fileNames]), [['kim_b_two', 'pending', undefined, ['bot.js']], ['kim_b', 'pending', undefined, ['bot.js']]]);

        // at most 3 waiting at once for one competitor; another of theirs is counted apart
        assert.strictEqual((await call(kim, 'arena_submit', bot)).error, false);
        assert.strictEqual((await call(kim, 'arena_submit', bot)).error, false);
        assert.match((await call(kim, 'arena_submit', bot)).value, /kim_b has 3 submissions waiting/);
        assert.strictEqual((await call(kim, 'arena_submit', { ...bot, name: 'kim_b_two' })).error, false);

        // the arena's intake writes its result back with the project token; the person reads it
        const { files, ...rest } = stored;
        const woken = wakes;
        assert.strictEqual((await go(`/api/docs/submissions/${first.id}`, { method: 'PUT', token: 'push-secret', body: JSON.stringify({ ...rest, fileNames: ['bot.js'], state: 'accepted', version: 'kim_b-v1' }) })).status, 200);
        assert.strictEqual((await go(`/api/docs/submissions/${first.id}`, { method: 'PUT', token: 'feed-secret', body: '{}' })).status, 403, 'a feed cannot');
        const after = (await call(kim, 'arena_my_submissions')).value.find((x) => x.id === first.id);
        assert.deepStrictEqual([after.state, after.version, after.fileNames], ['accepted', 'kim_b-v1', ['bot.js']]);
        assert.strictEqual(wakes, woken, 'the intake\'s result wakes nothing');

        // the arena's own bots (ops/house-submit.js): a new pending submission written with the token wakes the machine
        const house = { id: 'house.rush.x1', owner: '@arena', name: 'rush', kind: 'js', note: 'the port', files: bot.files, state: 'pending', submittedAt: new Date().toISOString() };
        assert.strictEqual((await go(`/api/docs/submissions/${house.id}`, { method: 'PUT', token: kim, body: JSON.stringify(house) })).status, 403, 'signing in only reads');
        assert.strictEqual(wakes, woken);
        assert.strictEqual((await go(`/api/docs/submissions/${house.id}`, { method: 'PUT', token: 'push-secret', body: JSON.stringify(house) })).status, 200);
        assert.strictEqual(wakes, woken + 1);
        assert.strictEqual((await go(`/api/docs/submissions/${house.id}`, { method: 'PUT', token: 'push-secret', body: JSON.stringify({ ...house, state: 'checking' }) })).status, 200);
        assert.strictEqual(wakes, woken + 1, 'only a new one');
        assert.deepStrictEqual((await call(kim, 'arena_my_submissions')).value.map((x) => x.id).includes(house.id), false, 'no login is @arena');
        const houseLogin = await mcpToken(w, go, 'house');
        assert.deepStrictEqual((await call(houseLogin, 'arena_my_submissions')).value, [], 'nor @house, whose ids would match');
    } finally {
        await close();
    }
});

test('auth: with ARENA_SIGNIN=github anyone with GitHub is a member, a blocked login is no one, and an admin is never blocked', () => {
    const dir = path.join(tmp, 'auth-open');
    const open = createAuth({ dir, env: { ...ENV, ARENA_SIGNIN: 'github' }, blocked: () => ['Bad-Guy', 'ericfode', 'pal'] });
    assert.deepStrictEqual(['anyone', 'pal', 'bad-guy', 'ericfode', '-bad', ''].map((l) => open.roleOf(l)), ['member', 'anon', 'anon', 'admin', 'anon', 'anon']);
    assert.deepStrictEqual([open.isBlocked('BAD-GUY'), open.isBlocked('ericfode'), open.isBlocked('anyone')], [true, false, false]);
    assert.strictEqual(open.fixed().signin, 'github');
    const cookie = (l) => ({ headers: { cookie: `swu_session=${open.sign({ l, exp: Date.now() + 60000 })}` } });
    assert.deepStrictEqual(open.who(cookie('anyone')), { role: 'member', login: 'anyone', via: 'cookie' });
    assert.deepStrictEqual(open.who(cookie('bad-guy')), { role: 'anon', login: 'bad-guy', blocked: true, via: 'cookie' });
    // an app reads as its person, never more than a friend
    open.useBearer((t) => ({ anyone: { login: 'anyone' }, eric: { login: 'ericfode' }, bad: { login: 'bad-guy' } })[t] ?? null);
    const app = (t) => open.who({ headers: { authorization: `Bearer ${t}` } }).role;
    assert.deepStrictEqual(['anyone', 'eric', 'bad'].map(app), ['member', 'friend', 'anon']);
    // anything but a known mode is the closed one
    for (const mode of [undefined, 'invited', 'everyone', 'GITHUB']) {
        const closed = createAuth({ dir, env: { ...ENV, ARENA_SIGNIN: mode } });
        assert.deepStrictEqual([closed.roleOf('anyone'), closed.roleOf('pal'), closed.fixed().signin], ['anon', 'friend', 'invited'], String(mode));
    }
});

test('open sign-in: a stranger signs in and reads, the swarm and the open tables stay for invited people, and a blocked login is out everywhere', async () => {
    const fakeGithub = async (url) => ({ json: async () => (url.includes('access_token') ? { access_token: 'gh-token' } : { login: 'Stranger', id: 7 }) });
    const w = makeWindow('w-open', { env: { ...ENV, ARENA_SIGNIN: 'github' }, fetchImpl: fakeGithub });
    const { go, close } = await serve(w);
    try {
        assert.match(await (await go('/')).text(), /enter a bot of your own.*Sign in with GitHub/s, 'the sign-in page says anyone may');
        const start = await go('/auth/github?next=%2F%23%2Farena');
        const to = new URL(start.headers.get('location'));
        assert.strictEqual(to.searchParams.get('allow_signup'), 'true', 'someone without a GitHub account may make one on the way');
        const back = await go(`/auth/github/callback?code=c&state=${to.searchParams.get('state')}`, { cookie: start.headers.get('set-cookie').split(';')[0] });
        assert.strictEqual(back.headers.get('location'), '/#/arena');
        const stranger = back.headers.getSetCookie().find((c) => c.startsWith('swu_session=')).split(';')[0];
        assert.strictEqual((await go('/', { cookie: stranger })).status, 200);
        assert.deepStrictEqual((await (await go('/api/me', { cookie: stranger })).json()).result, { login: 'stranger', role: 'member', signin: 'github' });
        assert.strictEqual((await go('/api/status', { cookie: stranger })).status, 200);
        assert.strictEqual((await (await go('/api/feedback', { cookie: stranger })).json()).result.may, true);
        assert.strictEqual((await go('/api/share', { cookie: stranger })).status, 403, 'nor the Share page');
        // the swarm's games are rated, so it stays for invited people; the open tables follow their own setting
        assert.strictEqual((await go('/swarm', { cookie: stranger })).status, 403);
        assert.strictEqual((await go('/api/swarm/info', { cookie: stranger })).status, 403);
        assert.strictEqual((await go('/api/tables/info', { cookie: stranger })).status, 403);

        // an admin blocks a login from the Share page: it is out at once, and back once unblocked
        const eric = `swu_session=${w.auth.sign({ l: 'ericfode', exp: Date.now() + 60000 })}`;
        const site = 'https://swu-arena.fly.dev';
        const share = (body, cookie = eric) => go('/api/share', { method: 'POST', cookie, origin: site, body: JSON.stringify(body) });
        assert.strictEqual((await share({ block: 'someone' }, stranger)).status, 403, 'a member cannot block');
        assert.strictEqual((await share({ block: 'EricFode' })).status, 409, 'an admin is never blocked');
        const listed = (await (await share({ block: '@Stranger' })).json()).result;
        assert.deepStrictEqual([listed.signin, listed.blocked, listed.limits.botsPerPerson], ['github', ['stranger'], 2]);
        const home = await go('/', { cookie: stranger });
        assert.strictEqual(home.status, 403);
        assert.match(await home.text(), /@stranger<\/b>, who may not use the arena/);
        assert.match((await (await go('/api/status', { cookie: stranger })).json()).error.message, /@stranger may not use the arena/);
        assert.strictEqual((await (await go('/api/feedback', { cookie: stranger })).json()).result.may, false);
        assert.strictEqual((await go('/art/SOR/005.png', { cookie: stranger })).status, 401);
        assert.deepStrictEqual((await (await share({ unblock: 'stranger' })).json()).result.blocked, []);
        assert.strictEqual((await go('/', { cookie: stranger })).status, 200, 'back at once');
    } finally {
        await close();
    }
});

test('mcp submit: a person fields 2 bots and sends 10 a day, the arena takes 20 from builders, and a suffix is never another GitHub account\'s builder name', async () => {
    const asked = [];
    const githubHas = async (login) => {
        asked.push(login);
        return login === 'ana-fast' ? true : login === 'ana-down' ? null : false;
    };
    const w = makeWindow('w-limits', { env: { ...ENV, ARENA_SIGNIN: 'github' }, githubHas });
    const { go, close } = await serve(w);
    try {
        const call = async (t, name, args = {}) => {
            const r = (await (await go('/mcp', { method: 'POST', token: t, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
            return { error: !!r.isError, value: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
        };
        const status = (competitors) => w.store.putDoc('arena', 'status', JSON.stringify({ competitors }));
        const bot = { kind: 'js', note: 'try', files: { 'bot.js': "require('./stdio').serve({ decide: () => ({ t: 'act', i: 0 }) });" } };
        status([]);
        const ana = await mcpToken(w, go, 'ana');
        assert.strictEqual((await call(ana, 'whoami')).value.role, 'member');
        assert.strictEqual((await call(ana, 'arena_submit', bot)).value.name, 'ana', 'the builder name asks GitHub nothing');
        assert.deepStrictEqual(asked, []);
        assert.match((await call(ana, 'arena_submit', { ...bot, name: 'ana_fast' })).value, /is the builder name of @ana-fast on GitHub/, '@ana-fast exists on GitHub');
        assert.match((await call(ana, 'arena_submit', { ...bot, name: 'ana_down' })).value, /GitHub did not answer/);
        assert.strictEqual((await call(ana, 'arena_submit', { ...bot, name: 'ana_two' })).value.name, 'ana_two');
        assert.deepStrictEqual(asked, ['ana-fast', 'ana-down', 'ana-two']);
        assert.match((await call(ana, 'arena_submit', { ...bot, name: 'ana_three' })).value, /at most 2 bots each: send new versions to ana_two or ana/);
        assert.strictEqual((await call(ana, 'arena_submit', bot)).error, false, 'new versions of a bot of theirs are fine');
        // a bot the arena entered counts while it plays; a benched one does not
        status([{ name: 'ana', owner: 'github:ana' }, { name: 'ana_old', owner: 'github:ana', benched: true }]);
        assert.strictEqual((await call(ana, 'arena_submit', { ...bot, name: 'ana_old' })).error, false, 'a new version of a benched bot of theirs');
        // 10 a day over all their bots: 4 stored so far, and 6 more from earlier today
        for (let i = 0; i < 6; i++) {
            w.store.putDoc('submissions', `ana.old${i}`, JSON.stringify({ id: `ana.old${i}`, owner: 'ana', name: 'ana_two', state: 'accepted', submittedAt: new Date().toISOString() }));
        }
        assert.match((await call(ana, 'arena_submit', { ...bot, name: 'ana_two' })).value, /at most 10 submissions a day over all your competitors/);

        // the arena takes 20 bots from builders who are not admins: the pending ones count, Eric's and the arena's do not
        const many = Array.from({ length: 18 }, (_, i) => ({ name: `p${i}`, owner: `github:p${i}` }));
        const anas = [{ name: 'ana', owner: 'github:ana' }, { name: 'ana_old', owner: 'github:ana', benched: true }];
        status([...many, ...anas, { name: 'ericfode_x', owner: 'github:ericfode' }, { name: 'rush', owner: 'arena' }]);
        // ana (playing) and ana_two (waiting, not entered yet) make 20 with the 18; ana_old is benched
        const zed = await mcpToken(w, go, 'zed');
        assert.match((await call(zed, 'arena_submit', bot)).value, /the arena is full: it takes 20 bots from builders/);
        status([...many.map((c, i) => (i === 0 ? { ...c, benched: true } : c)), ...anas]);
        const z = await call(zed, 'arena_submit', bot);
        assert.strictEqual(z.value.name, 'zed', `a benched bot leaves room: ${JSON.stringify(z)}`);

        // an admin has none of these limits (Eric's builders send many versions a day)
        const eric = await mcpToken(w, go, 'ericfode');
        for (const name of ['ericfode', 'ericfode_a', 'ericfode_b', 'ericfode_c']) {
            assert.strictEqual((await call(eric, 'arena_submit', { ...bot, name })).value.name, name);
        }
        assert.deepStrictEqual(asked, ['ana-fast', 'ana-down', 'ana-two'], 'nor asks GitHub for an admin');
    } finally {
        await close();
    }
});

test('mcp submit: new names sent at the same time, each waiting on GitHub, still make at most 2 bots', async () => {
    // GitHub answers slowly, so both submissions are counted before either is stored unless the limits are counted again
    const githubHas = () => new Promise((resolve) => setTimeout(() => resolve(false), 50));
    const w = makeWindow('w-limits-race', { env: { ...ENV, ARENA_SIGNIN: 'github' }, githubHas });
    const { go, close } = await serve(w);
    try {
        const call = async (t, name, args = {}) => {
            const r = (await (await go('/mcp', { method: 'POST', token: t, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
            return { error: !!r.isError, value: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
        };
        w.store.putDoc('arena', 'status', JSON.stringify({ competitors: [] }));
        const bot = { kind: 'js', note: 'try', files: { 'bot.js': "require('./stdio').serve({ decide: () => ({ t: 'act', i: 0 }) });" } };
        const bea = await mcpToken(w, go, 'bea');
        assert.strictEqual((await call(bea, 'arena_submit', bot)).value.name, 'bea');
        const both = await Promise.all(['bea_a', 'bea_b', 'bea_c'].map((name) => call(bea, 'arena_submit', { ...bot, name })));
        assert.strictEqual(both.filter((r) => !r.error).length, 1, JSON.stringify(both));
        assert.strictEqual(both.filter((r) => r.error && /at most 2 bots each/.test(r.value)).length, 2, JSON.stringify(both));
        assert.deepStrictEqual([...new Set(w.store.listDocs('submissions').map((d) => JSON.parse(w.store.getDoc('submissions', d.id)).name))].sort(), ['bea', both.find((r) => !r.error).value.name].sort());
    } finally {
        await close();
    }
});

test('mcp agent: a connect link gives an agent with no browser a token that submits as one competitor only', async () => {
    const w = makeWindow('w-agent');
    const { go, close } = await serve(w);
    try {
        const site = 'https://swu-arena.fly.dev';
        const form = (o) => new URLSearchParams(o).toString();
        const post = (p, body, opts = {}) => go(p, { method: 'POST', body: form(body), type: 'application/x-www-form-urlencoded', ...opts });
        const session = (l) => `swu_session=${w.auth.sign({ l, exp: Date.now() + 60000 })}`;
        const unescape = (x) => x.replace(/&#(\d+);/g, (m, c) => String.fromCharCode(c));
        w.store.putDoc('admin', 'invites', JSON.stringify({ logins: ['kim-b', 'lee'] }));
        w.store.putDoc('arena', 'status', JSON.stringify({ competitors: [{ name: 'kim_b_old', owner: 'github:someone' }] }));
        const meta = await (await go('/.well-known/oauth-authorization-server')).json();
        assert.strictEqual(meta.device_authorization_endpoint, `${site}/oauth/device_authorization`);
        assert.ok(meta.grant_types_supported.includes('urn:ietf:params:oauth:grant-type:device_code'));

        const start = async (name, label = 'Sprite one') => (await post('/oauth/device_authorization', { name, label })).json();
        const poll = async (device) => (await post('/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device })).json();
        const consent = (code, cookie) => go(`/oauth/device?user_code=${encodeURIComponent(code)}`, { cookie });
        const answer = async (code, decision, login = 'kim-b', origin = site) => {
            const page = await (await consent(code, session(login))).text();
            const tx = unescape(/name="tx" value="([^"]+)"/.exec(page)[1]);
            return post('/oauth/device', { tx, decision }, { cookie: session(login), origin });
        };
        assert.strictEqual((await post('/oauth/device_authorization', { name: 'Bad-Name' })).status, 400);

        const d = await start('kim_b_sprite');
        assert.match(d.user_code, /^[B-Z]{4}-[B-Z]{4}$/);
        assert.strictEqual(d.verification_uri_complete, `${site}/oauth/device?user_code=${d.user_code}`);
        assert.strictEqual((await poll(d.device_code)).error, 'authorization_pending');
        assert.strictEqual((await poll(d.device_code)).error, 'slow_down', 'polled again at once');

        // the person's side: sign in first; only invited people; the code typed in any case and spacing
        assert.match(await (await consent(d.user_code)).text(), /Sign in with GitHub/);
        assert.strictEqual((await consent(d.user_code, session('stranger'))).status, 403);
        assert.strictEqual((await consent('ZZZZ-ZZZZ', session('kim-b'))).status, 404);
        const page = await (await consent(d.user_code.toLowerCase().replace('-', ' '), session('kim-b'))).text();
        assert.ok(page.includes(d.user_code) && page.includes('kim_b_sprite') && page.includes('Sprite one'), 'the page names the code, the competitor and the agent');
        const tx = unescape(/name="tx" value="([^"]+)"/.exec(page)[1]);
        assert.strictEqual((await post('/oauth/device', { tx, decision: 'allow' }, { cookie: session('kim-b') })).status, 403, 'no Origin');
        assert.strictEqual((await post('/oauth/device', { tx, decision: 'allow' }, { cookie: session('lee'), origin: site })).status, 400, 'someone else signed in');
        assert.match(await (await post('/oauth/device', { tx, decision: 'allow' }, { cookie: session('kim-b'), origin: site })).text(), /Connected/);
        const tok = await poll(d.device_code);
        assert.match(tok.access_token, /^swuk_/);
        assert.strictEqual(tok.refresh_token, undefined);
        assert.strictEqual((await poll(d.device_code)).error, 'expired_token', 'one token, once');

        const call = async (t, name, args = {}) => {
            const r = await go('/mcp', { method: 'POST', token: t, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
            if (r.status !== 200) {
                return { status: r.status };
            }
            const j = (await r.json()).result;
            return { error: !!j.isError, value: j.isError ? j.content[0].text : JSON.parse(j.content[0].text) };
        };
        const me = (await call(tok.access_token, 'whoami')).value;
        assert.deepStrictEqual([me.login, me.competitor, me.app], ['kim-b', 'kim_b_sprite', 'Sprite one']);
        const bot = { kind: 'js', note: 'from the agent', files: { 'bot.js': "require('./stdio').serve({ decide: (m) => ({ t: 'act', i: 0 }) });" } };
        assert.strictEqual((await call(tok.access_token, 'arena_submit', bot)).value.name, 'kim_b_sprite', 'its competitor by default');
        assert.match((await call(tok.access_token, 'arena_submit', { ...bot, name: 'kim_b' })).value, /submits only as kim_b_sprite/);
        // the person's own app sees everything of theirs; the agent only its competitor's submissions
        const kim = await mcpToken(w, go, 'kim-b');
        assert.strictEqual((await call(kim, 'arena_submit', bot)).value.name, 'kim_b');
        assert.deepStrictEqual((await call(tok.access_token, 'arena_my_submissions')).value.map((x) => x.name), ['kim_b_sprite']);
        assert.deepStrictEqual((await call(kim, 'arena_my_submissions')).value.map((x) => x.name).sort(), ['kim_b', 'kim_b_sprite']);

        // names: never another person's builder name or competitor (checked when the person answers)
        for (const name of ['lee', 'kim_b_old']) {
            const x = await start(name);
            assert.strictEqual((await consent(x.user_code, session('kim-b'))).status, 403, name);
        }
        // a denied link gives nothing
        const no = await start('kim_b_other');
        assert.match(await (await answer(no.user_code, 'deny')).text(), /Denied/);
        assert.strictEqual((await poll(no.device_code)).error, 'access_denied');

        // the agent shows on the person's Build a bot page; connecting the same name again ends the old token
        const apps = (await (await go('/api/apps', { cookie: session('kim-b') })).json()).result.apps;
        assert.deepStrictEqual(apps.filter((a) => a.agent).map((a) => [a.app, a.site]), [['Sprite one', 'submits as kim_b_sprite']]);
        const again = await start('kim_b_sprite', 'Sprite one, again');
        await answer(again.user_code, 'allow');
        const tok2 = await poll(again.device_code);
        assert.strictEqual((await call(tok.access_token, 'whoami')).status, 401, 'the old token for that name is gone');
        assert.strictEqual((await call(tok2.access_token, 'whoami')).value.competitor, 'kim_b_sprite');
        const id = (await (await go('/api/apps', { cookie: session('kim-b') })).json()).result.apps.find((a) => a.agent).id;
        assert.strictEqual((await go('/api/apps', { method: 'POST', cookie: session('kim-b'), origin: site, body: JSON.stringify({ disconnect: id }) })).status, 200);
        assert.strictEqual((await call(tok2.access_token, 'whoami')).status, 401, 'disconnected on the Build a bot page');
    } finally {
        await close();
    }
});

test('mcp oauth: a person connects their MCP client with GitHub sign-in, reads as themselves, and can disconnect it', async () => {
    const crypto = require('crypto');
    const w = makeWindow('w-oauth');
    const { go, close } = await serve(w);
    try {
        const site = 'https://swu-arena.fly.dev';
        const form = (o) => new URLSearchParams(o).toString();
        const post = (p, body, opts = {}) => go(p, { method: 'POST', body: form(body), type: 'application/x-www-form-urlencoded', ...opts });
        const session = (l) => `swu_session=${w.auth.sign({ l, exp: Date.now() + 60000 })}`;
        w.store.putDoc('admin', 'invites', JSON.stringify({ logins: ['kim-b'] }));
        w.store.putDoc('runs', 'demo', JSON.stringify({ id: 'demo', createdAt: '2026-10-12T00:00:00Z', bots: ['rush'], games: [], owner: 'someone' }));

        // discovery: /mcp says where to sign in, and the server lists its endpoints
        const no = await go('/mcp', { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
        assert.strictEqual(no.status, 401);
        assert.match(no.headers.get('www-authenticate'), /resource_metadata="https:\/\/swu-arena\.fly\.dev\/\.well-known\/oauth-protected-resource"/);
        assert.deepStrictEqual((await (await go('/.well-known/oauth-protected-resource')).json()).authorization_servers, [site]);
        const meta = await (await go('/.well-known/oauth-authorization-server')).json();
        assert.deepStrictEqual([meta.issuer, meta.token_endpoint, meta.code_challenge_methods_supported], [site, `${site}/oauth/token`, ['S256']]);
        assert.strictEqual((await go('/.well-known/openid-configuration')).status, 404, 'a JSON 404, never the sign-in page');

        // the client registers itself; only safe return addresses
        const reg = (uris) => go('/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: 'Claude', redirect_uris: uris }) });
        for (const bad of [[], ['http://evil.example/cb'], ['javascript:alert(1)'], ['https://x.example/cb#frag'], 'https://x']) {
            assert.strictEqual((await reg(bad)).status, 400, JSON.stringify(bad));
        }
        const r1 = await reg(['https://claude.ai/api/mcp/auth_callback', 'http://localhost:33418/callback']);
        assert.strictEqual(r1.status, 201);
        const client = await r1.json();
        assert.strictEqual(client.token_endpoint_auth_method, 'none');

        const verifier = crypto.randomBytes(40).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        const ask = (extra = {}) => `/oauth/authorize?${form({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', resource: `${site}/mcp`, ...extra })}`;
        assert.strictEqual((await go(ask({ redirect_uri: 'https://claude.ai/other' }))).status, 400, 'an address the client never registered gets a page, never a redirect');
        assert.match((await go(ask({ code_challenge_method: 'plain' }))).headers.get('location'), /error=invalid_request/, 'PKCE S256 is required');

        // nobody signed in, or a guest with a view link: sign in with GitHub first, coming back to the same request
        const anon = await (await go(ask())).text();
        assert.match(anon, /Sign in with GitHub/);
        assert.ok(anon.includes(`/auth/github?next=${encodeURIComponent(ask())}`.replace(/&/g, '&#38;')));
        const guest = `swu_session=${w.auth.sign({ v: 'link1', exp: Date.now() + 60000 })}`;
        assert.match(await (await go(ask(), { cookie: guest })).text(), /Sign in with GitHub/);
        assert.strictEqual((await go(ask(), { cookie: session('stranger') })).status, 403, 'signed in, not invited');

        // the consent page: its form carries a signed ticket; only this site's page may answer
        const page = await (await go(ask(), { cookie: session('kim-b') })).text();
        assert.match(page, /Claude<\/b> \(claude\.ai\) wants to use SWU Arena as <b>@kim-b/);
        const tx = /name="tx" value="([^"]+)"/.exec(page)[1].replace(/&#(\d+);/g, (m, c) => String.fromCharCode(c));
        assert.strictEqual((await go('/', { cookie: `swu_session=${tx}` })).status, 200, 'the page itself');
        assert.match(await (await go('/', { cookie: `swu_session=${tx}` })).text(), /Sign in with GitHub/, 'a consent ticket is never a session');
        assert.strictEqual((await post('/oauth/authorize', { tx, decision: 'allow' }, { cookie: session('kim-b') })).status, 403, 'no Origin');
        assert.strictEqual((await post('/oauth/authorize', { tx, decision: 'allow' }, { cookie: session('ericfode'), origin: site })).status, 400, 'someone else signed in');
        const denied = await post('/oauth/authorize', { tx, decision: 'deny' }, { cookie: session('kim-b'), origin: site });
        assert.match(denied.headers.get('location'), /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?error=access_denied.*state=st8/);
        const allowed = await post('/oauth/authorize', { tx, decision: 'allow' }, { cookie: session('kim-b'), origin: site });
        const back = new URL(allowed.headers.get('location'));
        assert.deepStrictEqual([back.origin + back.pathname, back.searchParams.get('state'), back.searchParams.get('iss')], ['https://claude.ai/api/mcp/auth_callback', 'st8', site]);
        const code = back.searchParams.get('code');

        // the code, once, with its verifier
        const exchange = (extra) => post('/oauth/token', { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', resource: `${site}/mcp`, ...extra });
        assert.strictEqual((await (await exchange({ code_verifier: 'x'.repeat(43) })).json()).error, 'invalid_grant', 'wrong verifier');
        assert.strictEqual((await (await exchange({ code_verifier: verifier })).json()).error, 'invalid_grant', 'a code is spent by any try');
        const again = new URL((await post('/oauth/authorize', { tx, decision: 'allow' }, { cookie: session('kim-b'), origin: site })).headers.get('location')).searchParams.get('code');
        const tok = await (await post('/oauth/token', { grant_type: 'authorization_code', code: again, client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier })).json();
        assert.match(tok.access_token, /^swua_/);
        assert.match(tok.refresh_token, /^swur_/);
        assert.strictEqual(tok.expires_in, 3600);

        // MCP with the token: the person's own read tools, scrubbed like any friend's view
        const rpc = async (t, method, params) => (await go('/mcp', { method: 'POST', token: t, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) })).json();
        const init = await rpc(tok.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
        assert.strictEqual(init.result.protocolVersion, '2025-06-18');
        assert.strictEqual((await go('/mcp', { method: 'POST', token: tok.access_token, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' })).status, 202);
        const names = (await rpc(tok.access_token, 'tools/list')).result.tools.map((t) => t.name);
        assert.deepStrictEqual(names, ['whoami', 'arena_status', 'arena_standings', 'arena_report', 'arena_versions', 'arena_panel', 'arena_games', 'window_docs', 'window_replays', 'window_replay',
            'arena_guide', 'arena_submit', 'arena_my_submissions']);
        const call = async (t, name, args = {}) => {
            const r = (await rpc(t, 'tools/call', { name, arguments: args })).result;
            return { error: r.isError, value: JSON.parse(r.content[0].text) };
        };
        assert.deepStrictEqual((await call(tok.access_token, 'whoami')).value, { login: 'kim-b', role: 'friend', app: 'Claude', builder: 'kim_b',
            may: 'read games, replays, standings and research; submit your own bots (arena_guide says how) and follow them (arena_my_submissions)' });
        assert.deepStrictEqual((await call(tok.access_token, 'window_docs', { collection: 'runs', id: 'demo' })).value.owner, undefined, 'scrubbed');
        assert.strictEqual((await call(tok.access_token, 'window_docs', { collection: 'admin', id: 'invites' })).error, true);
        assert.strictEqual((await call(tok.access_token, 'arena_versions', {})).error, true);
        assert.strictEqual((await go('/mcp', { token: tok.access_token })).status, 405, 'no event stream');
        // a game against a person, sent with the person's name: the app never shows it, so neither does the MCP
        w.store.putDoc('runs', 'karabast-x', JSON.stringify({ id: 'karabast-x', createdAt: '2026-10-12T00:00:00Z', bots: ['c-clock'], games: [{ id: 'k1', p1: 'c-clock', p2: 'alice', outcome: 'won', winnerSeat: 'p2', winner: 'alice' }] }));
        w.store.putReplay('karabast-x', 'k1', Buffer.from(`${JSON.stringify({ t: 'header', players: [{ id: 'p1', name: 'p1', bot: 'c-clock' }, { id: 'p2', name: 'alice', bot: 'alice' }] })}\n${JSON.stringify({ t: 'step', state: { players: { p1: { name: 'c-clock' }, p2: { name: 'alice' } } } })}\n`));
        assert.deepStrictEqual((await call(tok.access_token, 'window_replays', { run: 'karabast-x' })).value, [{ id: 'k1', size: null }]);
        const masked = (await call(tok.access_token, 'window_replay', { run: 'karabast-x', game: 'k1' })).value;
        assert.ok(!masked.text.includes('alice') && masked.text.includes('"bot":"a person"') && masked.text.includes('"p2":{"name":"a person"}'), masked.text);
        assert.strictEqual(masked.size, Buffer.byteLength(masked.text));
        assert.ok(!JSON.stringify((await call(tok.access_token, 'window_docs', { collection: 'runs', id: 'karabast-x' })).value).includes('alice'));
        // slices start and end on whole characters, and read one after another they join back into the replay
        w.store.putReplay('demo', 'u1', Buffer.from(`${JSON.stringify({ t: 'header', note: 'Ça, Ünlü, 星' })}\n`));
        let joined = '', at = 0;
        for (let n = 0; n < 40; n++) {
            const s = (await call(tok.access_token, 'window_replay', { run: 'demo', game: 'u1', from: at, length: 3 })).value;
            assert.ok(!s.text.includes('�'), JSON.stringify(s));
            joined += s.text;
            at = s.from + s.length;
            if (at >= s.size) break;
        }
        assert.strictEqual(joined, `${JSON.stringify({ t: 'header', note: 'Ça, Ünlü, 星' })}\n`);
        assert.strictEqual((await call(tok.access_token, 'window_replay', { run: 'demo', game: 'u1', from: 35, length: 1 })).value.text, '星', 'less than one character gives that character');
        // the token reads like a friend and never writes; an admin's token is no admin either
        assert.strictEqual((await go('/api/docs/runs/demo', { method: 'PUT', token: tok.access_token, body: '{}' })).status, 403);
        assert.strictEqual((await go('/api/share', { token: tok.access_token })).status, 403);
        assert.strictEqual((await go('/mcp', { method: 'POST', token: 'push-secret', body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status, 401, 'the project token stays with mcp.js');

        // refresh: a new pair each time; the old refresh token used again ends the grant
        const refresh = (t) => post('/oauth/token', { grant_type: 'refresh_token', refresh_token: t, client_id: client.client_id });
        const tok2 = await (await refresh(tok.refresh_token)).json();
        assert.match(tok2.access_token, /^swua_/);
        assert.strictEqual((await go('/mcp', { method: 'POST', token: tok.access_token, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status, 401, 'the old access token is gone');
        assert.strictEqual((await (await refresh(tok.refresh_token)).json()).error, 'invalid_grant');
        assert.strictEqual((await go('/mcp', { method: 'POST', token: tok2.access_token, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status, 401, 'replay ends the grant');

        // connect once more, then: the Share page lists it and disconnects it; removing the invite cuts it off too
        const fresh = async () => {
            const c = new URL((await post('/oauth/authorize', { tx: /name="tx" value="([^"]+)"/.exec(await (await go(ask(), { cookie: session('kim-b') })).text())[1].replace(/&#(\d+);/g, (m, x) => String.fromCharCode(x)), decision: 'allow' }, { cookie: session('kim-b'), origin: site })).headers.get('location')).searchParams.get('code');
            return (await post('/oauth/token', { grant_type: 'authorization_code', code: c, client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier })).json();
        };
        const tok3 = await fresh();
        const listed = (await (await go('/api/apps', { cookie: session('kim-b') })).json()).result;
        assert.strictEqual(listed.mcp, `${site}/mcp`);
        assert.deepStrictEqual(listed.apps.map((a) => [a.app, a.site]), [['Claude', 'claude.ai']]);
        // the Build a bot page lists what an app can do from the server's own tools: every one, and only submit writes
        const mcpList = (await rpc(tok3.access_token, 'tools/list')).result.tools;
        assert.deepStrictEqual(listed.tools.map((t) => t.name), mcpList.map((t) => t.name));
        assert.deepStrictEqual(listed.tools.filter((t) => !t.readOnly).map((t) => t.name), ['arena_submit']);
        assert.ok(listed.tools.every((t) => t.does && !/\n/.test(t.does)));
        assert.deepStrictEqual((await (await go('/api/apps', { cookie: session('ericfode') })).json()).result.apps, [], 'only your own');
        const drop = (cookie, id, origin = site) => go('/api/apps', { method: 'POST', cookie, origin, body: JSON.stringify({ disconnect: id }) });
        assert.strictEqual((await drop(session('kim-b'), listed.apps[0].id, 'https://evil.example')).status, 403);
        assert.strictEqual((await drop(session('ericfode'), listed.apps[0].id)).status, 404, "not someone else's");
        assert.strictEqual((await drop(session('kim-b'), listed.apps[0].id)).status, 200);
        assert.strictEqual((await go('/mcp', { method: 'POST', token: tok3.access_token, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status, 401);
        const tok4 = await fresh();
        assert.strictEqual((await go('/mcp', { method: 'POST', token: tok4.access_token, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status, 200);
        w.store.putDoc('admin', 'invites', JSON.stringify({ logins: [] }));
        assert.strictEqual((await go('/mcp', { method: 'POST', token: tok4.access_token, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status, 401, 'an invite removed cuts the apps off at once');
        assert.strictEqual((await (await refresh(tok4.refresh_token)).json()).error, 'invalid_grant');
        // revoke answers the same either way
        assert.strictEqual((await post('/oauth/revoke', { token: 'nonsense' })).status, 200);
    } finally {
        await close();
    }
});

test('wakeGamesAt: posts to the games machine without waiting, and does nothing without an address', async () => {
    const calls = [];
    const fetchImpl = (url, opts) => {
        calls.push([url, opts.method]);
        return Promise.resolve({ body: null });
    };
    wakeGamesAt('', { fetchImpl });
    wakeGamesAt(undefined, { fetchImpl });
    assert.strictEqual(calls.length, 0);
    wakeGamesAt('http://swu-arena-games.flycast/wake', { fetchImpl });
    assert.deepStrictEqual(calls, [['http://swu-arena-games.flycast/wake', 'POST']]);
    // a machine that cannot be reached is only logged
    wakeGamesAt('http://nowhere.invalid/wake', { fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')) });
    await new Promise((r) => setTimeout(r, 10));
});
