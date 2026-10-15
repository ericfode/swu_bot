'use strict';
// node --test bot/test/decklists.test.js   (no card data needed)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { padId, normalizeDeck, checkDecks, loadDecks, deckPairs, dealDecks, parseDeckText } = require('../decklists');
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

test('metadata keeps only the name and the style', () => {
    const d = normalizeDeck({ ...deck('x'), metadata: { name: 'x', style: 'aggro', author: 'a-user', date: '2026-09-01', deckLink: 'https://example.org/1' } });
    assert.deepStrictEqual(d.metadata, { name: 'x', style: 'aggro' });
    assert.deepStrictEqual(normalizeDeck({ ...deck('y'), metadata: { name: 'y', author: 'a-user' } }).metadata, { name: 'y' });
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

// mock card data: set code -> { id (internal), types }
const cards = new Map([
    ['SOR_005', { id: '1000000005', types: ['leader'] }],
    ['SOR_029', { id: '1000000029', types: ['base'] }],
    ['JTL_024', { id: '4028826022', types: ['base'] }], // Data Vault: 60 cards
    ['JTL_025', { id: '4301437393', types: ['base'] }], // Thermal Oscillator: 45 cards
    ['SOR_046', { id: '1000000046', types: ['unit'] }],
    ['SOR_047', { id: '1000000047', types: ['event'] }],
    ['SOR_048', { id: '1000000048', types: ['event'] }], // not implemented
    ['SOR_T01', { id: '1000000901', types: ['token', 'upgrade'] }]
]);
for (let k = 0; k < 24; k++) {
    cards.set(`SHD_${100 + k}`, { id: `2000000${100 + k}`, types: ['upgrade'] });
}
// n main deck cards, three copies of each
const spread = (n) => Array.from({ length: Math.ceil(n / 3) }, (_, k) => ({ id: `SHD_${100 + k}`, count: Math.min(3, n - 3 * k) }));

test('checks catch wrong card types in the leader, base and main deck slots', () => {
    const types = (id) => cards.get(id)?.types ?? null;
    const known = (id) => cards.has(id);
    assert.deepStrictEqual(checkDecks([deck('a'), deck('b')].map(normalizeDeck), { known, types }), []);
    const bad = [
        { ...deck('unit-leader', 'SOR_046') },
        { ...deck('leader-base'), base: { id: 'SOR_005', count: 1 } },
        deck('main', 'SOR_005', [{ id: 'SOR_T01', count: 1 }, { id: 'SOR_005', count: 1 }, { id: 'SOR_029', count: 1 }])
    ].map(normalizeDeck);
    const problems = checkDecks(bad, { known, types });
    assert.deepStrictEqual(problems, [
        'unit-leader: leader SOR_046 is not a leader (unit)',
        'leader-base: base SOR_005 is not a base (leader)',
        'main: SOR_T01 is a token, not a main deck card',
        'main: SOR_005 is a leader, not a main deck card',
        'main: SOR_029 is a base, not a main deck card'
    ]);
    // without a types lookup the type checks are skipped
    assert.deepStrictEqual(checkDecks(bad, { known }), []);
});

test('the minimum deck size follows the base', () => {
    const minDeckSize = (base) => (base === 'JTL_024' ? 60 : base === 'JTL_025' ? 45 : 50);
    const sized = (name, base, n) => normalizeDeck({ metadata: { name }, leader: { id: 'SOR_005' }, base: { id: base }, deck: [{ id: 'SOR_046', count: n }] });
    const problems = checkDecks([sized('vault', 'JTL_024', 52), sized('vault-ok', 'JTL_024', 60), sized('osc', 'JTL_025', 45), sized('plain', 'SOR_029', 49)], { known: () => true, minDeckSize, maxCopies: () => Infinity });
    assert.deepStrictEqual(problems, ['vault: main deck has 52 cards (premier needs 60 with this base)', 'plain: main deck has 49 cards (premier needs 50)']);
});

test('loadDecks reads the card types and the base size rule from the card data', () => {
    const env = {
        cardDataGetter: { setCodeMap: new Map([...cards].map(([code, c]) => [code, c.id])), getCardSync: (id) => [...cards.values()].find((c) => c.id === id) },
        isImplemented: (c) => c.id !== '1000000048'
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklists-'));
    try {
        const file = path.join(dir, 'decks.json');
        const sized = (name, base, n) => ({ metadata: { name, author: 'a-user' }, leader: { id: 'SOR_005', count: 1 }, base: { id: base, count: 1 }, deck: spread(n) });
        fs.writeFileSync(file, JSON.stringify([sized('osc', 'JTL_025', 45), sized('vault', 'JTL_024', 60), deck('plain')]));
        const { decks, sha256 } = loadDecks(file, env);
        assert.deepStrictEqual(decks.map((d) => d.metadata), [{ name: 'osc' }, { name: 'vault' }, { name: 'plain' }]);
        assert.match(sha256, /^[0-9a-f]{64}$/);
        fs.writeFileSync(file, JSON.stringify({ decks: [sized('vault', 'JTL_024', 59), { ...deck('main', 'SOR_005', [{ id: 'SOR_T01', count: 1 }]), base: { id: 'SOR_048', count: 1 } }] }));
        assert.throws(() => loadDecks(file, env), (e) => [
            'vault: main deck has 59 cards (premier needs 60 with this base)',
            'main: SOR_048 has no implementation',
            'main: base SOR_048 is not a base (event)',
            'main: SOR_T01 is a token, not a main deck card'
        ].every((p) => e.message.includes(p)));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('copy limits: three per card, reprints counted together, card-specific limits', () => {
    // SHD_100 and SOR_046 are printings of one card here; VUL_001 may have 15 copies
    const key = (id) => (id === 'SOR_046' ? 'SHD_100' : id);
    const maxCopies = (k) => (k === 'VUL_001' ? 15 : 3);
    const base = (name, extra) => ({ metadata: { name }, leader: { id: 'SOR_005' }, base: { id: 'SOR_029' }, deck: [...spread(48), ...extra] });
    const decks = [
        base('ok', [{ id: 'VUL_001', count: 15 }]),
        base('reprint', [{ id: 'SOR_046', count: 1 }, { id: 'SHD_121', count: 1 }]),
        base('merged', [{ id: 'SHD_120', count: 2 }, { id: 'SHD_120', count: 2 }]),
        base('vulture', [{ id: 'VUL_001', count: 16 }])
    ].map(normalizeDeck);
    assert.deepStrictEqual(checkDecks(decks, { known: () => true, cardKey: key, maxCopies }), [
        'reprint: 4 copies of SHD_100 + SOR_046 (premier allows 3)',
        'merged: 4 copies of SHD_120 (premier allows 3)',
        'vulture: 16 copies of VUL_001 (premier allows 15)'
    ]);
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
    // the second pass over the pairs gives each bot the other deck of every pair
    for (let seed = 7; seed < 7 + P; seed++) {
        const first = s.find((g) => g.seed === seed && g.p1 === 'x#a');
        const again = s.find((g) => g.seed === seed + P && g.p1 === 'x#a');
        assert.deepStrictEqual(again.decks, [...first.decks].reverse());
    }
});

test('pairs come in round-robin rounds, so whole rounds give every deck the same number of games', () => {
    for (const n of [2, 3, 4, 5, 6, 7, 8, 27]) {
        const pairs = deckPairs(n);
        const P = (n * (n - 1)) / 2;
        assert.strictEqual(pairs.length, P);
        assert.strictEqual(new Set(pairs.map(([i, j]) => `${Math.min(i, j)}-${Math.max(i, j)}`)).size, P, `n=${n}: every pair once`);
        assert.ok(pairs.every(([i, j]) => i !== j && i >= 0 && j >= 0 && i < n && j < n));
        // a round pairs every deck once; one deck sits out when n is odd, a different one each round
        const size = n % 2 ? (n - 1) / 2 : n / 2;
        const out = new Set();
        for (let r = 0; r < P / size; r++) {
            const inRound = pairs.slice(r * size, (r + 1) * size).flat();
            assert.strictEqual(new Set(inRound).size, inRound.length, `n=${n} round ${r}: no deck twice`);
            if (n % 2) {
                out.add(Array.from({ length: n }, (_, d) => d).find((d) => !inRound.includes(d)));
            }
        }
        assert.strictEqual(out.size, n % 2 ? n : 0);
        // every prefix: after whole rounds the pairs per deck differ by at most 1 when n is odd (who sat out), else 0
        const games = new Array(n).fill(0);
        pairs.forEach(([i, j], k) => {
            games[i]++;
            games[j]++;
            const spread = Math.max(...games) - Math.min(...games);
            assert.ok(spread <= (n % 2) + ((k + 1) % size ? 1 : 0), `n=${n} after ${k + 1} pairs: spread ${spread}`);
        });
        // which deck comes first is balanced: each deck is first in (n - 1) / 2 of its pairs, rounded up or down
        const first = new Array(n).fill(0);
        pairs.forEach(([i]) => first[i]++);
        assert.ok(first.every((f) => f === Math.floor((n - 1) / 2) || f === Math.ceil((n - 1) / 2)), `n=${n}: ${first}`);
    }
});

test('one pass over the pairs: each bot holds each deck in about half of its games', () => {
    // games where `bot` holds deck d, and games where its opponent does, per deck
    const holds = (s, bot, n) => {
        const own = new Array(n).fill(0);
        const opp = new Array(n).fill(0);
        for (const g of s.filter((x) => x.p1 === bot || x.p2 === bot)) {
            const mine = g.p1 === bot ? 0 : 1;
            own[g.decks[mine]]++;
            opp[g.decks[1 - mine]]++;
        }
        return { own, opp };
    };
    for (const n of [27, 6, 5]) {
        const P = deckPairs(n).length;
        const half = [Math.floor((n - 1) / 2), Math.ceil((n - 1) / 2)].map((x) => 2 * x);
        // mirror and gauntlet with one pass (P seeds, 2 games each)
        const runs = [dealDecks(roundRobin(['x#a', 'x#b'], 2 * P, 1), n, 1), dealDecks(gauntlet(['c1', 'c2'], ['o'], 2 * P, 1), n, 1)];
        for (const [s, bot] of [[runs[0], 'x#a'], [runs[1], 'c1'], [runs[1], 'c2']]) {
            const { own, opp } = holds(s, bot, n);
            assert.ok(own.every((v) => half.includes(v)), `n=${n} ${bot}: ${own}`);
            assert.ok(own.every((v, d) => v + opp[d] === 2 * (n - 1)));
            if (n % 2) {
                assert.deepStrictEqual(own, opp, `n=${n} ${bot}: exactly half when n is odd`);
            }
        }
        // three bots, one pass per bot pair: exactly half for every bot and deck
        const three = dealDecks(roundRobin(['a', 'b', 'c'], 2 * P, 1), n, 1);
        for (const bot of ['a', 'b', 'c']) {
            const { own, opp } = holds(three, bot, n);
            assert.deepStrictEqual(own, opp, `n=${n} ${bot}`);
        }
    }
});

test('a run cut after whole rounds has given every deck the same number of games', () => {
    const n = 27;
    const P = deckPairs(n).length;
    const s = dealDecks(roundRobin(['x#a', 'x#b'], 4 * P, 1), n, 1);
    const games = new Array(n).fill(0);
    s.forEach((g, k) => {
        games[g.decks[0]]++;
        games[g.decks[1]]++;
        const seeds = (k + 1) / 2;
        if (seeds % 13 === 0) {
            // 13 pairs a round; a deck that sat out one more round than another is 2 games (one seed) behind, and
            // until the pass ends some deck has sat out once and another not yet
            const spread = Math.max(...games) - Math.min(...games);
            assert.strictEqual(spread, seeds % P ? 2 : 0, `after ${seeds} seeds`);
        }
    });
});

test('gauntlet: every challenger meets the same decks on the same seeds', () => {
    const s = dealDecks(gauntlet(['c1', 'c2'], ['o'], 6, 1), 4, 1);
    const key = (g) => `${g.seed}:${g.p1 === 'o' ? 'o' : 'c'}:${g.decks.join(',')}`;
    const c1 = s.filter((g) => g.p1 === 'c1' || g.p2 === 'c1').map(key);
    const c2 = s.filter((g) => g.p1 === 'c2' || g.p2 === 'c2').map(key);
    assert.deepStrictEqual(c1, c2);
});

test('deal by seat (rated rounds): each deck stays with its seat, so each bot plays both decks of its seed', () => {
    const n = 26;
    const P = deckPairs(n).length;
    const names = Array.from({ length: 13 }, (_, i) => `b${i}`);
    const first = 3_000_000_123; // a round's first seed comes from the arena's secret (referee.js roundSeed)
    const s = dealDecks(roundRobin(names, 6, first), n, first, { by: 'seat' });
    assert.strictEqual(s.length, 468);
    for (let i = 0; i < s.length; i += 2) {
        const [a, b] = [s[i], s[i + 1]];
        assert.strictEqual(a.seed, b.seed);
        assert.deepStrictEqual(a.decks, b.decks, 'the seat keeps its deck when the bots swap');
        assert.notStrictEqual(a.decks[0], a.decks[1]);
        assert.deepStrictEqual(a.decks, dealDecks([{ seed: a.seed, p1: 'x', p2: 'y' }], n, 0, { by: 'seat' })[0].decks, 'the seed alone decides, not the first seed');
    }
    // a round's 234 seeds play 234 different deck pairs, and every pair once in P seeds in a row
    const pairOf = (g) => [...g.decks].sort((x, y) => x - y).join('-');
    assert.strictEqual(new Set(s.map(pairOf)).size, 234);
    const run = dealDecks(Array.from({ length: P }, (_, k) => ({ seed: first + k, p1: 'x', p2: 'y' })), n, first, { by: 'seat' });
    assert.strictEqual(new Set(run.map(pairOf)).size, P);
    // the next pass over the pairs puts each pair's decks in the other seats
    const next = dealDecks(run.map((g) => ({ ...g, seed: g.seed + P })), n, first, { by: 'seat' });
    next.forEach((g, k) => assert.deepStrictEqual(g.decks, [...run[k].decks].reverse()));
    // another round's first seed starts somewhere else in the pairs
    const other = dealDecks(roundRobin(names, 6, 17), n, 17, { by: 'seat' });
    assert.notDeepStrictEqual(other.map((g) => g.decks), s.map((g) => g.decks));
    assert.throws(() => dealDecks(s, n, first, { by: 'deck' }), /by bot or by seat/);
});
