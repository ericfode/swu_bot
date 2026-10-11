'use strict';
// node --test bot/test/decklists.test.js   (no card data needed)
const test = require('node:test');
const assert = require('node:assert');
const { padId, normalizeDeck, checkDecks, deckPairs, dealDecks, parseDeckText } = require('../decklists');
const { roundRobin, gauntlet } = require('../ratings');

const deck = (name, leader = 'SOR_005', extra = []) => ({
    metadata: { name }, leader: { id: leader, count: 1 }, base: { id: 'SOR_029', count: 1 },
    deck: [{ id: 'SOR_046', count: 3 }, ...extra, ...Array.from({ length: 16 }, (_, k) => ({ id: `SHD_${String(100 + k)}`, count: 3 })), { id: 'SOR_047', count: 1 }]
});

test('ids are padded and repeated entries merged, sideboards dropped', () => {
    assert.strictEqual(padId('LAW_3'), 'LAW_003');
    assert.strictEqual(padId('LAW_46'), 'LAW_046');
    assert.strictEqual(padId('LAW_146'), 'LAW_146');
    const d = normalizeDeck({ leader: { id: 'SOR_5' }, base: { id: 'SOR_29' }, deck: [{ id: 'SOR_46', count: 2 }, { id: 'SOR_046', count: 1 }], sideboard: [{ id: 'SOR_047', count: 3 }] });
    assert.deepStrictEqual(d, { metadata: { name: 'SOR_005 / SOR_029' }, leader: { id: 'SOR_005', count: 1 }, base: { id: 'SOR_029', count: 1 }, deck: [{ id: 'SOR_046', count: 3 }] });
    assert.throws(() => normalizeDeck({ leader: { id: 'SOR_005' }, base: { id: 'SOR_029' }, deck: [{ id: 'SOR_046', count: 0 }] }), /bad entry/);
});

test('checks catch repeated names, unknown and unimplemented cards, and short decks', () => {
    const ok = [deck('a'), deck('b')].map(normalizeDeck);
    assert.deepStrictEqual(checkDecks(ok, { known: () => true }), []);
    const bad = [deck('a'), deck('a', 'SOR_999'), normalizeDeck({ metadata: { name: 'c' }, leader: { id: 'SOR_005' }, base: { id: 'SOR_029' }, deck: [{ id: 'SOR_046', count: 3 }] })];
    const problems = checkDecks(bad.map(normalizeDeck), { known: (id) => id !== 'SOR_999', implemented: (id) => id !== 'SHD_101' });
    assert.ok(problems.includes('a: name used twice'));
    assert.ok(problems.includes('a: SOR_999 is not in the card data'));
    assert.ok(problems.includes('a: SHD_101 has no implementation'));
    assert.ok(problems.includes('c: main deck has 3 cards (premier needs 50)'));
});

test('fixture text: comments dropped except the style, sideboard left out', () => {
    const text = '# Real-deck fixture - Someone\n# melee.gg/Decklist/View/1 #3 of 40\n# Style: softcontrol\n\nLeader\n1 LAW_008\n\nBase\n1 ASH_19\n\nDeck\n3 ASH_116\n2 JTL_032\n\nSideboard\n3 LAW_132\n';
    const d = parseDeckText(text, 'krennic');
    assert.deepStrictEqual(d, { metadata: { name: 'krennic', style: 'softcontrol' }, leader: { id: 'LAW_008', count: 1 }, base: { id: 'ASH_019', count: 1 }, deck: [{ id: 'ASH_116', count: 3 }, { id: 'JTL_032', count: 2 }] });
    assert.ok(!JSON.stringify(d).includes('melee'));
    assert.throws(() => parseDeckText('Leader\n1 LAW_008\nDeck\nthree ASH_116\n', 'x'), /cannot read line/);
});

test('mirror: every deck pair plays equally often, each deck once per seat per seed, and decks stay with their bot', () => {
    const n = 5;
    const P = deckPairs(n).length;
    assert.strictEqual(P, 10);
    const s = dealDecks(roundRobin(['x#a', 'x#b'], 4 * P, 7), n, 7);
    assert.strictEqual(s.length, 4 * P);
    const perPair = new Map();
    const atP1 = new Map();
    for (const g of s) {
        const k = [...g.decks].sort().join('-');
        perPair.set(k, (perPair.get(k) ?? 0) + 1);
        atP1.set(`${k}@${g.decks[0]}`, (atP1.get(`${k}@${g.decks[0]}`) ?? 0) + 1);
        assert.notStrictEqual(g.decks[0], g.decks[1]);
    }
    assert.strictEqual(perPair.size, P);
    assert.ok([...perPair.values()].every((v) => v === 4));
    assert.ok([...atP1.values()].every((v) => v === 2), 'each deck of a pair sits at p1 equally often');
    for (let i = 0; i < s.length; i += 2) {
        const [a, b] = [s[i], s[i + 1]];
        assert.strictEqual(a.seed, b.seed);
        assert.deepStrictEqual([a.p1, a.decks[0]], [b.p2, b.decks[1]], 'the same bot keeps the same deck when seats swap');
    }
    // the second pass over the pairs gives each bot the other deck
    const first = s.find((g) => g.seed === 7 && g.p1 === 'x#a');
    const again = s.find((g) => g.seed === 7 + P && g.p1 === 'x#a');
    assert.deepStrictEqual(again.decks, [...first.decks].reverse());
});

test('gauntlet: every challenger meets the same decks on the same seeds', () => {
    const s = dealDecks(gauntlet(['c1', 'c2'], ['o'], 6, 1), 4, 1);
    const key = (g) => `${g.seed}:${g.p1 === 'o' ? 'o' : 'c'}:${g.decks.join(',')}`;
    const c1 = s.filter((g) => g.p1 === 'c1' || g.p2 === 'c1').map(key);
    const c2 = s.filter((g) => g.p1 === 'c2' || g.p2 === 'c2').map(key);
    assert.deepStrictEqual(c1, c2);
});
