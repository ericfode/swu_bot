'use strict';
// Position evaluators (bot/eval) on hand-made snapshots. Runs without card data: unknown set codes count as tokens.
const test = require('node:test');
const assert = require('node:assert');
const { frameFeatures, vector, NAMES } = require('../eval/features');
const { loadEvaluator, EVALUATORS } = require('../eval/evaluators');

function side({ baseHp = 28, damage = 0, units = [], hand = 4, res = 3 } = {}) {
    return {
        base: { n: 'Base', s: null, hp: baseHp, d: damage }, leader: { n: 'Leader', s: null, dep: 0, x: 0 },
        res: { ready: res, total: res }, hand: Array.from({ length: hand }, () => ({ n: 'Card', s: null })), deck: 40, discard: [],
        ground: units.map(([p, h, d = 0]) => ({ n: 'Unit', s: null, p, h, d })), space: []
    };
}
const state = (p1, p2, initiative = 'p1') => ({ round: 4, phase: 'action', initiative, players: { p1: side(p1), p2: side(p2) } });

test('feature vector matches its names', () => {
    const fr = frameFeatures(state({}, {}), 'p1', { toAct: 'p2' });
    assert.strictEqual(vector(fr).length, NAMES.length);
    assert.strictEqual(fr.g.toAct, -1);
});

test('every evaluator prefers the side with the better board and base', () => {
    const s = state({ units: [[4, 5], [3, 3]], damage: 2 }, { units: [[1, 2]], damage: 20 });
    for (const name of EVALUATORS) {
        const ev = loadEvaluator(name);
        const p1 = ev.predict(s, 'p1', { view: 'objective' });
        assert.ok(p1 > 0.5, `${name} gives p1 ${p1}`);
    }
});

test('fitted models are antisymmetric: both players agree under the objective view', () => {
    const s = state({ units: [[2, 3]], damage: 5 }, { units: [[3, 4]], damage: 9 }, null);
    for (const name of ['linear', 'mlp']) {
        const ev = loadEvaluator(name);
        const a = ev.predict(s, 'p1', { view: 'objective' });
        const b = ev.predict(s, 'p2', { view: 'objective' });
        assert.ok(Math.abs(a + b - 1) < 1e-9, `${name}: ${a} + ${b}`);
    }
});

test('a destroyed base is decided', () => {
    const s = state({}, { damage: 28 });
    assert.strictEqual(loadEvaluator('linear').predict(s, 'p1'), 1);
    assert.strictEqual(loadEvaluator('linear').predict(s, 'p2'), 0);
});

test('h@ names resolve through the bot registry', () => {
    const { makeBot, describeBot } = require('../players');
    assert.strictEqual(describeBot('h2@linear').depth, 2);
    const b = makeBot('h@race');
    assert.strictEqual(b.name, 'h@race');
    assert.strictEqual(typeof b.evaluate, 'function');
});
