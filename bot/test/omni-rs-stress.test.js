'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diffPaths, cardIndex } = require('../omni/rs/mirror');
const { jobs } = require('../omni/rs/stress');

test('diffPaths names each differing field, array lengths included', () => {
    const forceteki = { round: 2, players: { p1: { base: { damage: 3 }, hand: [{ id: 'c1' }, { id: 'c2' }] } } };
    const rust = { round: 2, players: { p1: { base: { damage: 4 }, hand: [{ id: 'c1' }] } } };
    assert.deepEqual(diffPaths(rust, forceteki), [
        { path: '.players.p1.base.damage', forceteki: 3, rust: 4 },
        { path: '.players.p1.hand.length', forceteki: 2, rust: 1 },
        { path: '.players.p1.hand.1', forceteki: { id: 'c2' }, rust: undefined }
    ]);
    assert.deepEqual(diffPaths(forceteki, structuredClone(forceteki)), []);
});

test('cardIndex maps stable ids to set codes in every zone, upgrades included', () => {
    const side = (n) => ({
        base: { id: `c${n}`, setCode: 'B' }, leader: { id: `c${n + 1}`, setCode: 'L' }, hand: [], deck: [{ id: `c${n + 2}`, setCode: 'D' }],
        resources: [], discard: [], ground: [{ id: `c${n + 3}`, setCode: 'U', upgrades: [{ id: `c${n + 4}`, setCode: 'TOKEN_SHIELD' }] }], space: []
    });
    const index = cardIndex({ players: { p1: side(0), p2: side(10) } });
    assert.equal(index.c3, 'U');
    assert.equal(index.c4, 'TOKEN_SHIELD');
    assert.equal(index.c12, 'D');
    assert.equal(Object.keys(index).length, 10);
});

test('stress jobs play every pair once per seed and swap seats on odd seeds', () => {
    const list = jobs(['a', 'b', 'c'], [1, 2]);
    assert.equal(list.length, 6);
    assert.deepEqual(list.filter((j) => j.seed === 1).map((j) => j.bots), [['b', 'a'], ['c', 'a'], ['c', 'b']]);
    assert.deepEqual(list.filter((j) => j.seed === 2).map((j) => j.bots), [['a', 'b'], ['a', 'c'], ['b', 'c']]);
});

const { determinizeState } = require('../omni/rs/rust-sims');
const { RustViews } = require('../omni/rs/rust-view');
const { seededRng } = require('../rng');

const card = (id, setCode = 'X_001') => ({ id, setCode, name: setCode.toLowerCase() });
function board() {
    const side = (n) => ({
        base: { ...card(`c${n}`, 'B_001'), damage: 3, hp: 30, epicUsed: false },
        leader: { ...card(`c${n + 1}`, 'L_001'), deployed: false, exhausted: false, epicUsed: false },
        hand: [card(`c${n + 2}`), card(`c${n + 3}`)],
        deck: [card(`c${n + 4}`), card(`c${n + 5}`), card(`c${n + 6}`)],
        resources: [{ ...card(`c${n + 7}`), exhausted: true }, { ...card(`c${n + 8}`), exhausted: false }, { ...card(`c${n + 9}`), exhausted: true }],
        discard: [], space: [], out: false,
        ground: [{ ...card(`c${n + 10}`, 'U_001'), damage: 1, exhausted: true, power: 3, hp: 5, upgrades: [{ ...card(`c${n + 11}`, 'TOKEN_SHIELD'), token: true }] }]
    });
    return { nextCardId: 30, round: 2, phase: 'action', initiative: 'p1', initiativeClaimed: false, prevPassed: true, activePlayer: 'p1', actor: 'p1', winner: null, players: { p1: side(0), p2: side(12) } };
}

test('Rust simulations deal the hidden cards again: same zone sizes and exhausted count, seen cards kept', () => {
    const s = board();
    const d = determinizeState(s, 'p1', seededRng('deal'));
    const ids = (list) => list.map((c) => c.id).sort();
    assert.deepEqual(d.players.p1.hand, s.players.p1.hand);
    assert.deepEqual(d.players.p1.resources, s.players.p1.resources);
    assert.deepEqual(ids(d.players.p1.deck), ids(s.players.p1.deck));
    const opp = (x) => [...x.players.p2.hand, ...x.players.p2.resources, ...x.players.p2.deck].map((c) => c.id).sort();
    assert.deepEqual(opp(d), opp(s));
    assert.equal(d.players.p2.hand.length, 2);
    assert.equal(d.players.p2.resources.filter((r) => r.exhausted).length, 2);
    assert.deepEqual(d.players.p2.ground, s.players.p2.ground);
    assert.deepEqual(determinizeState(s, 'p1', seededRng('deal')), d, 'the same stream gives the same deal');
    assert.equal(s.players.p2.hand[0].id, 'c14', 'the input state is not changed');
});

test('Rust views use the protocol shapes and hide what the seat cannot see', () => {
    const pool = { cards: [
        { setCode: 'U_001', title: 'Unit', keywords: ['sentinel'], types: ['unit'] },
        { setCode: 'TOKEN_SHIELD', title: 'Shield', keywords: [], types: ['token', 'upgrade'] },
        { setCode: 'X_001', title: 'Card', keywords: [], types: ['unit'] }
    ] };
    const views = new RustViews(pool);
    const v = views.view(board(), 'p1');
    assert.deepEqual(v.players.p1.ground[0], { id: 'c10', n: 'Unit', s: 'U_001', p: 3, h: 5, d: 1, x: 1, sn: 1, u: [{ id: 'c11', n: 'Shield', s: null, t: 1 }] });
    assert.deepEqual(v.players.p1.res, { ready: 1, total: 3 });
    assert.equal(v.players.p1.hand.length, 2);
    assert.equal(v.players.p2.hand, undefined);
    assert.equal(v.players.p2.resources, undefined);
    assert.equal(v.players.p2.passed, 1);
    const acts = views.actions(board(), [
        { kind: 'button', card: null, arg: 'pass', method: null, label: 'Pass', key: '' },
        { kind: 'card', card: 'c2', arg: null, method: null, label: 'x_001', key: '' }
    ]);
    assert.deepEqual(acts, [
        { i: 0, kind: 'button', label: 'Pass', arg: 'pass' },
        { i: 1, kind: 'card', label: 'x_001', cardUuid: 'c2', card: { id: 'c2', n: 'Card', s: 'X_001', zone: 'hand', ctl: 'p1' } }
    ]);
    // the protocol schema needs a string signature
    assert.equal(views.prompt({ isActionWindow: () => true }, 'p1').signature, 'actionWindow|-');
    const target = views.prompt({ isActionWindow: () => false }, 'p1', [{ kind: 'card' }, { kind: 'button' }, { kind: 'card' }]);
    assert.equal(target.signature, 'rust|button|card');
    assert.equal(target.actionWindow, false);
});
