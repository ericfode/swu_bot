'use strict';
// bot/arena/ops/kill-user.py: what a games helper runs as root after each play of a slot. It kills every process of
// the slot's user, also ones that keep forking or try to stop it, and nothing of anyone else. Needs root and the users
// arena15 and arena16 (the images make arena1 to arena16); as root it kills every process of arena16 in this machine.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
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

/** the live processes (not zombies) of a uid */
function liveOf(uid) {
    const pids = [];
    for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) {
            continue;
        }
        let text;
        try {
            text = fs.readFileSync(`/proc/${name}/status`, 'utf8');
        } catch {
            continue;
        }
        const uids = /^Uid:\s+(.*)$/m.exec(text)?.[1].split(/\s+/).map(Number) ?? [];
        const state = /^State:\s+(\S)/m.exec(text)?.[1];
        if (uids.includes(uid) && state !== 'Z' && state !== 'X') {
            pids.push(Number(name));
        }
    }
    return pids;
}

const asUser = (uid, code) => spawn('setpriv', [`--reuid=${uid}`, `--regid=${uid}`, '--clear-groups', '--', 'python3', '-I', '-c', code], { stdio: 'ignore', detached: true });

// what a bot that got out of its sandbox could leave: one that keeps forking, and one that tries to stop every other
// process it finds (the killer among them)
const FORKER = `
import os, time
# spawned detached: already in a session of its own, outside any play's group
for _ in range(300):
    if os.fork() == 0:
        time.sleep(120)
        os._exit(0)
    time.sleep(0.005)
time.sleep(120)
`;
const STOPPER = `
import os, signal, time
# spawned detached: already in a session of its own, outside any play's group
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

test('kill-user.py: every process of the user goes, forking or fighting back; another user\'s stays', { skip: !ready && 'needs root and the users arena15 and arena16' }, async () => {
    const bystander = asUser(OTHER, 'import time; time.sleep(120)');
    try {
        asUser(SLOT, FORKER);
        const end = Date.now() + 10000;
        while (liveOf(SLOT).length < 20 && Date.now() < end) {
            await new Promise((r) => setTimeout(r, 20));
        }
        assert.ok(liveOf(SLOT).length >= 20, 'the forker has children');
        // started once the forker forks: it stops the forker too
        asUser(SLOT, STOPPER);
        await new Promise((r) => setTimeout(r, 200));
        const r = spawnSync('python3', ['-I', KILL_USER, String(SLOT)], { encoding: 'utf8', timeout: 30000 });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.deepStrictEqual(liveOf(SLOT), [], 'nothing of the user runs');
        assert.ok(liveOf(OTHER).includes(bystander.pid), 'another user\'s process runs on');
    } finally {
        bystander.kill('SIGKILL');
        spawnSync('python3', ['-I', KILL_USER, String(SLOT)], { timeout: 30000 });
    }
});

test('kill-user.py: refuses uid 0, a missing uid, and running as anyone but root', { skip: !ROOT && 'needs root' }, () => {
    for (const args of [['0'], [], ['x'], ['1', '2']]) {
        assert.strictEqual(spawnSync('python3', ['-I', KILL_USER, ...args]).status, 2, args.join(' '));
    }
    if (SLOT !== null) {
        const r = spawnSync('setpriv', [`--reuid=${SLOT}`, `--regid=${SLOT}`, '--clear-groups', '--', 'python3', '-I', KILL_USER, String(SLOT)], { encoding: 'utf8' });
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /must run as root/);
    }
});
