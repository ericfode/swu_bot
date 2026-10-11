'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const wasm = require('./pkg/node/omni_wasm.js');

const pool = fs.readFileSync(path.join(__dirname, '../omni/rs/pool.json'), 'utf8');
const fixtures = path.join(__dirname, '../omni-rs/tests/fixtures');
function records(name) {
    return zlib.gunzipSync(fs.readFileSync(path.join(fixtures, name))).toString('utf8').trim().split('\n').map(JSON.parse);
}
const sample = records('heuristic-vs-heuristic-1.jsonl.gz');
const initial = sample.find((r) => r.type === 'state').state;

test('actual Node Wasm matches every fixture decision, action set, window, and terminal state', () => {
    const engine = new wasm.WasmEngine(pool);
    try {
        assert.equal(engine.poolHash(), crypto.createHash('sha256').update(pool).digest('hex'));
        for (const file of fs.readdirSync(fixtures).filter((f) => f.endsWith('.gz')).sort()) {
            let game;
            try {
                for (const row of records(file)) {
                    if (row.type === 'state') {
                        game ??= engine.loadState(JSON.stringify(row.state));
                        assert.deepEqual(JSON.parse(game.snapshot()), row.state, `${file}:${row.step} state`);
                    } else if (row.type === 'decision') {
                        const before = game.stateHash();
                        const actual = JSON.parse(game.legalActions(row.actor));
                        assert.equal(game.stateHash(), before, 'enumeration must not mutate');
                        assert.deepEqual(actual.map((a) => a.key).sort(), row.actions.map((a) => a.key).sort(), `${file}:${row.step} actions`);
                        game.apply(row.chosen, row.actor);
                    } else if (row.type === 'result') {
                        assert.deepEqual(JSON.parse(game.snapshot()), row.state, `${file}: terminal`);
                        assert.equal(game.over(), true);
                        assert.equal(game.winner(), row.winner);
                    }
                }
            } finally { game?.free(); }
        }
    } finally { engine.free(); }
});

test('clones retain prompts and catalogue; invalid inputs and proofs do not mutate', () => {
    const engine = new wasm.WasmEngine(pool);
    const game = engine.loadState(JSON.stringify(initial));
    const checkpoint = game.clone();
    engine.free();
    try {
        const before = checkpoint.stateHash();
        const action = JSON.parse(game.legalActions())[0];
        game.apply(action.key);
        assert.equal(checkpoint.stateHash(), before);
        assert.notEqual(game.stateHash(), before);
        assert.throws(() => checkpoint.apply('[]'), /five-element/);
        assert.throws(() => checkpoint.apply(action.key, 'nobody'), /invalid seat/);
        assert.throws(() => checkpoint.prove('{"node":3}'), /unknown field/);
        assert.equal(checkpoint.stateHash(), before);
        const noNodes = JSON.parse(checkpoint.prove('{"nodes":0}'));
        assert.deepEqual([noNodes.nodes, noNodes.result, noNodes.complete], [0, null, false]);
        const noTime = JSON.parse(checkpoint.prove('{"ms":0}'));
        assert.equal(noTime.complete, false);
        const budget = JSON.parse(checkpoint.prove('{"ms":1}'));
        assert.equal(budget.complete, false);
        assert.equal(checkpoint.stateHash(), before);
        assert.throws(() => checkpoint.bench(-1), /integer/);
        assert.throws(() => checkpoint.bench(1.5), /integer/);
        const benchmark = JSON.parse(checkpoint.bench(100));
        assert.equal(benchmark.nodes, 100);
        assert.equal(checkpoint.stateHash(), before);
    } finally { game.free(); checkpoint.free(); }
});

test('browser ESM package initializes from bytes and runs the same retained-state search', async () => {
    const module = await import(pathToFileURL(path.join(__dirname, 'pkg/web/omni_wasm.js')).href);
    await module.default({ module_or_path: fs.readFileSync(path.join(__dirname, 'pkg/web/omni_wasm_bg.wasm')) });
    const engine = new module.WasmEngine(pool);
    const last = sample.filter((r) => r.type === 'state').at(-1).state;
    const game = engine.loadState(JSON.stringify(last));
    try {
        const proof = JSON.parse(game.prove('{"depth":2,"nodes":1000}'));
        assert.equal(proof.result, 'p2');
        assert.equal(proof.complete, true);
        assert.deepEqual(JSON.parse(game.snapshot()), last);
    } finally { game.free(); engine.free(); }
});
