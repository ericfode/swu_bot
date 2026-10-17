// @ts-nocheck -- portable JavaScript boundary fixture retained as supplied.
// Run with Node 22: SWU_BOUNDARY_REPO=/absolute/swu_bot node --test config-context.test.mjs
// Reads trusted configuration code only. Image identity files are local temporary fixtures.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(process.env.SWU_BOUNDARY_REPO || path.join(import.meta.dirname, '..', '..', '..'));
const { readConfig } = await import(pathToFileURL(path.join(repo, 'server', 'src', 'games', 'Config.ts')).href);
const require = createRequire(path.join(repo, 'server', 'package.json'));
const identity = require(path.join(repo, 'bot', 'arena', 'identity.js'));
assert.equal(typeof identity.contextFor, 'function', 'the v2 context API must be present');
const root = mkdtempSync(path.join(tmpdir(), 'arena-v2-config-context-'));
after(() => rmSync(root, { recursive: true, force: true }));
const IMAGE = { build: 'a'.repeat(40), cards: 'b'.repeat(64) };
const OLD = { build: 'c'.repeat(40), cards: 'd'.repeat(64) };
const expectedContext = (ids) => identity.contextFor({ arenaId: 'v2', ...ids });
const imageFixture = ({ files = true } = {}) => {
    const app = mkdtempSync(path.join(root, 'image-'));
    const data = path.join(app, 'data');
    mkdirSync(data);
    if (files) {
        writeFileSync(path.join(app, 'BUILD_SHA'), `${IMAGE.build}\n`);
        writeFileSync(path.join(app, 'CARDS_SHA'), `${IMAGE.cards}\n`);
    }
    return { app, env: { GAMES_APP: app, GAMES_DATA: data, ARENA_ID: 'v2' } };
};

test('v2 configuration derives the current context from immutable image build and card identities', () => {
    const f = imageFixture(), c = readConfig(f.env);
    assert.equal(c.build, IMAGE.build);
    assert.equal(c.cards, IMAGE.cards);
    assert.deepEqual(c.context, expectedContext(IMAGE));
    assert.notDeepEqual(c.context, expectedContext(OLD));
});

test('conflicting environment overrides cannot restore a previous v2 comparison context after an image rebuild', () => {
    const f = imageFixture();
    for (const overrides of [
        { GAMES_BUILD: OLD.build },
        { GAMES_CARDS: OLD.cards },
        { GAMES_BUILD: OLD.build, GAMES_CARDS: OLD.cards }
    ]) {
        let c;
        try {
            c = readConfig({ ...f.env, ...overrides });
        } catch (error) {
            assert.match(String(error.message), /immutable|conflict|image identity/i, 'conflicting identity must be an explicit configuration refusal');
            continue;
        }
        // Either rejecting the override or always preferring the immutable files is a valid safe contract.
        assert.equal(c.build, IMAGE.build, 'a build override never replaces the current immutable image');
        assert.equal(c.cards, IMAGE.cards, 'a cards override never replaces the current immutable catalog');
        assert.deepEqual(c.context, expectedContext(IMAGE));
        assert.notDeepEqual(c.context, expectedContext(OLD), 'an old stored placement cannot become current through environment overrides');
    }
});

test('explicit overrides equal to the immutable image retain the same v2 context', () => {
    const f = imageFixture(), c = readConfig({ ...f.env, GAMES_BUILD: IMAGE.build, GAMES_CARDS: IMAGE.cards });
    assert.deepEqual(c.context, expectedContext(IMAGE));
});

test('source fixtures without image identity files can explicitly supply valid build and card identities', () => {
    const f = imageFixture({ files: false });
    assert.equal(existsSync(path.join(f.app, 'BUILD_SHA')), false);
    assert.equal(existsSync(path.join(f.app, 'CARDS_SHA')), false);
    const c = readConfig({ ...f.env, GAMES_BUILD: IMAGE.build, GAMES_CARDS: IMAGE.cards });
    assert.equal(c.build, IMAGE.build);
    assert.equal(c.cards, IMAGE.cards);
    assert.deepEqual(c.context, expectedContext(IMAGE));
    assert.equal(existsSync(path.join(f.app, 'BUILD_SHA')), false, 'reading config does not create an image identity file');
    assert.equal(existsSync(path.join(f.app, 'CARDS_SHA')), false);
});
