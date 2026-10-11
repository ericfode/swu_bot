#!/usr/bin/env node
'use strict';

const { performance } = require('perf_hooks');
const { createSimulator } = require('./node');
const { records } = require('./check');

async function main(args) {
    const file = args[0] ?? 'bot/omni-rs/tests/fixtures/heuristic-vs-heuristic-1.jsonl.gz';
    const nodes = Number(args[1] ?? 1000000);
    const repetitions = Number(args[2] ?? 3);
    if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error('Repetitions must be a positive integer');
    const t0 = performance.now();
    const simulator = await createSimulator();
    const initial = records(file).find((r) => r.type === 'state')?.state;
    if (!initial) throw new Error('Trace has no initial state');
    const game = simulator.loadState(initial);
    const setupMs = performance.now() - t0;
    try {
        const warmup = game.bench(10000);
        for (let run = 1; run <= repetitions; run++) {
            const start = performance.now();
            const result = game.bench(nodes);
            console.log(JSON.stringify({ ...result, runtime: 'wasm-node', source: file, run,
                callMs: performance.now() - start, setupMs, warmupNodes: warmup.nodes }));
        }
    } finally { game.free(); simulator.free(); }
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
