'use strict';
/**
 * A WASI preview 1 host for the swarm's bot workers (bot/swarm/README.md): it runs a bot bundle's WebAssembly the way
 * bot/compiled/run.py does under wasmtime, in a browser worker or a Node worker thread. The bot reads its messages
 * from a pipe it blocks on (a SharedArrayBuffer ring, written by the referee: stdinPipe/StdinWriter below) and writes
 * its replies to stdout, which goes to the referee a chunk at a time. Its folders are read-only and in memory:
 * /bot (the bundle) and a runtime's own (Python's standard library); the card data comes in hello.
 *
 * Same as run.py: argv, env, read-only preopens, stdout and stderr, wall clocks, random bytes, exit codes (a trap is
 * 134). Not the same: no memory cap (a browser cannot cap a memory the module defines itself) and no fuel, which the
 * arena does not use; the referee's time limits still apply.
 */

const E = { SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, PERM: 63, ROFS: 69, SPIPE: 70, NOTCAPABLE: 76 };
const FILETYPE = { UNKNOWN: 0, CHAR: 2, DIRECTORY: 3, REGULAR: 4 };
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const RIGHTS_ALL = 0x1fffffffn;

class WasiExit extends Error {
    constructor(code) {
        super(`exit ${code}`);
        this.code = code;
    }
}

// --- the stdin pipe: a ring of `capacity` bytes after a header of 4 int32s (write count, read count, closed, spare)

const HEADER = 16;

function stdinPipe(capacity = 4 << 20) {
    return new SharedArrayBuffer(HEADER + capacity);
}

/** The referee's end: write(bytes) copies what fits now and returns how many; close() is EOF. */
class StdinWriter {
    constructor(sab) {
        this.ctl = new Int32Array(sab, 0, 4);
        this.data = new Uint8Array(sab, HEADER);
    }
    write(bytes) {
        const cap = this.data.length;
        const w = Atomics.load(this.ctl, 0);
        const r = Atomics.load(this.ctl, 1);
        const room = cap - ((w - r) >>> 0);
        const n = Math.min(room, bytes.length);
        for (let i = 0; i < n; i++) {
            this.data[((w + i) >>> 0) % cap] = bytes[i];
        }
        Atomics.store(this.ctl, 0, (w + n) | 0);
        Atomics.notify(this.ctl, 0);
        return n;
    }
    close() {
        Atomics.store(this.ctl, 2, 1);
        Atomics.notify(this.ctl, 0);
    }
}

/** The bot's end: read(max) blocks until there is something or EOF (null). */
class StdinReader {
    constructor(sab) {
        this.ctl = new Int32Array(sab, 0, 4);
        this.data = new Uint8Array(sab, HEADER);
    }
    read(max) {
        const cap = this.data.length;
        for (;;) {
            const w = Atomics.load(this.ctl, 0);
            const r = Atomics.load(this.ctl, 1);
            const avail = (w - r) >>> 0;
            if (avail > 0) {
                const n = Math.min(avail, max);
                const out = new Uint8Array(n);
                for (let i = 0; i < n; i++) {
                    out[i] = this.data[((r + i) >>> 0) % cap];
                }
                Atomics.store(this.ctl, 1, (r + n) | 0);
                return out;
            }
            if (Atomics.load(this.ctl, 2)) {
                return null;
            }
            Atomics.wait(this.ctl, 0, w, 1000);
        }
    }
    /** Whether a read would not block now. */
    ready() {
        return Atomics.load(this.ctl, 0) !== Atomics.load(this.ctl, 1) || Atomics.load(this.ctl, 2) === 1;
    }
}

// --- folders: a preopen is {guest: '/bot', files: Map(relative path -> Uint8Array)}

function folderIndex(files) {
    const dirs = new Map([['', new Set()]]);
    for (const p of files.keys()) {
        const parts = p.split('/');
        for (let i = 1; i <= parts.length; i++) {
            const parent = parts.slice(0, i - 1).join('/');
            const self = parts.slice(0, i).join('/');
            if (!dirs.has(parent)) {
                dirs.set(parent, new Set());
            }
            dirs.get(parent).add(parts[i - 1]);
            if (i < parts.length && !dirs.has(self)) {
                dirs.set(self, new Set());
            }
        }
    }
    return dirs;
}

/** Joins a relative guest path to a folder path, refusing to leave the preopen. */
function joinInside(base, rel) {
    const parts = base ? base.split('/') : [];
    for (const p of rel.split('/')) {
        if (!p || p === '.') {
            continue;
        }
        if (p === '..') {
            if (!parts.length) {
                return null;
            }
            parts.pop();
        } else {
            parts.push(p);
        }
    }
    return parts.join('/');
}

/**
 * The host. opts: {args, env, preopens: [{guest, files}], stdin: StdinReader | null, stdout(bytes), stderr(bytes),
 * now() ms since the epoch with fractions, mono() ms, random(Uint8Array)}.
 */
class WasiHost {
    constructor(opts) {
        this.o = opts;
        this.memory = null;
        const enc = new TextEncoder();
        this.args = opts.args.map((a) => enc.encode(`${a}\0`));
        this.env = Object.entries(opts.env ?? {}).map(([k, v]) => enc.encode(`${k}=${v}\0`));
        this.fds = [{ kind: 'stdin' }, { kind: 'stdout' }, { kind: 'stderr' }];
        this.folders = [];
        for (const p of opts.preopens ?? []) {
            const folder = { guest: p.guest, files: p.files, dirs: folderIndex(p.files) };
            this.folders.push(folder);
            this.fds.push({ kind: 'dir', folder, path: '', preopen: enc.encode(p.guest) });
        }
        this.enc = enc;
        this.dec = new TextDecoder();
    }

    view() {
        return new DataView(this.memory.buffer);
    }
    bytes() {
        return new Uint8Array(this.memory.buffer);
    }
    str(ptr, len) {
        return this.dec.decode(new Uint8Array(this.memory.buffer, ptr, len));
    }
    newFd(entry) {
        let fd = this.fds.indexOf(null);
        if (fd < 0) {
            fd = this.fds.length;
            this.fds.push(null);
        }
        this.fds[fd] = entry;
        return fd;
    }
    stat(entry) {
        if (entry.kind === 'dir') {
            return { type: FILETYPE.DIRECTORY, size: 4096n };
        }
        if (entry.kind === 'file') {
            return { type: FILETYPE.REGULAR, size: BigInt(entry.data.length) };
        }
        return { type: FILETYPE.CHAR, size: 0n };
    }
    writeFilestat(ptr, st, ino = 0n) {
        const v = this.view();
        v.setBigUint64(ptr, 0n, true);
        v.setBigUint64(ptr + 8, ino, true);
        v.setUint8(ptr + 16, st.type);
        v.setBigUint64(ptr + 24, 1n, true);
        v.setBigUint64(ptr + 32, st.size, true);
        v.setBigUint64(ptr + 40, 0n, true);
        v.setBigUint64(ptr + 48, 0n, true);
        v.setBigUint64(ptr + 56, 0n, true);
    }
    /** {folder, path, kind} for a path under a directory fd, or an errno. */
    lookup(dirfd, rel) {
        const d = this.fds[dirfd];
        if (!d || d.kind !== 'dir') {
            return E.BADF;
        }
        const p = joinInside(d.path, rel);
        if (p === null) {
            return E.NOTCAPABLE;
        }
        if (d.folder.files.has(p)) {
            return { folder: d.folder, path: p, kind: 'file' };
        }
        if (d.folder.dirs.has(p)) {
            return { folder: d.folder, path: p, kind: 'dir' };
        }
        return E.NOENT;
    }

    imports() {
        const h = this;
        const iovs = (ptr, n) => {
            const v = h.view();
            const out = [];
            for (let i = 0; i < n; i++) {
                out.push([v.getUint32(ptr + 8 * i, true), v.getUint32(ptr + 8 * i + 4, true)]);
            }
            return out;
        };
        const sizes = (list, countPtr, sizePtr) => {
            const v = h.view();
            v.setUint32(countPtr, list.length, true);
            v.setUint32(sizePtr, list.reduce((n, b) => n + b.length, 0), true);
            return E.SUCCESS;
        };
        const fill = (list, ptrs, buf) => {
            const v = h.view();
            const mem = h.bytes();
            let o = buf;
            list.forEach((b, i) => {
                v.setUint32(ptrs + 4 * i, o, true);
                mem.set(b, o);
                o += b.length;
            });
            return E.SUCCESS;
        };
        const nowNs = (id) => BigInt(Math.round((id === 0 ? h.o.now() : h.o.mono()) * 1e6));
        const sleepMs = (ms) => {
            if (ms > 0) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
            }
        };
        const w = {
            args_get: (ptrs, buf) => fill(h.args, ptrs, buf),
            args_sizes_get: (c, s) => sizes(h.args, c, s),
            environ_get: (ptrs, buf) => fill(h.env, ptrs, buf),
            environ_sizes_get: (c, s) => sizes(h.env, c, s),
            clock_res_get: (_id, ptr) => {
                h.view().setBigUint64(ptr, 1000n, true);
                return E.SUCCESS;
            },
            clock_time_get: (id, _precision, ptr) => {
                h.view().setBigUint64(ptr, nowNs(id), true);
                return E.SUCCESS;
            },
            fd_advise: () => E.SUCCESS,
            fd_allocate: () => E.ROFS,
            fd_close: (fd) => {
                if (!h.fds[fd]) {
                    return E.BADF;
                }
                if (fd > 2 && !h.fds[fd].preopen) {
                    h.fds[fd] = null;
                }
                return E.SUCCESS;
            },
            fd_datasync: () => E.SUCCESS,
            fd_sync: () => E.SUCCESS,
            fd_fdstat_get: (fd, ptr) => {
                const e = h.fds[fd];
                if (!e) {
                    return E.BADF;
                }
                const v = h.view();
                v.setUint8(ptr, h.stat(e).type);
                v.setUint16(ptr + 2, 0, true);
                v.setBigUint64(ptr + 8, RIGHTS_ALL, true);
                v.setBigUint64(ptr + 16, RIGHTS_ALL, true);
                return E.SUCCESS;
            },
            fd_fdstat_set_flags: (fd) => (h.fds[fd] ? E.SUCCESS : E.BADF),
            fd_fdstat_set_rights: (fd) => (h.fds[fd] ? E.SUCCESS : E.BADF),
            fd_filestat_get: (fd, ptr) => {
                const e = h.fds[fd];
                if (!e) {
                    return E.BADF;
                }
                h.writeFilestat(ptr, h.stat(e), BigInt(fd));
                return E.SUCCESS;
            },
            fd_filestat_set_size: () => E.ROFS,
            fd_filestat_set_times: () => E.ROFS,
            fd_pread: (fd, iovPtr, n, offset, nreadPtr) => {
                const e = h.fds[fd];
                if (!e || e.kind !== 'file') {
                    return e ? E.ISDIR : E.BADF;
                }
                let pos = Number(offset);
                let total = 0;
                const mem = h.bytes();
                for (const [buf, len] of iovs(iovPtr, n)) {
                    const chunk = e.data.subarray(pos, pos + len);
                    mem.set(chunk, buf);
                    pos += chunk.length;
                    total += chunk.length;
                    if (chunk.length < len) {
                        break;
                    }
                }
                h.view().setUint32(nreadPtr, total, true);
                return E.SUCCESS;
            },
            fd_pwrite: () => E.ROFS,
            fd_prestat_get: (fd, ptr) => {
                const e = h.fds[fd];
                if (!e || !e.preopen) {
                    return E.BADF;
                }
                const v = h.view();
                v.setUint8(ptr, 0);
                v.setUint32(ptr + 4, e.preopen.length, true);
                return E.SUCCESS;
            },
            fd_prestat_dir_name: (fd, ptr, len) => {
                const e = h.fds[fd];
                if (!e || !e.preopen) {
                    return E.BADF;
                }
                h.bytes().set(e.preopen.subarray(0, len), ptr);
                return E.SUCCESS;
            },
            fd_read: (fd, iovPtr, n, nreadPtr) => {
                const e = h.fds[fd];
                if (!e) {
                    return E.BADF;
                }
                const list = iovs(iovPtr, n);
                let total = 0;
                if (e.kind === 'stdin') {
                    const want = list.reduce((s, [, len]) => s + len, 0);
                    const got = h.o.stdin ? h.o.stdin.read(want) : null;
                    if (got) {
                        let o = 0;
                        const mem = h.bytes();
                        for (const [buf, len] of list) {
                            const part = got.subarray(o, o + len);
                            mem.set(part, buf);
                            o += part.length;
                            if (o >= got.length) {
                                break;
                            }
                        }
                        total = got.length;
                    }
                } else if (e.kind === 'file') {
                    const mem = h.bytes();
                    for (const [buf, len] of list) {
                        const chunk = e.data.subarray(e.pos, e.pos + len);
                        mem.set(chunk, buf);
                        e.pos += chunk.length;
                        total += chunk.length;
                        if (chunk.length < len) {
                            break;
                        }
                    }
                } else if (e.kind === 'dir') {
                    return E.ISDIR;
                } else {
                    return E.BADF;
                }
                h.view().setUint32(nreadPtr, total, true);
                return E.SUCCESS;
            },
            fd_readdir: (fd, buf, bufLen, cookie, usedPtr) => {
                const e = h.fds[fd];
                if (!e || e.kind !== 'dir') {
                    return e ? E.NOTDIR : E.BADF;
                }
                const names = ['.', '..', ...[...(e.folder.dirs.get(e.path) ?? [])].sort()];
                const v = h.view();
                const mem = h.bytes();
                let used = 0;
                for (let i = Number(cookie); i < names.length && used < bufLen; i++) {
                    const name = h.enc.encode(names[i]);
                    const child = names[i] === '.' || names[i] === '..' ? e.path : joinInside(e.path, names[i]);
                    const type = names[i] === '.' || names[i] === '..' || e.folder.dirs.has(child) ? FILETYPE.DIRECTORY : FILETYPE.REGULAR;
                    const head = new Uint8Array(24);
                    const hv = new DataView(head.buffer);
                    hv.setBigUint64(0, BigInt(i + 1), true);
                    hv.setBigUint64(8, BigInt(i + 1), true);
                    hv.setUint32(16, name.length, true);
                    hv.setUint8(20, type);
                    const entry = new Uint8Array(24 + name.length);
                    entry.set(head);
                    entry.set(name, 24);
                    const n = Math.min(entry.length, bufLen - used);
                    mem.set(entry.subarray(0, n), buf + used);
                    used += n;
                }
                v.setUint32(usedPtr, used, true);
                return E.SUCCESS;
            },
            fd_renumber: (from, to) => {
                if (!h.fds[from]) {
                    return E.BADF;
                }
                h.fds[to] = h.fds[from];
                h.fds[from] = null;
                return E.SUCCESS;
            },
            fd_seek: (fd, offset, whence, newPtr) => {
                const e = h.fds[fd];
                if (!e) {
                    return E.BADF;
                }
                if (e.kind !== 'file') {
                    return E.SPIPE;
                }
                const base = whence === 0 ? 0 : whence === 1 ? e.pos : e.data.length;
                const pos = base + Number(offset);
                if (pos < 0) {
                    return E.INVAL;
                }
                e.pos = pos;
                h.view().setBigUint64(newPtr, BigInt(pos), true);
                return E.SUCCESS;
            },
            fd_tell: (fd, ptr) => {
                const e = h.fds[fd];
                if (!e || e.kind !== 'file') {
                    return e ? E.SPIPE : E.BADF;
                }
                h.view().setBigUint64(ptr, BigInt(e.pos), true);
                return E.SUCCESS;
            },
            fd_write: (fd, iovPtr, n, nwrittenPtr) => {
                const e = h.fds[fd];
                if (!e) {
                    return E.BADF;
                }
                if (e.kind !== 'stdout' && e.kind !== 'stderr') {
                    return e.kind === 'stdin' ? E.BADF : E.ROFS;
                }
                const mem = h.bytes();
                const parts = iovs(iovPtr, n).map(([buf, len]) => mem.slice(buf, buf + len));
                const total = parts.reduce((s, p) => s + p.length, 0);
                const all = new Uint8Array(total);
                let o = 0;
                for (const p of parts) {
                    all.set(p, o);
                    o += p.length;
                }
                if (total) {
                    (e.kind === 'stdout' ? h.o.stdout : h.o.stderr)(all);
                }
                h.view().setUint32(nwrittenPtr, total, true);
                return E.SUCCESS;
            },
            path_create_directory: () => E.ROFS,
            path_filestat_get: (dirfd, _flags, ptr, len, out) => {
                const hit = h.lookup(dirfd, h.str(ptr, len));
                if (typeof hit === 'number') {
                    return hit;
                }
                const st = hit.kind === 'dir' ? { type: FILETYPE.DIRECTORY, size: 4096n } : { type: FILETYPE.REGULAR, size: BigInt(hit.folder.files.get(hit.path).length) };
                h.writeFilestat(out, st);
                return E.SUCCESS;
            },
            path_filestat_set_times: () => E.ROFS,
            path_link: () => E.ROFS,
            path_open: (dirfd, _dirflags, ptr, len, oflags, _rightsBase, _rightsInheriting, _fdflags, fdPtr) => {
                const rel = h.str(ptr, len);
                const hit = h.lookup(dirfd, rel);
                if (typeof hit === 'number') {
                    return hit === E.NOENT && oflags & OFLAGS.CREAT ? E.ROFS : hit;
                }
                // every folder is read-only: opening is fine, creating or truncating is not
                if (oflags & (OFLAGS.CREAT | OFLAGS.TRUNC)) {
                    return oflags & OFLAGS.EXCL ? E.EXIST : E.ROFS;
                }
                if (oflags & OFLAGS.DIRECTORY && hit.kind !== 'dir') {
                    return E.NOTDIR;
                }
                const entry = hit.kind === 'dir' ? { kind: 'dir', folder: hit.folder, path: hit.path } : { kind: 'file', data: hit.folder.files.get(hit.path), pos: 0 };
                h.view().setUint32(fdPtr, h.newFd(entry), true);
                return E.SUCCESS;
            },
            path_readlink: () => E.INVAL,
            path_remove_directory: () => E.ROFS,
            path_rename: () => E.ROFS,
            path_symlink: () => E.ROFS,
            path_unlink_file: () => E.ROFS,
            poll_oneoff: (inPtr, outPtr, n, neventsPtr) => {
                const v = h.view();
                let wait = Infinity;
                const ready = [];
                for (let i = 0; i < n; i++) {
                    const s = inPtr + i * 48;
                    const tag = v.getUint8(s + 8);
                    if (tag === 0) {
                        const timeout = Number(v.getBigUint64(s + 24, true)) / 1e6;
                        const abs = v.getUint16(s + 40, true) & 1;
                        const ms = abs ? timeout - h.o.mono() : timeout;
                        wait = Math.min(wait, Math.max(0, ms));
                    } else if (tag === 1) {
                        const fd = v.getUint32(s + 16, true);
                        if (fd !== 0 || !h.o.stdin || h.o.stdin.ready()) {
                            ready.push(i);
                        }
                    } else {
                        ready.push(i);
                    }
                }
                if (!ready.length) {
                    const until = h.o.mono() + (Number.isFinite(wait) ? wait : 1e9);
                    for (;;) {
                        const left = until - h.o.mono();
                        if (left <= 0) {
                            break;
                        }
                        // stdin readers wake up when data comes; a plain sleep is a wait on nothing
                        sleepMs(Math.min(left, 50));
                        const fdReady = [];
                        for (let i = 0; i < n; i++) {
                            const s = inPtr + i * 48;
                            if (v.getUint8(s + 8) === 1 && h.o.stdin?.ready()) {
                                fdReady.push(i);
                            }
                        }
                        if (fdReady.length) {
                            ready.push(...fdReady);
                            break;
                        }
                    }
                }
                let count = 0;
                const v2 = h.view();
                for (let i = 0; i < n; i++) {
                    const s = inPtr + i * 48;
                    const tag = v2.getUint8(s + 8);
                    const isReady = ready.includes(i) || (tag === 0 && !ready.length);
                    if (!isReady) {
                        continue;
                    }
                    const o = outPtr + count * 32;
                    v2.setBigUint64(o, v2.getBigUint64(s, true), true);
                    v2.setUint16(o + 8, 0, true);
                    v2.setUint8(o + 10, tag);
                    v2.setBigUint64(o + 16, tag === 1 ? 1n : 0n, true);
                    v2.setUint16(o + 24, 0, true);
                    count++;
                }
                v2.setUint32(neventsPtr, count, true);
                return E.SUCCESS;
            },
            proc_exit: (code) => {
                throw new WasiExit(code);
            },
            proc_raise: () => E.NOSYS,
            random_get: (ptr, len) => {
                for (let o = 0; o < len; o += 65536) {
                    const chunk = new Uint8Array(Math.min(65536, len - o));
                    h.o.random(chunk);
                    h.bytes().set(chunk, ptr + o);
                }
                return E.SUCCESS;
            },
            sched_yield: () => E.SUCCESS,
            sock_accept: () => E.NOTSUP,
            sock_recv: () => E.NOTSUP,
            sock_send: () => E.NOTSUP,
            sock_shutdown: () => E.NOTSUP
        };
        return { wasi_snapshot_preview1: w };
    }

    /** Instantiates and runs the module's _start; the exit code (a trap is 134, as run.py reports it). */
    async run(module) {
        const instance = await WebAssembly.instantiate(module, this.imports());
        this.memory = instance.exports.memory;
        try {
            instance.exports._start();
            return { code: 0 };
        } catch (e) {
            if (e instanceof WasiExit) {
                return { code: e.code };
            }
            return { code: 134, trap: String(e?.message ?? e) };
        }
    }
}

module.exports = { WasiHost, WasiExit, stdinPipe, StdinWriter, StdinReader, E };
