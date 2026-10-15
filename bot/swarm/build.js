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
 *   play-worker.js      runtime.js and engine.js, plus the entry below: the window's /play page, a person against the
 *                       JEPA bot (bot/table/host.js) on the same pack, with the referee and the bot in this worker
 *
 * Each module is wrapped as a function of (module, exports, require), as Node wraps it; require() between them uses
 * their file names. No packages, no transpiling: the code is the same code the Node tests run.
 *
 *   node bot/swarm/build.js [--out DIR]
 */
const fs = require('fs');
const path = require('path');

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

// The play worker's entry (bot/table/host.js). Messages in: {t: 'init', pack (its URL) or packBytes}, then
// {t: 'start', bot, deck, botDeck}, {t: 'act', act} and {t: 'concede'}. Out: {t: 'ready', ms, build, cards, options, cardText},
// {t: 'started', id, seat} or {t: 'refused', error} for a start, {t: 'acted', error} for an act (error null when taken),
// {t: 'msg', msg} for every table message (hello, decide, move, over, and end with the replay), {t: 'error', message}.
// The seed and the key of each game come from the browser's crypto.getRandomValues.
const PLAY_ENTRY = `
const { createEngineRuntime } = load('./engine');
let host = null;
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const filesOf = (doc) => {
    const files = new Map();
    for (const [p, v] of Object.entries(doc.files)) {
        files.set(p, v.startsWith('b64:') ? b64(v.slice(4)) : v);
    }
    return files;
};
const fail = (e) => self.postMessage({ t: 'error', message: String(e && e.stack || e) });
async function init(msg) {
    const t0 = performance.now();
    const doc = msg.packBytes ? JSON.parse(new TextDecoder().decode(msg.packBytes)) : await (await fetch(msg.pack)).json();
    const rt = createEngineRuntime({ files: filesOf(doc), log: { log: () => undefined, error: (...a) => console.warn('[play]', ...a) } });
    const { createTableHost } = rt.require('/app/bot/table/host.js');
    host = createTableHost({ send: (m) => self.postMessage({ t: 'msg', msg: m }) });
    self.postMessage({ t: 'ready', ms: Math.round(performance.now() - t0), build: doc.build, cards: doc.cards, options: host.options(), cardText: host.cardText() });
}
function start(msg) {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    try {
        const g = host.start({ bot: msg.bot, deck: msg.deck, botDeck: msg.botDeck, seed, key });
        self.postMessage({ t: 'started', id: g.id, seat: g.seat });
    } catch (e) {
        self.postMessage({ t: 'refused', error: String(e && e.message || e) });
    }
}
self.onmessage = (e) => {
    const msg = e.data;
    try {
        if (msg.t === 'init') {
            init(msg).catch(fail);
        } else if (!host) {
            fail('not ready (send init first)');
        } else if (msg.t === 'start') {
            start(msg);
        } else if (msg.t === 'act') {
            self.postMessage({ t: 'acted', error: host.act(msg.act) });
        } else if (msg.t === 'concede') {
            host.concede();
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

function build(out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'referee-worker.js'), bundle(['runtime', 'engine', 'wasi', 'processes', 'tar', 'referee-host'], REFEREE_ENTRY));
    fs.writeFileSync(path.join(out, 'bot-worker.js'), bundle(['wasi', 'bot-worker'], BOT_ENTRY));
    fs.copyFileSync(path.join(HERE, 'executor.js'), path.join(out, 'executor-worker.js'));
    fs.writeFileSync(path.join(out, 'play-worker.js'), bundle(['runtime', 'engine'], PLAY_ENTRY));
    return ['referee-worker.js', 'bot-worker.js', 'executor-worker.js', 'play-worker.js'];
}

module.exports = { build };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(HERE, '..', '..', 'build', 'swarm'));
    console.log(`built ${build(out).join(', ')} into ${out}`);
}
