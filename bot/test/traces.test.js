'use strict';
// Trace checks (bot/trace.js): games the live arena played, recorded by its game player, must play out the same way
// again on this checkout's engine and player, board by board. The games in bot/test/traces are from round 15, between
// the arena's resident bots; one of them ended in engine bug 3 of CLAUDE.md ("Resolve all"). Replaying needs the
// engine build and card data, and those tests are skipped without them. After a change meant to alter the boards (a
// new snapshot field, an engine upgrade), `node bot/trace.js rewrite bot/test/traces` records them again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { difference, readTrace, replayTrace, traceFiles } = require('../trace');

const ROOT = path.join(__dirname, '..', '..');
const TRACES = path.join(__dirname, 'traces');
const ENGINE = fs.existsSync(path.join(ROOT, 'forceteki', 'build', 'server')) && fs.existsSync(path.join(ROOT, 'forceteki', 'test', 'json', 'Card'));
const BUG3 = 'rust_greedy2-v1-vs-heuristic-v1-3381370137.jsonl.gz';

let env = null;
const engine = () => (env ??= new (require('../env').Env)());

test('difference names the first place two boards differ', () => {
    assert.equal(difference({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), null);
    assert.equal(difference({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] }), 'state.b[1]: want 2, got 3');
    assert.equal(difference({ p: { hand: [1, 2] } }, { p: { hand: [1] } }), 'state.p.hand: want 2 entries, got 1 ([1,2] vs [1])');
    assert.equal(difference({ x: 1 }, { x: 1, y: 2 }), 'state.y: want nothing, got 2');
});

test('every recorded game in bot/test/traces plays out the same again', { skip: !ENGINE && 'engine or card data not built' }, async () => {
    const files = traceFiles([TRACES]);
    assert.ok(files.length >= 8, 'the sample of games');
    for (const file of files) {
        const events = readTrace(file);
        const r = await replayTrace(engine(), events);
        assert.equal(r.diff, null, path.basename(file));
        assert.equal(r.steps, events.at(-1).steps, path.basename(file));
    }
});

test('a game that ended in an engine error raises it again on the same move', { skip: !ENGINE && 'engine or card data not built' }, async () => {
    const r = await replayTrace(engine(), readTrace(path.join(TRACES, BUG3)));
    assert.ok(r.ok);
    assert.match(r.note, /happens again when p2 takes action 1 \(button "Resolve all \(2\)"\)/);
});

test('a board or a move that differs from the recording is the first difference reported', { skip: !ENGINE && 'engine or card data not built' }, async () => {
    const file = path.join(TRACES, 'c_clock-v1-vs-rush-v1-3381370119.jsonl.gz');
    const board = readTrace(file);
    board.find((e) => e.n === 30).state.players.p1.base.d += 1;
    const b = await replayTrace(engine(), board);
    assert.equal(b.ok, false);
    assert.match(b.diff, /^step 30: state\.players\.p1\.base\.d: want \d+, got \d+$/);

    const move = readTrace(file);
    const step = move.find((e) => e.n === 12);
    step.legal += 1;
    const m = await replayTrace(engine(), move);
    assert.match(m.diff, /^step 12: p\d had \d+ legal actions \(recorded \d+\)/);

    const ending = readTrace(file);
    ending.at(-1).winner = ending.at(-1).winner === 'p1' ? 'p2' : 'p1';
    assert.match((await replayTrace(engine(), ending)).diff, /the game ends with winner p\d, recorded p\d/);
});
