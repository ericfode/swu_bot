'use strict';
/**
 * A small CommonJS runtime for the browser swarm (bot/swarm/README.md). It runs the repo's own Node code (the engine
 * from forceteki's build, bot/env.js, match.js, protocol.js, the bots) from an in-memory file tree, with the few Node
 * built-ins that code uses. It works in a browser worker and in Node (bot/test/swarm-runtime.test.js), where it never
 * touches the real file system: everything it reads comes from `files`, and everything the code writes stays in it.
 *
 *   const rt = createRuntime({ files, cwd: '/app', env: {}, spawn });
 *   const { Env } = rt.require('/app/bot/env.js');
 *
 * files: Map from absolute POSIX path to its contents (a string, or a Uint8Array for binary files). Directories are
 * implied by the paths. aliases: Map from absolute path (or bare module name) to a module object or a path, applied
 * before a file loads (the engine's winston logger is replaced by a silent one this way). spawn(cmd, args, opts): what
 * child_process.spawn does here (the swarm starts WebAssembly bots in workers through it); without it, spawn throws.
 *
 * Built-ins: fs (in memory), path (POSIX), events and buffer (the npm packages, from the file tree), util, crypto
 * (sha256, sha1, HMAC-SHA256, random bytes), v8 (serialize/deserialize as structuredClone), os, process, timers with
 * unref(), and stand-ins for async_hooks, worker_threads, perf_hooks, module, assert. Other built-ins load as empty
 * objects, so a module that only names one still loads.
 */

/** POSIX path functions; resolve() starts from cwd(). */
function makePath(cwd = () => '/') {
    const normalizeParts = (parts, absolute) => {
        const out = [];
        for (const p of parts) {
            if (!p || p === '.') {
                continue;
            }
            if (p === '..') {
                if (out.length && out[out.length - 1] !== '..') {
                    out.pop();
                } else if (!absolute) {
                    out.push('..');
                }
            } else {
                out.push(p);
            }
        }
        return out;
    };
    const path = {
        sep: '/',
        delimiter: ':',
        isAbsolute: (p) => String(p).startsWith('/'),
        normalize(p) {
            p = String(p);
            const abs = p.startsWith('/');
            const trail = p.endsWith('/');
            let s = normalizeParts(p.split('/'), abs).join('/');
            if (!s && !abs) {
                s = '.';
            }
            if (s && trail && s !== '/') {
                s += '/';
            }
            return abs ? `/${s}` : s;
        },
        join: (...parts) => {
            const j = parts.filter((x) => x !== '').join('/');
            return j ? path.normalize(j) : '.';
        },
        resolve(...parts) {
            let r = '';
            for (let i = parts.length - 1; i >= 0 && !r.startsWith('/'); i--) {
                if (parts[i]) {
                    r = r ? `${parts[i]}/${r}` : String(parts[i]);
                }
            }
            if (!r.startsWith('/')) {
                r = `${cwd()}/${r}`;
            }
            const s = `/${normalizeParts(r.split('/'), true).join('/')}`;
            return s;
        },
        dirname(p) {
            p = String(p);
            if (!p) {
                return '.';
            }
            const t = p.length > 1 ? p.replace(/\/+$/, '') : p;
            const i = t.lastIndexOf('/');
            return i < 0 ? '.' : i === 0 ? '/' : t.slice(0, i);
        },
        basename(p, ext) {
            const t = String(p).replace(/\/+$/, '');
            const b = t.slice(t.lastIndexOf('/') + 1);
            return ext && b.endsWith(ext) && b !== ext ? b.slice(0, -ext.length) : b;
        },
        extname(p) {
            const b = path.basename(p);
            const i = b.lastIndexOf('.');
            return i <= 0 ? '' : b.slice(i);
        },
        relative(from, to) {
            const f = path.resolve(from).split('/').filter(Boolean);
            const t = path.resolve(to).split('/').filter(Boolean);
            let i = 0;
            while (i < f.length && i < t.length && f[i] === t[i]) {
                i++;
            }
            return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/');
        },
        parse(p) {
            const base = path.basename(p);
            const ext = path.extname(p);
            const dir = path.dirname(p);
            return { root: String(p).startsWith('/') ? '/' : '', dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
        },
        format: (o) => `${o.dir ? `${o.dir}/` : o.root ?? ''}${o.base ?? `${o.name ?? ''}${o.ext ?? ''}`}`,
        toNamespacedPath: (p) => p
    };
    path.posix = path;
    return path;
}
const POSIX = makePath();

// --- hashing: SHA-256, SHA-1 and HMAC-SHA256, synchronous (the deal's keys use them: bot/rng.js)

const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function padded(bytes, bigEndianLength = true) {
    const len = bytes.length;
    const total = Math.ceil((len + 9) / 64) * 64;
    const m = new Uint8Array(total);
    m.set(bytes);
    m[len] = 0x80;
    const bits = len * 8;
    const dv = new DataView(m.buffer);
    if (bigEndianLength) {
        dv.setUint32(total - 8, Math.floor(bits / 2 ** 32));
        dv.setUint32(total - 4, bits >>> 0);
    }
    return { m, dv };
}

function sha256(bytes) {
    const { m, dv } = padded(bytes);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < m.length; o += 64) {
        for (let i = 0; i < 16; i++) {
            w[i] = dv.getUint32(o + i * 4);
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            hh = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        h[0] += a;
        h[1] += b;
        h[2] += c;
        h[3] += d;
        h[4] += e;
        h[5] += f;
        h[6] += g;
        h[7] += hh;
    }
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    h.forEach((x, i) => ov.setUint32(i * 4, x));
    return out;
}

function sha1(bytes) {
    const { m, dv } = padded(bytes);
    const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
    const w = new Uint32Array(80);
    const rotl = (x, n) => (x << n) | (x >>> (32 - n));
    for (let o = 0; o < m.length; o += 64) {
        for (let i = 0; i < 16; i++) {
            w[i] = dv.getUint32(o + i * 4);
        }
        for (let i = 16; i < 80; i++) {
            w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        }
        let [a, b, c, d, e] = h;
        for (let i = 0; i < 80; i++) {
            const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
            const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
            e = d;
            d = c;
            c = rotl(b, 30) >>> 0;
            b = a;
            a = t;
        }
        h[0] += a;
        h[1] += b;
        h[2] += c;
        h[3] += d;
        h[4] += e;
    }
    const out = new Uint8Array(20);
    const ov = new DataView(out.buffer);
    h.forEach((x, i) => ov.setUint32(i * 4, x));
    return out;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const concat = (chunks) => {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
        out.set(c, o);
        o += c.length;
    }
    return out;
};
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function hmacSha256(key, data) {
    let k = key.length > 64 ? sha256(key) : key;
    const block = new Uint8Array(64);
    block.set(k);
    const ipad = block.map((x) => x ^ 0x36);
    const opad = block.map((x) => x ^ 0x5c);
    k = null;
    return sha256(concat([opad, sha256(concat([ipad, data]))]));
}

// --- the in-memory file system

function fsError(code, syscall, p) {
    const text = { ENOENT: 'no such file or directory', EISDIR: 'illegal operation on a directory', ENOTDIR: 'not a directory', EEXIST: 'file already exists', EBADF: 'bad file descriptor' }[code] ?? code;
    const e = new Error(`${code}: ${text}, ${syscall} '${p}'`);
    e.code = code;
    e.syscall = syscall;
    e.path = p;
    e.errno = { ENOENT: -2, EISDIR: -21, ENOTDIR: -20, EEXIST: -17, EBADF: -9 }[code] ?? -1;
    return e;
}

function virtualFs(files, { cwd, Buffer, now = () => Date.now() }) {
    const dirs = new Set(['/']);
    const mtimes = new Map();
    const addDirs = (p) => {
        for (let d = POSIX.dirname(p); !dirs.has(d); d = POSIX.dirname(d)) {
            dirs.add(d);
        }
    };
    for (const p of files.keys()) {
        addDirs(p);
    }
    const abs = (p) => POSIX.resolve(cwd(), String(p instanceof URL ? p.pathname : p));
    const asBytes = (v) => (typeof v === 'string' ? utf8.encode(v) : v);
    const asText = (v) => (typeof v === 'string' ? v : fromUtf8.decode(v));
    const encodingOf = (opt) => (typeof opt === 'string' ? opt : opt?.encoding ?? null);
    const decode = (v, enc) => {
        if (!enc) {
            return Buffer.from(asBytes(v));
        }
        return enc === 'utf8' || enc === 'utf-8' ? asText(v) : Buffer.from(asBytes(v)).toString(enc);
    };
    const stat = (p, syscall, opts) => {
        const a = abs(p);
        const file = files.has(a);
        if (!file && !dirs.has(a)) {
            if (opts?.throwIfNoEntry === false) {
                return undefined;
            }
            throw fsError('ENOENT', syscall, p);
        }
        const size = file ? asBytes(files.get(a)).length : 4096;
        const t = mtimes.get(a) ?? 0;
        return {
            isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false, isFIFO: () => false, isSocket: () => false,
            isBlockDevice: () => false, isCharacterDevice: () => false,
            size, mode: file ? 0o100644 : 0o40755, mtimeMs: t, ctimeMs: t, atimeMs: t, birthtimeMs: t,
            mtime: new Date(t), ctime: new Date(t), atime: new Date(t), birthtime: new Date(t), uid: 0, gid: 0, ino: 0, dev: 0, nlink: 1
        };
    };
    const listDir = (p) => {
        const a = abs(p);
        if (files.has(a)) {
            throw fsError('ENOTDIR', 'scandir', p);
        }
        if (!dirs.has(a)) {
            throw fsError('ENOENT', 'scandir', p);
        }
        const prefix = a === '/' ? '/' : `${a}/`;
        const names = new Set();
        for (const set of [files.keys(), dirs]) {
            for (const q of set) {
                if (q.startsWith(prefix) && q.length > prefix.length) {
                    names.add(q.slice(prefix.length).split('/')[0]);
                }
            }
        }
        return [...names].sort();
    };
    const write = (p, data, append) => {
        const a = abs(p);
        if (dirs.has(a)) {
            throw fsError('EISDIR', 'open', p);
        }
        if (!dirs.has(POSIX.dirname(a))) {
            throw fsError('ENOENT', 'open', p);
        }
        if (!append && typeof data !== 'string') {
            // bytes stay bytes (a bundle's WebAssembly)
            files.set(a, Uint8Array.from(data));
        } else {
            const chunk = typeof data === 'string' ? data : asText(data);
            const prev = append && files.has(a) ? asText(files.get(a)) : '';
            files.set(a, prev + chunk);
        }
        mtimes.set(a, now());
    };
    const fds = new Map();
    let nextFd = 10;
    const fs = {
        constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024 },
        existsSync: (p) => {
            try {
                const a = abs(p);
                return files.has(a) || dirs.has(a);
            } catch {
                return false;
            }
        },
        readFileSync(p, opt) {
            if (typeof p === 'number') {
                const f = fds.get(p);
                if (!f) {
                    throw fsError('EBADF', 'read', p);
                }
                return decode(files.get(f.path) ?? '', encodingOf(opt));
            }
            const a = abs(p);
            if (!files.has(a)) {
                throw fsError(dirs.has(a) ? 'EISDIR' : 'ENOENT', 'open', p);
            }
            return decode(files.get(a), encodingOf(opt));
        },
        writeFileSync: (p, data) => write(p, data, false),
        appendFileSync: (p, data) => write(p, data, true),
        mkdirSync(p, opt) {
            const a = abs(p);
            if (files.has(a)) {
                throw fsError('EEXIST', 'mkdir', p);
            }
            if (dirs.has(a)) {
                if (opt?.recursive) {
                    return undefined;
                }
                throw fsError('EEXIST', 'mkdir', p);
            }
            if (!opt?.recursive && !dirs.has(POSIX.dirname(a))) {
                throw fsError('ENOENT', 'mkdir', p);
            }
            dirs.add(a);
            addDirs(a);
            return opt?.recursive ? a : undefined;
        },
        readdirSync(p, opt) {
            const names = listDir(p);
            if (!opt?.withFileTypes) {
                return names;
            }
            const a = abs(p);
            return names.map((name) => {
                const q = POSIX.join(a, name);
                const file = files.has(q);
                return { name, parentPath: a, path: a, isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false };
            });
        },
        statSync: (p, opt) => stat(p, 'stat', opt),
        lstatSync: (p, opt) => stat(p, 'lstat', opt),
        fstatSync: (fd) => {
            const f = fds.get(fd);
            if (!f) {
                throw fsError('EBADF', 'fstat', fd);
            }
            return stat(f.path, 'fstat');
        },
        realpathSync: (p) => {
            stat(p, 'realpath');
            return abs(p);
        },
        accessSync: (p) => {
            stat(p, 'access');
        },
        unlinkSync(p) {
            const a = abs(p);
            if (!files.delete(a)) {
                throw fsError('ENOENT', 'unlink', p);
            }
        },
        rmSync(p, opt) {
            const a = abs(p);
            if (files.delete(a)) {
                return;
            }
            if (!dirs.has(a)) {
                if (opt?.force) {
                    return;
                }
                throw fsError('ENOENT', 'rm', p);
            }
            for (const q of [...files.keys()]) {
                if (q.startsWith(`${a}/`)) {
                    files.delete(q);
                }
            }
            for (const q of [...dirs]) {
                if (q === a || q.startsWith(`${a}/`)) {
                    dirs.delete(q);
                }
            }
        },
        renameSync(from, to) {
            const a = abs(from);
            if (!files.has(a)) {
                throw fsError('ENOENT', 'rename', from);
            }
            const v = files.get(a);
            files.delete(a);
            write(to, v, false);
        },
        copyFileSync(from, to) {
            write(to, fs.readFileSync(from), false);
        },
        openSync(p, flags = 'r') {
            const a = abs(p);
            const writing = /[wa+]/.test(String(flags)) || (typeof flags === 'number' && flags & 3);
            if (writing) {
                if (/w/.test(String(flags)) || !files.has(a)) {
                    write(a, '', false);
                }
            } else if (!files.has(a)) {
                throw fsError('ENOENT', 'open', p);
            }
            const fd = nextFd++;
            fds.set(fd, { path: a, pos: 0 });
            return fd;
        },
        closeSync(fd) {
            fds.delete(fd);
        },
        readSync(fd, buf, off = 0, len = buf.length - off, pos = null) {
            const f = fds.get(fd);
            if (!f) {
                throw fsError('EBADF', 'read', fd);
            }
            const all = asBytes(files.get(f.path) ?? '');
            const start = pos ?? f.pos;
            const chunk = all.subarray(start, start + len);
            buf.set(chunk, off);
            if (pos === null) {
                f.pos = start + chunk.length;
            }
            return chunk.length;
        },
        writeSync(fd, data) {
            const f = fds.get(fd);
            if (!f) {
                throw fsError('EBADF', 'write', fd);
            }
            write(f.path, typeof data === 'string' ? data : asText(data), true);
            return typeof data === 'string' ? utf8.encode(data).length : data.length;
        },
        watch: () => ({ close() {}, on() {} }),
        createWriteStream(p) {
            write(p, '', false);
            return { write: (d) => (write(p, d, true), true), end: (d) => (d && write(p, d, true)), on() {}, once() {} };
        }
    };
    // the callback and promise forms, on top of the synchronous ones
    const promises = {};
    for (const [name, sync] of Object.entries({ readFile: 'readFileSync', writeFile: 'writeFileSync', appendFile: 'appendFileSync', mkdir: 'mkdirSync', readdir: 'readdirSync', stat: 'statSync', lstat: 'lstatSync', unlink: 'unlinkSync', rm: 'rmSync', rename: 'renameSync', access: 'accessSync', realpath: 'realpathSync', copyFile: 'copyFileSync' })) {
        promises[name] = async (...a) => fs[sync](...a);
        fs[name] = (...a) => {
            const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null;
            let r;
            let err = null;
            try {
                r = fs[sync](...a);
            } catch (e) {
                err = e;
            }
            if (cb) {
                queueMicrotask(() => cb(err, r));
            }
        };
    }
    fs.exists = (p, cb) => queueMicrotask(() => cb(fs.existsSync(p)));
    fs.promises = promises;
    return fs;
}

// --- the runtime

class ProcessExit extends Error {
    constructor(code) {
        super(`process.exit(${code})`);
        this.code = code;
    }
}

function createRuntime({ files, cwd: startDir = '/', env = {}, argv = ['node'], spawn = null, aliases = new Map(), log = console, cpus = 1, hostGlobal = globalThis } = {}) {
    let workdir = startDir;
    const cache = new Map();
    const builtinCache = new Map();
    const cwd = () => workdir;
    const path = makePath(cwd);
    const listeners = new Map();
    const emitter = {
        on(ev, fn) {
            (listeners.get(ev) ?? listeners.set(ev, []).get(ev)).push(fn);
            return process;
        },
        off(ev, fn) {
            listeners.set(ev, (listeners.get(ev) ?? []).filter((f) => f !== fn));
            return process;
        },
        emit(ev, ...a) {
            const l = listeners.get(ev) ?? [];
            l.forEach((f) => f(...a));
            return l.length > 0;
        }
    };
    const t0 = hostGlobal.performance?.now?.() ?? Date.now();
    const perfNow = () => hostGlobal.performance?.now?.() ?? Date.now();
    const write = (stream) => ({ write: (s) => (log[stream === 'out' ? 'log' : 'error'](String(s).replace(/\n$/, '')), true), isTTY: false, columns: 80, on() {}, once() {}, end() {} });
    const process = {
        env: { ...env },
        argv: [...argv],
        execArgv: [],
        execPath: '/usr/local/bin/node',
        platform: 'linux',
        arch: 'x64',
        pid: 1,
        ppid: 0,
        title: 'node',
        version: 'v22.0.0',
        versions: { node: '22.0.0', v8: '12.0' },
        release: { name: 'node' },
        exitCode: undefined,
        browser: false,
        cwd,
        chdir: (d) => {
            workdir = POSIX.resolve(workdir, d);
        },
        umask: () => 0o22,
        uptime: () => (perfNow() - t0) / 1000,
        hrtime: Object.assign((prev) => {
            const ns = Math.round(perfNow() * 1e6);
            const s = Math.floor(ns / 1e9);
            const n = ns % 1e9;
            if (!prev) {
                return [s, n];
            }
            let ds = s - prev[0];
            let dn = n - prev[1];
            if (dn < 0) {
                ds -= 1;
                dn += 1e9;
            }
            return [ds, dn];
        }, { bigint: () => BigInt(Math.round(perfNow() * 1e6)) }),
        memoryUsage: Object.assign(() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), { rss: () => 0 }),
        cpuUsage: () => ({ user: Math.round(perfNow() * 1000), system: 0 }),
        nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
        emitWarning: () => undefined,
        exit: (code = 0) => {
            throw new ProcessExit(code);
        },
        abort: () => {
            throw new ProcessExit(134);
        },
        kill: () => true,
        stdout: write('out'),
        stderr: write('err'),
        stdin: { on() {}, once() {}, resume() {}, pause() {}, setEncoding() {} },
        ...emitter,
        once: emitter.on,
        addListener: emitter.on,
        removeListener: emitter.off,
        removeAllListeners: (ev) => (listeners.delete(ev), process),
        listeners: (ev) => listeners.get(ev) ?? [],
        listenerCount: (ev) => (listeners.get(ev) ?? []).length,
        binding: () => ({}),
        features: {},
        config: { variables: {} }
    };
    // timers that answer unref() and ref() as Node's do
    const wrapTimer = (set, clear) => (fn, ms, ...a) => {
        const id = set(fn, ms, ...a);
        const t = { id, unref: () => t, ref: () => t, hasRef: () => true, refresh: () => t, close: () => clear(id), [Symbol.toPrimitive]: () => id };
        return t;
    };
    const unwrap = (clear) => (t) => clear(t && typeof t === 'object' ? t.id : t);
    const timers = {
        setTimeout: wrapTimer(hostGlobal.setTimeout.bind(hostGlobal), hostGlobal.clearTimeout.bind(hostGlobal)),
        setInterval: wrapTimer(hostGlobal.setInterval.bind(hostGlobal), hostGlobal.clearInterval.bind(hostGlobal)),
        setImmediate: wrapTimer((fn, _ms, ...a) => hostGlobal.setTimeout(fn, 0, ...a), hostGlobal.clearTimeout.bind(hostGlobal)),
        clearTimeout: unwrap(hostGlobal.clearTimeout.bind(hostGlobal)),
        clearInterval: unwrap(hostGlobal.clearInterval.bind(hostGlobal)),
        clearImmediate: unwrap(hostGlobal.clearTimeout.bind(hostGlobal))
    };
    timers.setImmediate = ((wrapped) => (fn, ...a) => wrapped(fn, 0, ...a))(timers.setImmediate);
    timers.promises = { setTimeout: (ms, v) => new Promise((r) => hostGlobal.setTimeout(() => r(v), ms)), setImmediate: (v) => new Promise((r) => hostGlobal.setTimeout(() => r(v), 0)) };

    // Buffer and EventEmitter come from the npm packages in the file tree (forceteki's node_modules)
    let Buffer = null;
    const fs = virtualFs(files, { cwd, Buffer: { from: (x, enc) => Buffer.from(x, enc) }, now: () => Date.now() });

    const crypto = {
        createHash(alg) {
            const fn = { sha256, sha1 }[String(alg).toLowerCase()];
            if (!fn) {
                throw new Error(`hash ${alg} is not available in the swarm runtime`);
            }
            const chunks = [];
            const h = {
                update: (d, enc) => (chunks.push(typeof d === 'string' ? Buffer.from(d, enc ?? 'utf8') : Uint8Array.from(d)), h),
                digest: (enc) => {
                    const b = Buffer.from(fn(concat(chunks)));
                    return enc ? b.toString(enc) : b;
                },
                copy: () => crypto.createHash(alg).update(concat(chunks))
            };
            return h;
        },
        createHmac(alg, key) {
            if (String(alg).toLowerCase() !== 'sha256') {
                throw new Error(`hmac ${alg} is not available in the swarm runtime`);
            }
            const k = typeof key === 'string' ? utf8.encode(key) : Uint8Array.from(key);
            const chunks = [];
            const h = {
                update: (d, enc) => (chunks.push(typeof d === 'string' ? Buffer.from(d, enc ?? 'utf8') : Uint8Array.from(d)), h),
                digest: (enc) => {
                    const b = Buffer.from(hmacSha256(k, concat(chunks)));
                    return enc ? b.toString(enc) : b;
                }
            };
            return h;
        },
        randomBytes: (n) => {
            const b = Buffer.alloc(n);
            hostGlobal.crypto.getRandomValues(b);
            return b;
        },
        randomUUID: () => hostGlobal.crypto.randomUUID(),
        randomInt: (a, b) => {
            const [lo, hi] = b === undefined ? [0, a] : [a, b];
            return lo + Math.floor(Math.random() * (hi - lo));
        },
        getRandomValues: (a) => hostGlobal.crypto.getRandomValues(a),
        timingSafeEqual: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
        webcrypto: hostGlobal.crypto
    };

    const inspect = (x, opts) => {
        if (typeof x === 'string') {
            return opts?.quote === false ? x : `'${x}'`;
        }
        if (x instanceof Error) {
            return x.stack ?? String(x);
        }
        try {
            return JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v));
        } catch {
            return String(x);
        }
    };
    const format = (f, ...a) => {
        if (typeof f !== 'string') {
            return [f, ...a].map((x) => (typeof x === 'string' ? x : inspect(x))).join(' ');
        }
        let i = 0;
        const s = f.replace(/%[sdifjoO%]/g, (m) => {
            if (m === '%%') {
                return '%';
            }
            const v = a[i++];
            return m === '%s' ? String(v) : m === '%d' || m === '%i' ? String(parseInt(v, 10)) : m === '%f' ? String(parseFloat(v)) : inspect(v);
        });
        return [s, ...a.slice(i).map((x) => (typeof x === 'string' ? x : inspect(x)))].join(' ');
    };
    const util = {
        format,
        inspect: Object.assign(inspect, { custom: Symbol.for('nodejs.util.inspect.custom'), defaultOptions: {} }),
        inherits(ctor, superCtor) {
            Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
            Object.setPrototypeOf(ctor, superCtor);
            ctor.super_ = superCtor;
        },
        promisify: (fn) => (...a) => new Promise((res, rej) => fn(...a, (e, v) => (e ? rej(e) : res(v)))),
        deprecate: (fn) => fn,
        debuglog: () => () => undefined,
        isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
        types: { isPromise: (x) => x instanceof Promise, isDate: (x) => x instanceof Date, isRegExp: (x) => x instanceof RegExp, isMap: (x) => x instanceof Map, isSet: (x) => x instanceof Set },
        TextEncoder,
        TextDecoder,
        isArray: Array.isArray
    };

    // a snapshot is a deep copy, as v8.serialize/deserialize make one (class instances come back as plain objects in both)
    const v8 = {
        serialize: (x) => ({ swarmSnapshot: hostGlobal.structuredClone(x) }),
        deserialize: (s) => hostGlobal.structuredClone(s.swarmSnapshot),
        getHeapStatistics: () => ({ total_heap_size: 0, used_heap_size: 0, heap_size_limit: 4 * 1024 ** 3 })
    };

    class AsyncLocalStorage {
        constructor() {
            this.store = undefined;
        }
        run(store, fn, ...a) {
            const was = this.store;
            this.store = store;
            try {
                return fn(...a);
            } finally {
                this.store = was;
            }
        }
        getStore() {
            return this.store;
        }
        enterWith(store) {
            this.store = store;
        }
        disable() {
            this.store = undefined;
        }
    }

    const assert = Object.assign((v, m) => {
        if (!v) {
            throw new Error(m ?? 'assertion failed');
        }
    }, {
        ok: (v, m) => assert(v, m),
        strictEqual: (a, b, m) => assert(a === b, m ?? `${inspect(a)} !== ${inspect(b)}`),
        notStrictEqual: (a, b, m) => assert(a !== b, m),
        deepStrictEqual: (a, b, m) => assert(util.isDeepStrictEqual(a, b), m ?? 'not deep equal'),
        equal: (a, b, m) => assert(a == b, m), // eslint-disable-line eqeqeq
        fail: (m) => assert(false, m),
        throws: (fn) => {
            try {
                fn();
            } catch {
                return;
            }
            throw new Error('did not throw');
        }
    });
    assert.strict = assert;

    const os = {
        EOL: '\n',
        platform: () => 'linux',
        type: () => 'Linux',
        arch: () => 'x64',
        release: () => '6.0.0',
        hostname: () => 'swarm',
        homedir: () => '/home/swarm',
        tmpdir: () => '/tmp',
        cpus: () => Array.from({ length: cpus }, () => ({ model: 'browser', speed: 0, times: {} })),
        availableParallelism: () => cpus,
        totalmem: () => 4 * 1024 ** 3,
        freemem: () => 2 * 1024 ** 3,
        loadavg: () => [0, 0, 0],
        uptime: () => process.uptime(),
        networkInterfaces: () => ({}),
        userInfo: () => ({ username: 'swarm', uid: 1000, gid: 1000, homedir: '/home/swarm', shell: null }),
        endianness: () => 'LE',
        constants: { signals: {} }
    };

    const childProcess = {
        spawn(cmd, args = [], opts = {}) {
            if (!spawn) {
                throw new Error(`spawn ${cmd}: no programs run here`);
            }
            return spawn(cmd, args, { ...opts, cwd: POSIX.resolve(workdir, opts.cwd ?? '.') });
        },
        spawnSync: (cmd) => {
            throw new Error(`spawnSync ${cmd}: not available in the swarm runtime`);
        },
        execFileSync: (cmd) => {
            throw new Error(`execFileSync ${cmd}: not available in the swarm runtime`);
        },
        execSync: (cmd) => {
            throw new Error(`execSync ${cmd}: not available in the swarm runtime`);
        },
        exec: (cmd) => {
            throw new Error(`exec ${cmd}: not available in the swarm runtime`);
        },
        execFile: (cmd) => {
            throw new Error(`execFile ${cmd}: not available in the swarm runtime`);
        },
        fork: (m) => {
            throw new Error(`fork ${m}: not available in the swarm runtime`);
        }
    };

    const BUILTIN_NAMES = ['assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'path/posix', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'stream/promises', 'string_decoder', 'sys', 'timers', 'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'];
    const isBuiltin = (name) => BUILTIN_NAMES.includes(String(name).replace(/^node:/, ''));

    const findPackage = (name) => {
        for (const base of ['/app/forceteki/node_modules', '/app/node_modules']) {
            if (files.has(`${base}/${name}/package.json`)) {
                return `${base}/${name}`;
            }
        }
        return null;
    };

    function builtin(name) {
        name = name.replace(/^node:/, '');
        if (builtinCache.has(name)) {
            return builtinCache.get(name);
        }
        let m;
        switch (name) {
        case 'fs':
            m = fs;
            break;
        case 'fs/promises':
            m = fs.promises;
            break;
        case 'path':
        case 'path/posix':
            m = path;
            break;
        case 'buffer':
            m = load(`${findPackage('buffer')}/index.js`);
            break;
        case 'events': {
            m = load(`${findPackage('events')}/events.js`);
            break;
        }
        case 'util':
        case 'sys':
            m = util;
            break;
        case 'crypto':
            m = crypto;
            break;
        case 'v8':
            m = v8;
            break;
        case 'os':
            m = os;
            break;
        case 'process':
            m = process;
            break;
        case 'timers':
            m = timers;
            break;
        case 'timers/promises':
            m = timers.promises;
            break;
        case 'assert':
            m = assert;
            break;
        case 'child_process':
            m = childProcess;
            break;
        case 'async_hooks':
            m = { AsyncLocalStorage, createHook: () => ({ enable() {
                return this;
            }, disable() {
                return this;
            } }), executionAsyncId: () => 0, triggerAsyncId: () => 0, AsyncResource: class {
                runInAsyncScope(fn, self, ...a) {
                    return fn.apply(self, a);
                }
            } };
            break;
        case 'worker_threads':
            m = { isMainThread: true, parentPort: null, workerData: null, threadId: 0, Worker: class {
                constructor() {
                    throw new Error('worker_threads.Worker: not available in the swarm runtime');
                }
            } };
            break;
        case 'perf_hooks':
            m = { performance: hostGlobal.performance, PerformanceObserver: class {
                observe() {}
                disconnect() {}
            } };
            break;
        case 'module':
            m = { builtinModules: BUILTIN_NAMES, isBuiltin, createRequire: (file) => makeRequire(POSIX.dirname(String(file).replace(/^file:\/\//, ''))) };
            break;
        case 'string_decoder':
            m = { StringDecoder: class {
                constructor() {
                    this.d = new TextDecoder();
                }
                write(b) {
                    return this.d.decode(b, { stream: true });
                }
                end(b) {
                    return b ? this.d.decode(b) : this.d.decode();
                }
            } };
            break;
        case 'url':
            m = { URL, URLSearchParams, fileURLToPath: (u) => decodeURIComponent(new URL(u).pathname), pathToFileURL: (p) => new URL(`file://${POSIX.resolve(workdir, p)}`) };
            break;
        default:
            m = {};
        }
        builtinCache.set(name, m);
        return m;
    }

    const EXTS = ['', '.js', '.json', '.cjs'];
    function resolveFile(p) {
        for (const ext of EXTS) {
            if (files.has(p + ext)) {
                return p + ext;
            }
        }
        if (files.has(`${p}/package.json`)) {
            const pkg = JSON.parse(fs.readFileSync(`${p}/package.json`, 'utf8'));
            // "exports" for ".", as Node's require reads it (conditions require, node, default), else "main"
            const pick = (x) => (typeof x === 'string' ? x : Array.isArray(x) ? x.map(pick).find(Boolean) : x && typeof x === 'object' ? pick(x.require ?? x.node ?? x.default) : null);
            const dot = pkg.exports && (typeof pkg.exports === 'string' || Array.isArray(pkg.exports) || !Object.keys(pkg.exports).some((k) => k.startsWith('.')) ? pkg.exports : pkg.exports['.']);
            const entry = pick(dot) ?? (typeof pkg.main === 'string' ? pkg.main : null);
            const main = entry ? POSIX.resolve(p, entry) : null;
            if (main) {
                const r = resolveFile(main);
                if (r) {
                    return r;
                }
            }
        }
        for (const ext of ['/index.js', '/index.json']) {
            if (files.has(p + ext)) {
                return p + ext;
            }
        }
        return null;
    }

    function resolve(request, fromDir) {
        if (aliases.has(request)) {
            return request;
        }
        if (isBuiltin(request)) {
            return `node:${request.replace(/^node:/, '')}`;
        }
        let hit = null;
        if (request.startsWith('/') || request.startsWith('./') || request.startsWith('../') || request === '.' || request === '..') {
            hit = resolveFile(POSIX.resolve(fromDir, request));
        } else {
            for (let d = fromDir; ; d = POSIX.dirname(d)) {
                if (!d.endsWith('/node_modules')) {
                    hit = resolveFile(POSIX.join(d, 'node_modules', request));
                    if (hit) {
                        break;
                    }
                }
                if (d === '/') {
                    break;
                }
            }
            if (!hit) {
                const [scope, rest] = request.startsWith('@') ? [request.split('/').slice(0, 2).join('/'), request.split('/').slice(2)] : [request.split('/')[0], request.split('/').slice(1)];
                const pkg = findPackage(scope);
                hit = pkg && resolveFile(rest.length ? POSIX.join(pkg, ...rest) : pkg);
            }
        }
        if (!hit) {
            const e = new Error(`Cannot find module '${request}' from '${fromDir}'`);
            e.code = 'MODULE_NOT_FOUND';
            throw e;
        }
        return hit;
    }

    function load(file) {
        if (aliases.has(file)) {
            const a = aliases.get(file);
            return typeof a === 'string' ? load(a) : a;
        }
        if (file.startsWith('node:')) {
            return builtin(file);
        }
        const hit = cache.get(file);
        if (hit) {
            return hit.exports;
        }
        const module = { id: file, filename: file, path: POSIX.dirname(file), exports: {}, loaded: false, children: [], paths: [], parent: null };
        module.require = makeRequire(module.path);
        cache.set(file, module);
        try {
            const src = fs.readFileSync(file, 'utf8');
            if (file.endsWith('.json')) {
                module.exports = JSON.parse(src);
            } else {
                const code = `${src.startsWith('#!') ? `//${src}` : src}\n//# sourceURL=swarm://${file}`;
                // eslint-disable-next-line no-new-func
                const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', 'process', 'Buffer', 'global', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', code);
                fn.call(module.exports, module.exports, module.require, module, file, module.path, process, Buffer, hostGlobal, timers.setTimeout, timers.setInterval, timers.setImmediate, timers.clearTimeout, timers.clearInterval, timers.clearImmediate);
            }
            module.loaded = true;
        } catch (e) {
            cache.delete(file);
            throw e;
        }
        return module.exports;
    }

    function makeRequire(fromDir) {
        const req = (request) => load(resolve(String(request), fromDir));
        req.resolve = (request) => resolve(String(request), fromDir);
        req.resolve.paths = () => [];
        req.cache = new Proxy({}, { get: (_t, k) => cache.get(k), has: (_t, k) => cache.has(k), deleteProperty: (_t, k) => cache.delete(k), ownKeys: () => [...cache.keys()], getOwnPropertyDescriptor: (_t, k) => (cache.has(k) ? { value: cache.get(k), enumerable: true, configurable: true } : undefined) });
        req.main = undefined;
        req.extensions = {};
        return req;
    }

    Buffer = builtin('buffer').Buffer;
    return { require: makeRequire(startDir), process, fs, path, timers, files, ProcessExit, resolve, load };
}

module.exports = { createRuntime, makePath, sha256, sha1, hmacSha256, toHex, ProcessExit };
