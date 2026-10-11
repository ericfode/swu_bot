'use strict';
// Fault attribution: the bot guard (players/guard.js) and how the ladder report scores games a bot broke.
const test = require('node:test');
const assert = require('node:assert');
const { guard } = require('../players/guard');
const { summarize, scoreOf } = require('../ladder-report');

const actions = [{ kind: 'button', label: 'Pass' }, { kind: 'button', label: 'Claim' }];
const ctx = { game: null, pid: 'x', actions, rng: () => 0 };
const plain = (a) => ({ kind: a.kind, label: a.label, cardUuid: a.cardUuid, arg: a.arg });
const cpuNow = () => {
    const u = process.threadCpuUsage();
    return (u.user + u.system) / 1000;
};
const burn = (ms) => {
    const t = cpuNow();
    while (cpuNow() - t < ms) {
        // burn this thread's CPU
    }
};

test('guard answers with a plain copy of the action and adds up thinking time', async () => {
    const calls = [];
    const bot = guard({ name: 'b', choose: (c) => c.actions[1] }, { enter: () => calls.push('in'), leave: () => calls.push('out') });
    assert.deepStrictEqual(await bot.choose(ctx), plain(actions[1]));
    assert.deepStrictEqual(await bot.choose(ctx), plain(actions[1]));
    assert.deepStrictEqual(calls, ['in', 'out', 'in', 'out']);
    assert.strictEqual(bot.fault, null);
    assert.ok(bot.thinkMs >= 0);
    const later = guard({ name: 'p', choose: async (c) => c.actions[0] });
    assert.deepStrictEqual(await later.choose(ctx), plain(actions[0]), 'choose may return a promise');
});

test('guard records a throw or a rejection as an error fault; a non-action is left to the referee', async () => {
    const boom = guard({ name: 'b', choose: () => { throw new Error('boom\nstack'); } });
    await assert.rejects(boom.choose(ctx), /boom/);
    assert.deepStrictEqual(boom.fault, { kind: 'error', message: 'boom' });
    const rejects = guard({ name: 'r', choose: async () => { throw new Error('later'); } });
    await assert.rejects(rejects.choose(ctx), /later/);
    assert.strictEqual(rejects.fault.kind, 'error');
    // match.js (protocol.js NativeSeat) finds no legal action for null and makes the game this bot's loss
    const nothing = guard({ name: 'n', choose: () => undefined });
    assert.strictEqual(await nothing.choose(ctx), null);
    assert.strictEqual(nothing.fault, null);
});

test('guard throws TIME_FORFEIT once CPU thinking goes over the cap', async () => {
    const bot = guard({ name: 'slow', choose: (c) => { burn(40); return c.actions[0]; } }, { capMs: 20 });
    await assert.rejects(bot.choose(ctx), /TIME_FORFEIT slow/);
    assert.strictEqual(bot.fault.kind, 'time');
    assert.ok(bot.fault.ms > 20);
    // already over: the next call fails before the bot runs
    await assert.rejects(bot.choose(ctx), /TIME_FORFEIT/);
});

test('a promise that does not settle is stopped when the wall budget runs out', async () => {
    const t0 = Date.now();
    const stuck = guard({ name: 'stuck', choose: () => new Promise(() => undefined) }, { capMs: 1000, wallCapMs: 60 });
    await assert.rejects(stuck.choose(ctx), /TIME_FORFEIT stuck/);
    assert.ok(Date.now() - t0 < 1000);
    assert.strictEqual(stuck.fault.kind, 'time');
});

test('a choose() that calls this.choose() is timed and announced once', async () => {
    let enters = 0;
    const raw = {
        name: 'r',
        depth: 0,
        choose(c) {
            return this.depth++ === 0 ? this.choose(c) : c.actions[0];
        }
    };
    const bot = guard(raw, { enter: () => enters++ });
    assert.deepStrictEqual(await bot.choose(ctx), plain(actions[0]));
    assert.strictEqual(enters, 1);
});

test('a game a bot broke (ERROR with by) is decided and counts as its forfeit; other ERRORs are incomplete', () => {
    const games = [
        { id: '1', p1: 'a', p2: 'b', winner: 'b', winnerSeat: 'p2', outcome: 'ERROR', by: 'p1', faultKind: 'time' },
        { id: '2', p1: 'b', p2: 'a', winner: 'b', winnerSeat: 'p1', outcome: 'won', by: null },
        { id: '3', p1: 'a', p2: 'b', winner: null, outcome: 'ERROR', by: null, error: 'LOAD a; LOAD b' }
    ];
    assert.strictEqual(scoreOf(games[0]), 0);
    const doc = summarize({ id: 't', createdAt: 'now', status: 'done', engine: null, config: { bots: ['a', 'b'] }, botInfo: {}, games, scheduled: 3 });
    assert.deepStrictEqual(doc.progress, { scheduled: 3, finished: 3, rated: 2, outcomes: { ERROR: 2, won: 1 } });
    const a = doc.bots.find((x) => x.name === 'a');
    assert.deepStrictEqual([a.wins, a.losses, a.incomplete, a.forfeits], [0, 2, 1, 1]);
    assert.strictEqual(doc.bots.find((x) => x.name === 'b').forfeits, 0);
    assert.strictEqual(doc.pairs[0].bWins, 2);
    // seat advantage only from played-out games: the one 'won' game was a p1 win
    assert.strictEqual(doc.firstSeatWinRate, 1);
});

test('guard: a bot cannot reset its counters or unwrap the guard, and off-CPU waiting counts against the wall cap', async () => {
    const cheat = guard({
        name: 'cheat', thinkMs: 0,
        choose(c) {
            burn(15);
            this.thinkMs = 0; // its own field, not the guard's
            this.choose = () => c.actions[0]; // replaces its own method, not the guarded one
            return { kind: 'button', label: 'Claim' };
        }
    }, { capMs: 40 });
    assert.deepStrictEqual(await cheat.choose(ctx), plain(actions[1]));
    assert.ok(cheat.thinkMs >= 10, `thinkMs ${cheat.thinkMs} wall ${cheat.wallMs}`);
    await assert.rejects(async () => {
        for (let i = 0; i < 4; i++) {
            await cheat.choose(ctx);
        }
    }, /TIME_FORFEIT/);
    assert.strictEqual(cheat.fault.kind, 'time');
    assert.throws(() => { cheat.thinkMs = 0; }, TypeError, 'counters are read-only');

    const sleeper = guard({ name: 'sleeper', choose: (c) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30); return c.actions[0]; } }, { capMs: 1000, wallCapMs: 50 });
    await sleeper.choose(ctx);
    await assert.rejects(sleeper.choose(ctx), /TIME_FORFEIT/);
});

test('guard: the answer is read once, inside the call, as primitives (a split as plain {id, amount} entries)', async () => {
    const tricky = guard({ name: 't', choose: () => ({ kind: 'button', get label() { throw new Error('getter'); } }) });
    await assert.rejects(tricky.choose(ctx), /getter/);
    assert.deepStrictEqual(tricky.fault, { kind: 'error', message: 'getter' });
    // a getter that changes its answer cannot pass the check with one value and play another
    let n = 0;
    const flip = guard({ name: 'f', choose: () => ({ kind: 'button', get label() { return n++ ? 'Nope' : 'Claim'; } }) });
    assert.deepStrictEqual(await flip.choose(ctx), plain(actions[1]));
    const odd = { toString: () => 'Claim' };
    const coerced = guard({ name: 'o', choose: () => ({ kind: 'button', label: odd, split: [{ get id() { return 'c4'; }, amount: 2, extra: 1 }] }) });
    assert.deepStrictEqual(await coerced.choose(ctx), { ...plain(actions[1]), split: [{ id: 'c4', amount: 2 }] });
    const bad = guard({ name: 'b', choose: () => ({ kind: 'button', label: 'Claim', split: { length: 1 } }) });
    assert.strictEqual((await bad.choose(ctx)).split, 'not an array');
});

test('guard: a throw from close() is ignored; name and needsUndo are read once; a throwing stats getter reads as null', async () => {
    const closer = guard({ name: 'c', choose: (c) => c.actions[0], close: () => { throw new Error('close'); } });
    await closer.choose(ctx);
    await assert.doesNotReject(closer.close());
    assert.strictEqual(closer.fault, null);
    let reads = 0;
    const bot = guard({ get name() { reads++; return 'g'; }, needsUndo: true, get stats() { throw new Error('stats'); }, choose: (c) => c.actions[0] });
    assert.strictEqual(bot.name, 'g');
    assert.strictEqual(bot.name, 'g');
    assert.strictEqual(reads, 1);
    assert.strictEqual(bot.needsUndo, true);
    assert.strictEqual(bot.stats, null);
    assert.throws(() => guard({ name: 'none' }), /choose\(\) .* or decide\(\)/);
});

test('guard: loadMs given as a clock is read after the bot\'s getters, so their work counts as load time', () => {
    const t0 = cpuNow();
    const bot = guard({ name: 'g', get choose() { burn(30); return (c) => c.actions[0]; } }, { capMs: 1000, loadMs: () => cpuNow() - t0 });
    assert.ok(bot.thinkMs >= 30, `thinkMs ${bot.thinkMs}`);
    assert.strictEqual(guard({ name: 'n', choose: (c) => c.actions[0] }, { loadMs: 7 }).thinkMs, 7, 'a number still works');
    const waited = guard({ name: 'w', choose: (c) => c.actions[0] }, { capMs: 100, wallCapMs: 200, loadWallMs: () => 250 });
    assert.strictEqual(waited.wallMs, 250, 'a wait while loading counts on the wall clock');
});

test('guard: a bot that claims external or stdio is still timed and tracked as a bot that runs here', async () => {
    let tracked = 0;
    const within = (fn) => {
        tracked++;
        return fn();
    };
    const liar = guard({ name: 'l', external: true, stdio: true, choose: (c) => { burn(20); return c.actions[0]; } }, { capMs: 5000, within });
    await liar.choose(ctx);
    assert.ok(tracked >= 1, 'its call ran inside within()');
    assert.ok(liar.thinkMs >= 20 && liar.wallMs >= 20, `CPU clock and wall cap apply (think ${liar.thinkMs}, wall ${liar.wallMs})`);
});

test('guard: an async call that waits without using CPU may run up to the wall cap, not the CPU cap', async () => {
    const waiter = guard({ name: 'w', choose: (c) => new Promise((resolve) => setTimeout(() => resolve(c.actions[0]), 150)) }, { capMs: 100, wallCapMs: 400 });
    assert.deepStrictEqual(await waiter.choose(ctx), plain(actions[0]));
    assert.strictEqual(waiter.fault, null);
});

test('guard: stats are copied as plain JSON, and close, stats and every call run inside within()', async () => {
    const cyc = {};
    cyc.self = cyc;
    const seen = [];
    const within = (fn) => {
        seen.push('in');
        try {
            return fn();
        } finally {
            seen.push('out');
        }
    };
    const mk = (stats) => guard({ name: 's', stats, choose: (c) => { seen.push('choose'); return c.actions[0]; }, close: () => seen.push('close') }, { within });
    assert.deepStrictEqual(mk({ nodes: 5, f: () => 1 }).stats, { nodes: 5 });
    assert.strictEqual(mk(cyc).stats, null);
    assert.strictEqual(mk({ big: 'x'.repeat(70000) }).stats, null);
    assert.strictEqual(mk(10n).stats, null);
    seen.length = 0;
    const b = mk(null);
    await b.close();
    await b.choose(ctx);
    assert.deepStrictEqual(seen, ['in', 'close', 'out', 'in', 'choose', 'out']);
});

test('guard: async work a bot left is charged to it outside its calls, and excused from the other bot\'s call', async () => {
    const mine = guard({ name: 'm', choose: (c) => c.actions[0] }, { capMs: 100 });
    mine.charge({ cpu: 30, wall: 40 });
    assert.strictEqual(mine.thinkMs, 30);
    assert.strictEqual(mine.wallMs, 40);
    mine.charge({ cpu: 80, wall: 80 });
    await assert.rejects(mine.choose(ctx), /TIME_FORFEIT m/, 'over the cap before its next call');
    let other = null;
    const victim = guard({ name: 'v', choose: (c) => { burn(30); other.excuse({ cpu: 25, wall: 25 }); return c.actions[0]; } });
    other = victim;
    await victim.choose(ctx);
    assert.ok(victim.thinkMs < 20, `excused time is not counted: ${victim.thinkMs}`);
    victim.excuse({ cpu: 1000, wall: 1000 });
    assert.ok(victim.thinkMs >= 0, 'outside a call there is nothing to excuse');
});

test('guard: a protocol client is timed on hello and decide, told the time it has left, and its replies are copied', async () => {
    const got = [];
    const client = {
        name: 'cl',
        decide(msg, sim) {
            got.push(msg.ms);
            return sim({ op: 'begin' }).then((r) => ({ t: 'act', i: 1, seen: r.ms, get extra() { return 'x'; } }));
        }
    };
    const bot = guard(client, { capMs: 5000 });
    assert.deepStrictEqual(await bot.hello({ t: 'hello', ms: 30000 }), { t: 'ready', v: 2, name: 'cl' });
    const r = await bot.decide({ t: 'decide', ms: 10000, state: { round: 2 } }, async () => ({ t: 'simulated', op: 'begin', ms: 9000 }));
    assert.ok(got[0] <= 5000 && got[0] > 4000, `told ${got[0]}`);
    assert.ok(r.seen <= 5000, `simulated says what is left of the budget: ${r.seen}`);
    assert.deepStrictEqual(r, { t: 'act', i: 1, seen: r.seen, extra: 'x' });
    assert.deepStrictEqual(await bot.over({ t: 'over' }), { t: 'ok' });
    assert.strictEqual(bot.needsUndo, undefined);
    assert.strictEqual(typeof bot.choose, 'undefined', 'match.js seats it as a protocol client');

    // closed by the referee while it is still thinking: its own reply limit ran out
    let release;
    const slow = guard({ name: 's', decide: () => new Promise((resolve) => (release = resolve)), close: () => release({ t: 'act', i: 0 }) });
    const pending = slow.decide({ t: 'decide', ms: 10, state: {} }, null);
    slow.close();
    await pending;
    assert.strictEqual(slow.fault.kind, 'time');
});
