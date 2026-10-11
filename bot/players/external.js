'use strict';

/**
 * External bot: any program (Rust, Python, ...) that speaks the stdio JSON Lines protocol in spec/stdio-protocol.md.
 *
 * It implements the same in-process interface as the other bots ({name, choose({game, pid, actions, rng}) -> action}),
 * so match.js / tournament.js drive it unchanged. choose() is synchronous, so the child process is talked to from a
 * worker thread and the main thread blocks on Atomics.wait until the answer line arrives.
 *
 *   new ExternalBot('rust-greedy', { cmd: 'target/release/swu-bot', args: ['--greedy'] })
 */

const path = require('path');
const { Worker } = require('worker_threads');
const { observe, promptView, actionView, seatOf } = require('../observe');

const PROTOCOL = 'swu-bot-stdio';
const VERSION = 1;
const REPLY_BYTES = 1 << 20;

// Runs in the worker: owns the child process, forwards one request line and hands back the next stdout line.
const WORKER_SRC = `
const { workerData, parentPort } = require('worker_threads');
const { spawn } = require('child_process');
const { cmd, args, cwd, env, stderr, sab } = workerData;
const ctl = new Int32Array(sab, 0, 2);
const buf = new Uint8Array(sab, 8);
const lines = [];
let pending = '';
let waiting = false;
let dead = null;
function deliver(text) {
    let bytes = Buffer.from(text, 'utf8');
    if (bytes.length > buf.length) {
        bytes = Buffer.from(JSON.stringify({ t: '__error', error: 'reply line longer than ' + buf.length + ' bytes' }));
    }
    buf.set(bytes);
    Atomics.store(ctl, 1, bytes.length);
    Atomics.store(ctl, 0, 1);
    Atomics.notify(ctl, 0);
}
function flush() {
    if (!waiting) return;
    if (lines.length) { waiting = false; deliver(lines.shift()); }
    else if (dead) { waiting = false; deliver(JSON.stringify({ t: '__error', error: dead })); }
}
const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', stderr] });
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
    pending += d;
    let k;
    while ((k = pending.indexOf('\\n')) >= 0) {
        const line = pending.slice(0, k).trim();
        pending = pending.slice(k + 1);
        if (line) lines.push(line);
    }
    flush();
});
child.on('error', (e) => { dead = 'could not start ' + cmd + ': ' + e.message; flush(); });
child.on('exit', (code, signal) => { dead = dead ?? ('bot process exited (code ' + code + (signal ? ', ' + signal : '') + ')'); flush(); });
child.stdin.on('error', () => undefined);
parentPort.on('message', (m) => {
    if (m.close) {
        // the open port keeps this thread alive, so close it once the child is gone
        child.stdin.end();
        if (dead) { parentPort.close(); return; }
        child.once('exit', () => parentPort.close());
        setTimeout(() => child.kill(), 2000).unref();
        return;
    }
    waiting = true;
    if (!dead) child.stdin.write(m.line + '\\n');
    flush();
});
`;

const live = new Set();

class ExternalBot {
    /**
     * opts: cmd, args = [], cwd = repo root, env = {}, timeoutMs = 10000 per decision, startTimeoutMs = 30000 for the hello,
     * stderr = 'inherit' | 'ignore'.
     */
    constructor(name, { cmd, args = [], cwd = path.join(__dirname, '..', '..'), env = {}, timeoutMs = 10000, startTimeoutMs = 30000, stderr = 'inherit' } = {}) {
        if (!cmd) {
            throw new Error(`external bot ${name}: no cmd`);
        }
        this.name = name;
        this.opts = { cmd, args, cwd, env, stderr };
        this.timeoutMs = timeoutMs;
        this.startTimeoutMs = startTimeoutMs;
        this.worker = null;
        this.game = null;
        this.seq = 0;
        // not named stats: tournament.js prints bot.stats in the heuristic bot's shape
        this.timing = { decisions: 0, ms: 0 };
    }

    start() {
        const sab = new SharedArrayBuffer(8 + REPLY_BYTES);
        this.ctl = new Int32Array(sab, 0, 2);
        this.buf = new Uint8Array(sab, 8);
        this.worker = new Worker(WORKER_SRC, { eval: true, workerData: { ...this.opts, sab } });
        this.worker.unref();
        live.add(this);
    }

    /** End the bot process (it sees EOF on stdin). */
    close() {
        if (this.worker) {
            this.worker.postMessage({ close: true });
            this.worker = null;
        }
        live.delete(this);
    }

    /** Send one message and block until the bot's reply line. */
    call(msg, timeoutMs) {
        if (!this.worker) {
            throw new Error(`external bot ${this.name}: process was closed after an earlier error`);
        }
        Atomics.store(this.ctl, 0, 0);
        this.worker.postMessage({ line: JSON.stringify(msg) });
        // after a timeout or a dead process the stream can't be trusted (a late line would answer the next request), so drop it; the next game starts a new process
        if (Atomics.wait(this.ctl, 0, 0, timeoutMs) === 'timed-out') {
            this.close();
            throw new Error(`external bot ${this.name}: no reply to '${msg.t}' within ${timeoutMs}ms`);
        }
        const text = Buffer.from(this.buf.subarray(0, Atomics.load(this.ctl, 1))).toString('utf8');
        let reply;
        try {
            reply = JSON.parse(text);
        } catch {
            this.close();
            throw new Error(`external bot ${this.name}: reply is not JSON: ${text.slice(0, 120)}`);
        }
        if (reply.t === '__error' || reply.t === 'error') {
            this.close();
            throw new Error(`external bot ${this.name}: ${reply.error ?? 'error'}`);
        }
        return reply;
    }

    /** First decision of a game: start the process if needed and send hello. */
    beginGame(eg, pid, rng) {
        // bots of finished games are never called again, so their processes can go
        for (const b of live) {
            if (b !== this && b.game?.over) {
                b.close();
            }
        }
        if (!this.worker) {
            this.start();
        }
        this.game = eg;
        this.seq = 0;
        const reply = this.call({
            t: 'hello', protocol: PROTOCOL, v: VERSION, bot: this.name, you: seatOf(eg, eg.player(pid)),
            seed: Math.floor(rng() * 4294967296), players: eg.ids.map((id, i) => ({ id: `p${i + 1}`, name: eg.names[i] }))
        }, this.startTimeoutMs);
        if (reply.t !== 'ready') {
            throw new Error(`external bot ${this.name}: expected 'ready', got '${reply.t}'`);
        }
        if (reply.v !== undefined && reply.v !== VERSION) {
            throw new Error(`external bot ${this.name}: speaks protocol v${reply.v}, adapter is v${VERSION}`);
        }
    }

    choose({ game: eg, pid, actions, rng }) {
        if (eg !== this.game) {
            this.beginGame(eg, pid, rng);
        }
        const t0 = Date.now();
        const reply = this.call({
            t: 'decide', seq: ++this.seq, you: seatOf(eg, eg.player(pid)), prompt: promptView(eg, pid),
            state: observe(eg, pid), actions: actions.map((a, i) => actionView(eg, a, i))
        }, this.timeoutMs);
        this.timing.decisions++;
        this.timing.ms += Date.now() - t0;
        if (reply.t !== 'act' || !Number.isInteger(reply.i) || reply.i < 0 || reply.i >= actions.length) {
            throw new Error(`external bot ${this.name}: expected {t:'act', i: 0..${actions.length - 1}}, got ${JSON.stringify(reply).slice(0, 120)}`);
        }
        const action = actions[reply.i];
        if (action.kind === 'distribute' && reply.distribution) {
            return forcedDistribution(this.name, action, reply.distribution);
        }
        return action;
    }
}

/**
 * env.js always splits a distribute action itself (randomDistribution). Narrowing targets to the bot's picks and the
 * caps to the bot's amounts leaves that function exactly one possible split, so a chosen split goes through an
 * unmodified env.js: every chosen target is taken (capacity only reaches the total once all are in) and each one is
 * filled to its cap.
 */
function forcedDistribution(name, action, distribution) {
    const { spec, targets, caps } = action;
    const fail = (why) => {
        throw new Error(`external bot ${name}: bad distribution (${why}): ${JSON.stringify(distribution).slice(0, 160)}`);
    };
    if (!Array.isArray(distribution)) {
        fail('not an array');
    }
    const picked = distribution.filter((e) => e && e.amount !== 0);
    const seen = new Set();
    let sum = 0;
    for (const e of picked) {
        const k = targets.indexOf(e.id);
        if (k < 0 || seen.has(e.id)) {
            fail(`unknown or repeated target ${e.id}`);
        }
        if (!Number.isInteger(e.amount) || e.amount < 0 || e.amount > caps[k]) {
            fail(`amount ${e.amount} for ${e.id} is outside 0..${caps[k]}`);
        }
        seen.add(e.id);
        sum += e.amount;
    }
    if (spec.maxTargets != null && picked.length > spec.maxTargets) {
        fail(`more than ${spec.maxTargets} targets`);
    }
    if (sum === 0 ? !spec.canChooseNoTargets : spec.canDistributeLess ? sum > spec.amount : sum !== spec.amount) {
        fail(`total ${sum} is not allowed for amount ${spec.amount}`);
    }
    return { ...action, spec: { ...spec, maxTargets: picked.length }, targets: picked.map((e) => e.id), caps: picked.map((e) => e.amount) };
}

module.exports = { ExternalBot, forcedDistribution, PROTOCOL, VERSION };
