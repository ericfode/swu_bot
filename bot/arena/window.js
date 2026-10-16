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
 *   Eric's Share page     GET, POST /api/share                 who is invited; {add} or {remove} one GitHub login
 *   Eric's settings  GET, POST /api/arena-settings        games per pair, time limit, games at once, wait between rounds;
 *                                                          the games machine reads them (coord/lib/coord/settings.ex)
 *   MCP clients      POST /mcp                             each person's own app (Claude, Claude Code...), signed in
 *                                                          with GitHub through OAuth (oauth.js, /oauth/*); it reads
 *   Build a bot page GET, POST /api/apps                   a person's connected apps; {disconnect: id}
 *   every page       GET /feedback.js, GET, POST /api/feedback   the feedback button and ` key (feedback.js); notes are kept in
 *                                                          `feedback`, which the project token and admins read
 *
 * push.js is the client and CLI for the push side. Who may do what is in auth.js: friends read, the project's token
 * pushes. Storage is WINDOW_HOME (the Fly volume): docs/<ns>/<id>.json and replays/<run>/<game>.jsonl.gz.
 * Start it with ARENA_MODE=window node bot/arena/server.js --host 0.0.0.0 --port 8080. With ARENA_GAMES_WAKE set (the
 * games machine's private address, http://swu-arena-games.flycast/wake), every submission wakes the games machine
 * (coord/): arena_submit's, and a new pending one a token writes to the submissions collection (ops/house-submit.js).
 * server.js also wakes it every 6 hours.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { createAuth, atLeast, LOGIN } = require('./auth');
const { createSwarmRelay } = require('./swarm-relay');
const { createPlay } = require('./play');
const { createTables } = require('./tables');
const { createArt } = require('./art');
const { createOAuth } = require('./oauth');
const { createMcpHttp } = require('./mcp-http');
const { builderName, ownsName, notYours } = require('./api');
const { createFeedback } = require('./feedback');
const { createGameLinks } = require('./gamelinks');

// server.js's Accept-Encoding rule (q values, *); required on use because server.js requires this file
const acceptsGzip = (req) => require('./server').acceptsGzip(req.headers['accept-encoding']);

const ROOT = path.join(__dirname, '..', '..');
// the collections a part may push; a friend reads the FRIEND ones raw, and the rest only through the app's public model
// submissions: bots people send through /mcp (arena_submit), each kept until the arena's intake (intake.js) has checked
// it; friends never read the collection raw, only their own through arena_my_submissions
// feedback: notes people send from the window's pages (feedback.js); the project token and admins read them
const NS = new Set(['arena', 'runs', 'ladders', 'league', 'experiments', 'evals', 'panels', 'bots', 'threads', 'lens', 'meta', 'research', 'admin', 'submissions', 'feedback']);
const FRIEND_NS = new Set(['arena', 'runs', 'evals', 'lens', 'meta']);
const FEED_NS = new Set(['runs', 'lens', 'replays']);
const ID = /^[A-Za-z0-9][\w.#@+-]{0,159}$/;
const MAX_DOC = 16e6;
const MAX_APPEND = 8e6;
const MAX_REPLAY = 32e6; // the longest recorded game so far is ~14 MB of text
// a game still marked running that sent nothing for this long is shown as stopped (settleRun)
const STALE_MS = 20 * 60000;
// bots people submit through /mcp (arena_submit): the kinds the arena's intake packs, and how much of them it takes
const SUBMIT_KINDS = ['js', 'python', 'wasm'];
const SUBMIT_FILES = 200;
const SUBMIT_BYTES = 3e6;
const SUBMIT_PENDING = 3; // waiting at once, per competitor name
const SUBMIT_PER_DAY = 20; // per competitor name
const SUBMIT_PER_DAY_PERSON = 60; // per person, over all their names
// Eric's arena settings (/api/arena-settings): each is an integer in its range, or absent for the games machine's own
// default (coord Coord.Config, roster.thinkCapMs). gamesPerPair is even: every seed is played from both seats.
const SETTINGS = {
    gamesPerPair: { min: 2, max: 10, even: true }, // arena: games each pair plays in a round
    thinkCapSec: { min: 10, max: 600 }, // arena: thinking time per bot per game; past it, that bot loses the game
    workers: { min: 1, max: 16 }, // compute: games the games machine plays at once
    roundGapMin: { min: 0, max: 240 } // compute: minutes from one round's end to the next round's start
};
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
 * arena_submit's checks of a submission's files (count, paths, size, base64 list, entry); throws WindowError. The dev
 * harness (bot/dev.js) applies them to a folder packed as a builder's submission.
 */
function submitFiles({ files, base64 = [], entry }) {
    need(files && typeof files === 'object' && !Array.isArray(files), 'bad_request', 'files: an object of path -> content');
    const paths = Object.keys(files);
    need(paths.length >= 1 && paths.length <= SUBMIT_FILES, 'bad_request', `files: 1 to ${SUBMIT_FILES} files`);
    need(Array.isArray(base64) && base64.every((p) => typeof p === 'string' && p in files), 'bad_request', 'base64: a list of paths that are in files');
    let bytes = 0;
    for (const p of paths) {
        need(/^[\w.-]+(\/[\w.-]+)*$/.test(p) && p.length <= 200 && !p.split('/').some((x) => x === '..' || x === '.' || x === '.git'), 'bad_request', `files: ${p} is not a plain relative path`);
        need(typeof files[p] === 'string', 'bad_request', `files: ${p} must be a string`);
        bytes += base64.includes(p) ? Math.floor(files[p].length * 3 / 4) : Buffer.byteLength(files[p]);
    }
    need(bytes <= SUBMIT_BYTES, 'too_large', `files: at most ${SUBMIT_BYTES / 1e6} MB in all`);
    need(entry === undefined || (typeof entry === 'string' && entry in files), 'bad_request', 'entry: one of the files');
}

/**
 * A run document sent by an outside machine is rebuilt from the fields the app's loaders read (dashboard/site/core.cjs
 * loadSources, app/src/model.cjs), each of a known type, and every other field is dropped, so nothing a feed sends can
 * break the model build. Games are objects with ids <feed>-<id>; seat names are plain words that are never an
 * Object.prototype key (the model indexes plain objects by them). Returns null for a document that does not fit.
 */
const okSetting = (k, v) => {
    const r = SETTINGS[k];
    return Number.isInteger(v) && v >= r.min && v <= r.max && (!r.even || v % 2 === 0);
};
const isName = (x) => typeof x === 'string' && /^[A-Za-z0-9][\w .@#+()-]{0,63}$/.test(x) && !(x in Object.prototype);
const FEED_OUTCOMES = new Set(['running', 'won', 'draw', 'abandoned']);
// a game's error text could name the person, so a people run keeps only that there was one
const NO_RESULT = 'no result';
const count = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : null);
function feedRun(doc, feed, id) {
    if (!doc || typeof doc !== 'object' || doc.id !== id || !Array.isArray(doc.games)) return null;
    if (doc.bots !== undefined && !(Array.isArray(doc.bots) && doc.bots.every(isName))) return null;
    // runs are ordered by createdAt, so a feed's run needs one
    if (!(typeof doc.createdAt === 'string' && doc.createdAt.length <= 40 && Number.isFinite(Date.parse(doc.createdAt)))) return null;
    // the run's bots list names our bots; every other seat is a person, kept only as "opponent", so a person's name is
    // never stored. A run with games must name at least one bot, and every game must seat one of them.
    const ours = new Set((doc.bots ?? []).filter((b) => b !== 'opponent'));
    if (doc.games.length && !ours.size) return null;
    const games = [], seen = new Set();
    for (const g of doc.games) {
        const ok = g && typeof g === 'object' && typeof g.id === 'string' && /^[\w.@#+-]{1,160}$/.test(g.id) && g.id.startsWith(`${feed}-`) && !seen.has(g.id)
            && isName(g.p1) && isName(g.p2) && (ours.has(g.p1) || ours.has(g.p2)) && FEED_OUTCOMES.has(g.outcome)
            && (g.outcome !== 'won' || g.winnerSeat === 'p1' || g.winnerSeat === 'p2') && (g.error == null || typeof g.error === 'string');
        if (!ok) return null;
        seen.add(g.id);
        // the seat follows from the outcome: only a won game names a winner, a draw is always 'draw'
        const seat = g.outcome === 'won' ? g.winnerSeat : g.outcome === 'draw' ? 'draw' : null;
        const p = { p1: ours.has(g.p1) ? g.p1 : 'opponent', p2: ours.has(g.p2) ? g.p2 : 'opponent' };
        games.push({ id: g.id, ...p, outcome: g.outcome, winnerSeat: seat, winner: seat === 'draw' ? 'draw' : seat ? p[seat] : null,
            rounds: count(g.rounds), steps: count(g.steps), error: g.error ? NO_RESULT : null });
    }
    const per = count(doc.gamesPerPairing); // the run's grid draws this many squares per pair, so it stays small
    return { id, feed, createdAt: doc.createdAt, ...(doc.bots ? { bots: doc.bots } : {}), ...(per && per <= 20 ? { gamesPerPairing: per } : {}), games };
}

/**
 * A feed's game row may carry the person's name on karabast.net (`person`). It never goes into the run document: the
 * window keeps it in admin/people, {names: {<game id>: name}}, which only an admin reads. Friends, view links, apps,
 * the project token and the app's model still see "opponent" (the app has left people games out since 2026-10-14).
 */
const PEOPLE_MAX = 20000;
const personName = (x) => (typeof x === 'string' && x.length <= 64 && !/[\u0000-\u001f\u007f]/.test(x) && x.trim() ? x.trim() : null);
function keepPeopleNames(store, games) {
    const prev = parseOr(store.getDoc('admin', 'people'), null)?.names;
    const names = prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...prev } : {};
    let changed = false;
    for (const g of games) {
        const name = personName(g?.person);
        if (name && names[g.id] !== name) {
            delete names[g.id]; // a renamed game moves to the end, so the oldest names are the ones dropped
            names[g.id] = name;
            changed = true;
        }
    }
    if (changed) {
        const ids = Object.keys(names).slice(-PEOPLE_MAX);
        store.putDoc('admin', 'people', JSON.stringify({ names: Object.fromEntries(ids.map((k) => [k, names[k]])), updatedAt: new Date().toISOString() }));
    }
}

/**
 * Writes come from programs with a bearer token; a session cookie only ever reads, whatever its role (the one exception
 * is an admin's change to the invite list, share() in createWindow). A feed token
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

    deleteReplay(run, game) {
        fs.rmSync(this.replayFile(run, game), { force: true });
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

    /** When the run's documents (runs, ladders) or, with `game`, that game's replay last changed: ms, 0 for none. */
    changedAt(run, game = null) {
        const files = game ? [this.replayFile(run, game)] : [this.docFile('runs', run), this.docFile('ladders', run)];
        return Math.max(0, ...files.map((f) => {
            try {
                return fs.statSync(f).mtimeMs;
            } catch {
                return 0;
            }
        }));
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
 * A run document as the app reads it. A sender that stops (a ladder killed mid-run, a pusher that died, a feed that went
 * away) leaves its last games marked running, and the app would show them as playing forever. So a running game that
 * sent nothing for `staleMs` (its replay, or the run's documents when it has no replay) reads as abandoned, with why; the
 * stored document stays as it came, and a sender that comes back makes the game live again. Returns the text, how many
 * games it `settled`, and `until`, when the next game still running goes stale (Infinity for none).
 */
function settleRun(store, run, text, { staleMs = STALE_MS, now = Date.now() } = {}) {
    const doc = text?.includes('"running"') ? parseOr(text, null) : null; // most runs have nothing running: no second parse
    if (!Array.isArray(doc?.games) || !doc.games.some((g) => g?.outcome === 'running')) {
        return { text, until: Infinity, settled: 0 };
    }
    let until = Infinity;
    let docAt = null;
    let changed = 0;
    const games = doc.games.map((g) => {
        if (g?.outcome !== 'running') {
            return g;
        }
        const at = (ID.test(String(g.id)) && store.changedAt(run, g.id)) || (docAt ??= store.changedAt(run));
        if (now - at < staleMs) {
            until = Math.min(until, at + staleMs);
            return g;
        }
        changed++;
        return { ...g, outcome: 'abandoned', error: `stopped: its run sent nothing for ${Math.round((now - at) / 60000)} min` };
    });
    return { text: changed ? JSON.stringify({ ...doc, games }) : text, until, settled: changed };
}

/**
 * The app's loaders (dashboard/site/core.cjs loadSources and app/src/model.cjs loadExtra) read through a reader with
 * list(dir) and text(path) in the project folder's layout. This reader answers those questions from the window's
 * collections, so the loaders run here unchanged and nothing outside the window depends on that layout. A run's games
 * still marked running are settled (settleRun); `staleAt()` says when the next one goes stale, `settled()` how many were.
 */
function storeReader(store, { staleMs = STALE_MS, now = () => Date.now() } = {}) {
    let staleAt = Infinity;
    let settled = 0;
    const DIRS = { 'dashboard/league': 'league', 'dashboard/experiments': 'experiments', 'dashboard/evals': 'evals', 'dashboard/panels': 'panels', 'dashboard/bots': 'bots', 'dashboard/lens': 'lens' };
    const FILES = {
        'dashboard/threads.json': ['threads', 'threads'], 'meta/meta.json': ['meta', 'atlas'], 'meta/ratings.json': ['meta', 'ratings'],
        'research/eval-theory/td-report.json': ['research', 'td-report'], 'arena/roster.json': ['arena', 'roster'],
        'arena/tournament.json': ['arena', 'tournament'], 'arena/status.json': ['arena', 'status'], 'arena/standings.json': ['arena', 'standings'],
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
                const text = store.getDoc(m[2] === 'index' ? 'runs' : 'ladders', m[1]);
                if (m[2] !== 'index') {
                    return text;
                }
                const out = settleRun(store, m[1], text, { staleMs, now: now() });
                staleAt = Math.min(staleAt, out.until);
                settled += out.settled;
                return out.text;
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
        },
        staleAt: () => staleAt,
        settled: () => settled
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

/**
 * People are never named to readers. A run of games against people (one a feed sent, or an id starting "karabast", as
 * app/src/model.cjs tells them apart) is stored as its writer sent it, and the programs that write (bearer tokens from
 * feed up) read it back that way, so their sizes and offsets match what they wrote. Everyone else (a sign-in, a view
 * link's guest, an MCP app) reads a copy where a seat outside the run's own bots list is "opponent" in the run document,
 * and "a person" in a replay's header and on each board, as the app shows it.
 */
const PERSON = 'a person';
const readsMasked = (who) => !(who.via === 'bearer' && atLeast(who.role, 'feed'));
const peopleRun = (id, doc) => (typeof doc?.feed === 'string' && doc.feed !== '') || /^karabast(-|$)/.test(id);
const oursOf = (doc) => new Set((Array.isArray(doc?.bots) ? doc.bots : []).filter((b) => b !== 'opponent'));

function maskRun(doc) {
    if (!Array.isArray(doc.games)) {
        return doc;
    }
    // with no bots list the person cannot be told from our bot, so every seat is hidden
    const ours = oursOf(doc);
    const seat = (n) => (typeof n !== 'string' || ours.has(n) || n === 'draw' ? n : 'opponent');
    const error = (e) => (!e ? null : /^TIME_FORFEIT (\S+)/.test(String(e)) ? `TIME_FORFEIT ${seat(RegExp.$1)}` : NO_RESULT);
    return { ...doc, games: doc.games.map((g) => (g && typeof g === 'object' ? { ...g, p1: seat(g.p1), p2: seat(g.p2), ...('winner' in g ? { winner: seat(g.winner) } : {}), ...('error' in g ? { error: error(g.error) } : {}) } : g)) };
}

/** A readers' copy of a document: a people run masked (above), and for friends without builder and thread names. */
function readerDoc(ns, id, doc, who) {
    const d = ns === 'runs' && doc && typeof doc === 'object' && readsMasked(who) && peopleRun(id, doc) ? maskRun(doc) : doc;
    return atLeast(who.role, 'project') ? d : scrub(d);
}

/**
 * A people game's replay as readers get it. The person's seat comes from the run's row for the game (a seat that is
 * "opponent" or outside the bots list), or, before the run names the game, from the header (a player named "opponent"
 * or outside the bots list). With no bots list every seat is hidden. Whole lines only: a line still being written waits for its newline, so the copy only ever
 * grows by whole lines and a reader's offsets stay valid while the game is played.
 */
function maskReplay(buf, doc, game) {
    const ours = oursOf(doc);
    const row = Array.isArray(doc?.games) ? doc.games.find((g) => g?.id === game) : null;
    const outside = (n) => n === 'opponent' || !ours.has(n);
    const isPerson = (p) => (row && typeof row[p.id] === 'string' ? outside(row[p.id]) : outside(p.bot));
    const names = new Map(); // seat -> the names the header gave the person
    const end = buf.lastIndexOf(10) + 1;
    const lines = buf.subarray(0, end).toString('utf8').split('\n');
    lines.pop();
    const out = lines.map((line) => {
        if (!line.includes('"header"') && ![...names.values()].some((ns) => ns.some((n) => line.includes(JSON.stringify(n))))) {
            return line;
        }
        let e;
        try {
            e = JSON.parse(line);
        } catch {
            return line;
        }
        let changed = false;
        if (e?.t === 'header' && Array.isArray(e.players)) {
            e.players = e.players.map((p) => {
                if (!p || typeof p !== 'object' || !isPerson(p)) {
                    return p;
                }
                names.set(p.id, [p.bot, p.name].filter((n) => typeof n === 'string' && n !== '' && n !== p.id));
                changed = true;
                return { ...p, bot: PERSON, ...(typeof p.name === 'string' && p.name !== p.id ? { name: PERSON } : {}) };
            });
        }
        for (const [seat, ns] of names) {
            const pl = e?.state?.players?.[seat];
            if (pl && ns.includes(pl.name)) {
                pl.name = PERSON;
                changed = true;
            }
        }
        return changed ? JSON.stringify(e) : line;
    });
    return Buffer.from(out.length ? `${out.join('\n')}\n` : '', 'utf8');
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
function appBuilder(store, { minMs = 10000, parts = null, staleMs = STALE_MS } = {}) {
    let cache = null;
    let builtVersion = -1;
    let builtAt = 0;
    let staleAt = Infinity; // when a game the last build showed as running goes stale with no change in the store
    let running = null;
    let p = parts;
    async function build() {
        p ??= loadAppParts();
        if (!p.core) {
            throw new WindowError('unsupported', `the app's data loader is not in this build (missing ${p.missing.join(', ')})`);
        }
        const v = store.version;
        const reader = storeReader(store, { staleMs });
        const loaded = await p.core.loadSources(reader);
        const extra = await p.model.loadExtra(reader);
        const M = p.model.buildModel(loaded, extra, p.core);
        M.replay = M.games.map((g) => (store.hasReplay(M.runs[g[0]]?.id, g[1]) ? 1 : 0)).join('');
        const t0panels = parseOr(store.getDoc('arena', 'archive-t0-panels'), []) || [];
        // a game going stale changes the model with no write, so the version a browser compares also counts the stopped games
        const settled = reader.settled();
        const result = { audience: 'public', model: p.model.publicModel(M), t0panels: t0panels.map(p.model.publicPanel), version: settled ? `${v}.${settled}` : v };
        const text = JSON.stringify({ result });
        cache = { text, gz: zlib.gzipSync(text) };
        builtVersion = v;
        builtAt = Date.now();
        staleAt = reader.staleAt();
        return cache;
    }
    return async function get() {
        const stale = !cache || ((store.version !== builtVersion || Date.now() >= staleAt) && Date.now() - builtAt >= minMs);
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
 * app (the friends' page file), kit (the viewer kit), appParts and staleMs (for tests).
 */
/**
 * Wakes the games machine (its coordinator's POST /wake) at `url`, e.g. http://swu-arena-games.flycast/wake: Fly's proxy starts
 * a stopped machine on the request. Never waits on it and never fails: the machine also wakes every 6 hours.
 */
function wakeGamesAt(url, { fetchImpl = fetch } = {}) {
    if (!url) {
        return;
    }
    fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(60000) }).then((r) => r.body?.cancel?.(), (e) => console.error(`window: waking the games machine: ${e.message}`));
}

function createWindow(opts = {}) {
    const home = path.resolve(opts.home ?? process.env.WINDOW_HOME ?? '/data/window');
    const store = new Store(home);
    const viewLinks = () => {
        const d = parseOr(store.getDoc('admin', 'links'), null);
        return Array.isArray(d?.links) ? d.links.filter((l) => l && typeof l.id === 'string' && typeof l.key === 'string') : [];
    };
    let play = null;
    let tables = null;
    const auth = opts.auth ?? createAuth({ dir: path.join(home, 'auth'), invites: () => parseOr(store.getDoc('admin', 'invites'), null)?.logins ?? [], links: viewLinks, openTo: (next) => !!play?.openTo(next) || !!tables?.openTo(next) });
    // the games machine (coord/), woken when a bot comes in; a stopped machine starts on the request
    const wakeGames = opts.wakeGames ?? (() => wakeGamesAt(process.env.ARENA_GAMES_WAKE));
    const appData = appBuilder(store, { minMs: opts.minMs ?? 10000, parts: opts.appParts ?? null, staleMs: opts.staleMs ?? STALE_MS });
    const appFile = opts.app ?? process.env.ARENA_APP ?? path.join(ROOT, 'app', 'dist', 'public.html');
    const kitFile = opts.kit ?? process.env.ARENA_KIT ?? path.join(ROOT, 'vendor', 'holotable', 'swu-viewer-kit.js');
    // the third-party licenses of the packages bundled into the kit, which Holotable's build writes next to it
    const kitLicenses = path.join(path.dirname(kitFile), 'swu-viewer-kit.licenses.txt');
    // the browser swarm (spec/executor.md): /swarm and /api/swarm/*, relayed to the games machine for signed-in people
    const swarm = opts.swarm ?? createSwarmRelay({ cacheDir: path.join(home, 'swarm'), botDir: path.join(home, 'swarm-bots') });
    // the play page (play.js): a person against a bot in their own tab, on the swarm's files; games come back here
    play = createPlay({ store, swarm, auth, kitFile, wake: () => wakeGames(), mode: opts.play ?? process.env.ARENA_PLAY });
    // card art for the isolated pages (/play, /tables), which cannot show the CDN's images themselves (art.js)
    const art = opts.art ?? createArt();

    const arenaDoc = (id) => parseOr(store.getDoc('arena', id), undefined);
    // the open tables (tables.js): people against people or any arena bot, every game in a player's tab
    tables = createTables({
        store, swarm, auth, kitFile, wake: () => wakeGames(), mode: opts.tables ?? process.env.ARENA_TABLES,
        arena: { status: () => arenaDoc('status') ?? { competitors: [] }, versions: (name) => (/^[a-z][a-z0-9_]{0,31}$/.test(name) ? arenaDoc(`versions-${name}`) ?? null : null) },
        ...(opts.tablesFetch ? { fetchImpl: opts.tablesFetch } : {}),
        ...(opts.tablesLimits ?? {}) // tests: {perDay, maxRows}
    });
    // the feedback button and key on every page (feedback.js): who may send follows who may use a page here
    const feedback = createFeedback({ store, origin: auth.origin, mayPlay: () => play.mode === 'github' || tables.mode === 'github', ...(opts.feedbackLimits ?? {}) }); // tests: {now, perDay, allPerDay}
    // every game's own page (gamelinks.js): /g/<run>/<game>, live or replay, for anyone with no sign-in
    const gameLinks = createGameLinks({ store, publicUrl: auth.publicUrl, kitFile, replayFor, peopleRun: (run) => peopleRun(run, parseOr(store.getDoc('runs', run), null)) });
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

    // a replay as this reader may see it (maskReplay above), or null; the last few masked copies are kept
    const masked = new Map();
    function replayFor(who, run, game) {
        const buf = store.readReplay(run, game);
        if (!buf || !readsMasked(who)) {
            return buf;
        }
        const doc = parseOr(store.getDoc('runs', run), null);
        if (!peopleRun(run, doc)) {
            return buf;
        }
        const k = `${run}/${game}`;
        const sig = crypto.createHash('sha256').update(buf).update(JSON.stringify([doc?.bots ?? null, Array.isArray(doc?.games) ? doc.games.find((g) => g?.id === game) ?? null : null])).digest('hex');
        const hit = masked.get(k);
        if (hit?.sig === sig) {
            return hit.buf;
        }
        const out = maskReplay(buf, doc, game);
        masked.delete(k);
        masked.set(k, { sig, buf: out });
        if (masked.size > 24) {
            masked.delete(masked.keys().next().value);
        }
        return out;
    }
    // a run's replays with sizes; a people run's copies for readers are sized when each one is read (window_replay)
    const replaySizes = (who, run) => {
        const people = readsMasked(who) && peopleRun(run, parseOr(store.getDoc('runs', run), null));
        return store.listReplays(run).map((id) => ({ id, size: people ? null : store.replaySize(run, id) }));
    };

    // ---- /mcp: each person's own MCP client (Claude, Claude Code, Cursor...) signs in with GitHub through OAuth
    // (oauth.js) and reads as that person; the project token stays with bot/arena/mcp.js for pushing ----
    const oauth = createOAuth({ dir: path.join(home, 'auth'), auth, checkName: (login, name) => nameProblem(login, name) });
    auth.useBearer(oauth.lookup);
    const { METHODS } = require('./api');
    const RO = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
    const TYPE = { string: { type: 'string' }, integer: { type: 'integer' } };
    const schema = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
    const pick = (a, keys) => Object.fromEntries(keys.filter((k) => a[k] !== undefined && a[k] !== null).map((k) => [k, a[k]]));
    const REPLAY_SLICE = 100000;
    // GitHub logins ignore case; the arena names an owner github:<login> in lowercase. The owner decides, not the id
    // alone: the arena's own (house) submissions are house.<name>.<t>, and house is a GitHub login too.
    const mySubmissions = (login) => {
        const me = String(login).toLowerCase();
        return store.listDocs('submissions').filter((d) => d.id.startsWith(`${me}.`))
            .map((d) => parseOr(store.getDoc('submissions', d.id), null)).filter((x) => x && String(x.owner).toLowerCase() === me)
            .sort((x, y) => String(y.submittedAt).localeCompare(String(x.submittedAt)));
    };
    /**
     * Why @login may not submit as competitor n, or null: a name is its builder's (their builder name, or it with _ and
     * a suffix), never another person's builder name (bob may not take bob_x while @bob-x can sign in), and never
     * another person's competitor. arena_submit and an agent's connect link (oauth.js device grant) both ask.
     */
    function nameProblem(login, n) {
        login = String(login ?? '').toLowerCase();
        if (typeof n !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(n)) {
            return 'name: 1-32 characters, lowercase letters, digits and _, starting with a letter';
        }
        const { admins, fromEnv } = auth.fixed();
        const others = [...admins, ...fromEnv, ...invited()].map((x) => String(x).toLowerCase()).filter((x) => x !== login);
        if (!ownsName(login, n) || others.some((x) => builderName(x) === n)) {
            return notYours(login, n);
        }
        // a competitor of someone else's: the arena refuses it too, but say so now
        const theirs = (arenaMethods.status().competitors ?? []).find((c) => c?.name === n);
        if (theirs && theirs.owner !== `github:${login}`) {
            return `"${n}" is another competitor's name; submit under your own (whoami says your builder name)`;
        }
        return null;
    }

    /** arena_submit: checks the request and stores it for the arena's intake; nothing of it runs here. */
    function submit(who, { kind, note, files, base64 = [], entry, name } = {}) {
        need(who.login && LOGIN.test(who.login), 'forbidden', 'submitting takes a GitHub sign-in');
        const login = who.login.toLowerCase();
        // an agent's token (a person's Claude on their Sprite) submits as its one competitor, and only as that one
        need(!who.agent || name === undefined || name === null || name === who.agent, 'forbidden', `this agent's token submits only as ${who.agent}`);
        need(SUBMIT_KINDS.includes(kind), 'bad_request', `kind: one of ${SUBMIT_KINDS.join(', ')}`);
        need(typeof note === 'string' && note.trim() && note.length <= 300, 'bad_request', 'note: one line (up to 300 characters) saying what this version changes');
        submitFiles({ files, base64, entry });
        const n = name ?? who.agent ?? builderName(login);
        need(typeof n === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(n), 'bad_request', 'name: 1-32 characters, lowercase letters, digits and _, starting with a letter');
        const problem = nameProblem(login, n);
        need(!problem, 'conflict', problem);
        const mine = mySubmissions(login);
        const forName = mine.filter((x) => x.name === n);
        need(forName.filter((x) => x.state === 'pending' || x.state === 'checking').length < SUBMIT_PENDING, 'conflict',
            `${n} has ${SUBMIT_PENDING} submissions waiting for the arena; arena_my_submissions shows them`);
        const now = Date.now();
        const today = (xs) => xs.filter((x) => now - Date.parse(x.submittedAt) < 86400000).length;
        need(today(forName) < SUBMIT_PER_DAY, 'conflict', `at most ${SUBMIT_PER_DAY} submissions a day for one competitor`);
        need(today(mine) < SUBMIT_PER_DAY_PERSON, 'conflict', `at most ${SUBMIT_PER_DAY_PERSON} submissions a day over all your competitors`);
        const id = `${login}.${now.toString(36)}${crypto.randomBytes(2).toString('hex')}`;
        const doc = { id, owner: login, name: n, kind, note: note.trim(), files, ...(base64.length ? { base64 } : {}), ...(entry ? { entry } : {}),
            state: 'pending', submittedAt: new Date(now).toISOString() };
        store.putDoc('submissions', id, JSON.stringify(doc));
        wakeGames();
        return { id, name: n, kind, state: 'pending',
            next: 'The arena packs it, starts it once in its sandbox and enters it; arena_my_submissions shows the version it rates, or what to fix. While the arena is not running, it waits.' };
    }
    const mcpTools = [
        { name: 'whoami', description: 'Who this app reads the arena as, and what it may do.', inputSchema: schema({}), annotations: RO,
            call: ({ who }) => ({ login: who.login, role: who.role, app: who.app, builder: builderName(who.login), ...(who.agent ? { competitor: who.agent } : {}),
                may: who.agent ? `read games, replays, standings and research; submit bots as ${who.agent} only (arena_guide says how) and follow them (arena_my_submissions)`
                    : 'read games, replays, standings and research; submit your own bots (arena_guide says how) and follow them (arena_my_submissions)' }) },
        ...[...ARENA_READ].map((m) => ({
            name: `arena_${m}`, description: METHODS[m].desc, annotations: RO,
            inputSchema: schema(Object.fromEntries(Object.entries(METHODS[m].props).map(([k, t]) => [k, TYPE[t]])), METHODS[m].required ?? []),
            call: (ctx, a) => scrub(arenaMethods[m](pick(a, Object.keys(METHODS[m].props))))
        })),
        { name: 'window_docs', annotations: RO,
            description: `Without id: the documents in a collection (${[...FRIEND_NS].join(', ')}), with their sizes. With id: one document. "runs" holds every ladder, tournament round and game list; "evals" and "lens" a game's win-chance curves; "meta" the ratings and the Strategy Atlas.`,
            inputSchema: schema({ collection: { type: 'string', enum: [...FRIEND_NS] }, id: TYPE.string }, ['collection']),
            call: (ctx, { collection, id }) => {
                need(FRIEND_NS.has(collection), 'not_found', `collection: one of ${[...FRIEND_NS].join(', ')}`);
                if (id == null || id === '') {
                    return store.listDocs(collection);
                }
                const text = store.getDoc(collection, String(id));
                need(text != null, 'not_found', `no ${collection}/${id}`);
                return readerDoc(collection, String(id), JSON.parse(text), ctx.who);
            } },
        { name: 'window_replays', annotations: RO, description: "A run's recorded games (replays) and their sizes in bytes (in a run against people, window_replay gives each size).", inputSchema: schema({ run: TYPE.string }, ['run']),
            call: (ctx, { run }) => replaySizes(ctx.who, String(run ?? '')) },
        { name: 'window_replay', annotations: RO,
            description: `Part of one game's replay: JSON lines, a header, then one step per decision with the board (spec/replay-format.md in the swu_bot repo). Up to ${REPLAY_SLICE} bytes per call from byte \`from\`; size says how much there is.`,
            inputSchema: schema({ run: TYPE.string, game: TYPE.string, from: TYPE.integer, length: TYPE.integer }, ['run', 'game']),
            call: (ctx, { run, game, from = 0, length = REPLAY_SLICE }) => {
                const buf = replayFor(ctx.who, String(run ?? ''), String(game ?? ''));
                need(buf, 'not_found', `no replay ${run}/${game}`);
                // a slice starts and ends on whole characters, so slices read one after another (from + length) join
                // back into the replay; length says how many bytes this one holds
                const inside = (i) => i < buf.length && (buf[i] & 0xc0) === 0x80; // a UTF-8 continuation byte
                let a = Math.min(buf.length, Math.max(0, Number(from) || 0));
                while (inside(a)) a++;
                let b = Math.min(buf.length, a + Math.min(REPLAY_SLICE, Math.max(1, Number(length) || REPLAY_SLICE)));
                while (b > a && inside(b)) b--;
                if (b === a && a < buf.length) {
                    for (b = a + 1; inside(b); b++); // asked for less than one character: give that character
                }
                const slice = buf.subarray(a, b);
                return { run, game, size: buf.length, from: a, length: slice.length, text: slice.toString('utf8') };
            } },
        { name: 'arena_guide', annotations: RO,
            description: 'How to write a bot for the arena and submit it: the short guide (topic "build", default), or the full bot protocol (topic "protocol").',
            inputSchema: schema({ topic: { type: 'string', enum: ['build', 'protocol'] } }),
            call: (ctx, { topic = 'build' }) => {
                const file = topic === 'protocol' ? path.join(ROOT, 'spec', 'protocol.md') : path.join(__dirname, 'BUILD.md');
                need(fs.existsSync(file), 'not_found', `${topic}: not in this build of the window`);
                return { topic, text: fs.readFileSync(file, 'utf8') };
            } },
        { name: 'arena_submit',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            description: `Submit a bot as your next version. The arena packs it into a WebAssembly bundle, starts it once in its sandbox and, if it answers, rates it in its ladders under your builder name (whoami). kind "js": files with bot.js, a bot program speaking the protocol (require('./stdio') gives serve()); "python": files with bot.py; "wasm": a ready bundle with its arena.json (binary files listed in base64). arena_guide explains each. The check takes a minute or two while the arena runs: follow it with arena_my_submissions. Up to ${SUBMIT_PENDING} waiting at a time for each competitor. An agent's token (connected with a link for one competitor) submits only as that competitor.`,
            inputSchema: schema({
                kind: { type: 'string', enum: SUBMIT_KINDS }, note: { type: 'string', description: 'one line: what this version changes and why' },
                files: { type: 'object', description: 'path -> file content, e.g. {"bot.js": "..."}', additionalProperties: { type: 'string' } },
                base64: { type: 'array', items: { type: 'string' }, description: 'the paths in files whose content is base64 (binary files of a wasm bundle)' },
                entry: { type: 'string', description: 'the file that starts the bot, if not bot.js / bot.py' },
                name: { type: 'string', description: 'the competitor to submit to: your builder name (the default; an agent\'s token: its competitor) or it with _ and a suffix, e.g. ana_fast. A new name makes a new competitor of yours' }
            }, ['kind', 'note', 'files']),
            call: ({ who }, a) => submit(who, a) },
        { name: 'arena_my_submissions', annotations: RO,
            description: 'Your submissions (an agent\'s token: its competitor\'s), newest first: pending, checking, accepted (with the version the arena rates) or rejected (with what to fix).',
            inputSchema: schema({}),
            call: ({ who }) => mySubmissions(who.login).filter((x) => !who.agent || x.name === who.agent)
                .map(({ files, base64, ...rest }) => ({ ...rest, ...(files ? { fileNames: Object.keys(files) } : {}) })) }
    ];
    const MCP_CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id', 'access-control-expose-headers': 'www-authenticate, mcp-session-id' };
    const mcp = createMcpHttp({
        name: 'swu-arena', version: '1.0.0', tools: mcpTools, headers: MCP_CORS, maxBody: 5 << 20,
        instructions: 'SWU Arena: Star Wars Unlimited bots playing each other and people. Start with whoami and arena_status; window_docs lists the runs, evaluations and research; window_replay reads a game move by move. To build a bot, read arena_guide, then submit it with arena_submit and follow it with arena_my_submissions: the arena runs every game itself, in a sandbox.'
    });
    function mcpRoute(req, res) {
        if (req.method === 'OPTIONS') {
            res.writeHead(204, { ...MCP_CORS, 'access-control-max-age': '600' });
            return res.end();
        }
        const who = auth.who(req);
        if (who.via !== 'oauth' || !atLeast(who.role, 'friend')) {
            const message = who.via === 'oauth' ? `@${who.login} is not on the invite list (any more)`
                : who.via === 'bearer' && who.role !== 'bad' ? 'this endpoint takes a person\'s own sign-in; the project token works with bot/arena/mcp.js'
                    : 'connect this server in your MCP client: it opens a GitHub sign-in';
            res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': oauth.challenge(who.via !== 'cookie'), ...MCP_CORS });
            return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message } }));
        }
        return mcp.handle(req, res, { who });
    }

    /**
     * A person's own connected apps, for the app's Build a bot page: GET lists them with the MCP address; POST {disconnect: id}
     * ends one, from this site's own pages only (Origin and JSON, as share() checks).
     */
    async function apps(req, res, who) {
        need(who.login, 'forbidden', 'sign in with GitHub to connect apps');
        if (req.method === 'POST') {
            need(who.via === 'cookie' && req.headers.origin === auth.origin, 'forbidden', "apps are disconnected only from this site's own pages");
            need(/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? ''), 'bad_request', 'send JSON');
            let q;
            try {
                q = JSON.parse((await readBody(req, 1024)).toString('utf8'));
            } catch (e) {
                throw e instanceof WindowError ? e : new WindowError('bad_request', 'body is not JSON');
            }
            need(typeof q?.disconnect === 'string' && oauth.end(who.login, q.disconnect), 'not_found', 'no such app of yours');
        } else {
            need(req.method === 'GET', 'bad_request', 'GET, or POST {disconnect: id}');
        }
        // the tools a connected app gets, from the server's own list, so the Build a bot page cannot drift from it
        const tools = mcpTools.map((t) => ({ name: t.name, does: String(t.description).split(/(?<=\.)\s/)[0], readOnly: t.annotations?.readOnlyHint === true }));
        return sendJson(res, 200, { result: { mcp: `${auth.publicUrl}/mcp`, apps: oauth.grantsOf(who.login), tools } }, req);
    }

    function sendJson(res, code, body, req) {
        if (res.headersSent) {
            return;
        }
        const text = JSON.stringify(body);
        sendText(res, req, code, 'application/json', text);
    }

    function sendText(res, req, code, type, text, headers = {}) {
        // every page this site sends gets the feedback button and key (feedback.js), so no page has to add it
        if (/^text\/html\b/.test(type)) {
            text = feedback.inject(text);
        }
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

    const invited = () => {
        const d = parseOr(store.getDoc('admin', 'invites'), null);
        return Array.isArray(d?.logins) ? d.logins.filter((x) => typeof x === 'string').map((x) => x.toLowerCase()) : [];
    };
    /** The Share page's lists; a login the server already lets in (admins, ARENA_INVITES) shows there, never as an invite. */
    const shared = () => {
        const fixed = auth.fixed(), set = new Set([...fixed.admins, ...fixed.fromEnv]);
        return { invites: invited().filter((x) => !set.has(x)), ...fixed, links: viewLinks().map(({ id, key, label, createdAt }) => ({ id, key, label, createdAt })) };
    };
    /**
     * Who may look, for Eric's Share page: GET lists the invited GitHub logins and the view links; POST changes one of
     * them: {add: login} or {remove: login} on the invite document, {addLink: note} or {removeLink: id} on the view
     * links (admin/links; a view link lets anyone holding it read, with no sign-in). The one write a signed-in browser
     * may make: only an admin, only from this site's own pages (the Origin header; a page elsewhere cannot set it), and
     * only as JSON (a plain form cannot send that). A removal takes effect on that person's next request.
     */
    async function share(req, res, who) {
        need(who.role === 'admin', 'forbidden', 'only an admin changes who can look');
        if (req.method === 'GET') {
            return sendJson(res, 200, { result: shared() }, req);
        }
        need(req.method === 'POST', 'bad_request', 'GET, or POST {add}, {remove}, {addLink} or {removeLink}');
        if (who.via === 'cookie') {
            need(req.headers.origin === auth.origin, 'forbidden', "the invite list changes only from this site's own pages");
            need(/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? ''), 'bad_request', 'send JSON');
        }
        let q;
        try {
            q = JSON.parse((await readBody(req, 4096)).toString('utf8'));
        } catch (e) {
            throw e instanceof WindowError ? e : new WindowError('bad_request', 'body is not JSON');
        }
        const ops = ['add', 'remove', 'addLink', 'removeLink'].filter((k) => typeof q?.[k] === 'string');
        need(ops.length === 1, 'bad_request', 'send one of {"add": "<GitHub login>"}, {"remove": "<GitHub login>"}, {"addLink": "<who it is for>"}, {"removeLink": "<id>"}');
        const keep = (ns) => {
            const d = parseOr(store.getDoc('admin', ns), null);
            return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
        };
        if (ops[0] === 'add' || ops[0] === 'remove') {
            const login = q[ops[0]].trim().replace(/^@/, '').toLowerCase();
            need(LOGIN.test(login), 'bad_request', 'a GitHub login: letters, digits and dashes, up to 39');
            // a login the server lets in would never leave the list it shows, so the page could not remove it
            const { admins, fromEnv } = auth.fixed();
            need(ops[0] !== 'add' || ![...admins, ...fromEnv].includes(login), 'conflict', `${login} can already sign in (set by the server)`);
            const cur = invited();
            const next = ops[0] === 'add' ? [...new Set([...cur, login])] : cur.filter((x) => x !== login);
            need(next.length <= 500, 'too_large', 'at most 500 invites');
            store.putDoc('admin', 'invites', JSON.stringify({ ...keep('invites'), logins: next, updatedAt: new Date().toISOString() }));
        } else if (ops[0] === 'addLink') {
            // the note says who the link is for; only admins ever see it
            const label = q.addLink.replace(/\s+/g, ' ').trim();
            need(label.length >= 1 && label.length <= 60 && !/[\u0000-\u001f\u007f]/.test(label), 'bad_request', 'a short note, up to 60 characters: who the link is for');
            const cur = viewLinks();
            need(cur.length < 100, 'too_large', 'at most 100 view links; remove one first');
            const link = { id: crypto.randomBytes(6).toString('hex'), key: crypto.randomBytes(24).toString('base64url'), label, createdAt: new Date().toISOString() };
            store.putDoc('admin', 'links', JSON.stringify({ ...keep('links'), links: [...cur, link] }));
        } else {
            need(/^[0-9a-f]{12}$/.test(q.removeLink), 'bad_request', 'removeLink: the id of a view link');
            store.putDoc('admin', 'links', JSON.stringify({ ...keep('links'), links: viewLinks().filter((l) => l.id !== q.removeLink) }));
        }
        return sendJson(res, 200, { result: shared() }, req);
    }

    /** The settings Eric set, without anything a doc might carry besides them. */
    const settingsDoc = () => {
        const d = parseOr(store.getDoc('admin', 'arena-settings'), null);
        const set = d && typeof d.settings === 'object' && d.settings ? d.settings : {};
        const settings = Object.fromEntries(Object.keys(SETTINGS).filter((k) => okSetting(k, set[k])).map((k) => [k, set[k]]));
        return { settings, updatedAt: typeof d?.updatedAt === 'string' ? d.updatedAt : null, by: typeof d?.by === 'string' ? d.by : null };
    };
    /**
     * Eric's arena settings (SETTINGS): GET for an admin and for the games machine's own token, which reads them every
     * minute; POST {set: {name: value | null}} changes some of them (null: back to the machine's default), for an admin
     * only and, from a browser, only from this site's own pages and as JSON, as on the Share page.
     */
    async function arenaSettings(req, res, who) {
        const machine = who.via === 'bearer' && who.games === true;
        need(who.role === 'admin' || (machine && req.method === 'GET'), 'forbidden', 'only an admin changes the arena settings');
        if (req.method === 'GET') {
            return sendJson(res, 200, { result: settingsDoc() }, req);
        }
        need(req.method === 'POST', 'bad_request', 'GET, or POST {"set": {"<name>": <value> or null}}');
        if (who.via === 'cookie') {
            need(req.headers.origin === auth.origin, 'forbidden', "the arena settings change only from this site's own pages");
            need(/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? ''), 'bad_request', 'send JSON');
        }
        let q;
        try {
            q = JSON.parse((await readBody(req, 4096)).toString('utf8'));
        } catch (e) {
            throw e instanceof WindowError ? e : new WindowError('bad_request', 'body is not JSON');
        }
        const set = q?.set;
        need(set && typeof set === 'object' && !Array.isArray(set) && Object.keys(set).length > 0, 'bad_request', 'send {"set": {"<name>": <value> or null}}');
        for (const [k, v] of Object.entries(set)) {
            const rule = Object.hasOwn(SETTINGS, k) ? SETTINGS[k] : null;
            need(rule, 'bad_request', `${k}: not a setting (${Object.keys(SETTINGS).join(', ')})`);
            need(v === null || okSetting(k, v), 'bad_request', `${k}: ${rule.even ? 'an even' : 'a whole'} number from ${rule.min} to ${rule.max}, or null for the default`);
        }
        const next = { ...settingsDoc().settings };
        for (const [k, v] of Object.entries(set)) {
            if (v === null) {
                delete next[k];
            } else {
                next[k] = v;
            }
        }
        store.putDoc('admin', 'arena-settings', JSON.stringify({ settings: next, updatedAt: new Date().toISOString(), by: who.login ?? 'admin token' }));
        return sendJson(res, 200, { result: settingsDoc() }, req);
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
            return sendJson(res, 200, { result: { login: who.login ?? null, role: who.role, ...(who.guest ? { guest: true } : {}) } }, req);
        }
        if (parts[0] === 'share' && parts.length === 1) {
            return share(req, res, who);
        }
        if (parts[0] === 'arena-settings' && parts.length === 1) {
            return arenaSettings(req, res, who);
        }
        if (parts[0] === 'apps' && parts.length === 1) {
            return apps(req, res, who);
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
                        return sendJson(res, 200, { result: list.map((d) => ({ ...d, doc: readerDoc(ns, d.id, parseOr(store.getDoc(ns, d.id), null), who) })) }, req);
                    }
                    return sendJson(res, 200, { result: list }, req);
                }
                const text = store.getDoc(ns, id);
                need(text != null, 'not_found', `no ${ns}/${id}`);
                const doc = friend || (ns === 'runs' && readsMasked(who)) ? JSON.parse(text) : null;
                return doc && (friend || (readsMasked(who) && peopleRun(id, doc))) ? sendJson(res, 200, { result: readerDoc(ns, id, doc, who) }, req) : sendText(res, req, 200, 'application/json', `{"result":${text}}`);
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
                    need(run, 'bad_request', `a run document needs games: [{id: "${who.feed}-<id>", p1, p2, outcome: running|won|draw|abandoned, winnerSeat, rounds, steps, error}] with distinct ids, a createdAt date, and seats (and bots, if any) named in plain words (WINDOW.md, "Outside machines")`);
                    // the run keeps which feed sent it, so the app never rates its games (model.cjs)
                    text = JSON.stringify(run);
                    keepPeopleNames(store, doc.games);
                } else if (ns === 'runs' && doc && typeof doc === 'object' && peopleRun(id, doc)) {
                    // a run against people sent with the project token: it must name our bots, and is stored with every
                    // other seat as "opponent", like a feed's run, so no read path (the app's model included) sees a name
                    need(!Array.isArray(doc.games) || !doc.games.length || oursOf(doc).size > 0, 'bad_request', 'a run against people must list our bots in "bots"; every other seat is stored as "opponent"');
                    text = JSON.stringify(maskRun(doc));
                }
                // a submission written straight to the collection (ops/house-submit.js, the arena's own bots) wakes the
                // games machine as arena_submit does; the machine's own writes update submissions that already exist
                const wake = ns === 'submissions' && doc?.state === 'pending' && store.getDoc(ns, id) == null;
                store.putDoc(ns, id, text);
                if (wake) {
                    wakeGames();
                }
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
                    return sendJson(res, 200, { result: q.sizes === '1' ? replaySizes(who, run) : store.listReplays(run) }, req);
                }
                const buf = replayFor(who, run, game);
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
            // the kit's license list, for anyone: its banner names the file, next to /kit.js and /play/kit.js
            if (req.method === 'GET' && (url.pathname === '/swu-viewer-kit.licenses.txt' || url.pathname === '/play/swu-viewer-kit.licenses.txt')) {
                return serveFile(req, res, kitLicenses, 'text/plain; charset=utf-8');
            }
            if (await auth.routes(req, res, url)) {
                return undefined;
            }
            if (await oauth.routes(req, res, url)) {
                return undefined;
            }
            if (url.pathname === '/mcp') {
                return mcpRoute(req, res);
            }
            // the open tables' logs: read with a reader token, which is no bearer token of the window's own
            if (await tables.openRoute(req, res, url, { sendJson, sendText })) {
                return undefined;
            }
            const who = auth.who(req);
            if (who.role === 'bad') {
                return sendJson(res, 401, { error: { code: 'unauthorized', message: 'wrong bearer token' } }, req);
            }
            if (await art.route(req, res, url, who)) {
                return undefined;
            }
            if (await play.route(req, res, url, who, { sendJson, sendText, readBody })) {
                return undefined;
            }
            if (await tables.route(req, res, url, who, { sendJson, sendText, readBody })) {
                return undefined;
            }
            if (await swarm.route(req, res, url, who, { sendJson, sendText, readBody })) {
                return undefined;
            }
            // feedback (feedback.js): anyone who may use a page here, invited or not, so before the invite check
            if (await feedback.route(req, res, url, who, { sendJson, sendText, readBody })) {
                return undefined;
            }
            // every game's own page (gamelinks.js): /g/<run>/<game> opens for anyone, so before the invite check
            if (await gameLinks.route(req, res, url, { sendJson, sendText })) {
                return undefined;
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
                if (!fs.existsSync(appFile)) {
                    return sendText(res, req, 503, 'text/plain', 'the app is not built: npm run app -- --public (app/README.md)');
                }
                return serveFile(req, res, appFile, 'text/html; charset=utf-8');
            }
            // the old arena page is gone; its bookmarks open the app
            if (url.pathname === '/arena' || url.pathname === '/arena.html') {
                res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
                return res.end();
            }
            if (url.pathname === '/strategy-diagram.js') {
                return serveFile(req, res, path.join(__dirname, 'web', 'strategy-diagram.js'), 'text/javascript');
            }
            if (url.pathname === '/kit.js') {
                return serveFile(req, res, kitFile, 'text/javascript');
            }
            // replay links in the replays-server shape of spec/replay-format.md (<ladder>/games/<id>.jsonl and <ladder>/index.json), from the window's collections
            const rep = /^\/replays\/([\w.%@+-]+)\/(?:games\/([\w.%@+-]+)\.jsonl|(index)\.json)$/.exec(url.pathname);
            if (rep) {
                const dec = (x) => {
                    try {
                        return decodeURIComponent(x);
                    } catch {
                        return '';
                    }
                };
                const runDoc = rep[3] ? parseOr(store.getDoc('runs', dec(rep[1])), null) : null;
                const text = rep[3] ? runDoc && JSON.stringify(readerDoc('runs', dec(rep[1]), runDoc, who)) : replayFor(who, dec(rep[1]), dec(rep[2]));
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

    return { handle, store, auth, wakeGames, tables };
}

module.exports = { createWindow, wakeGamesAt, Store, storeReader, settleRun, scrub, appBuilder, submitFiles, NS, FRIEND_NS };
