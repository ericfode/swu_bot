'use strict';
// The intake as the games machine runs it: root admits a submission, the checker packs and start-checks it as the
// bots' user in its own namespaces (isolate.sh --user, the arena's folders hidden), and root enters what the check
// left. Needs root, unshare, a user named arena, wasmtime and a built bundle; skipped elsewhere (CI runs as another
// user). The arena lives under /var/tmp, since the checker gets a /tmp of its own.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BOT = path.join(__dirname, '..', '..', 'build', 'compiled', 'node-random');
const skip = (() => {
    if (process.getuid?.() !== 0) {
        return 'needs root (isolate.sh)';
    }
    if (spawnSync('id', ['-u', 'arena'], { stdio: 'ignore' }).status !== 0) {
        return 'needs a user named arena';
    }
    if (spawnSync('unshare', ['--pid', '--fork', '--mount', '--mount-proc', 'true'], { stdio: 'ignore' }).status !== 0) {
        return 'needs unshare';
    }
    if (spawnSync('python3', ['-I', '-c', 'import wasmtime'], { stdio: 'ignore' }).status !== 0) {
        return 'needs wasmtime';
    }
    return !fs.existsSync(path.join(BOT, 'bot.wasm')) && 'needs build/compiled/node-random (python3 bot/compiled/build.py)';
})();

/** Runs checkIsolated for each job in a fresh node process with the games machine's settings; returns the results. */
function intake(base, jobs) {
    // every command the intake starts, on stderr, so the test sees how each check ran (intake.js takes spawn at load)
    const script = `const cp = require('child_process'); const spawn = cp.spawn;
cp.spawn = (cmd, args, o) => { console.error('SPAWN ' + JSON.stringify([cmd, ...args])); return spawn(cmd, args, o); };
const intake = require(${JSON.stringify(path.join(__dirname, '..', 'arena', 'intake.js'))});
(async () => { for (const job of JSON.parse(require('fs').readFileSync(0, 'utf8'))) console.log(JSON.stringify(await intake.checkIsolated(job))); })()
    .catch((e) => { console.error(e); process.exit(1); });`;
    const dirs = { ARENA_HOME: 'arena', ARENA_RESULTS: 'results', ARENA_DASH: 'dash', ARENA_INTAKE_WORK: 'work', HOME: 'root-home' };
    const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', ARENA_USER: 'arena', ...Object.fromEntries(Object.entries(dirs).map(([k, d]) => [k, path.join(base, d)])) };
    env.ARENA_HIDE = [env.ARENA_HOME, env.ARENA_DASH, env.ARENA_RESULTS, env.HOME].join(':');
    const r = spawnSync(process.execPath, ['-e', script], { env, input: JSON.stringify(jobs), encoding: 'utf8', timeout: 5 * 60000 });
    assert.strictEqual(r.status, 0, r.error?.message ?? r.stderr);
    const spawned = r.stderr.split('\n').filter((l) => l.startsWith('SPAWN ')).map((l) => JSON.parse(l.slice(6)));
    return { results: r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)), spawned };
}

/** Every path under dir whose owner is not root. */
function notRoots(dir) {
    const out = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const f = path.join(d, e.name);
            if (fs.lstatSync(f).uid !== 0) {
                out.push(path.relative(dir, f));
            }
            if (e.isDirectory()) {
                walk(f);
            }
        }
    };
    walk(dir);
    return out;
}

test('intake, isolated as on the games machine: the bots\' user checks a submission and root enters it; arena/ stays root\'s alone', { skip }, () => {
    const base = fs.mkdtempSync('/var/tmp/intake-isolated-');
    try {
        fs.chmodSync(base, 0o755);
        for (const d of ['arena', 'results', 'dash', 'root-home']) {
            fs.mkdirSync(path.join(base, d));
        }
        const wasm = fs.readFileSync(path.join(BOT, 'bot.wasm'));
        const files = { 'arena.json': fs.readFileSync(path.join(BOT, 'arena.json'), 'utf8'), 'bot.wasm': wasm.toString('base64') };
        const job = { id: 'kim-b.1', owner: 'kim-b', name: 'kim_b', kind: 'wasm', note: 'first', files, base64: ['bot.wasm'] };
        // a manifest that holds and a program that does not start: the start check, run by the checker, refuses it
        const junk = Buffer.from('\0asm\x01\0\0\0junk');
        const manifest = { ...JSON.parse(files['arena.json']), entry_sha256: require('crypto').createHash('sha256').update(junk).digest('hex') };
        const bad = { ...job, id: 'lee.1', owner: 'lee', name: 'lee', files: { 'arena.json': JSON.stringify(manifest), 'bot.wasm': junk.toString('base64') } };

        const { results: [first, again, refused], spawned } = intake(base, [job, job, bad]);
        // two checks (the same submission again is not checked), each in isolate.sh as the bots' user
        assert.strictEqual(spawned.length, 2, JSON.stringify(spawned));
        for (const argv of spawned) {
            assert.ok(argv[1].endsWith('isolate.sh') && argv.some((a, i) => a === '--user' && argv[i + 1] === 'arena'), JSON.stringify(argv));
        }
        assert.deepStrictEqual(first, { ok: true, name: 'kim_b', version: 'kim_b-v1', benched: false });
        assert.deepStrictEqual(again, first, 'the same submission again is the version it became');
        assert.strictEqual(refused.ok, false);
        assert.match(refused.error, /lee-v1 failed the start check/);

        const versions = path.join(base, 'arena', 'versions');
        assert.ok(wasm.equals(fs.readFileSync(path.join(versions, 'kim_b-v1', 'bundle', 'bot.wasm'))), 'the bundle as submitted');
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(versions, 'kim_b-v1', 'SUBMISSION.json'), 'utf8')).ref, 'window:kim-b.1');
        assert.deepStrictEqual(fs.readdirSync(versions).filter((v) => v.startsWith('lee')), [], 'nothing of the refused one');
        const roster = JSON.parse(fs.readFileSync(path.join(base, 'arena', 'roster.json'), 'utf8'));
        assert.deepStrictEqual(roster.agents.map((a) => [a.name, a.owner]), [['kim_b', 'github:kim-b']]);
        assert.deepStrictEqual(notRoots(path.join(base, 'arena')), [], 'nothing in arena/ is the bots\' user\'s');
        assert.deepStrictEqual(notRoots(path.join(base, 'dash')), []);
        assert.deepStrictEqual(fs.readdirSync(path.join(base, 'work')).filter((f) => f.startsWith('job-')), [], 'the job folders are gone');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});
