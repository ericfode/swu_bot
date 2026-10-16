'use strict';
// The card data every bot gets in hello.cards (bot/game-cards.js, spec/protocol.md): what it holds for the arena's deck
// lists, that every card a decision names is in it, that both seats get the same array and no bot can change the
// engine's copy, and that the arena's start check sends the same cards a game does.
// Needs the built engine and card data (forceteki/build/server, forceteki/test/json); skipped without.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ENGINE = fs.existsSync(path.join(ROOT, 'forceteki', 'build', 'server')) && fs.existsSync(path.join(ROOT, 'forceteki', 'test', 'json'));
const skip = !ENGINE && 'engine or card data not built';
const LISTS = require('../decks/ash-meta-2026-09.json');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'game-cards-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let env = null;
const getEnv = () => (env ??= new (require('../env').Env)());
const code = (c) => `${c.set}_${String(c.number).padStart(3, '0')}`;
const codesOf = (d) => [d.leader.id, d.base.id, ...d.deck.map((c) => c.id), ...(d.sideboard ?? []).map((c) => c.id)];

test('gameCards on all 27 lists: every code resolves, reprints give the engine\'s card, 13 tokens, one fixed order', { skip }, () => {
    const { gameCards } = require('../game-cards');
    const g = getEnv().cardDataGetter;
    assert.strictEqual(LISTS.length, 27);
    const reprints = { JTL_020: 'HMW_022', SOR_030: 'JTL_029', JTL_136: 'LAW_175' };
    const seen = new Set();
    for (let i = 0; i < LISTS.length; i++) {
        const a = LISTS[i];
        const b = LISTS[(i + 1) % LISTS.length];
        const cards = gameCards(g, [a, b]);
        const byCode = new Map();
        for (const c of cards) {
            for (const sc of [...(c.setCodes ?? []), ...(c.setId.number !== undefined ? [c.setId] : [])]) {
                byCode.set(code(sc), c);
            }
        }
        for (const id of [...codesOf(a), ...codesOf(b)]) {
            assert.ok(byCode.has(id), `${a.metadata.name} / ${b.metadata.name}: ${id} has a card`);
            // the engine's own object for it, unchanged
            assert.strictEqual(byCode.get(id), g.getCardSync(g.setCodeMap.get(id)), id);
            if (reprints[id]) {
                assert.strictEqual(code(byCode.get(id).setId), reprints[id], `${id} is the card whose setId is ${reprints[id]}`);
                seen.add(id);
            }
        }
        const tokens = cards.filter((c) => c.types.includes('token'));
        assert.deepStrictEqual(tokens.map((c) => c.title).sort(), ['Advantage', 'Battle Droid', 'Beast', 'Clone Trooper', 'Credit', 'Experience', 'Mandalorian', 'Shield', 'Spy', 'TIE Fighter', 'The Force', 'Weakness', 'X-Wing']);
        assert.ok(tokens.every((t) => t.setId.number === undefined && t.setCodes === undefined), 'tokens have no set number');
        const names = cards.map((c) => c.internalName);
        assert.deepStrictEqual(names, [...new Set(names)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)), 'once each, sorted by internalName');
        // the same array whichever list comes first, so both seats get the same one
        assert.deepStrictEqual(gameCards(g, [b, a]), cards);
        assert.deepStrictEqual(gameCards(g, { p1: b, p2: a }), cards);
    }
    assert.deepStrictEqual([...seen].sort(), Object.keys(reprints).sort(), 'the lists use all three reprint codes');
    assert.throws(() => gameCards(g, [LISTS[0], { ...LISTS[1], deck: [...LISTS[1].deck, { id: 'NOPE_999', count: 1 }] }]), /no card NOPE_999 in the card data/);
});

/**
 * A protocol client that plays random legal moves and keeps the hello it got (as received) and every decide.
 * With `vandal`, it then changes every card of its hello, which must reach neither the engine nor the other seat.
 */
function recorder(name, { vandal = false } = {}) {
    const { seededRng } = require('../rng');
    let rng = null;
    const bot = {
        name, got: null, decides: [],
        hello(msg) {
            bot.got = JSON.parse(JSON.stringify(msg));
            rng = seededRng(msg.seed);
            if (vandal) {
                for (const c of msg.cards) {
                    c.cost = 99;
                    c.title = 'changed';
                    c.setCodes?.splice(0);
                }
                msg.cards.splice(0, 5);
            }
            return { t: 'ready', v: 2, name };
        },
        decide(msg) {
            bot.decides.push(JSON.parse(JSON.stringify(msg)));
            return { t: 'act', i: Math.floor(rng() * msg.actions.length) };
        }
    };
    return bot;
}

/** Every card a decide names, as { where, ref } (card refs) or { where, label } (action labels: an internalName). */
function namedCards(msg) {
    const out = [];
    const refs = (where, list) => (list ?? []).forEach((r) => {
        out.push({ where, ref: r });
        refs(`${where} upgrade`, r.u);
        refs(`${where} captured`, r.cap);
    });
    for (const [seat, p] of Object.entries(msg.state.players)) {
        refs(`${seat} base`, [p.base]);
        refs(`${seat} leader`, p.leader ? [p.leader] : []);
        for (const zone of ['hand', 'resources', 'discard', 'ground', 'space']) {
            refs(`${seat} ${zone}`, p[zone]);
        }
    }
    refs('prompt', msg.prompt.cards);
    refs('revealed', msg.revealed);
    for (const a of msg.actions) {
        if (a.kind === 'card') {
            refs('action card', [a.card]);
            if (a.card.id !== 'hidden') {
                out.push({ where: 'card action', label: a.label });
            }
        } else if (a.kind === 'displayCard') {
            out.push({ where: 'displayCard action', label: a.label });
        } else if (a.kind === 'perCardButton') {
            out.push({ where: 'perCardButton action', label: a.label.slice(a.label.lastIndexOf(':') + 1) });
        }
    }
    return out;
}

/** The card of hello.cards a ref names: by s (setId and every setCodes entry), or for a token (s null) by title. */
function finder(cards) {
    const byCode = new Map();
    const tokens = new Map();
    const names = new Set(cards.map((c) => c.internalName));
    for (const c of cards) {
        for (const sc of [...(c.setCodes ?? []), ...(c.setId.number !== undefined ? [c.setId] : [])]) {
            byCode.set(code(sc), c);
        }
        if (c.types.includes('token') && !tokens.has(c.title)) {
            tokens.set(c.title, c);
        }
    }
    return {
        ref: (r) => (r.s === null ? tokens.get(r.n) : byCode.get(r.s)),
        label: (l) => names.has(l)
    };
}

async function playRecorded(decks, seed, opts = {}) {
    const { playGame } = require('../match');
    const bots = [recorder('rec-a', opts), recorder('rec-b')];
    const res = await playGame(getEnv(), { seed, bots, decks, key: `game-cards-${seed}` });
    assert.notStrictEqual(res.outcome, 'ERROR', res.error);
    return bots;
}

const games = [];
test('in a game both seats get the same cards, and every card a decision names is in them', { skip }, async () => {
    const { gameCards } = require('../game-cards');
    const g = getEnv().cardDataGetter;
    const pristine = JSON.stringify(gameCards(g, [LISTS[0], LISTS[1]]));
    // the start check's two lists (with the reprint JTL_020), two others with SOR_030 and JTL_136, and two random decks
    for (const [decks, seed, opts] of [[{ p1: LISTS[0], p2: LISTS[1] }, 3, { vandal: true }], [{ p1: LISTS[3], p2: LISTS[6] }, 5], [undefined, 7]]) {
        const [a, b] = await playRecorded(decks, seed, opts);
        games.push({ decks, a, b });
        assert.ok(a.got.cards.length >= 42, `${a.got.cards.length} cards`);
        assert.deepStrictEqual(a.got.cards, b.got.cards, 'both seats get the same array');
        const lists = [a.got.deck, a.got.opponent];
        assert.deepStrictEqual(a.got.cards, JSON.parse(JSON.stringify(gameCards(g, lists))));
        const find = finder(a.got.cards);
        let checked = 0;
        for (const msg of [...a.decides, ...b.decides]) {
            for (const n of namedCards(msg)) {
                if (n.ref) {
                    if (n.ref.id === 'hidden') {
                        continue;
                    }
                    const card = find.ref(n.ref);
                    assert.ok(card, `${n.where} ${JSON.stringify(n.ref)} is in hello.cards`);
                    assert.strictEqual(card.title, n.ref.n, `${n.where} ${JSON.stringify(n.ref)}: the title matches`);
                } else {
                    assert.ok(find.label(n.label), `${n.where} label ${n.label} is an internalName of hello.cards`);
                }
                checked++;
            }
        }
        assert.ok(checked > 1000, `${checked} card names checked`);
    }
    // p1 changed every card of its hello: the engine's objects and p2's hello are as they were
    assert.strictEqual(JSON.stringify(gameCards(g, [LISTS[0], LISTS[1]])), pristine);
    assert.strictEqual(JSON.stringify(games[0].b.got.cards), pristine);
});

test('the start check sends a bot program the cards a game sends for its two lists', { skip }, () => {
    for (const [k, v] of Object.entries({ ARENA_HOME: 'arena', ARENA_RESULTS: 'results', ARENA_DASH: 'dash' })) {
        process.env[k] = path.join(tmp, v);
    }
    const { startCheck } = require('../arena/api');
    const dir = fs.mkdtempSync(path.join(tmp, 'check-'));
    // a bot program that writes the hello it got to hello.json, then answers ready
    fs.writeFileSync(path.join(dir, 'rec.js'), "let b = '';\nprocess.stdin.on('data', (d) => {\n    b += d;\n    if (b.includes('\\n')) {\n"
        + "        require('fs').writeFileSync('hello.json', b.slice(0, b.indexOf('\\n')));\n        process.stdout.write('{\"t\":\"ready\",\"v\":2}\\n');\n    }\n});\n");
    startCheck(dir, 'rec-v1', { cmd: 'node', args: ['rec.js'] }, 'rec');
    const hello = JSON.parse(fs.readFileSync(path.join(dir, 'hello.json'), 'utf8'));
    assert.deepStrictEqual([hello.deck, hello.opponent], [LISTS[0], LISTS[1]]);
    const { gameCards } = require('../game-cards');
    assert.deepStrictEqual(hello.cards, JSON.parse(JSON.stringify(gameCards(getEnv().cardDataGetter, [LISTS[0], LISTS[1]]))));
    // and what a game with those lists sends (the test above played one, when it ran)
    if (games[0]) {
        assert.deepStrictEqual(hello.cards, games[0].b.got.cards);
    }
});
