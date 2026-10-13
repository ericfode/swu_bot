#!/usr/bin/env node
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const assert = require('assert/strict');
const { createSimulator } = require('./node');

function records(file) {
    const bytes = fs.readFileSync(file);
    return (file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes).toString('utf8').split('\n').filter((line) => line.trim()).map(JSON.parse);
}

function actionKeys(actions) {
    const keys = actions.map((a) => JSON.stringify(JSON.parse(a.key))).sort();
    assert.equal(new Set(keys).size, keys.length, 'Canonical action collision');
    return keys;
}

function checkRecords(simulator, rows, file = '<trace>') {
    let game, meta = false, finished = false, nextStep = null, windowReceipt = null;
    const result = { file, decisions: 0, windows: 0, winner: null, matched: false, runtime: 'wasm-node' };
    try {
        for (const [i, row] of rows.entries()) {
            try {
                if (finished) throw new Error('Records after terminal result');
                if (row.type === 'meta') {
                    assert.equal(meta, false, 'Duplicate metadata');
                    assert.equal(i, 0, 'Metadata must be first');
                    assert.equal(row.schema, 'omni-rs-trace-v1');
                    assert.equal(row.pool.sha256, simulator.poolHash, 'Pool hash mismatch');
                    meta = true;
                    continue;
                }
                assert.ok(meta, 'Missing trace metadata');
                assert.ok(Number.isSafeInteger(row.step), 'Missing integer step');
                nextStep ??= row.step;
                assert.equal(row.step, nextStep, 'Trace step is not consecutive');
                if (row.type === 'state') {
                    assert.equal(windowReceipt, null, 'Duplicate window receipt');
                    game ??= simulator.loadState(row.state);
                    assert.equal(game.isActionWindow(), true, 'Expected action window');
                    assert.deepEqual(game.snapshot(), row.state, 'Full window state mismatch');
                    windowReceipt = row.step;
                    result.windows++;
                } else if (row.type === 'decision') {
                    assert.ok(game, 'Decision before initial state');
                    if (game.isActionWindow()) assert.equal(windowReceipt, row.step, 'Missing action-window state receipt');
                    assert.deepEqual(actionKeys(game.legalActions(row.actor)), actionKeys(row.actions), 'Legal action set mismatch');
                    assert.equal(game.isActionWindow(row.actor), row.prompt.actionWindow, 'Action-window flag mismatch');
                    game.apply(row.actor, row.chosen);
                    result.decisions++;
                    nextStep++;
                    windowReceipt = null;
                } else if (row.type === 'result') {
                    assert.ok(game, 'Result before initial state');
                    assert.deepEqual(game.snapshot(), row.state, 'Terminal state mismatch');
                    assert.equal(game.over, true, 'Trace ends before the game');
                    assert.equal(game.winner, row.winner, 'Winner mismatch');
                    result.winner = row.winner;
                    finished = true;
                } else throw new Error(`Unknown record type ${row.type}`);
            } catch (error) {
                error.message = `${file}:${i + 1} step ${row.step ?? '?'}: ${error.message}`;
                throw error;
            }
        }
        assert.ok(finished, 'Missing terminal result');
        result.matched = true;
        return result;
    } finally { game?.free(); }
}

function options(args) {
    const opts = { files: [] };
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (flag === '--pool' || flag === '--catalogue') {
            const key = flag === '--pool' ? 'poolPath' : 'cataloguePath';
            if (opts[key] !== undefined) throw new Error(`Duplicate option ${flag}`);
            const value = args[++i];
            if (!value || value.startsWith('--')) throw new Error(`${flag} requires a file`);
            opts[key] = value;
        } else if (flag.startsWith('--')) throw new Error(`Unknown option ${flag}`);
        else opts.files.push(flag);
    }
    if (!opts.files.length) throw new Error('Usage: node bot/omni/wasm/check.js trace.jsonl[.gz]... [--pool FILE] [--catalogue FILE]');
    return opts;
}

async function main(args) {
    const opts = options(args);
    const simulator = await createSimulator(opts);
    try {
        for (const file of opts.files) console.log(JSON.stringify(checkRecords(simulator, records(file), file)));
    } finally { simulator.free(); }
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { records, checkRecords, options };
