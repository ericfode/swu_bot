'use strict';
/**
 * The arena window: the arena and the research as friends see them, hosted on Fly (phase A of the hosting plan,
 * https://claude.ai/artifact/XsnHdQbtsxYTymkuTaDcCy). It is one HTTP API, and every part of the project talks to it
 * through that API (Eric, 2026-10-11: the edges go through the API, never through the shared folder):
 *
 *   the arena        PUT  /api/docs/arena/<id>             status, standings, tournament, roster, report-<K>, versions-<name>, panel-<name>
 *   ladders          PUT  /api/docs/runs/<run>, ladders/<run>    their index and report
 *                    POST /api/replays/<run>/<game>?at=<bytes>    each game's replay lines as they are played
 *   meta analyzer    PUT  /api/docs/meta/atlas, meta/ratings
 *   research lines   PUT  /api/docs/{panels,experiments,evals,bots,league,lens,research,threads}/<id>
 *   browsers         GET  /, /arena, /api/app (the app's model), /api/status, /api/standings, /api/report, /api/games,
 *                         /api/versions, /api/panel (the arena's own read methods, same shapes), /api/replays/<run>/<game>
 *
 * push.js is the client and CLI for the push side. Who may do what is in auth.js: friends read, the project's token
 * pushes. Storage is WINDOW_HOME (the Fly volume): docs/<ns>/<id>.json and replays/<run>/<game>.jsonl.gz.
 * Start it with ARENA_MODE=window node bot/arena/server.js --host 0.0.0.0 --port 8080.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createAuth, atLeast } = require('./auth');

// server.js's Accept-Encoding rule (q values, *); required on use because server.js requires this file
const acceptsGzip = (req) => require('./server').acceptsGzip(req.headers['accept-encoding']);

const ROOT = path.join(__dirname, '..', '..');
// the collections a part may push; a friend reads the FRIEND ones raw, and the rest only through the app's public model
const NS = new Set(['arena', 'runs', 'ladders', 'league', 'experiments', 'evals', 'panels', 'bots', 'threads', 'lens', 'meta', 'research', 'admin']);
const FRIEND_NS = new Set(['arena', 'runs', 'evals', 'lens', 'meta']);
const FEED_NS = new Set(['runs', 'lens', 'replays']);
const ID = /^[A-Za-z0-9][\w.#@+-]{0,159}$/;
const MAX_DOC = 16e6;
const MAX_APPEND = 8e6;
const MAX_REPLAY = 32e6; // the longest recorded game so far is ~14 MB of text
// keys a friend never sees (builder and thread names, Eric's pick 6), at any depth of a document
const PRIVATE_KEYS = new Set(['owner', 'thread', 'threadId', 'session', 'sessionId', 'tokenHash', 'token']);

class WindowError extends Error {
    constructor(code, message, extra = {}) {
        super(message);
        this.code = code;
        Object.assign(this, extra);
    }
}

function need(cond, code, msg) {
    if (!cond) {
        throw new WindowError(code, msg);
    }
}

/**
 * A run document sent by an outside machine is rebuilt from the fields the app's loaders read (dashboard/site/core.cjs
 * loadSources, app/src/model.cjs), each of a known type, and every other field is dropped, so nothing a feed sends can
 * break the model build. Games are objects with ids <feed>-<id>; seat names are plain words that are never an
 * Object.prototype key (the model indexes plain objects by them). Returns null for a document that does not fit.
 */
const isName = (x) => typeof x === 'string' && /^[A-Za-z0-9][\w .@#+()-]{0,63}$/.test(x) && !(x in Object.prototype);
const FEED_OUTCOMES = new Set(['running', 'won', 'draw', 'abandoned']);
const count = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : null);
function feedRun(doc, feed, id) {
    if (!doc || typeof doc !== 'object' || doc.id !== id || !Array.isArray(doc.games)) return null;
    if (doc.bots !== undefined && !(Array.isArray(doc.bots) && doc.bots.every(isName))) return null;
    if (doc.createdAt !== undefined && !(typeof doc.createdAt === 'string' && doc.createdAt.length <= 40 && Number.isFinite(Date.parse(doc.createdAt)))) return null;
    const games = [];
    for (const g of doc.games) {
        const ok = g && typeof g === 'object' && typeof g.id === 'string' && /^[\w.@#+-]{1,160}$/.test(g.id) && g.id.startsWith(`${feed}-`)
            && isName(g.p1) && isName(g.p2) && FEED_OUTCOMES.has(g.outcome)
            && (g.winnerSeat == null || ['p1', 'p2', 'draw'].includes(g.winnerSeat)) && (g.error == null || typeof g.error === 'string');
        if (!ok) return null;
        const seat = g.winnerSeat ?? null;
        games.push({ id: g.id, p1: g.p1, p2: g.p2, outcome: g.outcome, winnerSeat: seat, winner: seat === 'draw' ? 'draw' : seat ? g[seat] : null,
            rounds: count(g.rounds), steps: count(g.steps), error: g.error ? g.error.slice(0, 200) : null });
    }
    const per = count(doc.gamesPerPairing); // the run's grid draws this many squares per pair, so it stays small
    return { id, feed, ...(doc.createdAt ? { createdAt: doc.createdAt } : {}), ...(doc.bots ? { bots: doc.bots } : {}), ...(per && per <= 20 ? { gamesPerPairing: per } : {}), games };
}

/**
 * Writes come from programs with a bearer token; a session cookie only ever reads, whatever its role. A feed token
 * (an outside machine, auth.js) writes only run documents, lens documents and replays named after it: <feed> or
 * <feed>-<anything>, so the Karabast Sprite can stream its games and nothing else.
 */
function canWrite(who, ns, id) {
    if (who.via === 'bearer' && who.role === 'feed') {
        const own = typeof id === 'string' && (id === who.feed || id.startsWith(`${who.feed}-`));
        need(own && FEED_NS.has(ns), 'forbidden', `the ${who.feed} feed writes only runs, lens documents and replays named ${who.feed} or ${who.feed}-<id>`);
        return;
    }
    need(who.via === 'bearer' && atLeast(who.role, 'project'), 'forbidden', 'pushing needs the project token (a bearer token; signing in only reads)');
}

function writeAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

/**
 * Documents and replays on disk. Replays are kept gzipped (a ~1 MB replay is ~25 KB), one gzip member per append, so an
 * append never rewrites the file; sizes and offsets are always of the uncompressed text.
 */
class Store {
    constructor(dir) {
        this.dir = dir;
        this.version = 0; // bumped by any change the app's model reads: a document, or a new replay file
        this.sizes = new Map();
    }

    docFile(ns, id) {
        need(NS.has(ns), 'not_found', `unknown collection "${ns}" (known: ${[...NS].join(', ')})`);
        need(ID.test(id ?? ''), 'bad_request', 'id: 1-160 characters, letters, digits and . _ - # @ +, starting with a letter or digit');
        return path.join(this.dir, 'docs', ns, `${id}.json`);
    }

    getDoc(ns, id) {
        try {
            return fs.readFileSync(this.docFile(ns, id), 'utf8');
        } catch (e) {
            if (e.code === 'ENOENT') {
                return null;
            }
            throw e;
        }
    }

    putDoc(ns, id, text) {
        writeAtomic(this.docFile(ns, id), text);
        this.version++;
    }

    deleteDoc(ns, id) {
        try {
            fs.unlinkSync(this.docFile(ns, id));
        } catch (e) {
            if (e.code === 'ENOENT') {
                return false;
            }
            throw e;
        }
        this.version++;
        return true;
    }

    listDocs(ns) {
        need(NS.has(ns), 'not_found', `unknown collection "${ns}"`);
        const dir = path.join(this.dir, 'docs', ns);
        if (!fs.existsSync(dir)) {
            return [];
        }
        return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
            const st = fs.statSync(path.join(dir, f));
            return { id: f.slice(0, -5), at: st.mtime.toISOString(), bytes: st.size };
        });
    }

    replayFile(run, game) {
        need(ID.test(run ?? '') && ID.test(game ?? ''), 'bad_request', 'run and game ids: letters, digits and . _ - # @ +');
        return path.join(this.dir, 'replays', run, `${game}.jsonl.gz`);
    }

    replayRuns() {
        const dir = path.join(this.dir, 'replays');
        return fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => ID.test(d)).sort() : [];
    }

    listReplays(run) {
        need(ID.test(run ?? ''), 'bad_request', 'run id: letters, digits and . _ - # @ +');
        const dir = path.join(this.dir, 'replays', run);
        return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl.gz')).map((f) => f.slice(0, -9)).sort() : [];
    }

    hasReplay(run, game) {
        return ID.test(run ?? '') && ID.test(game ?? '') && fs.existsSync(path.join(this.dir, 'replays', run, `${game}.jsonl.gz`));
    }

    /** The replay's text, or null. */
    readReplay(run, game) {
        let gz;
        try {
            gz = fs.readFileSync(this.replayFile(run, game));
        } catch (e) {
            if (e.code === 'ENOENT') {
                return null;
            }
            throw e;
        }
        const buf = zlib.gunzipSync(gz); // gunzip reads every member
        this.sizes.set(`${run}/${game}`, buf.length);
        return buf;
    }

    replaySize(run, game) {
        const k = `${run}/${game}`;
        if (!this.sizes.has(k)) {
            const buf = this.readReplay(run, game);
            if (!buf) {
                return 0;
            }
        }
        return this.sizes.get(k);
    }

    /**
     * Adds bytes at offset `at`, which must be the replay's current size (0 for a new one): a retried or out-of-order
     * append is refused with code conflict and the size to resend from, so a replay never gets a line twice.
     */
    appendReplay(run, game, at, buf) {
        const file = this.replayFile(run, game);
        const size = this.replaySize(run, game);
        if (at !== size) {
            throw new WindowError('conflict', `the replay has ${size} bytes, not ${at}: resend from ${size}`, { size });
        }
        need(size + buf.length <= MAX_REPLAY, 'too_large', `a replay may hold at most ${MAX_REPLAY} bytes`);
        const isNew = size === 0 && !fs.existsSync(file);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, zlib.gzipSync(buf));
        this.sizes.set(`${run}/${game}`, size + buf.length);
        if (isNew) {
            this.version++;
        }
        return { size: size + buf.length };
    }

    /** Replaces a whole replay (a finished game pushed at once, or a resync). */
    putReplay(run, game, buf) {
        const file = this.replayFile(run, game);
        const isNew = !fs.existsSync(file);
        writeAtomic(file, zlib.gzipSync(buf));
        this.sizes.set(`${run}/${game}`, buf.length);
        if (isNew) {
            this.version++;
        }
        return { size: buf.length };
    }
}

const parseOr = (text, dflt) => {
    try {
        return text == null ? dflt : JSON.parse(text);
    } catch {
        return dflt;
    }
};

/**
 * The app's loaders (dashboard/site/core.cjs loadSources and app/src/model.cjs loadExtra) read through a reader with
 * list(dir) and text(path) in the project folder's layout. This reader answers those questions from the window's
 * collections, so the loaders run here unchanged and nothing outside the window depends on that layout.
 */
function storeReader(store) {
    const DIRS = { 'dashboard/league': 'league', 'dashboard/experiments': 'experiments', 'dashboard/evals': 'evals', 'dashboard/panels': 'panels', 'dashboard/bots': 'bots', 'dashboard/lens': 'lens' };
    const FILES = {
        'dashboard/threads.json': ['threads', 'threads'], 'meta/meta.json': ['meta', 'atlas'], 'meta/ratings.json': ['meta', 'ratings'],
        'research/eval-theory/td-report.json': ['research', 'td-report'], 'arena/roster.json': ['arena', 'roster'],
        'arena/tournament.json': ['arena', 'tournament'], 'arena/standings.json': ['arena', 'standings'],
        'arena/archive/t0/standings.json': ['arena', 'archive-t0-standings']
    };
    const file = (name) => ({ name, path: name, isDirectory: false });
    const dir = (name) => ({ name, path: name, isDirectory: true });
    const rounds = (prefix) => store.listDocs('arena').map((d) => new RegExp(`^${prefix}(\\d+)$`).exec(d.id)).filter(Boolean).map((m) => file(`r${m[1]}.md`));
    const versions = () => store.listDocs('arena').map((d) => /^versions-([a-z][a-z0-9_]*)$/.exec(d.id)).filter(Boolean)
        .flatMap((m) => (parseOr(store.getDoc('arena', m[0]), []) || []).map((s, i) => dir(`${m[1]}-v${versionNumber(s, i)}`)));
    return {
        async list(d) {
            if (d === 'results') {
                return [...new Set([...store.listDocs('runs').map((x) => x.id), ...store.replayRuns()])].map(dir);
            }
            const g = /^results\/([^/]+)\/games$/.exec(d);
            if (g) {
                return store.listReplays(g[1]).map((id) => file(`${id}.jsonl`));
            }
            if (DIRS[d]) {
                return store.listDocs(DIRS[d]).map((x) => file(`${x.id}.json`));
            }
            if (d === 'arena/rounds') {
                return rounds('report-');
            }
            if (d === 'arena/archive/t0/rounds') {
                return rounds('archive-t0-report-');
            }
            if (d === 'arena/versions') {
                return versions();
            }
            return [];
        },
        async text(p) {
            if (FILES[p]) {
                return store.getDoc(...FILES[p]);
            }
            let m = /^results\/([^/]+)\/(index|ladder)\.json$/.exec(p);
            if (m && ID.test(m[1])) {
                return store.getDoc(m[2] === 'index' ? 'runs' : 'ladders', m[1]);
            }
            m = /^(dashboard\/[a-z]+)\/([^/]+)\.json$/.exec(p);
            if (m && DIRS[m[1]] && ID.test(m[2])) {
                return store.getDoc(DIRS[m[1]], m[2]);
            }
            m = /^arena\/(rounds|archive\/t0\/rounds)\/r(\d+)\.md$/.exec(p);
            if (m) {
                return parseOr(store.getDoc('arena', `${m[1] === 'rounds' ? 'report' : 'archive-t0-report'}-${m[2]}`), null)?.markdown ?? null;
            }
            m = /^arena\/versions\/([a-z][a-z0-9_]*)-v(\d+)\/SUBMISSION\.json$/.exec(p);
            if (m) {
                const all = parseOr(store.getDoc('arena', `versions-${m[1]}`), []) || [];
                const s = all.find((x, i) => versionNumber(x, i) === Number(m[2]));
                return s ? JSON.stringify(s) : null;
            }
            m = /^results\/([^/]+)\/games\/([^/]+)\.jsonl$/.exec(p);
            if (m && ID.test(m[1]) && ID.test(m[2])) {
                return store.readReplay(m[1], m[2])?.toString('utf8') ?? null;
            }
            return null;
        }
    };
}

/** A version's number: its own v, else the -v<N> in its name, else its place in the list. */
function versionNumber(s, i) {
    if (Number.isInteger(s?.v)) {
        return s.v;
    }
    const m = /-v(\d+)$/.exec(String(s?.name ?? ''));
    return m ? Number(m[1]) : i;
}

/** A copy without builder and thread names, for friends. */
function scrub(x) {
    if (Array.isArray(x)) {
        return x.map(scrub);
    }
    if (x && typeof x === 'object') {
        return Object.fromEntries(Object.entries(x).filter(([k]) => !PRIVATE_KEYS.has(k)).map(([k, v]) => [k, scrub(v)]));
    }
    return x;
}

/** The app's code, loaded once: the research loader, the Atlas kit and the app model. null when a part is missing. */
function loadAppParts() {
    const first = (...ps) => ps.find((p) => p && fs.existsSync(p)) || null;
    const core = first(process.env.APP_CORE, path.join(ROOT, 'dashboard', 'site', 'core.cjs'));
    const atlasKit = first(path.join(ROOT, 'meta', 'atlas-kit.js'));
    if (!core || !atlasKit) {
        return { missing: [!core && 'dashboard/site/core.cjs', !atlasKit && 'meta/atlas-kit.js'].filter(Boolean) };
    }
    globalThis.AtlasKit = require(atlasKit);
    require(path.join(ROOT, 'app', 'src', 'atlas.js')); // sets globalThis.SWUAtlas, which model.cjs uses
    return { core: require(core), model: require(path.join(ROOT, 'app', 'src', 'model.cjs')) };
}

/**
 * The app's data, built here from the window's collections with the app's own loaders. Rebuilt when something it reads
 * changed, at most every `minMs`; a request meanwhile gets the last build.
 */
function appBuilder(store, { minMs = 10000, parts = null } = {}) {
    let cache = null;
    let builtVersion = -1;
    let builtAt = 0;
    let running = null;
    let p = parts;
    async function build() {
        p ??= loadAppParts();
        if (!p.core) {
            throw new WindowError('unsupported', `the app's data loader is not in this build (missing ${p.missing.join(', ')})`);
        }
        const v = store.version;
        const reader = storeReader(store);
        const loaded = await p.core.loadSources(reader);
        const extra = await p.model.loadExtra(reader);
        const M = p.model.buildModel(loaded, extra, p.core);
        M.replay = M.games.map((g) => (store.hasReplay(M.runs[g[0]]?.id, g[1]) ? 1 : 0)).join('');
        const t0panels = parseOr(store.getDoc('arena', 'archive-t0-panels'), []) || [];
        const result = { audience: 'public', model: p.model.publicModel(M), t0panels: t0panels.map(p.model.publicPanel), version: v };
        const text = JSON.stringify({ result });
        cache = { text, gz: zlib.gzipSync(text) };
        builtVersion = v;
        builtAt = Date.now();
        return cache;
    }
    return async function get() {
        const stale = !cache || (store.version !== builtVersion && Date.now() - builtAt >= minMs);
        if (stale && !running) {
            running = build().catch((e) => {
                if (!cache) {
                    throw e;
                }
                console.error('app data rebuild failed, serving the last build:', e.message);
                return cache;
            }).finally(() => {
                running = null;
            });
            running.catch(() => {}); // callers with a cache do not await the rebuild: its failure must not end the process
        }
        if (!cache) {
            return running;
        }
        return cache;
    };
}

const STATUS = { bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, too_large: 413, internal: 500, unsupported: 501, unavailable: 503 };
// the arena's methods a window answers from what the arena pushed; the rest need the arena itself (phase B)
const ARENA_READ = new Set(['status', 'standings', 'report', 'versions', 'panel', 'games']);

/**
 * The window's request handler. opts: home (storage folder), auth (an auth.js instance; default from the environment),
 * app (the friends' page file), web (the arena page), kit (the viewer kit), appParts (for tests).
 */
function createWindow(opts = {}) {
    const home = path.resolve(opts.home ?? process.env.WINDOW_HOME ?? '/data/window');
    const store = new Store(home);
    const auth = opts.auth ?? createAuth({ dir: path.join(home, 'auth'), invites: () => parseOr(store.getDoc('admin', 'invites'), null)?.logins ?? [] });
    const appData = appBuilder(store, { minMs: opts.minMs ?? 10000, parts: opts.appParts ?? null });
    const appFile = opts.app ?? process.env.ARENA_APP ?? path.join(ROOT, 'app', 'dist', 'public.html');
    const webFile = opts.web ?? path.join(__dirname, 'web', 'index.html');
    const kitFile = opts.kit ?? process.env.ARENA_KIT ?? path.join(ROOT, 'studio', 'dist-kit', 'swu-viewer-kit.js');

    const arenaDoc = (id) => parseOr(store.getDoc('arena', id), undefined);
    const arenaMethods = {
        status: () => arenaDoc('status') ?? { tournament: null, round: null, phase: 'idle', competitors: [] },
        standings: () => arenaDoc('standings') ?? { rounds: [], global: {} },
        report: ({ round }) => {
            const all = store.listDocs('arena').map((d) => /^report-(\d+)$/.exec(d.id)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
            const k = round == null || round === '' ? all[all.length - 1] : Number(round);
            need(Number.isInteger(k) && all.includes(k), 'not_found', 'no round report yet');
            return arenaDoc(`report-${k}`);
        },
        versions: ({ name }) => {
            need(/^[a-z][a-z0-9_]{0,31}$/.test(name ?? ''), 'bad_request', 'name is required');
            const v = arenaDoc(`versions-${name}`);
            need(v, 'not_found', `no competitor "${name}" (see status)`);
            return v;
        },
        panel: ({ name }) => {
            need(/^[a-z][a-z0-9_]{0,31}$/.test(name ?? ''), 'bad_request', 'name is required');
            const v = arenaDoc(`panel-${name}`);
            need(v, 'not_found', `no panel for "${name}"`);
            return v;
        },
        games: ({ round }) => {
            const st = arenaMethods.standings();
            const k = round == null || round === '' ? st.rounds[st.rounds.length - 1]?.round : Number(round);
            need(k !== undefined, 'not_found', 'no rounds yet');
            need(Number.isInteger(k) && k >= 0, 'bad_request', 'round: an integer');
            const t = arenaDoc('tournament');
            const named = st.rounds.find((x) => x.round === k)?.ladderId ?? (Array.isArray(t?.rounds) ? t.rounds.find((r) => r?.n === k)?.ladder : undefined);
            const id = typeof named === 'string' && /^arena-[\w-]+$/.test(named) ? named : `arena-r${k}`;
            const idx = parseOr(store.getDoc('runs', id), null);
            need(idx, 'not_found', `no games for round ${k}`);
            return { round: k, ladderId: id, replayBase: `replays/${id}/games/`, games: idx.games };
        }
    };

    function sendJson(res, code, body, req) {
        if (res.headersSent) {
            return;
        }
        const text = JSON.stringify(body);
        sendText(res, req, code, 'application/json', text);
    }

    function sendText(res, req, code, type, text, headers = {}) {
        const gzip = req && acceptsGzip(req) && text.length > 1024;
        res.writeHead(code, { 'content-type': type, 'cache-control': 'no-cache', vary: 'accept-encoding', ...headers, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
        res.end(gzip ? zlib.gzipSync(text) : text);
    }

    function serveFile(req, res, file, type) {
        let text;
        try {
            text = fs.readFileSync(file);
        } catch {
            return sendText(res, req, 404, 'text/plain', 'not found');
        }
        return sendText(res, req, 200, type, text);
    }

    /** The request body, or too_large: refused up front when its length says so, else read to the end and dropped. */
    function readBody(req, max) {
        if (Number(req.headers['content-length']) > max) {
            req.resume();
            return Promise.reject(new WindowError('too_large', `request body over ${max} bytes`));
        }
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on('data', (d) => {
                size += d.length;
                if (size <= max) {
                    chunks.push(d);
                }
            });
            req.on('end', () => (size > max ? reject(new WindowError('too_large', `request body over ${max} bytes`)) : resolve(Buffer.concat(chunks))));
            req.on('error', reject);
        });
    }

    async function api(req, res, url, who) {
        const parts = url.pathname.split('/').slice(2).map((s) => {
            try {
                return decodeURIComponent(s);
            } catch {
                throw new WindowError('bad_request', 'malformed %-escape in the path');
            }
        });
        const q = Object.fromEntries(url.searchParams);
        const friend = !atLeast(who.role, 'project');
        if (parts[0] === 'me' && parts.length === 1) {
            return sendJson(res, 200, { result: { login: who.login ?? null, role: who.role } }, req);
        }
        if (parts[0] === 'app' && parts.length === 1) {
            const out = await appData();
            const gzip = acceptsGzip(req);
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', vary: 'accept-encoding', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
            return res.end(gzip ? out.gz : out.text);
        }
        if (parts[0] === 'docs') {
            const [, ns, id] = parts;
            need(parts.length <= 3 && ns, 'not_found', 'use /api/docs/<collection>[/<id>]');
            need(NS.has(ns), 'not_found', `unknown collection "${ns}"`);
            // The proxy adds the project token to every process in the project, competitor bots included, so the
            // invite list and anything else in `admin` needs the admin token (or Eric's own sign-in, to read).
            need(ns !== 'admin' || who.role === 'admin', 'forbidden', 'the admin collection needs the admin token');
            if (req.method === 'GET') {
                need(!friend || FRIEND_NS.has(ns), 'forbidden', `"${ns}" is shown to friends through the app, not raw`);
                if (!id) {
                    const list = store.listDocs(ns);
                    if (q.full === '1') {
                        return sendJson(res, 200, { result: list.map((d) => ({ ...d, doc: (friend ? scrub : (x) => x)(parseOr(store.getDoc(ns, d.id), null)) })) }, req);
                    }
                    return sendJson(res, 200, { result: list }, req);
                }
                const text = store.getDoc(ns, id);
                need(text != null, 'not_found', `no ${ns}/${id}`);
                return friend ? sendJson(res, 200, { result: scrub(JSON.parse(text)) }, req) : sendText(res, req, 200, 'application/json', `{"result":${text}}`);
            }
            canWrite(who, ns, id);
            need(id, 'bad_request', 'use /api/docs/<collection>/<id>');
            if (req.method === 'PUT') {
                const body = (await readBody(req, MAX_DOC)).toString('utf8');
                let doc;
                try {
                    doc = JSON.parse(body);
                } catch {
                    throw new WindowError('bad_request', 'body is not JSON');
                }
                // the loaders name a run by the id inside its index, so a feed's run must carry its own name there too
                let text = body;
                if (who.role === 'feed' && ns === 'runs') {
                    need(doc?.id === id, 'bad_request', `a run document's id must be "${id}", its name in the path`);
                    const run = feedRun(doc, who.feed, id);
                    need(run, 'bad_request', `a run document needs games: [{id: "${who.feed}-<id>", p1, p2, outcome: running|won|draw|abandoned, winnerSeat, rounds, steps, error}] with seats (and bots, if any) named in plain words (WINDOW.md, "Outside machines")`);
                    // the run keeps which feed sent it, so the app never rates its games (model.cjs)
                    text = JSON.stringify(run);
                }
                store.putDoc(ns, id, text);
                return sendJson(res, 200, { result: { ok: true, version: store.version } }, req);
            }
            if (req.method === 'DELETE') {
                return sendJson(res, 200, { result: { deleted: store.deleteDoc(ns, id) } }, req);
            }
            throw new WindowError('bad_request', 'GET, PUT or DELETE');
        }
        if (parts[0] === 'replays') {
            const [, run, game] = parts;
            need(parts.length <= 3 && run, 'not_found', 'use /api/replays/<run>[/<game>]');
            if (req.method === 'GET') {
                if (!game) {
                    const ids = store.listReplays(run);
                    return sendJson(res, 200, { result: q.sizes === '1' ? ids.map((id) => ({ id, size: store.replaySize(run, id) })) : ids }, req);
                }
                const buf = store.readReplay(run, game);
                need(buf, 'not_found', `no replay ${run}/${game}`);
                const from = Math.min(buf.length, Math.max(0, Number(q.from) || 0));
                const to = q.length ? Math.min(buf.length, from + Math.max(0, Number(q.length) || 0)) : buf.length;
                return sendText(res, req, 200, 'application/x-ndjson', buf.subarray(from, to), { 'x-size': String(buf.length) });
            }
            canWrite(who, 'replays', run);
            need(game, 'bad_request', 'use /api/replays/<run>/<game>');
            const body = await readBody(req, req.method === 'PUT' ? MAX_REPLAY : MAX_APPEND);
            if (req.method === 'POST') {
                need(/^\d+$/.test(q.at ?? ''), 'bad_request', 'at: the byte offset this append starts at (the size you last saw)');
                return sendJson(res, 200, { result: store.appendReplay(run, game, Number(q.at), body) }, req);
            }
            if (req.method === 'PUT') {
                return sendJson(res, 200, { result: store.putReplay(run, game, body) }, req);
            }
            throw new WindowError('bad_request', 'GET, POST (append) or PUT (replace)');
        }
        if (parts.length === 1 && /^[a-z_]+$/.test(parts[0])) {
            need(req.method === 'GET', 'unsupported', 'the window is read-only: registering, submitting and playing happen in the arena itself');
            if (!ARENA_READ.has(parts[0])) {
                throw new WindowError('unsupported', `"${parts[0]}" needs the arena itself; the window answers ${[...ARENA_READ].join(', ')}`);
            }
            const out = arenaMethods[parts[0]](q);
            return sendJson(res, 200, { result: friend ? scrub(out) : out }, req);
        }
        if (parts.length === 0 || (parts.length === 1 && parts[0] === '')) {
            return sendJson(res, 200, { result: { arena: [...ARENA_READ], collections: [...NS], replays: '/api/replays/<run>/<game>' } }, req);
        }
        throw new WindowError('not_found', 'unknown API path');
    }

    async function handle(req, res) {
        const url = new URL(req.url, 'http://x');
        try {
            if (url.pathname === '/healthz') {
                return sendText(res, req, 200, 'text/plain', 'ok');
            }
            if (await auth.routes(req, res, url)) {
                return undefined;
            }
            const who = auth.who(req);
            if (who.role === 'bad') {
                return sendJson(res, 401, { error: { code: 'unauthorized', message: 'wrong bearer token' } }, req);
            }
            if (url.pathname.startsWith('/api')) {
                if (!atLeast(who.role, 'friend')) {
                    return sendJson(res, 401, { error: { code: 'unauthorized', message: who.login ? `@${who.login} is not invited yet` : 'sign in at /auth/github, or send the project token' } }, req);
                }
                return await api(req, res, url, who);
            }
            if (req.method !== 'GET') {
                return sendText(res, req, 405, 'text/plain', 'GET only');
            }
            if (!atLeast(who.role, 'friend')) {
                return sendText(res, req, who.login ? 403 : 200, 'text/html; charset=utf-8', auth.signInPage(url.pathname + url.search, who.login));
            }
            if (url.pathname === '/' || url.pathname === '/index.html') {
                return serveFile(req, res, fs.existsSync(appFile) ? appFile : webFile, 'text/html; charset=utf-8');
            }
            if (url.pathname === '/arena' || url.pathname === '/arena.html') {
                return serveFile(req, res, webFile, 'text/html; charset=utf-8');
            }
            if (url.pathname === '/strategy-diagram.js') {
                return serveFile(req, res, path.join(__dirname, 'web', 'strategy-diagram.js'), 'text/javascript');
            }
            if (url.pathname === '/kit.js') {
                return serveFile(req, res, kitFile, 'text/javascript');
            }
            // the arena page's replay links (<ladder>/games/<id>.jsonl and <ladder>/index.json), from the window's collections
            const rep = /^\/replays\/([\w.%@+-]+)\/(?:games\/([\w.%@+-]+)\.jsonl|(index)\.json)$/.exec(url.pathname);
            if (rep) {
                const dec = (x) => {
                    try {
                        return decodeURIComponent(x);
                    } catch {
                        return '';
                    }
                };
                const text = rep[3] ? store.getDoc('runs', dec(rep[1])) : store.readReplay(dec(rep[1]), dec(rep[2]));
                return text == null ? sendText(res, req, 404, 'text/plain', 'not found') : sendText(res, req, 200, rep[3] ? 'application/json' : 'application/x-ndjson', text);
            }
            return sendText(res, req, 404, 'text/plain', 'not found');
        } catch (e) {
            const code = e instanceof WindowError ? e.code : 'internal';
            if (code === 'internal') {
                console.error(e);
            }
            return sendJson(res, STATUS[code] ?? 400, { error: { code, message: code === 'internal' ? 'internal error' : e.message, ...(e.size !== undefined ? { size: e.size } : {}) } }, req);
        }
    }

    return { handle, store, auth };
}

module.exports = { createWindow, Store, storeReader, scrub, appBuilder, NS, FRIEND_NS };
