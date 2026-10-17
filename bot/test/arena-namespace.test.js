'use strict';
// Trusted filesystem fixtures only: no engine, network, WASM runtime or bot process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-namespace-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
Object.assign(process.env, { ARENA_ID: 'v2', ARENA_HOME: path.join(tmp, 'controller'),
    ARENA_RESULTS: path.join(tmp, 'results'), ARENA_DASH: path.join(tmp, 'dash') });
const identity = require('../arena/identity');
const context = identity.contextFor({ arenaId: 'v2', build: 'b'.repeat(40), cards: 'c'.repeat(64) });
identity.comparisonContext = () => context;
const { initialize, candidates, verifyCandidates } = require('../arena/provision');
const { Store, storeReader, createWindow } = require('../arena/window');
const { read: historicalRead } = require('../arena/history');
const { cappedScore, globalElo } = require('../arena/referee');
const { verification } = require('../arena/compatibility');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const base = (name) => path.join(tmp, name);

test('fresh v2 provisioning preserves the historical roster, standings and result bytes', () => {
    const data = base('fresh');
    const historical = { 'arena/roster.json': '{"agents":[{"name":"old"}]}',
        'arena/standings.json': '{"global":{"old":1700}}', 'results/arena-r1/index.json': '{"games":["old-game"]}' };
    for (const [name, text] of Object.entries(historical)) {
        const file = path.join(data, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    }
    const first = initialize({ data, context });
    assert.equal(first.ready, true);
    assert.equal(first.root, path.join(data, 'arenas', 'v2'));
    assert.deepEqual(json(path.join(first.home, 'roster.json')).agents, []);
    assert.deepEqual(json(path.join(first.home, 'standings.json')).rounds, []);
    assert.deepEqual(json(path.join(first.home, 'standings.json')).global, {});
    assert.deepEqual(fs.readdirSync(first.results), []);
    const marker = fs.readFileSync(path.join(first.home, 'ARENA.json'), 'utf8');
    assert.equal(initialize({ data, context }).ready, true);
    assert.equal(fs.readFileSync(path.join(first.home, 'ARENA.json'), 'utf8'), marker);
    for (const [name, text] of Object.entries(historical)) assert.equal(fs.readFileSync(path.join(data, name), 'utf8'), text);
});

test('a verified namespace cannot be relabeled with different or unknown image context', () => {
    const data = base('bound');
    const state = initialize({ data, context });
    const marker = fs.readFileSync(path.join(state.home, 'ARENA.json'), 'utf8');
    for (const next of [null, { ...context, engineRevision: 'd'.repeat(64) }]) {
        assert.throws(() => initialize({ data, context: next }), /another or unavailable comparison context/);
        assert.equal(fs.readFileSync(path.join(state.home, 'ARENA.json'), 'utf8'), marker);
    }
});

test('unknown context is explicitly blocked and only an empty namespace can later acquire context', () => {
    const data = base('pending');
    assert.equal(initialize({ data, context: null }).ready, false);
    assert.equal(initialize({ data, context: null }).ready, false);
    assert.equal(initialize({ data, context }).ready, true);
    const occupied = base('occupied');
    const pending = initialize({ data: occupied, context: null });
    fs.writeFileSync(path.join(pending.results, 'unverified.json'), '{}');
    assert.throws(() => initialize({ data: occupied, context }), /cannot be relabeled/);
    assert.equal(json(path.join(pending.home, 'ARENA.json')).context, null);
});

test('provisioning refuses standings from another comparison context without altering them', () => {
    const data = base('mixed-standings');
    const state = initialize({ data, context });
    const file = path.join(state.home, 'standings.json');
    const mixed = { ...json(file), context: { ...context, runnerRevision: 'another-runner' }, rounds: [{ round: 1 }], global: { old: 1600 } };
    put(file, mixed);
    assert.throws(() => initialize({ data, context }), /context|historical|namespace/);
    assert.deepEqual(json(file), mixed);
});

test('provisioning refuses a symlink namespace and linked metadata without touching targets', () => {
    const data = base('linked-namespace'), victim = base('namespace-target');
    fs.mkdirSync(path.join(data, 'arenas'), { recursive: true }); fs.mkdirSync(victim);
    fs.symlinkSync(victim, path.join(data, 'arenas', 'v2'));
    assert.throws(() => initialize({ data, context }), /not a plain directory/);
    assert.deepEqual(fs.readdirSync(victim), []);
    const plain = initialize({ data: base('linked-metadata'), context });
    const marker = path.join(plain.home, 'ARENA.json'), original = fs.readFileSync(marker, 'utf8');
    fs.linkSync(marker, path.join(plain.home, 'marker-alias'));
    assert.throws(() => initialize({ data: base('linked-metadata'), context }), /not a plain unlinked file/);
    assert.equal(fs.readFileSync(marker, 'utf8'), original);
});

test('v2 documents, queue and replay storage are isolated while identity and research remain shared', () => {
    const dir = base('store'), old = new Store(dir), active = new Store(dir, { arenaId: 'v2' });
    for (const ns of ['arena', 'runs', 'ladders', 'submissions', 'panels', 'bots', 'threads']) {
        old.putDoc(ns, 'same', 'old');
        assert.equal(active.getDoc(ns, 'same'), null, ns);
        active.putDoc(ns, 'same', 'v2');
        assert.equal(old.getDoc(ns, 'same'), 'old', ns);
    }
    for (const ns of ['admin', 'research', 'meta', 'lens', 'feedback']) {
        old.putDoc(ns, 'shared', '{"shared":true}');
        assert.equal(active.getDoc(ns, 'shared'), '{"shared":true}', ns);
    }
    old.putReplay('same-run', 'same-game', Buffer.from('old\n'));
    assert.equal(active.readReplay('same-run', 'same-game'), null);
    active.putReplay('same-run', 'same-game', Buffer.from('v2\n'));
    assert.equal(old.readReplay('same-run', 'same-game').toString(), 'old\n');
    assert.equal(active.readReplay('same-run', 'same-game').toString(), 'v2\n');
});

test('active storeReader never falls back to historical standings, t0 archive, rounds or replays', async () => {
    const dir = base('reader'), old = new Store(dir), active = new Store(dir, { arenaId: 'v2' });
    for (const id of ['standings', 'archive-t0-standings', 'report-1', 'archive-t0-report-1']) old.putDoc('arena', id, '{"historical":true}');
    old.putDoc('runs', 'arena-r1', '{"id":"arena-r1"}'); old.putReplay('arena-r1', 'game', Buffer.from('old\n'));
    const reader = storeReader(active);
    for (const file of ['arena/standings.json', 'arena/archive/t0/standings.json', 'arena/rounds/r1.md',
        'arena/archive/t0/rounds/r1.md', 'results/arena-r1/index.json', 'results/arena-r1/games/game.jsonl']) assert.equal(await reader.text(file), null, file);
    for (const dir of ['results', 'arena/rounds', 'arena/archive/t0/rounds']) assert.deepEqual(await reader.list(dir), []);
});

test('historical records are available only through an explicit historical store reader', () => {
    const dir = base('history'), old = new Store(dir), active = new Store(dir, { arenaId: 'v2' });
    old.putDoc('arena', 'standings', '{"global":{"old":1700}}');
    old.putDoc('arena', 'report-2', '{"round":2}'); old.putDoc('arena', 'report-10', '{"round":10}');
    old.putDoc('arena', 'versions-old', '[{"v":1}]'); old.putDoc('runs', 'old-run', '{"games":[]}');
    old.putReplay('old-run', 'game', Buffer.from('historical\n'));
    assert.equal(historicalRead(active, ['standings']), null);
    assert.deepEqual(historicalRead(old, ['standings']), { global: { old: 1700 } });
    assert.deepEqual(historicalRead(old, ['report']), { round: 10 });
    assert.deepEqual(historicalRead(old, ['report'], { round: '2' }), { round: 2 });
    assert.equal(historicalRead(old, ['report'], { round: '9' }), null);
    assert.deepEqual(historicalRead(old, ['versions', 'old']), [{ v: 1 }]);
    assert.deepEqual(historicalRead(old, ['replays', 'old-run']), ['game']);
    assert.equal(historicalRead(old, ['replays', 'old-run', 'game']).toString(), 'historical\n');
    assert.equal(historicalRead(old, ['submissions']), null);
});

test('v2 scoring rejects missing negotiation in either seat, including a bot fault', () => {
    for (const protocols of [undefined, { p1: 2 }, { p2: 2 }, { p1: 1, p2: 2 }, { p1: 2, p2: '2' }]) {
        for (const outcome of ['won', 'ERROR']) assert.deepEqual(cappedScore({ p1: 'a', p2: 'b', winnerSeat: 'p1', by: 'p2', outcome, requiredProtocol: 2, protocols }), { score: null, forfeit: [false, false] });
    }
    assert.equal(cappedScore({ outcome: 'won', winnerSeat: 'p1', requiredProtocol: 2, protocols: { p1: 2, p2: 2 } }).score, 1);
});

test('global v2 ratings include only rounds with the current verified context and bundle identities', () => {
    const round = (a, changes = {}) => ({ requiredProtocol: 2, context, bots: [{ name: a }, { name: `${a}_other` }],
        bundles: { [a]: 'a'.repeat(64), [`${a}_other`]: 'b'.repeat(64) }, results: [{ a, b: `${a}_other`, score: 1 }], ...changes });
    const rated = globalElo([round('current'), round('old', { context: undefined }), round('mixed', { context: { ...context, engineRevision: 'd'.repeat(64) } }),
        round('v1', { requiredProtocol: 1 }), round('nodigest', { bundles: {} })]);
    assert.deepEqual(Object.keys(rated).sort(), ['current', 'current_other']);
    const saved = identity.comparisonContext;
    try { identity.comparisonContext = () => null; assert.deepEqual(globalElo([round('current')]), {}); }
    finally { identity.comparisonContext = saved; }
});

function sourceFixture(name) {
    const dir = base(name), source = path.join(dir, 'arena'), versions = path.join(source, 'versions');
    const agents = [{ name: 'valid', owner: 'github:fixture' }, { name: 'legacy', owner: 'github:fixture' }];
    put(path.join(source, 'roster.json'), { agents });
    for (const agent of agents) {
        const version = path.join(versions, `${agent.name}-v1`), bundle = path.join(version, 'bundle');
        put(path.join(version, 'SUBMISSION.json'), { bot: { kind: 'wasm' } });
        put(path.join(bundle, 'arena.json'), { schema: 'swu-arena-bot/1', protocol: agent.name === 'valid' ? 2 : 1,
            kind: 'wasm', platform: 'wasm32-wasip1', runtime: 'wasi-p1', run: { cmd: './bot.wasm' } });
        fs.writeFileSync(path.join(bundle, 'bot.wasm'), 'inert fixture bytes; never executed');
    }
    return source;
}

test('candidate planning only identifies canonical bundles and refuses a v1 manifest unchanged', () => {
    const source = sourceFixture('candidate-plan'), oldManifest = path.join(source, 'versions', 'legacy-v1', 'bundle', 'arena.json');
    const before = fs.readFileSync(oldManifest, 'utf8');
    const rows = candidates(source);
    assert.equal(rows[0].status, 'unverified'); assert.match(rows[0].bundleSha256, /^[0-9a-f]{64}$/);
    assert.equal(rows[1].status, 'rejected'); assert.match(rows[1].reason, /manifest protocol must be exactly 2/);
    assert.equal(fs.readFileSync(oldManifest, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(source, 'migration.json')), false);
});

test('candidate verification demands isolated digest-bound checks and valid explicit v2 evidence', async () => {
    const rows = candidates(sourceFixture('candidate-check')), row = rows[0];
    let calls = 0;
    const proof = verification({ negotiatedProtocol: 2 }, row.bundleSha256, 'b'.repeat(40), context);
    for (const [compatibility, ok] of [[proof, true], [undefined, false], [{ ...proof, negotiatedProtocol: 1 }, false],
        [{ ...proof, bundleSha256: '0'.repeat(64) }, false], [{ ...proof, context: undefined }, false]]) {
        const out = await verifyCandidates(rows, { context, check: async (job, options) => {
            calls++; assert.deepEqual(options, { requireIsolation: true, expectedBundleSha256: row.bundleSha256 });
            assert.equal(job.kind, 'wasm'); assert.equal(job.owner, 'fixture'); assert.equal(job.name, 'valid');
            assert.ok(job.files['arena.json']); assert.ok(job.files['bot.wasm']);
            return { ok: true, version: 'valid-v1', compatibility };
        } });
        assert.equal(out[0].status, ok ? 'accepted' : 'rejected'); assert.equal(out[1].status, 'rejected');
        assert.equal(out[0].bundle, undefined); assert.equal(out[0].owner, undefined);
    }
    assert.equal(calls, 5, 'manifest v1 is never passed to a checker');
    fs.appendFileSync(path.join(row.bundle, 'bot.wasm'), 'changed');
    const changed = await verifyCandidates([row], { context, check: async () => { throw new Error('must not be called'); } });
    assert.match(changed[0].reason, /source bundle changed after planning/);
});

async function request(window, url, { method = 'GET', headers = {}, body = '' } = {}) {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, { url, method, headers: { authorization: 'Bearer fixture-token', ...headers } });
    let status, response;
    const res = { writeHead(code) { status = code; }, end(data) { response = data?.toString() ?? ''; } };
    await window.handle(req, res);
    return { status, response, json: () => JSON.parse(response) };
}

test('window requires the v2 scope header for controller data and keeps history read-only without listening', async () => {
    const home = base('http'), old = new Store(home);
    old.putDoc('arena', 'standings', '{"global":{"old":1700}}');
    const { createAuth } = require('../arena/auth');
    const auth = createAuth({ dir: path.join(home, 'auth'), env: { ARENA_PUSH_TOKEN: 'fixture-token',
        ARENA_ADMINS: 'fixture-admin', ARENA_ADMIN_TOKEN: 'fixture-admin-token', ARENA_PUBLIC_URL: 'http://fixture.invalid' } });
    const window = createWindow({ home, arenaId: 'v2', auth, wakeGames() {}, swarm: { route: async () => false } });
    for (const scope of [undefined, 'open']) {
        const out = await request(window, '/api/docs/arena/standings', { headers: scope ? { 'x-swu-arena': scope } : {} });
        assert.equal(out.status, 409); assert.match(out.json().error.message, /x-swu-arena: v2/);
    }
    assert.equal((await request(window, '/api/docs/arena/standings', { headers: { 'x-swu-arena': 'v2' } })).status, 404);
    const written = await request(window, '/api/docs/arena/standings', { method: 'PUT', headers: { 'x-swu-arena': 'v2' }, body: '{"global":{}}' });
    assert.equal(written.status, 200);
    assert.deepEqual(JSON.parse(window.store.getDoc('arena', 'standings')), { global: {} });
    assert.equal((await request(window, '/api/replays/run/game', { method: 'PUT', body: 'must not persist' })).status, 409);
    assert.equal(window.store.hasReplay('run', 'game'), false);
    assert.equal((await request(window, '/api/replays/run/game', { method: 'PUT', headers: { 'x-swu-arena': 'v2' }, body: 'v2 replay\n' })).status, 200);
    assert.equal(old.hasReplay('run', 'game'), false);
    const browser = { authorization: '', cookie: `swu_session=${auth.sign({ l: 'fixture-admin', exp: Date.now() + 60000 })}` };
    const browserDoc = await request(window, '/api/docs/arena/standings', { headers: browser });
    assert.equal(browserDoc.status, 200, 'an admin browser reads active documents without controller headers');
    assert.deepEqual(browserDoc.json().result, { global: {} });
    assert.equal((await request(window, '/api/replays/run/game', { headers: browser })).status, 200,
        'an admin browser reads active replays without controller headers');
    assert.equal((await request(window, '/api/docs/arena/standings', { headers: { authorization: 'Bearer fixture-admin-token' } })).status, 409,
        'admin program credentials still require explicit arena scope');
    assert.equal((await request(window, '/api/docs/research/shared')).status, 404, 'shared research needs no arena scope');
    const history = await request(window, '/api/arenas/open/standings');
    assert.equal(history.status, 200); assert.deepEqual(history.json().result, { global: { old: 1700 } });
    assert.equal((await request(window, '/api/arenas/open/standings', { method: 'PUT', body: '{}' })).status, 501);
    assert.deepEqual(JSON.parse(old.getDoc('arena', 'standings')), { global: { old: 1700 } });
});
