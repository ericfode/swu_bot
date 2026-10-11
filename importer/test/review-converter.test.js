'use strict';

// Regression tests for the converter review (importer/karabast.js, importer/import.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { convertFrames, readFrames, splitGames } = require('../karabast');
const { readText } = require('../sources');
const { toTimeline, toSocketIo } = require('./formats');

// The same tiny game as importer.test.js: Game.getState as player "u1" (alice) sees it, against u2 (bob).
const card = (uuid, name, set, number, extra = {}) => ({ id: `id-${uuid}`, setId: { set, number }, uuid, name, controllerId: extra.controllerId ?? 'u1', ownerId: extra.controllerId ?? 'u1', ...extra });
const hidden = (owner) => ({ controllerId: owner, ownerId: owner, zone: 'hand' });
const P = (id) => ({ type: 'player', id, name: id === 'u1' ? 'alice' : 'bob', uuid: `Player_${id}` });
const C = (c) => ({ type: 'card', name: c.name, uuid: c.uuid, setId: c.setId, controllerId: c.controllerId });
const msg = (date, message) => ({ date, message });
const alert = (date, ...parts) => msg(date, { alert: { type: 'notification', message: parts } });

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

const wampa = card('C1', 'Wampa', 'SOR', 42, { type: 'basicUnit', zone: 'hand' });

function game(id = 'g1') {
    const pilot = card('C2', 'Battlefield Marine', 'SOR', 95, { type: 'basicUnit', zone: 'hand' });
    const trooper = card('C9', 'Death Star Stormtrooper', 'SOR', 129, { controllerId: 'u2', type: 'basicUnit', zone: 'groundArena', power: 3, hp: 1, damage: 0, exhausted: false });
    const s0 = {
        id, phase: 'setup', winners: [], players: {
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
    s1.newMessages = [alert('2026-10-01T12:00:00.900Z', 'Round: 1 - Action Phase')];
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

/** Next frame: a copy of the last one with these log lines (and whatever `change` does to it). */
function next(states, lines, change = () => {}) {
    const s = structuredClone(states[states.length - 1]);
    s.newMessages = lines;
    change(s);
    states.push(s);
    return states;
}

const frames = (states) => states.map((state) => ({ state }));
const steps = (events) => events.filter((e) => e.t === 'step');
const endOf = (events) => events[events.length - 1];
const NAMES = /\b(alice|bob)\b/;

test('end.how: a won game stays won by base when the loser leaves or concedes afterwards', () => {
    const won = game();
    won[4].players.u2.base.damage = 30;
    won[5].players.u2.base.damage = 30;
    const left = next(structuredClone(won), [msg('2026-10-01T12:00:09.000Z', [P('u2'), ' has left the game'])]);
    const conceded = next(structuredClone(won), [msg('2026-10-01T12:00:09.000Z', [P('u2'), ' concedes the game'])]);
    for (const [label, g] of [['plain', won], ['left after', left], ['conceded after', conceded]]) {
        const end = endOf(convertFrames(frames(g)).events);
        assert.deepStrictEqual([end.winner, end.how], ['p1', 'base destroyed'], label);
    }
    // a real concede or leave (the line comes with the win) still says so
    for (const [line, how] of [[' concedes the game', 'concede'], [' has left the game', 'left']]) {
        const g = game();
        g[5].newMessages = [msg('2026-10-01T12:00:04.800Z', [P('u2'), line]), ...g[5].newMessages];
        assert.strictEqual(endOf(convertFrames(frames(g)).events).how, how);
    }
});

test('usernames in plain-string fragments become seats', () => {
    const g = game();
    const sabine = card('L9', 'Sabine Wren', 'ASH', 6, { type: 'leader', zone: 'base' });
    const haulcraft = card('C7', 'Battered Haulcraft', 'SOR', 200, { type: 'basicUnit', zone: 'groundArena' });
    // Sabine Wren, Bargaining on Belief passes context.player.opponent.name, a plain string, into the effect message
    g[3].newMessages.push(msg('2026-10-01T12:00:03.000Z', [P('u1'), ' uses ', C(sabine), ', exhausting ', C(sabine), ' to have bob give 2 Advantage tokens to ', C(haulcraft)]));
    // Lobby.submitReport: game.addAlert('{0} has submitted a bug report', existingUser.username)
    g[4].newMessages.push(alert('2026-10-01T12:00:04.000Z', 'alice has submitted a bug report'));
    // lobby rematch alerts put the username into the text
    g[5].newMessages.push(alert('2026-10-01T12:00:05.000Z', 'bob has requested a rematch!'));
    const { events } = convertFrames(frames(g));
    const log = steps(events).flatMap((e) => e.log ?? []);
    assert.ok(log.includes('p1 uses Sabine Wren, exhausting Sabine Wren to have p2 give 2 Advantage tokens to Battered Haulcraft'), log.join('\n'));
    assert.ok(log.includes('p1 has submitted a bug report'));
    assert.ok(log.includes('p2 has requested a rematch!'));
    assert.ok(!NAMES.test(events.map((e) => JSON.stringify(e)).join('\n')), 'usernames leaked');
});

test('a spectator first frame keeps the whole chat, with names replaced', () => {
    const s0 = game()[1];
    // here the opponent is not called bob, so the name belongs to a spectator
    s0.players.u2.name = 'Player 2';
    s0.players.u2.user = { id: 'u2' };
    s0.spectators = [{ id: 'sp1', name: 'bob' }];
    s0.messageOffset = 0;
    s0.totalMessages = 3;
    s0.newMessages = [alert('t0', 'Round: 3 - Action Phase'), alert('t1', 'alice has submitted a bug report'), msg('t2', ['bob', ' has joined the game as a spectator'])];
    const { events } = convertFrames([{ state: s0 }]);
    assert.deepStrictEqual(events[1].log, ['Round: 3 - Action Phase', 'p1 has submitted a bug report', 'a spectator has joined the game as a spectator']);
});

test('usernames in a SWU Forge timeline alert (flattened to text) become seats', () => {
    const g = game();
    // an undo: the board goes back to s1, then Wampa is played again
    const undo = structuredClone(g[1]);
    undo.newMessages = [alert('2026-10-01T12:00:02.400Z', P('u1'), ' has rolled back to ', 'their previous action')];
    const again = structuredClone(g[2]);
    again.newMessages = [msg('2026-10-01T12:00:02.700Z', [P('u1'), ' plays ', C(wampa)])];
    const states = [g[0], g[1], g[2], undo, again];
    const stamps = states.map((s) => Math.max(...s.newMessages.map((m) => Date.parse(m.date))) + 50);
    const { events } = convertFrames(readText(JSON.stringify(toTimeline(states, stamps))).frames);
    const log = steps(events).flatMap((e) => e.log ?? []);
    assert.ok(log.includes('p1 has rolled back to their previous action'), log.join('\n'));
    assert.ok(!NAMES.test(events.map((e) => JSON.stringify(e)).join('\n')), 'usernames leaked');
});

test('names are replaced as whole words, longest first, in one pass', () => {
    const g = game();
    // a seat-like username must not be rewritten twice
    for (const s of g) {
        s.players.u1.name = 'p2';
        s.players.u1.user.username = 'p2';
        s.players.u2.name = 'p1';
        s.players.u2.user.username = 'p1';
        s.winners = s.winners.map(() => 'p2');
    }
    g[2].newMessages.push(alert('t', 'p2 has requested a rematch! p1 and p1x stay'));
    const log = steps(convertFrames(frames(g)).events).flatMap((e) => e.log ?? []);
    assert.ok(log.includes('p1 has requested a rematch! p2 and p1x stay'), log.join('\n'));
});

test('a capture holding a game and its rematch splits into two games', () => {
    const g1 = game('g1');
    g1[4].players.u2.base.damage = 30;
    g1[5].players.u2.base.damage = 30;
    const g2 = game('g2').slice(0, 3);
    const split = splitGames(frames([...g1, ...g2]));
    assert.deepStrictEqual(split.map((x) => x.length), [6, 3]);
    // without game ids: the chat log starts over, or a won game is followed by a new setup phase
    const noId = (s, k) => ({ ...s, id: undefined, ...(k === undefined ? {} : { totalMessages: k }) });
    assert.deepStrictEqual(splitGames(frames([...g1.map((s, k) => noId(s, k + 1)), ...g2.map((s, k) => noId(s, k + 1))])).map((x) => x.length), [6, 3]);
    assert.deepStrictEqual(splitGames(frames([...g1, ...g2].map((s) => noId(s)))).map((x) => x.length), [6, 3]);
    // an undo after the end (winners back to none, no setup) is not a new game
    const undone = [...g1, { ...structuredClone(g1[4]), winners: [] }];
    assert.deepStrictEqual(splitGames(frames(undone)).map((x) => x.length), [7]);

    // import.js writes each game: <id> and <id>.2
    const { importFile } = require('../import');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rematch-'));
    try {
        const file = path.join(dir, 'session.txt');
        fs.writeFileSync(file, toSocketIo([...g1, ...g2]));
        const out = importFile(file, {});
        assert.deepStrictEqual(out.map((x) => x.id), ['session', 'session.2']);
        assert.deepStrictEqual(out.map((x) => [endOf(x.events).winner, endOf(x.events).outcome, endOf(x.events).how ?? null]), [['p1', 'won', 'base destroyed'], [null, 'STUCK', null]]);
        assert.deepStrictEqual(steps(out[1].events).map((e) => e.state.round), [0, 1, 1]);
        assert.deepStrictEqual(out.map((x) => x.events[0].source.game), [1, 2]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** setup, round 1 action, round 1 regroup, round 2 action: the frames a rollback test starts from. */
function twoRounds() {
    const g = game().slice(0, 2);
    next(g, [alert('a', 'Round: 1 - Regroup Phase')], (s) => (s.phase = 'regroup'));
    next(g, [alert('b', 'Round: 2 - Action Phase')], (s) => (s.phase = 'action'));
    return g;
}
const rounds = (g) => readFrames(frames(g)).items.map((x) => x.state.round);

test('a rollback to an earlier round of the same phase moves the round back', () => {
    // the alert and the rollback line in one push
    const g = twoRounds();
    next(g, [alert('c', 'Round: 1 - Action Phase'), alert('d', P('u1'), ' has rolled back to ', 'the start of the action phase (round 2)')], (s) => (s.players.u1.availableResources = 1));
    assert.deepStrictEqual(rounds(g), [0, 1, 1, 2, 1]);
    // Karabast pushes each alert at once, so the round alert can come alone, before the rollback line
    const h = twoRounds();
    next(h, [alert('c', 'Round: 1 - Action Phase')], (s) => (s.players.u1.availableResources = 1));
    next(h, [alert('d', P('u1'), ' has rolled back to ', 'the start of the action phase (round 2)')]);
    assert.deepStrictEqual(rounds(h), [0, 1, 1, 2, 1, 1]);
    // a phase entered without its alert takes the alert that comes next (SWU Forge chat landing one frame late)
    const late = game().slice(0, 2);
    next(late, [alert('a', 'Round: 1 - Regroup Phase')], (s) => (s.phase = 'regroup'));
    next(late, [], (s) => (s.phase = 'action'));
    next(late, [alert('b', 'Round: 2 - Action Phase')], (s) => (s.players.u1.availableResources = 1));
    assert.deepStrictEqual(rounds(late), [0, 1, 1, 1, 2]);
});

test('resource phase: both players get their resource decision, the one who confirmed last holds the board', () => {
    const g = game().slice(0, 2);
    next(g, [alert('a', 'Round: 1 - Regroup Phase')], (s) => {
        s.phase = 'regroup';
        s.players.u1.promptState = { menuTitle: 'Select between 0 and 1 cards to resource', buttons: [] };
    });
    // bob confirmed first (no change, so no frame of its own); alice still had the prompt open
    next(g, [msg('b', [P('u1'), ' has resourced 1 card from hand']), msg('c', [P('u2'), ' has not resourced any cards'])], (s) => {
        s.players.u1.cardPiles.resources.push(s.players.u1.cardPiles.hand.pop());
        s.players.u1.promptState = {};
    });
    const res = steps(convertFrames(frames(g)).events).filter((e) => e.prompt === 'resource|-');
    assert.deepStrictEqual(res.map((e) => [e.pid, e.action.label, !!e.log]), [['p2', 'Done', false], ['p1', 'Resource 1', true]]);
    assert.strictEqual(res[1].state.players.p1.res.total, 3);
    assert.strictEqual(res[0].state.players.p1.res.total, 2, 'the first confirm shows the board before');
    // when alice was the one waiting, she goes first
    g[2].players.u1.promptState = { menuTitle: 'Waiting for opponent to choose cards to resource', buttons: [] };
    const again = steps(convertFrames(frames(g)).events).filter((e) => e.prompt === 'resource|-');
    assert.deepStrictEqual(again.map((e) => e.pid), ['p1', 'p2']);
});

test("triggered 'uses' lines are not new actions; action abilities (with a cost) are", () => {
    const g = game().slice(0, 3); // ends with 'p1 plays Wampa'
    next(g, [msg('a', [P('u1'), ' uses ', C(wampa), ' to give Sentinel to ', C(wampa), ' for this phase'])], (s) => (s.players.u1.cardPiles.groundArena[0].sentinel = true));
    next(g, [msg('b', [P('u1'), ' uses ', C(wampa), ', exhausting ', C(wampa), ' to draw a card'])], (s) => (s.players.u1.numCardsInDeck = 39));
    const s = steps(convertFrames(frames(g)).events).slice(-3).map((e) => [e.pid, e.prompt, e.title, e.action.label]);
    assert.deepStrictEqual(s, [
        ['p1', 'actionWindow|-', 'Choose an action', 'Wampa'],
        ['p1', '-|-', 'Resolve an ability', 'Wampa'],
        ['p1', 'actionWindow|-', 'Choose an action', 'Wampa']
    ]);
});

test('timer and undo lines on an unchanged board are not decisions', () => {
    const g = game().slice(0, 2);
    next(g, [alert('a', P('u1'), ' has 60 seconds of main time remaining.')]);
    next(g, [alert('b', P('u2'), ' has requested to undo')]);
    next(g, [alert('c', P('u1'), ' has denied the undo request')]);
    next(g, [msg('d', [P('u1'), ' plays ', C(wampa)])], (s) => {
        s.players.u1.cardPiles.hand = [];
        s.players.u1.cardPiles.groundArena = [{ ...wampa, zone: 'groundArena', power: 4, hp: 5 }];
    });
    const { events, report } = convertFrames(frames(g));
    assert.deepStrictEqual(steps(events).slice(1).map((e) => [e.pid, e.prompt, e.action.label]), [
        ['p1', 'log|-', 'Round: 1 - Action Phase'],
        ['p1', 'actionWindow|-', 'Wampa']
    ]);
    assert.strictEqual(report.steps, 2);
});
