'use strict';
// Read-only MCP projection of pushed placement status. All identities, documents and HTTP are local fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'placement-window-'));
Object.assign(process.env, { ARENA_HOME: path.join(tmp, 'arena'), ARENA_RESULTS: path.join(tmp, 'results'), ARENA_DASH: path.join(tmp, 'dash') });
const { createWindow } = require('../arena/window');
const { createAuth } = require('../arena/auth');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fixture() {
    const dir = fs.mkdtempSync(path.join(tmp, 'window-'));
    const auth = createAuth({ dir: path.join(dir, 'auth'), env: { ARENA_SIGNIN: 'github', ARENA_PUBLIC_URL: 'https://arena.example' } });
    const w = createWindow({ home: dir, auth, minMs: 0, wakeGames: () => assert.fail('reads must not wake the games machine') });
    const grants = { kim: { login: 'kim', grant: 'kim', app: 'fixture' }, lee: { login: 'lee', grant: 'lee', app: 'fixture' },
        agent: { login: 'kim', agent: 'kim_fast', grant: 'agent', app: 'fixture' } };
    // Fake only the token lookup; the window and role checks remain the normal HTTP/MCP implementation.
    auth.useBearer((token) => grants[token] ?? null);
    const request = async (url, token, body) => {
        const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
        Object.assign(req, { url, method: body ? 'POST' : 'GET',
            headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) } });
        let response;
        const res = {
            headersSent: false,
            writeHead(status) { this.headersSent = true; this.status = status; },
            end(text) { response = { status: this.status, json: async () => JSON.parse(String(text)) }; }
        };
        await w.handle(req, res);
        return response;
    };
    const submissions = async (token = 'kim') => {
        const res = await request('/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'arena_my_submissions', arguments: {} } });
        assert.equal(res.status, 200);
        const { result } = await res.json();
        assert.equal(!!result.isError, false);
        return JSON.parse(result.content[0].text);
    };
    const put = (doc) => w.store.putDoc('submissions', doc.id, JSON.stringify(doc));
    const status = (placements) => w.store.putDoc('arena', 'status', JSON.stringify({ competitors: [], ...(placements === undefined ? {} : { placements }) }));
    return { w, request, submissions, put, status };
}

const accepted = (id = 'kim.1', extra = {}) => ({ id, owner: 'kim', name: 'kim', state: 'accepted', version: 'kim-v1',
    submittedAt: '2026-01-01T00:00:00.000Z', fileNames: ['bot.js'], placement: { state: 'queued' }, ...extra });
const live = (extra = {}) => ({ version: 'kim-v1', ref: 'window:kim.1', state: 'running', round: 8,
    progress: { finished: 1, rated: 1, scheduled: 4 }, error: null, ...extra });

test('my submissions overlays live progress, failure and completion without rewriting the accepted record', async () => {
    const { w, put, status, submissions } = fixture();
    put(accepted());
    const before = w.store.getDoc('submissions', 'kim.1');
    for (const update of [live(), live({ state: 'held', error: 'worker failed twice' }),
        live({ state: 'complete', progress: { finished: 4, rated: 4, scheduled: 4 } })]) {
        status([update]);
        const mine = await submissions();
        assert.deepEqual(mine[0].placement, update);
        assert.equal(mine[0].state, 'accepted');
        assert.equal(mine[0].version, 'kim-v1');
        assert.equal(w.store.getDoc('submissions', 'kim.1'), before, 'projection never writes the intake record');
    }
});

test('live placement matches both version and submission ref, applies only to accepted records, and tolerates old status', async () => {
    const { put, status, submissions } = fixture();
    put(accepted());
    put(accepted('kim.pending', { state: 'pending', files: { 'bot.js': 'never executed' }, base64: ['bot.js'] }));
    put(accepted('kim.rejected', { state: 'rejected', error: 'start check failed' }));
    status([live({ ref: 'window:some-other-submission' }), live({ version: 'kim-v2' }), null, 1,
        live({ ref: 'window:kim.pending' }), live({ ref: 'window:kim.rejected' })]);
    const mine = await submissions();
    assert.equal(mine.length, 3);
    for (const doc of mine) assert.deepEqual(doc.placement, { state: 'queued' }, 'mismatch or nonaccepted state keeps the stored snapshot');
    const pending = mine.find((doc) => doc.state === 'pending');
    assert.equal(pending.files, undefined);
    assert.equal(pending.base64, undefined);
    assert.deepEqual(pending.fileNames, ['bot.js']);
    for (const oldStatus of [undefined, null, {}]) {
        status(oldStatus);
        assert.deepEqual((await submissions()).find((doc) => doc.id === 'kim.1').placement, { state: 'queued' });
    }
});

test('live progress preserves owner and agent scoping and grants no access to raw submission documents', async () => {
    const { put, status, submissions, request } = fixture();
    put(accepted());
    put(accepted('kim.fast', { name: 'kim_fast', version: 'kim_fast-v1' }));
    put(accepted('lee.1', { owner: 'lee', name: 'lee', version: 'lee-v1' }));
    status([live(), live({ version: 'kim_fast-v1', ref: 'window:kim.fast' }), live({ version: 'lee-v1', ref: 'window:lee.1' })]);
    assert.deepEqual((await submissions()).map((doc) => doc.id).sort(), ['kim.1', 'kim.fast']);
    assert.deepEqual((await submissions('agent')).map((doc) => doc.id), ['kim.fast']);
    assert.deepEqual((await submissions('lee')).map((doc) => doc.id), ['lee.1']);
    assert.equal((await request('/api/docs/submissions/lee.1', 'kim')).status, 403);
    assert.equal((await request('/api/docs/submissions/kim.1', 'agent')).status, 403);
});
