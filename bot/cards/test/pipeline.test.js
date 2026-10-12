'use strict';
const test = require('node:test'),
    assert = require('node:assert/strict');
const { coverage, digest, validateReview } = require('../pipeline/coverage');
const { mutants } = require('../pipeline/mutations');
const { options } = require('../pipeline/cli');
const catalogue = require('../../card-compiler/generated/catalog.json');
const hash = 'a'.repeat(64),
    trace = 'b'.repeat(64),
    pool = 'c'.repeat(64);
const plans = [
    {
        cardId: 'TST_001',
        cases: [{ id: 'case', coverageObligationIds: ['effect'] }],
        obligations: [{ id: 'effect' }],
        uncovered: [],
    },
];
const oracle = [
    {
        caseId: 'case',
        traceSha256: trace,
        poolSha256: pool,
        provenance: { sourceCatalogueSha256: hash },
        coverageObligationIds: ['effect'],
    },
];
const comparisons = ['native-auto', 'native-interpreter', 'wasm-auto'].map((runtime) => ({
    caseId: 'case',
    traceSha256: trace,
    poolSha256: pool,
    catalogueSha256: hash,
    runtime,
    matched: true,
}));
test('coverage requires witnessed obligation and all three exact current comparisons', () => {
    const status = (o = [], c = []) => coverage(plans, o, c)[0].obligations[0].status;
    assert.equal(status(), 'generated');
    assert.equal(status(oracle), 'oracle-exercised');
    assert.equal(status(oracle, comparisons), 'matched');
    for (const key of ['traceSha256', 'poolSha256', 'catalogueSha256'])
        assert.equal(
            status(
                oracle,
                comparisons.map((c) => ({ ...c, [key]: 'd'.repeat(64) })),
            ),
            'oracle-exercised',
        );
    assert.equal(status(oracle, comparisons.slice(1)), 'oracle-exercised');
    assert.equal(status([{ ...oracle[0], coverageObligationIds: [] }], comparisons), 'generated');
});
test('malformed missing identities never turn matching undefined into evidence', () => {
    const o = [{ caseId: 'case', coverageObligationIds: ['effect'] }],
        c = comparisons.map(({ runtime }) => ({ caseId: 'case', runtime, matched: true }));
    assert.equal(coverage(plans, o, c)[0].obligations[0].status, 'oracle-exercised');
});
test('semantic reviews bind complete selected card set, packet and every uncovered obligation', () => {
    const packet = { cards: [{ cardId: 'TST_001', probes: { uncovered: [{ id: 'timing' }] } }] };
    const review = {
        schema: 'swu-card-review/v1',
        packetSha256: digest(packet),
        reviewer: { model: 'independent-reviewer', effort: 'high' },
        cards: [
            {
                cardId: 'TST_001',
                verdict: 'no-findings',
                findings: [],
                uncoveredReviewed: [{ id: 'timing', assessment: 'Finite tests do not exercise this timing boundary.' }],
            },
        ],
    };
    assert.equal(validateReview(review, packet), review);
    assert.throws(() => validateReview({ ...review, packetSha256: hash }, packet), /bind this packet/);
    assert.throws(
        () => validateReview({ ...review, cards: [{ ...review.cards[0], uncoveredReviewed: [] }] }, packet),
        /skipped uncovered/,
    );
    assert.throws(
        () => validateReview({ ...review, cards: [...review.cards, ...review.cards] }, packet),
        /exactly once/,
    );
});
test('mutants change one configuration without changing source or oracle input', () => {
    const entry = catalogue.cards.find((c) => c.setCode === 'TWI_170'),
        before = digest(entry),
        changes = mutants(entry);
    assert.equal(changes.length, 3);
    assert.equal(digest(entry), before);
    for (const c of changes) {
        assert.equal(c.entry.sourceHash, entry.sourceHash);
        assert.deepEqual(c.entry.card, entry.card);
        assert.notEqual(digest(c.entry.abilities), digest(entry.abilities));
    }
});
test('pipeline CLI keeps builds mandatory and parses multiple selected cards', () => {
    assert.deepEqual(options(['--cards', 'TWI_124,TWI_170', '--card', 'JTL_052']).cards, [
        'TWI_124',
        'TWI_170',
        'JTL_052',
    ]);
    assert.throws(() => options(['--no-build']), /Unknown/);
    assert.throws(() => options(['--out']), /Missing/);
});

 test('arena-list mutants independently alter receiver, arena scope, amount and sign', () => {
    const entry = catalogue.cards.find(c => c.setCode === 'TS26_048');
    const changes = mutants(entry);
    for (const label of ['swap-owner','all-arenas','amount-plus-one','remove-negation'])
        assert.ok(changes.some(c => c.label === label), label);
    assert.ok(!changes.some(c => c.label.includes('sequential')));
});


test('defeat list sensitivity includes empty targets and owner restriction', () => {
    const entry = {setCode:'TST_002',abilities:{card:[{effect:{kind:'defeat',target:{kind:'arenaList',receiver:{kind:'ref',path:['game']},predicate:{kind:'const',value:true}}}}]}};
    const changes = mutants(entry);
    assert.deepEqual(changes.map(c => c.label).sort(), ['empty-list','friendly-only-list']);
    assert.equal(entry.abilities.card[0].effect.target.predicate.value,true);
});
test('cost query sensitivity covers zero-cost capability and attachment thresholds', () => {
    const condition = {kind:'binary',op:'&&',left:{kind:'query',name:'hasCost',receiver:{kind:'ref',path:['card']},args:[]},right:{kind:'binary',op:'<=',left:{kind:'ref',path:['card','cost']},right:{kind:'const',value:4}}};
    const entry = {setCode:'TST_003',abilities:{card:[]},attachCondition:condition};
    const before=digest(entry), changes=mutants(entry);
    assert.deepEqual(changes.map(c=>c.label).sort(),['amount-plus-one','no-cost-cards','positive-cost-only']);
    assert.equal(digest(entry),before);
    assert.ok(changes.every(c=>c.path.startsWith('attachCondition.')));
    const positive=changes.find(c=>c.label==='positive-cost-only').entry.attachCondition.left;
    assert.equal(positive.left.name,'getPrintedCost');
    assert.equal(positive.right.value,0);
});
