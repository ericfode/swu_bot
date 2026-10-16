'use strict';
// Feedback from the window's pages (bot/arena/feedback.js, web/feedback.js, ops/feedback.js): every page gets the
// widget, who may send a note, what is kept, the limits, what the sender reads back, and the project's side.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
Object.assign(process.env, { ARENA_HOME: path.join(tmp, 'arena-home'), ARENA_RESULTS: path.join(tmp, 'arena-results'), ARENA_DASH: path.join(tmp, 'no-dash') });

const { createWindow, Store } = require('../arena/window');
const { createAuth } = require('../arena/auth');
const { createFeedback } = require('../arena/feedback');

const ENV = { ARENA_PUSH_TOKEN: 'push-secret', ARENA_ADMIN_TOKEN: 'admin-secret', ARENA_ADMINS: 'ericfode', ARENA_INVITES: 'pal', GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', ARENA_PUBLIC_URL: 'https://swu-arena.fly.dev' };
const SITE = 'https://swu-arena.fly.dev';
const TAG = '<script src="/feedback.js" defer></script>';

function makeWindow(name, { play, limits } = {}) {
    const home = path.join(tmp, name);
    const store = new Store(home);
    const auth = createAuth({ dir: path.join(home, 'auth'), env: ENV, invites: () => [], links: () => JSON.parse(store.getDoc('admin', 'links') ?? '{"links":[]}').links });
    const app = path.join(tmp, `${name}-app.html`);
    fs.writeFileSync(app, '<!doctype html><title>app</title><header><span data-feedback-slot="searchbtn"></span></header><script>const s = "</body>";</script>');
    return createWindow({ home, auth, app, minMs: 0, wakeGames: () => undefined, ...(play ? { play } : {}), ...(limits ? { feedbackLimits: limits } : {}) });
}

async function serve(w) {
    const srv = http.createServer((req, res) => w.handle(req, res)).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const go = (p, { method = 'GET', token, cookie, body, type = 'application/json', origin } = {}) => fetch(base + p, {
        method, redirect: 'manual', body,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': type } : {}), ...(origin ? { origin } : {}) }
    });
    return { base, go, close: () => new Promise((r) => srv.close(r)) };
}

const session = (w, login) => `swu_session=${w.auth.sign({ l: login, exp: Date.now() + 60000 })}`;

test('inject: the widget goes in once, before </body>, and never inside a script', () => {
    const { inject } = createFeedback({ store: null, origin: SITE });
    assert.strictEqual(inject('<p>x</p></body></html>'), `<p>x</p>${TAG}</body></html>`);
    assert.strictEqual(inject(Buffer.from('<p>x</p>')), `<p>x</p>${TAG}`, 'a page without </body>: at the end');
    assert.strictEqual(inject('<script>a = "</BODY>";</script>'), `<script>a = "</BODY>";</script>${TAG}`, 'a </body> before the last </script> is inside a script');
    assert.strictEqual(inject(`<p>x</p>${TAG}</body>`), `<p>x</p>${TAG}</body>`, 'once');
    assert.strictEqual(inject('<style>/* web/feedback.js */</style>'), `<style>/* web/feedback.js */</style>${TAG}`, 'a page that only names the file still gets it');
});

test('every page the window sends gets the widget; /feedback.js is the widget only for people who may send', async () => {
    const w = makeWindow('pages');
    const { go, close } = await serve(w);
    try {
        const app = await (await go('/', { cookie: session(w, 'pal') })).text();
        assert.strictEqual(app.split('/feedback.js').length, 2, 'the app, once');
        assert.ok(app.endsWith(TAG), 'after the app\'s scripts');
        assert.match(await (await go('/')).text(), /\/feedback\.js/, 'the sign-in page too (its script is empty)');
        const widget = await go('/feedback.js', { cookie: session(w, 'pal') });
        assert.match(widget.headers.get('content-type'), /^text\/javascript/);
        const js = await widget.text();
        assert.match(js, /data-feedback-slot/);
        assert.match(js, /Backquote/);
        new (require('vm').Script)(js); // it parses
        for (const cookie of [undefined, session(w, 'stranger')]) {
            const r = await go('/feedback.js', { cookie });
            assert.strictEqual(r.status, 200);
            assert.doesNotMatch(await r.text(), /Backquote/, 'no widget for someone who may not send');
        }
        assert.doesNotMatch(await (await go('/feedback.js', { token: 'push-secret' })).text(), /Backquote/, 'nor for a token');
        assert.strictEqual((await go('/feedback.js', { method: 'POST', cookie: session(w, 'pal') })).status, 405);
    } finally {
        await close();
    }
});

test('a note: only from a person who may use the site, from its own pages, as JSON; kept with what was on screen', async () => {
    const w = makeWindow('send');
    const { go, close } = await serve(w);
    try {
        const pal = session(w, 'pal');
        const send = (body, opts = {}) => go('/api/feedback', { method: 'POST', cookie: pal, origin: SITE, body: JSON.stringify(body), ...opts });
        const context = { page: { path: '/play', hash: '#/x', title: 'SWU Arena Play' }, viewer: [{ kind: 'play', game: 'g1', step: 12, board: { round: 3 } }] };
        const r = await send({ note: '  The pass button hides behind the hand.\r\nOn my phone.  ', context });
        assert.strictEqual(r.status, 200);
        const { id, state, label } = (await r.json()).result;
        assert.match(id, /^fb-\d{8}-\d{6}-[0-9a-f]{6}$/);
        assert.deepStrictEqual([state, label], ['new', 'Received']);
        const doc = JSON.parse(w.store.getDoc('feedback', id));
        assert.strictEqual(doc.login, 'pal');
        assert.strictEqual(doc.note, 'The pass button hides behind the hand.\nOn my phone.');
        assert.deepStrictEqual(doc.page, { path: '/play', title: 'SWU Arena Play' });
        assert.deepStrictEqual(doc.context, context);
        assert.strictEqual(doc.state, 'new');
        assert.strictEqual(doc.history.length, 1);
        assert.strictEqual((await send({ note: 'no context', context: null })).status, 200);

        // a page elsewhere, a plain form, or anything but a note
        assert.strictEqual((await send({ note: 'x' }, { origin: null })).status, 403);
        assert.strictEqual((await send({ note: 'x' }, { origin: 'https://evil.example' })).status, 403);
        assert.strictEqual((await send({ note: 'x' }, { type: 'text/plain' })).status, 400);
        assert.strictEqual((await go('/api/feedback', { method: 'POST', cookie: pal, origin: SITE, type: 'application/x-www-form-urlencoded', body: 'note=x' })).status, 400);
        assert.strictEqual((await go('/api/feedback', { method: 'POST', cookie: pal, origin: SITE, body: 'not json' })).status, 400);
        assert.strictEqual((await go('/api/feedback', { method: 'POST', cookie: pal, origin: SITE, body: 'null' })).status, 400);
        for (const bad of [{}, { note: '   ' }, { note: 7 }, { note: 'x'.repeat(2001) }, { note: 'a\u0007b' }, { note: 'x', context: [1] }, { note: 'x', context: 'page' }]) {
            assert.strictEqual((await send(bad)).status, 400, JSON.stringify(bad));
        }
        assert.strictEqual((await send({ note: 'x', context: { big: 'x'.repeat(70000) } })).status, 413);
        assert.strictEqual((await send({ note: 'x', context: { big: 'x'.repeat(90000) } })).status, 413, 'over the body limit');

        // who may send: not a stranger (the site is invite-only here), a view link's guest, or a token
        assert.strictEqual((await send({ note: 'x' }, { cookie: session(w, 'stranger') })).status, 403);
        assert.strictEqual((await send({ note: 'x' }, { cookie: undefined })).status, 403);
        w.store.putDoc('admin', 'links', JSON.stringify({ links: [{ id: 'aaaaaaaaaaaa', key: 'k'.repeat(32), label: 'Sam', createdAt: new Date().toISOString() }] }));
        const guest = `swu_session=${w.auth.sign({ v: 'aaaaaaaaaaaa', exp: Date.now() + 60000 })}`;
        assert.strictEqual((await go('/api/app', { cookie: guest })).status, 200, 'the guest reads');
        assert.strictEqual((await send({ note: 'x' }, { cookie: guest })).status, 403, 'but sends no feedback');
        assert.strictEqual((await go('/api/feedback', { method: 'POST', token: 'push-secret', origin: SITE, body: '{"note":"x"}' })).status, 403);
        assert.strictEqual(w.store.listDocs('feedback').length, 2);
    } finally {
        await close();
    }
});

test('with /play open to GitHub, anyone signed in may send; each person and everyone together have a daily limit', async () => {
    const clock = { t: Date.parse('2026-10-16T10:00:00Z') };
    const w = makeWindow('limits', { play: 'github', limits: { now: () => clock.t, perDay: 3, allPerDay: 5 } });
    const { go, close } = await serve(w);
    try {
        const send = (login, note) => go('/api/feedback', { method: 'POST', cookie: session(w, login), origin: SITE, body: JSON.stringify({ note }) });
        assert.match(await (await go('/feedback.js', { cookie: session(w, 'stranger') })).text(), /Backquote/, 'the widget, for anyone who may play');
        for (let i = 0; i < 3; i++) {
            assert.strictEqual((await send('stranger', `note ${i}`)).status, 200);
        }
        const over = await send('stranger', 'one more');
        assert.strictEqual(over.status, 429);
        assert.match((await over.json()).error.message, /at most 3 notes a day/);
        assert.strictEqual((await send('pal', 'a')).status, 200);
        assert.strictEqual((await send('kim', 'b')).status, 200);
        assert.strictEqual((await send('ericfode', 'c')).status, 429, 'everyone together: 5 a day');
        clock.t += 86400e3;
        assert.strictEqual((await send('stranger', 'the next day')).status, 200);

        // the sender reads back their own notes, newest first, with where each is, and nobody else's
        const mine = (await (await go('/api/feedback', { cookie: session(w, 'stranger') })).json()).result;
        assert.strictEqual(mine.may, true);
        assert.deepStrictEqual(mine.notes.map((n) => n.note), ['the next day', 'note 2', 'note 1', 'note 0']);
        assert.deepStrictEqual(Object.keys(mine.notes[0]).sort(), ['at', 'id', 'label', 'note', 'state']);
        const pal = (await (await go('/api/feedback', { cookie: session(w, 'pal') })).json()).result;
        assert.deepStrictEqual(pal.notes.map((n) => n.note), ['a']);
        assert.deepStrictEqual((await (await go('/api/feedback')).json()).result, { may: false, notes: [] });
    } finally {
        await close();
    }
});

test('the project reads notes and moves them along (ops/feedback.js); friends never read them raw', async () => {
    const w = makeWindow('ops');
    const { base, go, close } = await serve(w);
    try {
        const pal = session(w, 'pal');
        const sent = await (await go('/api/feedback', { method: 'POST', cookie: pal, origin: SITE, body: JSON.stringify({ note: 'Undo after a card is played, please', context: { page: { path: '/play' }, viewer: [{ kind: 'play', game: 'play-1', step: 4 }] } }) })).json();
        const id = sent.result.id;
        assert.strictEqual((await go('/api/docs/feedback', { cookie: pal })).status, 403, 'a friend reads only their own, through /api/feedback');
        assert.strictEqual((await go('/api/docs/feedback', { token: 'push-secret' })).status, 200);
        assert.strictEqual((await go('/api/docs/feedback', { cookie: session(w, 'ericfode') })).status, 200, 'Eric reads them');

        Object.assign(process.env, { SWU_WINDOW: base, SWU_WINDOW_TOKEN: 'push-secret' });
        delete require.cache[require.resolve('../arena/push')];
        delete require.cache[require.resolve('../arena/ops/feedback')];
        const ops = require('../arena/ops/feedback');
        const listed = await ops.main(['list']);
        assert.match(listed, new RegExp(`^${id}  new  @pal  /play  \\[play play-1 step 4\\]\\n    Undo after a card is played, please$`));
        assert.deepStrictEqual(JSON.parse(await ops.main(['list', '--json'])).map((d) => d.id), [id]);
        assert.strictEqual(JSON.parse(await ops.main(['show', id])).note, 'Undo after a card is played, please');
        assert.strictEqual(await ops.main(['mark', id, 'working', '--summary', 'Play: undo for a played card', '--link', 'https://claude.ai/code/project/x?thread=y']), `${id}: new -> working`);
        await assert.rejects(ops.main(['mark', id, 'shipped']), /a state/);
        await assert.rejects(ops.main(['mark', id, 'done', '--link', 'javascript:alert(1)']), /https/);
        assert.strictEqual(await ops.main(['list']), 'no new feedback');
        assert.match(await ops.main(['list', '--state', 'open']), new RegExp(`${id}  working`));
        const doc = JSON.parse(w.store.getDoc('feedback', id));
        assert.strictEqual(doc.summary, 'Play: undo for a played card');
        assert.deepStrictEqual(doc.links, ['https://claude.ai/code/project/x?thread=y']);
        assert.deepStrictEqual(doc.history.map((h) => [h.state, h.by]), [['new', 'pal'], ['working', 'claude']]);
        const mine = (await (await go('/api/feedback', { cookie: pal })).json()).result.notes;
        assert.deepStrictEqual(mine.map((n) => [n.state, n.label]), [['working', 'Being worked on']], 'the sender sees where it is, and no more');
    } finally {
        delete process.env.SWU_WINDOW;
        delete process.env.SWU_WINDOW_TOKEN;
        await close();
    }
});
