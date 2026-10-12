'use strict';

// Engine modules can contain module-private symbols. Keep each implementation in
// its own complete engine process; swapping exports would mix symbol identities.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fork, execFileSync } = require('node:child_process');
const { verifyPair, pairMetrics, summarizePairs } = require('./compare.cjs');

const ROOT = path.resolve(__dirname, '../..');
const ENGINE_ROOT = path.join(ROOT, 'forceteki/build/server/game');
const ENGINE_FILES = {
    'GameObjectUtils.js': path.join(ENGINE_ROOT, 'core/GameObjectUtils.js'),
    'GameStateManager.js': path.join(ENGINE_ROOT, 'core/snapshot/GameStateManager.js')
};
const MODES = ['rust-stdio', 'ismcts', 'js-inprocess', 'js-stdio'];
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const status = (value) => process.stderr.write(value + '\n');

function argsOf(argv) {
    const opts = { baseline: null, fixtures: [], out: path.join(ROOT, 'results/search-profile-snapshot-paired'),
        pairs: 5, warmups: 2, modes: ['rust-stdio', 'ismcts'], modules: null };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--help' || flag === '-h') return { help: true };
        assert(['--baseline', '--fixtures', '--out', '--pairs', '--warmups', '--modes', '--modules'].includes(flag), `unknown flag ${flag}`);
        const value = argv[++i];
        assert(value !== undefined && !value.startsWith('--'), `missing value for ${flag}`);
        if (flag === '--baseline') opts.baseline = path.resolve(value);
        else if (flag === '--fixtures') opts.fixtures = value.split(',').map((file) => path.resolve(file));
        else if (flag === '--out') opts.out = path.resolve(value);
        else if (flag === '--modes') opts.modes = value.split(',');
        else if (flag === '--modules') opts.modules = value.split(',');
        else opts[flag.slice(2)] = Number(value);
    }
    assert(opts.baseline, '--baseline must name the directory containing preserved, pre-change compiled modules');
    assert(opts.fixtures.length > 0, '--fixtures must name one or more existing fixture JSON files');
    assert(Number.isInteger(opts.pairs) && opts.pairs > 0, '--pairs must be a positive integer');
    assert(Number.isInteger(opts.warmups) && opts.warmups >= 0, '--warmups must be a nonnegative integer');
    assert(opts.modes.length > 0 && new Set(opts.modes).size === opts.modes.length, '--modes must be nonempty and unique');
    for (const mode of opts.modes) assert(MODES.includes(mode), `unknown mode ${mode}`);
    if (opts.modules !== null) {
        assert(opts.modules.length > 0 && new Set(opts.modules).size === opts.modules.length, '--modules must be nonempty and unique');
        for (const name of opts.modules) {
            assert(!path.posix.isAbsolute(name) && !path.win32.isAbsolute(name) && !name.includes('\\'), `module path must be relative and use forward slashes: ${name}`);
            assert(name.split('/').every((part) => part && part !== '.' && part !== '..'), `module path cannot contain empty, dot or parent segments: ${name}`);
            assert(name.endsWith('.js'), `module path must name a compiled .js file: ${name}`);
        }
    }
    return opts;
}

/** Explicit modules use the same relative directory layout on both sides. The
 * original two-file snapshot comparison keeps its existing flat baseline layout.
 */
function moduleEntries(opts) {
    const files = opts.modules === null ? ENGINE_FILES : Object.fromEntries(opts.modules.map((name) => [name, path.join(ENGINE_ROOT, name)]));
    return Object.entries(files).map(([name, filename]) => ({ name, filename, baseline: path.join(opts.baseline, name) }));
}

/** Install before importing the engine so every caller sees one cached module
 * and one set of private symbols. Original filenames preserve relative imports.
 */
function installBaselineHook(sources) {
    const original = require.extensions['.js'];
    const loaded = {};
    const resolved = new Map();
    for (const [filename, source] of Object.entries(sources)) {
        const canonical = fs.realpathSync(filename);
        assert(!require.cache[canonical], `engine module already loaded: ${filename}`);
        assert(!resolved.has(canonical), `duplicate engine module path: ${filename}`);
        resolved.set(canonical, { filename, source });
    }
    const hook = (module, filename) => {
        const baseline = resolved.get(filename);
        if (!baseline) return original(module, filename);
        assert(!Object.hasOwn(loaded, baseline.filename), `baseline module loaded twice: ${filename}`);
        loaded[baseline.filename] = sha256(baseline.source);
        module._compile(baseline.source, filename);
    };
    require.extensions['.js'] = hook;
    return { loaded, restore() { assert.equal(require.extensions['.js'], hook); require.extensions['.js'] = original; } };
}

// A worker imports run.cjs only after boot installs its baseline loader. No
// benchmark work overlaps another worker: the parent awaits every IPC command.
async function workerMain() {
    assert(process.send, 'workers require an IPC channel');
    let runner, env, fixture, game, hook, busy = false, closing = false;
    const cleanup = async () => {
        if (closing) return;
        closing = true;
        try { await runner?.closeClients(); }
        finally { hook?.restore(); }
    };
    const exit = async () => {
        try { await cleanup(); } finally { process.exit(0); }
    };
    process.on('disconnect', exit);
    process.on('SIGTERM', exit);
    process.on('SIGINT', exit);
    process.on('message', async (message) => {
        try {
            assert(!busy && !closing, 'worker commands must not overlap');
            busy = true;
            let result;
            if (message.command === 'boot') {
                assert(!runner, 'worker is already initialized');
                assert(['before', 'after'].includes(message.variant), 'invalid worker variant');
                if (message.variant === 'before') hook = installBaselineHook(message.sources);
                else for (const [filename, expected] of Object.entries(message.hashes)) {
                    assert.equal(sha256(fs.readFileSync(filename)), expected, `current engine changed before load: ${filename}`);
                }
                runner = require('./run.cjs');
                env = new runner.Env();
                for (const filename of Object.keys(message.hashes)) {
                    assert(require.cache[fs.realpathSync(filename)], `engine module was not loaded: ${filename}`);
                    if (hook) assert.equal(hook.loaded[filename], message.hashes[filename], `baseline loader was not used: ${filename}`);
                }
                result = { pid: process.pid, variant: message.variant, gcBeforeSamples: !!global.gc,
                    loaded: hook?.loaded ?? message.hashes };
            } else if (message.command === 'fixture') {
                assert(runner && env, 'worker must boot first');
                fixture = message.fixture;
                game = await runner.replay(env, fixture);
                result = { fixture: fixture.id };
            } else if (message.command === 'sample') {
                assert(game && fixture, 'worker must replay a fixture first');
                assert.equal(message.fixture, fixture.id, 'worker has the wrong fixture');
                assert(MODES.includes(message.mode), 'invalid sample mode');
                const sample = await runner.sample(env, game, fixture, message.mode, { instrument: false, cpu: false });
                result = { summary: sample.summary, ...(message.tape ? { tape: sample.tape } : {}) };
            } else if (message.command === 'close') {
                await cleanup();
                result = { closed: true };
            } else throw new Error(`unknown worker command ${message.command}`);
            busy = false;
            if (process.connected) process.send({ id: message.id, ok: true, result }, (error) => {
                if (error || closing) process.exit(error ? 1 : 0);
            });
        } catch (error) {
            busy = false;
            if (process.connected) process.send({ id: message.id, ok: false,
                error: { message: String(error?.message ?? error), stack: error?.stack } });
        }
    });
}

function createWorker(variant) {
    const child = fork(__filename, ['--worker'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        execArgv: global.gc ? ['--expose-gc'] : [], serialization: 'advanced' });
    let nextId = 1, pending = null, exited = false, failure = null;
    const rejectPending = (error) => {
        failure ??= error;
        if (!pending) return;
        const request = pending;
        pending = null;
        clearTimeout(request.timer);
        request.reject(error);
    };
    const exitedPromise = new Promise((resolve) => {
        child.once('exit', (code, signal) => {
            exited = true;
            rejectPending(new Error(`${variant} worker exited (${signal ?? code})`));
            resolve();
        });
        child.once('error', (error) => { rejectPending(error); resolve(); });
    });
    child.on('message', (message) => {
        if (!pending || pending.id !== message.id) return rejectPending(new Error(`${variant} worker sent an unexpected reply`));
        const request = pending;
        pending = null;
        clearTimeout(request.timer);
        if (message.ok) request.resolve(message.result);
        else {
            const error = new Error(`${variant} worker: ${message.error?.message ?? 'unknown error'}`);
            if (message.error?.stack) error.stack += '\nWorker stack:\n' + message.error.stack;
            request.reject(error);
        }
    });
    const request = (command, values = {}, timeoutMs = 120000) => {
        assert(!pending, `${variant} worker already has an active command`);
        if (failure) return Promise.reject(failure);
        return new Promise((resolve, reject) => {
            const id = nextId++;
            const timer = setTimeout(() => rejectPending(new Error(`${variant} worker timed out during ${command}`)), timeoutMs);
            pending = { id, resolve, reject, timer };
            child.send({ id, command, ...values }, (error) => { if (error) rejectPending(error); });
        });
    };
    return {
        request,
        async close() {
            if (exited) return;
            if (!failure && !pending) {
                try { await request('close', {}, 10000); } catch { /* signal cleanup below */ }
            }
            if (!exited) child.kill('SIGTERM');
            const kill = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 5000);
            try { await exitedPromise; } finally { clearTimeout(kill); }
        }
    };
}

async function main(argv = process.argv.slice(2)) {
    const opts = argsOf(argv);
    if (opts.help) {
        process.stdout.write('Usage: node --expose-gc tools/search-profile/compare-snapshots.cjs --baseline DIR --fixtures FILE[,FILE] [--modules core/path/Module.js,...] [--out DIR] [--pairs 5] [--warmups 2] [--modes rust-stdio,ismcts]\nWithout --modules, DIR contains GameObjectUtils.js and GameStateManager.js. With --modules, paths are relative to forceteki/build/server/game and mirrored under DIR.\n');
        return;
    }
    const sources = {};
    const canonicalModules = new Set();
    const canonicalEngineRoot = fs.realpathSync(ENGINE_ROOT);
    const compiled = Object.fromEntries(moduleEntries(opts).map(({ name, filename, baseline }) => {
        const canonical = fs.realpathSync(filename);
        const relative = path.relative(canonicalEngineRoot, canonical);
        assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), `module resolves outside the compiled game engine: ${filename}`);
        assert(!canonicalModules.has(canonical), `duplicate compiled engine module: ${filename}`);
        canonicalModules.add(canonical);
        sources[filename] = fs.readFileSync(baseline, 'utf8');
        return [name, { originalFilename: filename,
            before: { file: baseline, sha256: sha256(sources[filename]) },
            after: { file: filename, sha256: sha256(fs.readFileSync(filename)) } }];
    }));
    assert(Object.values(compiled).some((file) => file.before.sha256 !== file.after.sha256),
        'baseline and current compiled files are identical; rebuild the optimized engine first');
    const fixtureSources = opts.fixtures.map((file) => {
        const source = fs.readFileSync(file, 'utf8');
        const entries = JSON.parse(source);
        assert(Array.isArray(entries) && entries.length > 0, `${file}: expected a nonempty fixture array`);
        return { file, sha256: sha256(source), entries };
    });
    const positions = fixtureSources.flatMap((source) => source.entries);
    assert(positions.every((fixture) => typeof fixture.id === 'string' && fixture.setup && Array.isArray(fixture.moves)), 'invalid fixture record');
    assert.equal(new Set(positions.map((fixture) => fixture.id)).size, positions.length, 'fixture IDs must be unique across files');
    const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    const output = {
        meta: {
            at: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
            cpu: os.cpus()[0]?.model, cores: os.cpus().length, gcBeforeSamples: !!global.gc,
            git: git(['rev-parse', 'HEAD']), engine: git(['-C', 'forceteki', 'rev-parse', 'HEAD']), opts, compiled,
            harness: Object.fromEntries(['compare-snapshots.cjs', 'compare.cjs', 'run.cjs'].map((name) =>
                [name, sha256(fs.readFileSync(path.join(__dirname, name)))])),
            fixtureSources: fixtureSources.map(({ file, sha256: hash, entries }) => ({ file, sha256: hash, fixtureIds: entries.map((fixture) => fixture.id) })),
            workers: {},
            method: [
                'Keep baseline and current engines in separate persistent Node processes; each uses its own module cache and private symbols.',
                'Install a baseline require.extensions .js hook before importing run.cjs. Compile the selected saved modules at their original filenames. The current worker uses the normal loader. Engine files are never rewritten.',
                'Replay the exact supplied fixture independently in both engines and verify root view and legal actions. Every sample uses a fresh verified Shadow and resets the bot.',
                'Run only one IPC command at a time, including startup, fixture replay and samples. Startup, IPC, preparation and first shadow replay are outside searchMs.',
                'Alternate before/after order within consecutive pairs, offset by fixture and mode, and alternate mode order. Warm both variants before measurement.',
                'Disable active span clocks and CPU sampling. Existing lightweight wrappers and transcript collection remain in both variants. Optional explicit GC happens before each search.',
                'Verify final action, request/response hashes, simulator counts/errors, native statistics except elapsed ms, and native search results for every pair and against the first equivalent workload, including warmups.',
                'Improvement percent is 100 * (1 - after.searchMs / before.searchMs) for each pair; summarize the median of those percentages, not a ratio of separate medians.',
                'Shared desktop load and independent process JIT/heap history remain uncontrolled. Paired order and warmups reduce confounding; this is a fixed-work search benchmark, not a playing-strength evaluation.'
            ]
        }, status: 'running', warmups: [], samples: [], pairs: [], aggregates: []
    };
    fs.mkdirSync(opts.out, { recursive: true });
    const save = () => { output.aggregates = summarizePairs(output.pairs); write(path.join(opts.out, 'comparison.json'), output); };
    const workers = {};
    const references = new Map();
    let currentPair = null;
    const safeName = (value) => value.replace(/[^a-zA-Z0-9_.-]/g, '_');
    try {
        write(path.join(opts.out, 'fixtures.json'), positions);
        save();
        for (const variant of ['before', 'after']) {
            workers[variant] = createWorker(variant);
            const hashes = Object.fromEntries(Object.values(compiled).map((file) => [file.originalFilename, file[variant].sha256]));
            output.meta.workers[variant] = await workers[variant].request('boot', { variant, hashes,
                ...(variant === 'before' ? { sources } : {}) });
        }
        save();
        for (const [fixtureIndex, fixture] of positions.entries()) {
            for (const variant of ['before', 'after']) await workers[variant].request('fixture', { fixture });
            const exercisePair = async (mode, index, phase) => {
                const modeIndex = opts.modes.indexOf(mode);
                const order = (fixtureIndex + modeIndex + index) % 2 ? ['after', 'before'] : ['before', 'after'];
                const measured = phase === 'measured';
                const rows = measured ? output.samples : output.warmups;
                const pair = { fixture: fixture.id, mode, phase, pair: index + 1, order, validated: false, sampleIndices: {} };
                currentPair = pair;
                if (measured) output.pairs.push(pair);
                const results = {};
                const tape = measured && index === 0 && mode !== 'ismcts';
                for (const variant of order) {
                    const result = await workers[variant].request('sample', { fixture: fixture.id, mode, tape });
                    results[variant] = result;
                    pair.sampleIndices[variant] = rows.length;
                    rows.push({ ...result.summary, variant, phase, pair: index + 1 });
                }
                verifyPair(results.before.summary, results.after.summary);
                const key = `${fixture.id}/${mode}`;
                if (references.has(key)) verifyPair(references.get(key), results.before.summary);
                else references.set(key, results.before.summary);
                pair.validated = true;
                Object.assign(pair, pairMetrics(results.before.summary, results.after.summary));
                if (tape) for (const variant of ['before', 'after']) {
                    write(path.join(opts.out, `${safeName(fixture.id)}-${mode}-${variant}-tape.json`), results[variant].tape);
                }
                currentPair = null;
                if (measured) status(`${fixture.id} ${mode} pair ${index + 1} (${order.join(' -> ')}): ${pair.beforeSearchMs.toFixed(1)} -> ${pair.afterSearchMs.toFixed(1)} ms; ${pair.searchImprovementPercent.toFixed(1)}% faster, behavior matched`);
                save();
            };
            for (let warmup = 0; warmup < opts.warmups; warmup++) {
                const modes = warmup % 2 ? [...opts.modes].reverse() : opts.modes;
                for (const mode of modes) await exercisePair(mode, warmup, 'warmup');
            }
            status(`${fixture.id}: both variants warmed; measuring ${opts.pairs} pairs per mode`);
            for (let pair = 0; pair < opts.pairs; pair++) {
                const modes = pair % 2 ? [...opts.modes].reverse() : opts.modes;
                for (const mode of modes) await exercisePair(mode, pair, 'measured');
            }
        }
        output.status = 'complete';
        output.completedAt = new Date().toISOString();
        save();
        status(`Saved ${path.join(opts.out, 'comparison.json')}; every paired workload and decision matched.`);
        return output;
    } catch (error) {
        output.status = 'failed';
        output.error = String(error?.message ?? error);
        if (currentPair) {
            currentPair.error = output.error;
            output.failedPair = currentPair;
        }
        save();
        throw error;
    } finally {
        await Promise.all(Object.values(workers).map((worker) => worker.close()));
    }
}

module.exports = { argsOf, moduleEntries, installBaselineHook, main };

if (require.main === module) {
    const run = process.argv[2] === '--worker' ? workerMain : main;
    run().catch((error) => { console.error(error); process.exitCode = 1; });
}
