'use strict';
// bot/compiled/run.py runs on one CPU until the bot's first reply: wasmtime hands every WASI file call to a thread of its
// pool, which starts on the same CPU, so a bot that reads the card data at start is not slowed by hand-offs between
// CPUs. The first reply puts every thread back on all the CPUs. Needs wasmtime and at least 2 CPUs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RUN_PY = path.join(__dirname, '..', 'compiled', 'run.py');
const WASMTIME = spawnSync('python3', ['-I', '-c', 'import wasmtime'], { stdio: 'ignore' }).status === 0;
const cpusOf = (file) => /^Cpus_allowed_list:\s+(\S+)$/m.exec(fs.readFileSync(file, 'utf8'))?.[1];
const ALL = cpusOf('/proc/self/status');
const skip = (!WASMTIME && 'needs wasmtime for Python') || (!/[-,]/.test(ALL ?? '') && 'needs at least 2 CPUs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-pin-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A WASI program that writes "started" on stderr, then (reply) a line on stdout, then waits for stdin to close
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
    ${reply ? `(i32.store (i32.const 0) (i32.const 80))
    (i32.store (i32.const 4) (i32.const 14))
    (drop (call $w (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))` : ''}
    (i32.store (i32.const 16) (i32.const 256))
    (i32.store (i32.const 20) (i32.const 64))
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

/** run.py on a bundle; resolves once the program wrote "started" (and, with a reply, its first stdout line). */
async function start(dir, env = {}, reply = false) {
    const p = spawn('python3', ['-I', RUN_PY, dir], { env: { PATH: process.env.PATH, SWU_WASM_CACHE: path.join(tmp, 'cache'), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
        out += d;
    });
    p.stderr.on('data', (d) => {
        err += d;
    });
    const end = Date.now() + 20000;
    while (!(err.includes('started') && (!reply || out.includes('\n'))) && Date.now() < end && p.exitCode === null) {
        await pause(20);
    }
    assert.ok(err.includes('started'), `the program started: ${err}`);
    return { p, out: () => out };
}

/** each thread of a process: its CPUs */
const threadCpus = (pid) => fs.readdirSync(`/proc/${pid}/task`).map((tid) => cpusOf(`/proc/${pid}/task/${tid}/status`));

async function stop(p) {
    p.stdin.end();
    await new Promise((r) => (p.exitCode !== null ? r() : p.on('exit', r)));
}

test('run.py: on one CPU until the first reply, then every thread back on all of them', { skip }, async () => {
    const silent = await start(bundle('silent', false));
    try {
        assert.deepStrictEqual(threadCpus(silent.p.pid).slice(0, 1).map((c) => /^\d+$/.test(c)), [true], 'the main thread runs on one CPU before any reply');
    } finally {
        await stop(silent.p);
    }

    const replier = await start(bundle('replier', true), {}, true);
    try {
        assert.match(replier.out(), /"ready"/);
        let cpus = [];
        const end = Date.now() + 5000;
        do {
            cpus = threadCpus(replier.p.pid);
            if (cpus.every((c) => c === ALL)) {
                break;
            }
            await pause(20);
        } while (Date.now() < end);
        assert.deepStrictEqual([...new Set(cpus)], [ALL], 'every thread is back on all the CPUs after the first reply');
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
