'use strict';
// bot/karabast on hand-made Karabast frames: legal actions, socket messages, the privacy scrub and the host guard.
// No engine, no card data and no server needed.
const test = require('node:test');
const assert = require('node:assert');
const { legalActions, gameMessage, decisionKey, makeScrubber, randomSplit } = require('../karabast/frame');
const { checkHost } = require('../karabast/socket');
const { seededRng } = require('../rng');

const unit = (uuid, extra = {}) => ({ uuid, name: uuid, zone: 'groundArena', hp: 4, damage: 1, ...extra });

function frame(promptState, piles = {}) {
    return {
        id: 'game-1',
        phase: 'action',
        players: {
            'user-a': {
                name: 'Alice',
                user: { id: 'user-a', username: 'Alice', cosmetics: { cardback: {} } },
                promptState,
                cardPiles: { hand: [], resources: [], groundArena: [], spaceArena: [], discard: [], ...piles },
                leaders: [{ uuid: 'L1', name: 'Leader', zone: 'base', selectable: true }],
                base: { uuid: 'B1', name: 'Base', zone: 'base', hp: 30, damage: 0 }
            },
            'user-b': {
                name: 'Bob',
                user: { id: 'user-b', username: 'Bob' },
                promptState: {},
                cardPiles: { hand: [{ controllerId: 'user-b', zone: 'hand' }], groundArena: [unit('U9', { controllerId: 'user-b' })] },
                base: { uuid: 'B2', name: 'Base', zone: 'base', hp: 25, damage: 3 }
            }
        },
        spectators: [{ id: 'spec-1', name: 'Watcher' }],
        newMessages: []
    };
}

test('legalActions reads buttons and selectable flags like env.legalActions', () => {
    const f = frame({
        promptUuid: 'P1',
        menuTitle: 'Choose an action',
        buttons: [
            { text: 'Pass', arg: 'pass', uuid: 'P1', command: 'menuButton' },
            { text: 'Off', arg: 'off', uuid: 'P1', command: 'menuButton', disabled: true },
            { text: 'Done', arg: 'done', uuid: 'P1', command: 'statefulPromptResults' }
        ]
    }, { hand: [{ uuid: 'H1', name: 'Wampa', zone: 'hand', selectable: true }, { uuid: 'H2', name: 'Picked', zone: 'hand', selectable: true, selected: true }] });
    const acts = legalActions(f, 'user-a');
    assert.deepStrictEqual(acts.map((a) => [a.kind, a.label]), [['button', 'Pass'], ['card', 'Wampa'], ['card', 'Leader']]);
    assert.deepStrictEqual(legalActions(f, 'user-b'), []);
    assert.deepStrictEqual(gameMessage(acts[0]), ['menuButton', 'pass', 'P1']);
    assert.deepStrictEqual(gameMessage(acts[1]), ['cardClicked', 'H1']);
});

test('distribute caps indirect damage at remaining HP and leaves bases uncapped', () => {
    const f = frame({
        promptUuid: 'P2',
        distributeAmongTargets: { type: 'distributeIndirectDamage', amount: 3, canDistributeLess: false, canChooseNoTargets: false, maxTargets: null }
    }, { groundArena: [unit('U1', { selectable: true })] });
    f.players['user-a'].leaders[0].selectable = false;
    f.players['user-a'].base.selectable = true;
    const [a] = legalActions(f, 'user-a');
    assert.strictEqual(a.kind, 'distribute');
    assert.deepStrictEqual(a.targets, ['U1', 'B1']);
    assert.deepStrictEqual(a.caps, [3, Infinity]);
    const split = randomSplit(a, seededRng('t'));
    assert.strictEqual(split.reduce((s, e) => s + e.amount, 0), 3);
    assert.deepStrictEqual(gameMessage(a, [{ id: 'U1', amount: 2 }, { id: 'B1', amount: 1 }, { id: 'X', amount: 0 }]),
        ['statefulPromptResults', { type: 'distributeIndirectDamage', valueDistribution: [{ uuid: 'U1', amount: 2 }, { uuid: 'B1', amount: 1 }] }, 'P2']);
});

test('options, numbers, display cards and per-card buttons', () => {
    const f = frame({
        promptUuid: 'P3',
        dropdownListOptions: ['Wampa'],
        selectNumber: { min: 0, max: 1 },
        displayCards: [{ cardUuid: 'D1', internalName: 'shown', selectionState: 'selectable' }]
    });
    f.players['user-a'].leaders[0].selectable = false;
    const acts = legalActions(f, 'user-a');
    assert.deepStrictEqual(acts.map((a) => gameMessage(a)), [
        ['menuButton', 'Wampa', 'P3'], ['menuButton', '0', 'P3'], ['menuButton', '1', 'P3'], ['menuButton', 'D1', 'P3', 'menuButton']
    ]);
    f.players['user-a'].promptState.perCardButtons = [{ text: 'Discard', arg: 'discard', command: 'perCardMenuButton' }];
    const withButtons = legalActions(f, 'user-a').filter((a) => a.kind !== 'option');
    assert.deepStrictEqual(withButtons.map((a) => gameMessage(a)), [['perCardMenuButton', 'discard', 'D1', 'P3']]);
});

test('decisionKey changes with the prompt and the actions', () => {
    const f = frame({ promptUuid: 'P1', buttons: [{ text: 'Pass', arg: 'pass', uuid: 'P1', command: 'menuButton' }] });
    const k1 = decisionKey(f, 'user-a');
    assert.strictEqual(decisionKey(structuredClone(f), 'user-a'), k1);
    f.players['user-a'].leaders[0].selectable = false;
    assert.notStrictEqual(decisionKey(f, 'user-a'), k1);
});

test('the scrub removes ids, names, user objects, spectators and chat text', () => {
    const scrub = makeScrubber(['me-spectator']);
    const f = frame({});
    f.players['user-a'].cardPiles.hand = [{ uuid: 'H1', name: 'Wampa', controllerId: 'user-a', ownerId: 'user-a' }];
    f.newMessages = [
        { date: 'd1', message: [{ id: 'user-a', name: 'Alice', type: 'player' }, ' plays ', { name: 'Wampa' }] },
        { date: 'd2', message: [{ id: 'user-b', name: 'Bob', type: 'playerChat' }, ' ', 'hi Alice, I am Bob from Reno'] },
        { date: 'd3', message: { alert: { type: 'notification', message: 'Watcher has joined the game as a spectator' } } },
        { date: 'd4', message: 'me-spectator has joined the game as a spectator' }
    ];
    const out = scrub(f);
    const text = JSON.stringify(out);
    for (const s of ['Alice', 'Bob', 'user-a', 'user-b', 'Watcher', 'spec-1', 'me-spectator', 'Reno', 'cosmetics', '"user"']) {
        assert.ok(!text.includes(s), `${s} survived the scrub`);
    }
    assert.deepStrictEqual(Object.keys(out.players), ['player1', 'player2']);
    assert.strictEqual(out.players.player1.cardPiles.hand[0].controllerId, 'player1');
    assert.strictEqual(out.players.player1.cardPiles.hand[0].name, 'Wampa');
    assert.deepStrictEqual(out.spectators, []);
    assert.deepStrictEqual(out.newMessages[0].message, [{ id: 'player1', name: 'player1', type: 'player' }, ' plays ', { name: 'Wampa' }]);
    assert.deepStrictEqual(out.newMessages[1], { date: 'd2', message: [{ type: 'playerChat' }] });
    assert.strictEqual(out.newMessages[2].message.alert.message, 'a spectator has joined the game as a spectator');
    // the input frame is left as it was, and labels stay stable across frames
    assert.strictEqual(f.players['user-a'].name, 'Alice');
    assert.deepStrictEqual(Object.keys(scrub(frame({})).players), ['player1', 'player2']);
});

test('checkHost allows localhost, refuses other hosts unless named, and needs NODE_USE_ENV_PROXY behind a proxy', () => {
    assert.strictEqual(checkHost('http://127.0.0.1:9500').hostname, '127.0.0.1');
    assert.strictEqual(checkHost('http://localhost:9500').hostname, 'localhost');
    assert.throws(() => checkHost('https://karabast.net'), /refusing to connect to karabast.net/);
    const saved = { ...process.env };
    try {
        delete process.env.https_proxy;
        process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
        delete process.env.NODE_USE_ENV_PROXY;
        assert.throws(() => checkHost('https://example.org', ['example.org']), /NODE_USE_ENV_PROXY=1/);
        assert.strictEqual(checkHost('http://127.0.0.1:9500').hostname, '127.0.0.1');
        process.env.NODE_USE_ENV_PROXY = '1';
        assert.strictEqual(checkHost('https://example.org', ['example.org']).hostname, 'example.org');
    } finally {
        for (const k of ['HTTPS_PROXY', 'https_proxy', 'NODE_USE_ENV_PROXY']) {
            if (k in saved) {
                process.env[k] = saved[k];
            } else {
                delete process.env[k];
            }
        }
    }
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Observer } = require('../karabast/observe');
const { KarabastSeat } = require('../karabast/seat');
const { PeopleLedger } = require('../karabast/ledger');

const noCards = { internal: new Map(), title: new Map() };

test('observe builds the protocol state: own hand open, the other hidden, upgrades under their unit', () => {
    const f = frame({ promptUuid: 'P1', promptType: 'actionWindow', menuTitle: 'Choose an action', buttons: [{ text: 'Pass', arg: 'pass', uuid: 'P1', command: 'menuButton' }] }, {
        hand: [{ uuid: 'H1', name: 'Wampa', setId: { set: 'SOR', number: 42 }, zone: 'hand', controllerId: 'user-a', selectable: true }],
        resources: [{ uuid: 'R1', name: 'Ruin', setId: { set: 'SOR', number: 1 }, zone: 'resource', exhausted: true }]
    });
    f.players['user-a'].forceToken = { active: true, uuid: 'F1', selectionState: { selectable: true } };
    f.players['user-b'].cardPiles.groundArena[0].type = 'basicUnit';
    f.players['user-b'].cardPiles.groundArena.push({ uuid: 'UP', name: 'Shield', setId: { set: 'SOR', number: 9 }, type: 'tokenUpgrade', parentCardId: 'U9', zone: 'groundArena' });
    const obs = new Observer('user-a', { cards: noCards });
    const d = obs.decision(f);
    assert.strictEqual(d.prompt.actionWindow, true);
    assert.strictEqual(d.state.players.p1.handCount, 1);
    assert.deepStrictEqual(d.state.players.p1.hand, [{ id: 'c1', n: 'Wampa', s: 'SOR_042' }]);
    assert.deepStrictEqual(d.state.players.p1.resources[0].x, 1);
    assert.strictEqual(d.state.players.p1.force, 1);
    assert.strictEqual(d.state.players.p2.hand, undefined);
    assert.strictEqual(d.state.players.p2.handCount, 1);
    assert.deepStrictEqual(d.state.players.p2.ground[0].u, [{ id: obs.id('UP'), n: 'Shield', s: 'SOR_009', t: 1 }]);
    // the Force token is clickable through its selectionState
    assert.ok(d.actions.some((a) => a.kind === 'card' && a.cardUuid === obs.id('F1')));
    assert.deepStrictEqual(d.actions[0], { i: 0, kind: 'button', label: 'Pass', arg: 'pass' });
});

test('observe checks a bot split against targets, caps and the amount', () => {
    const obs = new Observer('user-a', { cards: noCards });
    const a = { kind: 'distribute', spec: { amount: 3, maxTargets: null }, targets: ['U1', 'B1'], caps: [2, Infinity] };
    const [u, b] = [obs.id('U1'), obs.id('B1')];
    assert.deepStrictEqual(obs.split(a, [{ id: u, amount: 2 }, { id: b, amount: 1 }]), [{ id: 'U1', amount: 2 }, { id: 'B1', amount: 1 }]);
    assert.strictEqual(obs.split(a, [{ id: u, amount: 3 }]), null); // over the cap
    assert.strictEqual(obs.split(a, [{ id: b, amount: 2 }]), null); // short of the amount
    assert.strictEqual(obs.split(a, [{ id: 'c99', amount: 3 }]), null); // not a target
});

function fakeSeat(client = { name: 'fake', decide: () => ({ t: 'act', i: 0 }) }, opts = {}) {
    const sock = new EventEmitter();
    sock.sent = [];
    sock.send = (...m) => sock.sent.push(m);
    return { sock, seat: new KarabastSeat(sock, 'user-a', client, { seed: 't', ...opts }) };
}

test('a seat never sends undo and answers undo requests itself: allow twice, then deny, never block', () => {
    const { seat } = fakeSeat();
    assert.throws(() => seat.send('rollbackToSnapshot', { type: 'quick' }), /refusing/);
    assert.throws(() => seat.send('resetActionTimer'), /refusing/);
    const ask = frame({
        promptUuid: 'U', menuTitle: 'Your opponent would like to undo their previous action',
        buttons: ['Allow', 'Deny', 'Deny and Block Requests'].map((t) => ({ text: t, arg: t, uuid: 'U', command: 'menuButton' }))
    });
    ask.players['user-a'].leaders[0].selectable = false;
    assert.deepStrictEqual([1, 2, 3, 4].map(() => seat.rule(ask).label), ['Allow', 'Allow', 'Deny', 'Deny']);
    const pay = frame({ promptUuid: 'Q', menuTitle: 'You can no longer pay the cost for Wampa', buttons: ['Request undo', 'Abandon'].map((t) => ({ text: t, arg: t, uuid: 'Q', command: 'menuButton' })) });
    assert.strictEqual(seat.rule(pay).label, 'Abandon');
});

test('a seat plays the bot answer, hides undo buttons from it, and reports the result', async () => {
    let seen = null;
    const client = { name: 'fake', hello: () => ({ t: 'ready', v: 2 }), decide: (msg) => { seen = msg; return { t: 'act', i: msg.actions.findIndex((a) => a.label === 'Pass') }; }, over: () => ({ t: 'ok' }) };
    const { sock, seat } = fakeSeat(client);
    const done = seat.play();
    const f = frame({ promptUuid: 'P1', menuTitle: 'Choose an action', buttons: ['Undo', 'Pass'].map((t) => ({ text: t, arg: t.toLowerCase(), uuid: 'P1', command: 'menuButton' })) });
    sock.emit('gamestate', f);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(seen && !seen.actions.some((a) => /undo/i.test(a.label)));
    assert.deepStrictEqual(sock.sent.at(-1), ['game', 'menuButton', 'pass', 'P1']);
    sock.emit('gamestate', { ...frame({}), winners: ['Alice'] });
    const r = await done;
    assert.strictEqual(r.result, 'win');
    assert.strictEqual(r.stats.decisions, 1);
});

test('the people ledger caps distinct people and keeps no ids', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'people.json');
    const l = new PeopleLedger(file, 3);
    assert.strictEqual(l.add(['user-a', 'user-b'], 'watched'), 2);
    assert.strictEqual(l.add(['user-a'], 'played'), 0);
    assert.ok(l.room(1) && !l.room(2));
    assert.throws(() => l.add(['user-c', 'user-d'], 'watched'), /cap/);
    const again = new PeopleLedger(file, 3);
    assert.strictEqual(again.count, 2);
    assert.ok(again.has('user-b'));
    assert.ok(!fs.readFileSync(file, 'utf8').includes('user-'));
    for (const bad of [NaN, Number('ten'), Number(undefined), -1, 2.5, Infinity]) {
        assert.throws(() => new PeopleLedger(file, bad), /people cap/);
    }
});

test('two ledgers on one file share the cap', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'people.json');
    const a = new PeopleLedger(file, 2);
    const b = new PeopleLedger(file, 2);
    assert.strictEqual(a.add(['user-a'], 'played'), 1);
    assert.strictEqual(b.add(['user-b'], 'watched'), 1);
    // a's own snapshot still says 1; the file says 2
    assert.ok(!a.room(1));
    assert.throws(() => a.add(['user-c'], 'played'), /cap/);
    assert.strictEqual(new PeopleLedger(file, 2).count, 2);
    assert.ok(!fs.existsSync(`${file}.lock`));
    // a lock someone else holds is never taken over, however old
    fs.writeFileSync(`${file}.lock`, '');
    fs.utimesSync(`${file}.lock`, new Date(0), new Date(0));
    assert.throws(() => new PeopleLedger(file, 5, { lockWaitMs: 100 }).add(['user-d'], 'played'), /stayed locked.*remove/);
    assert.ok(fs.existsSync(`${file}.lock`));
    assert.strictEqual(new PeopleLedger(file, 5).count, 2);
});

test('a bad split is a bot failure, and the seat concedes at maxFailures', async () => {
    const client = { name: 'fake', hello: () => ({ t: 'ready', v: 2 }), decide: () => ({ t: 'act', i: 0, split: [{ id: 'c99', amount: 3 }] }), over: () => ({ t: 'ok' }) };
    const { sock, seat } = fakeSeat(client);
    const done = seat.play();
    const dist = (uuid) => {
        const f = frame({ promptUuid: uuid, distributeAmongTargets: { type: 'distributeIndirectDamage', amount: 3, canDistributeLess: false, canChooseNoTargets: false, maxTargets: null } },
            { groundArena: [unit('U1', { selectable: true })] });
        f.players['user-a'].leaders[0].selectable = false;
        f.players['user-a'].base.selectable = true;
        return f;
    };
    sock.emit('gamestate', dist('P1'));
    await new Promise((r) => setTimeout(r, 20));
    // the first failure plays a random split for the bot
    assert.strictEqual(sock.sent.at(-1)[1], 'statefulPromptResults');
    sock.emit('gamestate', dist('P2'));
    // a seat that never concedes would keep the test waiting: end it after 2 s
    const timer = setTimeout(() => seat.done('none', 'the seat did not concede'), 2000);
    const r = await done;
    clearTimeout(timer);
    assert.strictEqual(r.result, 'loss');
    assert.strictEqual(r.stats.failures.length, 2);
    assert.match(r.stats.failures[0], /bad split/);
    assert.deepStrictEqual(sock.sent.at(-1), ['game', 'concede']);
});

test('a seat concedes when the server keeps ignoring its answers at one decision', async () => {
    const client = { name: 'fake', hello: () => ({ t: 'ready', v: 2 }), decide: () => ({ t: 'act', i: 0 }), over: () => ({ t: 'ok' }) };
    const { sock, seat } = fakeSeat(client, { retryMs: 50, maxIgnored: 3 });
    const done = seat.play();
    // the server never moves on from this frame, as when it can no longer serialize the game
    sock.emit('gamestate', frame({ promptUuid: 'P1', menuTitle: 'Choose an action', buttons: ['Pass', 'Claim'].map((t) => ({ text: t, arg: t, uuid: 'P1', command: 'menuButton' })) }));
    const timer = setTimeout(() => seat.done('none', 'the seat did not concede'), 5000);
    const r = await done;
    clearTimeout(timer);
    assert.strictEqual(r.result, 'loss');
    assert.strictEqual(r.stats.rejected, 3);
    assert.match(r.reason, /ignored 3 answers/);
    assert.deepStrictEqual(sock.sent.at(-1), ['game', 'concede']);
});

test('a quick-match run that fails after entering the queue keeps the place counted', async () => {
    const http = require('http');
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const { spawn } = require('child_process');
    // a server that takes the queue entry, then drops the socket before any lobbystate
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    });
    server.on('upgrade', (req, socket) => socket.destroy());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-queue-'));
    const ledgerFile = path.join(dir, 'people.json');
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'karabast', 'queue.js'), '--server', `http://127.0.0.1:${server.address().port}`,
        '--bot', 'js-random', '--deck', 'luke-skywalker_jtl_data-vault', '--games', '1', '--ledger', ledgerFile, '--max-people', '10'], { stdio: 'ignore' });
    const code = await new Promise((r) => child.on('exit', r));
    server.close();
    assert.strictEqual(code, 1);
    const data = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    assert.strictEqual(Object.keys(data.people).length, 1);
    assert.match(Object.keys(data.people)[0], /^unidentified-/);
    assert.deepStrictEqual(data.held, {});
});

test('a reservation holds places until it is used or released', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'people.json');
    const a = new PeopleLedger(file, 3);
    const b = new PeopleLedger(file, 3);
    a.add(['user-a'], 'played');
    const hold = a.reserve(2);
    assert.ok(hold);
    // 1 counted + 2 held: nothing left for b, whether it reserves or adds directly
    assert.strictEqual(b.reserve(1), null);
    assert.ok(!b.room(1));
    assert.throws(() => b.add(['user-x'], 'played'), /reserved/);
    // the watched game had one new player: the unused place goes back with the reservation
    assert.strictEqual(a.add(['user-a', 'user-b'], 'watched', hold), 1);
    const again = b.reserve(1);
    assert.ok(again);
    b.release(again);
    assert.ok(b.room(1));
    assert.strictEqual(new PeopleLedger(file, 3).reserved(), 0);
    // a place held for a game that was joined but never identified stays counted
    const seen = b.reserve(1);
    b.spend(seen, 'watched');
    b.release(seen);
    assert.strictEqual(new PeopleLedger(file, 3).count, 3);
    assert.ok(!b.room(1));
});

/** A tiny watched game as spectate.js writes it: one scrubbed gamestate per line, both hands hidden. */
function watchedStates() {
    const card = (uuid, name, number, extra = {}) => ({ id: `id-${uuid}`, setId: { set: 'SOR', number }, uuid, name, ...extra });
    const player = (id, n) => ({
        id, name: id, hasInitiative: id === 'player1', availableResources: 0, numCardsInDeck: 40, isActionPhaseActivePlayer: false,
        leaders: [card(`L${n}`, `Leader ${n}`, n, { type: 'leader', zone: 'base', controllerId: id, exhausted: false })],
        base: card(`B${n}`, `Base ${n}`, 20 + n, { type: 'base', hp: 30, damage: 0, controllerId: id }),
        cardPiles: { hand: [{ controllerId: id, zone: 'hand' }], resources: [], groundArena: [], spaceArena: [], discard: [], outsideTheGame: [], capturedZone: [], credits: [] }
    });
    const P = (id) => ({ type: 'player', id, name: id, uuid: `Player_${id}` });
    const s0 = { id: 'g1', phase: 'setup', winners: [], players: { player1: player('player1', 1), player2: player('player2', 2) }, newMessages: [] };
    const s1 = structuredClone(s0);
    s1.phase = 'action';
    s1.players.player1.isActionPhaseActivePlayer = true;
    s1.newMessages = [{ date: '2026-10-01T12:00:01.000Z', message: { alert: { type: 'notification', message: ['Round: 1 - Action Phase'] } } }];
    const s2 = structuredClone(s1);
    s2.players.player2.base.damage = 4;
    s2.newMessages = [{ date: '2026-10-01T12:00:02.000Z', message: [P('player1'), ' attacks ', P('player2'), "'s base with ", { type: 'card', name: 'Leader 1', uuid: 'L1' }] }];
    const s3 = structuredClone(s2);
    s3.winners = ['player1'];
    s3.newMessages = [{ date: '2026-10-01T12:00:03.000Z', message: [P('player2'), ' concedes the game'] }];
    return [s0, s1, s2, s3];
}

test('the live view serves a game being played without an end line, and refuses ids outside the runs folder', () => {
    const { Games, LIVE_MS } = require('../karabast/live-view');
    const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'));
    fs.mkdirSync(path.join(runs, 'w-1'));
    const file = path.join(runs, 'w-1', 'abcdef012345.jsonl');
    const states = watchedStates().map((s) => JSON.stringify(s));
    // three boards and the recorder halfway through writing the fourth
    fs.writeFileSync(file, `${states.slice(0, 3).join('\n')}\n${states[3].slice(0, 40)}`);
    const games = new Games(runs);
    const [entry] = games.list();
    assert.deepStrictEqual([entry.id, entry.kind], ['w-1/abcdef012345', 'watched']);
    let g = games.get(entry.id);
    assert.ok(g.live);
    let lines = games.replay(g).trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines[0].t, 'header');
    assert.ok(lines.length > 1 && !lines.some((e) => e.t === 'end'));
    // the game ends: the end line is served and the game is no longer live
    fs.writeFileSync(file, `${states.join('\n')}\n`);
    g = games.get(entry.id);
    assert.ok(!g.live);
    lines = games.replay(g).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual([lines.at(-1).t, lines.at(-1).winner], ['end', 'p1']);
    assert.strictEqual(games.summary(entry).winner, 'p1');
    // a capture that stopped with no winner is live only for a while
    fs.writeFileSync(file, `${states.slice(0, 3).join('\n')}\n`);
    assert.ok(games.get(entry.id).live);
    assert.ok(!new Games(runs, { now: () => Date.now() + LIVE_MS + 1000 }).get(entry.id).live);
    for (const bad of ['../w-1/abcdef012345', 'w-1/../../abcdef012345', '.w/abcdef012345', 'w-1/abcdef01234', 'w-1/other/abcdef012345', 'w-1/frames/../abcdef012345']) {
        assert.strictEqual(games.get(bad), null, bad);
    }
});

test('the live view lists every game it can open, a game with only its first board included', () => {
    const { Games } = require('../karabast/live-view');
    const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'));
    const first = `${JSON.stringify(watchedStates()[0])}\n`;
    // a folder name a game id cannot carry is left out, so no listed game is a 404
    fs.mkdirSync(path.join(runs, 'run 1'));
    fs.writeFileSync(path.join(runs, 'run 1', 'abcdef012345.jsonl'), first);
    fs.mkdirSync(path.join(runs, 'w-1'));
    for (let i = 0; i < 45; i++) {
        fs.writeFileSync(path.join(runs, 'w-1', `${String(i).padStart(12, '0')}.jsonl`), first);
    }
    fs.writeFileSync(path.join(runs, 'w-1', 'ffffffffffff.jsonl'), 'not a frame file\n');
    const games = new Games(runs);
    const all = games.list().map((e) => games.summary(e));
    assert.strictEqual(all.length, 46);
    assert.ok(all.every((g) => g.id.startsWith('w-1/')));
    const one = all.find((g) => g.id === 'w-1/000000000000');
    assert.deepStrictEqual([one.board, one.steps, one.live], [true, 0, true]);
    assert.strictEqual(all.find((g) => g.id === 'w-1/ffffffffffff').board, false);
});

test('the live view gzips only when the client allows it', () => {
    const { acceptsGzip } = require('../karabast/live-view');
    const cases = { 'gzip': true, 'gzip, deflate, br': true, 'br;q=1.0, gzip;q=0.8': true, '*': true, 'gzip;q=0': false, 'gzip;q=0.0, br': false, '*;q=0': false, 'br, *;q=0.5': true, 'identity': false, '': false };
    for (const [header, want] of Object.entries(cases)) {
        assert.strictEqual(acceptsGzip(header), want, header);
    }
});

test('the live view answers only under its key', async () => {
    const { Games, makeServer, checkBinding } = require('../karabast/live-view');
    // beyond this machine a key is required: a live bot game shows our hand
    assert.throws(() => checkBinding('0.0.0.0', null), /--key/);
    assert.doesNotThrow(() => checkBinding('0.0.0.0', 'k3y-for-tests'));
    assert.doesNotThrow(() => checkBinding('127.0.0.1', null));
    const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-'));
    fs.writeFileSync(path.join(kit, 'swu-viewer-kit.js'), '// kit');
    fs.writeFileSync(path.join(kit, 'card-text.json'), '{}');
    fs.writeFileSync(path.join(kit, 'secret.txt'), 'no');
    const server = makeServer({ games: new Games(fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'))), kit, key: 'k3y-for-tests' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const at = (p) => fetch(`http://127.0.0.1:${server.address().port}${p}`).then((r) => r.status);
    try {
        assert.deepStrictEqual(
            await Promise.all(['/', '/games', '/k3y-for-tests/', '/k3y-for-tests/games', '/k3y-for-tests/kit/swu-viewer-kit.js', '/k3y-for-tests/kit/secret.txt', '/k3y-for-tests/game/w-1/abcdef012345'].map(at)),
            [404, 404, 200, 200, 200, 404, 404]
        );
        // odd paths get an answer, and the server keeps serving
        assert.deepStrictEqual(await Promise.all(['//', '//k3y-for-tests/', '/k3y-for-tests/%E0%A4%A', '/k3y-for-tests/games'].map(at)), [404, 404, 400, 200]);
    } finally {
        server.close();
    }
});

test('the queue loop keeps going after a wait with no match, and stops after maxErrors failures in a row', async () => {
    const { runLoop } = require('../karabast/queue');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-loop-'));
    const ledger = new PeopleLedger(path.join(out, 'people.json'), 10);
    const seen = [];
    // game 0: no match; 1: a win; 2: a loss; 3-5: failures (the loop stops at the third)
    const play = async (g, hooks) => {
        hooks.onQueued();
        seen.push(JSON.parse(fs.readFileSync(path.join(out, 'status.json'), 'utf8')).state);
        if (g === 0) {
            throw new Error('no match within 10 minutes');
        }
        if (g >= 3) {
            throw new Error('socket closed while queued: transport error');
        }
        await hooks.onMatched(`person-${g}`);
        hooks.onGameFile(`00000000000${g}.jsonl`);
        seen.push(JSON.parse(fs.readFileSync(path.join(out, 'status.json'), 'utf8')).file);
        return { result: g === 1 ? 'win' : 'loss', file: `00000000000${g}.jsonl` };
    };
    const end = await runLoop({ games: 10, gapS: 25, maxErrors: 3, ledger, out, bot: 'c-clock', deck: 'd', play, log: () => {}, wait: async () => {} });
    assert.deepStrictEqual(seen, ['queued', 'queued', '000000000001.jsonl', 'queued', '000000000002.jsonl', 'queued', 'queued', 'queued']);
    assert.deepStrictEqual([end.state, end.played, end.won, end.lost, end.errors, end.ok], ['stopped', 2, 1, 1, 3, false]);
    assert.match(end.reason, /3 failures in a row/);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(out, 'status.json'), 'utf8')).state, 'stopped');
    const rows = fs.readFileSync(path.join(out, 'games.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(rows.map((r) => r.result), ['no match', 'win', 'loss', 'error', 'error', 'error']);
    // every queued game keeps its place: 2 known people and 4 that may have been matched unseen
    assert.strictEqual(new PeopleLedger(path.join(out, 'people.json'), 10).count, 6);
});

test('the queue loop counts a game with no result as a failure and says why it stopped', async () => {
    const { runLoop } = require('../karabast/queue');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-loop-'));
    const results = ['none', 'loss', 'none'];
    const play = async (g, hooks) => {
        hooks.onQueued();
        return { result: results[g], reason: results[g] === 'none' ? 'socket closed: transport close' : 'game over' };
    };
    const end = await runLoop({ games: 3, gapS: 25, out, bot: 'c-clock', deck: 'd', play, log: () => {}, wait: async () => {} });
    assert.deepStrictEqual([end.played, end.lost, end.errors, end.ok], [1, 1, 2, false]);
    assert.strictEqual(end.reason, 'the last game failed: socket closed: transport close');
    // a failure earlier in the run does not stick to a run that ends well
    const ok = await runLoop({ games: 2, gapS: 25, out, bot: 'c-clock', deck: 'd', play, log: () => {}, wait: async () => {} });
    assert.deepStrictEqual([ok.ok, ok.reason], [true, 'played the 2 game(s) asked for']);
});

test('the queue loop stops at the people cap and on the stop file', async () => {
    const { runLoop } = require('../karabast/queue');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-loop-'));
    const ledger = new PeopleLedger(path.join(out, 'people.json'), 2);
    let n = 0;
    const play = async (g, hooks) => {
        hooks.onQueued();
        await hooks.onMatched(`person-${n++}`);
        return { result: 'loss' };
    };
    const capped = await runLoop({ games: 10, gapS: 25, ledger, out, bot: 'c-clock', deck: 'd', play, log: () => {}, wait: async () => {} });
    assert.deepStrictEqual([capped.played, capped.ok], [2, true]);
    assert.match(capped.reason, /people cap is reached \(2 counted/);
    const stop = path.join(out, 'STOP');
    fs.writeFileSync(stop, '');
    const stopped = await runLoop({ games: 10, gapS: 25, stopFile: stop, out, bot: 'c-clock', deck: 'd', play, log: () => {}, wait: async () => {} });
    assert.deepStrictEqual([stopped.played, stopped.reason], [0, 'the stop file exists']);
});

test('the live view names our bot in a bot game and reports the queue run', () => {
    const { Games, STATUS_STALE_MS } = require('../karabast/live-view');
    const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'));
    const dir = path.join(runs, 'q-1');
    fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
    // our seat is player2 here: the frames of a bot game are its own view
    const hand = [{ id: 'id-H1', setId: { set: 'SOR', number: 9 }, uuid: 'H1', name: 'Wampa', zone: 'hand', controllerId: 'a spectator' }];
    const states = watchedStates().map((s) => {
        const me = { ...s.players.player2, id: 'a spectator', name: 'a spectator' };
        me.cardPiles = { ...me.cardPiles, hand };
        return { ...s, players: { player1: s.players.player1, 'a spectator': me } };
    });
    fs.writeFileSync(path.join(dir, 'frames', 'abcdef012345.jsonl'), states.map((s) => JSON.stringify(s)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'games.jsonl'), JSON.stringify({ bot: 'c-clock', result: 'loss', file: 'abcdef012345.jsonl' }) + '\n');
    let now = Date.now();
    const games = new Games(runs, { now: () => now });
    const g = games.get('q-1/frames/abcdef012345');
    const h = g.events[0];
    const ours = h.source.pov;
    assert.ok(['p1', 'p2'].includes(ours));
    assert.deepStrictEqual(h.players.map((p) => [p.id === ours, p.bot]), [[ours === 'p1', ours === 'p1' ? 'c-clock (ours)' : 'opponent'], [ours === 'p2', ours === 'p2' ? 'c-clock (ours)' : 'opponent']]);
    const s = games.summary(games.list()[0]);
    assert.deepStrictEqual([s.bot, s.ours], ['c-clock', ours]);

    assert.strictEqual(games.status(), null);
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ bot: 'c-clock', state: 'playing', file: 'abcdef012345.jsonl', token: 'never sent', played: 1 }));
    const st = games.status();
    assert.deepStrictEqual([st.state, st.game, st.played, st.stale, 'token' in st], ['playing', 'q-1/frames/abcdef012345', 1, false, false]);
    now += STATUS_STALE_MS + 1000;
    assert.strictEqual(games.status().stale, true);
});
