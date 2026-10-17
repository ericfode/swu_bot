'use strict';
// Metadata-only fixtures and fake spec builders: no submitted bundle, program, or game is executed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'placement-test-'));
process.env.ARENA_HOME = path.join(tmp, 'arena');
process.env.ARENA_RESULTS = path.join(tmp, 'results');
const home = require('../arena/home');
const placement = require('../arena/placement');
const write = (file, doc) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc));
};
const refOf = (version) => `window:submission-${version}`;
const version = (name, n = 1, meta = {}) => {
    const v = `${name}-v${n}`;
    write(path.join(home.VERSIONS, v, 'SUBMISSION.json'), {
        name: v, agent: name, version: n, checked: true, bot: { kind: 'wasm' }, ref: refOf(v), submittedAt: '2026-10-17T01:00:00.000Z', ...meta
    });
    write(path.join(home.VERSIONS, v, 'bundle', 'arena.json'), {});
    // Were anything to load bot.js instead of describing the checked wasm version, this test fails visibly.
    fs.writeFileSync(path.join(home.VERSIONS, v, 'bot.js'), "throw new Error('submitted code must never be loaded');\n");
    return v;
};
const agent = (name, extra = {}) => home.updateRoster((r) => ({ ...r, agents: [...r.agents, { name, owner: `github:${name}`, ...extra }] }));
const add = (name, n = 1, extra = {}) => { agent(name, extra); return version(name, n); };
const enqueue = (v, extra = {}) => placement.enqueue({ version: v, ref: refOf(v), ...extra });
const specOf = (k, job, gamesPerPair = 2) => ({
    round: k, bots: [job.version, ...job.opponents], gamesPerPair, capMs: 60000, decks: null,
    bundles: Object.fromEntries([job.version, ...job.opponents].map((v) => [v, 'a'.repeat(64)])),
    botInfo: Object.fromEntries([job.version, ...job.opponents].map((v) => [v, { kind: 'arena', lang: 'wasm' }]))
});
const queueFiles = () => fs.existsSync(path.join(home.HOME, 'placements'))
    ? fs.readdirSync(path.join(home.HOME, 'placements')).filter((f) => f.endsWith('.json')) : [];
const child = (script) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (b) => { stdout += b; });
    c.stderr.on('data', (b) => { stderr += b; });
    c.on('error', reject);
    c.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`child ${code}: ${stderr}`)));
});
const modulePath = require.resolve('../arena/placement');

test.beforeEach(() => {
    fs.rmSync(home.HOME, { recursive: true, force: true });
    process.env.GAMES_PLACEMENT_MODE = 'immediate';
    write(home.ROSTER, { agents: [], baselines: [], thinkCapMs: 60000 });
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('placement: opt-in only, with no side effects when ordinary mode is selected', () => {
    const v = add('alice');
    delete process.env.GAMES_PLACEMENT_MODE;
    assert.equal(enqueue(v), null);
    assert.equal(placement.next(), null);
    assert.equal(placement.reserve(0, () => assert.fail('no spec in ordinary mode')), null);
    assert.deepEqual(placement.statuses(), []);
    assert.deepEqual(queueFiles(), []);
    assert.equal(fs.existsSync(path.join(home.HOME, 'placements')), false);
});

test('placement: rejected, unchecked, non-wasm, benched, withdrawn and mismatched submissions never queue', () => {
    const v = add('alice');
    assert.equal(placement.enqueue({ version: '../alice-v1', ref: refOf(v) }), null);
    assert.equal(placement.enqueue({ version: v, ref: 'window:wrong' }), null);
    assert.equal(placement.enqueue({ version: v, ref: 'local:unsupported' }), null);
    assert.equal(enqueue(v, { benched: true }), null);
    version('alice', 1, { checked: false });
    assert.equal(enqueue(v), null);
    version('alice', 1, { bot: { kind: 'stdio', cmd: 'must-not-start' } });
    assert.equal(enqueue(v), null);
    version('alice', 1, { bot: { kind: 'js' } });
    assert.equal(enqueue(v), null);
    version('alice');
    home.updateRoster((r) => ({ ...r, agents: r.agents.map((a) => ({ ...a, withdrawn: [1] })) }));
    assert.equal(enqueue(v), null);
    home.updateRoster((r) => ({ ...r, agents: [], bench: r.agents }));
    assert.equal(enqueue(v), null);
    assert.deepEqual(queueFiles(), []);
});

test('placement: admitted versions only; symlinked metadata or bundles are refused', () => {
    const v = add('alice');
    const metaFile = path.join(home.VERSIONS, v, 'SUBMISSION.json');
    const saved = path.join(tmp, 'saved-submission.json');
    fs.copyFileSync(metaFile, saved);
    fs.rmSync(metaFile);
    fs.symlinkSync(saved, metaFile);
    assert.equal(enqueue(v), null);
    fs.rmSync(metaFile);
    fs.copyFileSync(saved, metaFile);
    const dir = path.join(home.VERSIONS, v, 'bundle');
    const moved = path.join(tmp, 'saved-bundle');
    fs.renameSync(dir, moved);
    fs.symlinkSync(moved, dir);
    assert.equal(enqueue(v), null);
    assert.deepEqual(queueFiles(), []);
});

test('placement: bounded deterministic anchor and BT spread, frozen at enqueue; old accepted versions are kept', () => {
    const target = add('alice');
    const anchor = add('house', 1, { resident: true });
    const high = add('high');
    const middle = add('middle');
    const low = add('low');
    const bottom = add('bottom');
    const tied = add('tied');
    write(path.join(home.HOME, 'standings.json'), { rounds: [], global: { [high]: 1800, [middle]: 1600, [anchor]: 1500, [low]: 1300, [bottom]: 1200, [tied]: 1600 } });
    const row = enqueue(target);
    assert.equal(row.state, 'queued');
    assert.deepEqual(row.opponents, [anchor, high, tied, bottom]);
    assert.equal(row.opponents.length, placement.MAX_OPPONENTS);
    version('alice', 2);
    version('house', 2);
    write(path.join(home.HOME, 'standings.json'), { rounds: [], global: { [bottom]: 2500 } });
    assert.deepEqual(enqueue(target), row, 'retry keeps the original opponent/version snapshot');
    const spec = placement.reserve(7, (job) => specOf(7, job, 10));
    assert.deepEqual(spec.bots, [target, anchor, high, tied, bottom]);
    assert.deepEqual(spec.placement, { version: target, ref: refOf(target) });
    assert.equal(placement.statuses()[0].scheduled, 40, 'at most four opponents times ten games');
    assert.equal(placement.statuses()[0].spec, undefined);
    assert.equal(placement.statuses()[0].bundles, undefined);
});

test('placement: no opponent waits; readonly planning discovers a later admitted opponent and root reserves it', () => {
    const target = add('alice');
    assert.equal(enqueue(target).state, 'waiting');
    assert.equal(placement.next(), null);
    const file = path.join(home.HOME, 'placements', `${target}.json`);
    const before = fs.readFileSync(file, 'utf8');
    const opponent = add('house', 1, { resident: true });
    assert.equal(placement.next().version, target);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'plan is strictly read-only');
    const spec = placement.reserve(0, (job) => specOf(0, job));
    assert.deepEqual(spec.bots, [target, opponent]);
    assert.equal(placement.statuses()[0].state, 'running');
});

test('placement: failed preparation keeps its round, version and opponents; retries reuse the frozen spec', () => {
    const target = add('alice');
    const opponent = add('house', 1, { resident: true });
    enqueue(target);
    assert.throws(() => placement.reserve(3, () => { throw new Error('fake pack unavailable'); }), /fake pack unavailable/);
    assert.deepEqual([placement.next().round, placement.next().state, placement.next().error], [3, 'retrying', 'fake pack unavailable']);
    assert.equal(placement.reserve(4, () => assert.fail('cannot move a reserved job to another round')), null);
    version('house', 2);
    const spec = placement.reserve(3, (job) => specOf(3, job));
    assert.deepEqual(spec.bots, [target, opponent]);
    placement.update(3, { state: 'held', error: 'fake worker failure' });
    delete process.env.GAMES_PLACEMENT_MODE;
    assert.equal(placement.getRound(3).state, 'held');
    assert.deepEqual(placement.reserve(3, () => assert.fail('retry must reuse exact rules')), spec);
    assert.deepEqual(placement.next().spec, spec, 'started placement drains with the option off');
    assert.equal(queueFiles().length, 1);
});

test('placement: completion publishes counts and late failures cannot regress it; no rated results is explicit', () => {
    const target = add('alice');
    add('house', 1, { resident: true });
    enqueue(target);
    placement.reserve(0, (job) => specOf(0, job));
    placement.update(0, { state: 'running', finished: 1, rated: 1, scheduled: 2 });
    const done = placement.update(0, { state: 'done', finished: 2, rated: 2 });
    assert.equal(done.state, 'complete');
    assert.deepEqual(done.progress, { finished: 2, rated: 2, scheduled: 2 });
    assert.deepEqual(placement.update(0, { state: 'held', error: 'late failed callback', finished: 0 }), done);
    assert.equal(placement.next(), null);
    const v2 = version('alice', 2);
    enqueue(v2);
    placement.reserve(1, (job) => specOf(1, job));
    assert.equal(placement.update(1, { state: 'done', finished: 2, rated: 0 }).state, 'unrated');
    assert.equal(placement.next(), null);
});

test('placement: withdrawn queued targets are skipped without writing from plan', () => {
    const target = add('alice');
    add('house', 1, { resident: true });
    enqueue(target);
    home.updateRoster((r) => ({ ...r, agents: r.agents.map((a) => a.name === 'alice' ? { ...a, withdrawn: [1] } : a) }));
    const before = JSON.stringify(placement.statuses());
    assert.equal(placement.statuses()[0].state, 'blocked');
    assert.equal(placement.next(), null);
    assert.equal(JSON.stringify(placement.statuses()), before);
    const nextTarget = add('bob');
    enqueue(nextTarget);
    assert.equal(placement.next().version, nextTarget);
    placement.reserve(0, (job) => specOf(0, job));
    assert.equal(placement.statuses().find((r) => r.version === target).state, 'cancelled', 'root reconciles the blocked target');
});

test('placement: before start only invalid opponents are replaced, preserving eligible frozen older versions', () => {
    const target = add('alice');
    const house = add('house', 1, { resident: true });
    const high = add('high');
    assert.deepEqual(enqueue(target).opponents, [house, high]);
    const house2 = version('house', 2);
    const high2 = version('high', 2);
    add('middle');
    home.updateRoster((r) => ({ ...r, agents: r.agents.map((a) => a.name === 'house' ? { ...a, withdrawn: [1] } : a) }));
    const file = path.join(home.HOME, 'placements', `${target}.json`);
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(placement.next().version, target, 'readonly plan sees the available replacement');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const spec = placement.reserve(7, (job) => specOf(7, job));
    assert.deepEqual(spec.bots, [target, house2, high]);
    assert.ok(!spec.bots.includes(high2), 'a still-eligible frozen version is retained');
});

test('placement: root records waiting when opponents become ineligible, then admits a later replacement', () => {
    const target = add('alice');
    add('house', 1, { resident: true });
    enqueue(target);
    home.updateRoster((r) => ({ ...r, agents: r.agents.map((a) => a.name === 'house' ? { ...a, withdrawn: [1] } : a) }));
    const pendingFile = path.join(home.HOME, 'placements', `${target}.json`);
    const before = fs.readFileSync(pendingFile, 'utf8');
    assert.equal(placement.statuses()[0].state, 'waiting', 'readonly status explains the wait before root reconciliation');
    assert.match(placement.statuses()[0].error, /opponent/);
    assert.equal(fs.readFileSync(pendingFile, 'utf8'), before);
    assert.equal(placement.next(), null);
    assert.equal(placement.reserve(0, () => assert.fail('cannot play without an admitted opponent')), null);
    assert.equal(placement.statuses()[0].state, 'waiting');
    assert.deepEqual(placement.statuses()[0].opponents, []);
    const house2 = version('house', 2);
    assert.equal(placement.next().version, target);
    assert.deepEqual(placement.reserve(0, (job) => specOf(0, job)).bots, [target, house2]);
});

test('placement: an ordinary round keeps its number and files when placements are pending', () => {
    const target = add('alice');
    add('house', 1, { resident: true });
    enqueue(target);
    write(path.join(home.HOME, 'standings.json'), { rounds: [{ round: 5, status: 'running', bots: [] }] });
    assert.equal(placement.reserve(5, () => assert.fail('ordinary round is not replaced')), null);
    assert.equal(placement.getRound(5), null);
    write(path.join(home.RESULTS, 'arena-r6', 'ladder.json'), { config: { bots: ['older-v1', 'house-v1'] } });
    assert.equal(placement.reserve(6, () => assert.fail('ordinary ladder is not replaced')), null);
    assert.equal(placement.getRound(6), null);
    assert.equal(placement.next().version, target);
});

test('placement: interrupted enqueue leaves only an ignored temp file and retries atomically', () => {
    const target = add('alice');
    add('house', 1, { resident: true });
    const interrupted = spawnSync(process.execPath, ['-e', `
        const fs=require('fs');
        const link=fs.linkSync;
        fs.linkSync=(from,to)=>{ if(to.endsWith(${JSON.stringify(`${target}.json`)})) process.exit(73); return link(from,to); };
        require(${JSON.stringify(modulePath)}).enqueue({version:${JSON.stringify(target)},ref:${JSON.stringify(refOf(target))}});
    `], { env: process.env });
    assert.equal(interrupted.status, 73);
    assert.equal(fs.existsSync(path.join(home.HOME, 'placements', `${target}.json`)), false);
    assert.ok(fs.readdirSync(path.join(home.HOME, 'placements')).some((f) => f.startsWith('.tmp-')));
    assert.deepEqual(placement.statuses(), []);
    assert.equal(enqueue(target).state, 'queued');
    assert.equal(enqueue(target).version, target);
    assert.equal(queueFiles().length, 1);
});

test('placement: inherited OS lock stays with the parent and releases on parent close', () => {
    const file = path.join(tmp, 'flock-contract');
    const first = fs.openSync(file, 'a+');
    const second = fs.openSync(file, 'a+');
    const code = 'import fcntl, sys\ntry:\n fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError:\n sys.exit(75)\n';
    const claim = (fd) => spawnSync('python3', ['-I', '-c', code], {
        stdio: ['ignore', 'ignore', 'pipe', fd], env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }
    }).status;
    assert.equal(claim(first), 0);
    assert.equal(claim(second), 75, 'first helper exited but the parent still owns its open file description');
    fs.closeSync(first);
    assert.equal(claim(second), 0, 'closing the parent fd released its lock');
    fs.closeSync(second);
});

test('placement: persistent OS lock ignores old owner payloads and never changes inode', () => {
    const target = add('alice');
    add('house', 1, { resident: true });
    enqueue(target);
    const lock = path.join(home.HOME, 'placements', '.reserve.lock');
    fs.writeFileSync(lock, '');
    const inode = fs.statSync(lock).ino;
    const spec = placement.reserve(2, (job) => specOf(2, job));
    assert.equal(spec.placement.version, target);
    fs.writeFileSync(lock, 'partial or stale owner metadata');
    assert.equal(placement.update(2, { state: 'retrying' }).state, 'retrying');
    assert.equal(placement.update(2, { state: 'held' }).state, 'held');
    assert.equal(fs.statSync(lock).ino, inode, 'every contender locks the same persistent inode');
});

test('placement: restrictive root umask still leaves queue metadata readable by the plan process', () => {
    const target = add('alice');
    add('house', 1, { resident: true });
    const before = process.umask(0o077);
    try {
        enqueue(target);
        placement.reserve(0, (job) => specOf(0, job));
    } finally {
        process.umask(before);
    }
    assert.equal(fs.statSync(path.join(home.HOME, 'placements')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(home.HOME, 'placements', `${target}.json`)).mode & 0o777, 0o644);
});

test('placement: concurrent intake retries create one job and concurrent reservations share one round assignment', async () => {
    const first = add('alice');
    const second = add('bob');
    add('house', 1, { resident: true });
    const calls = await Promise.all(Array.from({ length: 12 }, (_, i) => {
        const v = i % 2 ? first : second;
        return child(`const p=require(${JSON.stringify(modulePath)}); process.stdout.write(JSON.stringify(p.enqueue({version:${JSON.stringify(v)},ref:${JSON.stringify(refOf(v))}})));`);
    }));
    assert.equal(queueFiles().length, 2);
    assert.equal(new Set(calls.map((r) => r.version)).size, 2);
    const wanted = placement.next().version;
    const crashed = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(modulePath)}).reserve(9,()=>process.exit(76));`], { env: process.env });
    assert.equal(crashed.status, 76, 'controller exits while it holds the OS lock and before its spec is ready');
    assert.equal(placement.getRound(9).version, wanted);
    assert.equal(fs.existsSync(path.join(home.HOME, 'placements', '.reserve.lock')), true);
    const reserved = await Promise.all(Array.from({ length: 4 }, () => child(`
        const p=require(${JSON.stringify(modulePath)});
        const s=p.reserve(9,j=>({round:9,bots:[j.version,...j.opponents],gamesPerPair:2,capMs:60000,decks:null,bundles:{},botInfo:{}}));
        process.stdout.write(JSON.stringify(s));
    `)));
    assert.ok(reserved.every((s) => s.placement.version === wanted));
    assert.equal(placement.statuses().filter((r) => r.round === 9).length, 1);
    placement.update(9, { state: 'done', finished: 4, rated: 4 });
    const another = placement.reserve(10, (job) => specOf(10, job));
    assert.notEqual(another.placement.version, wanted);
    assert.equal(new Set(placement.statuses().map((r) => r.round)).size, 2);
});
