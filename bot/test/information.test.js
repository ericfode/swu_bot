'use strict';
// Pure result fixtures only: no submitted code, game runner, files, or live rankings are used.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bradleyTerry } = require('../ratings');
const { select, THRESHOLDS, MODEL_LIMITS, SCALE } = require('../arena/information');

const T = 'alice-v2';
const H = 'house-v1';
const P = 'peer-v1';
const paired = (a, b, n, first = 1, scope = 'r1') => Array.from({ length: n }, (_, i) => [
    { id: `${scope}/${a}/${b}/${first + i}/0`, scope, a, b, seed: first + i, score: 0.5 },
    { id: `${scope}/${a}/${b}/${first + i}/1`, scope, a: b, b: a, seed: first + i, score: 0.5 }
]).flat();
const model = (observations = [], rest = {}) => select({ target: T, opponents: [H], anchors: [H], observations, ...rest });
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);

test('information: a new version bridges a real reference component before ranking other opponents', () => {
    const d = model([], { opponents: [P, H] });
    assert.equal(d.state, 'play');
    assert.equal(d.opponent, H);
    assert.equal(d.reason, 'connect-reference');
    assert.equal(d.connected, false, 'the finite BT prior is not a real comparison edge');
    assert.deepEqual(d.reference, [H]);
    assert.equal(d.unanchored, false);
});

test('information: full Fisher covariance and one correlated unit per mirrored seed have an exact balanced oracle', () => {
    for (const n of [0, 1, 4, 18, 19, 100]) {
        const d = model(paired(T, H, n));
        near(d.uncertainty, SCALE * Math.sqrt(8 / (1 + 2 * n)));
        near(d.expectedGain, 2 / (3 + 2 * n));
        near(d.expectedVarianceReduction, d.uncertainty ** 2 * d.expectedGain);
        near(d.calibrationUncertainty, d.uncertainty);
        assert.equal(d.observations, 2 * n);
        assert.equal(d.effectiveUnits, n);
    }
});

test('information: fresh repeats continue while useful; sufficient evidence stops without a fixed battle count', () => {
    assert.deepEqual(THRESHOLDS, { targetSeElo: 100, minRelativeGain: 0.05 });
    const few = model(paired(T, H, 1));
    assert.equal(few.state, 'play');
    assert.equal(few.opponent, H, 'a fresh seed against the same version can add useful evidence');
    const almost = model(paired(T, H, 18));
    assert.ok(almost.uncertainty < 100);
    assert.equal(almost.state, 'play', 'precision alone does not satisfy the gain criterion');
    const enough = model(paired(T, H, 19));
    assert.equal(enough.state, 'complete');
    assert.equal(enough.reason, 'information-sufficient');
    assert.ok(enough.expectedGain < 0.05);
    assert.equal(enough.opponent, undefined);
    assert.deepEqual(model(paired(T, H, 19)), enough, 'a stale pair is not scheduled repeatedly after sufficient information');
});

test('information: well-calibrated target cannot finish with a weakly measured active peer', () => {
    const d = model([...paired(T, H, 20), ...paired(P, H, 1, 100)], { opponents: [P, H] });
    assert.equal(d.connected, true);
    near(d.calibrationUncertainty, 76.54920560025903);
    near(d.comparisons.find((c) => c.opponent === P).uncertainty, 276.00208588776906);
    near(d.expectedGain, 0.386904761904762);
    assert.equal(d.state, 'play');
    assert.equal(d.opponent, P, 'the unresolved peer contrast controls the next match');
    assert.ok(d.uncertainty > 100);
});

test('information: every active pool component must be connected, including a new version of an old opponent', () => {
    const old = 'peer-v0';
    const d = model([...paired(T, H, 20), ...paired(old, H, 20, 100)], { opponents: [H, P] });
    assert.equal(d.state, 'play');
    assert.equal(d.connected, false);
    assert.equal(d.reason, 'connect-pool');
    assert.equal(d.opponent, P, 'old version evidence does not silently transfer to the new version');
});

test('information: all supplied anchors require real connectivity and inaccessible references remain inconclusive', () => {
    const other = 'other_house-v1';
    const observations = paired(T, H, 20);
    const bridge = model(observations, { opponents: [H, other], anchors: [H, other] });
    assert.equal(bridge.state, 'play');
    assert.equal(bridge.opponent, other);
    assert.equal(bridge.reason, 'connect-reference');
    const blocked = model(observations, { opponents: [H], anchors: [H, other] });
    assert.equal(blocked.state, 'waiting');
    assert.equal(blocked.connected, false);
    assert.equal(blocked.reason, 'no-reference-bridge');
});

test('information: point estimate is the unchanged existing BT fit on actual deduplicated games', () => {
    const observations = paired(T, H, 3).map((g, i) => ({ ...g, score: i % 2 ? 0 : 1 }));
    const d = model(observations);
    const fitted = bradleyTerry([T, H].sort(), observations);
    near(d.estimate, fitted[T] - fitted[H]);
    assert.ok(d.estimate > 0);
});

test('information: repeated ids and seed/seat retries do not inflate either fit or information', () => {
    const observations = paired(T, H, 2);
    const repeated = observations.flatMap((g) => [g, { ...g }, { ...g, id: `retry-alias/${g.id}` }]);
    const clean = model(observations);
    const d = model(repeated.reverse());
    near(d.uncertainty, clean.uncertainty);
    near(d.expectedGain, clean.expectedGain);
    near(d.estimate, clean.estimate);
    assert.equal(d.observations, 4);
    assert.equal(d.effectiveUnits, 2);
    assert.equal(d.duplicates, 8);
    assert.deepEqual(d.avoidSeeds, [1, 2]);
});

test('information: an id-only retry can acquire seed metadata without becoming a second game', () => {
    const g = paired(T, H, 1)[0];
    const { seed, ...withoutSeed } = g;
    const d = model([withoutSeed, g], { attempted: [{ ...withoutSeed }] });
    assert.equal(d.observations, 1);
    assert.equal(d.duplicates, 1);
    assert.deepEqual(d.avoidSeeds, [seed]);
    assert.equal(d.unknownSeedAttempts, 0, 'the identified copy supplies the earlier attempt\'s missing seed');
});

test('information: distinct round scopes can reuse a 32-bit seed without collapsing different real results', () => {
    const first = { id: 'round-a/game', scope: 'round-a', a: T, b: H, seed: 9, score: 1 };
    const second = { id: 'round-b/game', scope: 'round-b', a: T, b: H, seed: 9, score: 0 };
    const d = model([first, second, { ...first }]);
    assert.equal(d.observations, 2);
    assert.equal(d.effectiveUnits, 2);
    assert.equal(d.duplicates, 1);
    near(d.estimate, 0);
    assert.deepEqual(d.avoidSeeds, [9], 'future dispatch still avoids that exact pair seed across every scope');
});

test('information: conflicting or unidentifiable history fails closed', () => {
    const g = paired(T, H, 1)[0];
    assert.equal(model([g, { ...g, score: 1 }]).reason, 'data-conflict');
    assert.equal(model([g, { ...g, id: 'different-id', score: 0 }]).reason, 'data-conflict');
    assert.equal(model([{ a: T, b: H, score: 1 }]).reason, 'unidentified-results');
    assert.equal(model([{ ...g, score: null }]).reason, 'invalid-results');
    assert.equal(model([{ ...g, seed: -1 }]).reason, 'invalid-results');
    assert.equal(select({ target: T, anchors: null }).state, 'waiting');
});

test('information: unrated attempts add no information, are excluded from future seeds, and unknown seeds block unsafe repetition', () => {
    const attempt = { id: 'unrated', scope: 'r1', a: T, b: H, seed: 77 };
    const d = model([], { attempted: [attempt, attempt] });
    assert.equal(d.connected, false);
    assert.equal(d.observations, 0);
    near(d.uncertainty, SCALE * Math.sqrt(8));
    assert.deepEqual(d.avoidSeeds, [77]);
    const blocked = model([], { attempted: [{ id: 'unknown-seed', a: T, b: H }] });
    assert.equal(blocked.state, 'waiting');
    assert.equal(blocked.reason, 'unknown-seed-history');
    const safe = model(paired(P, H, 1), { opponents: [H, P], attempted: [{ id: 'unknown-seed', a: T, b: H }] });
    assert.equal(safe.state, 'play');
    assert.equal(safe.opponent, P, 'another eligible bridge remains usable');
});

test('information: id-only real results fit once, but unknown shared deals are not assumed independent', () => {
    const observations = Array.from({ length: 100 }, (_, i) => ({ id: `legacy-${i}`, a: T, b: H, score: 0.5 }));
    const d = model(observations);
    assert.equal(d.observations, 100);
    assert.equal(d.effectiveUnits, 1);
    near(d.uncertainty, SCALE * Math.sqrt(8 / 3));
    assert.equal(d.state, 'waiting');
    assert.equal(d.reason, 'unknown-seed-history');
});

test('information: gain plateau with unresolved precision is waiting, never sufficient', () => {
    const other = 'other_house-v1';
    const d = model([...paired(T, H, 1000), ...paired(other, H, 1, 10000)], { anchors: [H, other] });
    assert.equal(d.connected, true);
    assert.ok(d.uncertainty > 100);
    assert.ok(d.expectedGain < THRESHOLDS.minRelativeGain);
    assert.equal(d.state, 'waiting');
    assert.equal(d.reason, 'gain-plateau');
});

test('information: no anchors use a deterministic most-evidence reference and disclose relative calibration', () => {
    const q = 'q-v1';
    const z = 'z-v1';
    const observations = [...paired(P, q, 4), ...paired(H, z, 1, 100)];
    const d = model(observations, { opponents: [H, P], anchors: [] });
    assert.equal(d.unanchored, true);
    assert.deepEqual(d.reference, [P, q].sort());
    assert.equal(d.connected, false);
    assert.equal(d.state, 'play');
    assert.deepEqual(model([...observations].reverse(), { opponents: [P, H, P], anchors: [] }), d);
    assert.equal(model([], { opponents: [], anchors: [] }).reason, 'no-reference');
});

test('information: a previous target version and unrelated historical components cannot create false precision', () => {
    const prior = 'alice-v1';
    const d = model(paired(prior, H, 100));
    assert.equal(d.connected, false);
    assert.equal(d.state, 'play');
    assert.ok(d.uncertainty > 300);
    const baseline = model(paired(T, H, 3));
    const unrelated = model([...paired(T, H, 3), ...paired('x-v1', 'y-v1', 5, 100)]);
    near(unrelated.uncertainty, baseline.uncertainty);
    near(unrelated.expectedGain, baseline.expectedGain);
});

test('information: deterministic ties, input immutability, and explicit model safety bounds', () => {
    const input = { target: T, opponents: [P, H], anchors: [P, H], observations: [], attempted: [] };
    const before = JSON.stringify(input);
    const d = select(input);
    assert.equal(d.opponent, H);
    assert.equal(JSON.stringify(input), before);
    assert.equal(select({ target: T, opponents: Array.from({ length: MODEL_LIMITS.maxNodes }, (_, i) => `v${i}`) }).reason, 'model-limit');
    assert.equal(model(new Array(MODEL_LIMITS.maxObservations + 1).fill(null)).reason, 'model-limit');
});
