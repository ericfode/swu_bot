'use strict';
// On the games machine the arena's folders belong to the bots' user, and root processes (the referee, the pusher, the
// intake) work in them. These check that a root writer never writes through a link planted there, and that the intake
// cannot be made to check one submission forever. No engine or card data needed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-hardening-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
Object.assign(process.env, { ARENA_HOME: path.join(tmp, 'arena'), ARENA_RESULTS: path.join(tmp, 'results'), ARENA_DASH: path.join(tmp, 'dash') });
const home = require('../arena/home');
const intake = require('../arena/intake');

test('writeAtomic replaces a planted link instead of writing through it; appendJsonl refuses one', () => {
    const victim = path.join(tmp, 'victim.txt');
    fs.writeFileSync(victim, 'keep');
    const file = path.join(tmp, 'arena', 'standings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(victim, file);
    home.writeJson(file, { rounds: [] });
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep');
    assert.ok(fs.lstatSync(file).isFile());
    assert.deepStrictEqual(home.readJson(file), { rounds: [] });
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left');

    const log = path.join(tmp, 'arena', 'events.jsonl');
    fs.symlinkSync(victim, log);
    assert.throws(() => home.appendJsonl(log, { t: 'x' }), (e) => e.code === 'ELOOP');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep');
    const plain = path.join(tmp, 'arena', 'plain.jsonl');
    home.appendJsonl(plain, { a: 1 });
    home.appendJsonl(plain, { a: 2 });
    assert.deepStrictEqual(home.readJsonl(plain), [{ a: 1 }, { a: 2 }]);
});

/** A window that holds submissions in memory, with the two calls the intake makes. */
function memWindow(docs) {
    return {
        docs,
        async request(method, p) {
            if (p === '/api/docs/submissions') {
                return Object.keys(docs).map((id) => ({ id }));
            }
            return docs[decodeURIComponent(p.split('/').pop())] ?? null;
        },
        async putDoc(ns, id, doc) {
            docs[id] = JSON.parse(JSON.stringify(doc));
        }
    };
}

const sub = (extra) => ({ owner: 'kim-b', name: 'kim_b', kind: 'js', note: 'n', files: { 'bot.js': '1' }, ...extra });
const ready = () => null;

test('intake: a check the arena never finished counts as a try; at the limit the submission is rejected unchecked', async () => {
    const long = new Date(Date.now() - 60 * 60000).toISOString();
    const w = memWindow({ 'kim-b.1': sub({ state: 'checking', checkingAt: long, tries: intake.RETRIES - 2 }) });
    let checks = 0;
    const checker = async () => {
        checks++;
        return { ok: false, retry: true, error: 'no result' };
    };
    await intake.intakeOnce({ window: w, missing: ready, checker });
    assert.strictEqual(checks, 1);
    assert.strictEqual(w.docs['kim-b.1'].state, 'rejected', 'the stuck claim and the failed check make the limit');

    w.docs['kim-b.2'] = sub({ state: 'checking', checkingAt: long, tries: intake.RETRIES - 1 });
    const stats = {};
    assert.strictEqual(await intake.intakeOnce({ window: w, missing: ready, checker, stats }), 1);
    assert.strictEqual(checks, 1, 'not checked again');
    assert.strictEqual(w.docs['kim-b.2'].state, 'rejected');
    assert.match(w.docs['kim-b.2'].error, /stopped during its check/);
    assert.strictEqual(w.docs['kim-b.2'].files, undefined, 'its files are dropped');
    assert.strictEqual(stats.open, 0);
});

test('intake: a stop during a check puts the submission back to pending, with its tries', async () => {
    const w = memWindow({ 'kim-b.3': sub({ state: 'pending', tries: 1 }) });
    const current = {};
    let midCheck;
    const checker = () => new Promise((resolve) => {
        midCheck = { ...current };
        resolve({ ok: false, error: 'bad bot' });
    });
    await intake.intakeOnce({ window: w, missing: ready, checker, current });
    assert.strictEqual(midCheck.id, 'kim-b.3', 'the check in progress is visible to a stop');
    assert.deepStrictEqual(current, {}, 'and cleared after it');

    // as a stop would find it: claimed, checking
    w.docs['kim-b.4'] = sub({ state: 'checking', checkingAt: new Date().toISOString(), tries: 1 });
    assert.strictEqual(await intake.release({ id: 'kim-b.4', doc: sub({ state: 'pending', tries: 1 }) }, w), true);
    assert.strictEqual(w.docs['kim-b.4'].state, 'pending');
    assert.strictEqual(w.docs['kim-b.4'].tries, 1);
    assert.strictEqual(w.docs['kim-b.4'].checkingAt, undefined);
    assert.strictEqual(await intake.release({}, w), false, 'nothing being checked');
});

test('intake: the checker\'s result is its last stdout line, and only a {ok: boolean} object counts', () => {
    assert.deepStrictEqual(intake.lastResult('packing...\n{"ok":true,"version":"kim_b-v1"}\n'), { ok: true, version: 'kim_b-v1' });
    assert.strictEqual(intake.lastResult('{"ok":true}\nlater noise\n'), null);
    assert.strictEqual(intake.lastResult('{"ok":"yes"}'), null);
    assert.strictEqual(intake.lastResult(''), null);
});

test('referee: a ladder folder that is a link is neither locked nor handed to the bots\' user', () => {
    const { takeLock, giveToBots } = require('../arena/referee');
    const target = path.join(tmp, 'app');
    fs.mkdirSync(target, { recursive: true });
    const dir = path.join(tmp, 'results', 'arena-r8');
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.symlinkSync(target, dir);
    assert.throws(() => takeLock(dir), /not a folder/);
    assert.deepStrictEqual(fs.readdirSync(target), [], 'no lock written through the link');
    if (process.getuid?.() === 0) {
        const saved = process.env.ARENA_BOT_USER;
        process.env.ARENA_BOT_USER = 'nobody';
        try {
            assert.throws(() => giveToBots(dir), (e) => ['ENOTDIR', 'ELOOP'].includes(e.code));
            assert.strictEqual(fs.statSync(target).uid, 0, 'the link\'s target stays root\'s');
        } finally {
            if (saved === undefined) {
                delete process.env.ARENA_BOT_USER;
            } else {
                process.env.ARENA_BOT_USER = saved;
            }
        }
    }
});

test('dashboard: a roster name that is not a competitor name never becomes part of a file name', () => {
    const dash = require('../arena/dash');
    fs.mkdirSync(path.join(tmp, 'dash', 'panels'), { recursive: true });
    const victim = path.join(tmp, 'toolchain.json');
    fs.writeFileSync(victim, '{"keep":true}');
    home.writeJson(home.ROSTER, { thinkCapMs: 60000, baselines: ['rush'], agents: [{ name: 'x/../../../toolchain' }, { name: 'ok_one' }] });
    dash.publishStandings({ status: 'done', rounds: [{ round: 1, status: 'done', games: 0, scheduled: 0, bots: [] }], global: {} });
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), '{"keep":true}');
    assert.ok(fs.existsSync(path.join(tmp, 'dash', 'panels', 'arena-ok_one.json')));
    assert.throws(() => dash.updatePanel('../x', { now: 'n' }), /not a competitor name/);
});

test('intake --check: an error too long for one line is cut, so the result still comes back', () => {
    const job = path.join(tmp, 'check-job', 'job.json');
    fs.mkdirSync(path.dirname(job), { recursive: true });
    // a bad file path 70 KB long: check() throws it as the bot's error
    fs.writeFileSync(job, JSON.stringify(sub({ id: 'kim-b.9', files: { [`${'x/'.repeat(35000)}..`]: '1' } })));
    const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'arena', 'intake.js'), '--check', job, '-'],
        { encoding: 'utf8', env: { PATH: process.env.PATH, ARENA_HOME: process.env.ARENA_HOME, ARENA_RESULTS: process.env.ARENA_RESULTS, ARENA_DASH: process.env.ARENA_DASH } });
    assert.strictEqual(r.status, 0, r.stderr);
    const res = intake.lastResult(r.stdout);
    assert.ok(res && res.ok === false, r.stdout.slice(0, 200));
    assert.match(res.error, /^bad file path x\/x\//);
    assert.ok(r.stdout.length < 64 * 1024);
});

// last in this file: a stop is for the rest of the process (no later pass claims anything)
test('intake: a stop during a check writes no result; release puts the submission back to pending', async () => {
    const w = memWindow({ 'kim-b.5': sub({ state: 'pending' }), 'kim-b.6': sub({ state: 'pending' }) });
    const current = {};
    let released;
    // as the stop handlers do: kill the checks, then put back what was being checked
    const checker = async () => {
        intake.stopCheckers();
        released = intake.release(current, w);
        await new Promise((r) => setTimeout(r, 20));
        return { ok: false, error: 'the check took more than 5 minutes' }; // what a killed check looks like
    };
    assert.strictEqual(await intake.intakeOnce({ window: w, missing: ready, checker, current }), 0);
    assert.strictEqual(await released, true);
    assert.strictEqual(w.docs['kim-b.5'].state, 'pending', 'not rejected');
    assert.strictEqual(w.docs['kim-b.5'].error, undefined);
    assert.strictEqual(w.docs['kim-b.6'].state, 'pending', 'nothing else claimed');
    assert.strictEqual(await intake.intakeOnce({ window: w, missing: ready, checker }), 0, 'a stopped intake starts no pass');
});
