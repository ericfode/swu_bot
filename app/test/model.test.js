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

test('buildModel: games against people on Karabast show as their own run and stay out of bot records', () => {
    const src = tinySources();
    const game = (id, p1, p2, winnerSeat) => ({ id, p1, p2, outcome: 'won', winnerSeat });
    src.runs.push({ id: 'karabast', createdAt: '2026-10-11T21:00:00Z', bots: ['c-clock', 'opponent'], games: [
        game('karabast-1', 'c-clock', 'opponent', 'p2'),
        game('karabast-2', 'opponent', 'c-clock', 'p1'),
        { id: 'karabast-3', p1: 'c-clock', p2: 'opponent', outcome: 'running' },
        { id: 'karabast-4', p1: 'opponent', p2: 'c-clock', outcome: 'won', winnerSeat: 'draw' },
        { id: 'karabast-5', p1: 'c-clock', p2: 'opponent', outcome: 'abandoned' },
    ] });
    const M = model.buildModel(src, null, null);
    const r = M.runs.find(x => x.id === 'karabast');
    assert.equal(r.kind, 'people');
    assert.deepEqual([r.decided, r.running, r.errors, r.abandoned], [3, 1, 0, 1], 'a draw is a finished game; an abandoned one is neither');
    assert.deepEqual(r.table.find(t => t.id === 'c-clock'), { id: 'c-clock', w: 0, l: 2, d: 1, n: 3, pct: 1 / 6 });
    assert.deepEqual([M.bots['c-clock'].w, M.bots['c-clock'].l], [2, 1], 'c-clock\'s bot record is unchanged');
    assert.ok(!M.bots.opponent, 'people are not bots');
    assert.equal(M.games.filter(g => M.runs[g[0]].id === 'karabast').length, 5, 'every game stays listed');
    assert.equal(M.games.find(g => g[1] === 'karabast-5')[4], 5, 'an abandoned game keeps its own result code, apart from engine errors');
});

test('buildModel: a run any outside feed sent is never rated, whatever its name', () => {
    const src = tinySources();
    src.runs.push({ id: 'sprite', feed: 'sprite', createdAt: '2026-10-11T21:00:00Z', games: [{ id: 'sprite-1', p1: 'c-clock', p2: 'heuristic', outcome: 'won', winnerSeat: 'p1' }] });
    const M = model.buildModel(src, null, null);
    assert.equal(M.runs.find(x => x.id === 'sprite').kind, 'people');
    assert.deepEqual([M.bots['c-clock'].w, M.bots['c-clock'].l], [2, 1], 'records unchanged');
    src.runs.push({ id: 'sprite-2', feed: 'sprite', createdAt: '2026-10-11T22:00:00Z', games: [{ id: 'sprite-2', p1: 'c-clock', p2: 'opponent', outcome: 'running' }] });
    assert.deepEqual(model.buildModel(src, null, null).runs.find(x => x.id === 'sprite-2').bots, ['c-clock', 'opponent'], 'a run with no bots list and no finished game still names its seats');
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
    assert.ok(P.panels.every(p => !('thread' in p)));
    assert.ok(P.experiments.every(e => !('owner' in e)));
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
    assert.equal(plain.arena.tournament.rules, null);
});
