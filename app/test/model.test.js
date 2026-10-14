'use strict';
// node --test app/test/   (no card data or shared folder needed: small made-up inputs)
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/model.cjs');

const run = (id, createdAt, games, extra = {}) => ({ id, createdAt, games, ...extra });
const game = (id, p1, p2, winnerSeat, more = {}) => ({ id, p1, p2, outcome: 'won', winnerSeat, rounds: 6, steps: 300, ...more });

test('bradleyTerry: the winner rates higher, the mean is 1500 and the error shrinks with games', () => {
    const r = model.bradleyTerry(['a', 'b'], [{ a: 'a', b: 'b', score: 1 }, { a: 'a', b: 'b', score: 1 }, { a: 'a', b: 'b', score: 1 }, { a: 'b', b: 'a', score: 1 }]);
    assert.ok(r.a.rating > r.b.rating);
    assert.equal(Math.round((r.a.rating + r.b.rating) / 2), 1500);
    const more = model.bradleyTerry(['a', 'b'], Array.from({ length: 40 }, (_, i) => ({ a: 'a', b: 'b', score: i % 4 ? 1 : 0 })));
    assert.ok(more.a.se < r.a.se);
});

test('bradleyTerry: a bot with no games stays at the mean (prior)', () => {
    const r = model.bradleyTerry(['a', 'b', 'c'], [{ a: 'a', b: 'b', score: 1 }]);
    assert.ok(Math.abs(r.c.rating - 1500) < 5);
});

test('arenaHistory: the rating after each round matches the referee (all rounds so far, baselines pinned at 1500)', () => {
    // the referee's all-round rating (bot/arena/referee.js anchoredBT and globalElo): bot/ratings.js, then the baselines'
    // mean moved to 1500
    const { bradleyTerry } = require('../../bot/ratings');
    const referee = results => {
        const names = [...new Set(results.flatMap(x => [x.a, x.b]))], bt = bradleyTerry(names, results), shift = 1500 - (bt.base1 + bt.base2) / 2;
        return Object.fromEntries(names.map(n => [n, Math.round(bt[n] + shift)]));
    };
    const g = (a, b, score) => ({ a, b, score });
    const rounds = [
        { round: 0, ladderId: 'arena-r0', results: [g('x-v1', 'base1', 1), g('base2', 'x-v1', 1), g('base1', 'base2', 1), g('x-v1', 'base2', 0)] },
        { round: 1, ladderId: 'arena-r1', results: [g('x-v2', 'base1', 1), g('base2', 'x-v2', 0), g('x-v2', 'base2', 1), g('base1', 'base2', 0)] },
        { round: 2, ladderId: 'arena-h', pool: 'holdout', results: [g('x-v2', 'base1', 0)] },
    ];
    const h = model.arenaHistory({ rounds }, ['base1', 'base2']);
    assert.deepEqual(h.map(x => x.round), [0, 1], 'the held-out round is left out');
    assert.equal(h[0].ratings['x-v2'], undefined, 'a version has no rating before its first round');
    assert.deepEqual(h[0].ratings, referee(rounds[0].results));
    assert.deepEqual(h[1].ratings, referee([...rounds[0].results, ...rounds[1].results]), 'after the newest round it is the standings rating');
    assert.ok(Math.abs((h[1].ratings.base1 + h[1].ratings.base2) / 2 - 1500) <= 1);
});

test('canonical: the Atlas naming rule', () => {
    assert.equal(model.canonical('random-a', false), 'random');
    assert.equal(model.canonical('random', true), 'random');
    assert.equal(model.canonical('heuristic', false), 'legacy');
    assert.equal(model.canonical('aggro', false), 'legacy-aggro');
    assert.equal(model.canonical('heuristic', true), 'heuristic');
    assert.equal(model.canonical('c-clock', false), 'c-clock');
});

test('guessFamily: names to families', () => {
    assert.equal(model.guessFamily('random-b'), 'random');
    assert.equal(model.guessFamily('ismcts-b1-vlinear'), 'search');
    assert.equal(model.guessFamily('learned-vh'), 'learned');
    assert.equal(model.guessFamily('jev'), 'llm');
    assert.equal(model.guessFamily('rust-greedy2'), 'rules');
    assert.equal(model.guessFamily('c-clock'), 'heuristic');
    assert.equal(model.guessFamily('lisp'), 'other');
});

test('slimState and fullState: the small board keeps what the live grid and spot rules read', () => {
    const st = { round: 4, initiative: 'p2', players: {
        p1: { base: { hp: 30, d: 12 }, hand: [{}, {}, {}], res: { ready: 2, total: 5 }, leader: { dep: true }, ground: [{ p: 3, h: 4, d: 1 }], space: [] },
        p2: { base: { hp: 28, d: 3 }, hand: 5, res: { ready: 0, total: 5 }, leader: {}, ground: [], space: [{ p: 2, h: 2, d: 0 }] },
    } };
    const s = model.slimState(st);
    assert.deepEqual(s, { r: 4, i: 'p2', p1: { b: [30, 12], h: 3, r: [2, 5], l: 1, g: [[3, 4, 1]], s: [] }, p2: { b: [28, 3], h: 5, r: [0, 5], l: 0, g: [], s: [[2, 2, 0]] } });
    const f = model.fullState(s);
    assert.equal(f.round, 4);
    assert.deepEqual(f.players.p1.base, { hp: 30, d: 12 });
    assert.equal(f.players.p2.hand, 5);
    assert.deepEqual(f.players.p2.space, [{ p: 2, h: 2, d: 0 }]);
    assert.equal(model.slimState(null), null);
});

function tinySources() {
    // an old run (before the heuristic fix) and a new one; c-clock forfeits once by time
    const old = run('league-1', '2026-10-11T08:00:00Z', [game('g1', 'heuristic', 'random-a', 'p1'), game('g2', 'random-b', 'heuristic', 'p2')], { bots: ['heuristic', 'random-a', 'random-b'] });
    const neu = run('c-ladder-1', '2026-10-11T15:00:00Z', [
        game('g3', 'c-clock', 'heuristic', 'p1'),
        game('g4', 'heuristic', 'c-clock', 'p2'),
        { id: 'g5', p1: 'c-clock', p2: 'heuristic', outcome: 'ERROR', error: 'TIME_FORFEIT c-clock' },
        { id: 'g6', p1: 'c-clock', p2: 'heuristic', outcome: 'running' },
    ], { bots: ['c-clock', 'heuristic'] });
    return {
        runs: [old, neu],
        about: [{ id: 'c-clock', family: 'heuristic', lang: 'c', owner: 'C bot', oneLine: 'Race-clock bot in C' }],
        panels: [{ id: 'c', title: 'C bot', thread: 'C bot', bots: ['c-clock'], thoughts: [] }],
        experiments: [{ id: 'x', title: 'X', owner: 'Position evaluation research', status: 'done', metrics: [] }],
        threads: { threads: [{ title: 'C bot', status: 'completed' }] },
    };
}

test('buildModel: Atlas names, records, forfeits and running games', () => {
    const M = model.buildModel(tinySources(), null, null, { builtAt: '2026-10-11T19:00:00Z' });
    assert.equal(M.builtAt, '2026-10-11T19:00:00Z');
    assert.ok(M.bots.random && !M.bots['random-a'], 'random-a and random-b are one bot');
    assert.ok(M.bots.legacy, 'the old run\'s heuristic is legacy');
    assert.equal(M.bots.legacy.games, 2);
    assert.equal(M.bots.heuristic.games, 3, 'the new run\'s heuristic keeps its name; the running game is not counted');
    assert.deepEqual([M.bots['c-clock'].w, M.bots['c-clock'].l, M.bots['c-clock'].faults], [2, 1, 1]);
    assert.equal(M.runs[1].running, 1);
    assert.equal(M.games.find(g => g[1] === 'g5')[7], 1, 'g5 is marked as a forfeit');
    assert.equal(M.bots['c-clock'].fam, 'heuristic');
    assert.equal(M.ratings.from, 'app');
    assert.ok(M.order.every(id => M.bots[id].ratingFrom === 'app'));
});

test('buildModel: games against people (a karabast* run, or any run a feed sent) stay out of the app', () => {
    const src = tinySources();
    src.runs.push({ id: 'karabast', createdAt: '2026-10-11T21:00:00Z', bots: ['c-clock'], games: [
        { id: 'karabast-1', p1: 'c-clock', p2: 'some-person', outcome: 'won', winnerSeat: 'p2' },
        { id: 'karabast-2', p1: 'opponent', p2: 'c-clock', outcome: 'running' },
    ] });
    src.runs.push({ id: 'sprite', feed: 'sprite', createdAt: '2026-10-11T21:00:00Z', games: [{ id: 'sprite-1', p1: 'c-clock', p2: 'heuristic', outcome: 'won', winnerSeat: 'p1' }] });
    const M = model.buildModel(src, null, null), plain = model.buildModel(tinySources(), null, null);
    assert.deepEqual(M.runs.map(r => r.id), plain.runs.map(r => r.id), 'neither run reaches the model');
    assert.equal(M.games.length, plain.games.length);
    assert.ok(!M.botList.includes('some-person') && !M.botList.includes('opponent'), 'no person reaches the model');
    assert.deepEqual([M.bots['c-clock'].w, M.bots['c-clock'].l], [2, 1], 'records unchanged');
    assert.equal(M.totals.runs, M.runs.length);
});

test('buildModel: ratings come from meta/ratings.json when it lists the bot', () => {
    const extra = { ratings: { generatedAt: '2026-10-11T19:06:00Z', rules: 'Strategy Atlas', bots: { 'c-clock': { rating: 1874, se: 35, games: 149 }, heuristic: { rating: 1700, se: 20, games: 600 } } } };
    const M = model.buildModel(tinySources(), extra, null);
    assert.equal(M.bots['c-clock'].rating, 1874);
    assert.equal(M.bots['c-clock'].se, 35);
    assert.equal(M.bots['c-clock'].ratingFrom, 'atlas');
    assert.equal(M.bots.random.ratingFrom, 'app', 'bots the file does not list fall back to the app\'s own fit');
    assert.equal(M.order[0], 'c-clock');
    assert.equal(M.ratings.from, 'meta/ratings.json');
});

test('loadExtra: reads ratings.json and survives missing or broken files', async () => {
    const files = { 'meta/ratings.json': JSON.stringify({ schema: 'swu-ratings/1', generatedAt: 't', bots: { a: { rating: 1600, se: 10, games: 5 } } }), 'arena/roster.json': '{not json' };
    const reader = { list: async () => [], text: async p => files[p] ?? null };
    const x = await model.loadExtra(reader);
    assert.deepEqual(x.ratings.bots.a, { rating: 1600, se: 10, games: 5 });
    assert.equal(x.arena.roster, null);
    assert.equal(x.meta, null);
    const none = await model.loadExtra({ list: async () => [], text: async () => null });
    assert.equal(none.ratings, null);
});

test('publicModel: no threads, owners or thread names; the input is not changed', () => {
    const M = model.buildModel(tinySources(), null, null);
    M.arena.competitors = [{ name: 'duel_opus', panel: { id: 'arena-duel_opus', thread: 'Competing Claude bot builders', title: 'Opus' } }];
    const P = model.publicModel(M);
    assert.deepEqual(P.threads, []);
    assert.equal(P.bots['c-clock'].owner, null);
    assert.equal(P.bots['c-clock'].card.owner, null);
    assert.equal(P.bots['c-clock'].card.oneLine, 'Race-clock bot in C');
    assert.deepEqual(P.panels, [], 'panels feed only Lab');
    assert.equal(P.arena.competitors[0].panel.thread, undefined);
    assert.equal(P.arena.competitors[0].panel.title, 'Opus');
    assert.equal(M.bots['c-clock'].owner, 'C bot');
    assert.equal(M.panels[0].thread, 'C bot');
    assert.ok(!JSON.stringify(P).includes('Position evaluation research'));
});

test('buildModel: a tournament keeps its round ladders and its rules (from tournament.json, else standings)', () => {
    const rounds = [{ n: 1, ladder: 'arena-t1-r1', workStart: 'a', workEnd: 'b' }, { n: 2, kind: 'holdout', ladder: 'arena-t1-r2' }];
    const own = model.buildModel(tinySources(), { arena: { tournament: { id: 'arena-t1', rounds, rules: { holdout: { fraction: 0.3 } } } } }, null);
    assert.equal(own.arena.tournament.rounds[1].ladder, 'arena-t1-r2');
    assert.equal(own.arena.tournament.rules.holdout.fraction, 0.3);
    const fromStandings = model.buildModel(tinySources(), { arena: { tournament: { id: 'arena-t1', rounds }, standings: { rounds: [], tournament: { rules: { holdout: { fraction: 0.25 } } } } } }, null);
    assert.equal(fromStandings.arena.tournament.rules.holdout.fraction, 0.25);
    const plain = model.buildModel(tinySources(), { arena: { tournament: { id: 'x', rounds: [] } } }, null);
    const roster = { agents: [{ name: 'act' }], bench: [{ name: 'off', benchedAt: '2026-10-12T05:00:00Z' }], baselines: [] };
    const cs = model.buildModel(tinySources(), { arena: { roster } }, null).arena.competitors;
    assert.deepEqual(cs.map((c) => [c.name, !!c.benched]), [['act', false], ['off', true]], 'a benched builder stays listed, marked');
    assert.equal(plain.arena.tournament.rules, null);
});

test('buildModel: the arena\'s own bots (resident entries) are no builders; each shows as a baseline in place of the built-in bot it replaces', () => {
    const roster = { agents: [{ name: 'kim_b' }, { name: 'heuristic', resident: true }, { name: 'c_clock', resident: true }, { name: 'rush', resident: true }], baselines: ['heuristic', 'rush', 'c-clock-wasm', 'py-clock-wasm'] };
    const versions = { kim_b: [{ v: 1, name: 'kim_b-v1' }], heuristic: [{ v: 1, name: 'heuristic-v1' }, { v: 2, name: 'heuristic-v2' }], c_clock: [{ v: 1, name: 'c_clock-v1' }] };
    const a = model.buildModel(tinySources(), { arena: { roster, versions } }, null).arena;
    assert.deepEqual(a.competitors.map(c => c.name), ['kim_b']);
    assert.deepEqual(a.baselines, ['heuristic-v2', 'c_clock-v1', 'rush', 'py-clock-wasm'], 'rush has no version yet: the built-in one still plays');
});

test('arenaHistory: a round\'s own anchors pin it, and an old round without them is pinned by its bots with no builder', () => {
    const g = (a, b, score) => ({ a, b, score });
    const rounds = [
        { round: 0, bots: [{ name: 'x-v1', agent: 'x' }, { name: 'base1', agent: null }], results: [g('x-v1', 'base1', 1), g('base1', 'x-v1', 1), g('x-v1', 'base1', 1)] },
        { round: 1, anchors: ['base1-v1'], bots: [{ name: 'x-v1', agent: 'x' }, { name: 'base1-v1', agent: null }], results: [g('x-v1', 'base1-v1', 0), g('base1-v1', 'x-v1', 1)] },
    ];
    const h = model.arenaHistory({ rounds }, []);
    assert.equal(Math.round(h[0].ratings.base1), 1500, 'only the built-in bot anchors the old round');
    assert.ok(Math.abs((h[1].ratings.base1 + h[1].ratings['base1-v1']) / 2 - 1500) <= 1);
});

test('buildModel: the hosted arena takes its phase and round from arena status, and an old tournament is only an archive', () => {
    const old = { id: 'arena-t0', state: 'done', rounds: [{ n: 1, ladder: 'arena-t0-r1', ladderStart: 'a', ladderEnd: 'b' }] };
    const playing = model.buildModel(tinySources(), { arena: { tournament: old, status: { tournament: null, round: 2, phase: 'ladder' } } }, null).arena;
    assert.deepEqual([playing.hosted, playing.phase, playing.current, playing.tournament, playing.deadline], [true, 'ladder', { n: 2 }, null, null]);
    const between = model.buildModel(tinySources(), { arena: { tournament: old, status: { tournament: null, round: 2, phase: 'idle' } } }, null).arena;
    assert.deepEqual([between.hosted, between.phase, between.current], [true, 'idle', { n: 2 }]);
    const none = model.buildModel(tinySources(), { arena: { status: { tournament: null, round: null, phase: 'idle' } } }, null).arena;
    assert.deepEqual([none.hosted, none.phase, none.current], [true, 'idle', null]);
    // a clocked tournament (its status names it) and a project folder with no status keep tournament.json's clock
    const clocked = model.buildModel(tinySources(), { arena: { tournament: old, status: { tournament: 'arena-t0', round: 1, phase: 'done' } } }, null).arena;
    assert.deepEqual([clocked.hosted, clocked.phase, clocked.tournament.id], [false, 'done', 'arena-t0']);
    const folder = model.buildModel(tinySources(), { arena: { tournament: old } }, null).arena;
    assert.deepEqual([folder.hosted, folder.phase], [false, 'done']);
});
