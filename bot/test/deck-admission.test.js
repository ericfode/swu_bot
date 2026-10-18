'use strict';
// Trusted metadata + canonical tar packing/promotion only; checked:true never executes a bot or checker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-admission-'));
Object.assign(process.env, { ARENA_ID: 'open', ARENA_AUTH: '0', ARENA_HOME: path.join(root, 'arena'), ARENA_RESULTS: path.join(root, 'results'), ARENA_DASH: path.join(root, 'dash') });
const home = require('../arena/home');
const { api } = require('../arena/api');
const { bundleDigest, verification, currentCheckerBuild, compatibilityStatus } = require('../arena/compatibility');
const choices = require('../arena/deck-choice');
const { bundleFiles } = require('../arena/intake');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('promotion preserves deck binding, exact canonical bytes and v2 proof; changing deck requires new proof', () => {
    home.updateRoster((r) => ({ ...r, agents: [{ name: 'kim', owner: 'github:kim', resident: true }] }));
    const folder = path.join(root, 'bundle'); fs.mkdirSync(folder);
    const d = { metadata: { name: 'intended' }, leader: { id: 'SOR_005' }, base: { id: 'SOR_029' },
        deck: Array.from({ length: 17 }, (_, k) => ({ id: `SHD_${100 + k}`, count: k === 16 ? 2 : 3 })) };
    const lookups = { known: () => true };
    fs.writeFileSync(path.join(folder, 'bot.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])); // never run
    fs.writeFileSync(path.join(folder, 'arena.json'), JSON.stringify({ schema: 'swu-arena-bot/1', protocol: 2,
        kind: 'wasm', platform: 'wasm32-wasip1', runtime: 'wasi-p1', run: { cmd: './bot.wasm' } }));
    const before = bundleDigest(folder);
    const binding = choices.prepareBundle(folder, d, { lookups });
    const digest = bundleDigest(folder);
    assert.notEqual(digest, before);
    const proof = verification({ negotiatedProtocol: 2 }, digest, currentCheckerBuild());
    const submit = (files, compatibility) => api.submit({ name: 'kim', note: 'trusted frozen fixture', bot: { kind: 'wasm', files } }, { checked: true, compatibility });
    submit(bundleFiles(folder), proof);
    const version = path.join(home.VERSIONS, 'kim-v1');
    assert.equal(bundleDigest(path.join(version, 'bundle')), digest);
    const meta = home.readJson(path.join(version, 'SUBMISSION.json'));
    assert.deepEqual(meta.deck, binding);
    assert.deepEqual(choices.versionChoice('kim-v1'), binding);
    assert.equal(compatibilityStatus(meta.compatibility, { bundleSha256: digest }).compatible, true);
    const m = JSON.parse(fs.readFileSync(path.join(folder, 'arena.json')));
    m.arenaDeck.list.leader.id = 'SOR_006'; m.arenaDeck.sha256 = choices.digest(m.arenaDeck.list);
    fs.writeFileSync(path.join(folder, 'arena.json'), JSON.stringify(m));
    assert.throws(() => submit(bundleFiles(folder), proof), /compatibility not verified/);
    assert.deepEqual(home.versionsOf('kim'), [1]);
    assert.equal(bundleDigest(path.join(version, 'bundle')), digest);
    home.writeJson(path.join(version, 'SUBMISSION.json'), { ...meta, deck: m.arenaDeck });
    assert.throws(() => choices.versionChoice('kim-v1'), /admission differs/);
    home.writeJson(path.join(version, 'SUBMISSION.json'), { ...meta, deck: undefined });
    assert.equal(choices.versionChoice('kim-v1'), null, 'legacy metadata is not silently assigned a deck');
});
