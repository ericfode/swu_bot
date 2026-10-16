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
 *
 * The play page (tables.js, /tables) plays arena bots in a person's tab: lineup() is the latest round's versions with
 * their bundles ({round, capMs, bots: [{name, bundle, bytes}]}, the machine's GET /v1/swarm/lineup.json) and sendBot()
 * sends one of those bundles (GET /v1/swarm/bot/<hex>). Both are kept on the window's disk (botDir), and a new lineup's
 * bundles are fetched at once, so the bots stay playable while the machine sleeps. botHere(hex) is a bundle the window
 * has now, without fetching it.
 */
const crypto = require('crypto');
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
    'executor-worker.js': 'text/javascript',
    'tables-worker.js': 'text/javascript',
    // the JEPA bot's models (bot/swarm/pack.js MODELS), downloaded only by a person who picks that bot
    'tx-t10.safetensors': 'application/octet-stream',
    'tx-t10-e.safetensors': 'application/octet-stream'
};
// cross-origin isolation, which SharedArrayBuffer needs (a bot blocks on its stdin): the page and its workers
const ISOLATED = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin' };
const HEX = /^[0-9a-f]{64}$/;
const LEASE = /^[A-Za-z0-9_-]{1,64}$/;
const LEASE_TTL_MS = 6 * 3600 * 1000;
const RESULT_MAX = 48 << 20;

function createSwarmRelay({ token = process.env.SWARM_HELPER_TOKEN || null, machine = process.env.SWARM_GAMES_URL || 'http://swu-arena-games.internal:8090', cacheDir = null, botDir = null, page = path.join(__dirname, 'web', 'swarm.html'), fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    const leases = new Map(); // lease id -> {login, bundles, at}
    const tabs = new Map(); // login -> {at, slots: Set}: who asked for seeds lately, for the page's picture of the swarm
    let manifest = null; // {build, cards, at}
    const memory = new Map(); // swarm files when there is no cache folder (tests, the dev server)

    const forget = () => {
        for (const [id, l] of leases) {
            if (now() - l.at > LEASE_TTL_MS) {
                leases.delete(id);
            }
        }
    };

    async function toMachine(method, p, { body = null, build = null, timeoutMs = 60000, raw = false } = {}) {
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

    /** The machine's swarm manifest ({build, cards, sizes}), at most a minute old; null when the machine does not answer. */
    async function currentManifest() {
        if (manifest && now() - manifest.at < 60000) {
            return manifest;
        }
        try {
            const r = await toMachine('GET', '/v1/swarm/manifest.json', { build: null, timeoutMs: 8000 });
            if (r.status === 200 && r.json?.build) {
                // sizes and gz: each file's bytes and about what it is gzipped (bot/swarm/build.js), for the play page
                const map = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
                manifest = { build: String(r.json.build), cards: String(r.json.cards), sizes: map(r.json.sizes), gz: map(r.json.gz), at: now() };
                return manifest;
            }
        } catch {
            // asleep, or no address while it is stopped
        }
        return null;
    }

    /**
     * A swarm file of `build` and its gzip: {raw, gz} (paths on the window's disk, or buffers when there is no disk), or
     * null. It is fetched from the machine only when `build` is the machine's build now, so one build's bytes are never
     * kept under another's name; an older build's files are served while the window still has them. Only the newest
     * build is kept. A fetch in progress is shared by the requests that wait for it.
     */
    const pending = new Map();
    function swarmFile(build, name, current) {
        const dir = cacheDir && path.join(cacheDir, build);
        if (dir && fs.existsSync(path.join(dir, `${name}.gz`)) && fs.existsSync(path.join(dir, name))) {
            return Promise.resolve({ raw: path.join(dir, name), gz: path.join(dir, `${name}.gz`) });
        }
        if (!dir && memory.has(`${build}/${name}`)) {
            return Promise.resolve(memory.get(`${build}/${name}`));
        }
        if (build !== current) {
            return Promise.resolve(null);
        }
        const key = `${build}/${name}`;
        if (!pending.has(key)) {
            pending.set(key, (async () => {
                const r = await toMachine('GET', `/v1/swarm/${name}`, { build: null, timeoutMs: 120000, raw: true });
                if (r.status !== 200) {
                    return null;
                }
                // made once per build, off the event loop (zlib's thread pool), not on every request
                const gz = await new Promise((resolve, reject) => zlib.gzip(r.bytes, { level: 6 }, (e, b) => (e ? reject(e) : resolve(b))));
                if (!dir) {
                    const v = { raw: r.bytes, gz };
                    memory.set(key, v);
                    return v;
                }
                fs.mkdirSync(dir, { recursive: true });
                for (const [f, bytes] of [[name, r.bytes], [`${name}.gz`, gz]]) {
                    fs.writeFileSync(path.join(dir, `${f}.tmp`), bytes);
                    fs.renameSync(path.join(dir, `${f}.tmp`), path.join(dir, f));
                }
                for (const old of fs.readdirSync(cacheDir)) {
                    if (old !== build) {
                        fs.rmSync(path.join(cacheDir, old), { recursive: true, force: true });
                    }
                }
                return { raw: path.join(dir, name), gz: path.join(dir, `${name}.gz`) };
            })().finally(() => pending.delete(key)));
        }
        return pending.get(key);
    }

    /**
     * The bytes of swarm file `name` of `build` (gz: of its gzip, what a browser downloads), from the window's disk or
     * the machine's manifest, or null.
     */
    function fileSize(build, name, { gz = false } = {}) {
        const raw = cacheDir && /^[0-9a-zA-Z._-]{1,64}$/.test(build) && Object.hasOwn(FILES, name) ? path.join(cacheDir, build, gz ? `${name}.gz` : name) : null;
        const st = raw ? fs.statSync(raw, { throwIfNoEntry: false }) : null;
        if (st?.isFile()) {
            return st.size;
        }
        const n = manifest?.build === build ? manifest[gz ? 'gz' : 'sizes']?.[name] : null;
        return Number.isSafeInteger(n) ? n : null;
    }

    /** The build whose files the window has on its disk (only the newest is kept), or null: what a page loads while the machine sleeps. */
    function cachedBuild(names) {
        if (!cacheDir || !fs.existsSync(cacheDir)) {
            return null;
        }
        const ok = fs.readdirSync(cacheDir).filter((b) => /^[0-9a-zA-Z._-]{1,64}$/.test(b) && names.every((n) => fs.existsSync(path.join(cacheDir, b, `${n}.gz`))));
        return ok.length === 1 ? ok[0] : null;
    }

    /**
     * Sends swarm file `name` of the build in ?b= (default the machine's now) with the headers the swarm's files carry,
     * or an error: true once it answered. The play page (tables.js) loads its files this way too.
     */
    async function sendFile(req, res, url, name, { sendJson, sendText }) {
        const fail = (code, status, message) => sendJson(res, status, { error: { code, message } }, req);
        if (!Object.hasOwn(FILES, name)) {
            sendText(res, req, 404, 'text/plain', 'not found');
            return true;
        }
        const m = await currentManifest();
        const build = url.searchParams.get('b') || m?.build;
        if (!build || !/^[0-9a-zA-Z._-]{1,64}$/.test(build)) {
            fail('unavailable', 503, 'the games machine is asleep: the swarm starts with the next round');
            return true;
        }
        const f = await swarmFile(build, name, m?.build ?? null).catch(() => null);
        if (!f) {
            // an older build than the machine's (reload the page), or a machine that does not answer
            fail(m && build !== m.build ? 'build' : 'unavailable', m && build !== m.build ? 409 : 503, m && build !== m.build ? 'the games machine runs a newer build: reload the page' : 'the games machine is asleep: the swarm starts with the next round');
            return true;
        }
        // the URL names the build, so a file never changes: browsers keep it
        const gzip = /gzip/.test(req.headers['accept-encoding'] || '');
        const body = gzip ? f.gz : f.raw;
        // x-raw-length: the bytes the page reads once the browser has unzipped them (its progress bar's total)
        const lengthOf = (b) => (typeof b === 'string' ? fs.statSync(b).size : b.length);
        res.writeHead(200, { 'content-type': FILES[name], 'cache-control': 'private, max-age=86400, immutable', vary: 'accept-encoding', 'content-length': String(lengthOf(body)), 'x-raw-length': String(lengthOf(f.raw)), ...ISOLATED, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
        if (typeof body === 'string') {
            fs.createReadStream(body).pipe(res);
        } else {
            res.end(body);
        }
        return true;
    }

    /** Fetches the machine's files `names` of its build now into the window's cache, so they load while it sleeps. */
    async function keep(names) {
        const m = await currentManifest();
        if (m) {
            await Promise.all(names.map((n) => swarmFile(m.build, n, m.build).catch(() => null)));
        }
        return m;
    }

    // ---- arena bots for a person's tab: the lineup and its bundles, kept on the window's disk ----
    let lineupSeen = null; // {at, data}
    const botMemory = new Map(); // hex -> {raw, gz} when there is no bot folder (tests)
    const botPending = new Map();
    const lineupFile = () => botDir && path.join(botDir, 'lineup.json');
    const readLineup = () => {
        try {
            return lineupFile() ? JSON.parse(fs.readFileSync(lineupFile(), 'utf8')) : null;
        } catch {
            return null;
        }
    };
    const cleanLineup = (j) => ({
        round: Number.isInteger(j?.round) ? j.round : null,
        // the round's time per bot per game, which a tab plays its bots under
        capMs: Number.isSafeInteger(j?.capMs) && j.capMs >= 1000 ? j.capMs : null,
        bots: (Array.isArray(j?.bots) ? j.bots : []).filter((b) => b && /^[a-z][a-z0-9_]*-v\d+$/.test(String(b.name)) && HEX.test(String(b.bundle)))
            .map((b) => ({ name: String(b.name), bundle: String(b.bundle), bytes: Number.isSafeInteger(b.bytes) ? b.bytes : null })),
        at: new Date(now()).toISOString()
    });

    /** The latest round's versions with their bundles: {round, bots, at}; the machine's at most a minute old, else the window's last copy, else null. */
    async function lineup() {
        if (lineupSeen && now() - lineupSeen.at < 60000) {
            return lineupSeen.data;
        }
        if (token) {
            try {
                const r = await toMachine('GET', '/v1/swarm/lineup.json', { timeoutMs: 8000 });
                if (r.status === 200 && Array.isArray(r.json?.bots)) {
                    const data = cleanLineup(r.json);
                    lineupSeen = { at: now(), data };
                    if (botDir) {
                        fs.mkdirSync(botDir, { recursive: true });
                        fs.writeFileSync(`${lineupFile()}.tmp`, JSON.stringify(data));
                        fs.renameSync(`${lineupFile()}.tmp`, lineupFile());
                    }
                    // every bundle of the lineup now, so the bots play while the machine sleeps; the rest go
                    keepBots(data).catch(() => undefined);
                    return data;
                }
            } catch {
                // asleep, or no address while it is stopped
            }
        }
        const disk = readLineup();
        if (disk) {
            lineupSeen = { at: now() - 50000, data: disk }; // asked again in 10 s, not on every request
        }
        return disk;
    }

    /** Bundle `hex` and its gzip as the window has them now ({raw, gz}: paths, or buffers with no bot folder), else null. */
    function botHere(hex) {
        if (!HEX.test(String(hex))) {
            return null;
        }
        if (!botDir) {
            return botMemory.get(hex) ?? null;
        }
        const raw = path.join(botDir, `${hex}.tar`);
        return fs.existsSync(`${raw}.gz`) && fs.existsSync(raw) ? { raw, gz: `${raw}.gz` } : null;
    }

    /** Bundle `hex` and its gzip ({raw, gz}: paths, or buffers with no bot folder), fetched from the machine once; null when it has none. */
    function botFile(hex) {
        const here = botHere(hex);
        if (here) {
            return Promise.resolve(here);
        }
        const raw = botDir && path.join(botDir, `${hex}.tar`);
        if (!token) {
            return Promise.resolve(null);
        }
        if (!botPending.has(hex)) {
            botPending.set(hex, (async () => {
                const r = await toMachine('GET', `/v1/swarm/bot/${hex}`, { timeoutMs: 120000, raw: true });
                if (r.status !== 200 || crypto.createHash('sha256').update(r.bytes).digest('hex') !== hex) {
                    return null;
                }
                const gz = await new Promise((resolve, reject) => zlib.gzip(r.bytes, { level: 6 }, (e, b) => (e ? reject(e) : resolve(b))));
                if (!botDir) {
                    const v = { raw: r.bytes, gz };
                    botMemory.set(hex, v);
                    return v;
                }
                fs.mkdirSync(botDir, { recursive: true });
                for (const [f, bytes] of [[raw, r.bytes], [`${raw}.gz`, gz]]) {
                    fs.writeFileSync(`${f}.tmp`, bytes);
                    fs.renameSync(`${f}.tmp`, f);
                }
                return { raw, gz: `${raw}.gz` };
            })().catch(() => null).finally(() => botPending.delete(hex)));
        }
        return botPending.get(hex);
    }

    /** Fetches every bundle of `data` (a lineup) to the window's disk and drops the bundles no lineup names now. */
    async function keepBots(data) {
        const want = new Set(data.bots.map((b) => b.bundle));
        for (const hex of want) {
            await botFile(hex);
        }
        if (botDir && fs.existsSync(botDir)) {
            for (const f of fs.readdirSync(botDir)) {
                const m = /^([0-9a-f]{64})\.tar(\.gz)?$/.exec(f);
                if (m && !want.has(m[1])) {
                    fs.rmSync(path.join(botDir, f), { force: true });
                }
            }
        }
    }

    /** Sends bundle `hex` of the lineup (isolated, gzip when asked): true once answered. */
    async function sendBot(req, res, hex, { sendJson }) {
        const l = await lineup();
        if (!HEX.test(hex) || !l?.bots.some((b) => b.bundle === hex)) {
            sendJson(res, 404, { error: { code: 'not_found', message: 'not a bot of the arena now' } }, req);
            return true;
        }
        const f = await botFile(hex);
        if (!f) {
            sendJson(res, 503, { error: { code: 'unavailable', message: "this bot's files come from the games machine, which is asleep; try again in a minute" } }, req);
            return true;
        }
        const gzip = /gzip/.test(req.headers['accept-encoding'] || '');
        const body = gzip ? f.gz : f.raw;
        // x-raw-length: the bytes the page reads once the browser has unzipped them (its progress bar's total)
        const lengthOf = (b) => (typeof b === 'string' ? fs.statSync(b).size : b.length);
        res.writeHead(200, { 'content-type': 'application/x-tar', 'cache-control': 'private, max-age=86400, immutable', vary: 'accept-encoding', 'content-length': String(lengthOf(body)), 'x-raw-length': String(lengthOf(f.raw)), ...ISOLATED, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
        if (typeof body === 'string') {
            fs.createReadStream(body).pipe(res);
        } else {
            res.end(body);
        }
        return true;
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
            if (p === '/swarm' && !who.login && !who.guest) {
                return false; // the window's sign-in page
            }
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
            return sendFile(req, res, url, file[1], { sendJson, sendText });
        }
        const api = /^\/api\/swarm\/(info|hello|claim|bundle\/([0-9a-f]{64})|lease\/([A-Za-z0-9_-]{1,64})\/(heartbeat|result))$/.exec(p);
        if (!api) {
            fail('not_found', 404, 'unknown swarm path');
            return true;
        }
        forget();
        // the build the tab loaded, which the machine checks as it checks a helper's: a tab left open across a deploy is
        // refused (409) and reloads, rather than playing with the old engine
        const tabBuild = String(req.headers['x-swarm-build'] ?? '');
        if (api[1] !== 'info' && !/^[0-9a-zA-Z._-]{1,64}$/.test(tabBuild)) {
            fail('bad_request', 400, 'every swarm request names the build the tab loaded (x-swarm-build)');
            return true;
        }
        try {
            if (api[1] === 'info') {
                const m = await currentManifest();
                const q = m ? `?b=${encodeURIComponent(m.build)}` : '';
                // the swarm now: people whose tabs asked for a seed in the last 90 s, and their slots
                let people = 0;
                let slots = 0;
                for (const [login, t] of tabs) {
                    const live = [...t.slots.values()].filter((at) => now() - at < 90000).length;
                    if (live) {
                        people++;
                        slots += live;
                    } else if (now() - t.at > 3600000) {
                        tabs.delete(login);
                    }
                }
                sendJson(res, 200, { on: true, ready: !!m, build: m?.build ?? null, cards: m?.cards ?? null, login: person, swarm: { people, slots },
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
                const r = await toMachine('POST', '/v1/hello', { body, build: tabBuild });
                return pass(res, req, r, sendText);
            }
            if (api[1] === 'claim') {
                const body = safeJson(await readBody(req, 4096));
                const t = tabs.get(person) ?? { at: 0, slots: new Map() };
                t.at = now();
                t.slots.set(slotOf(person, body?.slot ?? '1'), now());
                tabs.set(person, t);
                const r = await toMachine('POST', '/v1/claim', { body: JSON.stringify({ slot: slotOf(person, body?.slot ?? '1') }), build: tabBuild, timeoutMs: 70000 });
                if (r.status === 200 && r.json && LEASE.test(String(r.json.lease))) {
                    // the machine lists bundles as {id, bytes}
                    const ids = (r.json.bundles ?? []).map((b) => (typeof b === 'string' ? b : b?.id)).filter((h) => HEX.test(String(h)));
                    leases.set(String(r.json.lease), { login: person, slot: slotOf(person, body?.slot ?? '1'), bundles: new Set(ids), at: now() });
                }
                return pass(res, req, r, sendText);
            }
            if (api[2]) {
                const mine = [...leases.values()].some((l) => l.login === person && l.bundles.has(api[2]));
                if (!mine) {
                    fail('not_found', 404, 'not a bundle of a seed you hold');
                    return true;
                }
                const r = await toMachine('GET', `/v1/bundle/${api[2]}`, { build: tabBuild, raw: true, timeoutMs: 120000 });
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
            // a slot that plays a seed is still part of the swarm, though it asks for nothing meanwhile
            tabs.get(person)?.slots.set(l.slot, now());
            const body = await readBody(req, api[4] === 'result' ? RESULT_MAX : 4096);
            const r = await toMachine('POST', `/v1/lease/${id}/${api[4]}`, { body: body.length ? body : '{}', build: tabBuild, timeoutMs: api[4] === 'result' ? 180000 : 30000 });
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

    return { route, leases, on: () => !!token, sendFile, currentManifest, cachedBuild, keep, fileSize, lineup, sendBot, botHere };
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
