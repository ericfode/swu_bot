'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { convertFrames, readFrames, compactSnapshot } = require('../karabast');
const { readText } = require('../sources');
const { toKaraBuddy, toTimeline, toSocketIo } = require('./formats');

// A tiny hand-written game in Karabast's gamestate shape (Game.getState as player "u1" sees it).
const card = (uuid, name, set, number, extra = {}) => ({ id: `id-${uuid}`, setId: { set, number }, uuid, name, controllerId: extra.controllerId ?? 'u1', ownerId: extra.controllerId ?? 'u1', ...extra });
const hidden = (owner) => ({ controllerId: owner, ownerId: owner, zone: 'hand' });
const P = (id) => ({ type: 'player', id, name: id === 'u1' ? 'alice' : 'bob', uuid: `Player_${id}` });
const C = (c) => ({ type: 'card', name: c.name, uuid: c.uuid, setId: c.setId, controllerId: c.controllerId });
const msg = (date, message) => ({ date, message });

function player(id, o = {}) {
    return {
        id, name: id === 'u1' ? 'alice' : 'bob', user: { id, username: id === 'u1' ? 'alice' : 'bob' },
        hasInitiative: false, availableResources: 0, numCardsInDeck: 40, isActionPhaseActivePlayer: false,
        leaders: [card(`L${id}`, id === 'u1' ? 'Luke Skywalker' : 'Darth Vader', 'SOR', id === 'u1' ? 5 : 10, { type: 'leader', zone: 'base', controllerId: id, exhausted: false })],
        base: card(`B${id}`, id === 'u1' ? 'Echo Base' : 'Capital City', 'SOR', id === 'u1' ? 23 : 28, { type: 'base', hp: 30, damage: 0, controllerId: id }),
        cardPiles: { hand: [], resources: [], groundArena: [], spaceArena: [], discard: [], outsideTheGame: [], capturedZone: [], credits: [] },
        ...o
    };
}

function game() {
    const wampa = card('C1', 'Wampa', 'SOR', 42, { type: 'basicUnit', zone: 'hand' });
    const pilot = card('C2', 'Battlefield Marine', 'SOR', 95, { type: 'basicUnit', zone: 'hand' });
    const trooper = card('C9', 'Death Star Stormtrooper', 'SOR', 129, { controllerId: 'u2', type: 'basicUnit', zone: 'groundArena', power: 3, hp: 1, damage: 0, exhausted: false });
    const s0 = {
        id: 'g1', phase: 'setup', winners: [], players: {
            u2: player('u2', { cardPiles: { ...player('u2').cardPiles, hand: [hidden('u2'), hidden('u2')] } }),
            u1: player('u1', { hasInitiative: true, cardPiles: { ...player('u1').cardPiles, hand: [wampa, pilot] } })
        },
        newMessages: [msg('2026-10-01T12:00:00.100Z', [P('u1'), ' is shuffling their deck'])]
    };
    const s1 = structuredClone(s0);
    s1.phase = 'action';
    s1.players.u1.isActionPhaseActivePlayer = true;
    s1.players.u1.availableResources = 2;
    s1.players.u1.cardPiles.resources = [card('R1', 'Takedown', 'SOR', 77, { zone: 'resource' }), card('R2', 'Repair', 'SOR', 90, { zone: 'resource' })];
    s1.players.u2.cardPiles.resources = [{ controllerId: 'u2', zone: 'resource' }, { controllerId: 'u2', zone: 'resource' }];
    s1.players.u2.cardPiles.groundArena = [trooper];
    s1.newMessages = [msg('2026-10-01T12:00:00.900Z', { alert: { type: 'notification', message: ['Round: 1 - Action Phase'] } })];
    const s2 = structuredClone(s1);
    s2.players.u1.cardPiles.hand = [pilot];
    s2.players.u1.cardPiles.groundArena = [{ ...wampa, zone: 'groundArena', power: 4, hp: 5, damage: 0, exhausted: true }];
    s2.players.u1.availableResources = 0;
    s2.players.u1.isActionPhaseActivePlayer = false;
    s2.players.u2.isActionPhaseActivePlayer = true;
    s2.newMessages = [msg('2026-10-01T12:00:01.900Z', [P('u1'), ' plays ', C(wampa)])];
    const s3 = structuredClone(s2);
    s3.players.u2.cardPiles.groundArena[0].exhausted = true;
    s3.players.u1.cardPiles.groundArena[0].damage = 3;
    s3.players.u2.cardPiles.groundArena.push(card('T1', 'Shield', 'SOR', null, { controllerId: 'u2', type: 'tokenUpgrade', zone: 'groundArena', parentCardId: 'C9' }));
    s3.newMessages = [msg('2026-10-01T12:00:02.900Z', [P('u2'), ' attacks ', C(wampa), ' with ', C(trooper)])];
    const s4 = structuredClone(s3);
    s4.players.u2.base.damage = 4;
    s4.players.u2.isActionPhaseActivePlayer = false;
    s4.newMessages = [msg('2026-10-01T12:00:03.900Z', [P('u1'), ' attacks ', P('u2'), "'s base with ", C(wampa)])];
    const s5 = structuredClone(s4);
    s5.winners = ['alice'];
    s5.newMessages = [msg('2026-10-01T12:00:04.900Z', [P('u1'), ' has won the game'])];
    return [s0, s1, s2, s3, s4, s5];
}

const frames = (states) => states.map((state) => ({ state }));
const steps = (events) => events.filter((e) => e.t === 'step');

test('seats: p1 is the player with the initiative; usernames never appear', () => {
    const { events, report } = convertFrames(frames(game()));
    assert.deepStrictEqual(report.seats, { p1: 'u1', p2: 'u2' });
    const text = events.map((e) => JSON.stringify(e)).join('\n');
    assert.ok(!/alice|bob/.test(text), 'usernames leaked');
    assert.strictEqual(events[0].players[0].deck, 'Luke Skywalker / Echo Base');
});

test('snapshot: hands, hidden cards, resources, upgrades, leader, base', () => {
    const r = readFrames(frames(game()));
    const s = r.items[3].state;
    assert.strictEqual(s.round, 1);
    assert.strictEqual(s.phase, 'action');
    assert.strictEqual(s.initiative, 'p1');
    assert.deepStrictEqual(s.players.p1.hand, [{ n: 'Battlefield Marine', s: 'SOR_095' }]);
    assert.deepStrictEqual(s.players.p2.hand, [{ n: 'Hidden card', s: null, hid: 1 }, { n: 'Hidden card', s: null, hid: 1 }]);
    assert.deepStrictEqual(s.players.p1.res, { ready: 0, total: 2 });
    assert.deepStrictEqual(s.players.p1.ground, [{ n: 'Wampa', s: 'SOR_042', p: 4, h: 5, d: 3, x: 1 }]);
    assert.deepStrictEqual(s.players.p2.ground, [{ n: 'Death Star Stormtrooper', s: 'SOR_129', p: 3, h: 1, d: 0, x: 1, u: [{ n: 'Shield', s: null, t: 1 }] }]);
    assert.deepStrictEqual(s.players.p1.leader, { n: 'Luke Skywalker', s: 'SOR_005', dep: 0, x: 0 });
    assert.deepStrictEqual(s.players.p2.base, { n: 'Capital City', s: 'SOR_028', hp: 30, d: 0 });
    assert.strictEqual(r.pov, 'p1');
    assert.strictEqual(r.items[0].state.round, 0, 'setup is round 0, as in the engine');
});

test('decisions: plays, two-click attacks (target base by name), winner', () => {
    const { events } = convertFrames(frames(game()));
    const s = steps(events).slice(1).map((e) => [e.pid, e.prompt, e.title, e.action.kind, e.action.label]);
    assert.deepStrictEqual(s, [
        ['p1', 'log|-', null, 'button', 'Round: 1 - Action Phase'],
        ['p1', 'actionWindow|-', 'Choose an action', 'card', 'Wampa'],
        ['p2', 'actionWindow|-', 'Choose an action', 'card', 'Death Star Stormtrooper'],
        ['p2', '-|single', 'Choose a target for attack', 'card', 'Wampa'],
        ['p1', 'actionWindow|-', 'Choose an action', 'card', 'Wampa'],
        ['p1', '-|single', 'Choose a target for attack', 'card', 'Capital City'],
        ['p1', 'log|-', null, 'button', 'p1 has won the game']
    ]);
    const atk = steps(events).find((e) => e.title === 'Choose a target for attack');
    const before = steps(events)[steps(events).indexOf(atk) - 1];
    assert.strictEqual(before.state.players.p1.ground[0].d, 0, 'first click keeps the old board');
    assert.strictEqual(atk.state.players.p1.ground[0].d, 3);
    const end = events[events.length - 1];
    assert.deepStrictEqual([end.t, end.winner, end.outcome, end.round], ['end', 'p1', 'won', 1]);
    assert.deepStrictEqual(events[0].source.hiddenHands, ['p2']);
});

test('player chat is dropped', () => {
    const g = game();
    g[2].newMessages.push(msg('2026-10-01T12:00:02.000Z', [{ type: 'playerChat', id: 'u2', name: 'bob' }, 'gl hf']));
    const { events, report } = convertFrames(frames(g));
    assert.strictEqual(report.chatDropped, 1);
    assert.ok(!events.some((e) => (e.log ?? []).some((l) => /gl hf/.test(l))));
});

test('round alerts left by an undo do not move the round', () => {
    const g = game();
    // an undone regroup leaves 'Round: 2' alerts in the log while the board stays in round 1's action phase
    g[3].newMessages.unshift(msg('2026-10-01T12:00:02.500Z', { alert: { type: 'notification', message: ['Round: 1 - Regroup Phase'] } }),
        msg('2026-10-01T12:00:02.600Z', { alert: { type: 'notification', message: ['Round: 2 - Action Phase'] } }));
    const r = readFrames(frames(g));
    assert.deepStrictEqual(r.items.map((x) => x.state.round), [0, 1, 1, 1, 1, 1]);
});

test('every capture format gives the same replay', () => {
    const g = game();
    const want = JSON.stringify(convertFrames(frames(g)).events);
    const same = (label, text) => assert.strictEqual(JSON.stringify(convertFrames(readText(text).frames).events), want, label);
    same('JSON array', JSON.stringify(g));
    same('JSON lines', g.map((s) => JSON.stringify(s)).join('\n'));
    same('socket.io frames', toSocketIo(g));
    same('KaraBuddy v2', JSON.stringify(toKaraBuddy(g)));
    // SWU Forge timeline: each push leaves the server 50 ms after its last log line; the browser clock is 7 s behind
    const pushed = g.map((s) => Math.max(...s.newMessages.map((m) => Date.parse(m.date))) + 50);
    const stamps = pushed.map((t) => t - 7000);
    const tl = toTimeline(g, stamps);
    const back = convertFrames(readText(JSON.stringify(tl)).frames).events;
    assert.deepStrictEqual(steps(back).map((e) => [e.pid, e.action?.label, e.log, e.state]), steps(JSON.parse(want)).map((e) => [e.pid, e.action?.label, e.log, e.state]), 'SWU Forge timeline');
});

test('analysis keeps only the views a one-seat capture supports', () => {
    const { usableViews, ALL_VIEWS } = require('../../analysis/analyze');
    const header = convertFrames(frames(game())).events[0];
    assert.deepStrictEqual(header.source.hiddenHands, ['p2']);
    assert.deepStrictEqual(usableViews({ header }, ALL_VIEWS), ['subjective_p1', 'omniscient']);
    assert.deepStrictEqual(usableViews({ header: { source: { hiddenHands: ['p1', 'p2'] } } }, ALL_VIEWS), ['omniscient']);
    assert.deepStrictEqual(usableViews({ header: { seed: 1 } }, ALL_VIEWS), ALL_VIEWS);
});

test('merge pairs frames across dropped and repeated frames', () => {
    const { align } = require('../merge');
    assert.deepStrictEqual(align(['a', 'b', 'b', 'c', 'd'], ['a', 'b', 'c', 'c', 'd']), [0, 1, 1, 2, 4]);
    assert.deepStrictEqual(align(['a', 'x', 'b'], ['a', 'b']), [0, -1, 1]);
    // an undo back to an earlier board pairs with the next copy of that board, not the old one
    assert.deepStrictEqual(align(['a', 'b', 'a', 'c'], ['a', 'b', 'a', 'c']), [0, 1, 2, 3]);
});

test('compact snapshot of a deployed leader', () => {
    const s = game()[4];
    s.players.u1.leaders[0] = { ...s.players.u1.leaders[0], zone: 'groundArena', type: 'leaderUnit', power: 6, hp: 7, damage: 0, exhausted: true };
    s.players.u1.cardPiles.groundArena.push(s.players.u1.leaders[0]);
    const snap = compactSnapshot(s, { p1: 'u1', p2: 'u2' }, 3);
    assert.deepStrictEqual(snap.players.p1.leader, { n: 'Luke Skywalker', s: 'SOR_005', dep: 1, x: 1 });
    assert.strictEqual(snap.players.p1.ground.length, 2);
});

// Engine-backed check: capture a real game with forceteki and compare every frame with the recorder's snapshots.
const engineReady = fs.existsSync(path.join(__dirname, '..', '..', 'forceteki', 'build', 'server')) &&
    fs.existsSync(path.join(__dirname, '..', '..', 'forceteki', 'test', 'json', '_cardMap.json'));

test('engine capture matches the recorder on every frame (rush vs random, seed 4)', { skip: !engineReady && 'needs forceteki/build and card data' }, async () => {
    const { Env } = require('../../bot/env');
    const { captureGame } = require('../capture');
    const { diffSnapshot } = require('../verify');
    const env = new Env();
    const { res, frames: f, seats } = await captureGame(env, { seed: 4, botNames: ['rush', 'random'], maxSteps: 6000 });
    const truth = res.events.filter((e) => e.t === 'step');
    for (const view of ['p1', 'p2', 'spectator']) {
        const r = readFrames(f[view].map((x) => ({ state: x.state })), { seats });
        assert.strictEqual(r.items.length, truth.length);
        const hiddenSeats = view === 'spectator' ? ['p1', 'p2'] : [view === 'p1' ? 'p2' : 'p1'];
        const bad = truth.map((t, k) => diffSnapshot(t.state, r.items[k].state, hiddenSeats)).filter((d) => d.length);
        assert.strictEqual(bad.length, 0, `${view}: ${JSON.stringify(bad[0])}`);
    }
    // both players' captures merged: every frame equals the truth, both hands included
    const { mergeCaptures } = require('../merge');
    const merged = mergeCaptures(f.p1.map((x) => ({ state: x.state })), f.p2.map((x) => ({ state: x.state })));
    assert.strictEqual(merged.unmatched, 0);
    const both = readFrames(merged.frames, { seats });
    assert.strictEqual(both.pov, 'both');
    const badBoth = truth.map((t, k) => diffSnapshot(t.state, both.items[k].state, [])).filter((d) => d.length);
    assert.strictEqual(badBoth.length, 0, `merged: ${JSON.stringify(badBoth[0])}`);
    // and through KaraBuddy and SWU Forge files
    const states = f.p1.map((x) => x.state);
    const want = JSON.stringify(steps(convertFrames(frames(states), { seats }).events).map((e) => e.state));
    const viaKb = convertFrames(readText(JSON.stringify(toKaraBuddy(states))).frames, { seats }).events;
    assert.strictEqual(JSON.stringify(steps(viaKb).map((e) => e.state)), want);
});
