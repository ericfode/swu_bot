'use strict';

// Review fixes for importer/merge.js (pairing after long gaps, captures without the log, failure frames) and for
// analysis/analyze.js on merged replays whose frames did not all pair.

const test = require('node:test');
const assert = require('node:assert');
const { mergeCaptures, align } = require('../merge');
const { convertFrames } = require('../karabast');

const card = (uuid, name, number, extra = {}) => ({ id: `id-${uuid}`, setId: { set: 'SOR', number }, uuid, name, controllerId: extra.controllerId ?? 'u1', ownerId: extra.controllerId ?? 'u1', ...extra });
const P = (id) => ({ type: 'player', id, name: id === 'u1' ? 'alice' : 'bob', uuid: `Player_${id}` });
const C = (c) => ({ type: 'card', name: c.name, uuid: c.uuid, setId: c.setId, controllerId: c.controllerId });
const msg = (message) => ({ date: '2026-10-01T12:00:00.000Z', message });

function player(id, hand, o = {}) {
    return {
        id, name: id === 'u1' ? 'alice' : 'bob', hasInitiative: id === 'u1', availableResources: 0, numCardsInDeck: 40,
        leaders: [card(`L${id}`, id === 'u1' ? 'Luke Skywalker' : 'Darth Vader', id === 'u1' ? 5 : 10, { type: 'leader', zone: 'base', controllerId: id })],
        base: card(`B${id}`, id === 'u1' ? 'Echo Base' : 'Capital City', id === 'u1' ? 23 : 28, { type: 'base', hp: 30, damage: 0, controllerId: id }),
        cardPiles: { hand, resources: [], groundArena: [], spaceArena: [], discard: [] },
        ...o
    };
}

/**
 * The truth (both hands shown) of a short game: setup, bob's mulligan (no public change), then a few turns.
 * Frames carry totalMessages like Karabast's pushes; view() drops it for the formats that lack it.
 */
function truth() {
    const wampa = card('C1', 'Wampa', 42, { type: 'basicUnit', zone: 'hand' });
    const marine = card('C2', 'Battlefield Marine', 95, { type: 'basicUnit', zone: 'hand' });
    const pre = [card('D1', 'Probe Droid', 130, { controllerId: 'u2', zone: 'hand' }), card('D2', 'AT-ST', 131, { controllerId: 'u2', zone: 'hand' })];
    const post = [card('D3', 'TIE Fighter', 132, { controllerId: 'u2', zone: 'hand' }), card('D4', 'Snowtrooper', 133, { controllerId: 'u2', zone: 'hand' })];
    const out = [];
    let total = 0;
    const push = (s, lines) => {
        total += lines.length;
        out.push({ ...structuredClone(s), newMessages: lines.map(msg), totalMessages: total });
    };
    const s = { id: 'g1', phase: 'setup', winners: [], players: { u1: player('u1', [wampa, marine]), u2: player('u2', pre) } };
    push(s, [[P('u1'), ' is shuffling their deck']]);
    push(s, []); // a second push with the same board
    s.players.u2.cardPiles.hand = post; // the mulligan: same count, so the public board does not change
    push(s, [[P('u2'), ' takes a mulligan']]);
    push(s, []);
    s.phase = 'action';
    s.players.u1.availableResources = 2;
    s.players.u1.cardPiles.resources = [card('R1', 'Takedown', 77, { zone: 'resource' }), card('R2', 'Repair', 90, { zone: 'resource' })];
    s.players.u2.cardPiles.resources = [card('R3', 'Vanquish', 78, { controllerId: 'u2', zone: 'resource' }), card('R4', 'Bounty', 91, { controllerId: 'u2', zone: 'resource' })];
    push(s, [{ alert: { type: 'notification', message: ['Round: 1 - Action Phase'] } }]);
    s.players.u1.cardPiles.hand = [marine];
    s.players.u1.cardPiles.groundArena = [{ ...wampa, zone: 'groundArena', power: 4, hp: 5, damage: 0, exhausted: true }];
    s.players.u1.availableResources = 0;
    push(s, [[P('u1'), ' plays ', C(wampa)]]);
    push(s, []); // frame 6: same board, nothing private changed
    s.players.u2.cardPiles.hand = [post[1]];
    s.players.u2.cardPiles.groundArena = [{ ...post[0], zone: 'groundArena', power: 2, hp: 1, damage: 0, exhausted: true }];
    push(s, [[P('u2'), ' plays ', C(post[0])]]);
    s.players.u2.base.damage = 4;
    push(s, [[P('u1'), ' attacks ', P('u2'), "'s base with ", C(wampa)]]);
    s.winners = ['alice'];
    push(s, [[P('u1'), ' has won the game']]);
    return out;
}

/** What one player is pushed: the other seat's hand and resources as nameless stubs. */
function view(states, me, { log = true } = {}) {
    return states.map((st) => {
        const s = structuredClone(st);
        for (const [id, p] of Object.entries(s.players)) {
            if (id !== me) {
                p.cardPiles.hand = p.cardPiles.hand.map(() => ({ controllerId: id, ownerId: id, zone: 'hand' }));
                p.cardPiles.resources = p.cardPiles.resources.map(() => ({ controllerId: id, ownerId: id, zone: 'resource' }));
            }
        }
        if (!log) {
            delete s.totalMessages;
        }
        return { state: s };
    });
}

const without = (frames, ...drop) => frames.filter((_, i) => !drop.includes(i));
const handOf = (f, id) => f.state.players[id].cardPiles.hand.map((c) => c.name ?? 'hidden');

/** Every merged frame shows bob's real hand at that moment or keeps it hidden, never another frame's hand. */
function assertNoWrongHand(merged, states) {
    merged.frames.forEach((f, i) => {
        const got = handOf(f, 'u2');
        if (got.some((n) => n !== 'hidden')) {
            assert.deepStrictEqual(got, handOf({ state: states[i] }, 'u2'), `frame ${i}`);
        }
    });
}

test('align re-anchors when a starts, or resumes, more than WINDOW frames into b', () => {
    const b = Array.from({ length: 400 }, (_, i) => `k${i}`);
    const idx = (keys) => keys.map((k) => b.indexOf(k));
    assert.deepStrictEqual(align(b.slice(250), b), idx(b.slice(250)));
    const gap = [...b.slice(0, 100), ...b.slice(321)];
    assert.deepStrictEqual(align(gap, b), idx(gap));
    // a board that comes back in another run of b (an undo) is not a re-anchor point; the next frame is
    const undo = [...b.slice(0, 300), 'x', 'k300', 'x', ...b.slice(301)];
    assert.deepStrictEqual(align(['x', 'k300', 'k301'], undo), [-1, 301, 303]);
    // within the window the nearest copy still pairs, as before
    assert.deepStrictEqual(align(['k299', 'x', 'k300', 'x'], undo), [299, 300, 301, 302]);
});

test('merge pairs a capture that starts more than 200 frames late', () => {
    const base = truth()[4];
    const states = Array.from({ length: 300 }, (_, i) => {
        const s = structuredClone(base);
        s.players.u1.base.damage = i % 30;
        s.players.u2.base.damage = Math.floor(i / 30);
        s.totalMessages = i;
        return s;
    });
    const late = mergeCaptures(view(states, 'u1').slice(250), view(states, 'u2'));
    assert.strictEqual(late.matched, 50);
    const gap = mergeCaptures(without(view(states, 'u1'), ...Array.from({ length: 221 }, (_, i) => 50 + i)), view(states, 'u2'));
    assert.strictEqual(gap.unmatched, 0);
    const nolog = mergeCaptures(view(states, 'u1', { log: false }).slice(250), view(states, 'u2', { log: false }));
    assert.strictEqual(nolog.matched, 50);
});

test('merge without the log keeps a run with a lost frame hidden instead of showing the other side of a mulligan', () => {
    const states = truth();
    const a = view(states, 'u1', { log: false });
    const b = view(states, 'u2', { log: false });
    assert.strictEqual(mergeCaptures(a, b).unmatched, 0);
    // b lost frame 1: frames 0-3 have one public board, and b's copies no longer line up with a's
    const lostPre = mergeCaptures(a, without(b, 1));
    assertNoWrongHand(lostPre, states);
    assert.strictEqual(lostPre.unmatched, 4);
    // b lost its post-mulligan frames: a's frames 2 and 3 must not reuse the pre-mulligan hand
    const lostPost = mergeCaptures(a, without(b, 2, 3));
    assertNoWrongHand(lostPost, states);
    assert.deepStrictEqual(handOf(lostPost.frames[3], 'u2'), ['hidden', 'hidden']);
    // a run where bob's cards stay the same still pairs when b lost or repeated a frame of it
    for (const bv of [without(b, 6), [...b.slice(0, 6), ...b.slice(5)]]) {
        const m = mergeCaptures(a, bv);
        assertNoWrongHand(m, states);
        assert.strictEqual(m.unmatched, 0);
    }
    // a repeated frame in the mulligan run leaves that run hidden
    const dup = mergeCaptures(a, [...b.slice(0, 2), ...b.slice(1)]);
    assertNoWrongHand(dup, states);
    assert.strictEqual(dup.unmatched, 4);
    // with the log the mulligan changes the key, so the same losses pair every frame correctly
    for (const drop of [[1], [2, 3]]) {
        const m = mergeCaptures(view(states, 'u1'), without(view(states, 'u2'), ...drop));
        assertNoWrongHand(m, states);
        assert.strictEqual(m.unmatched, drop.length === 1 ? 0 : 2);
    }
});

test('merge skips the empty-players frame of a server serialization failure', () => {
    const states = truth();
    const failure = { state: { players: {}, phase: 'action', winners: [], totalMessages: states.at(-1).totalMessages + 1, newMessages: ['A severe server error has occurred...'] } };
    const m = mergeCaptures([...view(states, 'u1'), failure], [...view(states, 'u2'), failure]);
    assert.strictEqual(m.frames.length, states.length);
    assert.strictEqual(m.unmatched, 0);
});

test('analysis skips the views that need a hand the merge left hidden, and tells the hindsight pass', () => {
    const { buildRequests, usableViews, ALL_VIEWS } = require('../../analysis/analyze');
    const { checkpoints } = require('../../analysis/lib/game');
    const states = truth();
    const m = mergeCaptures(view(states, 'u1'), without(view(states, 'u2'), 7));
    assert.strictEqual(m.unmatched, 1);
    const events = convertFrames(m.frames).events;
    const game = { id: 'g', header: events[0], steps: events.filter((e) => e.t === 'step'), end: events.at(-1) };
    assert.strictEqual(game.header.source.pov, 'both');
    assert.deepStrictEqual(usableViews(game, ALL_VIEWS), ALL_VIEWS);
    const cps = checkpoints(game);
    const hiddenAt = cps.filter((cp) => game.steps[cp.stepIndex].state.players.p2.hand.some((c) => c.hid)).map((cp) => cp.i);
    assert.strictEqual(hiddenAt.length, 1);
    const reqs = buildRequests(game, cps, ALL_VIEWS, { logWindow: 30, effort: 'low', omniEffort: 'low' });
    const ids = new Set(reqs.map((r) => r.id));
    for (const cp of cps) {
        const hidden = hiddenAt.includes(cp.i);
        assert.strictEqual(ids.has(`cp${cp.i}-subjective_p1`), true);
        assert.strictEqual(ids.has(`cp${cp.i}-subjective_p2`), !hidden);
        assert.strictEqual(ids.has(`cp${cp.i}-objective`), !hidden);
    }
    for (const r of reqs.filter((x) => x.view !== 'omniscient')) {
        assert.ok(!/Hidden card/.test(r.user), r.id);
    }
    const omni = reqs.find((r) => r.view === 'omniscient');
    assert.match(omni.user, new RegExp(`hand of p2 was not recorded at 1 of ${cps.length} checkpoints`));
});
