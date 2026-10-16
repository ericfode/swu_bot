'use strict';

/**
 * Transports for the bot protocol (spec/protocol.md). No engine dependency, so bot programs can require this.
 *
 *   answer(client, msg, sim)  an in-process client's reply to one referee message (hello and over are optional)
 *   new StdioClient(name, {cmd, args})   a bot program, as a client: JSON lines on its stdin/stdout
 *   serve(client)             the other end: run an in-process client as a bot program
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

// bot programs still running when this process exits are killed, hung or not
const live = new Set();
process.on('exit', () => live.forEach((c) => c.kill('SIGKILL')));

/**
 * Reply of an in-process client `{ name, hello?, decide, over? }` to `msg`; `sim(request)` resolves to the `simulated`
 * reply. `bye` gets none (undefined).
 */
async function answer(client, msg, sim) {
    switch (msg.t) {
        case 'hello': return client.hello ? client.hello(msg) : { t: 'ready', v: 2, name: client.name };
        case 'decide': return client.decide(msg, sim);
        case 'over': return client.over ? client.over(msg) : { t: 'ok' };
        case 'bye': return undefined;
        default: return { t: 'error', error: `unknown message '${msg.t}'` };
    }
}

/**
 * A program's transcript files (StdioClient log): <log>.in.jsonl, .out.jsonl and .stderr, opened now. write(which,
 * data) appends synchronously; close() closes them, once. A file that cannot be written never fails the game.
 */
function openTap(log) {
    const fds = {};
    for (const [k, ext] of [['in', 'in.jsonl'], ['out', 'out.jsonl'], ['err', 'stderr']]) {
        try {
            fds[k] = fs.openSync(`${log}.${ext}`, 'w');
        } catch {
            fds[k] = null;
        }
    }
    return {
        write(which, data) {
            try {
                if (fds[which] !== null) {
                    fs.writeSync(fds[which], data);
                }
            } catch {
                fds[which] = null;
            }
        },
        close() {
            for (const k of Object.keys(fds)) {
                try {
                    if (fds[k] !== null) {
                        fs.closeSync(fds[k]);
                    }
                } catch {} // closed already
                fds[k] = null;
            }
        }
    };
}

/**
 * A bot program as a protocol client. The process starts at a hello and serves game after game until close().
 * A transport failure (exit, a line that is not JSON or that nobody asked for) or close() ends the process, since
 * later lines could no longer be matched to requests; the next hello starts a new one. Ending means end of stdin,
 * then SIGKILL 2 s later, so `cmd` must be the bot itself (a wrapper script must exec it). Time limits are the
 * referee's (protocol.js); `timeoutMs` and `startTimeoutMs`, when given, override its budgets for this bot.
 * With `log` set to a path prefix before the program starts (the dev harness's transcripts, ladder-worker.js), the
 * program's stderr goes to <log>.stderr instead, every line sent to it to <log>.in.jsonl and every line it writes on
 * stdout to <log>.out.jsonl (line k of .out answers line k of .in), each as it is, and WASM_HOST_STATS=<log>.host.json
 * is added to its environment (bot/compiled/run.py writes its stats there). Off by default.
 */
class StdioClient {
    constructor(name, { cmd, args = [], cwd = ROOT, env = {}, stderr = 'inherit', timeoutMs, startTimeoutMs, lang } = {}) {
        if (!cmd) {
            throw new Error(`bot ${name}: no cmd`);
        }
        this.name = name;
        this.lang = lang;
        this.opts = { cmd, args, cwd, env, stderr };
        this.timeoutMs = timeoutMs;
        this.startTimeoutMs = startTimeoutMs;
        this.child = null;
        this.dead = null;
        this.waiter = null;
        this.stray = null;
        this.log = null;
        this.tap = null;
    }

    hello(msg) {
        if (this.stray !== null && !this.dead) {
            // a line written after the last game belongs to that game: start afresh rather than blame this one
            console.error(`${this.name}: wrote a line nobody asked for: ${this.stray.slice(0, 120)}`);
            this.fail('stray line');
        }
        if (!this.child || this.dead) {
            this.start();
        }
        return this.request(msg);
    }

    async decide(msg, sim) {
        let reply = await this.request(msg);
        while (reply?.t === 'sim') {
            reply = await this.request(await sim(reply));
        }
        return reply;
    }

    over(msg) {
        return this.request(msg);
    }

    /** Ends the program: it sees EOF, and is killed if still running 2 s later. Resolves once it has exited. */
    close() {
        const child = this.child;
        this.fail('closed');
        return child && live.has(child) ? new Promise((resolve) => child.once('exit', resolve)) : Promise.resolve();
    }

    start() {
        this.dead = null;
        this.stray = null;
        const { cmd, args, cwd, env, stderr } = this.opts;
        const tap = this.log ? openTap(this.log) : null;
        const child = spawn(cmd, args, {
            cwd, env: { ...process.env, ...env, ...(tap ? { WASM_HOST_STATS: `${this.log}.host.json` } : {}) }, stdio: ['pipe', 'pipe', tap ? 'pipe' : stderr]
        });
        if (tap) {
            child.stderr.on('data', (d) => tap.write('err', d));
            child.stderr.unref?.();
            // once its output is all read: written synchronously, so nothing is lost when the worker exits right after
            child.on('close', tap.close);
            child.on('error', tap.close);
        }
        this.tap = tap;
        let buf = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d) => {
            if (this.child !== child) {
                return; // a closed predecessor still flushing
            }
            buf += d;
            for (let k; (k = buf.indexOf('\n')) >= 0;) {
                const raw = buf.slice(0, k);
                const line = raw.trim();
                buf = buf.slice(k + 1);
                if (!line) {
                    continue;
                }
                tap?.write('out', `${raw}\n`);
                const w = this.waiter;
                this.waiter = null;
                if (w) {
                    w(line);
                } else {
                    this.stray ??= line;
                }
            }
        });
        const fail = (why) => this.child === child && this.fail(why);
        live.add(child);
        child.on('error', (e) => {
            live.delete(child); // a program that never started has no exit to wait for
            fail(`could not start ${cmd}: ${e.message}`);
        });
        child.on('exit', (code, signal) => {
            live.delete(child);
            fail(`exited (code ${code}${signal ? `, ${signal}` : ''})`);
        });
        child.stdin.on('error', () => undefined);
        // an idle bot never keeps node running; the referee's timer does while it waits for a reply
        for (const h of [child, child.stdin, child.stdout]) {
            h.unref?.();
        }
        this.child = child;
    }

    fail(why) {
        if (this.dead === null) {
            this.dead = why;
            const child = this.child;
            if (child && live.has(child)) {
                child.stdin.end();
                const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
                child.once('exit', () => clearTimeout(kill));
                child.ref(); // until it has exited, so its exit is seen
            }
        }
        const w = this.waiter;
        this.waiter = null;
        w?.(null);
    }

    /** Write one message, resolve to the next line parsed. */
    request(msg) {
        if (!this.child) {
            return Promise.reject(new Error('not started (send hello first)'));
        }
        if (this.stray !== null && !this.dead) {
            this.fail(`wrote a line nobody asked for: ${this.stray.slice(0, 120)}`);
        }
        if (this.dead) {
            return Promise.reject(new Error(this.dead));
        }
        return new Promise((resolve, reject) => {
            this.waiter = (line) => {
                if (line === null) {
                    return reject(new Error(this.dead));
                }
                try {
                    resolve(JSON.parse(line));
                } catch {
                    this.fail(`reply is not JSON: ${line.slice(0, 120)}`);
                    reject(new Error(this.dead));
                }
            };
            const line = `${JSON.stringify(msg)}\n`;
            this.tap?.write('in', line);
            this.child.stdin.write(line);
        });
    }
}

/** Run in-process client `client` as a bot program: read referee messages on stdin, answer on stdout, until EOF. */
async function serve(client, { input = process.stdin, output = process.stdout } = {}) {
    const lines = readline.createInterface({ input, crlfDelay: Infinity })[Symbol.asyncIterator]();
    const next = async () => {
        for (;;) {
            const { value, done } = await lines.next();
            if (done) {
                return null;
            }
            if (value.trim()) {
                return JSON.parse(value);
            }
        }
    };
    const send = (m) => output.write(`${JSON.stringify(m)}\n`);
    for (let msg; (msg = await next());) {
        // a sim call after the decision ended (a search left running) is answered here, never sent
        let open = true;
        const sim = async (request) => {
            if (!open) {
                return { t: 'simulated', op: request?.op ?? null, error: 'this decision is over' };
            }
            send(request);
            return (await next()) ?? Promise.reject(new Error('referee closed the stream'));
        };
        let reply;
        try {
            reply = await answer(client, msg, sim);
        } catch (e) {
            reply = { t: 'error', error: String(e?.message ?? e) };
        }
        open = false;
        if (reply !== undefined) {
            send(reply);
        }
    }
}

module.exports = { answer, StdioClient, serve };
