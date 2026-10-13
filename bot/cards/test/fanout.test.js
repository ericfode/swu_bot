'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fanout, status, executionOptions } = require('../pipeline/fanout');
const { digest } = require('../pipeline/coverage');
function fixture(t, count) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swu-fanout-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cards = Array.from({ length: count }, (_, i) => 'TST_' + String(i + 1).padStart(3, '0'));
    const prepared = { manifestSha256: 'a'.repeat(64), catalogue: { cards: cards.map(setCode => ({ setCode })) },
        admission: { irConvertedCount: 120, runtimeAdmittedCount: 100 } };
    const counters = { prepares: 0, launches: 0, active: 0, peak: 0 };
    const dependencies = {
        prepare: ({ out }) => { counters.prepares++; fs.mkdirSync(out); },
        loadPrepared: () => prepared,
        verifyResult: (out, cardId) => {
            const receipt = JSON.parse(fs.readFileSync(path.join(out, 'test-result.json')));
            assert.equal(receipt.cardId, cardId); assert.equal(receipt.prepared, prepared.manifestSha256);
            return { status: 'review-pending', comparisons: 3, reviewStatus: 'pending', packetSha256: digest(receipt) };
        },
        runChild: async ({ cardId, directory }) => {
            counters.launches++; counters.active++; counters.peak = Math.max(counters.peak, counters.active);
            fs.mkdirSync(directory);
            await new Promise(resolve => setTimeout(resolve, 20));
            fs.writeFileSync(path.join(directory, 'test-result.json'), JSON.stringify({ cardId, prepared: prepared.manifestSha256 }));
            counters.active--; return { exitCode: 0, signal: null };
        },
    };
    return { root, out: path.join(root, 'batch'), cards, prepared, counters, dependencies };
}
test('twenty jobs overlap, prepare only once, and verified resume starts no new children', async t => {
    const f = fixture(t, 20);
    const result = await fanout({ out: f.out, cards: f.cards, jobs: 20 }, f.dependencies);
    assert.equal(f.counters.prepares, 1); assert.equal(f.counters.launches, 20); assert.equal(f.counters.peak, 20);
    assert.equal(result.maxConcurrentChildren, 20); assert.equal(result.counts['review-pending'], 20);
    assert.deepEqual(result.independentlyReviewedCardIds, []); assert.equal(result.newCardCompletions, null);
    const resumed = await fanout({ run: f.out, jobs: 4 }, f.dependencies);
    assert.equal(f.counters.prepares, 1); assert.equal(f.counters.launches, 20);
    assert.ok(resumed.jobs.every(j => j.attempts === 1));
});
test('a failed card leaves successful siblings intact and retries only in a fresh attempt', async t => {
    const f = fixture(t, 3), real = f.dependencies.runChild;
    let failed = false;
    f.dependencies.runChild = async input => {
        if (input.cardId === 'TST_002' && !failed) { failed = true; fs.mkdirSync(input.directory); fs.writeFileSync(path.join(input.directory, 'partial'), 'keep'); return { exitCode: 1 }; }
        return real(input);
    };
    const initial = await fanout({ out: f.out, cards: f.cards, jobs: 2 }, f.dependencies);
    assert.equal(initial.counts.failed, 1); assert.equal(initial.counts['review-pending'], 2); assert.ok(f.counters.peak <= 2);
    const resumed = await fanout({ run: f.out, jobs: 2 }, f.dependencies);
    assert.equal(resumed.counts['review-pending'], 3);
    assert.equal(resumed.jobs.find(j => j.cardId === 'TST_002').attempts, 2);
    assert.ok(fs.existsSync(path.join(f.out, 'cards/TST_002/attempt-1/partial')));
    assert.equal(resumed.jobs.find(j => j.cardId === 'TST_001').attempts, 1);
});
test('resume rejects changed completed evidence and prepared identity before launching work', async t => {
    const f = fixture(t, 2);
    await fanout({ out: f.out, cards: f.cards }, f.dependencies);
    fs.writeFileSync(path.join(f.out, 'cards/TST_001/attempt-1/test-result.json'), JSON.stringify({ cardId: 'TST_999' }));
    await assert.rejects(fanout({ run: f.out }, f.dependencies), /TST_999/);
    assert.equal(f.counters.launches, 2);
    f.prepared.manifestSha256 = 'b'.repeat(64);
    await assert.rejects(fanout({ run: f.out }, f.dependencies), /Prepared manifest changed/);
    assert.equal(f.counters.launches, 2);
});
test('running attempts survive interruption and are never overwritten on resume', async t => {
    const f = fixture(t, 1);
    await fanout({ out: f.out, cards: f.cards }, f.dependencies);
    const file = path.join(f.out, 'state.json'), state = JSON.parse(fs.readFileSync(file));
    state.jobs[0].status = 'running'; state.jobs[0].attempts[0].status = 'running';
    fs.writeFileSync(file, JSON.stringify(state));
    const result = await fanout({ run: f.out }, f.dependencies);
    assert.equal(result.jobs[0].attempts, 2);
    const current = JSON.parse(fs.readFileSync(file));
    assert.equal(current.jobs[0].attempts[0].status, 'interrupted');
    assert.ok(fs.existsSync(path.join(f.out, 'cards/TST_001/attempt-1/test-result.json')));
});
test('an unconstructed job is needs-work, and a live coordinator cannot be recovered', async t => {
    const f = fixture(t, 1);
    f.dependencies.verifyResult = () => ({ status: 'needs-work', comparisons: 0, reviewStatus: 'pending' });
    const result = await fanout({ out: f.out, cards: f.cards }, f.dependencies);
    assert.equal(result.counts['needs-work'], 1); assert.deepEqual(result.pipelineComparedCardIds, []);
    fs.writeFileSync(path.join(f.out, 'coordinator.lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'owner' }));
    await assert.rejects(fanout({ run: f.out, recover: true }, f.dependencies), /still alive/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, 'coordinator.lock'))).token, 'owner');
    assert.equal(status({ run: f.out }, f.dependencies).counts['needs-work'], 1);
});
test('concurrency and timeout are explicit bounded integers', () => {
    assert.equal(executionOptions({}).jobs, 20);
    for (const jobs of [0, 21, 1.5, NaN, 'wat']) assert.throws(() => executionOptions({ jobs }));
    for (const timeoutMs of [0, 1.5, 14400001]) assert.throws(() => executionOptions({ timeoutMs }));
});

test('coordinator failure aborts and drains siblings before releasing its ownership', async t => {
    const f = fixture(t, 2);
    let activeStopped = false, started = false;
    f.dependencies.runChild = async ({ signal }) => {
        started = true;
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(fs.existsSync(path.join(f.out, 'coordinator.lock')), 'Coordinator must retain ownership while children stop');
        activeStopped = true;
        return { exitCode: 1, cancelled: true };
    };
    let injected = false;
    f.dependencies.saveState = (file, state) => {
        if (!injected && started && state.jobs[1].status === 'running') { injected = true; throw new Error('simulated disk failure'); }
        fs.writeFileSync(file, JSON.stringify(state));
    };
    await assert.rejects(fanout({ out: f.out, cards: f.cards, jobs: 2 }, f.dependencies), /simulated disk failure/);
    assert.equal(activeStopped, true);
    assert.ok(!fs.existsSync(path.join(f.out, 'coordinator.lock')));
});
test('concurrent recovery cannot replace the newly acquired live owner', async t => {
    const { spawn } = require('node:child_process');
    const f = fixture(t, 1); fs.mkdirSync(f.out);
    fs.writeFileSync(path.join(f.out, 'coordinator.lock'), JSON.stringify({ pid: 1000000000, host: os.hostname(), token: 'dead-owner' }));
    const modulePath = require.resolve('../pipeline/fanout');
    const script = `const {acquire}=require(${JSON.stringify(modulePath)});try {const release=acquire(${JSON.stringify(f.out)},true);console.log('acquired');setTimeout(()=>{release();process.exit(0)},150)} catch(e) {process.exit(2)}`;
    const child = () => new Promise((resolve, reject) => {
        const process = spawn(global.process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        process.once('error', reject); process.once('close', code => resolve(code));
    });
    const codes = await Promise.all([child(), child()]);
    assert.deepEqual(codes.sort(), [0, 2]);
});
test('resume rejects traversing card IDs even if manifest and state were rehashed together', async t => {
    const f = fixture(t, 1); await fanout({ out: f.out, cards: f.cards }, f.dependencies);
    const mf = path.join(f.out, 'manifest.json'), sf = path.join(f.out, 'state.json');
    const manifest = JSON.parse(fs.readFileSync(mf)), state = JSON.parse(fs.readFileSync(sf));
    manifest.cards = ['../../escape']; state.manifestSha256 = digest(manifest); state.jobs[0].cardId = '../../escape';
    fs.writeFileSync(mf, JSON.stringify(manifest)); fs.writeFileSync(sf, JSON.stringify(state));
    await assert.rejects(fanout({ run: f.out }, f.dependencies), /printed card ID/);
    assert.throws(() => status({ run: f.out }, f.dependencies), /printed card ID/);
});

test('a matching existing prepared bundle is reused without invoking any build', async t => {
    const f = fixture(t, 2), shared = path.join(f.root, 'shared-prepared'); fs.mkdirSync(shared);
    const result = await fanout({ out: f.out, cards: f.cards, prepared: shared }, f.dependencies);
    assert.equal(f.counters.prepares, 0); assert.equal(result.counts['review-pending'], 2);
    await fanout({ run: f.out }, f.dependencies);
    assert.equal(f.counters.prepares, 0); assert.equal(f.counters.launches, 2);
});


test('timeout kills a TERM-ignoring descendant even when its CLI parent exits first', { skip: process.platform === 'win32', timeout: 8000 }, async t => {
    const { runChild } = require('../pipeline/fanout');
    const { spawn } = require('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swu-fanout-descendant-'));
    const pidFile = path.join(root, 'grandchild.pid');
    let grandchildPid;
    t.after(() => {
        if (grandchildPid) { try { process.kill(grandchildPid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
        fs.rmSync(root, { recursive: true, force: true });
    });
    const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, process.argv[1]], {stdio: 'ignore'}); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;
    const result = await runChild({ cardId: 'TST_001', directory: path.join(root, 'attempt'), prepared: root, mutations: true, timeoutMs: 1500 }, {
        spawn: (command, _args, options) => spawn(command, ['-e', parent, pidFile], options),
    });
    assert.equal(result.timedOut, true);
    grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
        try { process.kill(grandchildPid, 0); await new Promise(resolve => setTimeout(resolve, 10)); }
        catch (e) { if (e.code !== 'ESRCH') throw e; alive = false; }
    }
    assert.equal(alive, false, 'No surviving descendant after the timed-out child closes');
    grandchildPid = null;
});
