'use strict';
/**
 * The window's side of the browser swarm (spec/executor.md, bot/swarm/README.md): the /swarm page, the tab's files,
 * and /api/swarm/*, which relays a signed-in person's tab to the games machine's helper API (port 8090 on its private
 * address) with the swarm's own helper token. Only people signed in with GitHub and invited (role friend or admin) may
 * use it; a view link's guest may not.
 *
 *   const swarm = createSwarmRelay({ token, machine, cacheDir });
 *   if (await swarm.route(req, res, url, who, helpers)) return;   // helpers: {sendJson, sendText, readBody}
 *
 * The window remembers which person holds which lease, and passes a person's heartbeats, results and bundle downloads
 * only for leases that person holds. Slot ids become <login>-<n>, so the machine's log can tell people apart. The tab's
 * files come from the machine (built with its image, so their build always matches it) and are kept on the window's
 * disk by build, so a sleeping machine does not stop a page from loading once it has been seen.
 * Off (every route answers 503 or the page says so) unless SWARM_HELPER_TOKEN is set.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FILES = {
    'manifest.json': 'application/json',
    'engine.json': 'application/json',
    'python-lib.json': 'application/json',
    'python.wasm': 'application/wasm',
    'referee-worker.js': 'text/javascript',
    'bot-worker.js': 'text/javascript',
    'executor-worker.js': 'text/javascript'
};
// cross-origin isolation, which SharedArrayBuffer needs (a bot blocks on its stdin): the page and its workers
const ISOLATED = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin' };
const HEX = /^[0-9a-f]{64}$/;
const LEASE = /^[A-Za-z0-9_-]{1,64}$/;
const LEASE_TTL_MS = 6 * 3600 * 1000;
const RESULT_MAX = 48 << 20;

function createSwarmRelay({ token = process.env.SWARM_HELPER_TOKEN || null, machine = process.env.SWARM_GAMES_URL || 'http://swu-arena-games.internal:8090', cacheDir = null, page = path.join(__dirname, 'web', 'swarm.html'), fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    const leases = new Map(); // lease id -> {login, bundles, at}
    let manifest = null; // {build, cards, at}

    const forget = () => {
        for (const [id, l] of leases) {
            if (now() - l.at > LEASE_TTL_MS) {
                leases.delete(id);
            }
        }
    };

    async function toMachine(method, p, { body = null, build = manifest?.build ?? null, timeoutMs = 60000, raw = false } = {}) {
        const headers = { authorization: `Bearer ${token}` };
        if (build) {
            headers['x-helper-build'] = build;
        }
        if (body !== null) {
            headers['content-type'] = 'application/json';
        }
        const r = await fetchImpl(`${machine}${p}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
        const bytes = Buffer.from(await r.arrayBuffer());
        return { status: r.status, type: r.headers.get('content-type') || 'application/json', bytes, json: raw ? null : (() => {
            try {
                return bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
            } catch {
                return null;
            }
        })() };
    }

    /** The machine's swarm manifest ({build, cards}), at most a minute old; null when the machine does not answer. */
    async function currentManifest() {
        if (manifest && now() - manifest.at < 60000) {
            return manifest;
        }
        try {
            const r = await toMachine('GET', '/v1/swarm/manifest.json', { build: null, timeoutMs: 8000 });
            if (r.status === 200 && r.json?.build) {
                manifest = { build: String(r.json.build), cards: String(r.json.cards), at: now() };
                return manifest;
            }
        } catch {
            // asleep, or no address while it is stopped
        }
        return null;
    }

    /** A swarm file of `build`, from the window's disk or else the machine (then kept). */
    async function swarmFile(build, name) {
        const dir = cacheDir && path.join(cacheDir, build);
        const file = dir && path.join(dir, name);
        if (file && fs.existsSync(file)) {
            return fs.readFileSync(file);
        }
        const r = await toMachine('GET', `/v1/swarm/${name}`, { build: null, timeoutMs: 120000, raw: true });
        if (r.status !== 200) {
            return null;
        }
        if (dir) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(`${file}.tmp`, r.bytes);
            fs.renameSync(`${file}.tmp`, file);
            // keep only this build's files
            for (const old of fs.readdirSync(cacheDir)) {
                if (old !== build) {
                    fs.rmSync(path.join(cacheDir, old), { recursive: true, force: true });
                }
            }
        }
        return r.bytes;
    }

    const slotOf = (login, slot) => `${String(login).toLowerCase().replace(/[^a-z0-9_-]/g, '')}-${String(slot).replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 32);

    async function route(req, res, url, who, { sendJson, sendText, readBody }) {
        const p = url.pathname;
        if (p !== '/swarm' && !p.startsWith('/swarm/') && !p.startsWith('/api/swarm/')) {
            return false;
        }
        // a person signed in on this site with GitHub and invited: not a view link's guest, not an app's or a feed's token
        const person = who.via === 'cookie' && who.login && !who.guest && (who.role === 'friend' || who.role === 'admin') ? who.login : null;
        const fail = (code, status, message) => sendJson(res, status, { error: { code, message } }, req);
        if (!person) {
            if (p === '/swarm') {
                sendText(res, req, 403, 'text/plain; charset=utf-8', 'The swarm is for people signed in with GitHub and invited to the arena.');
                return true;
            }
            fail('forbidden', 403, 'the swarm is for people signed in with GitHub and invited to the arena');
            return true;
        }
        if (p === '/swarm') {
            sendText(res, req, 200, 'text/html; charset=utf-8', fs.readFileSync(page, 'utf8'), ISOLATED);
            return true;
        }
        if (!token) {
            fail('unavailable', 503, 'the swarm is off (no SWARM_HELPER_TOKEN on the window)');
            return true;
        }
        const file = /^\/swarm\/([a-z0-9.-]+)$/.exec(p);
        if (file && req.method === 'GET') {
            if (!Object.hasOwn(FILES, file[1])) {
                sendText(res, req, 404, 'text/plain', 'not found');
                return true;
            }
            const m = await currentManifest();
            const build = url.searchParams.get('b') || m?.build;
            if (!build || !/^[0-9a-zA-Z._-]{1,64}$/.test(build)) {
                fail('unavailable', 503, 'the games machine is asleep: the swarm starts with the next round');
                return true;
            }
            const bytes = await swarmFile(build, file[1]).catch(() => null);
            if (!bytes) {
                fail('unavailable', 503, 'the games machine is asleep: the swarm starts with the next round');
                return true;
            }
            // the URL names the build, so a file never changes: browsers keep it
            const gzip = /gzip/.test(req.headers['accept-encoding'] || '') && FILES[file[1]] !== 'application/wasm';
            res.writeHead(200, { 'content-type': FILES[file[1]], 'cache-control': 'private, max-age=86400, immutable', vary: 'accept-encoding', ...ISOLATED, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
            res.end(gzip ? zlib.gzipSync(bytes) : bytes);
            return true;
        }
        const api = /^\/api\/swarm\/(info|hello|claim|bundle\/([0-9a-f]{64})|lease\/([A-Za-z0-9_-]{1,64})\/(heartbeat|result))$/.exec(p);
        if (!api) {
            fail('not_found', 404, 'unknown swarm path');
            return true;
        }
        forget();
        try {
            if (api[1] === 'info') {
                const m = await currentManifest();
                const q = m ? `?b=${encodeURIComponent(m.build)}` : '';
                sendJson(res, 200, { on: true, ready: !!m, build: m?.build ?? null, cards: m?.cards ?? null, login: person,
                    files: { pack: `/swarm/engine.json${q}`, referee: `/swarm/referee-worker.js${q}`, bot: `/swarm/bot-worker.js${q}`, executor: `/swarm/executor-worker.js${q}`, pythonLib: `/swarm/python-lib.json${q}`, pythonWasm: `/swarm/python.wasm${q}` },
                    ...(m ? {} : { why: 'the games machine is asleep: the swarm starts with the next round' }) }, req);
                return true;
            }
            if (req.method !== 'POST' && !api[2]) {
                fail('bad_request', 405, 'POST only');
                return true;
            }
            if (api[1] === 'hello') {
                const body = await readBody(req, 4096);
                const r = await toMachine('POST', '/v1/hello', { body, build: safeJson(body)?.build ?? manifest?.build });
                return pass(res, req, r, sendText);
            }
            if (api[1] === 'claim') {
                const body = safeJson(await readBody(req, 4096));
                const r = await toMachine('POST', '/v1/claim', { body: JSON.stringify({ slot: slotOf(person, body?.slot ?? '1') }), timeoutMs: 70000 });
                if (r.status === 200 && r.json && LEASE.test(String(r.json.lease))) {
                    leases.set(String(r.json.lease), { login: person, bundles: new Set((r.json.bundles ?? []).filter((h) => HEX.test(h))), at: now() });
                }
                return pass(res, req, r, sendText);
            }
            if (api[2]) {
                const mine = [...leases.values()].some((l) => l.login === person && l.bundles.has(api[2]));
                if (!mine) {
                    fail('not_found', 404, 'not a bundle of a seed you hold');
                    return true;
                }
                const r = await toMachine('GET', `/v1/bundle/${api[2]}`, { raw: true, timeoutMs: 120000 });
                res.writeHead(r.status, { 'content-type': r.type, ...ISOLATED });
                res.end(r.bytes);
                return true;
            }
            const id = api[3];
            const l = leases.get(id);
            if (!l || l.login !== person) {
                fail('gone', 410, 'not a seed you hold');
                return true;
            }
            const body = await readBody(req, api[4] === 'result' ? RESULT_MAX : 4096);
            const r = await toMachine('POST', `/v1/lease/${id}/${api[4]}`, { body: body.length ? body : '{}', timeoutMs: api[4] === 'result' ? 180000 : 30000 });
            if (api[4] === 'result' || r.status === 410) {
                leases.delete(id);
            } else {
                l.at = now();
            }
            return pass(res, req, r, sendText);
        } catch (e) {
            if (e?.code && e.name !== 'TimeoutError' && e.name !== 'AbortError' && e.name !== 'TypeError') {
                throw e; // the window's own errors (a body too large) are the window's to answer
            }
            fail('unavailable', 503, `the games machine did not answer (${String(e?.message ?? e).slice(0, 80)})`);
            return true;
        }
    }

    return { route, leases, on: () => !!token };
}

function safeJson(text) {
    try {
        return JSON.parse(String(text));
    } catch {
        return null;
    }
}

/** The machine's answer as it came (status, type, body); a 204 has no body. */
function pass(res, req, r, sendText) {
    if (r.status === 204) {
        res.writeHead(204, ISOLATED);
        res.end();
        return true;
    }
    sendText(res, req, r.status, r.type, r.bytes.toString('utf8'), ISOLATED);
    return true;
}

module.exports = { createSwarmRelay, FILES };
