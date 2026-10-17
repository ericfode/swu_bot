'use strict';
// Portable integration regressions. Set SWU_BOUNDARY_REPO while these live outside bot/test.
// Only trusted metadata and canonical tar packing are used; no bot, checker or game is executed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const repo = path.resolve(process.env.SWU_BOUNDARY_REPO || path.join(__dirname, '..', '..'));
const identity = require(path.join(repo, 'bot/arena/identity.js'));
const compatibility = require(path.join(repo, 'bot/arena/compatibility.js'));
const build = 'b'.repeat(40);
const cards = 'c'.repeat(64);
const digest = 'd'.repeat(64);
const context = () => identity.contextFor({ arenaId: 'v2', build, cards });
const evidence = (ctx = context(), sha = digest) => ({
    schema: compatibility.SCHEMA, negotiatedProtocol: 2, bundleSha256: sha, checkerBuild: build,
    checkedAt: '2026-10-17T00:00:00.000Z', ...(ctx === undefined ? {} : { context: structuredClone(ctx) })
});

test('v2 comparison context binds the logical arena, image build, cards and runner without a legacy default', () => {
    const ctx = context();
    assert.deepEqual(ctx, { schema: 1, arenaId: 'v2', protocol: 2,
        engineRevision: crypto.createHash('sha256').update(`${build}:${cards}`).digest('hex'), runnerRevision: 'swu-arena-v2/1' });
    assert.deepEqual(context(), ctx, 'the same immutable image and catalog are deterministic');
    assert.notEqual(identity.contextFor({ arenaId: 'v2', build: 'e'.repeat(40), cards }).engineRevision, ctx.engineRevision);
    assert.notEqual(identity.contextFor({ arenaId: 'v2', build, cards: 'f'.repeat(64) }).engineRevision, ctx.engineRevision);
    assert.equal(identity.contextFor({ arenaId: 'open', build, cards }), null);
    for (const values of [{}, { build }, { cards }, { build: 'unknown', cards }, { build, cards: 'unknown' }]) {
        assert.equal(identity.contextFor({ arenaId: 'v2', ...values }), null, 'missing runtime evidence must not acquire a current label');
    }
});

test('v2 context equality rejects stale protocol, foreign arena, old engine, runner and missing evidence', () => {
    const trusted = context();
    const original = JSON.stringify(trusted);
    assert.equal(identity.contextMatches(structuredClone(trusted), trusted), true);
    assert.equal(identity.contextProblem(trusted, trusted), null);
    for (const actual of [null, undefined, {}, { ...trusted, schema: 0 }, { ...trusted, arenaId: 'open' },
        { ...trusted, protocol: 1 }, { ...trusted, protocol: '2' }, { ...trusted, engineRevision: 'old-engine' },
        { ...trusted, runnerRevision: 'swu-arena-v2/old' }]) {
        assert.equal(identity.contextMatches(actual, trusted), false);
        assert.equal(typeof identity.contextProblem(actual, trusted), 'string');
    }
    assert.equal(identity.contextMatches(trusted, null), false);
    assert.equal(identity.contextMatches(null, null), false);
    assert.equal(JSON.stringify(trusted), original, 'validation never relabels a stale context');
});

test('v2 compatibility accepts exact final digest/context and rejects manifest-only or unstamped legacy evidence', () => {
    const trusted = context();
    const proof = evidence(trusted);
    const before = JSON.stringify(proof);
    assert.equal(compatibility.compatibilityStatus(proof, { bundleSha256: digest, context: trusted }).compatible, true);
    for (const stale of [undefined, { checked: true, protocol: 2 }, { ...proof, negotiatedProtocol: 1 },
        { ...proof, negotiatedProtocol: undefined }, { ...proof, context: undefined }, { ...proof, context: { ...trusted, protocol: 1 } }]) {
        assert.equal(compatibility.compatibilityStatus(stale, { bundleSha256: digest, context: trusted }).compatible, false);
    }
    assert.equal(JSON.stringify(proof), before);
});

test('old image or card results remain incompatible even when bot version and digest are unchanged', () => {
    const proof = evidence();
    for (const expected of [identity.contextFor({ arenaId: 'v2', build: 'a'.repeat(40), cards }),
        identity.contextFor({ arenaId: 'v2', build, cards: 'a'.repeat(64) })]) {
        const answer = compatibility.compatibilityStatus(proof, { bundleSha256: digest, context: expected });
        assert.equal(answer.compatible, false);
        assert.match(answer.reason, /context/i);
    }
    assert.equal(compatibility.compatibilityStatus(proof, { bundleSha256: 'a'.repeat(64), context: context() }).compatible, false);
    assert.equal(compatibility.compatibilityStatus(proof, { bundleSha256: digest, context: null }).compatible, false);
});

test('final canonical execution tar matches promotion copies and rejects changed bundle bytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-final-bundle-'));
    try {
        const before = path.join(root, 'checked');
        const promoted = path.join(root, 'promoted');
        fs.mkdirSync(before);
        fs.writeFileSync(path.join(before, 'bot.wasm'), 'trusted inert fixture, never executed');
        fs.writeFileSync(path.join(before, 'arena.json'), JSON.stringify({ schema: 'swu-arena-bot/1', protocol: 2,
            kind: 'wasm', platform: 'wasm32-wasip1', runtime: 'wasi-p1', run: { cmd: './bot.wasm' } }));
        const checkedDigest = compatibility.bundleDigest(before);
        fs.cpSync(before, promoted, { recursive: true });
        fs.utimesSync(path.join(promoted, 'bot.wasm'), new Date(0), new Date(1));
        fs.chmodSync(path.join(promoted, 'bot.wasm'), 0o600);
        const finalDigest = compatibility.bundleDigest(promoted);
        assert.equal(finalDigest, checkedDigest, 'canonical metadata normalization preserves the admitted execution bytes');
        const proof = evidence(context(), checkedDigest);
        assert.equal(compatibility.compatibilityStatus(proof, { bundleSha256: finalDigest, context: context() }).compatible, true);
        fs.appendFileSync(path.join(promoted, 'bot.wasm'), ' changed revision');
        const changedDigest = compatibility.bundleDigest(promoted);
        assert.notEqual(changedDigest, finalDigest);
        assert.equal(compatibility.compatibilityStatus(proof, { bundleSha256: changedDigest, context: context() }).compatible, false);
        assert.equal(proof.bundleSha256, checkedDigest, 'a changed execution bundle cannot update its old proof');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a current v2 round config cannot supply missing protocol, context or digest evidence for a game', () => {
    assert.equal(typeof identity.observationProblem, 'function');
    const bundles = { 'alice-v1': 'a'.repeat(64), 'house-v1': 'b'.repeat(64) };
    const config = { arena: 'v2', requiredProtocol: 2, context: context(), bots: Object.keys(bundles), bundles };
    const game = { p1: 'alice-v1', p2: 'house-v1', outcome: 'won', winnerSeat: 'draw', requiredProtocol: 2,
        protocols: { p1: 2, p2: 2 }, context: context(), bundles: { ...bundles } };
    assert.equal(identity.observationProblem(game, config), null);
    for (const stale of [{ ...game, requiredProtocol: undefined }, { ...game, requiredProtocol: 1 },
        { ...game, protocols: undefined }, { ...game, protocols: { p1: 2 } }, { ...game, protocols: { p1: 2, p2: 1 } },
        { ...game, context: undefined }, { ...game, context: { ...context(), engineRevision: 'old-engine' } },
        { ...game, bundles: undefined }, { ...game, bundles: { ...bundles, 'alice-v1': 'c'.repeat(64) } }]) {
        assert.equal(typeof identity.observationProblem(stale, config), 'string');
    }
    assert.equal(game.requiredProtocol, 2, 'a validator does not restamp result policy from its parent config');
});

test('per-game bundle evidence is exactly the two executed version identities', () => {
    assert.equal(typeof identity.bundleProblem, 'function');
    const expected = { 'alice-v1': 'a'.repeat(64), 'house-v1': 'b'.repeat(64) };
    assert.equal(identity.bundleProblem({ ...expected }, expected), null);
    for (const actual of [undefined, {}, { 'alice-v1': expected['alice-v1'] },
        { ...expected, 'alice-v1': 'c'.repeat(64) }, { ...expected, 'extra-v1': 'd'.repeat(64) }]) {
        assert.equal(typeof identity.bundleProblem(actual, expected), 'string');
    }
});
