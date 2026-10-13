'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createSimulator } = require('../node');
const { records, checkRecords } = require('../check');
const fixtures = path.resolve(__dirname, '../../../omni-rs/tests/fixtures');
const compiledFixtures = path.resolve(__dirname, '../../../omni-rs/tests/compiled-fixtures');
const cataloguePath = path.resolve(__dirname, '../../../card-compiler/generated/catalog.json');

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

test('compiled Wasm programmes replay all sixteen expanded engine games with exact pool provenance', async () => {
    const simulator = await createSimulator({ cataloguePath, poolPath: path.join(compiledFixtures, 'pool.json') });
    try {
        const files = fs.readdirSync(compiledFixtures).filter((file) => file.endsWith('.gz')).sort();
        assert.equal(files.length, 16);
        let decisions = 0, windows = 0;
        for (const file of files) {
            const result = checkRecords(simulator, records(path.join(compiledFixtures, file)), file);
            assert.equal(result.matched, true);
            decisions += result.decisions;
            windows += result.windows;
        }
        assert.ok(decisions > 0 && windows > 0);
    } finally { simulator.free(); }
});

test('catalogue JSON supports both all-admitted cards and an exact raw subset pool', async () => {
    const catalogueJson = fs.readFileSync(cataloguePath, 'utf8');
    const poolJson = fs.readFileSync(path.join(compiledFixtures, 'pool.json'), 'utf8');
    const subset = await createSimulator({ catalogueJson, poolJson });
    const all = await createSimulator({ catalogueJson });
    const file = fs.readdirSync(compiledFixtures).filter((file) => file.endsWith('.gz')).sort()[0];
    const rows = records(path.join(compiledFixtures, file));
    const initial = rows.find((row) => row.type === 'state').state;
    try {
        assert.equal(subset.poolHash, rows[0].pool.sha256);
        assert.throws(() => all.loadState(initial), /requires explicit Hidden phase history/);
        // This fixture starts before any arena entry, so no per-unit history is inferred.
        for (const player of Object.values(initial.players)) {
            assert.equal(player.ground.length, 0);
            assert.equal(player.space.length, 0);
        }
        const hiddenOnly = { ...structuredClone(initial), hiddenHistoryVersion: 1 };
        assert.throws(() => all.loadState(hiddenOnly), /requires explicit Force state version/);
        // Persistent Force identities come from an actual engine recording;
        // they cannot be reconstructed from an older snapshot's arena contents.
        const referenceFixtures = path.resolve(__dirname, '../../../cards/reference/fixtures');
        const manifest = require('../../../cards/reference/library').corpus(referenceFixtures);
        const forceRecording = manifest.recordings.find((row) => row.caseId === 'auto/LOF_193/force-first-gain');
        assert.ok(forceRecording, 'The corpus must retain the versioned Force engine witness');
        const versioned = records(path.join(referenceFixtures, 'traces', forceRecording.traceSha256 + '.jsonl.gz')).find((row) => row.type === 'state').state;
        assert.equal(versioned.forceStateVersion, 1);
        assert.equal(versioned.hiddenHistoryVersion, 1);
        for (const [simulator, snapshot] of [[subset, initial], [all, versioned]]) {
            const game = simulator.loadState(snapshot);
            try {
                assert.deepEqual(game.snapshot(), snapshot);
                assert.equal(game.prove({ nodes: 0 }).complete, false);
            } finally { game.free(); }
        }
        const wrongPool = JSON.parse(poolJson);
        wrongPool.cards.find((card) => card.types.includes('unit')).power += 1;
        await assert.rejects(createSimulator({ catalogueJson, poolJson: JSON.stringify(wrongPool) }), /differs/);
    } finally { subset.free(); all.free(); }
});

test('invalid wrapper options release their owned Wasm handle and CLI flags cannot disappear', async () => {
    const { WasmGame } = await import('../adapter.mjs');
    for (const options of [null, { ids: ['same', 'same'] }, { ids: 'ab' }, { names: ['one'] }]) {
        let freed = 0;
        assert.throws(() => new WasmGame({ free() { freed++; } }, options));
        assert.equal(freed, 1);
    }
    const checkOptions = require('../check').options;
    const proveOptions = require('../prove').options;
    assert.equal(checkOptions(['trace.gz', '--catalogue', 'catalog.json', '--pool', 'pool.json']).cataloguePath, 'catalog.json');
    assert.equal(proveOptions(['positions.jsonl', '--catalogue', 'catalog.json']).cataloguePath, 'catalog.json');
    for (const parse of [checkOptions, proveOptions]) {
        assert.throws(() => parse(['input.jsonl', '--catalogue']), /requires/);
        assert.throws(() => parse(['input.jsonl', '--pool', '--catalogue', 'catalog.json']), /requires/);
    }
});

test('A drawn game lists both player names, like EnvGame.winners', async () => {
    const { WasmGame } = await import('../adapter.mjs');
    const draw = new WasmGame({ winner: () => 'draw' }, { ids: ['alice', 'bob'], names: ['Alice', 'Bob'] });
    assert.deepEqual(draw.winners, ['Alice', 'Bob']);
    const won = new WasmGame({ winner: () => 'p2' }, { ids: ['alice', 'bob'], names: ['Alice', 'Bob'] });
    assert.deepEqual(won.winners, ['Bob']);
});
