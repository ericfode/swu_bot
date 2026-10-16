'use strict';
/**
 * Files the window sends as they are on its disk (the app, the viewer kit and its license list, the pages' scripts):
 * compressed once, not for every request, and answered with 304 Not Modified when the browser already has them.
 * Before 2026-10-16 the app page (2.7 MB) and the kit (2.4 MB) were gzipped again on every visit (~75 ms of the
 * window's one CPU each) and sent in full every time (~0.8 and ~0.7 MB), since nothing told a browser it had them.
 *
 *   const statics = createStatic();
 *   await statics.send(req, res, file, type, { headers, transform })   // false when there is no such file
 *
 * A file is read again when its size or time changes; transform (feedback.inject for pages) runs once on its text. A
 * browser that takes brotli gets it once the window has made it (in the background, the first time), else gzip, else
 * the file as it is. The ETag names the content, so a reload costs one small request; cache-control stays no-cache,
 * since these URLs stay the same when the file changes. compress() and pickEncoding() are the same rules for the
 * parts that keep their own copies (swarm-relay.js: the engine pack and bot bundles).
 */
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

const MIN = 1024; // smaller than this is sent as it is

/**
 * Whether an Accept-Encoding header takes one of `tokens`: such an entry (else *) whose q value is above 0. server.js
 * acceptsGzip is the same rule for gzip; brotli is taken only when named, as browsers name it.
 */
function accepts(header, tokens, star = true) {
    let hit = null;
    let any = null;
    for (const part of String(header ?? '').toLowerCase().split(',')) {
        const [token, ...params] = part.split(';').map((x) => x.trim());
        const q = params.find((x) => x.startsWith('q='));
        const ok = !q || Number(q.slice(2)) > 0;
        if (tokens.includes(token)) {
            hit = ok;
        } else if (token === '*') {
            any = ok;
        }
    }
    return hit ?? (star ? any : null) ?? false;
}

/** The coding to send: 'br' or 'gzip' when the request takes it and `have` (which codings exist) has it, else null. */
function pickEncoding(req, have) {
    const header = req.headers['accept-encoding'];
    if (have.br && accepts(header, ['br'], false)) {
        return 'br';
    }
    return have.gz && accepts(header, ['gzip', 'x-gzip']) ? 'gzip' : null;
}

// brotli's best level takes ~5 s on a 2.7 MB file and ~16 s on the 10 MB engine pack, so big files get a lower one:
// the app page is 622 KB at 11, 633 KB at 10 (2 s), 676 KB at 9 (0.3 s); the engine pack 935 KB at 11, 1.04 MB at 9
const brotliLevel = (n) => (n <= 1e6 ? 11 : n <= 4e6 ? 10 : 9);

/** bytes compressed with `coding` ('br' or 'gzip'), off the event loop (zlib's thread pool). */
function compress(bytes, coding) {
    return new Promise((resolve, reject) => {
        const done = (e, b) => (e ? reject(e) : resolve(b));
        if (coding === 'br') {
            zlib.brotliCompress(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brotliLevel(bytes.length), [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }, done);
        } else {
            zlib.gzip(bytes, { level: 9 }, done);
        }
    });
}

/** Whether an If-None-Match header names `etag` (weak comparison, as RFC 9110 says for it). */
function matches(header, etag) {
    if (!header) {
        return false;
    }
    const bare = (t) => t.trim().replace(/^W\//, '');
    return header.trim() === '*' || header.split(',').some((t) => bare(t) === bare(etag));
}

function createStatic({ log = console } = {}) {
    const entries = new Map(); // file (+ '#t' when transformed) -> {key, ready: Promise<{raw, etag, gz, br} | null>}

    function entry(file, transform) {
        let st;
        try {
            st = fs.statSync(file);
        } catch {
            return Promise.resolve(null);
        }
        if (!st.isFile()) {
            return Promise.resolve(null);
        }
        const id = transform ? `${file}#t` : file;
        const key = `${st.size}:${st.mtimeMs}`;
        const have = entries.get(id);
        if (have && have.key === key) {
            return have.ready;
        }
        const ready = (async () => {
            let raw = await fs.promises.readFile(file);
            if (transform) {
                raw = Buffer.from(transform(raw.toString('utf8')), 'utf8');
            }
            const e = { raw, etag: `W/"${crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 27)}"`, gz: null, br: null, made: Promise.resolve() };
            if (raw.length >= MIN) {
                e.gz = await compress(raw, 'gzip');
                // brotli is slower to make: gzip until it is ready
                e.made = compress(raw, 'br').then((b) => {
                    e.br = b;
                }, (err) => log.error(`window: brotli of ${file}: ${err.message}`));
            }
            return e;
        })().catch(() => {
            entries.delete(id);
            return null; // gone between stat and read
        });
        entries.set(id, { key, ready });
        return ready;
    }

    /**
     * Sends `file` as `type` (with `headers`, and cache-control `cache`), or answers 304 when the request's
     * If-None-Match names it; false when there is no such file. transform: (text) => text, run once per version.
     */
    async function send(req, res, file, type, { headers = {}, transform = null, cache = 'no-cache' } = {}) {
        const e = await entry(file, transform);
        if (!e) {
            return false;
        }
        const base = { 'content-type': type, 'cache-control': cache, vary: 'accept-encoding', etag: e.etag, ...headers };
        if (matches(req.headers['if-none-match'], e.etag)) {
            res.writeHead(304, base);
            res.end();
            return true;
        }
        const coding = pickEncoding(req, { br: !!e.br, gz: !!e.gz });
        const body = coding === 'br' ? e.br : coding === 'gzip' ? e.gz : e.raw;
        res.writeHead(200, { ...base, 'content-length': String(body.length), ...(coding ? { 'content-encoding': coding } : {}) });
        res.end(req.method === 'HEAD' ? undefined : body);
        return true;
    }

    /** Resolves once `file` is read and gzipped, and its brotli is made: for tests and for warming up at start. */
    async function ready(file, { transform = null } = {}) {
        const e = await entry(file, transform);
        await e?.made;
        return e;
    }

    return { send, ready };
}

module.exports = { createStatic, compress, pickEncoding, accepts, matches };
