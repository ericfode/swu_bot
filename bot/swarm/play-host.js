'use strict';
/**
 * The play page's worker (bot/arena/play.js, bot/swarm/build.js play-worker.js), in a browser worker or, for tests, in
 * Node: the engine from the swarm's pack, and a table (bot/table/host.js) where a person plays one bot at a time.
 *
 *   const host = createPlayHost({ files, makeWorker, send });   // send(msg): every table message, in order
 *   host.addFiles(entries)                // [[path, bytes]]: the JEPA bot's models, sent with its first game
 *   host.addPython(lib, module)           // python-lib.json's document and its interpreter, compiled once per tab
 *   host.addBundle(name, hex, tar, capMs) // an arena version: its canonical tar, checked against hex and unpacked
 *   host.table                            // the table: options, start, act, concede, cardText, done
 *
 * An arena version plays as it plays in a rated game: a bundle under the WASI host in its own worker (processes.js,
 * bot-worker.js), speaking protocol v2 through the referee, which sends it only what its seat sees and re-deals the
 * person's hidden cards in every simulation it asks for. It is guarded with the round's time limit per game (a bot over
 * it loses). Only WebAssembly versions play here: a bundle needs a stdin pipe (a SharedArrayBuffer), so the page must
 * be cross-origin isolated. The JEPA bot plays in this worker, with no pipe.
 */
const { createEngineRuntime } = require('./engine');
const { createSpawn } = require('./processes');
const { unpack } = require('./tar');

const WORK = '/work';
const VERSION = /^[a-z][a-z0-9_]*-v\d+$/;
const HEX = /^[0-9a-f]{64}$/;

function createPlayHost({ files, makeWorker, send, compile, log = console, cpus = 1 }) {
    let spawn = null;
    const rt = createEngineRuntime({ files, spawn: (...a) => spawn(...a), env: { ARENA_HOME: `${WORK}/arena` }, log, cpus });
    const modules = new Map();
    spawn = createSpawn({ fs: rt.fs, path: rt.path, makeWorker, compile, modules });
    const { fs, path } = rt;
    const players = rt.require('/app/bot/players/index.js');
    const { guard } = rt.require('/app/bot/players/guard.js');
    const { createTableHost, jepaOnly } = rt.require('/app/bot/table/host.js');
    const { JEPA_NAME } = rt.require('/app/bot/table/jepa.js');
    const jepa = jepaOnly();
    // name -> {hex, capMs, runtime}: the versions unpacked in this tab
    const versions = new Map();
    // the program of the game being started: an arena version's, stopped when its game ends (as referee.js does)
    let program = null;

    function addFiles(entries) {
        for (const [p, data] of entries) {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, data);
        }
    }

    function addPython(lib, module) {
        if (modules.has(lib.wasm)) {
            return;
        }
        addFiles(Object.entries(lib.files).map(([p, v]) => [p, typeof v === 'string' && v.startsWith('b64:') ? Uint8Array.from(atob(v.slice(4)), (c) => c.charCodeAt(0)) : v]));
        modules.set(lib.wasm, Promise.resolve(module));
    }

    /** Unpacks a version where arena/registry.js finds it, as referee-host.js prepare does; returns its runtime. */
    function addBundle(name, hex, tar, capMs) {
        if (!VERSION.test(name) || !HEX.test(hex)) {
            throw new Error(`not an arena version: ${name}`);
        }
        if (!Number.isFinite(capMs) || capMs < 1000) {
            throw new Error(`${name}: a time limit of 1000 ms or more`);
        }
        if (versions.get(name)?.hex !== hex) {
            const dir = path.join(WORK, 'arena', 'versions', name);
            fs.rmSync(dir, { recursive: true, force: true });
            for (const [rel, data] of unpack(tar, hex)) {
                const p = path.join(dir, 'bundle', rel);
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, data);
            }
            fs.writeFileSync(path.join(dir, 'SUBMISSION.json'), JSON.stringify({ bot: { kind: 'wasm' } }));
            // what play-seed.js checkResolved asks: the name resolves to this bundle, not to a bot built in here
            const d = players.describeBot(name);
            if (d?.kind !== 'arena' || d.lang !== 'wasm') {
                fs.rmSync(dir, { recursive: true, force: true });
                throw new Error(`${name} does not resolve to its bundle here`);
            }
            const m = JSON.parse(fs.readFileSync(path.join(dir, 'bundle', 'arena.json'), 'utf8'));
            versions.set(name, { hex, runtime: String(m.runtime) });
        }
        versions.get(name).capMs = capMs;
        return versions.get(name).runtime;
    }

    function makeBot(name) {
        if (name === JEPA_NAME) {
            return jepa(name);
        }
        const v = versions.get(name);
        if (!v) {
            throw new Error(`no bot ${name} in this tab`);
        }
        if (!loaded(v.runtime)) {
            throw new Error(`${name} needs the ${v.runtime} runtime, which this tab has not loaded`);
        }
        // a fresh program for every game (makeArenaBot), stopped when its game ends
        program = guard(players.makeBot(name, []), { capMs: v.capMs });
        return program;
    }

    /** True when a bundle of this runtime can start here: plain WASI always, an interpreter once addPython gave it. */
    function loaded(runtime) {
        if (runtime === 'wasi-p1') {
            return true;
        }
        const r = JSON.parse(fs.readFileSync('/app/bot/compiled/toolchain.json', 'utf8')).runtimes?.[runtime];
        // processes.js looks the interpreter up by this path, the one python-lib.json names
        return !!r && modules.has(path.join('/app/build/compiled/.tools', r.dir, r.wasm));
    }

    const table = createTableHost({ send, makeBot, bots: [JEPA_NAME] });
    const start = table.start;
    let playing = null;
    table.start = (opts) => {
        program = null;
        const g = start(opts);
        // the bundle's worker stops with its game; the JEPA bot has none
        const p = program;
        program = null;
        playing = p;
        if (p) {
            table.done.finally(() => {
                playing = playing === p ? null : playing;
                return p.close();
            });
        }
        return g;
    };
    return { table, addFiles, addPython, addBundle, runtime: rt, close: () => Promise.resolve(playing?.close()) };
}

module.exports = { createPlayHost };
