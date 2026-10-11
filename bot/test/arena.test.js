'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cappedScore, scoreRound } = require('../arena/referee');
const { roster } = require('../arena/home');

const cap = roster().thinkCapMs;
const t = (p1, p2) => ({ p1: { ms: p1, n: 10, p95: 1 }, p2: { ms: p2, n: 10, p95: 1 } });

test('time forfeit error is a loss for the named bot', () => {
    const g = { p1: 'a-v1', p2: 'rush', outcome: 'ERROR', error: `TIME_FORFEIT a-v1 thought ${cap + 1} ms (cap ${cap})`, timing: t(5, 5) };
    assert.deepStrictEqual(cappedScore(g), { score: 0, forfeit: [true, false] });
    assert.strictEqual(cappedScore({ ...g, error: `TIME_FORFEIT rush thought 1 ms` }).score, 1);
});

test('over the cap after the fact loses even a won game; both over is no result', () => {
    assert.strictEqual(cappedScore({ p1: 'a', p2: 'b', outcome: 'won', winner: 'a', timing: t(cap + 1, 5) }).score, 0);
    assert.strictEqual(cappedScore({ p1: 'a', p2: 'b', outcome: 'won', winner: 'a', timing: t(cap + 1, cap + 1) }).score, null);
    assert.strictEqual(cappedScore({ p1: 'a', p2: 'b', outcome: 'won', winner: 'b', timing: t(5, 5) }).score, 0);
    assert.strictEqual(cappedScore({ p1: 'a', p2: 'b', outcome: 'ERROR', error: 'engine', timing: t(5, 5) }).score, null);
});

test('scoreRound counts results, lost games and pins the baselines to 1500', () => {
    const games = [
        { id: 'g1', p1: 'x-v0', p2: 'rush', outcome: 'won', winner: 'x-v0', timing: t(5, 5), rounds: 5 },
        { id: 'g2', p1: 'rush', p2: 'x-v0', outcome: 'won', winner: 'rush', timing: t(5, 5), rounds: 6 },
        { id: 'g3', p1: 'x-v0', p2: 'heuristic', outcome: 'won', winner: 'x-v0', timing: t(5, 5), rounds: 7 },
        { id: 'g4', p1: 'heuristic', p2: 'x-v0', outcome: 'running' }
    ];
    const rd = scoreRound(3, { id: 'arena-r3', status: 'running', config: { bots: ['x-v0', 'rush', 'heuristic'], firstSeed: 3101, gamesPerPair: 2 }, progress: { scheduled: 4 }, games });
    const x = rd.bots.find((b) => b.name === 'x-v0');
    assert.strictEqual(x.wins, 2);
    assert.strictEqual(x.losses, 1);
    assert.strictEqual(x.lost[0].id, 'g2');
    assert.strictEqual(rd.games, 3);
    const bl = rd.bots.filter((b) => b.name !== 'x-v0');
    assert.ok(Math.abs((bl[0].btElo + bl[1].btElo) / 2 - 1500) <= 1);
});
