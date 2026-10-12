#!/usr/bin/env node
'use strict';

// Search timing comes from Search::solve, excluding process startup, input parsing
// and engine construction. This tool never enables dispatch instrumentation.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');

const HELP = `Usage:
  node tools/omni-search-bench.js prepare <workloads.json> <new-output-directory>
  node tools/omni-search-bench.js run <comparison.json> <new-output-directory>

See bot/omni-rs/benchmarks/README.md for config, invariants and profiling commands.`;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function jsonl(file) {
    const bytes = fs.readFileSync(file);
    return (file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes).toString('utf8').split('\n').filter((s) => s.trim()).map(JSON.parse);
}
function integer(value, name, minimum = 1) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
    return value;
}
function id(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new Error(`Unsafe or missing id: ${value}`);
    return value;
}
function uniqueIds(rows, name) {
    if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${name} must be a nonempty array`);
    const ids = rows.map((r) => id(r.id));
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${name} ids`);
}
function fingerprint(file) {
    const bytes = fs.readFileSync(file);
    return { path: path.resolve(file), bytes: bytes.length, sha256: sha256(bytes) };
}
function newDirectory(directory) {
    fs.mkdirSync(directory); // Refuse to mix a new run with older receipts.
    return path.resolve(directory);
}
function prepare(configFile, directory) {
    const config = readJson(configFile), base = path.dirname(path.resolve(configFile));
    uniqueIds(config.workloads, 'workloads');
    const out = newDirectory(directory);
    const catalogueSource = config.catalogue && path.resolve(base, config.catalogue);
    if (catalogueSource) fs.copyFileSync(catalogueSource, path.join(out, 'catalog.json'), fs.constants.COPYFILE_EXCL);
    const workloads = config.workloads.map((w) => {
        const trace = path.resolve(base, w.trace), pool = path.resolve(base, w.pool);
        const traceReceipt = fingerprint(trace), poolReceipt = fingerprint(pool);
        if (w.traceSha256 && traceReceipt.sha256 !== w.traceSha256) throw new Error(`${w.id}: trace hash changed`);
        const records = jsonl(trace), meta = records[0], states = records.filter((r) => r.type === 'state');
        if (meta.type !== 'meta' || meta.pool?.sha256 !== poolReceipt.sha256) throw new Error(`${w.id}: trace/pool provenance mismatch`);
        if (!Array.isArray(w.stateIndexes) || !w.stateIndexes.length) throw new Error(`${w.id}: explicit stateIndexes required`);
        const indexes = w.stateIndexes.map((i) => integer(i, 'state index', 0));
        if (new Set(indexes).size !== indexes.length) throw new Error(`${w.id}: duplicate state index`);
        const rows = indexes.map((i) => {
            const row = states[i];
            if (!row || row.state.phase !== 'action' || !['p1', 'p2'].includes(row.state.actor) || row.state.winner) {
                throw new Error(`${w.id}: state index ${i} is not a nonterminal action window`);
            }
            return { game: w.id, i, seed: meta.seed, pool: { sha256: poolReceipt.sha256 }, fullState: row.state };
        });
        const positions = `${w.id}.jsonl`, poolName = `${w.id}-pool.json`;
        fs.writeFileSync(path.join(out, positions), rows.map(JSON.stringify).join('\n') + '\n', { flag: 'wx' });
        fs.copyFileSync(pool, path.join(out, poolName), fs.constants.COPYFILE_EXCL);
        if (w.compiled && !catalogueSource) throw new Error(`${w.id}: compiled workload needs catalogue`);
        return { id: w.id, positions, pool: poolName, ...(w.compiled ? { catalogue: 'catalog.json' } : {}),
            nodes: integer(w.nodes ?? config.nodes ?? 30000, 'nodes'), depth: integer(w.depth ?? config.depth ?? 12, 'depth'),
            tableEntries: integer(w.tableEntries ?? config.tableEntries ?? 16384, 'tableEntries', 0),
            source: { trace: traceReceipt, pool: poolReceipt, seed: meta.seed, stateIndexes: indexes,
                steps: indexes.map((i) => states[i].step), ...(w.purpose ? { purpose: w.purpose } : {}), ...(w.caseId ? { caseId: w.caseId } : {}) } };
    });
    writeJson(path.join(out, 'workloads.json'), { schema: 'swu-search-workloads/v1', workloads });
    console.log(path.join(out, 'workloads.json'));
}
function stats(values) {
    const sorted = [...values].sort((a, b) => a - b), n = values.length;
    const mean = values.reduce((s, v) => s + v, 0) / n;
    const variance = n > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : null;
    return { samples: n, mean, median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2,
        min: sorted[0], max: sorted.at(-1), sampleVariance: variance, sampleStdDev: variance === null ? null : Math.sqrt(variance),
        coefficientOfVariation: variance === null ? null : Math.sqrt(variance) / mean };
}
function pairedChange(before, after) {
    const values = before.map((v, i) => 100 * (after[i] / v - 1));
    // Descriptive paired bootstrap; not a guarantee against shared-host drift.
    let seed = 0x6a09e667;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    const means = [];
    for (let b = 0; b < 10000; b++) {
        let sum = 0;
        for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)];
        means.push(sum / values.length);
    }
    means.sort((a, b) => a - b);
    const interval = values.length < 5 ? null : [means[249], means[9749]];
    return { percentTimeChange: stats(values), pairedBootstrap95PercentInterval: interval,
        interpretation: !interval || (interval[0] <= 0 && interval[1] >= 0) ? 'no resolved direction' :
            (interval[1] < 0 ? 'lower measured search time' : 'higher measured search time') };
}
function semanticRows(rows) {
    return rows.map(({ ms, ...row }) => row);
}
function parseResults(stdout, expected, nodesLimit) {
    const rows = stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
    if (rows.length !== expected.length) throw new Error(`Expected ${expected.length} positions, got ${rows.length}`);
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i], p = expected[i];
        if (r.game !== p.game || r.i !== p.i || r.seed !== p.seed) throw new Error(`Result identity differs at row ${i}`);
        if (!Number.isFinite(r.ms) || r.ms <= 0) throw new Error(`Invalid search time at row ${i}`);
        integer(r.nodes, 'result nodes', 0); integer(r.decisions, 'result decisions', 0); integer(r.transpositions, 'transpositions', 0); integer(r.depth, 'result depth', 0);
        if (r.nodes > nodesLimit || r.decisions < r.nodes || typeof r.complete !== 'boolean' || ![null, 'p1', 'p2'].includes(r.result)) {
            throw new Error(`Invalid search result at row ${i}`);
        }
    }
    if (!rows.some((r) => r.nodes > 0)) throw new Error('Workload performed no search nodes');
    return rows;
}
function run(configFile, directory) {
    const config = readJson(configFile), base = path.dirname(path.resolve(configFile));
    const workloadsFile = path.resolve(base, config.workloads), workloadBase = path.dirname(workloadsFile);
    const workloads = readJson(workloadsFile).workloads;
    uniqueIds(workloads, 'workloads'); uniqueIds(config.variants, 'variants');
    if (config.variants.length < 2) throw new Error('Compare at least two variants');
    const rounds = integer(config.rounds ?? 7, 'rounds'), warmups = integer(config.warmups ?? 1, 'warmups', 0);
    const timeoutMs = integer(config.timeoutMs ?? 300000, 'timeoutMs');
    const out = newDirectory(directory), snapshots = path.join(out, 'inputs'); fs.mkdirSync(snapshots);
    const copies = new Map(), assets = [];
    function snapshot(file) {
        file = path.resolve(file);
        if (copies.has(file)) return copies.get(file);
        const receipt = fingerprint(file), target = path.join(snapshots, `${receipt.sha256.slice(0, 16)}-${path.basename(file)}`);
        if (!fs.existsSync(target)) fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
        assets.push({ ...receipt, snapshot: target }); copies.set(file, target); return target;
    }
    const variants = config.variants.map((v) => {
        if (!['auto', 'interpreter', 'aot'].includes(v.backend ?? 'auto')) throw new Error(`${v.id}: invalid backend`);
        const binary = snapshot(path.resolve(base, v.binary)); fs.chmodSync(binary, 0o755);
        return { id: v.id, backend: v.backend ?? 'auto', binary, ...(v.commit ? { commit: v.commit } : {}),
            native: fingerprint(binary), ...(v.wasm ? { wasm: fingerprint(snapshot(path.resolve(base, v.wasm))) } : {}) };
    });
    for (const w of workloads) {
        w.positions = snapshot(path.resolve(workloadBase, w.positions));
        w.pool = snapshot(path.resolve(workloadBase, w.pool));
        if (w.catalogue) w.catalogue = snapshot(path.resolve(workloadBase, w.catalogue));
        integer(w.nodes, 'nodes'); integer(w.depth, 'depth'); integer(w.tableEntries, 'tableEntries', 0);
        w.expected = jsonl(w.positions);
        if (!w.expected.length) throw new Error(`${w.id}: no positions`);
        const keys = w.expected.map((r) => JSON.stringify([r.game, r.i]));
        if (new Set(keys).size !== keys.length || w.expected.some((r) => typeof r.game !== 'string' || !Number.isSafeInteger(r.i))) {
            throw new Error(`${w.id}: invalid/duplicate position identities`);
        }
    }
    const manifest = { schema: 'swu-search-comparison/v1', createdAt: new Date().toISOString(),
        host: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, node: process.version },
        rounds, warmups, instrumentation: false, timing: 'sum of native Search::solve ms, excluding loading and process setup',
        variantOrder: 'rotated each round; workload order alternates each round', variants, assets,
        workloads: workloads.map(({ expected, ...w }) => ({ ...w, positionsCount: expected.length })) };
    writeJson(path.join(out, 'manifest.json'), manifest);
    const log = path.join(out, 'runs.jsonl'), invariants = new Map(), runs = [];
    for (let round = -warmups; round < rounds; round++) {
        const order = ((round + warmups) % 2 ? [...workloads].reverse() : workloads);
        for (const w of order) {
            const offset = (round + warmups) % variants.length;
            const rotated = [...variants.slice(offset), ...variants.slice(0, offset)];
            for (const v of rotated) {
                const args = ['prove', w.positions, '--pool', w.pool, '--backend', v.backend, '--nodes', String(w.nodes),
                    '--depth', String(w.depth), '--table-entries', String(w.tableEntries)];
                if (w.catalogue) args.push('--catalogue', w.catalogue);
                const start = performance.now();
                const child = spawnSync(v.binary, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
                const record = { round, warmup: round < 0, workload: w.id, variant: v.id, command: [v.binary, ...args],
                    processMs: performance.now() - start, status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr };
                fs.appendFileSync(log, JSON.stringify(record) + '\n');
                if (child.error || child.status !== 0) throw new Error(`${w.id}/${v.id}: process failed: ${child.error?.message ?? child.stderr}`);
                const rows = parseResults(child.stdout, w.expected, w.nodes), semantic = JSON.stringify(semanticRows(rows));
                if (invariants.has(w.id) && invariants.get(w.id) !== semantic) throw new Error(`${w.id}/${v.id}: search results or work counts changed; no performance conclusion valid`);
                invariants.set(w.id, semantic);
                const ms = rows.reduce((s, r) => s + r.ms, 0), nodes = rows.reduce((s, r) => s + r.nodes, 0);
                runs.push({ round, warmup: round < 0, workload: w.id, variant: v.id, ms, nodes,
                    decisions: rows.reduce((s, r) => s + r.decisions, 0), microsecondsPerNode: 1000 * ms / nodes, nodesPerSecond: 1000 * nodes / ms });
                process.stderr.write(`${round < 0 ? 'warmup' : `round ${round + 1}/${rounds}`} ${w.id} ${v.id}: ${(1000 * ms / nodes).toFixed(3)} us/node\n`);
            }
        }
    }
    for (const a of assets) if (fingerprint(a.snapshot).sha256 !== a.sha256) throw new Error(`Input changed during run: ${a.snapshot}`);
    const timed = runs.filter((r) => !r.warmup);
    function summarize(name, samplesForVariant) {
        const samples = variants.map((v) => samplesForVariant(v.id));
        const groups = variants.map((v, i) => [v.id, { microsecondsPerNode: stats(samples[i]),
            nodesPerSecond: stats(samples[i].map((x) => 1e6 / x)), ...(i ? { versusFirstVariant: pairedChange(samples[0], samples[i]) } : {}) }]);
        return { id: name, variants: Object.fromEntries(groups) };
    }
    const summary = { schema: 'swu-search-summary/v1', equalWorkAndResults: true, rounds, warmups,
        workloads: workloads.map((w) => ({ ...summarize(w.id, (v) => timed.filter((r) => r.workload === w.id && r.variant === v).sort((a, b) => a.round - b.round).map((r) => r.microsecondsPerNode)),
            invariantResults: JSON.parse(invariants.get(w.id)) })),
        aggregate: summarize('all-workloads', (v) => Array.from({ length: rounds }, (_, round) => {
            const rows = timed.filter((r) => r.variant === v && r.round === round);
            return 1000 * rows.reduce((s, r) => s + r.ms, 0) / rows.reduce((s, r) => s + r.nodes, 0);
        })), variants, caveats: [
            'Search result and node/decision/transposition equality is not full transition conformance; run the Karabast reference checks separately.',
            'Bootstrap intervals describe these paired runs; shared-host interference, thermal drift and limited workload coverage remain possible.',
            'Negative percent time change is faster. No resolved direction means the interval includes zero, or fewer than five rounds.',
            'Search is deterministic for a frozen full state; trace seeds fix fixture generation, and the prover has no runtime random seed.',
            'Wasm sizes are recorded when supplied; these timings are native search only.'
        ] };
    writeJson(path.join(out, 'measurements.json'), runs);
    writeJson(path.join(out, 'summary.json'), summary);
    console.log(path.join(out, 'summary.json'));
}
function main(args) {
    if (args.length !== 3 || !['prepare', 'run'].includes(args[0])) throw new Error(HELP);
    (args[0] === 'prepare' ? prepare : run)(args[1], args[2]);
}
if (require.main === module) {
    try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { stats, pairedChange, parseResults, semanticRows };
