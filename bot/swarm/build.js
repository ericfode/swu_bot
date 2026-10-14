#!/usr/bin/env node
'use strict';
/**
 * Builds the swarm's browser files (bot/swarm/README.md) into build/swarm (or --out DIR):
 *
 *   referee-worker.js   runtime.js, engine.js, wasi.js and processes.js in one classic worker script, plus the entry
 *                       below: it loads a pack (engine.json, pack.js) and plays the games it is sent with referee.js
 *   bot-worker.js       wasi.js and bot-worker.js: one bot bundle under the WASI host
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

// The referee worker's entry. Messages in: {t: 'init', pack: URL of engine.json, botWorker: URL of bot-worker.js},
// then {t: 'play', job: {id, seed, p1, p2, key}, maxSteps, capMs}. Out: {t: 'ready', ms, build, cards},
// {t: 'step', id, step} (the replay's step lines, for the page's live view), {t: 'result', id, result, replay},
// {t: 'error', id, message}.
const REFEREE_ENTRY = `
const { createEngineRuntime } = load('./engine');
const { createSpawn } = load('./processes');
let rt = null;
let build = null;
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function init(msg) {
    const t0 = performance.now();
    const doc = await (await fetch(msg.pack)).json();
    const files = new Map();
    for (const [p, v] of Object.entries(doc.files)) {
        files.set(p, v.startsWith('b64:') ? b64(v.slice(4)) : v);
    }
    let sp = null;
    rt = createEngineRuntime({ files, spawn: (...a) => sp(...a), cpus: navigator.hardwareConcurrency || 1, log: { log: () => undefined, error: (...a) => console.warn('[swarm]', ...a) } });
    sp = createSpawn({ fs: rt.fs, path: rt.path, makeWorker: () => new Worker(msg.botWorker), stderr: null });
    // the engine and every card class load now, once per worker
    rt.require('/app/bot/env.js');
    build = { build: doc.build, cards: doc.cards };
    self.postMessage({ t: 'ready', ms: Math.round(performance.now() - t0), ...build });
}
async function play(msg) {
    const job = msg.job;
    try {
        const { createReferee } = rt.require('/app/bot/swarm/referee.js');
        const ref = createReferee({ maxSteps: msg.maxSteps, capMs: msg.capMs ?? Infinity, onStep: (step) => self.postMessage({ t: 'step', id: job.id, step }) });
        const { result, replay } = await ref.play(job);
        self.postMessage({ t: 'result', id: job.id, result, replay });
    } catch (e) {
        self.postMessage({ t: 'error', id: job.id, message: String(e && e.stack || e) });
    }
}
self.onmessage = (e) => {
    const msg = e.data;
    (msg.t === 'init' ? init(msg) : msg.t === 'play' ? play(msg) : Promise.resolve()).catch((err) => self.postMessage({ t: 'error', id: msg.job?.id ?? null, message: String(err && err.stack || err) }));
};
`;

const BOT_ENTRY = `
self.SwarmWasi = load('./wasi');
load('./bot-worker');
`;

function build(out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'referee-worker.js'), bundle(['runtime', 'engine', 'wasi', 'processes'], REFEREE_ENTRY));
    fs.writeFileSync(path.join(out, 'bot-worker.js'), bundle(['wasi', 'bot-worker'], BOT_ENTRY));
    return ['referee-worker.js', 'bot-worker.js'];
}

module.exports = { build };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(HERE, '..', '..', 'build', 'swarm'));
    console.log(`built ${build(out).join(', ')} into ${out}`);
}
