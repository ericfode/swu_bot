'use strict';
// node --test bot/test/deckbuild.test.js   (no card data needed: a mock card pool)
const test = require('node:test');
const assert = require('node:assert');
const { penalty } = require('../deckbuild/cards');
const D = require('../deckbuild/decks');
const { pairJobs, scoreA } = require('../deckbuild/play');
const { seededRng } = require('../rng');

// a tiny pool: leader and base give vigilance + heroism; units of every cost in and out of aspect
function mockPool() {
    const main = [];
    for (let cost = 1; cost <= 9; cost++) {
        for (const [k, aspects] of [['a', ['vigilance']], ['b', ['heroism']], ['c', []], ['d', ['aggression']], ['e', ['vigilance', 'vigilance']]]) {
            for (const arena of ['ground', 'space']) {
                main.push({ setCode: `T_${cost}${k}${arena[0]}`, type: 'unit', cost, power: cost, hp: cost + (k === 'c' ? 2 : 0), aspects, arena, keywords: [], unique: false });
            }
        }
    }
    const byCode = new Map(main.map((c) => [c.setCode, c]));
    byCode.set('L_1', { setCode: 'L_1', type: 'leader', aspects: ['vigilance', 'heroism'] });
    byCode.set('B_1', { setCode: 'B_1', type: 'base', aspects: ['vigilance'] });
    return {
        main,
        get: (c) => byCode.get(c) ?? null,
        provided: (l, b) => [...byCode.get(l).aspects, ...byCode.get(b).aspects],
        inAspect(l, b) {
            const prov = this.provided(l, b);
            return main.filter((c) => penalty(c, prov) === 0);
        }
    };
}

test('aspect penalty counts each missing icon once per provided icon', () => {
    assert.strictEqual(penalty({ aspects: [] }, ['vigilance']), 0);
    assert.strictEqual(penalty({ aspects: ['vigilance'] }, ['vigilance', 'heroism']), 0);
    assert.strictEqual(penalty({ aspects: ['aggression'] }, ['vigilance', 'heroism']), 1);
    assert.strictEqual(penalty({ aspects: ['vigilance', 'vigilance'] }, ['vigilance', 'heroism']), 1);
    assert.strictEqual(penalty({ aspects: ['vigilance', 'vigilance'] }, ['vigilance', 'vigilance']), 0);
});

test('random decks are aspect-legal, 50 cards, at most 3 copies; lists round-trip', () => {
    const pool = mockPool();
    const d = D.randomDeck(pool, 'L_1', 'B_1', seededRng('t'));
    assert.strictEqual(d.cards.length, 50);
    assert.deepStrictEqual(D.premierProblems(pool, d), []);
    assert.strictEqual(D.offAspectCopies(pool, d), 0);
    for (const k of D.counts(d.cards).values()) {
        assert.ok(k <= 3);
    }
    const back = D.fromList(D.toList(d));
    assert.deepStrictEqual([...back.cards].sort(), [...d.cards].sort());
    assert.strictEqual(back.leader, 'L_1');
});

test('stat deck follows the curve and prefers better stats; mutate keeps size and copy limit', () => {
    const pool = mockPool();
    const s = D.statDeck(pool, 'L_1', 'B_1');
    assert.strictEqual(s.cards.length, 50);
    assert.deepStrictEqual(D.premierProblems(pool, s), []);
    // the neutral 'c' units have +2 hp over their cost peers, so they come first in each bucket
    const cost2 = s.cards.filter((c) => pool.get(c).cost === 2);
    assert.ok(cost2.filter((c) => c.includes('c')).length >= 3);
    const m = D.mutate(pool, s, seededRng('m'), 10);
    assert.strictEqual(m.cards.length, 50);
    assert.deepStrictEqual(D.premierProblems(pool, m), []);
    const diff = [...D.counts(s.cards)].reduce((a, [c, k]) => a + Math.max(0, k - (D.counts(m.cards).get(c) ?? 0)), 0);
    assert.ok(diff <= 10);
});

test('pair jobs swap seats on one seed, and scores follow deck A', () => {
    const a = { metadata: { name: 'A' } },
        b = { metadata: { name: 'B' } };
    const [j1, j2] = pairJobs([[a, b]], { firstSeed: 7, pilot: 'x' });
    assert.strictEqual(j1.seed, 7);
    assert.strictEqual(j2.seed, 7);
    assert.strictEqual(j1.p1, a);
    assert.strictEqual(j2.p2, a);
    assert.strictEqual(scoreA({ aSeat: 'p2', winner: 'p2', outcome: 'won' }), 1);
    assert.strictEqual(scoreA({ aSeat: 'p1', winner: 'p2', outcome: 'won' }), 0);
    assert.strictEqual(scoreA({ aSeat: 'p1', winner: null, outcome: 'STEP_CAP' }), 0.5);
    assert.strictEqual(scoreA({ aSeat: 'p1', winner: null, outcome: 'ERROR' }), null);
});
