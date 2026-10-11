'use strict';
// node analysis/test/mock-llm.test.js -- runs the Claude evaluator path end to end against a fake client (no network).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadGame } = require('../lib/game');
const { analyzeGame } = require('../analyze');
const { ClaudeEvaluator } = require('../lib/llm');

function fakeMessage(params) {
    const user = params.messages[0].content;
    let out;
    if (params.output_config.format.schema.required.includes('evals')) {
        const n = Number(/from 0 to (\d+)/.exec(user)[1]);
        out = { evals: Array.from({ length: n + 1 }, (_, i) => ({ i, p1: i / n, note: '' })).filter((e) => e.i % 2 === 0), turning_points: [{ i: 3, by: 'p2', what: 'x' }], summary: 's' };
    } else {
        out = { p_win: 0.7, confidence: 0.6, factors: { board: 0.1, base_race: 0, cards: 0, resources: 0, initiative: 0 }, key_factor: 'board', why: 'w' };
    }
    return { model: params.model, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(out) }], usage: { input_tokens: 1000, output_tokens: 100 } };
}

const calls = [];
const client = {
    beta: { messages: { stream: (params) => { calls.push(params); return { finalMessage: async () => fakeMessage(params) }; } } },
    messages: {
        batches: {
            create: async ({ requests }) => { client._batch = requests; return { id: 'b1', processing_status: 'ended' }; },
            retrieve: async () => ({ processing_status: 'ended', request_counts: {} }),
            results: async () => client._batch.map((r) => ({ custom_id: r.custom_id, result: { type: 'succeeded', message: fakeMessage(r.params) } }))
        }
    }
};

(async () => {
    const game = loadGame(path.join(__dirname, '..', 'fixtures', 'fixture-game.jsonl'));
    const opt = { views: ['subjective_p1', 'subjective_p2', 'objective', 'omniscient'], granularity: 'round', maxCheckpoints: Infinity, logWindow: 10, effort: 'low', omniEffort: 'high' };
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swu-cache-'));
    const ev = new ClaudeEvaluator({ client, cacheDir, log: () => {} });
    const a = await analyzeGame(game, opt, ev);
    const n = a.checkpoints.length;
    assert.strictEqual(calls.length, n * 3 + 1);
    assert.strictEqual(calls[0].fallbacks, 'default');
    assert.deepStrictEqual(calls[0].thinking, { type: 'adaptive' });
    assert.strictEqual(calls[0].output_config.effort, 'low');
    const c = a.checkpoints[1];
    assert.strictEqual(c.views.subjective_p1.p1, 0.7);
    assert.ok(Math.abs(c.views.subjective_p2.p1 - 0.3) < 1e-9, 'p2 view is flipped into the p1 frame');
    assert.ok(a.checkpoints.every((x) => x.views.omniscient), 'omniscient filled, odd ones interpolated');
    assert.ok(a.usage.cost_usd > 0);

    // second run is served from the disk cache
    calls.length = 0;
    const b = await analyzeGame(game, opt, ev);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(b.usage.cached, n * 3 + 1);

    // batch path
    const ev2 = new ClaudeEvaluator({ client, cacheDir: null, batch: true, log: () => {} });
    const c2 = await analyzeGame(game, opt, ev2);
    assert.strictEqual(c2.checkpoints[1].views.objective.p1, 0.7);
    assert.ok(!('fallbacks' in client._batch[0].params), 'batch requests carry no fallbacks');
    console.log(`ok: ${n} checkpoints, ${n * 3 + 1} calls, cache and batch paths`);
})().catch((e) => { console.error(e); process.exit(1); });
