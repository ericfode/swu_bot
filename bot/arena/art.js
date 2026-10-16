'use strict';
/**
 * Card art through the window, for its cross-origin isolated pages (/play and /tables). An arena bot's stdin is a
 * SharedArrayBuffer, so those pages are isolated, with COEP require-corp: the one mode Safari has (it has no
 * credentialless). Under require-corp a page loads an image from another site only when that site allows it (a CORP or
 * CORS header), and swu-db's CDN sends neither. So the pages point the viewer kit's art at /art/ (setArtResolver) and the
 * window fetches the same image from the CDN.
 *
 *   const art = createArt({ dir });
 *   if (await art.route(req, res, url, who)) return;
 *
 *   GET /art/<SET>/<NNN>.png      a card's image, as https://cdn.swu-db.com/images/cards/<SET>/<NNN>.png
 *   GET /art/<SET>/<NNN>-b.png    the deployed side of a leader
 *
 * For anyone signed in with GitHub, a view link's guest, or a token: the images are public, but the window is no open
 * mirror. They never change, so browsers keep them a year. An image the CDN does not have (tokens, sets it has no art for
 * yet) answers 404, and the window remembers that for an hour, so a game asks the CDN once per card.
 *
 * Smaller images (2026-10-16, "make it cheap for them to be downloaded"): the CDN's images are ~270 KB JPEGs of
 * 1120x1560 (sent as image/png). The window makes each one a WebP of at most 1000 px on its long side (~70 KB, the same
 * look at the largest size the viewer shows a card) with cwebp, once, in the background after the first request for it,
 * and keeps it in `dir` (the volume, up to maxDiskBytes, oldest out first) and in memory. A browser whose Accept takes
 * image/webp gets the WebP once there is one, and the CDN's image until then; others always get the CDN's image. Memory
 * keeps the latest images up to maxBytes; a CDN image is dropped from it once its WebP is made.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { atLeast } = require('./auth');
const { accepts } = require('./static');

const CDN = 'https://cdn.swu-db.com/images/cards';
// set codes as the card data has them (SOR, TS26, IC27, ...), three-digit numbers
const PATH = /^\/art\/([A-Z0-9]{2,6})\/(\d{3})(-b)?\.png$/;
const MAX_BYTES = 48e6; // kept in memory: ~180 CDN images at ~260 KB, ~680 WebPs at ~70 KB
const MAX_DISK = 150e6; // WebPs kept on the volume: ~2,100 at ~70 KB
const MIN_FREE = 200e6; // the volume holds the replays first: no WebP is written when less is free
const MAX_IMAGE = 4e6;
const MISS_MS = 3600e3;
const TIMEOUT_MS = 15000;
const LONG_SIDE = 1000;
const QUALITY = 78;
const KEEP = 'public, max-age=31536000, immutable';
const IMAGE = { 'content-type': 'image/png', 'cache-control': KEEP, 'cross-origin-resource-policy': 'same-origin' };
const WEBP = { 'content-type': 'image/webp', 'cache-control': KEEP, 'cross-origin-resource-policy': 'same-origin' };

/** {w, h} of a JPEG or PNG image (its header), or null. */
function imageSize(buf) {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR') {
        return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
        return null;
    }
    for (let i = 2; i + 9 < buf.length;) {
        if (buf[i] !== 0xff) {
            return null;
        }
        const m = buf[i + 1];
        if (m === 0xff) {
            i++; // fill byte
            continue;
        }
        if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
            i += 2; // no length
            continue;
        }
        // a start of frame (SOF0-SOF15, less DHT, JPG and DAC) holds the size
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
            return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
}

const isWebp = (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';

/** The image as a WebP of at most LONG_SIDE px on its long side, made by cwebp (Debian's webp package). */
function cwebp(buf, { bin = 'cwebp', timeoutMs = 60000 } = {}) {
    const size = imageSize(buf);
    const resize = size && Math.max(size.w, size.h) > LONG_SIDE ? ['-resize', ...(size.w >= size.h ? [LONG_SIDE, 0] : [0, LONG_SIDE]).map(String)] : [];
    return new Promise((resolve, reject) => {
        const p = spawn(bin, ['-quiet', '-q', String(QUALITY), ...resize, '-o', '-', '--', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
        const out = [];
        let err = '';
        const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
        p.stdout.on('data', (d) => out.push(d));
        p.stderr.on('data', (d) => {
            err += d;
        });
        p.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
        p.on('close', (code) => {
            clearTimeout(timer);
            const b = Buffer.concat(out);
            if (code === 0 && isWebp(b)) {
                resolve(b);
            } else {
                reject(new Error(`cwebp ended ${code}: ${err.trim().slice(0, 200)}`));
            }
        });
        p.stdin.on('error', () => undefined); // it may stop reading early when it fails
        p.stdin.end(buf);
    });
}

function createArt({ fetchImpl = fetch, maxBytes = MAX_BYTES, now = Date.now, timeoutMs = TIMEOUT_MS, dir = null, maxDiskBytes = MAX_DISK, minFreeBytes = MIN_FREE, toWebp = cwebp } = {}) {
    const kept = new Map(); // key (or key#webp) -> Buffer, least recently used first
    let bytes = 0;
    const missing = new Map(); // key -> when the CDN said it has no such image
    const pending = new Map(); // key -> Promise<Buffer | null>, so a page asking for one card twice fetches it once
    let webpOn = typeof toWebp === 'function';
    const noWebp = new Map(); // key -> when its WebP could not be made (or was no smaller): the CDN's image for an hour
    const queue = []; // keys whose WebP is to be made, one at a time
    const queued = new Set();
    let making = false;
    let disk = null; // the WebPs on disk: rel -> size, oldest first (read from dir once)
    let diskBytes = 0;

    const keep = (key, buf) => {
        if (buf.length > maxBytes) {
            return;
        }
        if (kept.has(key)) {
            bytes -= kept.get(key).length;
            kept.delete(key);
        }
        kept.set(key, buf);
        bytes += buf.length;
        for (const [k, b] of kept) {
            if (bytes <= maxBytes) {
                break;
            }
            kept.delete(k);
            bytes -= b.length;
        }
    };
    const drop = (key) => {
        if (kept.has(key)) {
            bytes -= kept.get(key).length;
            kept.delete(key);
        }
    };
    const recent = (key) => {
        const have = kept.get(key);
        if (have) {
            kept.delete(key);
            kept.set(key, have);
        }
        return have ?? null;
    };

    /** The image, null when the CDN has none; throws when the CDN could not be asked (no answer, an error status). */
    async function fetchImage(key) {
        const r = await fetchImpl(`${CDN}/${key}`, { signal: AbortSignal.timeout(timeoutMs) });
        if (r.status === 404 || r.status === 403) {
            // S3 answers 403 for a file it does not have
            await r.body?.cancel?.();
            return null;
        }
        if (r.status !== 200) {
            await r.body?.cancel?.();
            throw new Error(`the card art CDN answered ${r.status}`);
        }
        const type = String(r.headers.get('content-type') ?? '');
        const buf = Buffer.from(await r.arrayBuffer());
        if (!/^image\/png\b/i.test(type) || buf.length > MAX_IMAGE) {
            throw new Error(`the card art CDN sent ${type || 'no type'}, ${buf.length} bytes`);
        }
        return buf;
    }

    /** The CDN's image (kept in memory), null when the CDN has none. */
    function image(key) {
        const have = recent(key);
        if (have) {
            return Promise.resolve(have);
        }
        const miss = missing.get(key);
        if (miss !== undefined && now() - miss < MISS_MS) {
            return Promise.resolve(null);
        }
        missing.delete(key);
        if (!pending.has(key)) {
            pending.set(key, fetchImage(key).then((buf) => {
                if (buf) {
                    keep(key, buf);
                } else {
                    missing.set(key, now());
                }
                return buf;
            }).finally(() => pending.delete(key)));
        }
        return pending.get(key);
    }

    // ---- the WebPs: in memory as key#webp, on disk as <dir>/<SET>/<NNN>[-b].webp ----
    const relOf = (key) => key.replace(/\.png$/, '.webp');
    function diskIndex() {
        if (disk || !dir) {
            return disk;
        }
        disk = new Map();
        const found = [];
        for (const set of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
            if (!/^[A-Z0-9]{2,6}$/.test(set)) {
                continue;
            }
            for (const f of fs.readdirSync(path.join(dir, set))) {
                const st = /^\d{3}(-b)?\.webp$/.test(f) ? fs.statSync(path.join(dir, set, f), { throwIfNoEntry: false }) : null;
                if (st?.isFile()) {
                    found.push({ rel: `${set}/${f}`, size: st.size, at: st.mtimeMs });
                }
            }
        }
        for (const f of found.sort((a, b) => a.at - b.at)) {
            disk.set(f.rel, f.size);
            diskBytes += f.size;
        }
        return disk;
    }
    function writeDisk(key, buf) {
        const index = diskIndex();
        if (!index) {
            return;
        }
        const rel = relOf(key);
        try {
            fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
            const st = fs.statfsSync(dir);
            if (st.bavail * st.bsize - buf.length < minFreeBytes) {
                return;
            }
            for (const [old, size] of index) {
                if (diskBytes + buf.length <= maxDiskBytes) {
                    break;
                }
                fs.rmSync(path.join(dir, old), { force: true });
                index.delete(old);
                diskBytes -= size;
            }
            const file = path.join(dir, rel);
            fs.writeFileSync(`${file}.tmp`, buf);
            fs.renameSync(`${file}.tmp`, file);
            diskBytes += buf.length - (index.get(rel) ?? 0);
            index.delete(rel);
            index.set(rel, buf.length);
        } catch (e) {
            console.error(`window: card art ${rel} not kept on disk: ${e.message}`);
        }
    }
    /** The WebP the window has made for `key`, from memory or disk, or null. */
    async function webp(key) {
        const have = recent(`${key}#webp`);
        if (have || !diskIndex()?.has(relOf(key))) {
            return have;
        }
        try {
            const buf = await fs.promises.readFile(path.join(dir, relOf(key)));
            keep(`${key}#webp`, buf);
            return buf;
        } catch {
            const size = disk.get(relOf(key)) ?? 0;
            disk.delete(relOf(key));
            diskBytes -= size;
            return null;
        }
    }
    /** Makes the WebPs of the queue, one at a time, from the CDN's images in memory (asked again if they left). */
    async function makeAll() {
        if (making) {
            return;
        }
        making = true;
        try {
            while (queue.length && webpOn) {
                const key = queue.shift();
                queued.delete(key);
                try {
                    const src = await image(key);
                    if (!src) {
                        continue;
                    }
                    const small = await toWebp(src);
                    if (!isWebp(small) || small.length >= src.length) {
                        noWebp.set(key, now());
                        continue;
                    }
                    keep(`${key}#webp`, small);
                    drop(key);
                    writeDisk(key, small);
                } catch (e) {
                    if (e?.code === 'ENOENT') {
                        webpOn = false;
                        console.error('window: cwebp is not installed, so card art goes out as the CDN has it');
                    } else {
                        noWebp.set(key, now());
                        console.error(`window: card art ${key} not made smaller: ${e.message}`);
                    }
                }
            }
        } finally {
            making = false;
        }
    }
    function later(key) {
        const no = noWebp.get(key);
        if (!webpOn || queued.has(key) || (no !== undefined && now() - no < MISS_MS)) {
            return;
        }
        queue.push(key);
        queued.add(key);
        makeAll().catch(() => undefined);
    }

    async function route(req, res, url, who) {
        const m = PATH.exec(url.pathname);
        if (!m) {
            return false;
        }
        const send = (code, text) => {
            res.writeHead(code, { 'content-type': 'text/plain', 'cache-control': 'no-cache' });
            res.end(text);
            return true;
        };
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return send(405, 'GET only');
        }
        if (!who.login && !atLeast(who.role, 'friend')) {
            return send(401, 'sign in with GitHub first');
        }
        const key = `${m[1]}/${m[2]}${m[3] ?? ''}.png`;
        // the answer depends on what the browser takes, once WebPs are made
        const vary = webpOn ? { vary: 'accept' } : {};
        // named with a q above 0: a wildcard alone never gets one, so a browser that cannot show WebP never does
        const wants = webpOn && accepts(req.headers?.accept, ['image/webp'], false);
        const small = wants ? await webp(key) : null;
        if (small) {
            res.writeHead(200, { ...WEBP, ...vary, 'content-length': String(small.length) });
            res.end(req.method === 'HEAD' ? undefined : small);
            return true;
        }
        let buf;
        try {
            buf = await image(key);
        } catch (e) {
            console.error(`window: card art ${url.pathname}: ${e.message}`);
            return send(502, 'the card art did not come');
        }
        if (!buf) {
            res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'public, max-age=3600' });
            res.end('no art for this card');
            return true;
        }
        if (wants) {
            later(key);
        }
        res.writeHead(200, { ...IMAGE, ...vary, 'content-length': String(buf.length) });
        res.end(req.method === 'HEAD' ? undefined : buf);
        return true;
    }

    /** Resolves once every WebP asked for so far is made (or given up): for tests. */
    async function settled() {
        while (making || queue.length) {
            await new Promise((r) => setTimeout(r, 5));
        }
    }

    return { route, settled, stats: () => ({ kept: kept.size, bytes, missing: missing.size, disk: disk ? disk.size : null, diskBytes }) };
}

module.exports = { createArt, PATH, imageSize, cwebp };
