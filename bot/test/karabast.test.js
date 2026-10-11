'use strict';
// bot/karabast on hand-made Karabast frames: legal actions, socket messages, the privacy scrub and the host guard.
// No engine, no card data and no server needed.
const test = require('node:test');
const assert = require('node:assert');
const { legalActions, gameMessage, decisionKey, makeScrubber } = require('../karabast/frame');
const { checkHost } = require('../karabast/socket');
const { randomSplit } = require('../karabast/selfplay');
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

test('checkHost allows localhost and refuses other hosts unless named', () => {
    assert.strictEqual(checkHost('http://127.0.0.1:9500').hostname, '127.0.0.1');
    assert.strictEqual(checkHost('http://localhost:9500').hostname, 'localhost');
    assert.throws(() => checkHost('https://karabast.net'), /refusing to connect to karabast.net/);
    assert.strictEqual(checkHost('https://example.org', ['example.org']).hostname, 'example.org');
});
