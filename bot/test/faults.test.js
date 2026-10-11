'use strict';
// Fault attribution: the choose() guard (players/guard.js) and how the ladder report scores forfeits.
const test = require('node:test');
const assert = require('node:assert');
const { guard } = require('../players/guard');
const { summarize, scoreOf } = require('../ladder-report');

const actions = [{ kind: 'button', label: 'Pass' }, { kind: 'button', label: 'Claim' }];
const ctx = { game: null, pid: 'x', actions, rng: () => 0 };
const cpuNow = () => {
    const u = process.threadCpuUsage();
    return (u.user + u.system) / 1000;
};

test('guard passes actions through and adds up thinking time', () => {
    const calls = [];
    const bot = guard({ name: 'b', choose: (c) => c.actions[1] }, { onEnter: () => calls.push('in'), onExit: () => calls.push('out') });
    assert.strictEqual(bot.choose(ctx), actions[1]);
    assert.strictEqual(bot.choose(ctx), actions[1]);
    assert.deepStrictEqual(calls, ['in', 'out', 'in', 'out']);
    assert.strictEqual(bot.fault, null);
    assert.ok(bot.thinkMs >= 0);
});

test('guard records a throw or a non-action as an error fault and rethrows', () => {
    const boom = guard({ name: 'b', choose: () => { throw new Error('boom\nstack'); } });
    assert.throws(() => boom.choose(ctx), /boom/);
    assert.deepStrictEqual(boom.fault, { kind: 'error', message: 'boom' });
    const nothing = guard({ name: 'n', choose: () => undefined });
    assert.throws(() => nothing.choose(ctx), /not one of the legal actions/);
    assert.strictEqual(nothing.fault.kind, 'error');
});

test('guard throws TIME_FORFEIT once CPU thinking goes over the cap', () => {
    const bot = guard({
        name: 'slow',
        choose: (c) => {
            const end = cpuNow() + 40;
            while (cpuNow() < end) {
                // burn this thread's CPU
            }
            return c.actions[0];
        }
    }, { capMs: 20 });
    assert.throws(() => bot.choose(ctx), /TIME_FORFEIT slow/);
    assert.strictEqual(bot.fault.kind, 'time');
    assert.ok(bot.fault.ms > 20);
});

test('a choose() that calls this.choose() is timed and announced once', () => {
    let enters = 0;
    const raw = {
        name: 'r',
        depth: 0,
        choose(c) {
            return this.depth++ === 0 ? this.choose(c) : c.actions[0];
        }
    };
    const bot = guard(raw, { onEnter: () => enters++ });
    assert.strictEqual(bot.choose(ctx), actions[0]);
    assert.strictEqual(enters, 1);
});

test('forfeits count as decided games and per-bot forfeits', () => {
    const games = [
        { id: '1', p1: 'a', p2: 'b', winner: 'b', winnerSeat: 'p2', outcome: 'forfeit', fault: 'p1', faultKind: 'time' },
        { id: '2', p1: 'b', p2: 'a', winner: 'b', winnerSeat: 'p1', outcome: 'won', fault: null },
        { id: '3', p1: 'a', p2: 'b', winner: null, outcome: 'ERROR', fault: null, error: 'LOAD a; LOAD b' }
    ];
    assert.strictEqual(scoreOf(games[0]), 0);
    const doc = summarize({ id: 't', createdAt: 'now', status: 'done', engine: null, config: { bots: ['a', 'b'] }, botInfo: {}, games, scheduled: 3 });
    assert.deepStrictEqual(doc.progress, { scheduled: 3, finished: 3, rated: 2, outcomes: { forfeit: 1, won: 1, ERROR: 1 } });
    const a = doc.bots.find((x) => x.name === 'a');
    assert.deepStrictEqual([a.wins, a.losses, a.incomplete, a.forfeits], [0, 2, 1, 1]);
    assert.strictEqual(doc.bots.find((x) => x.name === 'b').forfeits, 0);
    assert.strictEqual(doc.pairs[0].bWins, 2);
    // seat advantage only from played-out games: the one 'won' game was a p1 win
    assert.strictEqual(doc.firstSeatWinRate, 1);
});

test('guard: a bot cannot reset its counters, unwrap the guard, or play an action that is not legal', () => {
    const ctx = { actions: [{ kind: 'button', label: 'Pass' }, { kind: 'card', label: 'X', cardUuid: 'u1' }] };
    const burn = (ms) => { const t = cpuNow(); while (cpuNow() - t < ms) { /* busy */ } };
    const cheat = guard({
        name: 'cheat', thinkMs: 0,
        choose(c) {
            burn(15);
            this.thinkMs = 0; // its own field, not the guard's
            this.choose = () => c.actions[0]; // replaces its own method, not the guarded one
            return { kind: 'card', label: 'X', cardUuid: 'u1' }; // a copy of a legal action is fine
        }
    }, { capMs: 40 });
    assert.strictEqual(cheat.choose(ctx), ctx.actions[1]);
    assert.ok(cheat.thinkMs >= 10, `thinkMs ${cheat.thinkMs} wall ${cheat.wallMs}`);
    assert.throws(() => { cheat.choose(ctx); cheat.choose(ctx); cheat.choose(ctx); }, /TIME_FORFEIT/);
    assert.strictEqual(cheat.fault.kind, 'time');
    assert.throws(() => { cheat.thinkMs = 0; }, TypeError, 'counters are read-only');

    const bogus = guard({ name: 'bogus', choose: () => ({ kind: 'nope', label: 'win' }) });
    assert.throws(() => bogus.choose(ctx), /not one of the legal actions/);
    assert.strictEqual(bogus.fault.kind, 'error');

    const sleeper = guard({ name: 'sleeper', choose: (c) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30); return c.actions[0]; } }, { capMs: 1000, wallCapMs: 50 });
    sleeper.choose(ctx);
    assert.throws(() => sleeper.choose(ctx), /TIME_FORFEIT/, 'waiting off-CPU still counts against the wall cap');
});

test('guard keeps a bot\'s own damage split on the live distribute action, and refuses one that is not legal', () => {
    const live = { kind: 'distribute', label: 'distribute 3', spec: { amount: 3, maxTargets: 3 }, targets: ['a', 'b', 'c'], caps: [3, 2, 3], uuid: 'now' };
    const ctx = { pid: 'x', actions: [live], game: { refetch: () => live } };
    const split = (targets, caps) => guard({ name: 's', choose: () => ({ ...live, uuid: 'old', targets, caps, spec: { ...live.spec, maxTargets: targets.length } }) });
    assert.deepStrictEqual(split(['c', 'a'], [2, 1]).choose(ctx), { ...live, targets: ['c', 'a'], caps: [2, 1], spec: { amount: 3, maxTargets: 2 } });
    assert.deepStrictEqual(guard({ name: 'r', choose: (c) => c.actions[0] }).choose(ctx), live, 'the plain action stays a random split');
    // refetch builds new objects, and uncapped targets have cap Infinity: a copy of the live action is legal
    const open = { ...live, label: 'distribute 2', spec: { amount: 2 }, caps: [Infinity, 1, Infinity] };
    const copy = guard({ name: 'c', choose: (c) => ({ ...c.actions[0] }) });
    assert.deepStrictEqual(copy.choose({ pid: 'x', actions: [open], game: { refetch: () => ({ ...open }) } }), open);
    for (const [targets, caps] of [[['b'], [3]], [['z'], [3]], [['a'], [2]], [['a', 'a'], [1, 2]]]) {
        const bot = split(targets, caps);
        assert.throws(() => bot.choose(ctx), /not one of the legal actions/, JSON.stringify([targets, caps]));
        assert.strictEqual(bot.fault.kind, 'error');
    }
});
