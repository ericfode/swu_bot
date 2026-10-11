'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// a scratch arena, results folder, dashboard and secret: nothing here touches the project's shared folders
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-test-'));
process.env.ARENA_HOME = path.join(tmp, 'arena');
process.env.ARENA_RESULTS = path.join(tmp, 'results');
process.env.ARENA_DASH = path.join(tmp, 'dash');
process.env.ARENA_SECRET_FILE = path.join(tmp, 'secret');
fs.mkdirSync(process.env.ARENA_DASH, { recursive: true });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { cappedScore, scoreRound, globalElo, lineup, roundSeed, loadSecret } = require('../arena/referee');
const dash = require('../arena/dash');
const { HOME, writeJson, readJson } = require('../arena/home');

const t = (p1, p2) => ({ p1: { ms: p1, n: 10, p95: 1 }, p2: { ms: p2, n: 10, p95: 1 } });
const dashFile = (...p) => readJson(path.join(process.env.ARENA_DASH, ...p), null);
const ladderOf = (bots, games, status = 'running') => ({ id: 'arena-r1', status, config: { bots, firstSeed: 77, gamesPerPair: 2 }, progress: { scheduled: 4 }, games });

function setRoster(agents, baselines = ['rush', 'heuristic']) {
    writeJson(path.join(HOME, 'roster.json'), { thinkCapMs: 60000, baselines, agents: agents.map((name) => ({ name, title: name, start: 'rush', philosophy: `${name}'s prompt` })) });
}

test('a fault seat loses whatever else the record says; the rest scores only when played out', () => {
    const g = { p1: 'a-v1', p2: 'rush', timing: t(5, 5) };
    assert.deepStrictEqual(cappedScore({ ...g, outcome: 'forfeit', fault: 'p1', faultKind: 'time', winner: 'rush', winnerSeat: 'p2' }), { score: 0, forfeit: [true, false] });
    assert.deepStrictEqual(cappedScore({ ...g, outcome: 'forfeit', fault: 'p2', faultKind: 'hang', winner: 'a-v1', winnerSeat: 'p1' }), { score: 1, forfeit: [false, true] });
    assert.strictEqual(cappedScore({ ...g, outcome: 'forfeit', fault: 'p2', faultKind: 'load' }).score, 1);
    assert.strictEqual(cappedScore({ ...g, outcome: 'won', winner: 'a-v1', winnerSeat: 'p1', fault: null }).score, 1);
    assert.strictEqual(cappedScore({ ...g, outcome: 'won', winner: 'rush', winnerSeat: 'p2', fault: null }).score, 0);
    assert.strictEqual(cappedScore({ ...g, outcome: 'won', winner: 'draw', winnerSeat: 'draw' }).score, 0.5);
    assert.strictEqual(cappedScore({ ...g, outcome: 'won', winner: 'a-v1' }).score, 1, 'records without winnerSeat');
    // both seats at fault, or an engine error: unrated, nobody forfeits
    assert.deepStrictEqual(cappedScore({ ...g, outcome: 'ERROR', fault: null, error: 'engine' }), { score: null, forfeit: [false, false] });
});

test('the cap comes from the fault, not from timing or error text', () => {
    const g = { p1: 'a', p2: 'b', timing: t(10 * 60000, 5) };
    assert.strictEqual(cappedScore({ ...g, outcome: 'won', winner: 'a', winnerSeat: 'p1', fault: null }).score, 1);
    assert.strictEqual(cappedScore({ ...g, outcome: 'ERROR', error: 'TIME_FORFEIT a thought 70000 ms (cap 60000)', fault: null }).score, null);
});

test('scoreRound counts results, forfeits, lost games and pins the baselines to 1500', () => {
    setRoster(['x']);
    const games = [
        { id: 'g1', p1: 'x-v0', p2: 'rush', outcome: 'won', winner: 'x-v0', winnerSeat: 'p1', timing: t(5, 5), rounds: 5 },
        { id: 'g2', p1: 'rush', p2: 'x-v0', outcome: 'won', winner: 'rush', winnerSeat: 'p1', timing: t(5, 5), rounds: 6 },
        { id: 'g3', p1: 'x-v0', p2: 'heuristic', outcome: 'won', winner: 'x-v0', winnerSeat: 'p1', timing: t(5, 5), rounds: 7 },
        { id: 'g4', p1: 'heuristic', p2: 'x-v0', outcome: 'forfeit', fault: 'p2', faultKind: 'time', winner: 'heuristic', winnerSeat: 'p1', timing: t(5, 5), rounds: 3 },
        { id: 'g5', p1: 'rush', p2: 'heuristic', outcome: 'running' }
    ];
    const rd = scoreRound(3, ladderOf(['x-v0', 'rush', 'heuristic'], games));
    const x = rd.bots.find((b) => b.name === 'x-v0');
    assert.strictEqual(x.wins, 2);
    assert.strictEqual(x.losses, 2);
    assert.strictEqual(x.forfeits, 1);
    assert.deepStrictEqual(x.lost.map((l) => [l.id, l.forfeit, l.faultKind]), [['g2', false, null], ['g4', true, 'time']]);
    assert.strictEqual(rd.games, 4);
    assert.strictEqual(rd.leader, 'x-v0');
    const bl = rd.bots.filter((b) => b.name !== 'x-v0');
    assert.ok(Math.abs((bl[0].btElo + bl[1].btElo) / 2 - 1500) <= 1);
});

test('a round without rated games has no Elo, ranks or leader', () => {
    setRoster(['x']);
    const rd = scoreRound(1, ladderOf(['x-v0', 'rush'], [{ id: 'g1', p1: 'x-v0', p2: 'rush', outcome: 'running' }, { id: 'g2', p1: 'rush', p2: 'x-v0', outcome: 'ERROR', fault: null }]));
    assert.strictEqual(rd.leader, null);
    assert.strictEqual(rd.rated, 0);
    assert.ok(rd.bots.every((b) => b.btElo === null && b.rank === null));
    assert.deepStrictEqual(globalElo([rd]), {});
});

test('round seeds: stable for the same secret, tournament and round; different otherwise', () => {
    const s = 'ab'.repeat(32);
    const k1 = roundSeed(s, 'arena-t1', 1);
    assert.strictEqual(roundSeed(s, 'arena-t1', 1), k1);
    assert.ok(Number.isInteger(k1) && k1 >= 0 && k1 < 2 ** 32);
    assert.notStrictEqual(roundSeed(s, 'arena-t1', 2), k1);
    assert.notStrictEqual(roundSeed(s, 'arena-t2', 1), k1);
    assert.notStrictEqual(roundSeed('cd'.repeat(32), 'arena-t1', 1), k1);
    const secret = loadSecret();
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.strictEqual(loadSecret(), secret, 'created once, then reused');
    assert.strictEqual(fs.statSync(process.env.ARENA_SECRET_FILE).mode & 0o077, 0, 'only the owner can read it');
});

test('lineup takes the newest version submitted by the cutoff', () => {
    setRoster(['a', 'b']);
    const version = (name, submittedAt, code = true) => {
        writeJson(path.join(HOME, 'versions', name, 'SUBMISSION.json'), { name, note: 'n', ...(submittedAt ? { submittedAt } : {}) });
        if (code) {
            fs.writeFileSync(path.join(HOME, 'versions', name, 'bot.js'), 'module.exports = {};\n');
        }
    };
    version('a-v0', '2026-10-11T10:00:00.000Z');
    version('a-v1', '2026-10-11T10:45:00.000Z');
    version('a-v2', '2026-10-11T11:00:00.000Z');
    version('b-v0', null); // older submissions have no submittedAt: they always count
    version('b-v1', '2026-10-11T11:30:00.000Z');
    assert.deepStrictEqual(lineup('2026-10-11T10:45:00.000Z'), ['a-v1', 'b-v0', 'rush', 'heuristic']);
    assert.deepStrictEqual(lineup('2026-10-11T09:00:00.000Z'), ['b-v0', 'rush', 'heuristic']);
    assert.deepStrictEqual(lineup(), ['a-v2', 'b-v1', 'rush', 'heuristic']);
    version('a-v3', '2026-10-11T11:40:00.000Z', false); // no bot.js: the newest version that loads plays instead
    assert.deepStrictEqual(lineup(), ['a-v2', 'b-v1', 'rush', 'heuristic']);
});

test('dashboard: a round without games shows "no games yet", not an invented Elo or leader', () => {
    setRoster(['nog']);
    const rd = scoreRound(1, ladderOf(['nog-v0', 'rush'], [{ id: 'g1', p1: 'nog-v0', p2: 'rush', outcome: 'running' }]));
    dash.publishStandings({ status: 'running', rounds: [rd], global: globalElo([rd]), tournament: { id: 't', plannedRounds: 3, rounds: [1] } });
    const lb = dashFile('panels', 'arena-leaderboard.json');
    assert.deepStrictEqual(lb.bots, [], 'the leaderboard is a summary panel');
    assert.match(lb.now, /no games yet/);
    assert.ok(lb.widgets[0].rows.every((row) => row[0] === '-' && row[3] === 'no games yet'));
    const ex = dashFile('experiments', 'arena.json');
    assert.strictEqual(ex.metrics[0].value, 'no games yet');
    assert.deepStrictEqual(ex.progress, { done: 0, total: 3, unit: 'rounds' });
    assert.deepStrictEqual(ex.chart.series, [{ name: 'nog', points: [] }]);
    const items = Object.fromEntries(dashFile('panels', 'arena-nog.json').widgets[0].items.map((i) => [i.label, i.value]));
    assert.strictEqual(items['Elo (all rounds)'], 'no games yet');
    assert.strictEqual(items['rank in round 1'], 'no games yet');
});

test('dashboard: progress counts planned rounds, series are best first, and done is done', () => {
    setRoster(['lo', 'hi']);
    const win = (id, w, l) => ({ id, p1: w, p2: l, outcome: 'won', winner: w, winnerSeat: 'p1', timing: t(5, 5), rounds: 5 });
    const rd = scoreRound(1, ladderOf(['lo-v0', 'hi-v0', 'rush'], [win('g1', 'hi-v0', 'rush'), win('g2', 'hi-v0', 'lo-v0'), win('g3', 'rush', 'lo-v0')], 'done'));
    dash.publishStandings({ status: 'done', rounds: [rd], global: globalElo([rd]), tournament: { id: 't', plannedRounds: 2, rounds: [1] } });
    const ex = dashFile('experiments', 'arena.json');
    assert.strictEqual(ex.status, 'done');
    assert.deepStrictEqual(ex.progress, { done: 1, total: 2, unit: 'rounds' });
    assert.deepStrictEqual(ex.chart.series.map((s) => s.name), ['hi', 'lo']);
    assert.strictEqual(ex.metrics[0].value, 'hi-v0');
    assert.strictEqual(dashFile('panels', 'arena-leaderboard.json').status, 'done');
    assert.strictEqual(dashFile('panels', 'arena-lo.json').status, 'done');
});

test('dashboard: say and the referee write separate halves, so neither loses the other\'s update', () => {
    setRoster(['half']);
    const diagram = { type: 'strategy', title: 'd', nodes: [{ id: 'n', label: 'n', kind: 'input' }], edges: [], highlight: [], steps: [] };
    dash.updatePanel('half', { now: 'tuning', thought: 'first', diagram, plan: [null, '', '  ', 'a', { text: 'b', state: 'doing' }, { text: 7, state: 'bogus' }, { state: 'done' }, ...Array(20).fill('more')] });
    const rd = scoreRound(1, ladderOf(['half-v0', 'rush'], [{ id: 'g1', p1: 'half-v0', p2: 'rush', outcome: 'won', winner: 'half-v0', winnerSeat: 'p1', timing: t(5, 5), rounds: 4 }], 'done'));
    dash.publishStandings({ status: 'running', rounds: [rd], global: globalElo([rd]) });
    let p = dashFile('panels', 'arena-half.json');
    assert.strictEqual(p.now, 'tuning');
    assert.strictEqual(p.thoughts[0].text, 'first');
    assert.deepStrictEqual(p.widgets.map((w) => w.type), ['strategy', 'stats', 'line', 'line', 'table', 'text']);
    assert.strictEqual(p.plan.length, 12);
    assert.deepStrictEqual(p.plan.slice(0, 3), [{ text: 'a', state: 'todo' }, { text: 'b', state: 'doing' }, { text: '7', state: 'todo' }]);
    assert.ok(p.plan.every((x) => typeof x.text === 'string' && x.text));
    dash.updatePanel('half', { thought: 'second' });
    p = dashFile('panels', 'arena-half.json');
    assert.deepStrictEqual(p.bots, ['half-v0'], 'the referee\'s fields survive a later say');
    assert.deepStrictEqual(p.thoughts.map((x) => x.text), ['first', 'second']);
    assert.strictEqual(p.widgets[0].type, 'strategy');
    assert.ok(fs.existsSync(path.join(HOME, 'panels', 'half.say.json')) && fs.existsSync(path.join(HOME, 'panels', 'half.rated.json')));
});

test('eval reads results from fault and winnerSeat', () => {
    const { resultFor } = require('../arena/eval');
    assert.strictEqual(resultFor({ outcome: 'forfeit', fault: 'p1', winnerSeat: 'p2' }, 'p1'), 'loss');
    assert.strictEqual(resultFor({ outcome: 'forfeit', fault: 'p1', winnerSeat: 'p2' }, 'p2'), 'win');
    assert.strictEqual(resultFor({ outcome: 'won', winner: 'me', winnerSeat: 'p2', fault: null }, 'p2'), 'win');
    assert.strictEqual(resultFor({ outcome: 'won', winner: 'draw', winnerSeat: 'draw' }, 'p1'), 'draw');
    assert.strictEqual(resultFor({ outcome: 'ERROR', fault: null, error: 'TIME_FORFEIT me' }, 'p1'), 'ERROR');
});
