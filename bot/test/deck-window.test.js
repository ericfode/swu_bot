'use strict';
// Real window HTTP/MCP handling with a fixture bearer identity; submissions remain inert pending documents.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-window-'));
Object.assign(process.env, { ARENA_HOME: path.join(root, 'arena'), ARENA_RESULTS: path.join(root, 'results'), ARENA_DASH: path.join(root, 'dash') });
const { createWindow } = require('../arena/window');
const { createAuth } = require('../arena/auth');
const choices = require('../arena/deck-choice');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture() {
    const dir = fs.mkdtempSync(path.join(root, 'w-'));
    const auth = createAuth({ dir: path.join(dir, 'auth'), env: { ARENA_SIGNIN: 'github', ARENA_PUBLIC_URL: 'https://arena.example' } });
    let wake = 0;
    const w = createWindow({ home: dir, auth, minMs: 0, wakeGames: () => wake++ });
    auth.useBearer((token) => token === 'fixture' ? { login: 'kim', grant: 'kim', app: 'test' } : null);
    const request = async (url, body) => {
        const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
        Object.assign(req, { url, method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' } });
        let response;
        const res = { headersSent: false, writeHead(status) { this.headersSent = true; this.status = status; }, end(text) { response = { status: this.status, json: JSON.parse(String(text)) }; } };
        await w.handle(req, res); assert.ok(response?.json.result, JSON.stringify(response)); return response;
    };
    const rpc = (name, args = {}) => request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const value = (r) => JSON.parse(r.json.result.content[0].text);
    return { w, rpc, value, request, wakes: () => wake };
}
const submission = { kind: 'js', note: 'data-only test, never run', files: { 'bot.js': 'throw new Error("must never execute")' } };

test('hosted and REST discovery expose the same complete deck catalog and submit schema', async () => {
    const f = fixture();
    const listed = await f.request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = listed.json.result.tools;
    const submit = tools.find((t) => t.name === 'arena_submit');
    assert.deepEqual(submit.inputSchema.properties.deck.anyOf, [{ type: 'string' }, { type: 'object' }]);
    assert.ok(!submit.inputSchema.required.includes('deck'));
    const discovery = f.value(await f.rpc('arena_decks'));
    assert.ok(discovery.decks.length > 10);
    assert.deepEqual((await f.request('/api/decks')).json.result, discovery);
    const name = discovery.decks[0].name;
    assert.deepEqual(f.value(await f.rpc('arena_decks', { name })).deck, choices.selection(name));
    assert.equal(f.wakes(), 0, 'discovery is read only');
});

test('explicit selection is normalized and retained in receipt, pending job and private status', async () => {
    const f = fixture(); const name = choices.catalog()[0].metadata.name;
    const r = await f.rpc('arena_submit', { ...submission, deck: name });
    assert.ok(!r.json.result.isError, JSON.stringify(r.json));
    const receipt = f.value(r);
    assert.deepEqual(receipt.deck, choices.selection(name));
    const job = JSON.parse(f.w.store.getDoc('submissions', receipt.id));
    assert.deepEqual(job.deck, choices.selection(name));
    const mine = f.value(await f.rpc('arena_my_submissions'));
    assert.deepEqual(mine[0].deck, job.deck);
    assert.equal(f.wakes(), 1);
});

test('malformed/unknown choices refuse before queue insertion and omission retains old default', async () => {
    const f = fixture();
    for (const deck of ['no-such-deck', { leader: { id: '/private/file' }, base: { id: 'SOR_029' }, deck: [] }]) {
        const r = await f.rpc('arena_submit', { ...submission, deck });
        assert.equal(r.json.result.isError, true);
        assert.equal(f.w.store.listDocs('submissions').length, 0);
        assert.equal(f.wakes(), 0);
    }
    const r = await f.rpc('arena_submit', submission);
    const receipt = f.value(r); const job = JSON.parse(f.w.store.getDoc('submissions', receipt.id));
    assert.ok(!Object.hasOwn(job, 'deck')); assert.ok(!Object.hasOwn(receipt, 'deck'));
    assert.equal(job.state, 'pending');
});
