'use strict';
/**
 * child_process.spawn for the swarm runtime (runtime.js, bot/swarm/README.md): the referee starts a bot program with
 * `python3 bot/compiled/run.py <bundle>` (resident WebAssembly bots, bot/external-bots.json and players/, and arena
 * versions, arena/registry.js). Here that becomes a bot worker (bot-worker.js) running the bundle under the WASI host
 * the way run.py runs it under wasmtime: same argv, env, read-only /bot and /cards, the runtime's own folders for
 * Python bundles. Any other program fails to start, as a missing program would.
 *
 *   const spawn = createSpawn({ fs, makeWorker })   // fs: the runtime's (bundles and card data are files in it)
 *   createRuntime({ ..., spawn })
 *
 * makeWorker() returns a Worker-like object: postMessage, terminate, and onmessage (browser) or on('message') (Node).
 * The returned process has what bot/stdio.js uses of a ChildProcess: stdin.write/end, stdout data events, exit and
 * error events, kill(), ref() and unref().
 */
const { stdinPipe, StdinWriter } = require('./wasi');

class Emitter {
    constructor() {
        this.l = new Map();
    }
    on(ev, fn) {
        (this.l.get(ev) ?? this.l.set(ev, []).get(ev)).push({ fn, once: false });
        return this;
    }
    once(ev, fn) {
        (this.l.get(ev) ?? this.l.set(ev, []).get(ev)).push({ fn, once: true });
        return this;
    }
    off(ev, fn) {
        this.l.set(ev, (this.l.get(ev) ?? []).filter((x) => x.fn !== fn));
        return this;
    }
    emit(ev, ...a) {
        const list = this.l.get(ev) ?? [];
        this.l.set(ev, list.filter((x) => !x.once));
        list.forEach((x) => x.fn(...a));
        return list.length > 0;
    }
    removeListener(ev, fn) {
        return this.off(ev, fn);
    }
    ref() {
        return this;
    }
    unref() {
        return this;
    }
}

const enc = new TextEncoder();

/** A spawned bundle: the ChildProcess side of a bot worker. */
class BotProcess extends Emitter {
    constructor(worker, start, { onStderr }) {
        super();
        this.pid = BotProcess.next = (BotProcess.next ?? 1000) + 1;
        this.worker = worker;
        this.exitCode = null;
        this.signalCode = null;
        this.done = false;
        const sab = stdinPipe();
        const writer = new StdinWriter(sab);
        const queue = [];
        let closing = false;
        let timer = null;
        const pump = () => {
            timer = null;
            while (queue.length) {
                const n = writer.write(queue[0]);
                if (n < queue[0].length) {
                    queue[0] = queue[0].subarray(n);
                    timer = setTimeout(pump, 1);
                    return;
                }
                queue.shift();
            }
            if (closing) {
                writer.close();
            }
        };
        const stdin = new Emitter();
        stdin.write = (data) => {
            if (this.done || closing) {
                return false;
            }
            queue.push(typeof data === 'string' ? enc.encode(data) : data);
            if (!timer) {
                pump();
            }
            return true;
        };
        stdin.end = (data) => {
            if (data) {
                stdin.write(data);
            }
            closing = true;
            if (!timer) {
                pump();
            }
        };
        this.stdin = stdin;
        this.stdout = new Emitter();
        let decoder = null;
        this.stdout.setEncoding = () => {
            decoder = new TextDecoder();
            return this.stdout;
        };
        this.stderr = new Emitter();
        const onMessage = (m) => {
            if (m.t === 'out') {
                this.stdout.emit('data', decoder ? decoder.decode(m.data, { stream: true }) : m.data);
            } else if (m.t === 'err') {
                onStderr?.(m.data);
                this.stderr.emit('data', m.data);
            } else if (m.t === 'exit') {
                if (m.trap) {
                    onStderr?.(enc.encode(`[swarm] trap: ${m.trap}\n`));
                }
                this.finish(m.code, null);
            }
        };
        if (typeof worker.on === 'function') {
            worker.on('message', onMessage);
            worker.on('error', (e) => this.fail(e));
        } else {
            worker.onmessage = (e) => onMessage(e.data);
            worker.onerror = (e) => this.fail(new Error(e.message ?? 'the bot worker failed'));
        }
        worker.postMessage({ ...start, stdin: sab });
    }
    fail(e) {
        if (!this.done) {
            this.emit('error', e);
            this.finish(1, null);
        }
    }
    finish(code, signal) {
        if (this.done) {
            return;
        }
        this.done = true;
        this.exitCode = code;
        this.signalCode = signal;
        try {
            this.worker.terminate();
        } catch {
            // gone
        }
        // as Node does: exit after the last output already delivered
        setTimeout(() => {
            this.emit('exit', code, signal);
            this.emit('close', code, signal);
        }, 0);
    }
    kill(signal = 'SIGTERM') {
        this.finish(null, signal);
        return true;
    }
}

/**
 * The spawn function. fs and path: the runtime's. modules: a Map cache of compiled WebAssembly by file. stderr(bytes):
 * where bots' stderr goes when the caller asked for it.
 */
function createSpawn({ fs, path, makeWorker, compile = (bytes) => WebAssembly.compile(bytes), stderr = null, cardRoot = '/app/forceteki/test/json', toolsRoot = '/app/build/compiled/.tools' }) {
    const modules = new Map();
    let cards = null;
    const folderFiles = (root) => {
        const out = [];
        const walk = (dir, rel) => {
            for (const name of fs.readdirSync(dir)) {
                const p = path.join(dir, name);
                const r = rel ? `${rel}/${name}` : name;
                if (fs.statSync(p).isDirectory()) {
                    walk(p, r);
                } else {
                    out.push([r, new Uint8Array(fs.readFileSync(p))]);
                }
            }
        };
        walk(root, '');
        return out;
    };
    const moduleOf = async (file) => {
        if (!modules.has(file)) {
            modules.set(file, compile(new Uint8Array(fs.readFileSync(file))));
        }
        return modules.get(file);
    };
    // what run.py does with a bundle's arena.json: argv, env and the folders it sees
    const plan = (bundleDir) => {
        const m = JSON.parse(fs.readFileSync(path.join(bundleDir, 'arena.json'), 'utf8'));
        const name = m.name || path.basename(bundleDir);
        const preopens = [{ guest: '/bot', files: folderFiles(bundleDir) }];
        const env = { ...(m.run?.env ?? {}) };
        if (m.cards?.use === 'mount') {
            cards ??= folderFiles(cardRoot);
            preopens.push({ guest: '/cards', files: cards });
            Object.assign(env, m.cards.env ?? { SWU_CARD_JSON: '/cards' });
        }
        if (m.runtime === 'wasi-p1') {
            // bundle.py entry_file: run.cmd "./bot.wasm", else the first argument
            const cmd = String(m.run?.cmd ?? '');
            const entry = cmd.startsWith('./') ? cmd.slice(2) : String(m.run?.args?.[0] ?? 'bot.wasm');
            if (entry.startsWith('/') || entry.split('/').includes('..')) {
                throw new Error(`entry ${entry} leaves the bundle`);
            }
            return { wasm: path.join(bundleDir, entry), args: [name, ...(m.run?.args ?? [])], env, preopens };
        }
        const toolchain = JSON.parse(fs.readFileSync('/app/bot/compiled/toolchain.json', 'utf8'));
        const rt = toolchain.runtimes?.[m.runtime];
        if (!rt) {
            throw new Error(`unknown runtime ${m.runtime}`);
        }
        const home = path.join(toolsRoot, rt.dir);
        if (!fs.existsSync(path.join(home, rt.wasm))) {
            throw new Error(`runtime ${m.runtime} is not loaded in this tab`);
        }
        for (const [host, guest] of Object.entries(rt.preopen ?? {})) {
            preopens.push({ guest, files: folderFiles(path.join(home, host)) });
        }
        Object.assign(env, rt.env ?? {});
        const args = m.run?.args ?? [];
        return { wasm: path.join(home, rt.wasm), args: [m.run.cmd, `/bot/${args[0]}`, ...args.slice(1)], env, preopens };
    };

    return function spawn(cmd, args, opts = {}) {
        const runPy = args.findIndex((a) => /(^|\/)bot\/compiled\/run\.py$/.test(String(a)));
        const proc = new Emitter();
        if (runPy < 0) {
            // not a bundle: like a program that is not installed here
            proc.stdin = Object.assign(new Emitter(), { write: () => false, end() {} });
            proc.stdout = Object.assign(new Emitter(), { setEncoding: () => proc.stdout });
            proc.stderr = new Emitter();
            proc.kill = () => true;
            setTimeout(() => proc.emit('error', Object.assign(new Error(`spawn ${cmd} ENOENT (only bundles run in the swarm)`), { code: 'ENOENT' })), 0);
            return proc;
        }
        const bundleArg = args.filter((a, i) => i > runPy && !String(a).startsWith('--')).pop();
        const bundleDir = path.resolve(opts.cwd ?? '/app', String(bundleArg));
        let p;
        try {
            p = plan(bundleDir);
        } catch (e) {
            proc.stdin = Object.assign(new Emitter(), { write: () => false, end() {} });
            proc.stdout = Object.assign(new Emitter(), { setEncoding: () => proc.stdout });
            proc.stderr = new Emitter();
            proc.kill = () => true;
            setTimeout(() => proc.emit('error', new Error(`the bundle in ${bundleDir} does not start: ${e.message}`)), 0);
            return proc;
        }
        // the module compiles asynchronously; the process exists at once and its stdin queues until then
        const lazy = new Emitter();
        lazy.stdout = Object.assign(new Emitter(), { setEncoding: () => lazy.stdout });
        lazy.stderr = new Emitter();
        const pending = [];
        let real = null;
        let killed = null;
        lazy.stdin = Object.assign(new Emitter(), {
            write: (d) => (real ? real.stdin.write(d) : (pending.push(['write', d]), true)),
            end: (d) => (real ? real.stdin.end(d) : pending.push(['end', d]))
        });
        lazy.kill = (sig = 'SIGTERM') => {
            if (real) {
                return real.kill(sig);
            }
            killed = sig;
            setTimeout(() => lazy.emit('exit', null, sig), 0);
            return true;
        };
        lazy.pid = 0;
        moduleOf(p.wasm).then((module) => {
            if (killed) {
                return;
            }
            real = new BotProcess(makeWorker(), { t: 'start', module, args: p.args, env: p.env, preopens: p.preopens }, { onStderr: opts.stdio?.[2] === 'ignore' ? null : stderr });
            lazy.pid = real.pid;
            let decode = false;
            lazy.stdout.setEncoding = () => {
                decode = true;
                real.stdout.setEncoding('utf8');
                return lazy.stdout;
            };
            real.stdout.setEncoding('utf8');
            void decode;
            real.stdout.on('data', (d) => lazy.stdout.emit('data', d));
            real.stderr.on('data', (d) => lazy.stderr.emit('data', d));
            real.on('exit', (c, s) => lazy.emit('exit', c, s));
            real.on('close', (c, s) => lazy.emit('close', c, s));
            real.on('error', (e) => lazy.emit('error', e));
            for (const [op, d] of pending.splice(0)) {
                real.stdin[op](d);
            }
        }, (e) => lazy.emit('error', new Error(`the bundle's WebAssembly does not compile: ${e.message}`)));
        return lazy;
    };
}

module.exports = { createSpawn, BotProcess, Emitter };
