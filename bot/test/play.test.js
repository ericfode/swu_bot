'use strict';
// The window's play page (bot/arena/play.js): who may play in each mode, the page's files from the games machine
// (through the swarm relay, kept on the window's disk), and finished games coming back to the window as a people run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'play-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
Object.assign(process.env, { ARENA_HOME: path.join(tmp, 'arena-home'), ARENA_RESULTS: path.join(tmp, 'arena-results'), ARENA_DASH: path.join(tmp, 'no-dash') });

const { createWindow, Store } = require('../arena/window');
const { createAuth } = require('../arena/auth');
const { createSwarmRelay } = require('../arena/swarm-relay');
const { checkReplay } = require('../arena/play');

const ENV = { ARENA_PUSH_TOKEN: 'push-secret', ARENA_ADMIN_TOKEN: 'admin-secret', ARENA_ADMINS: 'ericfode', ARENA_INVITES: 'pal,pal2', GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', ARENA_PUBLIC_URL: 'https://swu-arena.fly.dev' };
const ORIGIN = 'https://swu-arena.fly.dev';

/** A games machine that is awake (build b1) or asleep (every request fails). */
function machine() {
    const m = { awake: true, asked: [] };
    m.fetchImpl = async (url) => {
        const u = new URL(url);
        m.asked.push(u.pathname);
        if (!m.awake) {
            throw new TypeError('fetch failed');
        }
        const body = u.pathname === '/v1/swarm/manifest.json' ? JSON.stringify({ build: 'b1', cards: 'c1' }) : `// ${u.pathname}`;
        return { status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from(body) };
    };
    return m;
}

function makeWindow(name, { mode, fetchImpl, wake = () => undefined, clock = { t: Date.now() } } = {}) {
    const home = path.join(tmp, name);
    const store = new Store(home);
    let play = null;
    const auth = createAuth({ dir: path.join(home, 'auth'), env: ENV, fetch: fetchImpl, openTo: (n) => play?.(n) ?? false, invites: () => [], links: () => JSON.parse(store.getDoc('admin', 'links') ?? '{"links":[]}').links });
    const m = machine();
    const swarm = createSwarmRelay({ token: 'swarm-secret', machine: 'http://games', cacheDir: path.join(home, 'swarm'), fetchImpl: m.fetchImpl, now: () => clock.t });
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
        assert.deepStrictEqual([info.ready, info.build, info.files], [true, 'b1', { pack: '/play/engine.json?b=b1', worker: '/play/play-worker.js?b=b1' }]);
        const worker = await go('/play/play-worker.js?b=b1', { cookie: pal });
        assert.strictEqual(worker.status, 200);
        assert.strictEqual(await worker.text(), '// /v1/swarm/play-worker.js');
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

        const run = JSON.parse(store.getDoc('runs', 'play'));
        assert.deepStrictEqual([run.feed, run.bots, run.games.length], ['play', ['jepa-tx-gate'], 2]);
        assert.deepStrictEqual(run.games.map((g) => [g.p1, g.p2, g.outcome, g.winnerSeat, g.winner, g.conceded, g.error]),
            [['opponent', 'jepa-tx-gate', 'won', 'p2', 'jepa-tx-gate', false, null], ['opponent', 'jepa-tx-gate', 'won', 'p2', 'jepa-tx-gate', true, null]]);
        assert.ok(!store.getDoc('runs', 'play').includes('pal'), 'the run never names the person');
        assert.deepStrictEqual(JSON.parse(store.getDoc('admin', 'people')).names, { [id]: '@pal', [conceded]: '@pal' });

        // the person reads their own games back; another invited person does not
        const mine = (await (await go('/api/play/info', { cookie: pal })).json()).result;
        assert.deepStrictEqual(mine.games.map((g) => [g.id, g.winner, g.conceded]), [[conceded, 'jepa-tx-gate', true], [id, 'jepa-tx-gate', false]]);
        assert.strictEqual(mine.all, undefined);
        assert.strictEqual(await (await go(`/api/play/games/${id}.jsonl`, { cookie: pal })).text(), replay());
        assert.strictEqual((await go(`/api/play/games/${id}.jsonl`, { cookie: session(w, 'pal2') })).status, 404);
        // Eric sees every game and who played it
        const eric = (await (await go('/api/play/info', { cookie: session(w, 'ericfode') })).json()).result;
        assert.deepStrictEqual(eric.all.map((g) => g.person), ['@pal', '@pal']);
        assert.strictEqual((await go(`/api/play/games/${id}.jsonl`, { cookie: session(w, 'ericfode') })).status, 200);
        // readers of the arena see a people run: "opponent", and "a person" in the replay
        const read = await (await go('/api/docs/runs/play', { cookie: session(w, 'pal2') })).json();
        assert.deepStrictEqual(read.result.games.map((g) => g.p1), ['opponent', 'opponent']);
        assert.match(await (await go(`/replays/play/games/${id}.jsonl`, { cookie: session(w, 'pal2') })).text(), /"bot":"a person"/);
    } finally {
        await close();
    }
});

test('the replay check takes the play worker\'s games and nothing else', () => {
    assert.strictEqual(checkReplay(replay()).steps, 3);
    assert.throws(() => checkReplay(''), /JSON Lines/);
    assert.throws(() => checkReplay(replay({ seed: -1 })), /seed/);
    assert.throws(() => checkReplay(replay().replace('{"t":"step","n":1', '{"t":"header","n":1')), /a step/);
    assert.throws(() => checkReplay(replay().replace('{"t":"step","n":1', '{"t":"step"not-json,"n":1')), /line 3: not a replay event/);
    assert.throws(() => checkReplay(replay().replace('darth-vader_jtl_yellow"}', '<b>"}')), /deck lists/);
});
