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
    assert.deepEqual(seat.hello({ t: 'hello' }), { t: 'ready', v: 2, name: 'person', noEffect: true, sim: true });
    assert.deepEqual(new PersonSeat({ send: () => undefined, previews: false }).hello({ t: 'hello' }), { t: 'ready', v: 2, name: 'person', noEffect: true });
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

test('a person\'s screen gets hello without the card data, and the referee\'s message stays as it was', () => {
    const sent = [];
    const seat = new PersonSeat({ send: (m) => sent.push(m) });
    const hello = { t: 'hello', you: 'p1', deck: { leader: { id: 'SOR_010', count: 1 } }, ms: null, cards: [{ internalName: 'shield', title: 'Shield' }] };
    assert.deepEqual(seat.hello(hello), { t: 'ready', v: 2, name: 'person', noEffect: true, sim: true });
    assert.deepStrictEqual(sent, [{ t: 'hello', you: 'p1', deck: { leader: { id: 'SOR_010', count: 1 } }, ms: null }]);
    assert.strictEqual(hello.cards.length, 1);
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

test('a person\'s card moves that would change nothing come marked noEffect, and the engine agrees; a bot that does not ask gets no marks', { skip: !ENGINE && 'engine or card data not built' }, async () => {
    const { Env } = require('../env');
    const { loadDecks } = require('../decklists');
    const { seededRng } = require('../rng');
    const { playTable } = require('../table/table');
    const env = new Env();
    const { decks } = loadDecks(path.join(ROOT, 'bot/decks/ash-meta-2026-09.json'), env);
    const byName = (n) => decks.find((d) => d.metadata.name === n);
    const seed = 20;
    const rng = seededRng(`person-${seed}`);
    const marks = { shown: 0, clicked: 0, asked: 0, bot: 0, elsewhere: 0 };
    let seat;
    let clickedMark = false;
    const send = (m) => {
        if (m.t !== 'decide') {
            return;
        }
        const marked = m.actions.filter((a) => a.noEffect);
        marks.shown += marked.length;
        marks.elsewhere += marked.filter((a) => a.kind !== 'card' || !m.prompt.actionWindow).length;
        // the engine's own question: "Playing X will have no effect. Are you sure...?" or "The ability ... will have no effect"
        const question = /will have no effect/i.test(JSON.stringify(m.prompt));
        if (clickedMark) {
            marks.asked += question ? 1 : 0;
        }
        clickedMark = false;
        setImmediate(() => {
            let a = marked.length && marks.clicked < 4 ? marked[0] : m.actions[Math.floor(rng() * m.actions.length)];
            if (question) {
                a = m.actions.find((x) => /cancel/i.test(x.label)) ?? a;
            }
            if (a.noEffect) {
                marks.clicked++;
                clickedMark = true;
            }
            assert.equal(seat.answer({ t: 'act', seq: m.seq, i: a.i }), null);
        });
    };
    seat = new PersonSeat({ name: 'you', send });
    const brng = seededRng(`bot-${seed}`);
    const bot = {
        name: 'plain', hello: () => ({ t: 'ready', v: 2 }),
        decide: (m) => {
            marks.bot += m.actions.filter((a) => 'noEffect' in a).length;
            return { t: 'act', i: Math.floor(brng() * m.actions.length) };
        }
    };
    const { result } = await playTable({ env, person: seat, personSeat: 'p1', bot, decks: { p1: byName('admiral-piett_jtl_blue'), p2: byName('ahsoka-tano_ash_yellow') }, seed, key: 'no-effect-test', send });
    assert.equal(result.outcome, 'won', result.error);
    assert.ok(marks.clicked >= 3, `the person clicked marked cards: ${JSON.stringify(marks)}`);
    assert.equal(marks.asked, marks.clicked, `every marked card the person clicked made the engine ask "will have no effect": ${JSON.stringify(marks)}`);
    assert.equal(marks.elsewhere, 0, 'only card moves in the action window are marked');
    assert.equal(marks.bot, 0, 'a client that does not ask gets no marks');
});

test('a preview names damage, units that leave play and upgrades that go, and only lands on the question it was made for', () => {
    const { changes, withPreviews, keyOf } = require('../table/preview');
    const side = (base, ground, more = {}) => ({ base: { id: base, d: 0 }, ground, space: [], discard: [], ...more });
    const unit = (id, d, more = {}) => ({ id, s: 'SOR_001', d, ...more });
    const before = { players: { p1: side('b1', [unit('c1', 0), unit('c2', 1, { u: [{ id: 'c9' }] }), unit('c6', 0)]), p2: side('b2', [unit('c3', 2), unit('c4', 0), unit('c5', 0, { s: null }), unit('c7', 0)]) } };
    const after = {
        players: {
            p1: side('b1', [unit('c1', 3, { cap: [{ id: 'c4' }] }), unit('c2', 1)], { hand: [{ id: 'c6' }] }),
            p2: { ...side('b2', [], { discard: [{ id: 'c3' }] }), base: { id: 'b2', d: 4 } }
        }
    };
    assert.deepEqual(changes(before, after), [
        { id: 'c1', d: 3 }, { id: 'c2', lost: ['c9'] }, { id: 'c6', gone: 'returned' }, { id: 'b2', d: 4 },
        { id: 'c3', gone: 'defeated' }, { id: 'c4', gone: 'captured' }, { id: 'c5', gone: 'defeated' }, { id: 'c7', gone: 'left' }
    ]);
    assert.deepEqual(changes(before, before), []);
    const actions = [{ i: 0, kind: 'card', label: 'Wing Leader', card: { id: 'c3' } }, { i: 1, kind: 'button', label: 'Cancel' }];
    const msg = decide(4, actions);
    const node = { keys: actions.map(keyOf), previews: [{ cards: [{ id: 'c3', gone: 'defeated' }] }, null] };
    const shown = withPreviews(msg, node);
    assert.deepEqual(shown.actions[0].preview, { cards: [{ id: 'c3', gone: 'defeated' }] });
    assert.equal('preview' in shown.actions[1], false);
    assert.equal('preview' in msg.actions[0], false, 'the referee\'s message stays as it was');
    assert.strictEqual(withPreviews(msg, { ...node, keys: ['card|c4|Other', node.keys[1]] }), msg, 'another question gets none');
    assert.strictEqual(withPreviews(msg, undefined), msg);
});

test('a person\'s previews (the answers to a move\'s questions, played out on the copy) match what the real game then does', { skip: !ENGINE && 'engine or card data not built' }, async () => {
    const { Env } = require('../env');
    const { makeBot } = require('../players');
    const { loadDecks } = require('../decklists');
    const { seededRng } = require('../rng');
    const { playTable } = require('../table/table');
    const { changes } = require('../table/preview');
    const env = new Env();
    const { decks } = loadDecks(path.join(ROOT, 'bot/decks/ash-meta-2026-09.json'), env);
    const byName = (n) => decks.find((d) => d.metadata.name === n);
    const seen = { questions: 0, previews: 0, checked: 0, outsideQuestions: 0 };
    const wrong = [];
    for (const seed of [100, 102]) {
        const rng = seededRng(`preview-${seed}`);
        let seat;
        let last = null;
        const send = (m) => {
            if (m.t === 'move' && last && m.seat === 'p1') {
                const p = last.msg.actions[last.i].preview;
                // a complete preview (no more questions, the game goes on) is exactly the board after the person's answer
                if (p && !p.more && !p.winner) {
                    seen.checked++;
                    const real = changes(last.msg.state, m.state);
                    if (JSON.stringify(real) !== JSON.stringify(p.cards)) {
                        wrong.push({ seed, label: last.msg.actions[last.i].label, preview: p.cards, real });
                    }
                }
                last = null;
            }
            if (m.t !== 'decide') {
                return;
            }
            const shown = m.actions.filter((a) => a.preview).length;
            if (m.prompt.actionWindow) {
                seen.outsideQuestions += shown;
            } else {
                seen.questions++;
                seen.previews += shown;
            }
            setImmediate(() => {
                // mostly the person's own units in play, so attacks (a question: which target) come often
                let i = Math.floor(rng() * m.actions.length);
                const units = m.actions.filter((a) => m.prompt.actionWindow && a.kind === 'card' && /Arena/.test(a.card?.zone ?? '') && a.card.ctl === m.you);
                if (units.length && rng() < 0.7) {
                    i = units[Math.floor(rng() * units.length)].i;
                }
                if (m.actions[i].kind === 'distribute') {
                    i = m.actions.findIndex((a) => a.kind !== 'distribute');
                    i = i < 0 ? 0 : i;
                }
                last = { msg: m, i };
                assert.equal(seat.answer({ t: 'act', seq: m.seq, i }), null);
            });
        };
        seat = new PersonSeat({ name: 'you', send });
        const { result } = await playTable({
            env, person: seat, personSeat: 'p1', bot: makeBot('heuristic'), seed, key: `preview-test-${seed}`, send,
            decks: { p1: byName('admiral-piett_jtl_blue'), p2: byName('ahsoka-tano_ash_yellow') }
        });
        assert.equal(result.outcome, 'won', result.error);
    }
    assert.equal(seen.outsideQuestions, 0, 'previews only go on the questions that follow a move');
    assert.ok(seen.checked >= 10, `enough complete previews to check: ${JSON.stringify(seen)}`);
    assert.deepEqual(wrong, [], `every complete preview matched the real game: ${JSON.stringify(seen)}`);
});

test('a person takes back moves against a bot: the game plays again to their last real choice, and the replay keeps only the moves that stand', { skip: !ENGINE && 'engine or card data not built' }, async () => {
    const { Env } = require('../env');
    const { makeBot } = require('../players');
    const { loadDecks } = require('../decklists');
    const { seededRng } = require('../rng');
    const { playTable } = require('../table/table');
    const { replayTrace } = require('../trace');
    const env = new Env();
    const { decks } = loadDecks(path.join(ROOT, 'bot/decks/ash-meta-2026-09.json'), env);
    const byName = (n) => decks.find((d) => d.metadata.name === n);
    for (const seed of [7, 8]) {
        const rng = seededRng(`undo-${seed}`);
        const seen = []; // the person's decisions: board and choices
        const looks = (m) => JSON.stringify([m.state, m.actions.map((a) => a.label)]);
        let rewound = null;
        const count = { undo: 0, queued: 0, rewinds: 0, failed: 0, offered: 0 };
        let seat;
        const send = (m) => {
            if (m.t === 'rewind') {
                if (m.error) {
                    count.failed++;
                } else {
                    count.rewinds++;
                    rewound = m;
                }
                return;
            }
            if (m.t !== 'decide') {
                return;
            }
            if (rewound) {
                // the decision taken back, asked again: the board the rewind showed, and a decision seen before
                assert.deepStrictEqual(m.state, rewound.state);
                assert.ok(seen.includes(looks(m)), 'the decision asked again is one the person was asked before');
                rewound = null;
            }
            seen.push(looks(m));
            count.offered += m.undo ? 1 : 0;
            setImmediate(() => {
                if (m.undo && count.undo < 12 && rng() < 0.15) {
                    count.undo++;
                    assert.equal(seat.answer({ t: 'undo' }), null);
                    return;
                }
                let i = Math.floor(rng() * m.actions.length);
                if (m.actions[i].kind === 'distribute') {
                    i = m.actions.findIndex((a) => a.kind !== 'distribute');
                    i = i < 0 ? 0 : i;
                }
                assert.equal(seat.answer({ t: 'act', seq: m.seq, i }), null);
                // now and then, an undo while the bot thinks: it answers the next decision
                if (m.actions.length > 1 && count.queued < 4 && rng() < 0.03) {
                    count.queued++;
                    assert.equal(seat.answer({ t: 'undo' }), null);
                }
            });
        };
        seat = new PersonSeat({ name: 'you', send });
        assert.equal(seat.answer({ t: 'undo' }), null, 'an undo before any decision waits for one');
        seat.undoNext = false;
        const { result, replay } = await playTable({
            env, person: seat, personSeat: 'p1', bot: makeBot('heuristic'), seed, key: `undo-test-${seed}`, send,
            decks: { p1: byName('admiral-piett_jtl_blue'), p2: byName('ahsoka-tano_ash_yellow') }
        });
        assert.equal(result.outcome, 'won', result.error);
        assert.ok(count.rewinds >= 5, `moves taken back: ${JSON.stringify(count)}`);
        assert.equal(count.failed, 0, `every move could be taken back: ${JSON.stringify(count)}`);
        const events = replay.trim().split('\n').map((l) => JSON.parse(l));
        const steps = events.filter((e) => e.t === 'step');
        assert.deepStrictEqual(steps.map((e) => e.n), steps.map((e, k) => k), 'the replay numbers its moves without gaps');
        assert.equal(steps.at(-1).n, result.steps);
        const check = await replayTrace(env, events);
        assert.ok(check.ok, `the replay plays out the same again: ${check.diff}`);
    }
    // a decision with nothing to take back refuses an undo, and the decision stays open
    const sent = [];
    const p = new PersonSeat({ name: 'you', send: (m) => sent.push(m) });
    const asked = p.decide(decide(1, [{ i: 0, kind: 'button', label: 'Pass' }, { i: 1, kind: 'button', label: 'Go' }]));
    assert.match(p.answer({ t: 'undo' }), /no move to take back/);
    assert.equal(p.answer({ t: 'act', seq: 1, i: 1 }), null);
    assert.deepStrictEqual(await asked, { t: 'act', i: 1 });
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
    // the person's screen got hello without the card data the JEPA bot built its card tables from
    const hello = msgs.find((m) => m.t === 'hello');
    assert.deepStrictEqual([hello.you, hello.deck.metadata.name, 'cards' in hello], ['p1', 'darth-vader_jtl_yellow', false]);
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
