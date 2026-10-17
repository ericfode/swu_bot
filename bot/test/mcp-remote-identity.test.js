'use strict';
// Stdio MCP and a trusted fake fetch only: no listener, bot, engine or external request starts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.join(__dirname, '..', '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-remote-identity-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const preload = path.join(root, 'fetch.cjs');
fs.writeFileSync(preload, String.raw`
const fs = require('node:fs'), path = require('node:path');
const calls = [], sizes = new Map();
global.fetch = async (address, options = {}) => {
  const url = new URL(address);
  if (url.origin !== 'https://arena.fixture.invalid') throw new Error('unexpected external address');
  const method = options.method || 'GET';
  const headers = Object.fromEntries(new Headers(options.headers).entries());
  calls.push({ method, path: url.pathname, headers });
  let result = {};
  if (url.pathname === '/api') result = { collections: ['runs'], arena: ['status'] };
  else if (url.pathname.startsWith('/api/replays/')) {
    const parts = url.pathname.split('/');
    if (parts.length === 5 && method === 'PUT') sizes.set(parts[4], Buffer.byteLength(options.body));
    if (parts.length === 4) result = [...sizes].map(([id, size]) => ({ id, size }));
  }
  return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
};
process.on('exit', () => fs.writeFileSync(process.env.FIXTURE_CALLS, JSON.stringify({
  calls, arenaId: require(path.join(process.env.FIXTURE_REPO, 'bot/arena/identity.js')).id
})));
`);

function invoke({ selected, bearer = true, remote = true, fromEnvironment = false } = {}) {
    const dir = fs.mkdtempSync(path.join(root, 'case-'));
    const run = path.join(dir, 'arena-v2-r7');
    fs.mkdirSync(path.join(run, 'games'), { recursive: true });
    fs.writeFileSync(path.join(run, 'index.json'), JSON.stringify({ id: 'arena-v2-r7', games: [{ id: 'game', outcome: 'won' }] }));
    fs.writeFileSync(path.join(run, 'games/game.jsonl'), '{"t":"end","outcome":"won"}\n');
    const callsFile = path.join(dir, 'calls.json');
    const env = { PATH: process.env.PATH, LANG: 'C', TZ: 'UTC', ARENA_HOME: path.join(dir, 'arena'),
        FIXTURE_CALLS: callsFile, FIXTURE_REPO: repo,
        ...(selected ? { ARENA_ID: selected } : {}),
        ...(remote && fromEnvironment ? { ARENA_URL: 'https://arena.fixture.invalid/' } : {}) };
    const tool = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const requests = remote ? [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        tool(2, 'arena_status'),
        tool(3, 'window_docs', { collection: 'runs', id: 'arena-v2-r7' }),
        tool(4, 'window_replays', { run: 'arena-v2-r7' }),
        tool(5, 'window_put_doc', { collection: 'arena', id: 'status', doc: { fixture: true } }),
        tool(6, 'window_put_run', { path: run }),
        tool(7, 'arena_opponents')
    ] : [tool(1, 'arena_local_help')];
    const r = spawnSync(process.execPath, ['--require', preload, path.join(repo, 'bot/arena/mcp.js'),
        ...(remote && !fromEnvironment ? ['--remote', 'https://arena.fixture.invalid/'] : []),
        ...(bearer ? ['--token', 'trusted-fixture-token'] : [])], {
        env, input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n', encoding: 'utf8', timeout: 10000
    });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
    const replies = r.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(replies.length, requests.length, r.stdout);
    for (const reply of replies) assert.ok(!reply.error && !reply.result?.isError, JSON.stringify(reply));
    return { ...JSON.parse(fs.readFileSync(callsFile, 'utf8')), replies };
}

for (const selected of [undefined, 'open']) test(`remote stdio MCP ${selected ?? 'default v2'} scopes reads and uploads together`, () => {
    const { calls, arenaId, replies } = invoke({ selected });
    const expected = selected ?? 'v2';
    assert.equal(arenaId, expected, 'namespace selection happens before api loads identity');
    for (const call of calls) {
        assert.equal(call.headers['x-swu-arena'], expected, `${call.method} ${call.path}`);
        assert.equal(call.headers.authorization, 'Bearer trusted-fixture-token');
    }
    for (const route of ['/api', '/api/status', '/api/docs/runs/arena-v2-r7', '/api/opponents']) {
        assert.ok(calls.some((call) => call.method === 'GET' && call.path === route), route);
    }
    const replayReads = calls.filter((call) => call.method === 'GET' && call.path === '/api/replays/arena-v2-r7');
    assert.equal(replayReads.length, 3, 'explicit replay read, push cache check and post-upload verification all carry identity');
    assert.ok(calls.some((call) => call.method === 'PUT' && call.path === '/api/docs/arena/status'));
    const upload = calls.findIndex((call) => call.method === 'PUT' && call.path === '/api/replays/arena-v2-r7/game');
    assert.ok(upload >= 0);
    assert.ok(calls.slice(upload + 1).some((call) => call.method === 'GET' && call.path === '/api/replays/arena-v2-r7'));
    const uploaded = JSON.parse(replies.find((reply) => reply.id === 6).result.content[0].text);
    assert.equal(uploaded.onWindow, 1);
    assert.deepEqual(uploaded.missing, []);
});

test('remote URL from the environment defaults reads to v2 without a bearer token', () => {
    const { calls, arenaId } = invoke({ bearer: false, fromEnvironment: true });
    assert.equal(arenaId, 'v2');
    for (const call of calls) assert.equal(call.headers['x-swu-arena'], 'v2');
    const docs = calls.find((call) => call.method === 'GET' && call.path === '/api/docs/runs/arena-v2-r7');
    assert.equal(docs.headers.authorization, undefined, 'a bearer header is optional for remote reads');
});

test('local stdio MCP retains the historical open namespace without remote requests', () => {
    const { calls, arenaId } = invoke({ remote: false });
    assert.equal(arenaId, 'open');
    assert.deepEqual(calls, []);
});
