'use strict';

/**
 * Transports for the bot protocol (spec/protocol.md). No engine dependency, so bot programs can require this.
 *
 *   answer(client, msg, sim)  an in-process client's reply to one referee message (hello and over are optional)
 *   new StdioClient(name, {cmd, args})   a bot program, as a client: JSON lines on its stdin/stdout
 *   serve(client)             the other end: run an in-process client as a bot program
 */

const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** Reply of an in-process client `{ name, hello?, decide, over? }` to `msg`; `sim(request)` resolves to the `simulated` reply. */
async function answer(client, msg, sim) {
    switch (msg.t) {
        case 'hello': return client.hello ? client.hello(msg) : { t: 'ready', v: 2, name: client.name };
        case 'decide': return client.decide(msg, sim);
        case 'over': return client.over ? client.over(msg) : { t: 'ok' };
        default: return { t: 'error', error: `unknown message '${msg.t}'` };
    }
}

/**
 * A bot program as a protocol client. The process starts at a hello and serves game after game until close().
 * A transport failure (exit, a line that is not JSON or that nobody asked for) or close() ends the process, since
 * later lines could no longer be matched to requests; the next hello starts a new one. Time limits are the referee's
 * (protocol.js); `timeoutMs` and `startTimeoutMs`, when given, override its per-message budgets for this bot.
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
    }

    hello(msg) {
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

    /** Ends the program (it sees EOF; killed if still running 2 s later). */
    close() {
        this.fail('closed');
    }

    start() {
        this.dead = null;
        this.stray = null;
        const { cmd, args, cwd, env, stderr } = this.opts;
        const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', stderr] });
        let buf = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d) => {
            if (this.child !== child) {
                return; // a closed predecessor still flushing
            }
            buf += d;
            for (let k; (k = buf.indexOf('\n')) >= 0;) {
                const line = buf.slice(0, k).trim();
                buf = buf.slice(k + 1);
                if (!line) {
                    continue;
                }
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
        child.on('error', (e) => fail(`could not start ${cmd}: ${e.message}`));
        child.on('exit', (code, signal) => fail(`exited (code ${code}${signal ? `, ${signal}` : ''})`));
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
            if (child && child.exitCode === null) {
                child.stdin.end();
                setTimeout(() => child.kill(), 2000).unref();
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
            this.child.stdin.write(`${JSON.stringify(msg)}\n`);
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
    const sim = async (request) => {
        send(request);
        return (await next()) ?? Promise.reject(new Error('referee closed the stream'));
    };
    for (let msg; (msg = await next());) {
        let reply;
        try {
            reply = await answer(client, msg, sim);
        } catch (e) {
            reply = { t: 'error', error: String(e?.message ?? e) };
        }
        send(reply);
    }
}

module.exports = { answer, StdioClient, serve };
