'use strict';
// The browser swarm's runtime must play the same game as Node: a pack of this checkout (bot/swarm/pack.js), the engine
// loaded from it in memory (bot/swarm/engine.js), heuristic vs rush on a keyed deal, replay compared line by line.
// Needs the engine build and card data (forceteki/build, forceteki/test/json); skipped without them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const built = fs.existsSync(path.join(ROOT, 'forceteki', 'build', 'server', 'game', 'core', 'Game.js')) && fs.existsSync(path.join(ROOT, 'forceteki', 'test', 'json'));

async function play(req) {
    const { Env } = req('bot/env.js');
    const { playGame } = req('bot/match.js');
    const players = req('bot/players/index.js');
    const { snapshot } = req('bot/recorder.js');
    const lines = [];
    const r = await playGame(new Env(), { seed: 11, bots: [players.makeBot('heuristic', []), players.makeBot('rush', [])], key: 'a'.repeat(64), maxSteps: 3000, record: true, snapshot, onEvent: (e) => lines.push(JSON.stringify(e)) });
    return { r, lines };
}

// one pack of this checkout for every test here, removed when they are done
let packed = null;
function packOnce() {
    if (!packed) {
        const { pack } = require('../swarm/pack');
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-pack-'));
        process.on('exit', () => fs.rmSync(out, { recursive: true, force: true }));
        pack({ root: ROOT, out });
        packed = out;
    }
    return packed;
}

test('a game under the swarm runtime is the same game as in Node', { skip: !built && 'no engine build here', timeout: 300000 }, async () => {
    const { filesOf } = require('../swarm/pack');
    const { createEngineRuntime } = require('../swarm/engine');
    const { createRefereeHost } = require('../swarm/referee-host');
    const out = packOnce();
    {
        const native = await play((p) => require(path.join(ROOT, p)));
        const files = filesOf(JSON.parse(fs.readFileSync(path.join(out, 'engine.json'), 'utf8')));
        const rt = createEngineRuntime({ files });
        const swarm = await play((p) => rt.require(`/app/${p}`));
        assert.strictEqual(swarm.r.outcome, native.r.outcome);
        assert.strictEqual(swarm.lines.length, native.lines.length);
        swarm.lines.forEach((l, i) => assert.strictEqual(l, native.lines[i], `replay line ${i}`));

        // a seed of deck lists (rated rounds deal the tournament lists by seat): the swarm's referee plays the lists
        // the job gives, the same game as Node plays on them
        const { normalizeDeck } = require('../decklists');
        const lists = JSON.parse(fs.readFileSync(path.join(ROOT, 'bot', 'decks', 'ash-meta-2026-09.json'), 'utf8')).map(normalizeDeck);
        const job = {
            v: 1, seed: 11, key: 'b'.repeat(64), maxSteps: 3000, capMs: 60000, hangMs: 150000, gameMs: 840000, decks: [lists[2], lists[7]],
            games: [{ id: 'rush-vs-heuristic-11', p1: 'rush', p2: 'heuristic', decks: [0, 1] }], bots: { heuristic: { kind: 'resident' }, rush: { kind: 'resident' } }
        };
        const host = createRefereeHost({ files: filesOf(JSON.parse(fs.readFileSync(path.join(out, 'engine.json'), 'utf8'))), makeWorker: () => assert.fail('no bot program here') });
        host.prepare(job);
        const { result, replay } = await host.play(job, job.games[0].id);
        const head = JSON.parse(replay.split('\n')[0]);
        assert.deepStrictEqual(head.decks, { p1: lists[2], p2: lists[7] });
        const { Env } = require('../env');
        const { playGame } = require('../match');
        const players = require('../players');
        const { snapshot } = require('../recorder');
        const lines = [];
        const r = await playGame(new Env(), { seed: 11, bots: [players.makeBot('rush', []), players.makeBot('heuristic', [])], decks: { p1: structuredClone(lists[2]), p2: structuredClone(lists[7]) }, key: job.key, maxSteps: 3000, record: true, snapshot, onEvent: (e) => lines.push(JSON.stringify(e)) });
        assert.deepStrictEqual([result.outcome, result.steps, result.winnerSeat], [r.outcome, r.steps, r.winner]);
        assert.deepStrictEqual(replay.trim().split('\n').slice(0, -1), lines.slice(0, -1), 'the same game, board by board');
        host.close();
    }
});

/** A person who answers every decision with a pick of `rng`, through `act` (and the referee's own split). */
function scriptedPerson(act, rng) {
    return (m) => {
        if (m.t === 'decide') {
            setImmediate(() => {
                const i = Math.floor(rng() * m.actions.length);
                assert.strictEqual(act({ t: 'act', seq: m.seq, i }), null);
            });
        }
    };
}

test('the play page\'s worker: a person against the JEPA bot in the browser runtime is the same game as in Node', { skip: !built && 'no engine build here', timeout: 300000 }, async () => {
    const vm = require('vm');
    const { webcrypto } = require('crypto');
    const { build } = require('../swarm/build');
    const { seededRng } = require('../rng');
    const out = packOnce();
    build(out);
    const deck = 'darth-vader_jtl_yellow';
    const seed = 7;
    const key = 'c'.repeat(64);
    // Node: the table host as serve.js and the tests run it
    const { createTableHost } = require('../table/host');
    let node = null;
    const nodeHost = createTableHost({ send: (m) => node?.(m) });
    node = scriptedPerson((a) => nodeHost.act(a), seededRng(seed));
    nodeHost.start({ deck, seed, key });
    const native = await nodeHost.done;
    // the worker: play-worker.js as a browser runs it (self, postMessage, fetch of the pack), here in a fresh context
    // whose seed and key are the ones above
    const sent = [];
    let onSent = () => undefined;
    const self = { postMessage: (m) => (sent.push(m), onSent(m)) };
    const ctx = vm.createContext({
        self, console, performance, TextDecoder, TextEncoder, URL, atob, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, structuredClone,
        crypto: { getRandomValues: (a) => (a.set(a.length === 1 ? [seed] : Buffer.from(key, 'hex')), a), randomUUID: () => webcrypto.randomUUID() },
        fetch: async () => ({ json: async () => JSON.parse(fs.readFileSync(path.join(out, 'engine.json'), 'utf8')) })
    });
    vm.runInContext(fs.readFileSync(path.join(out, 'play-worker.js'), 'utf8'), ctx);
    const next = (t) => new Promise((resolve) => {
        const hit = sent.find((m) => m.t === t || m.t === 'error');
        if (hit) {
            return resolve(hit);
        }
        onSent = (m) => (m.t === t || m.t === 'error') && resolve(m);
    });
    self.onmessage({ data: { t: 'init', pack: '/play/engine.json', botWorker: '/play/bot-worker.js' } });
    const ready = await next('ready');
    assert.strictEqual(ready.t, 'ready', ready.message);
    // the worker's objects are another realm's, so they are compared as JSON
    assert.strictEqual(JSON.stringify(ready.options.bots), '["jepa-tx-gate"]');
    assert.strictEqual(ready.isolated, false, 'no SharedArrayBuffer here: only the JEPA bot can play');
    // the JEPA bot's models are not in the pack: the page sends them with the first game
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(manifest.models).sort(), ['tx-t10-e.safetensors', 'tx-t10.safetensors']);
    assert.ok(!Object.keys(JSON.parse(fs.readFileSync(path.join(out, 'engine.json'), 'utf8')).files).some((f) => f.endsWith('.safetensors')));
    assert.ok(manifest.sizes['engine.json'] > 0 && manifest.sizes['tx-t10.safetensors'] > 0, 'every file\'s size, for the progress bar');
    self.onmessage({ data: { t: 'start', deck } });
    const refused = await next('refused');
    assert.match(refused.error, /tx-t10|ENOENT|no such file/i, 'no models, no JEPA bot');
    const files = Object.entries(manifest.models).map(([name, p]) => [p, new Uint8Array(fs.readFileSync(path.join(out, name)))]);
    const person = scriptedPerson((a) => {
        self.onmessage({ data: { t: 'act', act: a } });
        return sent.at(-1).t === 'acted' ? sent.at(-1).error : null;
    }, seededRng(seed));
    const ended = new Promise((resolve) => {
        onSent = (m) => {
            if (m.t === 'msg') {
                person(m.msg);
                if (m.msg.t === 'end') {
                    resolve(m.msg);
                }
            }
        };
    });
    self.onmessage({ data: { t: 'start', deck, files } });
    assert.strictEqual(JSON.stringify(sent.find((m) => m.t === 'started')), '{"t":"started","id":"play-00000007","seat":"p1"}');
    const end = await ended;
    assert.strictEqual(end.outcome, native.result.outcome);
    assert.strictEqual(end.replay, native.replay, 'the same game, board by board');
});

const RANDOM_BUNDLE = path.join(ROOT, 'build', 'compiled', 'node-random');
test('the play page\'s worker plays an arena version: a WebAssembly bundle in its own worker, against a person', { skip: (!built || !fs.existsSync(path.join(RANDOM_BUNDLE, 'arena.json'))) && 'no engine build, or no node-random bundle (python3 bot/compiled/build.py)', timeout: 300000 }, async () => {
    const crypto = require('crypto');
    const { Worker } = require('worker_threads');
    const { execFileSync } = require('child_process');
    const { filesOf } = require('../swarm/pack');
    const { createPlayHost } = require('../swarm/play-host');
    const { checkReplay } = require('../arena/play');
    const { seededRng } = require('../rng');
    const out = packOnce();
    // the bundle as the games machine keeps it: its canonical tar, named by its sha256
    const tar = new Uint8Array(execFileSync('python3', [path.join(ROOT, 'bot', 'compiled', 'bundle.py'), 'tar', RANDOM_BUNDLE], { maxBuffer: 256 << 20 }));
    const hex = crypto.createHash('sha256').update(tar).digest('hex');
    let onMsg = () => undefined;
    const host = createPlayHost({
        files: filesOf(JSON.parse(fs.readFileSync(path.join(out, 'engine.json'), 'utf8'))),
        makeWorker: () => new Worker(path.join(ROOT, 'bot', 'swarm', 'bot-worker.js')),
        send: (m) => onMsg(m),
        log: { log: () => undefined, error: () => undefined }
    });
    try {
        const deck = 'darth-vader_jtl_yellow';
        assert.throws(() => host.addBundle('Node Random', hex, tar, 60000), /not an arena version/);
        assert.throws(() => host.addBundle('node_random-v1', hex, tar, 10), /1000 ms or more/);
        assert.throws(() => host.addBundle('node_random-v1', 'f'.repeat(64), tar, 60000), /sha256 is not/);
        assert.throws(() => host.table.start({ bot: 'node_random-v1', deck, seed: 5 }), /no bot node_random-v1 in this tab/);
        assert.strictEqual(host.addBundle('node_random-v1', hex, tar, 60000), 'wasi-p1');
        assert.strictEqual(host.addBundle('node_random-v1', hex, tar, 60000), 'wasi-p1', 'the same bundle again is a no-op');
        onMsg = scriptedPerson((a) => host.table.act(a), seededRng(5));
        assert.deepStrictEqual(host.table.start({ bot: 'node_random-v1', deck, seed: 5, key: 'd'.repeat(64) }), { id: 'play-00000005', seat: 'p1' });
        const { result, replay } = await host.table.done;
        assert.strictEqual(result.outcome, 'won', result.error);
        assert.deepStrictEqual(JSON.parse(replay.split('\n')[0]).players.map((p) => p.bot), ['person', 'node_random-v1']);
        assert.strictEqual(checkReplay(replay).bot, 'node_random-v1', 'the window keeps the game');
    } finally {
        host.close();
    }
});
