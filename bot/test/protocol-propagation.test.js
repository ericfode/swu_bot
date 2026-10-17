'use strict';
// Trusted source fixtures verify the policy at runner boundaries without engine
// data, worker threads, submitted programs, or a browser. Private functions are
// exposed only inside the fixture wrapper, leaving production exports unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { AsyncLocalStorage } = require('async_hooks');

const BOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-propagation-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
function load(relative, dependencies, { expose = 'module.exports', process: proc = { env: {}, exit() {}, on() {}, threadCpuUsage: () => ({ user: 0, system: 0 }) } } = {}) {
    const file = path.join(BOT, relative);
    const module = { exports: {} };
    const localRequire = (name) => {
        if (!Object.hasOwn(dependencies, name)) throw new Error(`unexpected dependency in ${relative}: ${name}`);
        return dependencies[name];
    };
    const source = fs.readFileSync(file, 'utf8').replace(/^#![^\n]*\n/, '');
    const wrapper = vm.runInThisContext(`(function(require,module,exports,__dirname,process,setTimeout,performance) {\n${source}\nreturn ${expose};\n})`, { filename: file });
    // Timers used only as cleanup backstops must not keep the fixture alive.
    const timer = (fn, ms) => { const t = setTimeout(fn, ms); if (ms > 100) t.unref(); return t; };
    return wrapper(localRequire, module, module.exports, path.dirname(file), proc, timer, performance);
}
const rawBot = (name) => ({ name, decide() {}, close: async () => undefined, thinkMs: 0 });
const guard = (bot) => bot;
const timingSummary = () => ({ n: 0, ms: 0, p50: 0, p95: 0, max: 0 });
const forfeit = (job, i, kind) => ({ by: `p${i + 1}`, faultKind: kind, winner: [job.p1, job.p2][1 - i], winnerSeat: `p${2 - i}` });
const normalResult = () => ({ seed: 4, steps: 1, outcome: 'won', winner: 'p1', round: 1, ms: 1, requiredProtocol: 2, protocols: { p1: 2, p2: 2 }, events: [] });

test('play-seed sends the checked job policy to its queue and workerData', async () => {
    let received;
    const play = load('arena/play-seed.js', {
        fs, os, path, child_process: { execFileSync() {} }, '../decklists': require('../decklists'),
        '../players': { describeBot: () => ({ kind: 'arena', lang: 'wasm' }) },
        '../game-pool': { async runPool(queue, options) {
            received = { queue, options };
            queue.forEach((g) => options.onResult({ job: g, result: normalResult() }));
        } }
    }, { expose: 'play' });
    const job = { seed: 4, key: null, requiredProtocol: 2, maxSteps: 10, capMs: 1000, hangMs: 2000, gameMs: 3000,
        games: [{ id: 'g', p1: 'a-v1', p2: 'b-v1' }], bots: { 'a-v1': { kind: 'wasm', bundle: 'a'.repeat(64) }, 'b-v1': { kind: 'wasm', bundle: 'b'.repeat(64) } } };
    const r = await play(job, { bundles: tmp, work: path.join(tmp, 'seed') });
    assert.equal(received.queue[0].requiredProtocol, 2);
    assert.equal(received.options.workerData.requiredProtocol, 2);
    assert.deepEqual(r.results[0].result.protocols, { p1: 2, p2: 2 });
});

function threadFixture({ loadFailure = false } = {}) {
    let listener;
    const posts = [];
    const lines = [];
    let given;
    const worker = {
        parentPort: { on: (name, fn) => { if (name === 'message') listener = fn; }, postMessage: (m) => posts.push(m) },
        workerData: { requiredProtocol: 2, maxSteps: 10, capMs: 1000 }
    };
    const control = { set() {}, get: () => ({}), same: () => true, restore() {}, chose() {}, newGame() {} };
    load('ladder-worker.js', {
        fs: { mkdirSync() {}, writeFileSync() {}, appendFileSync: (file, line) => lines.push(JSON.parse(line)) }, path,
        worker_threads: worker,
        async_hooks: { AsyncLocalStorage, createHook: () => ({ enable() {} }) },
        './env': { Env: class {} },
        './match': { timingSummary, async playGame(env, opts) { given = opts; return normalResult(); } },
        './recorder': { snapshot() {} },
        './players': { makeBot(name) { if (loadFailure && name === 'bad') throw new Error('trusted load failure'); return rawBot(name); }, closeBots() {}, describeBot: () => ({ kind: 'arena' }) },
        './stdio': { StdioClient: class {} }, './players/guard': { guard }, './rng': { gameKey() {} },
        './game-pool': { workerControl: () => control, forfeit, PHASE: {} }
    });
    return { async play() { await listener({ id: 'g', seed: 4, p1: loadFailure ? 'bad' : 'a', p2: 'b', replayFile: 'trusted-fixture.jsonl' }); return posts.find((p) => p.result).result; }, lines, options: () => given };
}

test('ladder worker passes required v2 to the match and retains accepted versions in rewritten replay end', async () => {
    const fixture = threadFixture();
    const r = await fixture.play();
    assert.equal(fixture.options().requiredProtocol, 2);
    assert.deepEqual(r.protocols, { p1: 2, p2: 2 });
    assert.equal(fixture.lines.at(-1).requiredProtocol, 2);
    assert.deepEqual(fixture.lines.at(-1).protocols, r.protocols);
});

test('ladder worker load failure records required v2 and no claimed negotiations', async () => {
    const fixture = threadFixture({ loadFailure: true });
    const r = await fixture.play();
    assert.equal(r.requiredProtocol, 2);
    assert.deepEqual(r.protocols, {});
    assert.equal(r.by, 'p1');
    assert.equal(r.faultKind, 'load');
    assert.equal(fixture.options(), undefined);
});

function swarmFixture({ loadFailure = false } = {}) {
    let given;
    const { createReferee } = load('swarm/referee.js', {
        '../env': { Env: class {} },
        '../match': { timingSummary, async playGame(env, opts) { given = opts; return normalResult(); } },
        '../recorder': { snapshot() {} },
        '../players': { makeBot(name) { if (loadFailure && name === 'bad') throw new Error('trusted load failure'); return rawBot(name); }, closeBots() {}, describeBot: () => ({ kind: 'arena' }) },
        '../players/guard': { guard }
    });
    return { ref: createReferee({ maxSteps: 10, capMs: 1000 }), options: () => given };
}

test('browser swarm referee passes required v2 and preserves its protocols in replay end', async () => {
    const fixture = swarmFixture();
    const r = await fixture.ref.play({ id: 'g', seed: 4, p1: 'a', p2: 'b', requiredProtocol: 2 });
    assert.equal(fixture.options().requiredProtocol, 2);
    const last = JSON.parse(r.replay.trim().split('\n').at(-1));
    assert.equal(last.requiredProtocol, 2);
    assert.deepEqual(last.protocols, { p1: 2, p2: 2 });
});

test('browser swarm load failure records required v2 and no claimed negotiations', async () => {
    const fixture = swarmFixture({ loadFailure: true });
    const { result, replay } = await fixture.ref.play({ id: 'g', seed: 4, p1: 'bad', p2: 'b', requiredProtocol: 2 });
    assert.equal(result.requiredProtocol, 2);
    assert.deepEqual(result.protocols, {});
    assert.equal(result.faultKind, 'load');
    assert.equal(replay, null);
    assert.equal(fixture.options(), undefined);
});

const identity = require('../arena/identity');
const BUILD = 'a'.repeat(40);
const CARDS = 'b'.repeat(64);
const CONTEXT = identity.contextFor({ arenaId: 'v2', build: BUILD, cards: CARDS });
const hostJob = () => ({ seed: 4, key: null, requiredProtocol: 2, context: { ...CONTEXT }, maxSteps: 10,
    games: [{ id: 'g', p1: 'a-v1', p2: 'b-v1' }],
    bots: { 'a-v1': { kind: 'wasm', bundle: 'a'.repeat(64) }, 'b-v1': { kind: 'wasm', bundle: 'b'.repeat(64) } } });
function hostFixture({ build = BUILD, cards = CARDS } = {}) {
    let given;
    let creates = 0;
    let unpacks = 0;
    const files = new Map();
    const rt = { files, fs: { mkdirSync() {}, rmSync() {}, writeFileSync: (name, data) => files.set(name, data) }, path, require(name) {
        if (name.endsWith('env.js')) return {};
        if (name.endsWith('identity.js')) return identity;
        if (name.endsWith('play-seed.js')) return { checkJob: (job) => job, checkResolved() {}, gameDecks: () => null };
        if (name.endsWith('referee.js')) return { createReferee: () => {
            creates++;
            return { play: async (job) => { given = job; return { result: normalResult(), replay: `${JSON.stringify({ t: 'end', requiredProtocol: 2, protocols: { p1: 2, p2: 2 } })}\n` }; } };
        } };
        throw new Error(`unexpected runtime module ${name}`);
    } };
    const { createRefereeHost } = load('swarm/referee-host.js', {
        './engine': { createEngineRuntime: () => rt }, './processes': { createSpawn() {} }, './tar': { unpack() { unpacks++; return []; } }
    });
    const host = createRefereeHost({ files, makeWorker() {}, build, cards });
    return { host, given: () => given, creates: () => creates, unpacks: () => unpacks };
}

test('browser swarm host verifies its manifest context and binds exact per-game bundle evidence', async () => {
    const fixture = hostFixture();
    const job = hostJob();
    fixture.host.prepare(job);
    const { result, replay } = await fixture.host.play(job, 'g');
    assert.equal(fixture.given().requiredProtocol, 2);
    assert.deepEqual(result.context, CONTEXT);
    assert.deepEqual(result.bundles, { 'a-v1': 'a'.repeat(64), 'b-v1': 'b'.repeat(64) });
    const end = JSON.parse(replay.trim());
    assert.deepEqual(end.context, result.context);
    assert.deepEqual(end.bundles, result.bundles);
});

test('browser swarm refuses a different or missing trusted manifest before unpacking or creating a referee', async () => {
    for (const options of [{ build: 'c'.repeat(40) }, { cards: 'd'.repeat(64) }, { build: null }]) {
        const fixture = hostFixture(options);
        assert.throws(() => fixture.host.prepare(hostJob()), /swarm job refused: .*comparison context/);
        await assert.rejects(fixture.host.play(hostJob(), 'g'), /swarm job refused: .*comparison context/);
        assert.equal(fixture.unpacks(), 0);
        assert.equal(fixture.creates(), 0);
    }
});

test('browser swarm rechecks job context and verified bundle hashes immediately before play', async () => {
    const fixture = hostFixture();
    const job = hostJob();
    fixture.host.prepare(job);
    await assert.rejects(fixture.host.play({ ...job, context: { ...CONTEXT, runnerRevision: 'other' } }, 'g'), /context differs at runnerRevision/);
    job.bots['a-v1'].bundle = 'c'.repeat(64);
    await assert.rejects(fixture.host.play(job, 'g'), /a-v1 has no verified frozen bundle/);
    assert.equal(fixture.creates(), 0);
});

test('browser swarm leaves legacy jobs without comparison binding unchanged', async () => {
    const fixture = hostFixture({ build: null });
    const job = hostJob();
    delete job.requiredProtocol;
    delete job.context;
    const played = await fixture.host.play(job, 'g');
    assert.equal(Object.hasOwn(played.result, 'context'), false);
    assert.equal(Object.hasOwn(played.result, 'bundles'), false);
    assert.equal(Object.hasOwn(fixture.given(), 'requiredProtocol'), false);
});

test('the browser runtime crypto shim derives the same comparison context as Node', () => {
    const { createRuntime } = require('../swarm/runtime');
    const files = new Map([
        ['/app/node_modules/buffer/package.json', '{"name":"buffer","main":"index.js"}'],
        // The engine pack normally provides the npm Buffer implementation. This
        // fixture uses trusted Node Buffer and exercises the actual crypto shim.
        ['/app/node_modules/buffer/index.js', 'exports.Buffer = global.Buffer;'],
        ['/app/bot/arena/identity.js', fs.readFileSync(path.join(BOT, 'arena/identity.js'), 'utf8')]
    ]);
    const rt = createRuntime({ files, cwd: '/app' });
    const browserIdentity = rt.require('/app/bot/arena/identity.js');
    assert.deepEqual(browserIdentity.contextFor({ arenaId: 'v2', build: BUILD, cards: CARDS }), CONTEXT);
});

test('pool stopped results and synthetic replay ends retain policy without inventing accepted versions', () => {
    const lines = [];
    const stoppedResult = load('game-pool.js', {
        fs: { existsSync: () => true, appendFileSync: (file, line) => lines.push(JSON.parse(line)) }, path,
        worker_threads: {}, child_process: {}, './rng': {}
    }, { expose: 'stoppedResult' });
    const r = stoppedResult({ seed: 4, p1: 'a', p2: 'b', requiredProtocol: 2, replayFile: 'fixture.jsonl' }, { steps: 2, round: 1, think: [1, 1] }, { seat: 1, kind: 'hang', error: 'trusted interrupted fixture', ms: 1 });
    assert.equal(r.requiredProtocol, 2);
    assert.deepEqual(r.protocols, {});
    assert.equal(lines[0].requiredProtocol, 2);
    assert.deepEqual(lines[0].protocols, {});
});
