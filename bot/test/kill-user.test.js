'use strict';
// bot/arena/ops/kill-user.py: what a games helper runs as root after each play of a slot. It kills every process of
// the slot's user, also ones that keep forking, hop from pid to pid, try to stop it, or run on in a thread after their
// main thread exited, and nothing of anyone else; two at once (two slots ending together) both finish. Needs root and
// the users arena15 and arena16 (the images make arena1 to arena16); as root it kills every process of both in this
// machine.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const KILL_USER = path.join(__dirname, '..', 'arena', 'ops', 'kill-user.py');
const idOf = (user) => {
    const r = spawnSync('id', ['-u', user], { encoding: 'utf8' });
    return r.status === 0 ? Number(r.stdout.trim()) : null;
};
const ROOT = process.getuid?.() === 0;
const [SLOT, OTHER] = [idOf('arena16'), idOf('arena15')];
const ready = ROOT && SLOT !== null && OTHER !== null;
// the exit system call (one thread), for a process whose main thread ends while another runs on
const SYS_EXIT = { x64: 60, arm64: 93 }[os.arch()];

/** the threads of a uid that are alive (not zombies), in every process */
function liveOf(uid) {
    const tids = [];
    for (const pid of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) {
            continue;
        }
        let tasks;
        try {
            tasks = fs.readdirSync(`/proc/${pid}/task`);
        } catch {
            continue;
        }
        for (const tid of tasks) {
            let text;
            try {
                text = fs.readFileSync(`/proc/${pid}/task/${tid}/status`, 'utf8');
            } catch {
                continue;
            }
            const uids = /^Uid:\s+(.*)$/m.exec(text)?.[1].split(/\s+/).map(Number) ?? [];
            const state = /^State:\s+(\S)/m.exec(text)?.[1];
            if (uids.includes(uid) && state !== 'Z' && state !== 'X') {
                tids.push(Number(tid));
            }
        }
    }
    return tids;
}

// unref: a process the killer missed (one left stopped, say) fails the test without holding the test run open
const asUser = (uid, code) => {
    const p = spawn('setpriv', [`--reuid=${uid}`, `--regid=${uid}`, '--clear-groups', '--', 'python3', '-I', '-c', code], { stdio: 'ignore', detached: true });
    p.unref();
    return p;
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// what a bot that got out of its sandbox could leave (each spawned detached: in a session of its own, outside any
// play's group): one that keeps forking, one that forks and exits so its pid keeps changing, one that tries to stop
// every other process it finds (the killer among them), and one whose main thread exits while a thread runs on
const FORKER = `
import os, time
for _ in range(300):
    if os.fork() == 0:
        time.sleep(120)
        os._exit(0)
    time.sleep(0.005)
time.sleep(120)
`;
const HOPPER = `
import os, time
end = time.monotonic() + 120
while time.monotonic() < end:
    if os.fork() != 0:
        os._exit(0)
`;
const STOPPER = `
import os, signal, time
me = os.getpid()
end = time.monotonic() + 120
while time.monotonic() < end:
    for n in os.listdir('/proc'):
        if n.isdigit() and int(n) != me:
            try:
                os.kill(int(n), signal.SIGSTOP)
            except OSError:
                pass
    time.sleep(0.001)
`;
const THREAD = `
import ctypes, threading, time
threading.Thread(target=lambda: time.sleep(120)).start()
time.sleep(0.2)
ctypes.CDLL(None).syscall(${SYS_EXIT}, 0)
`;

test('kill-user.py: every process of the user goes, however it hides or fights back; another user\'s stays', { skip: !ready && 'needs root and the users arena15 and arena16' }, async () => {
    const bystander = asUser(OTHER, 'import time; time.sleep(120)');
    try {
        asUser(SLOT, FORKER);
        const end = Date.now() + 10000;
        while (liveOf(SLOT).length < 20 && Date.now() < end) {
            await pause(20);
        }
        assert.ok(liveOf(SLOT).length >= 20, 'the forker has children');
        asUser(SLOT, HOPPER);
        if (SYS_EXIT) {
            asUser(SLOT, THREAD);
        }
        await pause(500);
        // started last: it stops the others too
        asUser(SLOT, STOPPER);
        await pause(200);
        for (let i = 0; i < 5; i++) {
            const r = spawnSync('python3', ['-I', KILL_USER, String(SLOT)], { encoding: 'utf8', timeout: 30000 });
            assert.strictEqual(r.status, 0, r.stderr);
            assert.deepStrictEqual(liveOf(SLOT), [], 'no thread of the user runs');
            if (i < 4) {
                // and again, each time with the tricks running
                asUser(SLOT, HOPPER);
                if (SYS_EXIT) {
                    asUser(SLOT, THREAD);
                }
                asUser(SLOT, STOPPER);
                await pause(300);
            }
        }
        assert.ok(liveOf(OTHER).length > 0 && !bystander.exitCode && !bystander.signalCode, 'another user\'s process runs on');
    } finally {
        bystander.kill('SIGKILL');
        spawnSync('python3', ['-I', KILL_USER, String(SLOT)], { timeout: 30000 });
    }
});

test('kill-user.py: two at once, for two slots whose plays ended together, both finish with their users gone', { skip: !ready && 'needs root and the users arena15 and arena16' }, async () => {
    // every killer kills as real uid nobody, so two that overlapped would kill each other: they take turns
    const run = (uid) => new Promise((resolve) => {
        const p = spawn('python3', ['-I', KILL_USER, String(uid)], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => {
            err += d;
        });
        p.on('close', (code) => resolve({ code, err }));
    });
    try {
        for (let i = 0; i < 100; i++) {
            asUser(SLOT, 'import time; time.sleep(120)');
            asUser(OTHER, 'import time; time.sleep(120)');
            const end = Date.now() + 5000;
            while ((!liveOf(SLOT).length || !liveOf(OTHER).length) && Date.now() < end) {
                await pause(10);
            }
            for (const r of await Promise.all([run(SLOT), run(OTHER)])) {
                assert.strictEqual(r.code, 0, r.err);
            }
            assert.deepStrictEqual([...liveOf(SLOT), ...liveOf(OTHER)], [], `round ${i}`);
        }
    } finally {
        spawnSync('python3', ['-I', KILL_USER, String(SLOT)], { timeout: 30000 });
        spawnSync('python3', ['-I', KILL_USER, String(OTHER)], { timeout: 30000 });
    }
});

test('kill-user.py: the thread trick hides a process from a check of the main thread alone', { skip: !(ready && SYS_EXIT) && 'needs root, arena16 and x64 or arm64' }, async () => {
    // what the test above guards against: the process's own status says zombie while a thread runs
    const p = asUser(SLOT, THREAD);
    try {
        let tids = [];
        const end = Date.now() + 5000;
        while (Date.now() < end) {
            tids = fs.existsSync(`/proc/${p.pid}/task`) ? fs.readdirSync(`/proc/${p.pid}/task`) : [];
            if (tids.length && /^State:\s+Z/m.test(fs.readFileSync(`/proc/${p.pid}/status`, 'utf8'))) {
                break;
            }
            await pause(20);
        }
        assert.match(fs.readFileSync(`/proc/${p.pid}/status`, 'utf8'), /^State:\s+Z/m, 'the main thread is a zombie');
        assert.ok(liveOf(SLOT).length >= 1, 'a thread of it runs');
    } finally {
        spawnSync('python3', ['-I', KILL_USER, String(SLOT)], { timeout: 30000 });
    }
    assert.deepStrictEqual(liveOf(SLOT), []);
});

test('kill-user.py: refuses uid 0, nobody, a missing uid, running as anyone but root, and a lock folder others reach', { skip: !ROOT && 'needs root' }, () => {
    for (const args of [['0'], ['65534'], [], ['x'], ['1', '2']]) {
        assert.strictEqual(spawnSync('python3', ['-I', KILL_USER, ...args]).status, 2, args.join(' '));
    }
    if (SLOT !== null) {
        const r = spawnSync('setpriv', [`--reuid=${SLOT}`, `--regid=${SLOT}`, '--clear-groups', '--', 'python3', '-I', KILL_USER, String(SLOT)], { encoding: 'utf8' });
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /must run as root/);
        // a lock another user could hold would let it stop every kill
        const LOCK_DIR = '/run/swu-kill-user';
        assert.strictEqual(spawnSync('python3', ['-I', KILL_USER, String(SLOT)]).status, 0);
        fs.chmodSync(LOCK_DIR, 0o777);
        try {
            const open = spawnSync('python3', ['-I', KILL_USER, String(SLOT)], { encoding: 'utf8' });
            assert.strictEqual(open.status, 2);
            assert.match(open.stderr, /not a folder only root reaches/);
        } finally {
            fs.chmodSync(LOCK_DIR, 0o700);
        }
    }
});
