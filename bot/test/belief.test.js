'use strict';
// Belief model and ISMCTS registry on mock objects (no engine or card data needed beyond the require chain).
const test = require('node:test');
const assert = require('node:assert');
const { seededRng } = require('../env');
const { BeliefModel } = require('../players/belief');
const { describeBot, parseIsmcts } = require('../players');
const { gauntlet } = require('../ratings');

const card = (name, cost) => ({ internalName: name, cost, aspects: [] });

function pool() {
    const cards = [];
    for (let i = 0; i < 3; i++) {
        cards.push(card('cheap', 1), card('mid', 3), card('big', 7));
    }
    return cards;
}

test('sampleSplit keeps zone sizes and the multiset', () => {
    const b = new BeliefModel(0);
    const rng = seededRng('t');
    const p = pool();
    for (let i = 0; i < 50; i++) {
        const { hand, res, deck } = b.sampleSplit(p, 3, 2, rng);
        assert.equal(hand.length, 3);
        assert.equal(res.length, 2);
        assert.equal(deck.length, 4);
        const all = [...hand, ...res, ...deck].sort();
        assert.deepEqual(all, p.map((c) => c.internalName).sort());
    }
});

test('beta = 0 ignores evidence; larger beta avoids cards the opponent could have played', () => {
    const p = pool();
    const freq = (beta) => {
        const b = new BeliefModel(beta);
        b.evidence.set('cheap', 3);
        b.evidence.set('mid', 3);
        const rng = seededRng('f');
        let big = 0;
        for (let i = 0; i < 2000; i++) {
            big += b.sampleSplit(p, 3, 0, rng).hand.filter((n) => n === 'big').length;
        }
        return big / (2000 * 3);
    };
    const f0 = freq(0);
    const f1 = freq(1);
    const f3 = freq(3);
    assert.ok(Math.abs(f0 - 1 / 3) < 0.03, `uniform share of big cards, got ${f0}`);
    assert.ok(f1 > f0 + 0.2, `beta 1 should favour big cards (${f1} vs ${f0})`);
    assert.ok(f3 >= f1, `beta 3 should favour them at least as much (${f3} vs ${f1})`);
});

test('observe: a pass with 3 ready resources adds evidence to cards costing 3 or less', () => {
    const opp = { hand: [card('cheap', 1), card('big', 7)], resources: [{}, {}, {}], drawDeck: [card('mid', 3)], readyResourceCount: 3, passedActionPhase: false, getPenaltyAspects: () => [] };
    const me = { opponent: opp };
    const eg = { round: 2, phase: 'action', player: () => me, isActionWindow: () => true };
    const b = new BeliefModel(1);
    b.observe(eg, 'me');
    opp.passedActionPhase = true;
    b.observe(eg, 'me');
    assert.equal(b.evidence.get('cheap'), 1);
    assert.equal(b.evidence.get('mid'), 1);
    assert.equal(b.evidence.get('big'), undefined);
    assert.equal(b.observations, 1);
});

test('ismcts names parse into options', () => {
    assert.deepEqual(parseIsmcts('ismcts'), { beta: 1, horizon: 1, iterPerAction: 6, peek: false });
    assert.deepEqual(parseIsmcts('ismcts-b2.5-h2-n4'), { beta: 2.5, horizon: 2, iterPerAction: 4, peek: false });
    assert.equal(parseIsmcts('ismcts-peek').peek, true);
    assert.equal(parseIsmcts('ismctsx'), null);
    assert.equal(describeBot('ismcts-b0#2').profile, 'ismcts-b0');
});

test('gauntlet: challengers face every opponent on the same seeds, from both seats', () => {
    const s = gauntlet(['a', 'b'], ['x', 'y'], 2, 10);
    assert.equal(s.length, 8);
    const seedsA = s.filter((g) => g.p1 === 'a' || g.p2 === 'a').map((g) => g.seed);
    const seedsB = s.filter((g) => g.p1 === 'b' || g.p2 === 'b').map((g) => g.seed);
    assert.deepEqual(seedsA, seedsB);
    assert.ok(!s.some((g) => (g.p1 === 'a' && g.p2 === 'b') || (g.p1 === 'b' && g.p2 === 'a')));
});
