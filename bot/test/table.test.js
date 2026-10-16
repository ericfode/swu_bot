'use strict';
// The table (bot/table): a person's seat as a protocol client, and whole games a scripted person plays through it.
// The games need the built engine and card data (forceteki/build/server, forceteki/test/json); they are skipped without.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PersonSeat, splitProblem } = require('../table/person');

const ROOT = path.join(__dirname, '..', '..');
const ENGINE = fs.existsSync(path.join(ROOT, 'forceteki', 'build', 'server')) && fs.existsSync(path.join(ROOT, 'forceteki', 'test', 'json'));

const decide = (seq, actions) => ({ t: 'decide', seq, you: 'p1', ms: null, prompt: { title: 'Choose' }, state: {}, actions, revealed: [] });
const dist = { type: 'damage', amount: 3, canDistributeLess: false, canChooseNoTargets: false, maxTargets: null, tokenType: null, targets: [{ id: 'c1', cap: 2 }, { id: 'c2', cap: null }] };

test('a split must name listed targets once, stay under each cap and add up', () => {
    assert.equal(splitProblem(dist, [{ id: 'c1', amount: 2 }, { id: 'c2', amount: 1 }]), null);
    assert.equal(splitProblem(dist, [{ id: 'c2', amount: 3 }]), null);
    assert.match(splitProblem(dist, [{ id: 'c1', amount: 3 }]), /0 to 2/);
    assert.match(splitProblem(dist, [{ id: 'c9', amount: 3 }]), /cannot take/);
    assert.match(splitProblem(dist, [{ id: 'c2', amount: 1 }, { id: 'c2', amount: 2 }]), /twice/);
    assert.match(splitProblem(dist, [{ id: 'c2', amount: 2 }]), /must be 3/);
    assert.match(splitProblem(dist, [{ id: 'c2', amount: 1.5 }]), /not 1.5/);
    assert.equal(splitProblem({ ...dist, canDistributeLess: true }, [{ id: 'c2', amount: 2 }]), null);
    assert.match(splitProblem({ ...dist, maxTargets: 1 }, [{ id: 'c1', amount: 1 }, { id: 'c2', amount: 2 }]), /at most 1 target/);
    assert.match(splitProblem({ ...dist, canDistributeLess: true }, []), /at least one/);
});

test('a person\'s wrong answer is refused and the decision stays open; a right one is taken once', async () => {
    const sent = [];
    const seat = new PersonSeat({ send: (m) => sent.push(m) });
    assert.deepEqual(seat.hello({ t: 'hello' }), { t: 'ready', v: 2, name: 'person' });
    assert.equal(seat.answer({ t: 'act', seq: 1, i: 0 }), 'nothing to answer now');
    const reply = seat.decide(decide(1, [{ i: 0, kind: 'button', label: 'Pass' }, { i: 1, kind: 'distribute', label: 'distribute 3', distribute: dist }]));
    assert.equal(sent.at(-1).t, 'decide');
    assert.match(seat.answer({ t: 'act', seq: 2, i: 0 }), /another decision/);
    assert.match(seat.answer({ t: 'act', seq: 1, i: 5 }), /no choice 5/);
    assert.match(seat.answer({ t: 'act', seq: 1, i: 1, split: [{ id: 'c1', amount: 3 }] }), /0 to 2/);
    assert.equal(seat.answer({ t: 'act', seq: 1, i: 1, split: [{ id: 'c1', amount: 2, extra: 1 }, { id: 'c2', amount: 1 }] }), null);
    assert.deepEqual(await reply, { t: 'act', i: 1, split: [{ id: 'c1', amount: 2 }, { id: 'c2', amount: 1 }] });
    assert.equal(seat.answer({ t: 'act', seq: 1, i: 0 }), 'nothing to answer now');
});

test('conceding answers the open decision with an error, and every later one too', async () => {
    const seat = new PersonSeat({ send: () => undefined });
    const reply = seat.decide(decide(1, [{ i: 0, kind: 'button', label: 'Pass' }]));
    seat.concede();
    assert.deepEqual(await reply, { t: 'error', error: 'conceded' });
    assert.deepEqual(await seat.decide(decide(2, [])), { t: 'error', error: 'conceded' });
});

/** A person who answers every decision with a random legal choice (a random split for damage), a moment later. */
function scripted(seat, rng) {
    return (msg) => {
        if (msg.t !== 'decide') {
            return;
        }
        setImmediate(() => {
            const i = Math.floor(rng() * msg.actions.length);
            const a = msg.actions[i];
            let split;
            if (a.kind === 'distribute') {
                const d = a.distribute;
                let left = d.amount;
                split = d.targets.map((t) => {
                    const take = Math.min(left, t.cap ?? left);
                    left -= take;
                    return { id: t.id, amount: take };
                }).filter((e) => e.amount > 0);
                if (left > 0 || (d.maxTargets != null && split.length > d.maxTargets)) {
                    split = undefined; // let the referee pick a random legal split
                }
            }
            const why = seat.answer({ t: 'act', seq: msg.seq, i, ...(split ? { split } : {}) });
            assert.equal(why, null, `answer refused: ${why}`);
        });
    };
}

test('a scripted person plays whole games against a bot; the bot\'s hidden cards never reach the person\'s screen', { skip: !ENGINE && 'engine or card data not built' }, async () => {
    const { Env } = require('../env');
    const { makeBot } = require('../players');
    const { loadDecks } = require('../decklists');
    const { seededRng } = require('../rng');
    const { playTable } = require('../table/table');
    const env = new Env();
    const { decks } = loadDecks(path.join(ROOT, 'bot/decks/ash-meta-2026-09.json'), env);
    const byName = (n) => decks.find((d) => d.metadata.name === n);
    for (const seed of [5, 6]) {
        const msgs = [];
        let seat;
        const send = (m) => {
            msgs.push(m);
            onMsg(m);
        };
        seat = new PersonSeat({ name: 'you', send });
        const onMsg = scripted(seat, seededRng(seed));
        const { result, replay } = await playTable({
            env, person: seat, personSeat: 'p1', bot: makeBot('rush'), seed, key: `table-test-${seed}`, send,
            decks: { p1: byName('darth-vader_jtl_yellow'), p2: byName('luke-skywalker_jtl_data-vault') }
        });
        assert.equal(result.outcome, 'won', `seed ${seed}: ${result.error}`);
        const moves = msgs.filter((m) => m.t === 'move');
        assert.equal(moves.length, result.steps);
        assert.equal(msgs.at(-1).t, 'end');
        assert.equal(msgs.at(-1).winner, result.winner);
        assert.equal(replay.trim().split('\n').length, result.steps + 3, 'header, start, every move and the end');
        // the bot's hand, resources and deck never show in what the person's screen got during the game
        const shown = JSON.stringify(msgs.filter((m) => m.t !== 'end'));
        const lines = replay.trim().split('\n').map((l) => JSON.parse(l));
        for (const m of moves) {
            assert.equal(m.state.players.p2.hand, undefined);
            assert.equal(m.state.players.p2.resources, undefined);
            assert.ok(Array.isArray(m.state.players.p1.hand));
        }
        const botHands = new Set(lines.filter((l) => l.t === 'step').flatMap((l) => l.state.players.p2.hand.map((c) => c.id)));
        const botOpen = new Set(lines.filter((l) => l.t === 'step').flatMap((l) => {
            const p = l.state.players.p2;
            return [...p.discard, ...p.ground, ...p.space, ...p.ground.flatMap((u) => u.u ?? []), ...p.space.flatMap((u) => u.u ?? []), ...l.state.players.p1.ground.flatMap((u) => [...(u.u ?? []), ...(u.cap ?? [])]), ...l.state.players.p1.space.flatMap((u) => [...(u.u ?? []), ...(u.cap ?? [])])].map((c) => c.id);
        }));
        // a card that only ever sat in the bot's hand (never played, discarded or revealed by a prompt) is never named
        const revealed = new Set(msgs.flatMap((m) => [...(m.revealed ?? []), ...(m.prompt?.cards ?? [])]).map((c) => c.id));
        for (const id of botHands) {
            if (!botOpen.has(id) && !revealed.has(id)) {
                assert.ok(!shown.includes(`"id":"${id}"`), `seed ${seed}: the bot's hidden card ${id} reached the screen`);
            }
        }
    }
});

test('the bot\'s look-ahead deals the person\'s hand, resources and deck again (protocol.js determinize)', { skip: !ENGINE && 'engine or card data not built' }, async () => {
    const { Env } = require('../env');
    const { loadDecks } = require('../decklists');
    const { seededRng } = require('../rng');
    const { determinize } = require('../protocol');
    const env = new Env();
    const { decks } = loadDecks(path.join(ROOT, 'bot/decks/ash-meta-2026-09.json'), env);
    const byName = (n) => decks.find((d) => d.metadata.name === n);
    const eg = env.newGame({ seed: 'redeal', deck1: byName('darth-vader_jtl_yellow'), deck2: byName('luke-skywalker_jtl_data-vault') });
    await eg.start();
    const rng = seededRng('moves');
    while (!eg.over && eg.round < 3) {
        const pid = eg.ids.find((p) => eg.legalActions(p).length);
        const acts = eg.legalActions(pid);
        eg.apply(pid, acts[Math.floor(rng() * acts.length)], rng);
    }
    const [person, bot] = eg.ids.map((pid) => eg.player(pid));
    const ids = (cards) => cards.map((c) => eg.cardId(c.uuid));
    const before = { hand: ids(person.hand), res: ids(person.resources), deck: ids(person.drawDeck), botHand: ids(bot.hand), spent: person.resources.filter((c) => c.exhausted).length };
    assert.ok(before.hand.length > 2 && before.res.length > 2, 'the person has a hand and resources to deal');
    determinize(eg, eg.ids[1], seededRng('deal'));
    const after = { hand: ids(person.hand), res: ids(person.resources), deck: ids(person.drawDeck), botHand: ids(bot.hand), spent: person.resources.filter((c) => c.exhausted).length };
    // the same sizes and the same cards in all, dealt again: the bot cannot read the real hand from its simulations
    assert.deepStrictEqual([after.hand.length, after.res.length, after.deck.length, after.spent], [before.hand.length, before.res.length, before.deck.length, before.spent]);
    assert.deepStrictEqual([...after.hand, ...after.res, ...after.deck].sort(), [...before.hand, ...before.res, ...before.deck].sort());
    assert.notDeepStrictEqual(after.hand.sort(), before.hand.sort(), 'the person\'s hand is dealt again');
    assert.deepStrictEqual(after.botHand, before.botHand, 'the bot keeps its own hand');
});

test('the browser table (host.js): a scripted person plays a whole game against the JEPA bot', { skip: !ENGINE && 'engine or card data not built' }, async () => {
    const { createTableHost, pickDecks } = require('../table/host');
    const { seededRng } = require('../rng');
    const msgs = [];
    let onMsg = () => undefined;
    const host = createTableHost({ send: (m) => (msgs.push(m), onMsg(m)) });
    const opts = host.options();
    assert.deepStrictEqual(opts.bots, ['jepa-tx-gate']);
    assert.equal(opts.botDeck, 'random');
    assert.throws(() => host.start({ deck: 'no-such-deck', seed: 1 }), /unknown deck/);
    assert.throws(() => host.start({ deck: opts.decks[0].name, seed: -1 }), /seed/);
    assert.throws(() => host.start({ bot: 'rush', deck: opts.decks[0].name, seed: 1 }), /no bot rush/);
    // a random bot deck is the seed's pick
    const { decks } = require('../decklists').loadDecks(path.join(ROOT, 'bot/decks/ash-meta-2026-09.json'), new (require('../env').Env)());
    assert.equal(pickDecks(decks, decks[0].metadata.name, 'random', 30).theirs, decks[30 % decks.length]);
    const seed = 11;
    const g = host.start({ deck: 'darth-vader_jtl_yellow', seed, key: 'host-test' });
    assert.deepStrictEqual(g, { id: 'play-0000000b', seat: 'p1' });
    assert.throws(() => host.start({ deck: 'darth-vader_jtl_yellow', seed: 12 }), /being played/);
    onMsg = scripted({ answer: (r) => host.act(r) }, seededRng(seed));
    msgs.filter((m) => m.t === 'decide').forEach(onMsg); // a decision sent before the script was set
    const { result, replay } = await host.done;
    assert.equal(result.outcome, 'won', result.error);
    const lines = replay.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(lines[0].players.map((p) => p.bot), ['person', 'jepa-tx-gate']);
    assert.equal(lines[0].players[1].deck, decks[seed % decks.length].metadata.name);
    assert.equal(msgs.at(-1).t, 'end');
    assert.equal(host.act({ t: 'act', seq: 1, i: 0 }), 'no game is being played');
    // the window keeps this replay as the play page sends it (bot/arena/play.js)
    const { checkReplay, rowOf } = require('../arena/play');
    const row = rowOf('play-0000000b-00000000', checkReplay(replay), { sha256: 'x', bytes: replay.length, at: '2026-10-15T00:00:00Z' });
    assert.deepStrictEqual([row.p1, row.p2, row.outcome, row.winnerSeat, row.decks.p1], ['opponent', 'jepa-tx-gate', 'won', result.winner, 'darth-vader_jtl_yellow']);
    // card text for the start screen and for cards with no art
    const text = host.cardText();
    assert.equal(text.schema, 'swu-card-text/1');
    assert.equal(text.cards[decks[0].leader.id].ty[0], 'leader');
    assert.ok(Object.values(text.cards).some((c) => c.t === 'Shield' && c.ty.includes('token')));
});
