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
const { checkJob, residentsHere, gameDecks, Refused } = require('../arena/play-seed');
const { gameKey } = require('../rng');
const { checkDone } = require('../remote-lane');
const { normalizeDeck } = require('../decklists');

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
// the tournament lists, as the lane sends them (decklists.js normalizeDeck), and a job that deals two of them by seat
const LISTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'bot', 'decks', 'ash-meta-2026-09.json'), 'utf8')).map(normalizeDeck);
const deckJob = (change = {}) => job({ decks: [LISTS[3], LISTS[8]], games: job().games.map((g) => ({ ...g, decks: [0, 1] })), ...change });
// the job as the helper's coordinator writes it: Elixir's Jason sorts the keys of every object
const sortedKeys = (x) => (Array.isArray(x) ? x.map(sortedKeys) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortedKeys(x[k])])) : x);

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

test('checkJob takes a seed of deck lists only whole: the lists as the lane sends them and two of them per game', () => {
    const bundles = path.join(tmp, 'check-bundles');
    assert.ok(checkJob(deckJob(), bundles));
    assert.ok(checkJob(sortedKeys(deckJob()), bundles), 'its keys sorted, as the coordinator writes it');
    assert.ok(checkJob(deckJob({ decks: [LISTS[3], LISTS[8], LISTS[9]], games: [{ ...pair('heuristic', 'rush')[0], decks: [2, 0] }] }), bundles), 'any two of the lists');
    const games = deckJob().games;
    const refused = {
        'lists without decks on the games': { games: job().games },
        'decks on the games without lists': { decks: undefined },
        'one game without its decks': { games: [games[0], job().games[1]] },
        'an index past the lists': { games: [{ ...games[0], decks: [0, 2] }, games[1]] },
        'one deck for a game': { games: [{ ...games[0], decks: [0] }, games[1]] },
        'an index that is not a whole number': { games: [{ ...games[0], decks: [0, 0.5] }, games[1]] },
        'no lists': { decks: [] },
        'too many lists': { decks: Array.from({ length: 17 }, () => LISTS[0]) },
        'a list that is not one': { decks: ['admiral-piett_jtl_blue', LISTS[8]] },
        'a list with an unpadded id': { decks: [{ ...LISTS[3], base: { id: 'SOR_29', count: 1 } }, LISTS[8]] },
        'a list with more in its metadata': { decks: [{ ...LISTS[3], metadata: { ...LISTS[3].metadata, author: 'someone' } }, LISTS[8]] },
        'a list with a sideboard': { decks: [{ ...LISTS[3], sideboard: [] }, LISTS[8]] }
    };
    for (const [why, change] of Object.entries(refused)) {
        const doc = deckJob(change);
        if (change.decks === undefined && 'decks' in change) {
            delete doc.decks;
        }
        assert.throws(() => checkJob(doc, bundles), Refused, why);
    }
    // the decks a game plays are copies: nothing the engine does to them reaches the job
    const j = deckJob();
    const d = gameDecks(j, j.games[1]);
    assert.deepStrictEqual(d, { p1: LISTS[3], p2: LISTS[8] });
    d.p1.deck.length = 0;
    assert.ok(j.decks[0].deck.length > 0);
    const s = sortedKeys(j);
    assert.strictEqual(JSON.stringify(gameDecks(s, s.games[0])), JSON.stringify({ p1: LISTS[3], p2: LISTS[8] }), 'keys back in the lists\' own order');
    assert.strictEqual(gameDecks(job(), job().games[0]), null);
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

test('play-seed plays a seed of deck lists by seat, as the games machine plays it', { skip: !ENGINE && 'engine or card data not built', timeout: 600000 }, async () => {
    // the games machine's ladder holds all the lists and indexes into them; the job carries the seed's two
    const machine = [LISTS[0], LISTS[3], LISTS[5], LISTS[8]];
    const at = [1, 3];
    // written as the helper's coordinator writes it; the replays still match the games machine's line for line
    const r = run(sortedKeys(deckJob()));
    assert.strictEqual(r.code, 0, r.err.slice(-5).join('\n'));
    const doc = JSON.parse(r.out);
    const replays = Object.fromEntries(Object.entries(doc.replays).map(([id, f]) => [id, fs.readFileSync(f, 'utf8')]));
    const games = job().games.map((g) => ({ ...g, decks: at }));
    assert.strictEqual(checkDone(games, { results: doc.results, replays }, { seed: 11, key: KEY, decks: machine }), null);
    for (const { id } of doc.results) {
        const head = JSON.parse(replays[id].split('\n')[0]);
        assert.deepStrictEqual(head.decks, { p1: LISTS[3], p2: LISTS[8] }, `${id}: each seat plays its list`);
        assert.deepStrictEqual(head.players.map((p) => p.deck), [LISTS[3].metadata.name, LISTS[8].metadata.name]);
    }
    // a replay that names other decks does not pass, nor does one for a seed of random decks
    const swapped = { ...LISTS[8], metadata: LISTS[3].metadata };
    assert.match(checkDone(games, { results: doc.results, replays }, { seed: 11, key: KEY, decks: [LISTS[0], swapped, LISTS[5], LISTS[3]] }), /names other decks/);
    assert.match(checkDone(games, { results: doc.results, replays }, { seed: 11, key: KEY, decks: null }), /names other decks/);
    // the same games on the games machine's own workers (ladder.js: the run's lists, indices into them)
    const { runPool } = require('../game-pool');
    const here = new Map();
    const dir = fs.mkdtempSync(path.join(tmp, 'machine-'));
    await runPool(games.map((g) => ({ ...g, seed: 11, key: KEY, replayFile: path.join(dir, `${g.id}.jsonl`) })), {
        workers: 2, hangMs: 150000,
        workerData: { maxSteps: 6000, engineRev: null, capMs: 60000, key: null, decks: machine, pool: null },
        onResult: ({ job: g, result }) => here.set(g.id, result)
    });
    for (const { id, result } of doc.results) {
        const m = here.get(id);
        assert.deepStrictEqual([result.outcome, result.winner, result.winnerSeat, result.steps, result.round], [m.outcome, m.winner, m.winnerSeat, m.steps, m.round], id);
        const lines = (t) => t.trim().split('\n').slice(0, -1);
        assert.deepStrictEqual(lines(replays[id]), lines(fs.readFileSync(path.join(dir, `${id}.jsonl`), 'utf8')), `${id}: the same game, board by board`);
    }
    require('../game-pool').killChildren(null);
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

test('play-seed --warm compiles the residents this image builds, and names none it does not', { skip: !WASMTIME && 'no wasmtime' }, () => {
    const r = run(null, { args: ['--warm'] });
    assert.strictEqual(r.code, 0, r.err.join('\n'));
    const doc = JSON.parse(r.out);
    assert.deepStrictEqual(Object.keys(doc), ['ok', 'warmed', 'failed']);
    assert.strictEqual(doc.ok, true);
    assert.deepStrictEqual([...doc.warmed, ...doc.failed.map((f) => f.name)].sort(), [...residentsHere()].sort(), 'an image without their bundles warms nothing and fails nothing');
    for (const f of doc.failed) {
        assert.deepStrictEqual(Object.keys(f), ['name', 'error']);
        assert.strictEqual(typeof f.error, 'string');
    }
    assert.deepStrictEqual(doc.warmed, residentsHere(), 'every built resident compiles');
});
