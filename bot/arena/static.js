'use strict';
/**
 * Sending the same bytes many times, cheaply: the window's app page (2.8 MB, the viewer kit inside), the viewer kit
 * itself, small scripts, and the app's model (/api/app, which every open tab asks for every 15 s). Each is gzipped
 * once per change, not on every request, and carries an ETag, so a browser that has it already gets a 304 with no
 * body. With `cache-control: no-cache` the browser still asks each time, so a deploy or a new model shows at once.
 *
 *   const files = createStatic({ transform });   // transform(buf, type): e.g. the feedback script into HTML pages
 *   files.send(req, res, file, type)            // false when the file is missing
 *   sendCached(req, res, entry)                 // entry: cached({raw, type})
 */
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

/** A weak ETag for these bytes (the gzipped and the plain copy are the same content). */
const etagOf = (buf) => `W/"${crypto.createHash('sha256').update(buf).digest('base64url').slice(0, 27)}"`;

/** True when the request's If-None-Match names this ETag (weak comparison; a list, or *). */
function notModified(req, etag) {
    const h = String(req.headers['if-none-match'] ?? '').trim();
    if (!h || !etag) {
        return false;
    }
    const bare = (t) => t.trim().replace(/^W\//, '');
    return h === '*' || h.split(',').some((t) => bare(t) === bare(etag));
}

const gzipOk = (req) => /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));

/** {raw, gz, etag, type} for bytes sent many times: gzipped once (null when too small to gain). */
function cached(raw, type) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    return { raw: buf, gz: buf.length > 1024 ? zlib.gzipSync(buf) : null, etag: etagOf(buf), type };
}

/**
 * Sends a cached entry: 304 when the browser has these bytes, else the gzip (when the browser takes it) or the bytes.
 * headers: added to both (cache-control defaults to no-cache: the browser asks again each time, and gets a 304).
 */
function sendCached(req, res, entry, { headers = {}, acceptsGzip = gzipOk } = {}) {
    const common = { 'cache-control': 'no-cache', vary: 'accept-encoding', etag: entry.etag, ...headers };
    if (notModified(req, entry.etag)) {
        res.writeHead(304, common);
        return res.end();
    }
    const gz = entry.gz && acceptsGzip(req);
    const body = gz ? entry.gz : entry.raw;
    res.writeHead(200, { 'content-type': entry.type, ...common, 'content-length': String(body.length), ...(gz ? { 'content-encoding': 'gzip' } : {}) });
    return res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * Files from disk, each kept (bytes, gzip, ETag) until its size or mtime changes; at most `max` files. transform(buf,
 * type) changes the bytes once, before they are kept.
 */
function createStatic({ transform = (buf) => buf, max = 16, acceptsGzip = gzipOk } = {}) {
    const kept = new Map(); // file -> {mtimeMs, size, entry}, least recently used first

    function load(file, type) {
        let st;
        try {
            st = fs.statSync(file);
        } catch {
            return null;
        }
        if (!st.isFile()) {
            return null;
        }
        const hit = kept.get(file);
        kept.delete(file);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.entry.type === type) {
            kept.set(file, hit);
            return hit.entry;
        }
        let raw;
        try {
            raw = fs.readFileSync(file);
        } catch {
            return null;
        }
        const entry = cached(transform(raw, type), type);
        kept.set(file, { mtimeMs: st.mtimeMs, size: st.size, entry });
        if (kept.size > max) {
            kept.delete(kept.keys().next().value);
        }
        return entry;
    }

    /** Sends the file (headers as sendCached takes them); false when there is no such file. */
    function send(req, res, file, type, headers = {}) {
        const entry = load(file, type);
        if (!entry) {
            return false;
        }
        sendCached(req, res, entry, { headers, acceptsGzip });
        return true;
    }

    return { send, load };
}

module.exports = { createStatic, sendCached, cached, notModified, etagOf };
