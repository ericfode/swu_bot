'use strict';
/**
 * One referee worker's work (bot/swarm/README.md), in a browser worker or, for tests, in Node: the engine loaded once
 * from a pack, then one game at a time, as a helper's play-seed.js plays them (one game per worker, as ladder-worker.js).
 *
 *   const host = createRefereeHost({ files, makeWorker });
 *   host.prepare(job, bundles)              // bundles: {hex: Uint8Array of the canonical tar}; checks the job
 *   const { result, replay } = await host.play(job, gameId, onStep)
 *
 * prepare() checks the job with play-seed.js's own checkJob (only heuristic, rush, the residents and WebAssembly
 * versions with their bundles), unpacks each version where arena/registry.js finds it (ARENA_HOME=/work/arena, each
 * version a bundle/ folder and a SUBMISSION.json of kind wasm) after checking its tar against the job's bundle id, and
 * checks that every name resolves to the bot the job names (play-seed.js checkResolved).
 */
const { createEngineRuntime } = require('./engine');
const { createSpawn } = require('./processes');
const { unpack } = require('./tar');

const WORK = '/work';

function createRefereeHost({ files, makeWorker, compile, log = console, cpus = 1, stderr = null }) {
    let spawn = null;
    const rt = createEngineRuntime({ files, spawn: (...a) => spawn(...a), env: { ARENA_HOME: `${WORK}/arena` }, log, cpus });
    const modules = new Map();
    spawn = createSpawn({ fs: rt.fs, path: rt.path, makeWorker, compile, stderr, modules });
    const { fs, path } = rt;
    // the engine and every card class load now, once per worker
    rt.require('/app/bot/env.js');
    const seed = rt.require('/app/bot/arena/play-seed.js');
    const unpacked = new Map();

    function prepare(job, bundles = {}) {
        fs.mkdirSync(`${WORK}/bundles`, { recursive: true });
        fs.mkdirSync(`${WORK}/arena/versions`, { recursive: true });
        for (const [hex, tar] of Object.entries(bundles)) {
            if (/^[0-9a-f]{64}$/.test(hex)) {
                fs.writeFileSync(`${WORK}/bundles/${hex}.tar`, tar);
            }
        }
        const checked = seed.checkJob(job, `${WORK}/bundles`);
        for (const [name, b] of Object.entries(checked.bots).filter(([, x]) => x.kind === 'wasm')) {
            if (unpacked.get(name) === b.bundle) {
                continue;
            }
            const dir = path.join(WORK, 'arena', 'versions', name);
            fs.rmSync(dir, { recursive: true, force: true });
            for (const [rel, data] of unpack(rt.files.get(`${WORK}/bundles/${b.bundle}.tar`), b.bundle)) {
                const p = path.join(dir, 'bundle', rel);
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, data);
            }
            fs.writeFileSync(path.join(dir, 'SUBMISSION.json'), JSON.stringify({ bot: { kind: 'wasm' } }));
            unpacked.set(name, b.bundle);
        }
        seed.checkResolved(checked);
        return checked;
    }

    async function play(job, gameId, onStep = null) {
        const g = job.games.find((x) => x.id === gameId);
        if (!g) {
            throw new Error(`no game ${gameId} in the job`);
        }
        const { createReferee } = rt.require('/app/bot/swarm/referee.js');
        const ref = createReferee({ maxSteps: job.maxSteps, capMs: job.capMs ?? Infinity, onStep });
        return ref.play({ id: g.id, seed: job.seed, p1: g.p1, p2: g.p2, key: job.key });
    }

    /** The bundle runtimes a checked job's bots need ('wasi-p1', 'python-3.14-wasi'), from their arena.json. */
    function runtimes(job) {
        const out = new Set();
        for (const [name, b] of Object.entries(job.bots)) {
            const dir = b.kind === 'wasm' ? path.join(WORK, 'arena', 'versions', name, 'bundle') : `/app/build/compiled/${name.replace(/-wasm$/, '')}`;
            const manifest = path.join(dir, 'arena.json');
            if (fs.existsSync(manifest)) {
                out.add(String(JSON.parse(fs.readFileSync(manifest, 'utf8')).runtime));
            }
        }
        return out;
    }

    /** Adds files (an interpreter's library) and compiled modules (its WebAssembly, by the path run.py would read). */
    function addFiles(entries, compiled = []) {
        for (const [p, data] of entries) {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, data);
        }
        for (const [p, module] of compiled) {
            modules.set(p, Promise.resolve(module));
        }
    }

    return { prepare, play, runtimes, addFiles, runtime: rt, close: () => rt.require('/app/bot/players/index.js').closeBots() };
}

module.exports = { createRefereeHost };
