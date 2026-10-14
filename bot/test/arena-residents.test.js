'use strict';
// The arena's own bots as entries (spec stage 1): resident entries made by house submissions, how they replace the bots
// built into the image one by one, and how they anchor the ratings. No engine or card data needed, except the last test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-residents-test-'));
process.env.ARENA_HOME = path.join(tmp, 'arena');
process.env.ARENA_RESULTS = path.join(tmp, 'results');
process.env.ARENA_DASH = path.join(tmp, 'dash');
process.env.ARENA_SECRET_FILE = path.join(tmp, 'secret');
fs.mkdirSync(process.env.ARENA_DASH, { recursive: true });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { scoreRound, globalElo, allRoundAnchors, lineup, anchorsOf, residentName } = require('../arena/referee');
const { planRound } = require('../arena/gamesctl');
const { HOME, writeJson, readJson, versionsOf } = require('../arena/home');
const { houseDoc } = require('../arena/ops/house-submit');

const BASELINES = ['heuristic', 'rush', 'c-clock-wasm', 'py-clock-wasm'];
const t = { p1: { ms: 5, n: 10, p95: 1 }, p2: { ms: 5, n: 10, p95: 1 } };
const won = (id, p1, p2, winner) => ({ id, p1, p2, outcome: 'won', winner, winnerSeat: winner === p1 ? 'p1' : 'p2', timing: t, rounds: 5 });
const ladderOf = (bots, games) => ({ id: 'arena-r1', status: 'done', config: { bots, firstSeed: 1, gamesPerPair: 2 }, progress: { scheduled: games.length }, games });
const version = (name, code = true) => {
    writeJson(path.join(HOME, 'versions', name, 'SUBMISSION.json'), { name, note: 'n', submittedAt: '2026-10-14T06:00:00.000Z' });
    if (code) {
        fs.writeFileSync(path.join(HOME, 'versions', name, 'bot.js'), 'module.exports = {};\n');
    }
};
function setRoster(agents, baselines = BASELINES) {
    fs.rmSync(path.join(HOME, 'versions'), { recursive: true, force: true });
    writeJson(path.join(HOME, 'roster.json'), { thinkCapMs: 60000, baselines, agents });
}

test('residentName: the entry that replaces each bot built into the image', () => {
    assert.deepStrictEqual(['heuristic', 'rush', 'c-clock-wasm', 'rust-greedy2-wasm', 'node-search-wasm'].map(residentName), ['heuristic', 'rush', 'c_clock', 'rust_greedy2', 'node_search']);
});

test('lineup: a resident with a version takes the place of the built-in bot it replaces, one by one', () => {
    setRoster([{ name: 'kim_b', owner: 'github:kim-b' }, { name: 'heuristic', owner: 'arena', resident: true }, { name: 'c_clock', owner: 'arena', resident: true }, { name: 'rush', owner: 'arena', resident: true }]);
    version('kim_b-v1');
    assert.deepStrictEqual(lineup(), ['kim_b-v1', ...BASELINES], 'residents with no version yet: the built-in bots play');
    version('heuristic-v1');
    version('c_clock-v1');
    assert.deepStrictEqual(lineup(), ['kim_b-v1', 'heuristic-v1', 'c_clock-v1', 'rush', 'py-clock-wasm'], 'no round misses one of the arena\'s own bots');
    assert.deepStrictEqual(anchorsOf(lineup()), ['heuristic-v1', 'c_clock-v1', 'rush', 'py-clock-wasm'], 'the builder\'s bot is no anchor');
    setRoster([{ name: 'heuristic', owner: 'arena', resident: true }], []);
    version('heuristic-v1');
    assert.deepStrictEqual(lineup(), ['heuristic-v1'], 'an image with no built-in bots');
});

test('lineup: a resident whose versions are all withdrawn gives its place back to the built-in bot', () => {
    setRoster([{ name: 'heuristic', owner: 'arena', resident: true, withdrawn: [2] }, { name: 'rush', owner: 'arena', resident: true, withdrawn: [1] }]);
    version('heuristic-v1');
    version('heuristic-v2');
    version('rush-v1');
    assert.deepStrictEqual(lineup(), ['heuristic-v1', 'rush', 'c-clock-wasm', 'py-clock-wasm']);
    const { ownBots } = require('../arena/home');
    assert.deepStrictEqual(ownBots(), lineup(), 'status names the same bots');
});

test('a built-in bot whose name only starts like an entry\'s versions is not that entry\'s', () => {
    setRoster([{ name: 'ismcts', owner: 'arena', resident: true }, { name: 'kim', owner: 'github:kim' }], ['ismcts-vlinear-deck', 'kim-vs']);
    const rd = scoreRound(5, ladderOf(['ismcts-v3', 'ismcts-vlinear-deck', 'kim-v1', 'kim-vs'], [won('g1', 'kim-v1', 'kim-vs', 'kim-v1'), won('g2', 'ismcts-v3', 'ismcts-vlinear-deck', 'ismcts-v3')]));
    assert.deepStrictEqual(Object.fromEntries(rd.bots.map((b) => [b.name, [b.agent, b.resident ?? null]])),
        { 'ismcts-v3': [null, 'ismcts'], 'ismcts-vlinear-deck': [null, null], 'kim-v1': ['kim', null], 'kim-vs': [null, null] });
    assert.strictEqual(rd.leader, 'kim-v1');
});

test('scoreRound: a resident is no builder (never the leader) and anchors the round with the built-in bots left', () => {
    setRoster([{ name: 'kim_b', owner: 'github:kim-b' }, { name: 'heuristic', owner: 'arena', resident: true }]);
    const bots = ['kim_b-v1', 'heuristic-v1', 'rush'];
    const rd = scoreRound(4, ladderOf(bots, [
        won('g1', 'heuristic-v1', 'kim_b-v1', 'heuristic-v1'), won('g2', 'kim_b-v1', 'heuristic-v1', 'heuristic-v1'),
        won('g3', 'kim_b-v1', 'rush', 'kim_b-v1'), won('g4', 'rush', 'kim_b-v1', 'rush'),
        won('g5', 'heuristic-v1', 'rush', 'heuristic-v1'), won('g6', 'rush', 'heuristic-v1', 'rush')
    ]));
    assert.deepStrictEqual(rd.anchors, ['heuristic-v1', 'rush']);
    const row = (n) => rd.bots.find((b) => b.name === n);
    assert.deepStrictEqual([row('heuristic-v1').agent, row('heuristic-v1').resident], [null, 'heuristic']);
    assert.deepStrictEqual([row('kim_b-v1').agent, row('kim_b-v1').resident], ['kim_b', undefined]);
    assert.strictEqual(row('rush').agent, null);
    assert.strictEqual(rd.leader, 'kim_b-v1', 'the best builder leads even below a resident');
    assert.ok(Math.abs((row('heuristic-v1').btElo + row('rush').btElo) / 2 - 1500) <= 1, 'the arena\'s own bots average 1500');
});

test('globalElo: the bots built into the image anchor every round, so a resident\'s new version moves no one', () => {
    setRoster([{ name: 'kim_b', owner: 'github:kim-b' }, { name: 'heuristic', owner: 'arena', resident: true }], []);
    const g = (a, b, score) => ({ a, b, score });
    // a round from before rounds recorded anchors: its bots with no builder are the built-in ones
    const old = { round: 1, bots: [{ name: 'kim_b-v1', agent: 'kim_b' }, { name: 'heuristic', agent: null }, { name: 'rush', agent: null }],
        results: [g('kim_b-v1', 'heuristic', 1), g('heuristic', 'kim_b-v1', 1), g('kim_b-v1', 'rush', 1), g('rush', 'kim_b-v1', 0), g('heuristic', 'rush', 1), g('rush', 'heuristic', 0)] };
    const now = { round: 2, anchors: ['heuristic-v1'], bots: [{ name: 'kim_b-v1', agent: 'kim_b' }, { name: 'heuristic-v1', agent: null, resident: 'heuristic' }],
        results: [g('kim_b-v1', 'heuristic-v1', 1), g('heuristic-v1', 'kim_b-v1', 1)] };
    const next = { round: 3, anchors: ['heuristic-v2'], bots: [{ name: 'kim_b-v1', agent: 'kim_b' }, { name: 'heuristic-v2', agent: null, resident: 'heuristic' }],
        results: [g('kim_b-v1', 'heuristic-v2', 0), g('heuristic-v2', 'kim_b-v1', 1)] };
    assert.deepStrictEqual(allRoundAnchors([old, now, next], []), ['heuristic', 'rush'], 'with roster.baselines empty');
    const elo = globalElo([old, now]);
    assert.ok(Math.abs((elo.heuristic + elo.rush) / 2 - 1500) <= 1, JSON.stringify(elo));
    const later = globalElo([old, now, next]);
    assert.ok(Math.abs((later.heuristic + later.rush) / 2 - 1500) <= 1, JSON.stringify(later));
    // an arena that never had bots built in: its first round's own bots, whatever versions come later
    assert.deepStrictEqual(allRoundAnchors([now, next], []), ['heuristic-v1']);
    assert.deepStrictEqual(allRoundAnchors([], ['rush']), ['rush']);
});

test('planRound: the arena\'s own bots alone are no reason to play', () => {
    setRoster([{ name: 'heuristic', owner: 'arena', resident: true }]);
    version('heuristic-v1');
    const opts = { replayMs: 24 * 3600000, settledSince: 0 };
    assert.deepStrictEqual(planRound(opts), { round: null, why: 'no-competitor' });
    const r = readJson(path.join(HOME, 'roster.json'));
    writeJson(path.join(HOME, 'roster.json'), { ...r, agents: [...r.agents, { name: 'kim_b', owner: 'github:kim-b' }] });
    version('kim_b-v1');
    assert.strictEqual(planRound(opts).why, 'changed');
});

test('register resident: admin only on a hosted arena, no starter, first version v1, listed apart from the builders', () => {
    setRoster([]);
    const { api } = require('../arena/api');
    const r = api.register({ name: 'heuristic', owner: 'arena', resident: true, title: 'heuristic', philosophy: 'one of ours' });
    assert.deepStrictEqual([r.version, typeof r.token], [null, 'string'], 'a built-in name is free for a resident');
    assert.deepStrictEqual(versionsOf('heuristic'), []);
    fs.writeFileSync(path.join(HOME, 'agents', 'heuristic', 'bot.js'), "exports.createBot = (name) => ({ name, decide: () => ({ t: 'act', i: 0 }) });\n");
    assert.strictEqual(api.submit({ name: 'heuristic', note: 'the port', token: r.token }).version, 'heuristic-v1');
    assert.strictEqual(api.submit({ name: 'heuristic', note: 'again', token: r.token }).version, 'heuristic-v2');
    api.register({ name: 'kim_b', start: 'rush' });
    const st = api.status();
    assert.deepStrictEqual(st.competitors.map((c) => [c.name, !!c.resident]), [['heuristic', true], ['kim_b', false]]);
    assert.deepStrictEqual(api.panels().panels.map((p) => p.id), ['arena-kim_b'], 'a resident has no panel');
    assert.throws(() => api.panel({ name: 'heuristic' }), (e) => e.code === 'not_found');
    assert.deepStrictEqual(st.baselines, ['heuristic-v2', 'rush', 'c-clock-wasm', 'py-clock-wasm'], 'status lists the arena\'s own bots in play');
    assert.throws(() => api.register({ name: 'heuristic', owner: 'arena', resident: true }), (e) => e.code === 'conflict');
    assert.throws(() => api.register({ name: 'heuristic', start: 'rush' }), 'a builder cannot take it either');

    const { spawnSync } = require('child_process');
    const hosted = path.join(tmp, 'hosted');
    fs.mkdirSync(path.join(hosted, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(hosted, 'roster.json'), JSON.stringify({ thinkCapMs: 60000, baselines: [], agents: [] }));
    const reg = (args) => JSON.parse(spawnSync(process.execPath, ['-e', `require('./bot/arena/api').call('register', ${JSON.stringify(args)}).then((o) => console.log(JSON.stringify(o)))`], {
        cwd: path.join(__dirname, '..', '..'), encoding: 'utf8',
        env: { ...process.env, ARENA_HOME: hosted, ARENA_AUTH: '1', ARENA_ADMIN_TOKEN: 'adm1n' }
    }).stdout);
    assert.match(reg({ name: 'rush', resident: true, owner: 'arena' }).error?.message ?? '', /only the admin registers a resident/);
    assert.ok(reg({ name: 'rush', resident: true, owner: 'arena', token: 'adm1n' }).result);
    assert.ok(JSON.parse(fs.readFileSync(path.join(hosted, 'roster.json'), 'utf8')).agents.find((a) => a.name === 'rush').resident);
});

test('house-submit: a bundle goes as kind wasm with its binary files in base64, source as js or python', () => {
    const dir = (files) => {
        const d = fs.mkdtempSync(path.join(tmp, 'house-'));
        for (const [p, body] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true });
            fs.writeFileSync(path.join(d, p), body);
        }
        return d;
    };
    const wasm = houseDoc('c_clock', dir({ 'arena.json': '{}', 'bot.wasm': Buffer.from([0, 97, 115, 109]), '.hidden': 'x', '__pycache__/a.pyc': 'x' }), { note: 'built from bot/compiled', now: 0 });
    assert.deepStrictEqual([wasm.owner, wasm.name, wasm.kind, wasm.state, wasm.base64, Object.keys(wasm.files), wasm.entry], ['@arena', 'c_clock', 'wasm', 'pending', ['bot.wasm'], ['arena.json', 'bot.wasm'], undefined]);
    assert.match(wasm.id, /^house\.c_clock\.0[0-9a-f]{4}$/);
    assert.deepStrictEqual(Buffer.from(wasm.files['bot.wasm'], 'base64'), Buffer.from([0, 97, 115, 109]));
    const js = houseDoc('rush', dir({ 'rush.js': 'x', 'common.js': 'y', 'stdio.js': 'z' }), { note: 'the port', entry: 'rush.js' });
    assert.deepStrictEqual([js.kind, js.entry, js.base64], ['js', 'rush.js', undefined]);
    assert.strictEqual(houseDoc('py', dir({ 'main.py': 'x' }), { note: 'n', entry: 'main.py' }).kind, 'python');
    assert.throws(() => houseDoc('rush', dir({ 'rush.js': 'x' }), { note: 'n' }), /no bot\.js/);
    assert.throws(() => houseDoc('rush', dir({ 'bot.js': 'x', 'a.bin': Buffer.from([0, 1]) }), { note: 'n' }), /a\.bin is not text/);
    assert.throws(() => houseDoc('Rush', dir({ 'bot.js': 'x' }), { note: 'n' }), /name/);
    assert.throws(() => houseDoc('rush', dir({ 'bot.js': 'x' }), { note: ' ' }), /--note/);
    assert.throws(() => houseDoc('rush', dir({ 'arena.json': '{}' }), { note: 'n', entry: 'x.js' }), /no --entry/);
});

// the intake's checker as a plain child process, since the scratch arena lives under /tmp, which isolate.sh would replace
process.env.ARENA_INTAKE_NO_ISOLATE = '1';
process.env.ARENA_INTAKE_WORK = path.join(tmp, 'intake-work');

/** A window that holds submissions in memory, with the two calls the intake makes (as in arena.test.js). */
function fakeWindow(docs) {
    return {
        docs,
        request: async (method, p) => {
            const id = decodeURIComponent(p.split('/')[4] ?? '');
            return id ? structuredClone(docs[id] ?? null) : Object.keys(docs).map((k) => ({ id: k }));
        },
        putDoc: async (ns, id, doc) => {
            docs[id] = structuredClone(doc);
        }
    };
}

test('intake: a house submission that names a builder\'s competitor is rejected; a builder cannot take a resident\'s name', async () => {
    setRoster([{ name: 'kim_b', owner: 'github:kim-b' }, { name: 'heuristic', owner: 'arena', resident: true }]);
    const { intakeOnce } = require('../arena/intake');
    const base = { note: 'n', kind: 'js', state: 'pending', submittedAt: '2026-10-14T06:00:00Z', files: { 'bot.js': '' } };
    const w = fakeWindow({ 'house.kim_b.1': { ...base, owner: '@arena', name: 'kim_b' }, 'kim-b.1': { ...base, owner: 'kim-b', name: 'heuristic' } });
    assert.strictEqual(await intakeOnce({ window: w, finished: new Set(), missing: () => null }), 2);
    assert.match(w.docs['house.kim_b.1'].error, /belongs to another competitor/);
    assert.match(w.docs['kim-b.1'].error, /"heuristic" is not yours/);
});

const TOOLS = path.join(__dirname, '..', '..', 'build', 'compiled', '.tools');
const javyReady = fs.existsSync(path.join(TOOLS, 'javy-8.0.0', 'javy')) && require('child_process').spawnSync('python3', ['-c', 'import wasmtime'], { stdio: 'ignore' }).status === 0;

test('intake: a house submission enters a resident under a built-in name, owner arena, versions from v1', { skip: !javyReady && 'needs wasmtime and Javy (bot/compiled/README.md)' }, async () => {
    setRoster([]);
    const { intakeOnce } = require('../arena/intake');
    const js = "const { serve } = require('./stdio');\nserve({ decide: (m) => ({ t: 'act', i: 0 }) });\n";
    const base = { owner: '@arena', name: 'rush', kind: 'js', state: 'pending', submittedAt: '2026-10-14T06:00:00Z' };
    const w = fakeWindow({ 'house.rush.1': { ...base, note: 'the port', entry: 'rush.js', files: { 'rush.js': js } } });
    assert.strictEqual(await intakeOnce({ window: w }), 1);
    assert.deepStrictEqual([w.docs['house.rush.1'].state, w.docs['house.rush.1'].version ?? w.docs['house.rush.1'].error], ['accepted', 'rush-v1']);
    const entry = readJson(path.join(HOME, 'roster.json')).agents.find((a) => a.name === 'rush');
    assert.deepStrictEqual([entry.owner, entry.resident, entry.harness], ['arena', true, null]);
    assert.deepStrictEqual(versionsOf('rush'), [1], 'no starter version');
    assert.strictEqual(readJson(path.join(HOME, 'versions', 'rush-v1', 'bundle', 'arena.json')).build.source, 'an arena house submission');
    w.docs['house.rush.2'] = { ...base, note: 'next', entry: 'rush.js', files: { 'rush.js': `// v2\n${js}` } };
    assert.strictEqual(await intakeOnce({ window: w }), 1);
    assert.strictEqual(w.docs['house.rush.2'].version, 'rush-v2');
    assert.deepStrictEqual(lineup(), ['rush-v2', 'heuristic', 'c-clock-wasm', 'py-clock-wasm']);
});
