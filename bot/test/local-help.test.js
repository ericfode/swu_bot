'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { localHelp } = require('../arena/local-help');
const dev = require('../dev');
const { compatibilityStatus, verification, currentCheckerBuild } = require('../arena/compatibility');

test('local help examples use the existing runner arguments and explicit v2 contract', () => {
    const h = localHelp({ owner: 'ana-b', competitor: 'ana_b_fast' });
    const args = (s) => s.slice('npm run dev -- '.length).split(' ');
    const check = dev.parseArgs(args(h.candidate.buildAndCheck));
    assert.equal(check.games, 0);
    assert.equal(check.owner, 'ana-b');
    assert.equal(check.name, 'ana_b_fast');
    const play = dev.parseArgs(args(h.test.baseline));
    assert.deepEqual(play.vs, ['heuristic', 'rush']);
    assert.equal(play.seed, 4242);
    assert.equal(play.games, 4);
    assert.equal(play.jobs, 1);
    const replay = dev.parseArgs(args(h.test.inspect[1]));
    assert.match(replay.again, /\.in\.jsonl$/);
    assert.equal(h.protocol.manifest.protocol, 2);
    assert.equal(h.protocol.manifest.schema, 'swu-arena-bot/1');
    assert.match(h.protocol.requirements.join(' '), /ready.*v.*2/);
    assert.match(h.test.consent, /Downloading is not execution/);
    assert.equal(localHelp({ owner: 'bad; command', competitor: '../../x' }).candidate.buildAndCheck, 'npm run dev -- ../my-bot --owner your-login --games 0');
});

test('documented command entry points print help without setup or workload execution', () => {
    const root = path.join(__dirname, '..', '..');
    for (const entry of ['bot/dev.js', 'bot/arena/download-opponent.js']) {
        const r = spawnSync(process.execPath, [entry, '--help'], { cwd: root, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /npm run dev|download-opponent/);
    }
    const setup = spawnSync('bash', ['tools/setup.sh', '--help'], { cwd: root, encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stdout, /sandbox/);
});

test('local harness check jobs carry trusted build identity required by v2 intake', () => {
    const bot = { owner: 'ana', version: 'ana-v1', doc: { name: 'ana', kind: 'wasm', files: {}, owner: 'untrusted',
        checkerBuild: '0'.repeat(40), context: { arenaId: 'untrusted' } } };
    const job = JSON.parse(JSON.stringify(dev.localCheckJob(bot)));
    assert.equal(job.checkerBuild, currentCheckerBuild());
    assert.equal(job.owner, 'ana');
    assert.equal(job.checkAs, 'ana-v1');
    assert.equal(Object.hasOwn(job, 'context'), false);
    // The final intake's pure evidence contract accepts this trusted parent identity after an observed v2 reply.
    const digest = 'a'.repeat(64);
    const observed = verification({ negotiatedProtocol: 2 }, digest, job.checkerBuild);
    assert.equal(compatibilityStatus(observed, { bundleSha256: digest, checkerBuild: job.checkerBuild }).compatible, true);
    assert.throws(() => dev.localCheckJob(bot, { checkerBuild: null }), /checker build identity is unavailable/);
    assert.equal(dev.childEnv('/tmp/local-test').ARENA_ID, undefined, 'local checks do not impersonate the hosted v2 arena');
});
