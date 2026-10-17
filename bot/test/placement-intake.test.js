'use strict';
// Submission integration only: checkers, queue writes and the window are fakes. Recovery exercises only an already
// entered version's metadata; none of these tests packs, starts or plays submitted code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'placement-intake-'));
Object.assign(process.env, { ARENA_HOME: path.join(tmp, 'arena'), ARENA_RESULTS: path.join(tmp, 'results'), ARENA_DASH: path.join(tmp, 'dash') });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const home = require('../arena/home');
const intake = require('../arena/intake');

const ready = () => null;
const submission = (extra = {}) => ({ owner: 'kim', name: 'kim', kind: 'js', note: 'a tested change',
    files: { 'bot.js': 'this is never executed' }, state: 'pending', ...extra });
const accepted = async () => ({ ok: true, name: 'kim', version: 'kim-v1', benched: false });
const placement = { version: 'kim-v1', ref: 'window:kim.1', state: 'queued', completed: 0, total: 2 };

function memWindow(docs) {
    return {
        docs,
        writes: [],
        async request(method, url) {
            assert.equal(method, 'GET');
            return url === '/api/docs/submissions' ? Object.keys(docs).map((id) => ({ id })) : docs[decodeURIComponent(url.split('/').pop())] ?? null;
        },
        async putDoc(ns, id, doc) {
            assert.equal(ns, 'submissions');
            const copy = JSON.parse(JSON.stringify(doc));
            this.writes.push(copy);
            docs[id] = copy;
        }
    };
}

test('a checked submission is queued before acceptance, and the owner receives placement progress', async () => {
    const w = memWindow({ 'kim.1': submission() });
    const stats = {};
    const finished = new Set();
    const calls = [];
    const enqueuePlacement = (job) => {
        assert.equal(w.docs['kim.1'].state, 'checking', 'acceptance has not been acknowledged');
        calls.push(job);
        return placement;
    };
    assert.equal(await intake.intakeOnce({ window: w, missing: ready, checker: accepted, enqueuePlacement, stats, finished }), 1);
    assert.deepEqual(calls, [{ version: 'kim-v1', ref: 'window:kim.1', benched: false }]);
    assert.deepEqual(w.docs['kim.1'].placement, placement);
    assert.equal(w.docs['kim.1'].state, 'accepted');
    assert.equal(w.docs['kim.1'].files, undefined);
    assert.equal(w.docs['kim.1'].base64, undefined);
    assert.equal(stats.accepted, 1);
    assert.equal(stats.open, 0);
    assert.deepEqual([...finished], ['kim.1']);
});

test('a rejected submission never queues placement work', async () => {
    const w = memWindow({ 'kim.rejected': submission() });
    assert.equal(await intake.intakeOnce({ window: w, missing: ready,
        checker: async () => ({ ok: false, error: 'sandbox start check failed' }),
        enqueuePlacement: () => assert.fail('rejected code must never enter placement') }), 1);
    assert.equal(w.docs['kim.rejected'].state, 'rejected');
    assert.equal(w.docs['kim.rejected'].error, 'sandbox start check failed');
    assert.equal(w.docs['kim.rejected'].placement, undefined);
});

test('cycle mode acceptance keeps the existing response when no placement is requested', async () => {
    const w = memWindow({ 'kim.cycle': submission() });
    await intake.intakeOnce({ window: w, missing: ready, checker: accepted, enqueuePlacement: () => null });
    assert.equal(w.docs['kim.cycle'].state, 'accepted');
    assert.equal(w.docs['kim.cycle'].placement, undefined);
});

test('queue failure leaves a valid submission pending; retry recovers its entered ref and queues it once', async () => {
    const id = 'kim.retry';
    const ref = `window:${id}`;
    const w = memWindow({ [id]: submission() });
    const finished = new Set();
    home.writeJson(path.join(home.HOME, 'roster.json'), { thinkCapMs: 60000, baselines: [], agents: [{ name: 'kim', owner: 'github:kim' }] });
    // Only metadata is needed for checkIsolated's existing-ref recovery path. No bundle or executable exists.
    home.writeJson(path.join(home.VERSIONS, 'kim-v1', 'SUBMISSION.json'), { ref, checked: true });
    let attempts = 0;
    let inserts = 0;
    const jobs = new Map();
    const enqueuePlacement = (job) => {
        attempts++;
        if (attempts === 1) throw new Error('placement storage unavailable');
        if (!jobs.has(job.ref)) {
            jobs.set(job.ref, { ...placement, ref: job.ref });
            inserts++;
        }
        return jobs.get(job.ref);
    };
    await assert.rejects(intake.intakeOnce({ window: w, missing: ready, checker: accepted, enqueuePlacement, finished }), /placement storage unavailable/);
    assert.equal(w.docs[id].state, 'pending');
    assert.equal(w.docs[id].files['bot.js'], 'this is never executed');
    assert.equal(w.docs[id].checkingAt, undefined);
    assert.equal(finished.size, 0);
    assert.equal(w.writes.some((doc) => doc.state === 'rejected' || doc.state === 'accepted'), false);
    assert.equal(await intake.intakeOnce({ window: w, missing: ready, checker: intake.checkIsolated, enqueuePlacement, finished }), 1);
    assert.equal(w.docs[id].state, 'accepted');
    assert.equal(w.docs[id].version, 'kim-v1');
    assert.equal(inserts, 1);
    // A boot with an old pending copy recovers the same version and uses the same queue key.
    w.docs[id] = submission();
    await intake.intakeOnce({ window: w, missing: ready, checker: intake.checkIsolated, enqueuePlacement });
    assert.equal(inserts, 1);
    assert.equal(home.versionsOf('kim').length, 1, 'no duplicate submitted version');
});

test('retrying an acceptance acknowledgment sends the existing placement without checking or queuing again', async () => {
    const w = memWindow({ 'kim.ack': submission() });
    const put = w.putDoc;
    let fail = true;
    w.putDoc = async function(ns, id, doc) {
        if (doc.state === 'accepted' && fail) {
            fail = false;
            throw new Error('window unavailable');
        }
        return put.call(this, ns, id, doc);
    };
    const unsent = new Map();
    const finished = new Set();
    let enqueued = 0;
    const enqueuePlacement = () => { enqueued++; return placement; };
    await assert.rejects(intake.intakeOnce({ window: w, missing: ready, checker: accepted, enqueuePlacement, unsent, finished }), /window unavailable/);
    assert.equal(enqueued, 1);
    assert.equal(unsent.size, 1);
    await intake.intakeOnce({ window: w, missing: ready, checker: () => assert.fail('already entered'),
        enqueuePlacement: () => assert.fail('already queued'), unsent, finished });
    assert.equal(w.docs['kim.ack'].state, 'accepted');
    assert.deepEqual(w.docs['kim.ack'].placement, placement);
    assert.equal(unsent.size, 0);
});
