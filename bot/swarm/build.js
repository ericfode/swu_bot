#!/usr/bin/env node
'use strict';
/**
 * Builds the swarm's browser files (bot/swarm/README.md) into build/swarm (or --out DIR):
 *
 *   referee-worker.js   runtime.js, engine.js, wasi.js, processes.js, tar.js and referee-host.js in one classic worker
 *                       script, plus the entry below: it loads a pack (engine.json, pack.js) and plays the games it is
 *                       sent, one at a time, with referee.js
 *   bot-worker.js       wasi.js and bot-worker.js: one bot bundle under the WASI host
 *   executor-worker.js  executor.js as it is: the tab's lease loop
 *   tables-worker.js    runtime.js, engine.js, wasi.js, processes.js and tar.js, plus the entry below: the window's
 *                       play page (/tables, bot/table/open.js), a person against the JEPA bot or an arena version (its
 *                       bundle in bot workers, as the referee worker runs them), or two people with this tab as the host
 *
 * Each module is wrapped as a function of (module, exports, require), as Node wraps it; require() between them uses
 * their file names. No packages, no transpiling: the code is the same code the Node tests run.
 *
 *   node bot/swarm/build.js [--out DIR]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const HERE = __dirname;

function bundle(mods, entry) {
    const parts = mods.map((m) => `${JSON.stringify(`./${m}`)}: function (module, exports, require) {\n${fs.readFileSync(path.join(HERE, `${m}.js`), 'utf8')}\n}`);
    return `'use strict';
// built by bot/swarm/build.js from bot/swarm/{${mods.join(',')}}.js; do not edit
(function () {
const defs = {
${parts.join(',\n')}
};
const cache = {};
function load(id) {
    if (cache[id]) return cache[id].exports;
    if (!defs[id]) throw new Error('swarm bundle: no module ' + id);
    const module = { exports: {} };
    cache[id] = module;
    defs[id].call(module.exports, module, module.exports, (r) => load(r.endsWith('.js') ? r.slice(0, -3) : r));
    return module.exports;
}
${entry}
})();
`;
}

// The referee worker's entry. Messages in: {t: 'init', packBytes (or pack, its URL), botWorker, pythonLib, pythonWasm}, then
// {t: 'play', job, game, bundles} (bundles: {hex: Uint8Array}). Out: {t: 'ready', ms, build, cards}, {t: 'step', step}
// (the replay's step lines, for the page's live view), {t: 'result', result, replay}, {t: 'error', message}.
const REFEREE_ENTRY = `
const { createRefereeHost } = load('./referee-host');
let host = null;
let cfg = null;
let python = null;
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const filesOf = (doc) => {
    const files = new Map();
    for (const [p, v] of Object.entries(doc.files)) {
        files.set(p, v.startsWith('b64:') ? b64(v.slice(4)) : v);
    }
    return files;
};
async function init(msg) {
    const t0 = performance.now();
    cfg = msg;
    const doc = msg.packBytes ? JSON.parse(new TextDecoder().decode(msg.packBytes)) : await (await fetch(msg.pack)).json();
    host = createRefereeHost({ files: filesOf(doc), makeWorker: () => new Worker(msg.botWorker), cpus: navigator.hardwareConcurrency || 1, log: { log: () => undefined, error: (...a) => console.warn('[swarm]', ...a) } });
    self.postMessage({ t: 'ready', ms: Math.round(performance.now() - t0), build: doc.build, cards: doc.cards });
}
// a Python bundle's interpreter: its library into the files, its WebAssembly compiled once per worker
function ensurePython() {
    python ??= (async () => {
        const lib = await (await fetch(cfg.pythonLib)).json();
        const res = await fetch(cfg.pythonWasm);
        const module = WebAssembly.compileStreaming && /wasm/.test(res.headers.get('content-type') || '') ? await WebAssembly.compileStreaming(res) : await WebAssembly.compile(await res.arrayBuffer());
        host.addFiles(Object.entries(lib.files).map(([p, v]) => [p, v.startsWith('b64:') ? b64(v.slice(4)) : v]), [[lib.wasm, module]]);
    })();
    return python;
}
async function play(msg) {
    try {
        host.prepare(msg.job, msg.bundles || {});
        if ([...host.runtimes(msg.job)].some((r) => r !== 'wasi-p1')) {
            await ensurePython();
        }
        const { result, replay } = await host.play(msg.job, msg.game, (step) => self.postMessage({ t: 'step', step }));
        self.postMessage({ t: 'result', result, replay });
    } catch (e) {
        self.postMessage({ t: 'error', message: String(e && e.stack || e) });
    }
}
self.onmessage = (e) => {
    const msg = e.data;
    (msg.t === 'init' ? init(msg) : msg.t === 'play' ? play(msg) : Promise.resolve()).catch((err) => self.postMessage({ t: 'error', message: String(err && err.stack || err) }));
};
`;

// The tables worker's entry (bot/table/open.js). Messages in: {t: 'init', pack (its URL) or packBytes, botWorker,
// pythonLib, pythonWasm}; {t: 'bot', name, hex, tar, capMs, python?} unpacks an arena version's bundle (tar: Uint8Array)
// so the host can make it, guarded with its round's capMs (python: {lib, wasm}, python-lib.json and python.wasm's bytes
// as the page downloaded them, for a Python bundle; without them the worker fetches pythonLib and pythonWasm); {t: 'checkDeck', n, deck}; {t: 'start', game: {mode, bot, deck,
// botDeck, peerDeck, you, peer}, files?}; {t: 'act', act}, {t: 'peerAct', n, act}, {t: 'concede'}, {t: 'peerConcede'}.
// Out: {t: 'ready', ms, build, cards, options, cardText, isolated}; {t: 'botReady', name, error}; {t: 'deckChecked', n,
// deck, error}; {t: 'started', id, seat, peerSeat, cardText} or {t: 'refused', error}; {t: 'acted', error};
// {t: 'peerActed', n, error}; {t: 'msg', msg} for every table message of this tab's person and {t: 'peer', msg} for the
// guest's (both end with the replay); {t: 'error', message}. The seed and the key of each game come from the browser's
// crypto.getRandomValues.
const TABLES_ENTRY = `
const { createEngineRuntime } = load('./engine');
const { createSpawn } = load('./processes');
const { unpack } = load('./tar');
const WORK = '/work';
let rt = null;
let host = null;
let cfg = null;
let python = null;
let spawn = null;
const modules = new Map();
const post = (m) => self.postMessage(m);
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const filesOf = (doc) => {
    const files = new Map();
    for (const [p, v] of Object.entries(doc.files)) {
        files.set(p, v.startsWith('b64:') ? b64(v.slice(4)) : v);
    }
    return files;
};
const fail = (e) => post({ t: 'error', message: String(e && e.stack || e) });
const why = (e) => String(e && e.message || e).split('\\n')[0].slice(0, 300);
async function init(msg) {
    const t0 = performance.now();
    cfg = msg;
    const doc = msg.packBytes ? JSON.parse(new TextDecoder().decode(msg.packBytes)) : await (await fetch(msg.pack)).json();
    rt = createEngineRuntime({ files: filesOf(doc), spawn: (...a) => spawn(...a), env: { ARENA_HOME: WORK + '/arena' }, cpus: navigator.hardwareConcurrency || 1, log: { log: () => undefined, error: (...a) => console.warn('[tables]', ...a) } });
    spawn = createSpawn({ fs: rt.fs, path: rt.path, makeWorker: () => new Worker(msg.botWorker), modules });
    const { createOpenHost } = rt.require('/app/bot/table/open.js');
    host = createOpenHost({ send: (m) => post({ t: 'msg', msg: m }), sendPeer: (m) => post({ t: 'peer', msg: m }) });
    post({ t: 'ready', ms: Math.round(performance.now() - t0), build: doc.build, cards: doc.cards, options: host.options(), cardText: host.cardText(), isolated: !!self.crossOriginIsolated });
}
// a Python bundle's interpreter: its library into the files, its WebAssembly compiled once per worker; from the bytes
// the page sends (given) or fetched here
function ensurePython(given) {
    python ??= (async () => {
        let lib;
        let module;
        if (given && given.lib && given.wasm) {
            lib = JSON.parse(typeof given.lib === 'string' ? given.lib : new TextDecoder().decode(given.lib));
            module = await WebAssembly.compile(given.wasm);
        } else {
            lib = await (await fetch(cfg.pythonLib)).json();
            const res = await fetch(cfg.pythonWasm);
            module = WebAssembly.compileStreaming && /wasm/.test(res.headers.get('content-type') || '') ? await WebAssembly.compileStreaming(res) : await WebAssembly.compile(await res.arrayBuffer());
        }
        for (const [p, v] of Object.entries(lib.files)) {
            rt.fs.mkdirSync(rt.path.dirname(p), { recursive: true });
            rt.fs.writeFileSync(p, v.startsWith('b64:') ? b64(v.slice(4)) : v);
        }
        modules.set(lib.wasm, Promise.resolve(module));
    })();
    python.catch(() => { python = null; });
    return python;
}
// an arena version's bundle where arena/registry.js finds it (as referee-host.js prepare unpacks it)
async function addBot(msg) {
    try {
        if (!/^[a-z][a-z0-9_]*-v\\d+$/.test(msg.name) || !/^[0-9a-f]{64}$/.test(msg.hex)) {
            throw new Error('a version name and its bundle id');
        }
        if (!self.crossOriginIsolated) {
            throw new Error('this browser cannot run arena bots here (the page is not cross-origin isolated)');
        }
        const dir = rt.path.join(WORK, 'arena', 'versions', msg.name);
        rt.fs.rmSync(dir, { recursive: true, force: true });
        for (const [rel, data] of unpack(msg.tar, msg.hex)) {
            const p = rt.path.join(dir, 'bundle', rel);
            rt.fs.mkdirSync(rt.path.dirname(p), { recursive: true });
            rt.fs.writeFileSync(p, data);
        }
        rt.fs.writeFileSync(rt.path.join(dir, 'SUBMISSION.json'), JSON.stringify({ bot: { kind: 'wasm' } }));
        const manifest = rt.path.join(dir, 'bundle', 'arena.json');
        const runtime = rt.fs.existsSync(manifest) ? String(JSON.parse(rt.fs.readFileSync(manifest, 'utf8')).runtime) : 'wasi-p1';
        if (runtime !== 'wasi-p1') {
            await ensurePython(msg.python);
        }
        host.setCap(msg.name, msg.capMs);
        post({ t: 'botReady', name: msg.name, error: null });
    } catch (e) {
        post({ t: 'botReady', name: msg.name, error: why(e) });
    }
}
function start(msg) {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    try {
        // the JEPA bot's models (bot/swarm/pack.js MODELS), sent with the first game against it: [[path, bytes]]
        for (const [p, data] of msg.files || []) {
            rt.fs.mkdirSync(rt.path.dirname(p), { recursive: true });
            rt.fs.writeFileSync(p, data);
        }
        const gm = msg.game || {};
        const g = host.start({ ...gm, seed, key });
        const custom = [gm.deck, gm.peerDeck, gm.botDeck].filter((d) => d && typeof d === 'object');
        post({ t: 'started', id: g.id, seat: g.seat, peerSeat: g.peerSeat || null, cardText: custom.length ? host.cardText(custom) : null });
    } catch (e) {
        post({ t: 'refused', error: why(e) });
    }
}
self.onmessage = (e) => {
    const msg = e.data;
    try {
        if (msg.t === 'init') {
            init(msg).catch(fail);
        } else if (!host) {
            fail('not ready (send init first)');
        } else if (msg.t === 'bot') {
            addBot(msg);
        } else if (msg.t === 'checkDeck') {
            try {
                post({ t: 'deckChecked', n: msg.n, deck: host.checkDeck(msg.deck), error: null });
            } catch (err) {
                post({ t: 'deckChecked', n: msg.n, deck: null, error: why(err) });
            }
        } else if (msg.t === 'start') {
            start(msg);
        } else if (msg.t === 'act') {
            post({ t: 'acted', error: host.act(msg.act) });
        } else if (msg.t === 'peerAct') {
            post({ t: 'peerActed', n: msg.n, error: host.peerAct(msg.act) });
        } else if (msg.t === 'concede') {
            host.concede();
        } else if (msg.t === 'peerConcede') {
            host.peerConcede();
        }
    } catch (err) {
        fail(err);
    }
};
`;

const BOT_ENTRY = `
self.SwarmWasi = load('./wasi');
load('./bot-worker');
`;

/**
 * Adds every file's size to the pack's manifest.json, when there is one, for the play page's progress bar: sizes, as
 * the page reads it, and gz, about what it downloads (the window sends each file gzipped at level 6, swarm-relay.js).
 */
function sizes(out) {
    const file = path.join(out, 'manifest.json');
    if (!fs.existsSync(file)) {
        return;
    }
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const names = fs.readdirSync(out).filter((n) => n !== 'manifest.json' && fs.statSync(path.join(out, n)).isFile()).sort();
    m.sizes = Object.fromEntries(names.map((n) => [n, fs.statSync(path.join(out, n)).size]));
    m.gz = Object.fromEntries(names.map((n) => [n, zlib.gzipSync(fs.readFileSync(path.join(out, n)), { level: 6 }).length]));
    fs.writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
}

function build(out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'referee-worker.js'), bundle(['runtime', 'engine', 'wasi', 'processes', 'tar', 'referee-host'], REFEREE_ENTRY));
    fs.writeFileSync(path.join(out, 'bot-worker.js'), bundle(['wasi', 'bot-worker'], BOT_ENTRY));
    fs.copyFileSync(path.join(HERE, 'executor.js'), path.join(out, 'executor-worker.js'));
    fs.writeFileSync(path.join(out, 'tables-worker.js'), bundle(['runtime', 'engine', 'wasi', 'processes', 'tar'], TABLES_ENTRY));
    sizes(out);
    return ['referee-worker.js', 'bot-worker.js', 'executor-worker.js', 'tables-worker.js'];
}

module.exports = { build };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(HERE, '..', '..', 'build', 'swarm'));
    console.log(`built ${build(out).join(', ')} into ${out}`);
}
