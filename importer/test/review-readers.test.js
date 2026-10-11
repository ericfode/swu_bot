'use strict';

// Regression tests for the capture readers (importer/sources.js): SWU Forge timelines and devtools HAR exports.

const test = require('node:test');
const assert = require('node:assert');
const { convertFrames, readFrames } = require('../karabast');
const { readText } = require('../sources');
const { toTimeline, toSocketIo } = require('./formats');

const P = (id) => ({ type: 'player', id, name: id === 'u1' ? 'alice' : 'bob', uuid: `Player_${id}` });
const alert = (text) => ({ alert: { type: 'notification', message: [text] } });
const T0 = Date.parse('2026-10-01T12:00:00.000Z');

function player(id, o = {}) {
    return {
        id, name: id === 'u1' ? 'alice' : 'bob', user: { id, username: id === 'u1' ? 'alice' : 'bob' },
        hasInitiative: id === 'u1', availableResources: 0, numCardsInDeck: 40, isActionPhaseActivePlayer: false,
        leaders: [{ id: `id-L${id}`, uuid: `L${id}`, name: id === 'u1' ? 'Luke Skywalker' : 'Darth Vader', setId: { set: 'SOR', number: id === 'u1' ? 5 : 10 }, type: 'leader', zone: 'base', controllerId: id, exhausted: false }],
        base: { id: `id-B${id}`, uuid: `B${id}`, name: id === 'u1' ? 'Echo Base' : 'Capital City', setId: { set: 'SOR', number: id === 'u1' ? 23 : 28 }, type: 'base', hp: 30, damage: 0, controllerId: id },
        cardPiles: { hand: [], resources: [], groundArena: [], spaceArena: [], discard: [], outsideTheGame: [], capturedZone: [] },
        ...o
    };
}

/**
 * A game of `rounds` rounds, one frame per decision, frames 3 s apart on the server clock. Each action phase has
 * `passes` frames where the players pass in turn (each changes the board), each regroup one resource frame. Every
 * frame's lines are dated `lead` ms before the frame is pushed. Returns the states and the push times.
 *
 * With `burst`, each phase starts as Karabast does it: the round alert goes out in its own push (GameChat.addAlert
 * pushes at once), and the push that ends the input follows 2 ms later with a draw.
 */
function longGame({ rounds = 4, passes = 4, lead = 50, burst = false } = {}) {
    const states = [];
    const pushed = [];
    const s = { id: 'g1', phase: 'setup', winners: [], players: { u1: player('u1'), u2: player('u2') }, newMessages: [] };
    let t = T0 - 3000;
    const push = (lines, after = 3000) => {
        t += after;
        states.push(structuredClone({ ...s, newMessages: lines.map((m, k) => ({ date: new Date(t - Math.min(lead, after / 2) + k / 10).toISOString(), message: m })) }));
        pushed.push(t);
    };
    const phaseStart = (phase, line) => {
        s.phase = phase;
        if (burst) {
            push([alert(line)]);
            s.players.u2.numCardsInDeck -= 1;
            push([[P('u2'), ' draws a card']], 2);
            return [];
        }
        return [alert(line)];
    };
    push([[P('u1'), ' is shuffling their deck']]);
    for (let r = 1; r <= rounds; r++) {
        for (let k = 0; k < passes; k++) {
            const who = k % 2 ? 'u2' : 'u1';
            const first = k === 0 ? phaseStart('action', `Round: ${r} - Action Phase`) : [];
            s.players[who].numCardsInDeck -= 1;
            s.players.u1.isActionPhaseActivePlayer = who === 'u2';
            s.players.u2.isActionPhaseActivePlayer = who === 'u1';
            push([...first, [P(who), ' passes']]);
        }
        const first = phaseStart('regroup', `Round: ${r} - Regroup Phase`);
        s.players.u1.availableResources += 1;
        push([...first, [P('u1'), ' has resourced 1 card from hand']]);
    }
    s.players.u2.base.damage = 30;
    s.winners = ['alice'];
    push([[P('u1'), ' has won the game']]);
    return { states, pushed };
}

const steps = (events) => events.filter((e) => e.t === 'step');
const view = (events) => steps(events).map((e) => [e.pid, e.action?.label, e.log, e.state]);
const raw = (states) => convertFrames(states.map((state) => ({ state }))).events;
const viaForge = (states, stamps) => convertFrames(readText(JSON.stringify(toTimeline(states, stamps))).frames).events;
const browser = (pushed, latency = () => 80) => pushed.map((t, i) => t + latency(i) - 7000);

test('SWU Forge: the reader matches raw frames on a plain multi-round game', () => {
    const { states, pushed } = longGame();
    assert.deepStrictEqual(view(viaForge(states, browser(pushed))), view(raw(states)));
});

test('SWU Forge: round alerts left by an undo across a phase boundary do not shift the chat clock', () => {
    const { states, pushed } = longGame();
    // the third frame of round 1's action phase: an undone regroup left its alerts, the board stays in the action phase
    const i = states.findIndex((s) => s.newMessages.some((m) => m.message?.alert?.message[0] === 'Round: 1 - Action Phase')) + 2;
    const at = (k) => new Date(pushed[i] - 400 + k).toISOString();
    states[i].newMessages.unshift({ date: at(0), message: alert('Round: 1 - Regroup Phase') }, { date: at(1), message: alert('Round: 2 - Action Phase') });
    assert.deepStrictEqual(view(viaForge(states, browser(pushed))), view(raw(states)));
});

test('SWU Forge: a rollback to the start of the action phase (a second alert, no phase change) does not shift the chat clock', () => {
    const { states, pushed } = longGame();
    const i = states.findIndex((s) => s.newMessages.some((m) => m.message?.alert?.message[0] === 'Round: 2 - Action Phase')) + 2;
    states[i].newMessages.unshift({ date: new Date(pushed[i] - 300).toISOString(), message: alert('Round: 2 - Action Phase') });
    assert.deepStrictEqual(view(viaForge(states, browser(pushed))), view(raw(states)));
});

test('SWU Forge: chat lines stay with their frame when push latency varies by a few hundred ms', () => {
    const { states, pushed } = longGame();
    const want = view(raw(states));
    // the pushes that start a phase (the ones the clock offset is taken from) arrive 300 ms later than the rest
    const phaseStart = (i) => i > 0 && states[i].phase !== states[i - 1].phase;
    assert.deepStrictEqual(view(viaForge(states, browser(pushed, (i) => (phaseStart(i) ? 380 : 80)))), want);
    assert.deepStrictEqual(view(viaForge(states, browser(pushed, (i) => (phaseStart(i) ? 80 : 380)))), want);
    // odd pushes arrive 70 ms later than even ones
    assert.deepStrictEqual(view(viaForge(states, browser(pushed, (i) => (i % 2 ? 150 : 80)))), want);
});

test('SWU Forge: a round alert stays with its phase change when the next push follows within milliseconds', () => {
    const { states, pushed } = longGame({ burst: true });
    const rawFrames = states.map((state) => ({ state }));
    const rounds = (frames) => readFrames(frames).items.map((x) => [x.state.phase, x.state.round]);
    const lines = (frames) => readFrames(frames).items.flatMap((x) => x.lines.map((l) => l.text));
    // both pushes of a burst arrive together; from one phase start to the next, latency moves by up to 300 ms (in the
    // last case most pushes are slow, so the fast ones arrive 300 ms sooner than the offset says)
    const slot = (i) => Math.floor((pushed[i] - T0) / 3000);
    for (const latency of [(i) => 80 + (slot(i) % 4) * 30, (i) => 170 - (slot(i) % 3) * 45, (i) => (slot(i) % 3 ? 380 : 80)]) {
        const back = readText(JSON.stringify(toTimeline(states, browser(pushed, latency)))).frames;
        assert.deepStrictEqual(rounds(back), rounds(rawFrames));
        assert.deepStrictEqual(lines(back), lines(rawFrames), 'no line lost');
    }
});

test('SWU Forge: deployed leaders read as deployed (Forge cards have no zone)', () => {
    const { states, pushed } = longGame({ rounds: 2 });
    const deploy = (s, type) => {
        const l = s.players.u2.leaders[0];
        Object.assign(l, { type, zone: 'groundArena', power: 5, hp: 5, damage: 0 });
        s.players.u2.cardPiles.groundArena = type === 'nonTokenLeaderUnit' ? [l] : [];
    };
    states.slice(4, 7).forEach((s) => deploy(s, 'nonTokenLeaderUnit'));
    states.slice(8, 10).forEach((s) => deploy(s, 'leaderUpgrade')); // a pilot leader deployed as an upgrade
    // p1 has a double-sided leader that flips in frame 6: same card, back-side title, still at the base
    states.forEach((s, i) => Object.assign(s.players.u1.leaders[0], { name: i < 6 ? 'Chancellor Palpatine' : 'Darth Sidious', setId: { set: 'TWI', number: 17 }, onStartingSide: i < 6 }));
    const leaders = (frames) => readFrames(frames).items.map((x) => [x.state.players.p1.leader, x.state.players.p2.leader]);
    const want = leaders(states.map((state) => ({ state })));
    assert.deepStrictEqual(want.map(([, l]) => l.dep), states.map((_, i) => ((i >= 4 && i < 7) || (i >= 8 && i < 10) ? 1 : 0)));
    assert.deepStrictEqual(want.map(([l]) => l.dep), states.map((_, i) => (i >= 6 ? 1 : 0)));
    assert.deepStrictEqual(leaders(readText(JSON.stringify(toTimeline(states, browser(pushed)))).frames), want);
});

test('SWU Forge: player chat is dropped, speaker name included', () => {
    const { states, pushed } = longGame({ rounds: 2 });
    const chatAt = 3;
    states[chatAt].newMessages.unshift({ date: new Date(pushed[chatAt] - 600).toISOString(), message: [{ type: 'playerChat', id: 'u2', name: 'bob' }, ' gl hf, my discord is bob#1234'] });
    const tl = toTimeline(states, browser(pushed));
    const want = view(raw(states));
    const check = (label, timeline) => {
        const r = convertFrames(readText(JSON.stringify(timeline)).frames);
        assert.strictEqual(r.report.chatDropped, 1, label);
        assert.ok(!/gl hf|discord|alice|bob/.test(JSON.stringify(r.events)), `${label}: chat or a username leaked`);
        assert.deepStrictEqual(view(r.events), want, label);
    };
    // as KaraBuddy's converter and formats.js write it: the speaker becomes a card token with no card id
    check('card token', tl);
    // a writer that names the speaker with a player token (no uuid, unlike real player tokens)
    const asPlayer = structuredClone(tl);
    const e = asPlayer.chat.find((x) => /gl hf/.test(JSON.stringify(x)));
    e.tokens[0] = { kind: 'player', name: 'bob' };
    check('player token', asPlayer);
});

test('SWU Forge: entries after the last frame are dropped, except the game\'s own alerts', () => {
    const { states, pushed } = longGame({ rounds: 2 });
    const stamps = browser(pushed);
    const want = raw(states);
    const tl = toTimeline(states, stamps);
    const late = Date.parse(states[states.length - 1].newMessages[0].date) + 60000;
    tl.chat.push(
        { ts: late, tokens: [{ kind: 'player', name: 'bob', uuid: 'Player_u2' }, ' has left the game'] },
        { ts: late + 1, tokens: [{ kind: 'alert', text: 'alice has requested a rematch!' }] },
        { ts: late + 2, tokens: [{ kind: 'card', name: 'bob', cardId: null, setId: null, controllerId: null }, ' rematch?'] }
    );
    const back = convertFrames(readText(JSON.stringify(tl)).frames).events;
    assert.deepStrictEqual(view(back), view(want));
    assert.deepStrictEqual(back[back.length - 1], want[want.length - 1], 'end event: the late "has left" line does not change how the game ended');
    assert.ok(!/alice|bob|rematch/.test(JSON.stringify(back)));
    // a timeout alert pushed after the last captured frame still says how the game ended (when the base survived)
    const alive = structuredClone(states);
    alive[alive.length - 1].players.u2.base.damage = 10;
    const tl2 = toTimeline(alive, stamps);
    tl2.chat.push({ ts: late + 3, tokens: [{ kind: 'alert', text: 'Game ended due to bob timing out.' }] });
    const timedOut = convertFrames(readText(JSON.stringify(tl2)).frames).events;
    assert.strictEqual(timedOut[timedOut.length - 1].how, 'timeout');
    assert.ok(!/bob/.test(JSON.stringify(timedOut)));
});

test('browser devtools HAR export of the game socket', () => {
    const { states } = longGame({ rounds: 2 });
    const msgs = toSocketIo(states).trim().split('\n').map((data, i) => ({ type: 'receive', time: T0 / 1000 + i, opcode: 1, data }));
    msgs.splice(1, 0, { type: 'send', time: T0 / 1000, opcode: 1, data: '42["game",{"type":"passAction"}]' }, { type: 'receive', time: T0 / 1000, opcode: 1, data: '2' });
    const har = { log: { version: '1.2', creator: { name: 'WebInspector', version: '537.36' }, entries: [
        { request: { url: 'https://karabast.net/' }, response: { status: 200 } },
        { request: { url: 'wss://karabast.net/ws/socket.io/?EIO=4&transport=websocket' }, response: { status: 101 }, _resourceType: 'websocket', _webSocketMessages: msgs }
    ] } };
    for (const text of [JSON.stringify(har), JSON.stringify(har, null, 2)]) {
        const cap = readText(text);
        assert.strictEqual(cap.meta.reader, 'har');
        assert.strictEqual(cap.frames.length, states.length);
        assert.strictEqual(cap.frames[0].t, T0);
        assert.deepStrictEqual(convertFrames(cap.frames).events, raw(states));
    }
});
