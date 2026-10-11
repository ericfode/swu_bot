'use strict';
// node --test bot/test/   (no card data needed)
const test = require('node:test');
const assert = require('node:assert');
const { sequentialElo, bradleyTerry, wilson, roundRobin } = require('../ratings');
const { summarize, scoreOf } = require('../ladder-report');

test('roundRobin plays each seed from both seats and rounds games up to even', () => {
    const s = roundRobin(['a', 'b', 'c'], 3, 10);
    assert.strictEqual(s.length, 3 * 4);
    const ab = s.filter((g) => [g.p1, g.p2].sort().join() === 'a,b');
    assert.deepStrictEqual(ab.map((g) => [g.seed, g.p1]), [[10, 'a'], [10, 'b'], [11, 'a'], [11, 'b']]);
    assert.strictEqual(new Set(s.map((g) => g.seed)).size, 6);
});

test('sequential Elo is zero-sum and moves toward the winner', () => {
    const { ratings, history } = sequentialElo(['a', 'b'], [{ a: 'a', b: 'b', score: 1 }]);
    assert.strictEqual(ratings.a, 1512);
    assert.strictEqual(ratings.b, 1488);
    assert.strictEqual(history.length, 1);
});

test('Bradley-Terry recovers a 3:1 strength ratio (~191 Elo)', () => {
    const results = [];
    for (let i = 0; i < 300; i++) {
        results.push({ a: 'x', b: 'y', score: 1 }, { a: 'y', b: 'x', score: 0 }, { a: 'x', b: 'y', score: 1 }, { a: 'x', b: 'y', score: 0 });
    }
    const r = bradleyTerry(['x', 'y'], results, { prior: 0 });
    assert.ok(Math.abs(r.x - r.y - 400 * Math.log10(3)) < 0.5, `${r.x - r.y}`);
    assert.ok(Math.abs((r.x + r.y) / 2 - 1500) < 1e-6);
});

test('Bradley-Terry stays finite for an unbeaten bot and is transitive', () => {
    const results = [];
    for (let i = 0; i < 10; i++) {
        results.push({ a: 'a', b: 'b', score: 1 }, { a: 'b', b: 'c', score: 1 }, { a: 'a', b: 'c', score: 1 });
    }
    const r = bradleyTerry(['a', 'b', 'c'], results);
    assert.ok(Number.isFinite(r.a) && r.a > r.b && r.b > r.c);
});

test('wilson interval contains the point estimate', () => {
    const [lo, hi] = wilson(7, 10);
    assert.ok(lo < 0.7 && hi > 0.7 && lo > 0 && hi < 1);
});

test('summarize counts wins, draws and incomplete games and rates only finished ones', () => {
    const games = [
        { id: '1', seed: 1, p1: 'a', p2: 'b', winner: 'a', outcome: 'won', botStats: [{ windows: 10, ms: 100 }, null] },
        { id: '2', seed: 1, p1: 'b', p2: 'a', winner: 'a', outcome: 'won' },
        { id: '3', seed: 2, p1: 'a', p2: 'b', winner: 'draw', outcome: 'won' },
        { id: '4', seed: 2, p1: 'b', p2: 'a', winner: null, outcome: 'ERROR', error: 'boom' },
        { id: '5', seed: 3, p1: 'a', p2: 'b', winner: null, outcome: 'running' }
    ];
    const doc = summarize({ id: 't', createdAt: 'now', status: 'running', engine: null, config: { bots: ['a', 'b'] }, botInfo: {}, games, scheduled: 6 });
    assert.strictEqual(doc.schema, 'swu-ladder/1');
    assert.deepStrictEqual(doc.progress, { scheduled: 6, finished: 4, rated: 3, outcomes: { won: 3, ERROR: 1 } });
    const a = doc.bots.find((b) => b.name === 'a');
    assert.deepStrictEqual([a.wins, a.losses, a.draws, a.incomplete, a.games], [2, 0, 1, 1, 4]);
    assert.strictEqual(a.winRate, 2.5 / 3);
    assert.strictEqual(a.msPerWindow, 10);
    assert.strictEqual(doc.bots[0].name, 'a');
    assert.deepStrictEqual(doc.pairs[0], { a: 'a', b: 'b', games: 4, aWins: 2, bWins: 0, draws: 1, incomplete: 1, aScore: 2.5 / 3 });
    assert.strictEqual(doc.eloHistory.length, 3);
    assert.strictEqual(scoreOf(games[1]), 0);
    // a bot that breaks the game loses it; an engine error stays unrated
    assert.strictEqual(scoreOf({ p1: 'a', p2: 'b', winner: 'b', outcome: 'ERROR', by: 'p1' }), 0);
    assert.strictEqual(scoreOf({ p1: 'a', p2: 'b', winner: null, outcome: 'ERROR', by: null }), null);
});

test('timingSummary reports count, total and percentiles', () => {
    const { timingSummary } = require('../match');
    assert.deepStrictEqual(timingSummary([]), { n: 0, ms: 0, p50: 0, p95: 0, max: 0 });
    const t = timingSummary(Array.from({ length: 100 }, (_, i) => i + 1));
    assert.deepStrictEqual(t, { n: 100, ms: 5050, p50: 51, p95: 96, max: 100 });
});
