'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createSimulator } = require('../node');
const { records, checkRecords } = require('../check');
const fixtures = path.resolve(__dirname, '../../../omni-rs/tests/fixtures');

test('Wasm adapter matches every engine decision and state in all committed fixtures', async () => {
    const simulator = await createSimulator();
    try {
        const files = fs.readdirSync(fixtures).filter((f) => f.endsWith('.gz'));
        assert.ok(files.length >= 6);
        for (const file of files) assert.equal(checkRecords(simulator, records(path.join(fixtures, file)), file).matched, true);
    } finally { simulator.free(); }
});

test('Wasm state, copies, checkpoints, and searches remain independent of JS snapshots', async () => {
    const simulator = await createSimulator();
    const initial = records(path.join(fixtures, 'heuristic-vs-heuristic-1.jsonl.gz')).find((r) => r.type === 'state').state;
    const game = simulator.loadState(initial, { ids: ['alice', 'bob'], names: ['Alice', 'Bob'] });
    try {
        const baseline = game.snapshot();
        const observation = game.snapshot();
        observation.players.p1.base.damage = 29;
        assert.deepEqual(game.snapshot(), baseline);
        const checkpoint = game.mark();
        const copy = game.clone();
        try {
            game.apply(game.actor, game.legalActions().find((a) => a.label === 'Pass'));
            assert.notDeepEqual(game.snapshot(), baseline);
            assert.deepEqual(copy.snapshot(), baseline);
            game.restore(checkpoint);
            assert.deepEqual(game.snapshot(), baseline);
            const result = game.prove({ depth: 2, nodes: 50 });
            assert.ok(Number.isFinite(result.ms));
            assert.ok(Number.isInteger(result.nodes));
            assert.deepEqual(game.snapshot(), baseline, 'A search must not mutate the retained game');
            const bench = game.bench(10);
            assert.equal(bench.nodes, 10);
            assert.deepEqual(game.snapshot(), baseline, 'A benchmark must not mutate the retained game');
        } finally { copy.free(); }
    } finally { game.free(); simulator.free(); }
    assert.throws(() => game.snapshot(), /freed/);
});

test('Wasm rejects incorrect pools, unsupported cards, invalid limits and illegal choices without mutation', async () => {
    const simulator = await createSimulator();
    const initial = records(path.join(fixtures, 'heuristic-vs-heuristic-1.jsonl.gz')).find((r) => r.type === 'state').state;
    try {
        assert.throws(() => simulator.loadState({ pool: { sha256: 'wrong' }, fullState: initial }), /pool hash/);
        const bad = structuredClone(initial);
        bad.players.p1.hand[0].setCode = 'UNSUPPORTED_001';
        assert.throws(() => simulator.loadState(bad), /UNSUPPORTED_001/);
        const game = simulator.loadState(initial);
        try {
            const before = game.snapshot();
            assert.throws(() => game.apply('["button",null,"fake",null,"Made up action"]'));
            assert.throws(() => game.prove({ ms: -1 }));
            assert.throws(() => game.prove({ hiddenOption: true }));
            assert.deepEqual(game.snapshot(), before);
            // The game owns its Rust catalog reference independently of the JS simulator handle.
            simulator.free();
            assert.deepEqual(game.snapshot(), before);
        } finally { game.free(); }
    } finally { simulator.free(); }
});
