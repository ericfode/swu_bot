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
