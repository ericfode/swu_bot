'use strict';
const { sha256 } = require('../inventory');
const digest = (value) => sha256(Buffer.from(JSON.stringify(value)));
// Planning, observing the oracle, and agreeing with it are separate evidence.
function coverage(plans, observations = [], comparisons = [], review = null) {
    return plans.map((plan) => {
        const cases = new Map(plan.cases.map((c) => [c.id, c]));
        const oracle = observations.filter((r) => cases.has(r.caseId));
        const matched = (id) =>
            oracle.some(
                (o) =>
                    o.caseId === id &&
                    [o.traceSha256, o.poolSha256, o.provenance?.sourceCatalogueSha256].every(
                        (h) => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h),
                    ) &&
                    ['native-auto', 'native-interpreter', 'wasm-auto'].every((runtime) =>
                        comparisons.some(
                            (r) =>
                                r.caseId === id &&
                                r.runtime === runtime &&
                                r.matched &&
                                r.traceSha256 === o.traceSha256 &&
                                r.poolSha256 === o.poolSha256 &&
                                r.catalogueSha256 === o.provenance?.sourceCatalogueSha256,
                        ),
                    ),
            );
        const obligations = plan.obligations.map((o) => {
            const ids = plan.cases.filter((c) => (c.coverageObligationIds ?? []).includes(o.id)).map((c) => c.id);
            const witnessed = ids.filter((id) =>
                oracle.some((r) => r.caseId === id && (r.coverageObligationIds ?? []).includes(o.id)),
            );
            return {
                ...o,
                caseIds: ids,
                oracleCaseIds: witnessed,
                status: witnessed.some(matched)
                    ? 'matched'
                    : witnessed.length
                    ? 'oracle-exercised'
                    : ids.length
                    ? 'generated'
                    : 'uncovered',
            };
        });
        return {
            cardId: plan.cardId,
            obligations,
            uncovered: plan.uncovered,
            totals: Object.fromEntries(
                ['uncovered', 'generated', 'oracle-exercised', 'matched'].map((status) => [
                    status,
                    obligations.filter((o) => o.status === status).length,
                ]),
            ),
            review: review?.cards?.find((c) => c.cardId === plan.cardId) ?? { verdict: 'pending' },
            note: 'Matched obligations are finite experiments. Unrepresented source semantics and interactions still require review.',
        };
    });
}
function validateReview(review, packet) {
    const assert = require('node:assert/strict');
    assert.equal(review.schema, 'swu-card-review/v1');
    assert.equal(review.packetSha256, digest(packet), 'Review does not bind this packet');
    assert.ok(review.reviewer?.model && review.reviewer?.effort, 'Name the reviewing model and effort');
    assert.ok(Array.isArray(review.cards));
    assert.deepEqual(
        review.cards.map((c) => c.cardId).sort(),
        packet.cards.map((c) => c.cardId).sort(),
        'Review every selected card exactly once',
    );
    for (const card of review.cards) {
        assert.ok(['no-findings', 'findings', 'incomplete'].includes(card.verdict), 'Unknown review verdict');
        assert.ok(
            Array.isArray(card.findings) && Array.isArray(card.uncoveredReviewed),
            'Review needs findings and uncoveredReviewed',
        );
        if (card.verdict === 'no-findings') assert.equal(card.findings.length, 0);
        if (card.verdict === 'findings') assert.ok(card.findings.length);
        const expected = new Set(packet.cards.find((c) => c.cardId === card.cardId).probes.uncovered.map((o) => o.id));
        const addressed = new Set(
            card.uncoveredReviewed.map((o) => {
                assert.ok(o.id && o.assessment, 'Explain each reviewed coverage gap');
                return o.id;
            }),
        );
        if (card.verdict !== 'incomplete')
            for (const id of expected) assert.ok(addressed.has(id), 'Review skipped uncovered behavior: ' + id);
        for (const f of card.findings) {
            assert.ok(['conversion', 'runtime', 'baseline', 'coverage'].includes(f.category));
            assert.ok(['bug', 'gap', 'question'].includes(f.kind));
            assert.ok(f.summary && Array.isArray(f.sourceRefs) && f.sourceRefs.length, 'Findings need source evidence');
        }
    }
    return review;
}
module.exports = { coverage, digest, validateReview };
