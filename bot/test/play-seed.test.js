'use strict';
// The helper's game runner (bot/arena/play-seed.js): which jobs it refuses, and real games through it. The games need
// the built engine and card data (forceteki/build/server, forceteki/test/json) and, for the WebAssembly version,
// wasmtime; each part is skipped when its piece is missing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { checkJob, residentsHere, RESIDENTS, Refused } = require('../arena/play-seed');
const { gameKey } = require('../rng');
const { checkDone } = require('../remote-lane');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'bot', 'arena', 'play-seed.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'play-seed-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ENGINE = fs.existsSync(path.join(ROOT, 'forceteki', 'build', 'server')) && fs.existsSync(path.join(ROOT, 'forceteki', 'test', 'json'));
const WASMTIME = spawnSync('python3', ['-c', 'import wasmtime'], { stdio: 'ignore' }).status === 0;
const NODE_RANDOM = path.join(ROOT, 'build', 'compiled', 'node-random');
const KEY = gameKey('play-seed-test', 11);

const job = (change = {}) => ({
    v: 1, seed: 11, key: KEY, maxSteps: 6000, capMs: 60000, hangMs: 150000, gameMs: 840000,
    games: [{ id: 'heuristic-vs-rush-11', p1: 'heuristic', p2: 'rush' }, { id: 'rush-vs-heuristic-11', p1: 'rush', p2: 'heuristic' }],
    bots: { heuristic: { kind: 'resident' }, rush: { kind: 'resident' } },
    ...change
});
const pair = (a, b, seed = 11) => [{ id: `${a}-vs-${b}-${seed}`, p1: a, p2: b }, { id: `${b}-vs-${a}-${seed}`, p1: b, p2: a }];

/** Runs play-seed.js with the job in a fresh folder: { code, out (stdout), err (stderr lines), work }. */
function run(doc, { bundles = path.join(tmp, 'no-bundles'), args = null, env = {} } = {}) {
    const dir = fs.mkdtempSync(path.join(tmp, 'run-'));
    const file = path.join(dir, 'job.json');
    fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
    const work = path.join(dir, 'work');
    // nothing from here may reach a window
    const { SWU_WINDOW, ARENA_PUSH_TOKEN, SWU_WINDOW_TOKEN, ...base } = process.env;
    const r = spawnSync(process.execPath, [SCRIPT, ...(args ?? ['--job', file, '--bundles', bundles, '--work', work])], {
        cwd: tmp, encoding: 'utf8', timeout: 300000, env: { ...base, SWU_WASM_CACHE: path.join(tmp, 'wasm-cache'), ...env }
    });
    return { code: r.status, out: r.stdout, err: r.stderr.trim().split('\n'), work };
}

/** A canonical tar of a bundle folder in `dir`, named by its sha256 as the helper stores it; returns the hex. */
function bundleTar(folder, dir) {
    const r = spawnSync('python3', [path.join(ROOT, 'bot', 'compiled', 'bundle.py'), 'tar', folder], { maxBuffer: 80 << 20 });
    assert.strictEqual(r.status, 0, String(r.stderr));
    const hex = crypto.createHash('sha256').update(r.stdout).digest('hex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${hex}.tar`), r.stdout);
    return hex;
}

test('checkJob takes the lane\'s jobs and refuses everything else before anything runs', () => {
    const bundles = path.join(tmp, 'check-bundles');
    fs.mkdirSync(bundles, { recursive: true });
    const hex = 'ab'.repeat(32);
    fs.writeFileSync(path.join(bundles, `${hex}.tar`), 'x');
    assert.ok(checkJob(job(), bundles));
    assert.ok(checkJob(job({ key: null, capMs: null, gameMs: 0 }), bundles), 'no key, no cap, no game limit');
    assert.ok(checkJob(job({ games: pair('kim-v3', 'rush'), bots: { 'kim-v3': { kind: 'wasm', bundle: hex }, rush: { kind: 'resident' } } }), bundles), 'a version with its tar');
    const here = residentsHere();
    if (here.length) {
        assert.ok(checkJob(job({ games: pair(here[0], 'rush'), bots: { [here[0]]: { kind: 'resident' }, rush: { kind: 'resident' } } }), bundles), 'a built resident');
    }
    const refused = {
        'a bot program': { games: pair('kim-v3', 'rush'), bots: { 'kim-v3': { kind: 'stdio' }, rush: { kind: 'resident' } } },
        'a bot.js agent': { games: pair('kim', 'rush'), bots: { kim: { kind: 'resident' } , rush: { kind: 'resident' } } },
        'a bot.js version': { games: pair('kim-v3', 'rush'), bots: { 'kim-v3': { kind: 'resident' }, rush: { kind: 'resident' } } },
        'another bot program': { games: pair('py-random', 'rush'), bots: { 'py-random': { kind: 'resident' }, rush: { kind: 'resident' } } },
        'a resident by its program name': { games: pair('c-clock', 'rush'), bots: { 'c-clock': { kind: 'resident' }, rush: { kind: 'resident' } } },
        'a built-in that is not a resident': { games: pair('random', 'rush'), bots: { random: { kind: 'resident' }, rush: { kind: 'resident' } } },
        'a resident whose bundle is not built': { games: pair('rust-search-wasm', 'rush'), bots: { 'rust-search-wasm': { kind: 'resident' }, rush: { kind: 'resident' } } },
        'a version without its tar': { games: pair('kim-v3', 'rush'), bots: { 'kim-v3': { kind: 'wasm', bundle: 'cd'.repeat(32) }, rush: { kind: 'resident' } } },
        'a version name that is not one': { games: pair('Kim-v3', 'rush'), bots: { 'Kim-v3': { kind: 'wasm', bundle: hex }, rush: { kind: 'resident' } } },
        'a wasm entry with more in it': { games: pair('kim-v3', 'rush'), bots: { 'kim-v3': { kind: 'wasm', bundle: hex, cmd: 'sh' }, rush: { kind: 'resident' } } },
        'a bad bundle id': { games: pair('kim-v3', 'rush'), bots: { 'kim-v3': { kind: 'wasm', bundle: '../x' }, rush: { kind: 'resident' } } },
        'version 2': { v: 2 },
        'a negative seed': { seed: -1 },
        'a seed that is not a number': { seed: '11' },
        'a key that is not a game key': { key: 'run-key' },
        'no step cap': { maxSteps: 0 },
        'a zero cap': { capMs: 0 },
        'no watchdog': { hangMs: undefined },
        'a negative game limit': { gameMs: -1 },
        'no games': { games: [] },
        'nine games': { games: Array.from({ length: 9 }, (_, i) => ({ id: `g${i}`, p1: 'heuristic', p2: 'rush' })) },
        'a game id with a slash': { games: [{ id: '../x', p1: 'heuristic', p2: 'rush' }] },
        'a game id with a leading dot': { games: [{ id: '.x', p1: 'heuristic', p2: 'rush' }] },
        'the same id twice': { games: [{ id: 'g', p1: 'heuristic', p2: 'rush' }, { id: 'g', p1: 'rush', p2: 'heuristic' }] },
        'a game without p2': { games: [{ id: 'g', p1: 'heuristic' }] },
        'a game with more in it': { games: [{ id: 'g', p1: 'heuristic', p2: 'rush', key: 'x' }] },
        'a bot missing from bots': { bots: { heuristic: { kind: 'resident' } } },
        'a bot in bots that plays no game': { bots: { heuristic: { kind: 'resident' }, rush: { kind: 'resident' }, random: { kind: 'resident' } } }
    };
    for (const [why, change] of Object.entries(refused)) {
        assert.throws(() => checkJob(job(change), bundles), Refused, why);
    }
    assert.throws(() => checkJob([job()], bundles), Refused, 'a list');
    assert.throws(() => checkJob(null, bundles), Refused, 'null');
});

test('play-seed: usage and refused jobs exit 2 with the reason last on stderr and nothing on stdout', () => {
    const usage = run(job(), { args: ['--job'] });
    assert.strictEqual(usage.code, 2);
    assert.match(usage.err.at(-1), /^play-seed: usage/);
    assert.strictEqual(usage.out, '');
    for (const [doc, why] of [['{"v":1,', /not JSON/], [job({ v: 2 }), /version 2/], [job({ games: pair('random', 'rush'), bots: { random: { kind: 'resident' }, rush: { kind: 'resident' } } }), /random: not a bot a helper plays/]]) {
        const r = run(doc);
        assert.strictEqual(r.code, 2, r.err.join('\n'));
        assert.match(r.err.at(-1), why);
        assert.strictEqual(r.out, '');
        assert.ok(!fs.existsSync(path.join(r.work, 'out')), 'nothing ran');
    }
});

test('play-seed: a version whose tar does not match its id, or whose name a built-in bot takes, is refused', { skip: !fs.existsSync(NODE_RANDOM) && 'no build/compiled/node-random' }, () => {
    const bundles = path.join(tmp, 'bundles-refuse');
    const hex = bundleTar(NODE_RANDOM, bundles);
    // a tar stored under another bundle's id
    const other = 'ef'.repeat(32);
    fs.copyFileSync(path.join(bundles, `${hex}.tar`), path.join(bundles, `${other}.tar`));
    const wrong = run(job({ games: pair('kim-v1', 'rush'), bots: { 'kim-v1': { kind: 'wasm', bundle: other }, rush: { kind: 'resident' } } }), { bundles });
    assert.strictEqual(wrong.code, 2);
    assert.match(wrong.err.at(-1), /kim-v1: its bundle does not unpack \(error: .*sha256 is not/);
    // random-v1 would play as the built-in random bot (players/index.js matches /^random/ first)
    const named = run(job({ games: pair('random-v1', 'rush'), bots: { 'random-v1': { kind: 'wasm', bundle: hex }, rush: { kind: 'resident' } } }), { bundles });
    assert.strictEqual(named.code, 2);
    assert.match(named.err.at(-1), /random-v1 does not resolve to the bot the job names/);
    assert.strictEqual(named.out, '');
});

test('play-seed plays both games of a seed from the given game key and prints one line', { skip: !ENGINE && 'engine or card data not built' }, () => {
    const r = run(job());
    assert.strictEqual(r.code, 0, r.err.slice(-5).join('\n'));
    assert.strictEqual(r.out.split('\n').length, 2, 'one line and its newline');
    const doc = JSON.parse(r.out);
    assert.strictEqual(doc.ok, true);
    assert.deepStrictEqual(doc.results.map((x) => x.id), ['heuristic-vs-rush-11', 'rush-vs-heuristic-11']);
    for (const { id, result } of doc.results) {
        assert.strictEqual(result.key, KEY, 'dealt from the game key it was given');
        assert.strictEqual(result.seed, 11);
        assert.ok(['won', 'STEP_CAP', 'STUCK', 'ERROR'].includes(result.outcome));
        const file = doc.replays[id];
        assert.strictEqual(file, path.join(r.work, 'out', `${id}.jsonl`));
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        const [p1, p2] = id.split('-vs-');
        assert.strictEqual(lines[0].t, 'header');
        assert.strictEqual(lines[0].seed, 11);
        assert.deepStrictEqual(lines[0].players.map((p) => p.bot), [p1, p2.replace(/-11$/, '')]);
        assert.strictEqual(lines.at(-1).t, 'end');
        assert.strictEqual(lines.at(-1).outcome, result.outcome);
        assert.strictEqual(lines.at(-1).winner, result.winnerSeat);
    }
    // what the helper posts from this passes the ladder's own check of a done lease
    const replays = Object.fromEntries(Object.entries(doc.replays).map(([id, f]) => [id, fs.readFileSync(f, 'utf8')]));
    assert.strictEqual(checkDone(job().games, { results: doc.results, replays }, { seed: 11, key: KEY }), null);
    // one deal for the seed: each seat gets the same deck in both games, whichever bot sits there
    const decks = doc.results.map(({ id }) => JSON.parse(fs.readFileSync(doc.replays[id], 'utf8').split('\n')[0]).players.map((p) => p.deck));
    assert.deepStrictEqual(decks[0], decks[1]);
});

test('play-seed unpacks a WebAssembly version and plays it in the sandbox', { skip: (!ENGINE || !WASMTIME || !fs.existsSync(NODE_RANDOM)) && 'needs the engine, wasmtime and build/compiled/node-random' }, () => {
    const bundles = path.join(tmp, 'bundles-play');
    const hex = bundleTar(NODE_RANDOM, bundles);
    const r = run(job({ key: null, games: pair('kim-v1', 'rush'), bots: { 'kim-v1': { kind: 'wasm', bundle: hex }, rush: { kind: 'resident' } } }), { bundles });
    assert.strictEqual(r.code, 0, r.err.slice(-5).join('\n'));
    const doc = JSON.parse(r.out);
    for (const { result } of doc.results) {
        assert.strictEqual(result.by, null, `nobody broke the game: ${result.error}`);
        assert.ok(!('key' in result), 'no key: dealt from the seed alone');
    }
    const replays = Object.fromEntries(Object.entries(doc.replays).map(([id, f]) => [id, fs.readFileSync(f, 'utf8')]));
    assert.strictEqual(checkDone(pair('kim-v1', 'rush'), { results: doc.results, replays }, { seed: 11, key: null }), null);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(r.work, 'arena', 'versions', 'kim-v1', 'SUBMISSION.json'), 'utf8')), { bot: { kind: 'wasm' } });
    assert.ok(fs.existsSync(path.join(r.work, 'arena', 'versions', 'kim-v1', 'bundle', 'bot.wasm')));
});

test('play-seed --warm prints which residents it compiled and which it could not', { skip: !WASMTIME && 'no wasmtime' }, () => {
    const r = run(null, { args: ['--warm'] });
    assert.strictEqual(r.code, 0, r.err.join('\n'));
    const doc = JSON.parse(r.out);
    assert.deepStrictEqual(Object.keys(doc), ['ok', 'warmed', 'failed']);
    assert.strictEqual(doc.ok, true);
    assert.deepStrictEqual([...doc.warmed, ...doc.failed.map((f) => f.name)].sort(), [...RESIDENTS].sort());
    for (const f of doc.failed) {
        assert.deepStrictEqual(Object.keys(f), ['name', 'error']);
        assert.strictEqual(typeof f.error, 'string');
    }
    assert.deepStrictEqual(doc.warmed, residentsHere(), 'every built resident compiles');
});
