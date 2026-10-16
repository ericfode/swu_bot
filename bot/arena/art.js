'use strict';
/**
 * Card art through the window, for its cross-origin isolated pages (/play and /tables). An arena bot's stdin is a
 * SharedArrayBuffer, so those pages are isolated, with COEP require-corp: the one mode Safari has (it has no
 * credentialless). Under require-corp a page loads an image from another site only when that site allows it (a CORP or
 * CORS header), and swu-db's CDN sends neither. So the pages point the viewer kit's art at /art/ (setArtResolver) and the
 * window fetches the same image from the CDN.
 *
 *   const art = createArt();
 *   if (await art.route(req, res, url, who)) return;
 *
 *   GET /art/<SET>/<NNN>.png      a card's image, as https://cdn.swu-db.com/images/cards/<SET>/<NNN>.png
 *   GET /art/<SET>/<NNN>-b.png    the deployed side of a leader
 *
 * For anyone signed in with GitHub, a view link's guest, or a token: the images are public, but the window is no open
 * mirror. They never change, so browsers keep them a year. The window keeps the latest ones in memory (maxBytes) and
 * none on disk (the volume holds the replays). An image the CDN does not have (tokens, sets it has no art for yet)
 * answers 404, and the window remembers that for an hour, so a game asks the CDN once per card.
 */
const { atLeast } = require('./auth');

const CDN = 'https://cdn.swu-db.com/images/cards';
// set codes as the card data has them (SOR, TS26, IC27, ...), three-digit numbers
const PATH = /^\/art\/([A-Z0-9]{2,6})\/(\d{3})(-b)?\.png$/;
const MAX_BYTES = 48e6; // kept in memory: ~180 cards at ~260 KB
const MAX_IMAGE = 4e6;
const MISS_MS = 3600e3;
const TIMEOUT_MS = 15000;
const IMAGE = { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable', 'cross-origin-resource-policy': 'same-origin' };

function createArt({ fetchImpl = fetch, maxBytes = MAX_BYTES, now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
    const kept = new Map(); // key -> Buffer, least recently used first
    let bytes = 0;
    const missing = new Map(); // key -> when the CDN said it has no such image
    const pending = new Map(); // key -> Promise<Buffer | null>, so a page asking for one card twice fetches it once

    const keep = (key, buf) => {
        if (buf.length > maxBytes) {
            return;
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

    function image(key) {
        const have = kept.get(key);
        if (have) {
            kept.delete(key);
            kept.set(key, have);
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
        let buf;
        try {
            buf = await image(`${m[1]}/${m[2]}${m[3] ?? ''}.png`);
        } catch (e) {
            console.error(`window: card art ${url.pathname}: ${e.message}`);
            return send(502, 'the card art did not come');
        }
        if (!buf) {
            res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'public, max-age=3600' });
            res.end('no art for this card');
            return true;
        }
        res.writeHead(200, { ...IMAGE, 'content-length': String(buf.length) });
        res.end(req.method === 'HEAD' ? undefined : buf);
        return true;
    }

    return { route, stats: () => ({ kept: kept.size, bytes, missing: missing.size }) };
}

module.exports = { createArt, PATH };
