'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { stats, pairedChange, parseResults, semanticRows } = require('../omni-search-bench');

const position = { game: 'fixture', i: 0, seed: 7 };
const result = { ...position, ms: 10, nodes: 100, decisions: 250, transpositions: 3, depth: 2, complete: false, result: null };

test('summary reports sample variance and paired uncertainty without rounding away noise', () => {
    assert.equal(stats([1, 2, 3]).sampleVariance, 1);
    assert.equal(stats([1, 2, 3]).median, 2);
    assert.equal(pairedChange([10, 10, 10, 10, 10], [10, 10, 10, 10, 10]).interpretation, 'no resolved direction');
    assert.equal(pairedChange([10, 10, 10, 10, 10], [8, 8, 8, 8, 8]).interpretation, 'lower measured search time');
    assert.equal(pairedChange([10, 10], [8, 8]).pairedBootstrap95PercentInterval, null);
    assert.equal('coefficientOfVariation' in pairedChange([10, 10], [8, 8]).percentTimeChange, false);
});

test('semantic comparison removes timing only; counts, identity and result remain', () => {
    const rows = semanticRows([result]);
    assert.equal('ms' in rows[0], false);
    assert.equal(rows[0].decisions, result.decisions);
    assert.equal(rows[0].result, null);
    assert.equal(rows[0].seed, 7);
});

test('result validation rejects missing rows, changed identity and excess work', () => {
    assert.deepEqual(parseResults(JSON.stringify(result), [position], 100), [result]);
    assert.throws(() => parseResults('', [position], 100), /Expected 1 positions/);
    assert.throws(() => parseResults(JSON.stringify({ ...result, i: 1 }), [position], 100), /identity differs/);
    assert.throws(() => parseResults(JSON.stringify({ ...result, nodes: 101 }), [position], 100), /Invalid search result/);
    assert.throws(() => parseResults(JSON.stringify({ ...result, ms: 0 }), [position], 100), /Invalid search time/);
});

function fixture(t, changed) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-search-bench-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'positions.jsonl'), JSON.stringify(position) + '\n');
    fs.writeFileSync(path.join(dir, 'pool.json'), '{}\n');
    for (const variant of ['before', 'after']) {
        const row = { ...result, ms: variant === 'after' ? 8 : 10,
            ...(changed && variant === 'after' ? { decisions: 251 } : {}) };
        fs.writeFileSync(path.join(dir, variant), '#!/usr/bin/env node\nconsole.log(' + JSON.stringify(JSON.stringify(row)) + ');\n', { mode: 0o755 });
    }
    fs.writeFileSync(path.join(dir, 'workloads.json'), JSON.stringify({ workloads: [{ id: 'fixture', positions: 'positions.jsonl', pool: 'pool.json', nodes: 100, depth: 12, tableEntries: 10 }] }));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ workloads: 'workloads.json', rounds: 2, warmups: 0,
        variants: [{ id: 'before', binary: 'before' }, { id: 'after', binary: 'after' }] }));
    return { dir, child: spawnSync(process.execPath, [path.join(__dirname, '../omni-search-bench.js'), 'run', path.join(dir, 'config.json'), path.join(dir, 'out')], { encoding: 'utf8' }) };
}

test('runner retains receipts, freezes binaries and interleaves variant order', (t) => {
    const { dir, child } = fixture(t, false);
    assert.equal(child.status, 0, child.stderr);
    const summary = JSON.parse(fs.readFileSync(path.join(dir, 'out/summary.json')));
    assert.equal(summary.equalWorkAndResults, true);
    assert.equal(summary.workloads[0].variants.before.microsecondsPerNode.mean, 100);
    assert.equal(summary.workloads[0].variants.after.microsecondsPerNode.mean, 80);
    const runs = fs.readFileSync(path.join(dir, 'out/runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(runs.map((r) => r.variant), ['before', 'after', 'after', 'before']);
    assert.ok(runs.every((r) => r.command[0].startsWith(path.join(dir, 'out/inputs'))));
    assert.ok(runs.every((r) => !r.command.includes('--rules-receipt')));
});

test('runner fails closed on changed decision counts and leaves raw failure evidence', (t) => {
    const { dir, child } = fixture(t, true);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /search results or work counts changed/);
    assert.equal(fs.existsSync(path.join(dir, 'out/summary.json')), false);
    assert.ok(fs.readFileSync(path.join(dir, 'out/runs.jsonl'), 'utf8').includes('251'));
});
