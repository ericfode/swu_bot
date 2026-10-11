'use strict';

// Alternate the old and new ActionWindow implementations inside one process.
// Engine files stay untouched; only the three changed prototype methods switch.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const ENGINE_FILE = path.join(ROOT, 'forceteki/build/server/game/core/gameSteps/ActionWindow.js');
const METHODS = ['continue', 'getSelectableCards', 'setPrompt'];
const MODES = ['rust-stdio', 'ismcts', 'js-inprocess', 'js-stdio'];
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const median = (values) => {
    assert(values.length > 0, 'cannot take the median of no values');
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function argsOf(argv) {
    const opts = { baseline: null, fixtures: [], out: path.join(ROOT, 'results/search-profile-cache-paired'),
        pairs: 5, warmups: 2, modes: ['rust-stdio', 'ismcts'] };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--help' || flag === '-h') return { help: true };
        assert(['--baseline', '--fixtures', '--out', '--pairs', '--warmups', '--modes'].includes(flag), `unknown flag ${flag}`);
        const value = argv[++i];
        assert(value !== undefined && !value.startsWith('--'), `missing value for ${flag}`);
        if (flag === '--baseline') opts.baseline = path.resolve(value);
        else if (flag === '--fixtures') opts.fixtures = value.split(',').map((file) => path.resolve(file));
        else if (flag === '--out') opts.out = path.resolve(value);
        else if (flag === '--modes') opts.modes = value.split(',');
        else opts[flag.slice(2)] = Number(value);
    }
    assert(opts.baseline, '--baseline must name the preserved, pre-change compiled ActionWindow.js');
    assert(opts.fixtures.length > 0, '--fixtures must name one or more existing fixture JSON files');
    assert(Number.isInteger(opts.pairs) && opts.pairs > 0, '--pairs must be a positive integer');
    assert(Number.isInteger(opts.warmups) && opts.warmups >= 0, '--warmups must be a nonnegative integer');
    assert(opts.modes.length > 0 && new Set(opts.modes).size === opts.modes.length, '--modes must be nonempty and unique');
    for (const mode of opts.modes) assert(MODES.includes(mode), `unknown mode ${mode}`);
    return opts;
}

/** Compile the saved source at its original filename so relative imports resolve normally.
 * Do not insert this module into require.cache: the engine must keep its current class.
 */
function loadBaselineModule(source, originalFilename = ENGINE_FILE) {
    const baseline = new Module(originalFilename, module);
    baseline.filename = originalFilename;
    baseline.paths = Module._nodeModulePaths(path.dirname(originalFilename));
    baseline._compile(source, originalFilename);
    baseline.loaded = true;
    return baseline.exports;
}

function describeDescriptor(descriptor) {
    if (!descriptor) return null;
    const describe = (value) => typeof value === 'function' ? Function.prototype.toString.call(value) : value;
    return Object.fromEntries(Object.entries(descriptor).map(([key, value]) => [key, describe(value)]));
}

/** Both variants instantiate the current class. A baseline setPrompt is inherited,
 * so deleting the current own override is essential, not an assignment to undefined.
 */
function createPrototypeSwitcher(current, baseline) {
    assert.equal(Object.getPrototypeOf(current), Object.getPrototypeOf(baseline), 'baseline and current must share the same UiPrompt prototype');
    const saved = Object.fromEntries(METHODS.map((name) => [name, Object.getOwnPropertyDescriptor(current, name)]));
    const old = Object.fromEntries(METHODS.map((name) => [name, Object.getOwnPropertyDescriptor(baseline, name)]));
    for (const name of ['continue', 'getSelectableCards']) {
        assert.equal(typeof saved[name]?.value, 'function', `current ${name} is missing`);
        assert.equal(typeof old[name]?.value, 'function', `baseline ${name} is missing`);
    }
    assert.equal(typeof saved.setPrompt?.value, 'function', 'current setPrompt override is missing; rebuild the optimized engine first');
    assert.equal(old.setPrompt, undefined, 'expected the baseline to inherit UiPrompt.setPrompt');

    // This comparison is intended for exactly this optimization, not arbitrary revisions.
    for (const name of new Set([...Reflect.ownKeys(current), ...Reflect.ownKeys(baseline)])) {
        if (name === 'constructor' || METHODS.includes(name)) continue;
        assert.deepEqual(describeDescriptor(Object.getOwnPropertyDescriptor(current, name)),
            describeDescriptor(Object.getOwnPropertyDescriptor(baseline, name)),
            `unrelated ActionWindow prototype member changed: ${String(name)}`);
    }

    const apply = (descriptors) => {
        for (const name of METHODS) {
            if (descriptors[name]) Object.defineProperty(current, name, descriptors[name]);
            else assert(Reflect.deleteProperty(current, name), `could not remove own ${name}`);
        }
    };
    let running = false;
    const restore = () => apply(saved);
    return {
        restore,
        methods: Object.fromEntries(METHODS.map((name) => [name, {
            before: old[name] ? sha256(JSON.stringify(describeDescriptor(old[name]))) : 'inherited',
            after: sha256(JSON.stringify(describeDescriptor(saved[name])))
        }])),
        async withVariant(variant, fn) {
            assert(variant === 'before' || variant === 'after', `unknown variant ${variant}`);
            assert(!running, 'variant switches must not overlap or nest');
            running = true;
            try {
                apply(variant === 'before' ? old : saved);
                return await fn();
            } finally {
                restore();
                running = false;
            }
        }
    };
}

const withoutStatsTime = (stats) => stats == null ? stats : Object.fromEntries(Object.entries(stats).filter(([key]) => key !== 'ms'));

function behaviorOf(sample) {
    return {
        chosen: sample.chosen,
        requestHash: sample.requestHash,
        traceHash: sample.traceHash,
        simCounts: sample.simCounts,
        simErrors: sample.simErrors,
        stats: withoutStatsTime(sample.stats),
        nativeSearch: sample.nativeSearch
    };
}

function verifyPair(before, after) {
    assert.equal(before.fixture, after.fixture, 'paired fixtures differ');
    assert.equal(before.mode, after.mode, 'paired modes differ');
    const label = `${before.fixture}/${before.mode}`;
    for (const sample of [before, after]) {
        assert(Number.isFinite(sample.searchMs) && sample.searchMs > 0, `${label}: invalid search time`);
        assert.deepEqual(sample.simErrors, [], `${label}: simulator errors invalidate the comparison`);
        if (sample.mode === 'ismcts') {
            assert(sample.stats && sample.nativeSearch, `${label}: native stats/search result missing; use the updated run.cjs`);
            assert.equal(sample.stats.failedPlayouts, 0, `${label}: failed native playouts invalidate the comparison`);
        } else {
            assert.equal(typeof sample.requestHash, 'string', `${label}: request hash missing`);
            assert.equal(typeof sample.traceHash, 'string', `${label}: response trace hash missing`);
        }
    }
    const left = behaviorOf(before);
    const right = behaviorOf(after);
    for (const key of Object.keys(left)) assert.deepEqual(left[key], right[key], `${label}: before/after ${key} changed`);
    return true;
}

function pairMetrics(before, after) {
    return {
        beforeSearchMs: before.searchMs,
        afterSearchMs: after.searchMs,
        savedSearchMs: before.searchMs - after.searchMs,
        searchImprovementPercent: 100 * (1 - after.searchMs / before.searchMs),
        searchSpeedup: before.searchMs / after.searchMs,
        beforeDecisionMs: before.decisionMs,
        afterDecisionMs: after.decisionMs,
        decisionImprovementPercent: 100 * (1 - after.decisionMs / before.decisionMs)
    };
}

function summarizePairs(pairs) {
    const groups = new Map();
    for (const pair of pairs) {
        if (!pair.validated) continue;
        const key = `${pair.fixture}/${pair.mode}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(pair);
    }
    return [...groups.entries()].map(([group, values]) => ({
        group,
        pairs: values.length,
        beforeFirst: values.filter((value) => value.order[0] === 'before').length,
        afterFirst: values.filter((value) => value.order[0] === 'after').length,
        beforeSearchMedianMs: median(values.map((value) => value.beforeSearchMs)),
        afterSearchMedianMs: median(values.map((value) => value.afterSearchMs)),
        medianPairedSearchImprovementPercent: median(values.map((value) => value.searchImprovementPercent)),
        minPairedSearchImprovementPercent: Math.min(...values.map((value) => value.searchImprovementPercent)),
        maxPairedSearchImprovementPercent: Math.max(...values.map((value) => value.searchImprovementPercent)),
        medianPairedSearchSpeedup: median(values.map((value) => value.searchSpeedup)),
        medianPairedSavedSearchMs: median(values.map((value) => value.savedSearchMs)),
        beforeDecisionMedianMs: median(values.map((value) => value.beforeDecisionMs)),
        afterDecisionMedianMs: median(values.map((value) => value.afterDecisionMs)),
        medianPairedDecisionImprovementPercent: median(values.map((value) => value.decisionImprovementPercent))
    }));
}

async function main(argv = process.argv.slice(2)) {
    const opts = argsOf(argv);
    if (opts.help) {
        process.stdout.write('Usage: node --expose-gc tools/search-profile/compare.cjs --baseline FILE --fixtures FILE[,FILE] [--out DIR] [--pairs 5] [--warmups 2] [--modes rust-stdio,ismcts]\n');
        return;
    }
    const baselineSource = fs.readFileSync(opts.baseline, 'utf8');
    const currentSource = fs.readFileSync(ENGINE_FILE, 'utf8');
    assert.notEqual(sha256(baselineSource), sha256(currentSource), 'baseline and current compiled files are identical; rebuild the optimized engine first');
    const fixtureSources = opts.fixtures.map((file) => {
        const source = fs.readFileSync(file, 'utf8');
        const entries = JSON.parse(source);
        assert(Array.isArray(entries) && entries.length > 0, `${file}: expected a nonempty fixture array`);
        return { file, sha256: sha256(source), entries };
    });
    const positions = fixtureSources.flatMap((source) => source.entries);
    assert(positions.every((fixture) => typeof fixture.id === 'string' && fixture.setup && Array.isArray(fixture.moves)), 'invalid fixture record');
    assert.equal(new Set(positions.map((fixture) => fixture.id)).size, positions.length, 'fixture IDs must be unique across files');

    // Lazy import keeps --help and the exported pure-helper checks engine-free.
    const { Env, replay, sample, write, status, closeClients } = require('./run.cjs');
    const { ActionWindow } = require(ENGINE_FILE);
    const { ActionWindow: BaselineActionWindow } = loadBaselineModule(baselineSource);
    const switcher = createPrototypeSwitcher(ActionWindow.prototype, BaselineActionWindow.prototype);
    const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    const meta = {
        at: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
        cpu: os.cpus()[0]?.model, cores: os.cpus().length, gcBeforeSamples: !!global.gc,
        git: git(['rev-parse', 'HEAD']), engine: git(['-C', 'forceteki', 'rev-parse', 'HEAD']), opts,
        compiled: {
            originalFilename: ENGINE_FILE,
            before: { file: opts.baseline, sha256: sha256(baselineSource) },
            after: { file: ENGINE_FILE, sha256: sha256(currentSource) },
            prototypeMethods: switcher.methods,
            constructor: 'Current ActionWindow constructor in both variants; its added field is transient optional prompt-refresh storage.'
        },
        harness: {
            runnerSha256: sha256(fs.readFileSync(__filename)),
            sampleRunnerSha256: sha256(fs.readFileSync(path.join(__dirname, 'run.cjs')))
        },
        fixtureSources: fixtureSources.map(({ file, sha256: hash, entries }) => ({ file, sha256: hash, fixtureIds: entries.map((fixture) => fixture.id) })),
        method: [
            'Use the supplied exact fixtures; preparation and child startup are outside search timers.',
            'Use one verified real root per fixture and a fresh verified Shadow for every sample, with bot hello/reset each time.',
            'Switch only continue, getSelectableCards and setPrompt on the current ActionWindow prototype; restore current descriptors in finally. No engine files are written.',
            'Alternate before/after order within consecutive pairs and alternate mode order; offset the first variant by fixture and mode. Warm both variants before measurement.',
            'Disable active span clocks and CPU sampling. Existing lightweight wrappers and transcript collection remain in both variants.',
            'Verify final action, request/response hashes, simulator counts/errors, native statistics except elapsed ms, and native search results for every pair and against the first equivalent workload.',
            'Improvement percent is 100 * (1 - after.searchMs / before.searchMs) for each pair; summarize the median of those percentages, not a ratio of separate medians.',
            'Shared desktop load is uncontrolled. Prototype replacement may affect JIT/inline caches; paired order and warmups reduce confounding but do not provide process isolation.'
        ]
    };
    fs.mkdirSync(opts.out, { recursive: true });
    const output = { meta, status: 'running', warmups: [], samples: [], pairs: [], aggregates: [] };
    const save = () => {
        output.aggregates = summarizePairs(output.pairs);
        write(path.join(opts.out, 'comparison.json'), output);
    };
    const referenceBehavior = new Map();
    const env = new Env();
    let currentPair = null;
    const safeName = (text) => text.replace(/[^a-zA-Z0-9_.-]/g, '_');
    try {
        write(path.join(opts.out, 'fixtures.json'), positions);
        save();
        for (const [fixtureIndex, fixture] of positions.entries()) {
            // Baseline shadow.sync must match this same real root, including its hidden state.
            const game = await switcher.withVariant('after', () => replay(env, fixture));
            const exercisePair = async (mode, index, phase) => {
                const modeIndex = opts.modes.indexOf(mode);
                const order = (fixtureIndex + modeIndex + index) % 2 ? ['after', 'before'] : ['before', 'after'];
                const measured = phase === 'measured';
                const rows = measured ? output.samples : output.warmups;
                const pair = { fixture: fixture.id, mode, pair: index + 1, order, validated: false, sampleIndices: {} };
                currentPair = pair;
                if (measured) output.pairs.push(pair);
                const results = {};
                for (const variant of order) {
                    const result = await switcher.withVariant(variant, () => sample(env, game, fixture, mode, { instrument: false, cpu: false }));
                    results[variant] = result;
                    pair.sampleIndices[variant] = rows.length;
                    rows.push({ ...result.summary, variant, phase, pair: index + 1 });
                }
                verifyPair(results.before.summary, results.after.summary);
                const behavior = behaviorOf(results.before.summary);
                const key = `${fixture.id}/${mode}`;
                if (referenceBehavior.has(key)) assert.deepEqual(behavior, referenceBehavior.get(key), `${key}: work changed across pairs/warmups`);
                else referenceBehavior.set(key, behavior);
                pair.validated = true;
                Object.assign(pair, pairMetrics(results.before.summary, results.after.summary));
                if (measured && index === 0 && mode !== 'ismcts') {
                    for (const variant of ['before', 'after']) {
                        write(path.join(opts.out, `${safeName(fixture.id)}-${mode}-${variant}-tape.json`), results[variant].tape);
                    }
                }
                currentPair = null;
                if (measured) {
                    status(`${fixture.id} ${mode} pair ${index + 1} (${order.join(' -> ')}): ${pair.beforeSearchMs.toFixed(1)} -> ${pair.afterSearchMs.toFixed(1)} ms; ${pair.searchImprovementPercent.toFixed(1)}% faster, behavior matched`);
                    save();
                }
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
        if (currentPair) currentPair.error = output.error;
        save();
        throw error;
    } finally {
        switcher.restore();
        await closeClients();
    }
}

module.exports = { argsOf, loadBaselineModule, createPrototypeSwitcher, verifyPair, pairMetrics, summarizePairs, main };

if (require.main === module) {
    main().catch((error) => { console.error(error); process.exitCode = 1; });
}
