#!/usr/bin/env node
'use strict';
/**
 * Packs what the swarm's browser runtime (runtime.js) needs to play arena games, as files under the virtual root /app
 * (the games image's layout: /app/bot, /app/forceteki/build/server, /app/forceteki/test/json, /app/build/compiled):
 *
 *   node bot/swarm/pack.js [--root DIR] [--out build/swarm]
 *
 * It takes all of the engine's build (forceteki/build/server, no source maps), all card data (forceteki/test/json),
 * and of bot/ and the npm packages only the files a traced run loads or reads: a game between the in-process bots,
 * every resident WebAssembly bot and an arena version built (not played), the Rust simulator's views. The trace runs in
 * a child process (pack.js --trace) with hooks on require and on fs reads.
 *
 * Out: engine.json, {build, cards, files: {"/app/...": text}} (binary files are base64 under "b64:"), and
 * manifest.json, {build, cards, bytes, sha256, count}. build and cards are the games image's BUILD_SHA and CARDS_SHA
 * when the root has them (a helper must match both), else "dev".
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
// folders whose code the swarm may need although the trace does not load it (lazy requires): the referee's Rust
// simulations and Kessel's adapter (vendor/kessel, without its WebAssembly package), and the play page's table
// (bot/table: host.js plays a person against the JEPA bot in the person's tab)
const BOT_DIRS = ['bot/players', 'bot/sims', 'vendor/kessel/js', 'bot/table'];
const SKIP = /(^|\/)(test|tests|__pycache__|target)(\/|$)|\.(map|md|ts|py|rs|c|h|o)$/;
// the engine's logger and what it pulls in: the runtime gives the engine a silent logger instead (runtime.js aliases)
const LOGGING = /\/node_modules\/(winston|winston-transport|logform|@colors|triple-beam|readable-stream|async|@dabh|colorspace|color|color-string|color-convert|color-name|simple-swizzle|is-arrayish|text-hex|kuler|enabled|one-time|fn\.name|stack-trace|safe-stable-stringify|fecha|is-stream|util-deprecate|process|inherits|string_decoder|safe-buffer|ms)\//;

function walk(dir, out = []) {
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) {
            walk(p, out);
        } else {
            out.push(p);
        }
    }
    return out;
}

/** The trace (child process): every file under root that the scenarios load or read, one per line on stdout. */
async function trace(root) {
    const Module = require('module');
    const seen = new Set();
    const note = (p) => {
        if (typeof p === 'string' && p.startsWith(root)) {
            seen.add(p);
        }
    };
    for (const fn of ['readFileSync', 'existsSync', 'statSync', 'lstatSync', 'readdirSync']) {
        const orig = fs[fn];
        fs[fn] = function (p, ...a) {
            const abs = typeof p === 'string' ? path.resolve(p) : p;
            if (fn !== 'readdirSync') {
                note(abs);
            }
            return orig.call(this, p, ...a);
        };
    }
    process.chdir(root);
    const { Env } = require(path.join(root, 'bot/env.js'));
    const env = new Env();
    const { playGame } = require(path.join(root, 'bot/match.js'));
    const players = require(path.join(root, 'bot/players/index.js'));
    const { snapshot } = require(path.join(root, 'bot/recorder.js'));
    require(path.join(root, 'bot/protocol.js'));
    require(path.join(root, 'bot/stdio.js'));
    require(path.join(root, 'bot/rng.js'));
    // a short game between the in-process bots loads what a game needs; when a lineup has none of them any more (the
    // arena's residents become submitted bundles), the modules required above still are the pack
    try {
        const bots = [players.makeBot('heuristic', []), players.makeBot('rush', [])];
        await playGame(env, { seed: 7, bots, key: null, maxSteps: 400, record: true, snapshot });
    } catch (e) {
        console.error(`pack: no traced game (${String(e?.message ?? e).split('\n')[0]}); packing the modules loaded so far`);
    }
    for (const name of ['c-clock-wasm', 'rust-greedy2-wasm', 'rust-search-wasm', 'node-search-wasm', 'py-clock-wasm']) {
        try {
            players.describeBot(name);
            players.programSpec?.(name);
        } catch {
            // not built in this checkout
        }
    }
    try {
        require(path.join(root, 'bot/sims/rust-view.js'));
        require(path.join(root, 'bot/sims/pool.js')).loadPool(path.join(root, 'bot/sims/pool.json'));
    } catch {
        // optional
    }
    // every module loaded (with --preserve-symlinks, under root as named), and the data files read
    Object.keys(require.cache).forEach(note);
    void Module;
    // stdout is a pipe: exit once the list is written, not before
    process.stdout.write([...seen].join('\n') + '\n', () => process.exit(0));
}

function pack({ root, out }) {
    const t = spawnSync(process.execPath, ['--preserve-symlinks', __filename, '--trace', root], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, NODE_ENV: 'test' } });
    if (t.status !== 0) {
        throw new Error(`the trace failed: ${(t.stderr || '').trim().split('\n').slice(-5).join(' | ')}`);
    }
    // what the trace touched, less what the engine only looked at (lstat on source maps) and this folder itself
    const chosen = new Set(t.stdout.split('\n').filter((p) => p && !SKIP.test(path.relative(root, p)) && !LOGGING.test(p) && !path.relative(root, p).startsWith('bot/swarm/')));
    const add = (p) => {
        if (fs.statSync(p, { throwIfNoEntry: false })?.isFile() && !SKIP.test(path.relative(root, p))) {
            chosen.add(p);
        }
    };
    for (const p of walk(path.join(root, 'forceteki/build/server'))) {
        if (p.endsWith('.js') || p.endsWith('.json')) {
            add(p);
        }
    }
    for (const p of walk(path.join(root, 'forceteki/test/json'))) {
        chosen.add(p);
    }
    for (const d of BOT_DIRS) {
        if (fs.existsSync(path.join(root, d))) {
            for (const p of walk(path.join(root, d))) {
                if (/\.(js|json)$/.test(p) && !p.includes('/node_modules/')) {
                    add(p);
                }
            }
        }
    }
    // the swarm's own code that runs inside the runtime, and the resident WebAssembly bots (bundles, not the tools)
    for (const f of ['bot/swarm/referee.js', 'bot/compiled/toolchain.json', 'bot/players/guard.js', 'bot/arena/play-seed.js', 'bot/decklists.js', 'bot/arena/registry.js', 'bot/arena/home.js', 'bot/game-pool.js']) {
        add(path.join(root, f));
    }
    // the play page's JEPA bot (vendor/jepa: the player and its two models) and the deck lists people pick from
    for (const f of ['vendor/jepa/jepa.js', 'vendor/jepa/tx-t10.safetensors', 'vendor/jepa/tx-t10-e.safetensors', 'vendor/jepa/VERSION.json', 'bot/decks/ash-meta-2026-09.json']) {
        add(path.join(root, f));
    }
    const compiled = path.join(root, 'build/compiled');
    if (fs.existsSync(compiled)) {
        for (const name of fs.readdirSync(compiled).filter((n) => !n.startsWith('.'))) {
            const dir = path.join(compiled, name);
            if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'arena.json'))) {
                walk(dir).forEach((p) => chosen.add(p));
            }
        }
    }
    // the npm packages the runtime itself loads (Buffer, EventEmitter), and every package.json on the way to a file
    for (const pkg of ['buffer', 'base64-js', 'ieee754', 'events']) {
        for (const p of walk(path.join(root, 'forceteki/node_modules', pkg))) {
            if (/\.(js|json)$/.test(p) && !/(^|\/)(test|tests)\//.test(p)) {
                chosen.add(p);
            }
        }
    }
    for (const p of [...chosen]) {
        const m = /^(.*\/node_modules\/(@[^/]+\/)?[^/]+)\//.exec(p);
        if (m && fs.existsSync(`${m[1]}/package.json`)) {
            chosen.add(`${m[1]}/package.json`);
        }
    }
    const files = {};
    let bytes = 0;
    for (const p of [...chosen].sort()) {
        if (!fs.statSync(p, { throwIfNoEntry: false })?.isFile()) {
            continue;
        }
        const v = `/app/${path.relative(root, p)}`;
        const buf = fs.readFileSync(p);
        const text = buf.toString('utf8');
        files[v] = Buffer.from(text, 'utf8').equals(buf) ? text : `b64:${buf.toString('base64')}`;
        bytes += buf.length;
    }
    const read = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8').trim() : 'dev');
    const doc = { build: read('BUILD_SHA'), cards: read('CARDS_SHA'), files };
    const json = JSON.stringify(doc);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'engine.json'), json);
    const manifest = { build: doc.build, cards: doc.cards, count: Object.keys(files).length, bytes, packBytes: Buffer.byteLength(json), sha256: crypto.createHash('sha256').update(json).digest('hex') };
    // Python bundles' interpreter, when the root has it (the games image does): its WebAssembly as is, and its standard
    // library as python-lib.json, without what a bot never imports (tests, GUI toolkits, docs)
    const toolchain = JSON.parse(fs.readFileSync(path.join(root, 'bot/compiled/toolchain.json'), 'utf8'));
    const py = toolchain.runtimes?.['python-3.14-wasi'];
    const home = py && path.join(root, 'build/compiled/.tools', py.dir);
    if (home && fs.existsSync(path.join(home, py.wasm))) {
        fs.copyFileSync(path.join(home, py.wasm), path.join(out, 'python.wasm'));
        const lib = {};
        for (const p of walk(path.join(home, 'lib'))) {
            const rel = path.relative(root, p);
            if (!/(^|\/)(test|tests|idlelib|tkinter|turtledemo|pydoc_data|ensurepip|__pycache__)(\/|$)|turtle\.py$/.test(rel)) {
                const buf = fs.readFileSync(p);
                const text = buf.toString('utf8');
                lib[`/app/${rel}`] = Buffer.from(text, 'utf8').equals(buf) ? text : `b64:${buf.toString('base64')}`;
            }
        }
        fs.writeFileSync(path.join(out, 'python-lib.json'), JSON.stringify({ build: doc.build, wasm: `/app/${path.relative(root, path.join(home, py.wasm))}`, files: lib }));
        manifest.python = { wasm: py.wasm, files: Object.keys(lib).length };
    }
    fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
}

/** engine.json's files as the runtime's Map (binary files back to bytes). */
function filesOf(doc) {
    const m = new Map();
    for (const [p, v] of Object.entries(doc.files)) {
        m.set(p, v.startsWith('b64:') ? Uint8Array.from(Buffer.from(v.slice(4), 'base64')) : v);
    }
    return m;
}

module.exports = { pack, filesOf };

if (require.main === module) {
    const argv = process.argv.slice(2);
    if (argv[0] === '--trace') {
        trace(path.resolve(argv[1])).catch((e) => {
            console.error(e?.stack ?? e);
            process.exit(1);
        });
    } else {
        const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
        const root = path.resolve(arg('--root', REPO));
        const out = path.resolve(arg('--out', path.join(REPO, 'build', 'swarm')));
        const m = pack({ root, out });
        console.log(`packed ${m.count} files, ${(m.bytes / 1048576).toFixed(1)} MB, into ${path.relative(process.cwd(), out) || out}/engine.json (${(m.packBytes / 1048576).toFixed(1)} MB)`);
    }
}
