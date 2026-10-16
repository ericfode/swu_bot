'use strict';
// bot/compiled/run.py runs on one CPU until the bot's first reply: wasmtime hands every WASI file call to a thread of its
// pool, which starts on the same CPU, so a bot that reads the card data at start is not slowed by hand-offs between
// CPUs. The first reply puts every thread back on all the CPUs. Needs Linux, wasmtime and at least 2 CPUs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RUN_PY = path.join(__dirname, '..', 'compiled', 'run.py');
const WASMTIME = spawnSync('python3', ['-I', '-c', 'import wasmtime'], { stdio: 'ignore' }).status === 0;
const cpusOf = (file) => /^Cpus_allowed_list:\s+(\S+)$/m.exec(fs.readFileSync(file, 'utf8'))?.[1];
const ALL = fs.existsSync('/proc/self/status') ? cpusOf('/proc/self/status') : undefined;
const skip = (!ALL && 'needs Linux /proc') || (!WASMTIME && 'needs wasmtime for Python') || (!/[-,]/.test(ALL) && 'needs at least 2 CPUs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-pin-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A WASI program that writes "started" on stderr, then (reply) reads one chunk of stdin and writes a line on stdout, the
// way a bot reads its first request before it answers, then waits for stdin to close
const program = (reply) => `(module
  (import "wasi_snapshot_preview1" "fd_write" (func $w (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read" (func $r (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 64) "started\\n")
  (data (i32.const 80) "{\\"t\\":\\"ready\\"}\\n")
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 64))
    (i32.store (i32.const 4) (i32.const 8))
    (drop (call $w (i32.const 2) (i32.const 0) (i32.const 1) (i32.const 8)))
    (i32.store (i32.const 16) (i32.const 256))
    (i32.store (i32.const 20) (i32.const 64))
    ${reply ? `(drop (call $r (i32.const 0) (i32.const 16) (i32.const 1) (i32.const 24)))
    (i32.store (i32.const 0) (i32.const 80))
    (i32.store (i32.const 4) (i32.const 14))
    (drop (call $w (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))` : ''}
    (block $done (loop $more
      (br_if $done (call $r (i32.const 0) (i32.const 16) (i32.const 1) (i32.const 24)))
      (br_if $done (i32.eqz (i32.load (i32.const 24))))
      (br $more)))))`;

function bundle(name, reply) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    const make = 'import sys, json, hashlib, wasmtime\nb = wasmtime.wat2wasm(sys.stdin.read())\nopen(sys.argv[1] + "/bot.wasm", "wb").write(b)\n'
        + 'json.dump({"schema": "swu-arena-bot/1", "name": sys.argv[2], "lang": "wat", "protocol": 2, "kind": "wasm", "platform": "wasm32-wasip1",'
        + ' "runtime": "wasi-p1", "run": {"cmd": "./bot.wasm", "args": [], "env": {}}, "entry_sha256": hashlib.sha256(b).hexdigest(),'
        + ' "resources": {"memory_mb": 64}, "cards": {"use": "none"}, "network": "none"}, open(sys.argv[1] + "/arena.json", "w"))';
    const r = spawnSync('python3', ['-c', make, dir, name], { input: program(reply), encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return dir;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** waits up to ms for check() to be true; returns its last value */
async function until(check, ms) {
    const end = Date.now() + ms;
    let ok = check();
    while (!ok && Date.now() < end) {
        await pause(20);
        ok = check();
    }
    return ok;
}

/** run.py on a bundle; resolves once the program wrote "started" */
async function start(dir, env = {}) {
    const p = spawn('python3', ['-I', RUN_PY, dir], { env: { PATH: process.env.PATH, SWU_WASM_CACHE: path.join(tmp, 'cache'), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
        out += d;
    });
    p.stderr.on('data', (d) => {
        err += d;
    });
    await until(() => err.includes('started') || p.exitCode !== null, 20000);
    assert.ok(err.includes('started'), `the program started: ${err}`);
    return { p, out: () => out };
}

/** the CPUs of a process's main thread, and of each of its threads */
const mainCpus = (pid) => cpusOf(`/proc/${pid}/task/${pid}/status`);
const threadCpus = (pid) => fs.readdirSync(`/proc/${pid}/task`).flatMap((tid) => {
    try {
        return [cpusOf(`/proc/${pid}/task/${tid}/status`)];
    } catch {
        return []; // a thread that just ended
    }
});
const one = (cpus) => /^\d+$/.test(cpus);

async function stop(p) {
    p.stdin.end();
    await new Promise((r) => (p.exitCode !== null ? r() : p.on('exit', r)));
}

test('run.py: on one CPU until the first reply, then every thread back on all of them', { skip }, async () => {
    const silent = await start(bundle('silent', false));
    try {
        assert.ok(one(mainCpus(silent.p.pid)), 'the main thread runs on one CPU before any reply');
    } finally {
        await stop(silent.p);
    }

    const replier = await start(bundle('replier', true));
    try {
        // its read of the first request starts a thread of wasmtime's, on the same one CPU
        assert.ok(await until(() => threadCpus(replier.p.pid).filter(one).length >= 2, 5000), `a second thread on one CPU: ${threadCpus(replier.p.pid)}`);
        replier.p.stdin.write('{"t":"hello"}\n');
        await until(() => replier.out().includes('\n') || replier.p.exitCode !== null, 20000);
        assert.match(replier.out(), /"ready"/);
        await until(() => threadCpus(replier.p.pid).every((c) => c === ALL), 5000);
        assert.deepStrictEqual([...new Set(threadCpus(replier.p.pid))], [ALL], 'every thread is back on all the CPUs after the first reply');
    } finally {
        await stop(replier.p);
    }
});

test('run.py: SWU_WASM_PIN=off leaves it on all its CPUs', { skip }, async () => {
    const silent = await start(bundle('silent-off', false), { SWU_WASM_PIN: 'off' });
    try {
        assert.deepStrictEqual([...new Set(threadCpus(silent.p.pid))], [ALL]);
    } finally {
        await stop(silent.p);
    }
});
