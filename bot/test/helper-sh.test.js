'use strict';
// helper.sh (bot/arena/ops) against stand-ins for docker, fly and the rest: what it builds and runs, and the lines the
// live view (helper-tui.js) reads from it. Nothing here touches Docker, Fly or the real ~/.config.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tui = require('../arena/ops/helper-tui');

const REPO = path.join(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'bot', 'arena', 'ops', 'helper.sh');
const SHA = 'b'.repeat(40);
const IMAGE = `registry.fly.io/swu-arena-games:${SHA}`;

// Each stand-in logs its argv as one JSON line and answers what helper.sh reads. `fly proxy` waits like the real one,
// until helper.sh stops it.
const stub = (body) => `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify([require('path').basename(process.argv[1]), ...args]) + '\\n');
${body}`;

const STUBS = {
    docker: stub(`
const [a, b] = args;
if (a === 'info') { if (b === '--format') console.log(args[2].includes('NCPU') ? 8 : 17179869184); process.exit(0); }
if (a === 'image' && b === 'inspect') process.exit(process.env.STUB_BUILT ? 0 : 1);
if (a === 'image' && b === 'ls') { console.log(['swu-helper:' + 'a'.repeat(40), 'swu-helper-coord:' + 'a'.repeat(40), 'swu-helper:' + process.env.STUB_SHA, 'python:3.12-slim-bookworm'].join('\\n')); process.exit(0); }
if (a === 'build') { console.log('#1 [internal] load build definition from Dockerfile.helper'); process.exit(0); }
if (a === 'container' && b === 'inspect') process.exit(1);
if (a === 'run') process.exit(Number(process.env.STUB_RUN_EXIT || 0));
process.exit(0);
`),
    fly: stub(`
const [a, b] = args;
if (a === 'machine' && b === 'list') console.log(JSON.stringify([{ config: { image: process.env.STUB_IMAGE } }]));
if (a === 'proxy') setTimeout(() => {}, 60000);
`),
    // only what helper.sh asks of jq: -r '.[0].config.image'
    jq: stub(`process.stdout.write(JSON.parse(fs.readFileSync(0, 'utf8'))[0].config.image + '\\n');`),
    // no logind here: helper.sh then runs docker directly
    'systemd-inhibit': stub('process.exit(1);'),
    caffeinate: stub(`process.exit(require('child_process').spawnSync(args[1], args.slice(2), { stdio: 'inherit' }).status ?? 1);`),
};

function setup(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-sh-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    for (const [name, text] of Object.entries(STUBS)) {
        fs.writeFileSync(path.join(bin, name), text, { mode: 0o755 });
    }
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.config', 'swu-helper'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'swu-helper', 'env'), `GAMES_HELPER_TOKEN=${'0'.repeat(64)}\n`, { mode: 0o600 });
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(tmp);
    return { root, bin, home, tmp, log: path.join(root, 'calls.jsonl') };
}

/** Runs helper.sh with the stand-ins first on PATH; resolves {code, out, err, calls}. */
function run(t, s, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn('sh', [SCRIPT, ...args], {
            cwd: s.root,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home, TMPDIR: s.tmp, SWU_REPO: REPO, SWU_HELPER_PLAIN: '1',
                STUB_LOG: s.log, STUB_SHA: SHA, STUB_IMAGE: IMAGE, ...env,
            },
        });
        // whatever helper.sh left behind (its port forward) goes with its process group
        t.after(() => {
            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch {
                // gone already
            }
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        const timer = setTimeout(() => reject(new Error(`helper.sh did not end: ${out}${err}`)), 30000);
        child.on('error', reject);
        child.on('close', (code) => {
            clearTimeout(timer);
            const calls = fs.existsSync(s.log) ? fs.readFileSync(s.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
            resolve({ code, out, err, calls });
        });
    });
}

const of = (calls, ...head) => calls.filter((c) => head.every((h, i) => c[i] === h));

test('native: builds the helper image from the machine image alone and runs its own command', async (t) => {
    const s = setup(t);
    const r = await run(t, s, ['--slots', '2'], { SWU_HELPER_NATIVE: '1', STUB_RUN_EXIT: '0' });
    assert.strictEqual(r.code, 0, r.err);

    const builds = of(r.calls, 'docker', 'build');
    assert.strictEqual(builds.length, 1, 'one build: no coordinator stage any more');
    const b = builds[0];
    assert.strictEqual(b[b.indexOf('-f') + 1], path.join(REPO, 'bot', 'arena', 'ops', 'Dockerfile.helper'));
    assert.ok(b.includes(`MACHINE_IMAGE=${IMAGE}`));
    assert.strictEqual(b[b.indexOf('-t') + 1], `swu-helper:${SHA}`);
    assert.ok(!b.some((a) => /COORD_IMAGE|--target/.test(a)));
    // the context is an empty folder of its own, removed after the build
    const ctx = b.at(-1);
    assert.ok(ctx.startsWith(s.tmp) && !fs.existsSync(ctx), ctx);
    assert.strictEqual(of(r.calls, 'docker', 'pull').length, 1);
    // older helper images go, the new one stays
    assert.deepStrictEqual(of(r.calls, 'docker', 'image', 'rm').map((c) => c[3]).sort(), [`swu-helper-coord:${'a'.repeat(40)}`, `swu-helper:${'a'.repeat(40)}`]);

    const runs = of(r.calls, 'docker', 'run');
    assert.strictEqual(runs.length, 1);
    const d = runs[0];
    assert.strictEqual(d.at(-1), `swu-helper:${SHA}`, 'no command after the image: its CMD starts the server');
    assert.ok(d.includes('COORD_ROLE=helper') && d.includes('GAMES_HELPER_SLOTS=2'));
    assert.ok(d.includes('swu-helper-data:/data') && d.includes('no-new-privileges'));
    assert.ok(!d.some((a) => /RELEASE_TMP|coord\/bin/.test(a)));
    assert.ok(!d.includes('--platform'), 'a native image runs as built');

    // what the live view makes of the lines
    const kinds = r.out.trim().split('\n').map((l) => tui.parseLine(l).kind);
    assert.deepStrictEqual(kinds.filter((k) => k !== 'log'), ['pulling', 'buildlog', 'built', 'starting']);
    assert.match(r.out, /^built swu-helper:b{40}$/m);
});

test('native: a helper image built before is used as it is', async (t) => {
    const s = setup(t);
    const r = await run(t, s, ['--slots', '1'], { SWU_HELPER_NATIVE: '1', STUB_BUILT: '1' });
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(of(r.calls, 'docker', 'build').length, 0);
    assert.strictEqual(of(r.calls, 'docker', 'pull').length, 0);
    assert.match(r.out, /^using swu-helper:b{40} \(built before\)$/m);
    assert.strictEqual(of(r.calls, 'docker', 'run')[0].at(-1), `swu-helper:${SHA}`);
});

test('pulled: exit 3 reads the machine image again, and the same image stops the script', async (t) => {
    const s = setup(t);
    const r = await run(t, s, ['--slots', '3'], { SWU_HELPER_NATIVE: '0', STUB_RUN_EXIT: '3' });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /^the games machine runs another build: reading its image$/m);
    assert.match(r.err, /helper\.sh: the games machine still runs registry\.fly\.io\/swu-arena-games:b{40}, which this helper just ran/);
    const runs = of(r.calls, 'docker', 'run');
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].at(-1), IMAGE);
    assert.strictEqual(runs[0][runs[0].indexOf('--platform') + 1], 'linux/amd64');
    assert.strictEqual(of(r.calls, 'docker', 'build').length, 0);
    assert.strictEqual(of(r.calls, 'fly', 'machine', 'list').length, 2);
});

test('any other exit code of the helper ends the script with it', async (t) => {
    const s = setup(t);
    const r = await run(t, s, ['--slots', '1'], { SWU_HELPER_NATIVE: '0', STUB_RUN_EXIT: '1' });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(of(r.calls, 'docker', 'run').length, 1);
});
