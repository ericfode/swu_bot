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

test("the play page's worker (tables-worker.js): a person against the JEPA bot in the browser runtime is the same game as in Node", { skip: !built && 'no engine build here', timeout: 300000 }, async () => {
    const vm = require('vm');
    const { webcrypto } = require('crypto');
    const { build } = require('../swarm/build');
    const { seededRng } = require('../rng');
    const out = packOnce();
    build(out);
    const seed = 7;
    const key = 'c'.repeat(64);
    const game = { mode: 'bot', bot: 'jepa-tx-gate', deck: 'darth-vader_jtl_yellow', you: 'pl_aaaaaa' };
    // Node: the open host as bot/test/open-table.test.js runs it
    const { createOpenHost } = require('../table/open');
    let node = null;
    const nodeHost = createOpenHost({ send: (m) => node?.(m) });
    node = scriptedPerson((a) => nodeHost.act(a), seededRng(seed));
    nodeHost.start({ ...game, seed, key });
    const native = await nodeHost.done;
    // the worker: tables-worker.js as a browser runs it (self, postMessage, fetch of the pack), here in a fresh context
    // whose seed and key are the ones above
    const sent = [];
    let onSent = () => undefined;
    const self = { postMessage: (m) => (sent.push(m), onSent(m)) };
    const ctx = vm.createContext({
        self, navigator: { hardwareConcurrency: 2 }, console, performance, TextDecoder, TextEncoder, URL, atob, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, structuredClone,
        crypto: { getRandomValues: (a) => (a.set(a.length === 1 ? [seed] : Buffer.from(key, 'hex')), a), randomUUID: () => webcrypto.randomUUID() },
        fetch: async () => ({ json: async () => JSON.parse(fs.readFileSync(path.join(out, 'engine.json'), 'utf8')) })
    });
    vm.runInContext(fs.readFileSync(path.join(out, 'tables-worker.js'), 'utf8'), ctx);
    const next = (t) => new Promise((resolve) => {
        const hit = sent.find((m) => m.t === t || m.t === 'error');
        if (hit) {
            return resolve(hit);
        }
        onSent = (m) => (m.t === t || m.t === 'error') && resolve(m);
    });
    self.onmessage({ data: { t: 'init', pack: '/tables/engine.json', botWorker: '/tables/bot-worker.js' } });
    const ready = await next('ready');
    assert.strictEqual(ready.t, 'ready', ready.message);
    assert.strictEqual(ready.isolated, false, 'no SharedArrayBuffer here: only the JEPA bot can play');
    // the JEPA bot's models are not in the pack: the page sends them with the first game
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(manifest.models).sort(), ['tx-t10-e.safetensors', 'tx-t10.safetensors']);
    assert.ok(!Object.keys(JSON.parse(fs.readFileSync(path.join(out, 'engine.json'), 'utf8')).files).some((f) => f.endsWith('.safetensors')));
    assert.ok(manifest.sizes['engine.json'] > 0 && manifest.sizes['tx-t10.safetensors'] > 0 && manifest.gz['tables-worker.js'] > 0, "every file's size, for the progress bars");
    assert.ok(!('play-worker.js' in manifest.sizes), 'one play page, one page worker');
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
    self.onmessage({ data: { t: 'start', game, files } });
    const started = sent.find((m) => m.t === 'started' || m.t === 'refused');
    assert.strictEqual(started.t, 'started', started.error);
    const end = await ended;
    assert.strictEqual(end.outcome, native.result.outcome);
    assert.strictEqual(end.replay, native.replay, 'the same game, board by board');
});

test("the open tables' worker: two people in the browser runtime play the same game as in Node, and decks are checked there", { skip: !built && 'no engine build here', timeout: 300000 }, async () => {
    const vm = require('vm');
    const { webcrypto } = require('crypto');
    const { build } = require('../swarm/build');
    const { seededRng } = require('../rng');
    const out = packOnce();
    build(out);
    const seed = 6;
    const key = 'd'.repeat(64);
    const game = { mode: 'people', deck: 'darth-vader_jtl_yellow', peerDeck: 'luke-skywalker_jtl_data-vault', you: 'pl_aaaaaa', peer: 'pl_bbbbbb' };
    // Node: the open host as bot/test/open-table.test.js runs it
    const { createOpenHost } = require('../table/open');
    let mine = null;
    let theirs = null;
    const nodeHost = createOpenHost({ send: (m) => mine?.(m), sendPeer: (m) => theirs?.(m) });
    mine = scriptedPerson((a) => nodeHost.act(a), seededRng('me'));
    theirs = scriptedPerson((a) => nodeHost.peerAct(a), seededRng('them'));
    nodeHost.start({ ...game, seed, key });
    const native = await nodeHost.done;
    // the worker, as the tables page runs it: this tab's person (msg) and the linked guest (peer)
    const sent = [];
    let onSent = () => undefined;
    const self = { postMessage: (m) => (sent.push(m), onSent(m)) };
    const ctx = vm.createContext({
        self, navigator: { hardwareConcurrency: 2 }, console, performance, TextDecoder, TextEncoder, URL, atob, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, structuredClone,
        crypto: { getRandomValues: (a) => (a.set(a.length === 1 ? [seed] : Buffer.from(key, 'hex')), a), randomUUID: () => webcrypto.randomUUID() },
        fetch: async () => ({ json: async () => JSON.parse(fs.readFileSync(path.join(out, 'engine.json'), 'utf8')) })
    });
    vm.runInContext(fs.readFileSync(path.join(out, 'tables-worker.js'), 'utf8'), ctx);
    self.onmessage({ data: { t: 'init', pack: '/tables/engine.json', botWorker: '/tables/bot-worker.js' } });
    const ready = await new Promise((resolve) => {
        onSent = (m) => (m.t === 'ready' || m.t === 'error') && resolve(m);
    });
    assert.strictEqual(ready.t, 'ready', ready.message);
    assert.ok(ready.options.decks.length > 10);
    assert.strictEqual(ready.isolated, false);
    // a deck list as SWUDB exports it is checked against the pack's card data; a broken one says why
    const vader = JSON.parse(fs.readFileSync(path.join(ROOT, 'bot', 'decks', 'ash-meta-2026-09.json'), 'utf8')).find((d) => d.metadata.name === 'darth-vader_jtl_yellow');
    self.onmessage({ data: { t: 'checkDeck', n: 1, deck: { ...vader, metadata: { name: "Vader's list", author: 'someone' } } } });
    self.onmessage({ data: { t: 'checkDeck', n: 2, deck: { ...vader, deck: vader.deck.slice(0, 2) } } });
    const checked = sent.filter((m) => m.t === 'deckChecked');
    assert.deepStrictEqual([checked[0].error, checked[0].deck.metadata.name], [null, "Vader's list"]);
    assert.match(checked[1].error, /main deck has \d+ cards/);
    self.onmessage({ data: { t: 'bot', name: 'tinybot-v1', hex: '0'.repeat(64), tar: new Uint8Array(0) } });
    assert.match(sent.at(-1).error, /not cross-origin isolated/, 'arena bots need an isolated page');

    const me = scriptedPerson((a) => {
        self.onmessage({ data: { t: 'act', act: a } });
        return sent.at(-1).t === 'acted' ? sent.at(-1).error : null;
    }, seededRng('me'));
    let n = 0;
    const them = scriptedPerson((a) => {
        self.onmessage({ data: { t: 'peerAct', n: ++n, act: a } });
        return sent.at(-1).t === 'peerActed' ? sent.at(-1).error : null;
    }, seededRng('them'));
    const ends = {};
    const ended = new Promise((resolve) => {
        onSent = (m) => {
            const [who, screen] = m.t === 'msg' ? ['mine', me] : m.t === 'peer' ? ['theirs', them] : [null, null];
            if (who) {
                screen(m.msg);
                if (m.msg.t === 'end') {
                    ends[who] = m.msg;
                }
            }
            if (ends.mine && ends.theirs) {
                resolve(ends);
            }
        };
    });
    self.onmessage({ data: { t: 'start', game } });
    assert.strictEqual(JSON.stringify(sent.find((m) => m.t === 'started')), '{"t":"started","id":"open-00000006","seat":"p1","peerSeat":"p2","cardText":null}');
    const end = await ended;
    assert.strictEqual(end.mine.outcome, native.result.outcome);
    assert.strictEqual(end.mine.replay, native.replay, 'the same game, board by board');
    assert.strictEqual(end.theirs.replay, native.replay, 'the guest gets the same replay');
});

const COMPILED = path.join(ROOT, 'build', 'compiled');
test("the play page's worker plays arena versions: a WebAssembly and a Python bundle in their own workers, against a person, with the files the page sends", { skip: (!built || !fs.existsSync(path.join(COMPILED, 'node-random', 'arena.json')) || !fs.existsSync(path.join(COMPILED, 'py-random', 'arena.json'))) && 'no engine build, or no test bundles (python3 bot/compiled/build.py)', timeout: 300000 }, async () => {
    const vm = require('vm');
    const crypto = require('crypto');
    const { Worker } = require('worker_threads');
    const { execFileSync } = require('child_process');
    const { build } = require('../swarm/build');
    const { checkReplay } = require('../arena/tables');
    const { seededRng } = require('../rng');
    const out = packOnce();
    build(out);
    if (!fs.existsSync(path.join(out, 'python.wasm'))) {
        assert.fail('the pack has no Python (build/compiled/.tools): python3 bot/compiled/build.py installs it');
    }
    // a bundle as the games machine keeps it: its canonical tar, named by its sha256
    const tarOf = (dir) => new Uint8Array(execFileSync('python3', [path.join(ROOT, 'bot', 'compiled', 'bundle.py'), 'tar', path.join(COMPILED, dir)], { maxBuffer: 256 << 20 }));
    const workers = [];
    const sent = [];
    let onSent = () => undefined;
    const fetched = [];
    // an isolated page's worker: bundles run in bot workers (here Node's), the pack is fetched, nothing else is
    const self = { postMessage: (m) => (sent.push(m), onSent(m)), crossOriginIsolated: true };
    const ctx = vm.createContext({
        self, navigator: { hardwareConcurrency: 2 }, console, performance, TextDecoder, TextEncoder, URL, atob, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, structuredClone,
        Worker: function BotWorker() {
            const w = new Worker(path.join(ROOT, 'bot', 'swarm', 'bot-worker.js'));
            workers.push(w);
            return w;
        },
        crypto: { getRandomValues: (a) => crypto.webcrypto.getRandomValues(a), randomUUID: () => crypto.randomUUID() },
        fetch: async (url) => {
            fetched.push(url);
            return { json: async () => JSON.parse(fs.readFileSync(path.join(out, 'engine.json'), 'utf8')) };
        }
    });
    vm.runInContext(fs.readFileSync(path.join(out, 'tables-worker.js'), 'utf8'), ctx);
    const next = (t) => new Promise((resolve) => {
        const hit = sent.find((m) => m.t === t || m.t === 'error');
        if (hit) {
            sent.splice(sent.indexOf(hit), 1);
            return resolve(hit);
        }
        onSent = (m) => {
            if (m.t === t || m.t === 'error') {
                sent.splice(sent.indexOf(m), 1);
                resolve(m);
            }
        };
    });
    try {
        self.onmessage({ data: { t: 'init', pack: '/tables/engine.json', botWorker: '/tables/bot-worker.js', pythonLib: '/tables/python-lib.json', pythonWasm: '/tables/python.wasm' } });
        const ready = await next('ready');
        assert.strictEqual(ready.t, 'ready', ready.message);
        assert.strictEqual(ready.isolated, true);
        const python = { lib: new Uint8Array(fs.readFileSync(path.join(out, 'python-lib.json'))), wasm: new Uint8Array(fs.readFileSync(path.join(out, 'python.wasm'))) };
        for (const [dir, name, seed] of [['node-random', 'node_random-v1', 5], ['py-random', 'py_random-v1', 6]]) {
            const tar = tarOf(dir);
            const hex = crypto.createHash('sha256').update(tar).digest('hex');
            self.onmessage({ data: { t: 'bot', name, hex: 'f'.repeat(64), tar: tar.slice(), capMs: 60000 } });
            assert.match((await next('botReady')).error, /sha256/i, 'a bundle is checked against its id');
            self.onmessage({ data: { t: 'bot', name, hex, tar, capMs: 60000, ...(dir === 'py-random' ? { python } : {}) } });
            const added = await next('botReady');
            assert.strictEqual(added.error, null);
            const person = scriptedPerson((a) => {
                self.onmessage({ data: { t: 'act', act: a } });
                const r = sent.findLast((m) => m.t === 'acted');
                sent.splice(sent.indexOf(r), 1);
                return r.error;
            }, seededRng(seed));
            const ended = new Promise((resolve) => {
                onSent = (m) => {
                    if (m.t === 'msg') {
                        sent.splice(sent.indexOf(m), 1);
                        person(m.msg);
                        if (m.msg.t === 'end') {
                            resolve(m.msg);
                        }
                    }
                };
            });
            self.onmessage({ data: { t: 'start', game: { mode: 'bot', bot: name, deck: 'darth-vader_jtl_yellow', you: 'pl_aaaaaa' } } });
            const started = await next('started');
            assert.strictEqual(started.t, 'started', started.error);
            const end = await ended;
            assert.strictEqual(end.outcome, 'won', end.error);
            const { header } = checkReplay(end.replay);
            assert.deepStrictEqual(header.players.map((p) => p.bot).sort(), ['pl_aaaaaa', name].sort(), 'the window keeps the game');
        }
        assert.deepStrictEqual(fetched, ['/tables/engine.json'], 'Python came with the bot, as the page downloaded it');
    } finally {
        await Promise.all(workers.map((w) => w.terminate()));
    }
});
