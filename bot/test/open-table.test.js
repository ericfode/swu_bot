'use strict';
// The open tables' host (bot/table/open.js): two people in one game, a person against an arena bot, custom deck lists.
// The games need the built engine and card data (forceteki/build/server, forceteki/test/json); they are skipped without.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ENGINE = fs.existsSync(path.join(ROOT, 'forceteki', 'build', 'server')) && fs.existsSync(path.join(ROOT, 'forceteki', 'test', 'json'));
const skip = !ENGINE && 'engine or card data not built';

/** Answers every decision a screen gets with a random legal choice, a moment later, through `answer`. */
function scripted(answer, rng) {
    return (msg) => {
        if (msg.t !== 'decide') {
            return;
        }
        setImmediate(() => {
            const i = Math.floor(rng() * msg.actions.length);
            const why = answer({ t: 'act', seq: msg.seq, i });
            assert.equal(why, null, `answer refused: ${why}`);
        });
    };
}

let shared = null;
const env = () => (shared ??= new (require('../env').Env)());

test('two people play a whole game: each screen sees only its own hand, and both get the end and the replay', { skip }, async () => {
    const { createOpenHost } = require('../table/open');
    const { seededRng } = require('../rng');
    const mine = [];
    const theirs = [];
    let onMine = () => undefined;
    let onTheirs = () => undefined;
    const host = createOpenHost({ env: env(), send: (m) => (mine.push(m), onMine(m)), sendPeer: (m) => (theirs.push(m), onTheirs(m)) });
    const lists = host.options().decks.map((d) => d.name);
    assert.ok(lists.length > 10);
    assert.throws(() => host.start({ mode: 'people', deck: lists[0], peerDeck: 'nope', seed: 3 }), /other player's deck: no list named nope/);
    const seed = 7;
    const g = host.start({ mode: 'people', deck: 'darth-vader_jtl_yellow', peerDeck: 'luke-skywalker_jtl_data-vault', you: 'pl_aaaaaa', peer: 'pl_bbbbbb', seed, key: 'open-test' });
    assert.deepStrictEqual(g, { id: 'open-00000007', seat: 'p2', peerSeat: 'p1' }, 'an odd seed seats the host second');
    onMine = scripted((r) => host.act(r), seededRng('me'));
    onTheirs = scripted((r) => host.peerAct(r), seededRng('them'));
    mine.filter((m) => m.t === 'decide').forEach(onMine);
    theirs.filter((m) => m.t === 'decide').forEach(onTheirs);
    const { result, replay } = await host.done;
    assert.equal(result.outcome, 'won', result.error);
    const header = JSON.parse(replay.split('\n')[0]);
    assert.deepStrictEqual(header.players.map((p) => [p.id, p.bot, p.lang, p.deck]), [['p1', 'pl_bbbbbb', 'person', 'luke-skywalker_jtl_data-vault'], ['p2', 'pl_aaaaaa', 'person', 'darth-vader_jtl_yellow']]);
    for (const [msgs, seat, other] of [[mine, 'p2', 'p1'], [theirs, 'p1', 'p2']]) {
        const moves = msgs.filter((m) => m.t === 'move');
        assert.equal(moves.length, result.steps);
        for (const m of moves) {
            assert.ok(Array.isArray(m.state.players[seat].hand), `${seat} sees its own hand`);
            assert.equal(m.state.players[other].hand, undefined, `${seat} never sees the other hand`);
        }
        assert.ok(msgs.filter((m) => m.t === 'decide').every((m) => m.you === seat));
        const end = msgs.at(-1);
        assert.equal(end.t, 'end');
        assert.equal(end.winner, result.winner);
        assert.equal(end.replay, replay);
        assert.equal(end.conceded, false);
    }
});

test('a concession ends a people game for both screens, named by seat', { skip }, async () => {
    const { createOpenHost } = require('../table/open');
    const mine = [];
    const theirs = [];
    const host = createOpenHost({ env: env(), send: (m) => mine.push(m), sendPeer: (m) => theirs.push(m) });
    const g = host.start({ mode: 'people', deck: 'darth-vader_jtl_yellow', peerDeck: 'luke-skywalker_jtl_data-vault', seed: 4, key: 'k' });
    assert.equal(g.seat, 'p1');
    while (!theirs.some((m) => m.t === 'decide') && !mine.some((m) => m.t === 'decide')) {
        await new Promise((r) => setImmediate(r));
    }
    host.peerConcede();
    const { result } = await host.done;
    assert.equal(result.winner, 'p1');
    assert.deepStrictEqual([mine.at(-1).conceded, mine.at(-1).concededBy], [false, 'p2']);
    assert.deepStrictEqual([theirs.at(-1).conceded, theirs.at(-1).concededBy], [true, 'p2']);
    assert.equal(host.peerAct({ t: 'act', seq: 1, i: 0 }), 'no game is being played');
});

test("an arena version is guarded with its round's thinking time, and 45 s when the lineup gives none", { skip }, () => {
    const { createOpenHost, CAP_MS } = require('../table/open');
    const host = createOpenHost({ env: env(), send: () => undefined });
    assert.equal(host.capOf('tinybot-v2'), CAP_MS);
    host.setCap('tinybot-v2', 30000);
    host.setCap('other-v1', null);
    host.setCap('tiny-v1', 5);
    assert.deepStrictEqual([host.capOf('tinybot-v2'), host.capOf('other-v1'), host.capOf('tiny-v1')], [30000, CAP_MS, CAP_MS]);
});

test("a person plays Eric's JEPA bot: the bot's random deck is the seed's pick, hello has no card data, and the card text has leaders and tokens", { skip }, async () => {
    const { createOpenHost } = require('../table/open');
    const { pickDecks } = require('../table/host');
    const { seededRng } = require('../rng');
    const { decks } = require('../decklists').loadDecks(path.join(ROOT, 'bot/decks/ash-meta-2026-09.json'), env());
    assert.equal(pickDecks(decks, decks[0].metadata.name, 'random', 30).theirs, decks[30 % decks.length]);
    const msgs = [];
    let onMsg = () => undefined;
    const host = createOpenHost({ env: env(), send: (m) => (msgs.push(m), onMsg(m)) });
    const g = host.start({ mode: 'bot', bot: 'jepa-tx-gate', deck: 'darth-vader_jtl_yellow', you: 'pl_dddddd', seed: 11, key: 'jepa-test' });
    onMsg = scripted((r) => host.act(r), seededRng('jepa'));
    msgs.filter((m) => m.t === 'decide').forEach(onMsg); // a decision sent before the script was set
    const { result, replay } = await host.done;
    assert.equal(result.outcome, 'won', result.error);
    const header = JSON.parse(replay.split('\n')[0]);
    const seats = { p1: header.players[0].bot, p2: header.players[1].bot };
    assert.deepStrictEqual([seats[g.seat], seats[g.seat === 'p1' ? 'p2' : 'p1']], ['pl_dddddd', 'jepa-tx-gate']);
    // the person's screen got hello without the card data the JEPA bot built its card tables from
    const hello = msgs.find((m) => m.t === 'hello');
    assert.deepStrictEqual([hello.you, hello.deck.metadata.name, 'cards' in hello], [g.seat, 'darth-vader_jtl_yellow', false]);
    assert.equal(msgs.at(-1).t, 'end');
    // card text for the start screen and for cards with no art
    const text = host.cardText();
    assert.equal(text.schema, 'swu-card-text/1');
    assert.equal(text.cards[decks[0].leader.id].ty[0], 'leader');
    assert.ok(Object.values(text.cards).some((c) => c.t === 'Shield' && c.ty.includes('token')));
});

test('a person plays an arena bot made by the registry, and a custom deck list (SWUDB export form) is checked first', { skip }, async () => {
    const { createOpenHost } = require('../table/open');
    const { seededRng } = require('../rng');
    const { decks } = require('../decklists').loadDecks(path.join(ROOT, 'bot/decks/ash-meta-2026-09.json'), env());
    const msgs = [];
    let onMsg = () => undefined;
    const host = createOpenHost({ env: env(), send: (m) => (msgs.push(m), onMsg(m)) });
    // a list as SWUDB exports it: author, unpadded ids, a sideboard; only the name stays
    const src = decks.find((d) => d.metadata.name === 'darth-vader_jtl_yellow');
    const custom = {
        metadata: { name: 'My Vader', author: 'someone' },
        leader: { id: src.leader.id.replace(/_0+(\d)/, '_$1'), count: 1 },
        base: src.base,
        deck: src.deck,
        sideboard: [{ id: 'SOR_010', count: 1 }]
    };
    const d = host.checkDeck(custom);
    assert.deepStrictEqual(d.metadata, { name: 'My Vader' });
    assert.equal(d.leader.id, src.leader.id);
    assert.throws(() => host.checkDeck({ ...custom, deck: custom.deck.slice(0, 3) }), /main deck has \d+ cards/);
    assert.throws(() => host.checkDeck({ ...custom, leader: { id: 'XXX_999', count: 1 } }), /XXX_999 is not in the card data/);
    assert.throws(() => host.start({ mode: 'bot', bot: 'rush', deck: { ...custom, deck: [] }, seed: 2 }), /your deck: main deck has 0 cards/);
    const g = host.start({ mode: 'bot', bot: 'rush', deck: custom, botDeck: 'luke-skywalker_jtl_data-vault', you: 'pl_cccccc', seed: 2, key: 'bot-test' });
    assert.equal(g.seat, 'p1');
    onMsg = scripted((r) => host.act(r), seededRng('bot'));
    msgs.filter((m) => m.t === 'decide').forEach(onMsg);
    const { result, replay } = await host.done;
    assert.equal(result.outcome, 'won', result.error);
    const header = JSON.parse(replay.split('\n')[0]);
    assert.deepStrictEqual(header.players.map((p) => [p.bot, p.deck]), [['pl_cccccc', 'My Vader'], ['rush', 'luke-skywalker_jtl_data-vault']]);
    assert.equal(header.decks.p1.metadata.author, undefined, 'no author in the replay');
    const text = host.cardText([custom]);
    assert.equal(text.cards[src.leader.id].ty[0], 'leader');
});
