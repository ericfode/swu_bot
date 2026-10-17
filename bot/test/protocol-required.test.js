'use strict';
// Exercise the real referee and match loop without a built forceteki checkout.
// Only engine-dependent imports and board views are replaced; all negotiation,
// failure attribution, lifecycle and recording run through production code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

function load(file, dependencies) {
    const module = { exports: {} };
    const localRequire = (name) => {
        if (Object.hasOwn(dependencies, name)) {
            return dependencies[name];
        }
        throw new Error(`unexpected dependency in ${file}: ${name}`);
    };
    const wrapper = vm.runInThisContext(`(function(require,module,exports,__dirname) {\n${fs.readFileSync(file, 'utf8')}\n})`, { filename: file });
    wrapper(localRequire, module, module.exports, path.dirname(file));
    return module.exports;
}

const BOT = path.join(__dirname, '..');
const views = {
    snapshot: (eg) => ({ round: eg.round }),
    view: (eg) => ({ round: eg.round }),
    promptView: () => ({ actionWindow: false }),
    actionView: (eg, a, i) => ({ i, kind: a.kind, label: a.label }),
    actionKey: (eg, a) => a.label,
    placedRef: (eg, c) => c
};
const protocol = load(path.join(BOT, 'protocol.js'), {
    path,
    './env': { splitError: () => null, randomSplit: () => [] },
    './view': views,
    './stdio': require('../stdio'),
    [path.join(BOT, '..', 'forceteki', 'build/server', 'game/core/Constants.js')]: { DeckZoneDestination: {} }
});
const { playGame } = load(path.join(BOT, 'match.js'), {
    './rng': require('../rng'), './view': views, './protocol': protocol, './game-cards': require('../game-cards')
});
const decks = { p1: { metadata: { name: 'trusted fixture' }, deck: [] }, p2: { metadata: { name: 'trusted fixture' }, deck: [] } };
function fixtureEnv() {
    let starts = 0;
    return {
        get starts() { return starts; },
        cardDataGetter: { setCodeMap: new Map(), tokenData: {} },
        newGame() {
            const eg = {
                game: new EventEmitter(), ids: ['p1', 'p2'], round: 1, over: false, winner: null,
                start: async () => { starts++; },
                legalActions: () => [{ kind: 'button', label: 'Pass' }],
                promptSignature: () => 'fixture',
                player: () => ({ currentPrompt: () => ({}) }),
                isActionWindow: () => false,
                seatOf: (id) => id,
                apply: () => { eg.over = true; eg.winner = 'p1'; }
            };
            return eg;
        }
    };
}
function client(name, ready) {
    const messages = [];
    return {
        name, messages, closed: false,
        hello(msg) { messages.push(msg); return ready; },
        decide(msg) { messages.push(msg); return { t: 'act', i: 0 }; },
        over(msg) { messages.push(msg); return { t: 'ok' }; },
        close() { this.closed = true; }
    };
}
const end = (r) => r.events.findLast((e) => e.t === 'end');

test('required v2 records both accepted negotiations and keeps the hello envelope v1', async () => {
    const a = client('a', { t: 'ready', v: 2, version: 'build-a' });
    const b = client('b', { t: 'ready', v: 2, version: 'build-b' });
    const r = await playGame(fixtureEnv(), { seed: 1, bots: [a, b], decks, requiredProtocol: 2, record: true });
    assert.equal(r.outcome, 'won');
    assert.deepEqual(r.protocols, { p1: 2, p2: 2 });
    assert.deepEqual(r.versions, { p1: 'build-a', p2: 'build-b' });
    assert.equal(r.requiredProtocol, 2);
    assert.deepEqual(end(r).protocols, r.protocols);
    assert.equal(end(r).requiredProtocol, 2);
    assert.equal(r.events[0].requiredProtocol, 2);
    for (const c of [a, b]) {
        assert.equal(c.messages[0].v, 1);
        assert.deepEqual(c.messages[0].versions, [2]);
        assert.equal(c.messages.at(-1).t, 'over');
    }
});

for (const [label, ready, received] of [
    ['v1', { t: 'ready', v: 1 }, '1'],
    ['missing v', { t: 'ready' }, 'omitted'],
    ['null v', { t: 'ready', v: null }, 'null'],
    ['string v', { t: 'ready', v: '2' }, '"2"']
]) {
    test(`required v2 rejects ${label} before engine start and retains earlier accepted seat`, async () => {
        const env = fixtureEnv();
        const a = client('a', { t: 'ready', v: 2, version: 'build-a' });
        const b = client('bad', ready);
        const r = await playGame(env, { seed: 1, bots: [a, b], decks, requiredProtocol: 2, record: true });
        assert.equal(r.outcome, 'ERROR');
        assert.equal(r.by, 'p2');
        assert.equal(r.winner, 'p1');
        assert.equal(env.starts, 0);
        assert.equal(r.error, `p2 bad: requires protocol v2; ready.v must be 2, got ${received}`);
        assert.deepEqual(r.protocols, { p1: 2 });
        assert.deepEqual(r.versions, { p1: 'build-a' });
        assert.deepEqual(end(r).protocols, { p1: 2 });
        assert.equal(end(r).requiredProtocol, 2);
        assert.deepEqual(b.messages.map((m) => m.t), ['hello']);
        assert.equal(b.closed, true);
        assert.deepEqual(a.messages.map((m) => m.t), ['hello', 'over']);
    });
}

test('required v2 first-seat hello failure records policy and no accepted protocols', async () => {
    const a = client('bad', { t: 'ready' });
    const b = client('b', { t: 'ready', v: 2 });
    const r = await playGame(fixtureEnv(), { seed: 1, bots: [a, b], decks, requiredProtocol: 2, record: true });
    assert.equal(r.by, 'p1');
    assert.equal(r.winner, 'p2');
    assert.deepEqual(r.protocols, {});
    assert.deepEqual(end(r).protocols, {});
    assert.equal(end(r).requiredProtocol, 2);
    assert.deepEqual(b.messages, []);
});

test('required v2 rejects native choose bots with an attributed error and replay end', async () => {
    const env = fixtureEnv();
    const native = { name: 'native', choose: () => { throw new Error('must not run'); } };
    const b = client('b', { t: 'ready', v: 2 });
    const r = await playGame(env, { seed: 1, bots: [native, b], decks, requiredProtocol: 2, record: true });
    assert.equal(r.by, 'p1');
    assert.equal(r.outcome, 'ERROR');
    assert.equal(r.error, 'p1 native: requires protocol v2; a native choose() bot does not negotiate a protocol');
    assert.equal(env.starts, 0);
    assert.deepEqual(r.protocols, {});
    assert.deepEqual(r.events.map((e) => e.t), ['header', 'end']);
});

test('local legacy mode still negotiates v1 and records actual per-seat versions', async () => {
    const a = client('legacy', { t: 'ready' });
    const b = client('modern', { t: 'ready', v: 2 });
    const r = await playGame(fixtureEnv(), { seed: 1, bots: [a, b], decks, record: true });
    assert.equal(r.outcome, 'won');
    assert.deepEqual(r.protocols, { p1: 1, p2: 2 });
    assert.deepEqual(a.messages[0].versions, [1, 2]);
    assert.equal(a.messages.some((m) => m.t === 'over'), false);
    assert.equal(b.messages.at(-1).t, 'over');
    assert.equal(Object.hasOwn(r, 'requiredProtocol'), false);
});

test('local native mode has no fabricated negotiated version', async () => {
    const native = { name: 'native', choose: ({ actions }) => actions[0] };
    const b = client('modern', { t: 'ready', v: 2 });
    const r = await playGame(fixtureEnv(), { seed: 1, bots: [native, b], decks, record: true });
    assert.equal(r.outcome, 'won');
    assert.deepEqual(r.protocols, { p2: 2 });
});
