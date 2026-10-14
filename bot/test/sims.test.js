'use strict';
// The referee's simulations on the Rust engine (bot/sims, spec/protocol.md#sim): the pieces on their own, the vendored
// Kessel package, and a real game in which a bot that asks for "simEngine": "rust" gets Rust simulations, never the
// forceteki ones the referee falls back to when Kessel cannot load. The game needs the engine build and card data and
// is skipped without them.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPool, verifyPool } = require('../sims/pool');
const { stateHash } = require('../sims/state');
const { determinizeState } = require('../sims/rust-sims');
const { RustViews } = require('../sims/rust-view');
const { seededRng } = require('../rng');

const ROOT = path.join(__dirname, '..', '..');
const KESSEL = path.join(ROOT, 'vendor', 'kessel');
const ENGINE = fs.existsSync(path.join(ROOT, 'forceteki', 'build', 'server')) && fs.existsSync(path.join(ROOT, 'forceteki', 'test', 'json', 'Card'));

test('the vendored Kessel files are the ones VERSION.json names', () => {
    const version = JSON.parse(fs.readFileSync(path.join(KESSEL, 'VERSION.json'), 'utf8'));
    assert.match(version.commit, /^[0-9a-f]{40}$/);
    assert.ok(version.files['js/node.js'] && version.files['pkg/node/kessel_wasm_bg.wasm'], 'the adapter and the package');
    for (const [file, { bytes, sha256 }] of Object.entries(version.files)) {
        const body = fs.readFileSync(path.join(KESSEL, file));
        assert.equal(body.length, bytes, file);
        assert.equal(crypto.createHash('sha256').update(body).digest('hex'), sha256, file);
    }
});

test('pool provenance checks exact bytes and permits relocation without changing content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sims-pool-'));
    try {
        const a = path.join(dir, 'a.json');
        const b = path.join(dir, 'b.json');
        const body = JSON.stringify({ schema: 'omni-rs-pool-v1', cards: [{ setCode: 'SOR_014' }] });
        fs.writeFileSync(a, body);
        fs.writeFileSync(b, body);
        const pool = loadPool(a);
        assert.equal(verifyPool(pool.provenance, b).provenance.sha256, pool.provenance.sha256);
        fs.appendFileSync(b, '\n');
        assert.throws(() => verifyPool(pool.provenance, b), /hash mismatch/);
        assert.throws(() => verifyPool(null, b), /unrestricted deal/);
        fs.writeFileSync(b, JSON.stringify({ schema: 'omni-rs-pool-v1', cards: [{ setCode: 'SOR_014' }, { setCode: 'SOR_014' }] }));
        assert.throws(() => loadPool(b), /duplicate pool card/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the committed pool loads: the 100 cards Rust simulations may play', () => {
    const pool = loadPool(path.join(__dirname, '..', 'sims', 'pool.json'));
    assert.equal(pool.cards.length, 100);
    assert.deepEqual(pool.cards.filter((c) => c.types.includes('leader')).map((c) => c.setCode), ['SOR_014', 'IBH_053', 'SEC_005']);
});

test('state hashes preserve card order while ignoring object insertion order', () => {
    assert.equal(stateHash({ round: 1, hand: ['c1', 'c2'] }), stateHash({ hand: ['c1', 'c2'], round: 1 }));
    assert.notEqual(stateHash({ hand: ['c1', 'c2'] }), stateHash({ hand: ['c2', 'c1'] }));
    assert.notEqual(stateHash({ resources: [{ id: 'c1', exhausted: false }] }), stateHash({ resources: [{ id: 'c1', exhausted: true }] }));
});

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

test('the vendored Kessel package loads with the committed pool', async () => {
    const { createSimulator } = require('../../vendor/kessel/js/node');
    const simulator = await createSimulator({ poolPath: path.join(__dirname, '..', 'sims', 'pool.json') });
    try {
        assert.equal(typeof simulator.loadState, 'function');
    } finally {
        simulator.free?.();
    }
});

test('a bot that asks for Rust simulations gets them in a real game, not the forceteki fallback', { skip: !ENGINE && 'engine or card data not built' }, async () => {
    const { Env } = require('../env');
    const { playGame } = require('../match');
    const { createRandomBot } = require('../players/random');
    const { rustEngine } = require('../sims/rust-sims');
    const searchBot = require('./fixtures/search-bot');
    assert.ok(await rustEngine(), 'the referee loads Kessel from vendor/kessel (else every simulation runs on forceteki)');

    const env = new Env();
    const pool = loadPool(path.join(__dirname, '..', 'sims', 'pool.json'));
    const rng = seededRng('sims-test');
    const decks = { p1: env.randomDeck(rng, { pool }), p2: env.randomDeck(rng, { pool }) };
    // the fixture search bot, asking for Rust simulations; every decision it is sent is seen here, and so is every
    // simulation reply
    const inner = searchBot.create('rusty', { width: 4, horizon: 12, simEngine: 'rust' });
    const seen = { decides: 0, simDecides: 0, rust: 0, other: 0, replies: 0, errors: [] };
    const rusty = {
        name: 'rusty',
        hello: (m) => inner.hello(m),
        over: () => ({ t: 'ok' }),
        async decide(m, sim) {
            seen.decides++;
            if (m.sim) {
                seen.simDecides++;
                if (m.simEngine === 'rust') seen.rust++;
                else seen.other++;
            }
            return inner.decide(m, async (req) => {
                const r = await sim(req);
                seen.replies++;
                if (r.error && seen.errors.length < 3) seen.errors.push(r.error);
                return r;
            });
        }
    };
    const r = await playGame(env, { seed: 8, bots: [rusty, createRandomBot('r')], decks, maxSteps: 160 });
    assert.ok(!r.error, `the game ran without a bot or engine error (${r.error})`);
    assert.ok(seen.simDecides > 0, 'the bot was offered simulations');
    assert.ok(seen.replies > 0, 'the bot simulated');
    assert.equal(seen.other, 0, 'no decision fell back to forceteki simulations');
    assert.equal(seen.rust, seen.simDecides, 'every decision with simulations ran them on Rust');
});

// round 15 of the live arena: at this position Flarestar Attack Shuttle's effect lasts while its source is in play,
// which the Rust state cannot express; the referee threw, and the game ended with no winner (27 games of 2,862 ended
// so, found by replaying them with bot/trace.js)
test('a position the Rust state cannot express gets forceteki simulations, and the game goes on', { skip: !ENGINE && 'engine or card data not built' }, async () => {
    const { Env } = require('../env');
    const { readTrace, replayTrace } = require('../trace');
    const { rustSimulator, rustEngine } = require('../sims/rust-sims');
    const { fullState } = require('../sims/state');
    assert.ok(await rustEngine());
    const events = readTrace(path.join(__dirname, 'fixtures', 'rust-unsupported-effect.jsonl.gz'));
    assert.match(events.at(-1).error, /^Unsupported stat effect duration whileSourceInPlay on flarestar-attack-shuttle/);
    const env = new Env();
    const replayed = await replayTrace(env, events);
    assert.equal(replayed.diff, null);
    // play the recorded moves again to the position where the referee threw
    const { gameStreams } = require('../rng');
    const eg = env.newGame({ seed: gameStreams(events[0].seed, events.at(-1).key).engine, deck1: events[0].decks.p1, deck2: events[0].decks.p2 });
    await eg.start();
    for (const s of events.filter((e) => e.t === 'step' && e.n > 0)) {
        eg.apply(eg.pidOf(s.pid), eg.legalActions(eg.pidOf(s.pid))[s.action.i]);
    }
    const pid = eg.pidOf('p2');
    assert.throws(() => fullState(eg, pid), /Unsupported stat effect/);
    assert.equal(await rustSimulator(eg, pid, (deal) => seededRng(`deal:${deal}`), null), null, 'no Rust simulator, so the referee serves forceteki ones');
});
