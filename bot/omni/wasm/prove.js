#!/usr/bin/env node
'use strict';

const fs = require('fs');
const readline = require('readline');
const zlib = require('zlib');
const { performance } = require('perf_hooks');
const { createSimulator } = require('./node');

function options(args) {
    const opts = { depth: 12 };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--pool') opts.poolPath = args[++i];
        else if (a === '--depth') opts.depth = Number(args[++i]);
        else if (a === '--nodes') opts.nodes = Number(args[++i]);
        else if (a === '--ms') opts.ms = Number(args[++i]);
        else if (a === '--ms-field') opts.msField = args[++i];
        else if (!a.startsWith('--') && !opts.file) opts.file = a;
        else throw new Error(`Unknown argument ${a}`);
    }
    if (!opts.file) throw new Error('Usage: node bot/omni/wasm/prove.js positions.jsonl[.gz] [--pool file] [--depth 12] [--nodes N | --ms N | --ms-field jsMs]');
    if (['nodes', 'ms', 'msField'].filter((k) => opts[k] !== undefined).length > 1) throw new Error('Choose one of --nodes, --ms, --ms-field');
    return opts;
}

async function proveFile(opts, write = (row) => process.stdout.write(JSON.stringify(row) + '\n')) {
    const t0 = performance.now();
    const simulator = await createSimulator(opts);
    const setupMs = performance.now() - t0;
    const source = fs.createReadStream(opts.file);
    const stream = opts.file.endsWith('.gz') ? source.pipe(zlib.createGunzip()) : source;
    const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let line = 0;
    try {
        for await (const text of input) {
            line++;
            if (!text.trim()) continue;
            const row = JSON.parse(text);
            if (!row.fullState) throw new Error(`Line ${line}: missing fullState`);
            const limits = { depth: opts.depth };
            if (opts.nodes !== undefined) limits.nodes = opts.nodes;
            if (opts.ms !== undefined) limits.ms = opts.ms;
            if (opts.msField !== undefined) {
                const budget = row[opts.msField];
                if (!Number.isFinite(budget) || budget < 0) throw new Error(`Line ${line}: missing or invalid budget field ${opts.msField}`);
                limits.ms = budget;
            }
            const beforeImport = performance.now();
            const game = simulator.loadState(row);
            const imported = performance.now();
            try {
                const result = game.prove(limits);
                const done = performance.now();
                const labels = Object.fromEntries(['game', 'i', 'fromEnd', 'seed', 'bots', 'winner', 'toMove', 'round', 'proven', 'jsMs', 'jsNodes'].filter((k) => row[k] !== undefined).map((k) => [k, row[k]]));
                write({ ...labels, ...result, runtime: 'wasm-node', importMs: imported - beforeImport,
                    callMs: done - imported, endToEndMs: done - beforeImport, ...(limits.ms !== undefined ? { budgetMs: limits.ms } : {}) });
            } finally { game.free(); }
        }
    } finally { input.close(); source.destroy(); simulator.free(); }
    process.stderr.write(`Wasm initialization and pool load: ${setupMs.toFixed(3)} ms\n`);
}

if (require.main === module) proveFile(options(process.argv.slice(2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { options, proveFile };
