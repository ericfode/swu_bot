'use strict';
/**
 * The window's open tables (/tables): people play each other, or any arena bot, on Holotable's play screen. Every
 * game runs in a player's browser tab (bot/table/open.js in tables-worker.js, on the swarm's engine pack): a bot game
 * in the person's own tab, a people game in the host's tab, with the guest's tab linked to it. The window only puts
 * people in touch (lobby.js: invite codes, the queue, the WebRTC handshake, and a relay when the two browsers cannot
 * reach each other), lists the bots, reads SWUDB decks (swudb.js), and keeps the finished games for training, with an
 * API that anyone signed in with GitHub can read with a free reader token. Eric's picks (2026-10-16): no ratings yet,
 * every game hosted by a player's browser (1A); logs readable with a reader token (2B); the same random id for a player
 * in every log, never a GitHub name (3A); any arena bot that runs in a browser (4B); both players trusted in this
 * first version (no signed moves, no deal proof).
 *
 *   const tables = createTables({ store, swarm, auth, kitFile, arena, wake });
 *   if (await tables.openRoute(req, res, url, helpers)) return;      // /api/open/*, before the window's own auth
 *   if (await tables.route(req, res, url, who, helpers)) return;     // helpers: {sendJson, sendText, readBody}
 *   tables.openTo(next)   // whether GitHub sign-in may return a login with no role to `next` (auth.js openTo)
 *
 * ARENA_TABLES says who may play: 'invited' (the default), 'github' (anyone signed in with GitHub) or 'off'. Reader
 * tokens are for anyone signed in with GitHub whatever the mode.
 *
 *   GET  /tables                         the page (web/tables.html, cross-origin isolated so arena bots can run)
 *   GET  /tables/kit.js                  the viewer kit
 *   GET  /tables/<file>?b=<build>        engine.json, tables-worker.js, bot-worker.js, python-lib.json, python.wasm, and
 *                                        the JEPA bot's models (tx-t10.safetensors, tx-t10-e.safetensors)
 *   GET  /tables/bot/<sha256>.tar        an arena bot's bundle (swarm-relay.js lineup)
 *   GET  /tables/logs                    how to read the logs; a button for your reader token
 *   GET  /api/tables/info                {mode, login, you, admin, ready, build, files, why?, decks, bots, people, games}
 *   POST /api/tables/deck {text}         a SWUDB link or a pasted deck list -> {deck}
 *   POST /api/tables/invite              -> {room, code, k}: a room you host; your friend joins with the code
 *   POST /api/tables/join {code}         -> {room, k, peer}
 *   POST /api/tables/queue               -> {ticket, k}: find a game (the stream says who you are paired with)
 *   GET  /api/tables/stream?room&side&k  the side's server-sent events (or ?ticket&k for the queue)
 *   POST /api/tables/send?room&side&k    {msg} for the other side
 *   POST /api/tables/leave?room&side&k
 *   POST /api/tables/games {replay, seat}   keeps a finished game: {id}; the other player sending it too adds their seat
 *   GET  /api/tables/games               your games; GET /api/tables/games/<id>.jsonl one of them
 *   POST /api/tables/me {renew: true}    a new random player id for your next games
 *   POST /api/tables/token               a new reader token (the old one stops working): {token}
 *   GET  /api/open/games?since&limit     (reader token) the kept games, oldest first: {games, next}
 *   GET  /api/open/games/<id>.jsonl      (reader token) a game's replay
 *   GET  /api/open/weeks                 (reader token) [{week, games}]
 *   GET  /api/open/weeks/<week>.tar.gz   (reader token) a week's games as tables-<week>/index.json and games/<id>.jsonl
 *
 * Games are kept in the run "tables" as a people run (window.js peopleRun), unrated; who played which seat is kept in
 * admin/tables-people for admins only.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');
const { atLeast, LOGIN } = require('./auth');
const { createLobby, LobbyError, MAX_MSG } = require('./lobby');
const { swudbId, fetchSwudb, deckFromJson } = require('./swudb');
const { normalizeDeck } = require('../decklists');

const RUN = 'tables';
const JEPA = 'jepa-tx-gate';
const MODES = new Set(['off', 'invited', 'github']);
// the JEPA bot's models (bot/swarm/pack.js MODELS) and where the worker puts each, fetched only for a game against it
const MODELS = { 'tx-t10.safetensors': '/app/vendor/jepa/tx-t10.safetensors', 'tx-t10-e.safetensors': '/app/vendor/jepa/tx-t10-e.safetensors' };
const FILES = ['engine.json', 'tables-worker.js', 'bot-worker.js', 'python-lib.json', 'python.wasm', ...Object.keys(MODELS)];
const NEEDED = ['engine.json', 'tables-worker.js', 'bot-worker.js'];
const PEOPLE = ['lobby', 'invite', 'join', 'direct'];
// the page and the worker scripts: SharedArrayBuffer (a bot blocks on its stdin) needs cross-origin isolation, and
// credentialless lets the card art from swu-db's CDN load without the CDN's say-so (browsers without it get no
// arena bots, only the JEPA bot)
const ISOLATED_PAGE = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless' };
const PID = /^pl_[0-9a-f]{6}$/;
const VERSION = /^[a-z][a-z0-9_]*-v\d+$/;
const GAME = /^open-[0-9a-f]{8}-[0-9a-f]{8}$/;
const WEEK = /^\d{4}-W\d{2}$/;
const NAME = /^[A-Za-z0-9][\w .@#+()'&/,!?-]{0,79}$/;
const MAX_REPLAY = 16e6;
const MAX_LINES = 40000;
const MAX_ROWS = 20000;
const PER_DAY = 80; // games a person may send a day
const ROOMS_PER_HOUR = 60;
const DECKS_PER_HOUR = 60;
const WAKE_MS = 15 * 60000;
const DECKS = path.join(__dirname, '..', 'decks', 'ash-meta-2026-09.json');

const parseOr = (text, dflt) => {
    try {
        return text == null ? dflt : JSON.parse(text);
    } catch {
        return dflt;
    }
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

/** The ISO week of a time, as 2026-W42. */
function isoWeek(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        return null;
    }
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const year = t.getUTCFullYear();
    const week = Math.ceil(((t - Date.UTC(year, 0, 1)) / 864e5 + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * A finished open-table game's replay (spec/replay-format.md) as tables-worker.js writes it: a header whose seats are
 * people (lang person, a random player id) or bots, at least one a person; step lines; an end line. Returns
 * {header, end, steps} or throws a reason.
 */
function checkReplay(text) {
    if (typeof text !== 'string' || !text.length) {
        throw new Error('replay: the game as JSON Lines text');
    }
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }
    if (lines.length < 3 || lines.length > MAX_LINES) {
        throw new Error(`replay: a header, steps and an end line (${lines.length} lines)`);
    }
    const parse = (line, i) => {
        const e = parseOr(line, null);
        if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.t !== 'string') {
            throw new Error(`replay line ${i + 1}: not a replay event`);
        }
        return e;
    };
    const header = parse(lines[0], 0);
    const end = parse(lines[lines.length - 1], lines.length - 1);
    for (let i = 1; i < lines.length - 1; i++) {
        if (!lines[i].startsWith('{"t":"step"') || parse(lines[i], i).t !== 'step') {
            throw new Error(`replay line ${i + 1}: a step`);
        }
    }
    const p = Array.isArray(header.players) ? header.players : [];
    if (header.t !== 'header' || header.v !== 1 || p.length !== 2 || p[0]?.id !== 'p1' || p[1]?.id !== 'p2') {
        throw new Error('replay header: two seats, p1 and p2');
    }
    for (const x of p) {
        const person = x.lang === 'person';
        if (person ? !PID.test(String(x.bot)) : !(VERSION.test(String(x.bot)) || x.bot === JEPA)) {
            throw new Error(`replay header: ${x.id} is a player id (pl_ and 6 hex digits) or an arena bot, not ${JSON.stringify(String(x.bot)).slice(0, 40)}`);
        }
    }
    if (!p.some((x) => x.lang === 'person')) {
        throw new Error('replay header: at least one seat is a person');
    }
    if (!Number.isInteger(header.seed) || header.seed < 0 || header.seed >= 2 ** 32) {
        throw new Error('replay header: the game seed');
    }
    if (!['p1', 'p2'].every((s) => typeof header.decks?.[s]?.metadata?.name === 'string' && NAME.test(header.decks[s].metadata.name))) {
        throw new Error('replay header: both deck lists, by name');
    }
    const n = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : null);
    if (end.t !== 'end' || typeof end.outcome !== 'string' || n(end.steps) === null || n(end.round) === null) {
        throw new Error('replay: the last line is the end of the game');
    }
    return { header, end, steps: lines.length - 2 };
}

/** The run row of a checked game: seats by public name, who won, and the decks. */
function rowOf(id, { header, end }, { sha256, bytes, at }) {
    const names = { p1: header.players[0].bot, p2: header.players[1].bot };
    let outcome = 'abandoned';
    let winnerSeat = null;
    let concededBy = null;
    if (end.outcome === 'won' && (end.winner === 'p1' || end.winner === 'p2')) {
        outcome = 'won';
        winnerSeat = end.winner;
    } else if (end.outcome === 'ERROR' && (end.by === 'p1' || end.by === 'p2')) {
        // a seat that breaks the game loses it; a concession ends it that way too (bot/table/person.js)
        outcome = 'won';
        winnerSeat = end.by === 'p1' ? 'p2' : 'p1';
        concededBy = /conceded/.test(String(end.error ?? '')) ? end.by : null;
    } else if (end.winner === 'draw') {
        outcome = 'draw';
    }
    return {
        id, p1: names.p1, p2: names.p2, people: header.players.filter((x) => x.lang === 'person').map((x) => x.id),
        outcome, winnerSeat, winner: outcome === 'draw' ? 'draw' : winnerSeat ? names[winnerSeat] : null,
        rounds: end.round, steps: end.steps, error: (end.outcome === 'ERROR' && !concededBy) || outcome === 'abandoned' ? 'no result' : null,
        conceded: !!concededBy, concededBy, decks: { p1: header.decks.p1.metadata.name, p2: header.decks.p2.metadata.name }, playedAt: at, bytes, sha256
    };
}

/**
 * A page of the kept games after `since` (oldest first): at most `limit`, and more when the games after the last one
 * share its playedAt, since the next page starts after that time. `next` is that time, or null on the last page.
 */
function pageOf(rows, since, limit) {
    const after = since ? rows.filter((r) => String(r.playedAt) > since) : rows;
    let end = Math.min(limit, after.length);
    while (end < after.length && after[end].playedAt === after[end - 1].playedAt) {
        end++;
    }
    return { games: after.slice(0, end), next: end < after.length ? after[end - 1].playedAt : null };
}

/** One file of a ustar archive: its header, its data and the padding after it. An archive ends with TAR_END. */
function tarEntry(name, data, mtime = Math.floor(Date.now() / 1000)) {
    const h = Buffer.alloc(512);
    const put = (s, off, len) => h.write(s, off, len, 'utf8');
    put(name.slice(-100), 0, 100);
    put('0000644\0', 100, 8);
    put('0000000\0', 108, 8);
    put('0000000\0', 116, 8);
    put(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    put(`${mtime.toString(8).padStart(11, '0')}\0`, 136, 12);
    h.fill(' ', 148, 156);
    put('0', 156, 1);
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    let sum = 0;
    for (const b of h) {
        sum += b;
    }
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    return [h, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
}
const TAR_END = Buffer.alloc(1024);

function createTables({
    store, swarm, auth, kitFile, arena = { status: () => ({ competitors: [] }), versions: () => null }, wake = () => undefined,
    mode = process.env.ARENA_TABLES || 'invited', page = path.join(__dirname, 'web', 'tables.html'), decksFile = DECKS,
    fetchImpl = globalThis.fetch, now = Date.now, lobby = createLobby({ now }), perDay = PER_DAY, maxRows = MAX_ROWS
} = {}) {
    const on = MODES.has(mode) ? mode : 'invited';
    const sentGames = new Map(); // login -> times of the games they sent, the last day, and a slot per upload under way
    const rate = new Map(); // `${what}:${login}` -> times, the last hour
    const deckCache = new Map(); // SWUDB id -> {at, deck}
    let woke = 0;
    let kit = null;

    let lists = [];
    try {
        const raw = parseOr(fs.readFileSync(decksFile, 'utf8'), []);
        lists = (Array.isArray(raw) ? raw : raw?.decks ?? []).map((d, i) => normalizeDeck(d, i));
    } catch (e) {
        console.error(`tables: no deck lists (${e.message})`);
    }
    const deckOptions = lists.map((d) => ({ name: d.metadata.name, leader: d.leader.id, base: d.base.id, style: d.metadata.style ?? null }));

    /** A GitHub login signed in on this site (not a view link's guest), or null. */
    const github = (who) => (who.via === 'cookie' && !who.guest && typeof who.login === 'string' && LOGIN.test(who.login) ? who.login.toLowerCase() : null);
    /** The login of a person who may play here, or null. */
    const player = (who) => {
        const login = github(who);
        return login && (on === 'github' || atLeast(who.role, 'friend')) ? login : null;
    };
    const openTo = (next) => typeof next === 'string' && (/^\/tables\/logs(?:[?#]|$)/.test(next) || (on === 'github' && /^\/tables(?:[/?#]|$)/.test(next)));

    const limited = (what, login, max, ms = 3600000) => {
        const k = `${what}:${login}`;
        const t = now();
        const times = (rate.get(k) ?? []).filter((x) => t - x < ms);
        if (times.length >= max) {
            return true;
        }
        rate.set(k, [...times, t]);
        return false;
    };

    // ---- public player ids (3A): one random id per login, the same in every log, new on request ----
    const ids = () => {
        const d = parseOr(store.getDoc('admin', 'tables-ids'), null)?.ids;
        return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    };
    function pidOf(login, renew = false) {
        const all = ids();
        if (!renew && PID.test(String(all[login]))) {
            return all[login];
        }
        const taken = new Set(Object.values(all));
        let pid;
        do {
            pid = `pl_${crypto.randomBytes(3).toString('hex')}`;
        } while (taken.has(pid));
        all[login] = pid;
        store.putDoc('admin', 'tables-ids', JSON.stringify({ ids: all, updatedAt: new Date(now()).toISOString() }));
        return pid;
    }

    // ---- reader tokens (2B): one per GitHub login, kept as its sha256 ----
    const tokens = () => {
        const d = parseOr(store.getDoc('admin', 'tables-tokens'), null)?.tokens;
        return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    };
    function newToken(login) {
        const all = tokens();
        for (const [h, t] of Object.entries(all)) {
            if (t?.login === login) {
                delete all[h];
            }
        }
        const token = `swu_r_${crypto.randomBytes(24).toString('hex')}`;
        all[sha(token)] = { login, at: new Date(now()).toISOString() };
        store.putDoc('admin', 'tables-tokens', JSON.stringify({ tokens: all }));
        return token;
    }
    const tokenLogin = (token) => (typeof token === 'string' && /^swu_r_[0-9a-f]{48}$/.test(token) ? tokens()[sha(token)]?.login ?? null : null);

    // ---- the games ----
    const runDoc = () => {
        const d = parseOr(store.getDoc('runs', RUN), null);
        return d && typeof d === 'object' && Array.isArray(d.games) ? d : { id: RUN, feed: RUN, kind: 'tables', createdAt: new Date(now()).toISOString(), bots: [], games: [] };
    };
    const people = () => {
        const d = parseOr(store.getDoc('admin', 'tables-people'), null)?.games;
        return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    };
    const brief = (r, pid) => {
        const mine = r.p1 === pid ? 'p1' : r.p2 === pid ? 'p2' : null;
        return {
            id: r.id, seat: mine, opponent: mine ? r[mine === 'p1' ? 'p2' : 'p1'] : null, p1: r.p1, p2: r.p2, outcome: r.outcome, winnerSeat: r.winnerSeat,
            winner: r.winner, won: mine ? r.winnerSeat === mine : null, conceded: !!r.conceded, concededBy: r.concededBy ?? null, rounds: r.rounds, steps: r.steps, decks: r.decks, playedAt: r.playedAt
        };
    };

    // ---- the bots (4B): Eric's JEPA bot, and every version of the arena's latest round whose bundle the window has ----
    async function bots() {
        const out = [{ name: JEPA, title: "Eric's JEPA bot", owner: 'ericfode', elo: null, bytes: null, runtime: 'js', url: null, bundle: null }];
        const lineup = swarm.on() ? await swarm.lineup().catch(() => null) : null;
        const comps = Array.isArray(arena.status()?.competitors) ? arena.status().competitors : [];
        for (const b of lineup?.bots ?? []) {
            const agent = b.name.replace(/-v\d+$/, '');
            const c = comps.find((x) => x?.latest === b.name) ?? comps.find((x) => x?.name === agent) ?? null;
            const v = (arena.versions(agent) ?? []).find((x) => x?.name === b.name);
            const files = Array.isArray(v?.files) ? v.files : [];
            out.push({
                name: b.name, title: typeof c?.title === 'string' ? c.title : agent, owner: typeof c?.owner === 'string' ? c.owner.replace(/^github:/, '') : null,
                elo: Number.isFinite(c?.elo) ? Math.round(c.elo) : null, bytes: b.bytes, runtime: files.some((f) => /\.py$/.test(f)) ? 'python' : 'wasm',
                url: `/tables/bot/${b.bundle}.tar`, bundle: b.bundle, note: typeof v?.note === 'string' ? v.note.slice(0, 160) : null
            });
        }
        return [out[0], ...out.slice(1).sort((a, b) => (b.elo ?? -1) - (a.elo ?? -1))];
    }

    function sendPage(req, res, code, html, sendText, headers = {}) {
        sendText(res, req, code, 'text/html; charset=utf-8', html, headers);
        return true;
    }

    function sendKit(req, res, sendText) {
        let st;
        try {
            st = fs.statSync(kitFile);
        } catch {
            sendText(res, req, 404, 'text/plain', 'not found');
            return true;
        }
        if (!kit || kit.mtimeMs !== st.mtimeMs) {
            const raw = fs.readFileSync(kitFile);
            kit = { mtimeMs: st.mtimeMs, raw, gz: zlib.gzipSync(raw) };
        }
        const gzip = /gzip/.test(req.headers['accept-encoding'] || '');
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache', vary: 'accept-encoding', 'cross-origin-resource-policy': 'same-origin', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
        res.end(gzip ? kit.gz : kit.raw);
        return true;
    }

    async function info(req, res, who, login, sendJson) {
        const pid = pidOf(login);
        const doc = runDoc();
        const mine = doc.games.filter((r) => r.p1 === pid || r.p2 === pid).slice(-30).reverse().map((r) => brief(r, pid));
        const admin = who.role === 'admin';
        const out = {
            on: true, mode: on, login, you: pid, admin, decks: deckOptions, people: PEOPLE, bots: await bots(), games: mine, played: doc.games.length, lobby: lobby.stats()
        };
        if (!swarm.on()) {
            return sendJson(res, 200, { result: { ...out, ready: false, why: 'The game files are off on this window (no SWARM_HELPER_TOKEN).' } }, req);
        }
        const m = await swarm.currentManifest();
        const build = m?.build ?? swarm.cachedBuild(NEEDED);
        if (m) {
            swarm.keep(FILES).catch(() => undefined);
        }
        if (!build) {
            if (now() - woke > WAKE_MS) {
                woke = now();
                wake();
            }
            return sendJson(res, 200, { result: { ...out, ready: false, why: 'The game files come from the games machine, which is starting. This takes about a minute.' } }, req);
        }
        const q = `?b=${encodeURIComponent(build)}`;
        const models = Object.entries(MODELS).map(([name, p]) => ({ url: `/tables/${name}${q}`, path: p, bytes: swarm.fileSize?.(build, name) ?? null }));
        const files = { pack: `/tables/engine.json${q}`, worker: `/tables/tables-worker.js${q}`, botWorker: `/tables/bot-worker.js${q}`, pythonLib: `/tables/python-lib.json${q}`, pythonWasm: `/tables/python.wasm${q}`, models };
        return sendJson(res, 200, { result: { ...out, ready: true, build, files } }, req);
    }

    async function importDeck(req, res, login, { sendJson, readBody }) {
        const fail = (status, code, message) => sendJson(res, status, { error: { code, message } }, req);
        const q = parseOr((await readBody(req, 1 << 20)).toString('utf8'), null);
        const text = typeof q?.text === 'string' ? q.text.trim() : '';
        if (!text) {
            return fail(400, 'bad_request', 'send {"text": "<a SWUDB link, or a deck list as JSON>"}');
        }
        try {
            const id = text.startsWith('{') ? null : swudbId(text);
            if (!id && !text.startsWith('{')) {
                return fail(400, 'bad_request', 'paste a SWUDB deck link (swudb.com/deck/...), or a deck list as JSON (SWUDB: Export, then JSON)');
            }
            if (id) {
                const hit = deckCache.get(id);
                if (hit && now() - hit.at < 5 * 60000) {
                    return sendJson(res, 200, { result: { deck: hit.deck, source: 'swudb' } }, req);
                }
                if (limited('deck', login, DECKS_PER_HOUR)) {
                    return fail(429, 'too_many', `at most ${DECKS_PER_HOUR} SWUDB decks an hour`);
                }
                const deck = await fetchSwudb(id, { fetchImpl });
                deckCache.set(id, { at: now(), deck });
                if (deckCache.size > 200) {
                    deckCache.delete(deckCache.keys().next().value);
                }
                return sendJson(res, 200, { result: { deck, source: 'swudb' } }, req);
            }
            return sendJson(res, 200, { result: { deck: deckFromJson(text), source: 'json' } }, req);
        } catch (e) {
            return fail(400, 'bad_request', String(e?.message ?? e).slice(0, 300));
        }
    }

    async function keepGame(req, res, login, { sendJson, readBody }) {
        const fail = (status, code, message) => sendJson(res, status, { error: { code, message } }, req);
        const t = now();
        const times = (sentGames.get(login) ?? []).filter((x) => typeof x !== 'number' || t - x < 864e5); // objects: uploads under way
        if (times.length >= perDay) {
            return fail(429, 'too_many', `at most ${perDay} games a day; this one was not kept`);
        }
        // this upload's place in the day's count, taken before its body is read and given back unless a new game is kept
        const slot = {};
        sentGames.set(login, [...times, slot]);
        let kept = false;
        try {
            return await keepBody(req, res, login, { sendJson, readBody, fail, t, markKept: () => { kept = true; } });
        } finally {
            const mine = sentGames.get(login) ?? [];
            sentGames.set(login, mine.map((x) => (x === slot ? (kept ? t : null) : x)).filter((x) => x !== null));
        }
    }

    async function keepBody(req, res, login, { sendJson, readBody, fail, t, markKept }) {
        // the replay comes as a JSON string, where each quote and backslash of its lines takes two bytes
        const q = parseOr((await readBody(req, 2 * MAX_REPLAY + 4096)).toString('utf8'), null);
        const replay = typeof q?.replay === 'string' ? q.replay : null;
        if (!replay || Buffer.byteLength(replay) > MAX_REPLAY) {
            return fail(400, 'bad_request', `send {"replay": "<the game as JSON Lines>", "seat": "p1" or "p2"}, at most ${MAX_REPLAY} bytes`);
        }
        let game;
        try {
            game = checkReplay(replay);
        } catch (e) {
            return fail(400, 'bad_request', e.message);
        }
        const pid = pidOf(login);
        const seat = q.seat === 'p1' || q.seat === 'p2' ? q.seat : null;
        const sat = seat && game.header.players[seat === 'p1' ? 0 : 1];
        if (!sat || sat.lang !== 'person' || sat.bot !== pid) {
            return fail(400, 'bad_request', `seat: the seat you played, whose player is your id ${pid}`);
        }
        const sha256 = sha(replay);
        const doc = runDoc();
        let row = doc.games.find((r) => r.sha256 === sha256);
        if (!row) {
            const id = `open-${game.header.seed.toString(16).padStart(8, '0')}-${sha256.slice(0, 8)}`;
            store.putReplay(RUN, id, Buffer.from(replay, 'utf8'));
            // stamped as it joins the list, so the list stays in playedAt order when uploads overlap
            row = rowOf(id, game, { sha256, bytes: Buffer.byteLength(replay), at: new Date(now()).toISOString() });
            const all = [...doc.games, row];
            doc.games = all.slice(-maxRows);
            doc.bots = [...new Set([...doc.bots, ...game.header.players.filter((x) => x.lang !== 'person').map((x) => x.bot)])];
            store.putDoc('runs', RUN, JSON.stringify(doc));
            for (const old of all.slice(0, all.length - doc.games.length)) {
                store.deleteReplay(RUN, old.id); // the oldest games go with their rows
            }
            markKept();
        }
        // who played which seat, for admins only
        const all = people();
        all[row.id] = { ...(all[row.id] ?? {}), [seat]: `@${login}` };
        const keep = Object.keys(all).slice(-maxRows);
        store.putDoc('admin', 'tables-people', JSON.stringify({ games: Object.fromEntries(keep.map((k) => [k, all[k]])), updatedAt: new Date(t).toISOString() }));
        return sendJson(res, 200, { result: { id: row.id } }, req);
    }

    function logsPage(login) {
        const how = `<h2>The API</h2><p>Send your token as <code>Authorization: Bearer &lt;token&gt;</code>.</p><ul>
<li><code>GET /api/open/games?since=&lt;time&gt;&amp;limit=&lt;n&gt;</code>: the games kept, oldest first, and <code>next</code> to go on from</li>
<li><code>GET /api/open/games/&lt;id&gt;.jsonl</code>: one game in the arena's replay format (both decks, the seed and deal key, every move and the board after it, the end)</li>
<li><code>GET /api/open/weeks</code> and <code>GET /api/open/weeks/&lt;week&gt;.tar.gz</code>: a whole week in one file, as a folder Holotable can open</li></ul>
<p>Players appear by a random id (like <code>pl_7f3a9c</code>), never their GitHub name.</p>
<pre>curl -H "Authorization: Bearer $TOKEN" ${esc(auth.publicUrl ?? '')}/api/open/games</pre>`;
        if (!login) {
            return auth.shell(`<h1>Open tables: game logs</h1><p>Every game finished on the open tables is kept for training, and anyone signed in with GitHub can read them with a free reader token.</p><p><a class="btn" href="/auth/github?next=%2Ftables%2Flogs">Sign in with GitHub</a></p>${how}`);
        }
        return auth.shell(`<h1>Open tables: game logs</h1><p>Signed in as <b>@${esc(login)}</b>. A new token replaces your old one.</p>
<p><button class="btn" id="tok" type="button">Make my reader token</button></p><pre id="out" hidden></pre>${how}
<script>document.getElementById('tok').onclick=async()=>{const r=await fetch('/api/tables/token',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const j=await r.json().catch(()=>({}));const o=document.getElementById('out');o.hidden=false;o.textContent=r.ok?j.result.token:('Not made: '+((j.error&&j.error.message)||r.status));};</script>`);
    }

    /** /api/open/*: the kept games for readers with a reader token (or anyone signed in with GitHub on this site). */
    async function openRoute(req, res, url, { sendJson, sendText }) {
        const p = url.pathname;
        if (!p.startsWith('/api/open/') && p !== '/api/open') {
            return false;
        }
        const fail = (status, code, message) => sendJson(res, status, { error: { code, message } }, req);
        const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
        const reader = bearer ? tokenLogin(bearer) : github(auth.who(req));
        if (!reader) {
            fail(401, 'unauthorized', bearer ? 'not a reader token (make a new one at /tables/logs)' : 'send a reader token (Authorization: Bearer swu_r_...); make one at /tables/logs');
            return true;
        }
        if (req.method !== 'GET') {
            fail(405, 'bad_request', 'GET only');
            return true;
        }
        const rows = runDoc().games;
        if (p === '/api/open/games') {
            const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            const { games, next } = pageOf(rows, url.searchParams.get('since'), limit);
            sendJson(res, 200, { result: { games: games.map(({ sha256, ...r }) => ({ ...r, sha256, week: isoWeek(r.playedAt) })), next } }, req);
            return true;
        }
        const g = /^\/api\/open\/games\/([\w-]+)\.jsonl$/.exec(p);
        if (g) {
            const buf = GAME.test(g[1]) ? store.readReplay(RUN, g[1]) : null;
            if (!buf) {
                fail(404, 'not_found', 'no game by that id');
                return true;
            }
            sendText(res, req, 200, 'application/x-ndjson', buf.toString('utf8'));
            return true;
        }
        if (p === '/api/open/weeks') {
            const by = new Map();
            for (const r of rows) {
                const w = isoWeek(r.playedAt);
                if (w) {
                    by.set(w, (by.get(w) ?? 0) + 1);
                }
            }
            sendJson(res, 200, { result: [...by].sort().map(([week, games]) => ({ week, games, file: `/api/open/weeks/${week}.tar.gz` })) }, req);
            return true;
        }
        const w = /^\/api\/open\/weeks\/([\dW-]+)\.tar\.gz$/.exec(p);
        if (w && WEEK.test(w[1])) {
            const games = rows.filter((r) => isoWeek(r.playedAt) === w[1]);
            const dir = `tables-${w[1]}`;
            const mtime = Math.floor(now() / 1000);
            // streamed: one replay in memory at a time, read when the client has taken the ones before
            function* archive() {
                yield* tarEntry(`${dir}/index.json`, Buffer.from(JSON.stringify({ id: dir, kind: 'tables', week: w[1], games })), mtime);
                for (const r of games) {
                    const buf = store.readReplay(RUN, r.id);
                    if (buf) {
                        yield* tarEntry(`${dir}/games/${r.id}.jsonl`, buf, mtime);
                    }
                }
                yield TAR_END;
            }
            res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${dir}.tar.gz"`, 'cache-control': 'no-cache' });
            await pipeline(Readable.from(archive(), { objectMode: false, highWaterMark: 1 << 20 }), zlib.createGzip(), res).catch(() => undefined); // a reader that goes away ends it
            return true;
        }
        fail(404, 'not_found', 'unknown open API path (/api/open/games, /api/open/weeks)');
        return true;
    }

    async function route(req, res, url, who, { sendJson, sendText, readBody }) {
        const p = url.pathname;
        if (p !== '/tables' && !p.startsWith('/tables/') && !p.startsWith('/api/tables/')) {
            return false;
        }
        const fail = (status, code, message) => sendJson(res, status, { error: { code, message } }, req);
        // the logs page and reader tokens: anyone signed in with GitHub, whatever the mode
        if (p === '/tables/logs') {
            return sendPage(req, res, 200, logsPage(github(who)), sendText);
        }
        if (p === '/api/tables/token') {
            const login = github(who);
            if (!login) {
                fail(401, 'unauthorized', 'sign in with GitHub at /auth/github?next=/tables/logs');
            } else if (req.method !== 'POST' || req.headers.origin !== auth.origin) {
                fail(403, 'forbidden', "tokens are made only from this site's own logs page (POST)");
            } else if (limited('token', login, 10)) {
                fail(429, 'too_many', 'at most 10 new tokens an hour');
            } else {
                sendJson(res, 200, { result: { token: newToken(login) } }, req);
            }
            return true;
        }
        if (on === 'off') {
            if (p.startsWith('/api/')) {
                fail(404, 'not_found', 'the open tables are off');
            } else {
                sendPage(req, res, 404, auth.shell('<h1>SWU Arena</h1><p>The open tables are closed for now.</p>'), sendText);
            }
            return true;
        }
        const login = player(who);
        if (!login) {
            if (p.startsWith('/api/')) {
                fail(who.login ? 403 : 401, who.login ? 'forbidden' : 'unauthorized', who.login ? `@${who.login} may not play here yet` : 'sign in with GitHub at /auth/github?next=/tables');
                return true;
            }
            const back = encodeURIComponent(url.pathname + url.search);
            if (github(who)) {
                return sendPage(req, res, 403, auth.shell(`<h1>Open tables</h1><p>You are signed in to GitHub as <b>@${esc(who.login)}</b>. The open tables are open to people Eric invited to the arena, and <b>@${esc(who.login)}</b> is not on the list yet.</p><p>Send Eric your GitHub username, <b>${esc(who.login)}</b>. Once he has added it, reload this page.</p><p><a href="/auth/logout">Sign out</a></p>`), sendText);
            }
            const who2 = on === 'github' ? 'Anyone with a GitHub account can play.' : 'The open tables are open to people Eric invited to the arena.';
            return sendPage(req, res, 200, auth.shell(`<h1>Open tables</h1><p>Play Star Wars Unlimited against other people or any arena bot, on the real rules engine in your browser. Finished games are kept for training under a random player id.</p><p>${who2} Sign in with GitHub: GitHub asks once whether SWU Arena may see your username, and nothing else is shared.</p><p><a class="btn" href="/auth/github?next=${back}">Sign in with GitHub</a></p>`), sendText);
        }
        try {
            if (p === '/tables' || p === '/tables/') {
                if (req.method !== 'GET') {
                    sendText(res, req, 405, 'text/plain', 'GET only');
                    return true;
                }
                return sendPage(req, res, 200, fs.readFileSync(page, 'utf8'), sendText, ISOLATED_PAGE);
            }
            if (p === '/tables/kit.js') {
                return sendKit(req, res, sendText);
            }
            const bot = /^\/tables\/bot\/([0-9a-f]{64})\.tar$/.exec(p);
            if (bot && req.method === 'GET') {
                // a bundle the window does not have yet comes from the machine: wake it (as play.js sendBundle does)
                if (!swarm.botHere?.(bot[1]) && now() - woke > WAKE_MS) {
                    woke = now();
                    wake();
                }
                return await swarm.sendBot(req, res, bot[1], { sendJson });
            }
            const file = /^\/tables\/([a-z0-9.-]+)$/.exec(p);
            if (file && req.method === 'GET') {
                if (!FILES.includes(file[1])) {
                    sendText(res, req, 404, 'text/plain', 'not found');
                    return true;
                }
                return await swarm.sendFile(req, res, url, file[1], { sendJson, sendText });
            }
            if (p === '/api/tables/info' && req.method === 'GET') {
                await info(req, res, who, login, sendJson);
                return true;
            }
            if (req.method === 'POST' && req.headers.origin !== auth.origin) {
                fail(403, 'forbidden', "the open tables take requests only from this site's own page");
                return true;
            }
            const q = (k) => url.searchParams.get(k) ?? '';
            const pid = () => pidOf(login);
            if (p === '/api/tables/deck' && req.method === 'POST') {
                await importDeck(req, res, login, { sendJson, readBody });
                return true;
            }
            if (p === '/api/tables/invite' && req.method === 'POST') {
                if (limited('room', login, ROOMS_PER_HOUR)) {
                    fail(429, 'too_many', `at most ${ROOMS_PER_HOUR} tables an hour`);
                    return true;
                }
                sendJson(res, 200, { result: lobby.invite({ login, pid: pid() }) }, req);
                return true;
            }
            if (p === '/api/tables/join' && req.method === 'POST') {
                const body = parseOr((await readBody(req, 4096)).toString('utf8'), null);
                sendJson(res, 200, { result: lobby.join(body?.code, { login, pid: pid() }) }, req);
                return true;
            }
            if (p === '/api/tables/queue' && req.method === 'POST') {
                if (limited('room', login, ROOMS_PER_HOUR)) {
                    fail(429, 'too_many', `at most ${ROOMS_PER_HOUR} tables an hour`);
                    return true;
                }
                sendJson(res, 200, { result: lobby.queue({ login, pid: pid() }) }, req);
                return true;
            }
            if (p === '/api/tables/stream' && req.method === 'GET') {
                lobby.stream(req, res, { room: q('room'), ticket: q('ticket'), side: q('side'), k: q('k') });
                return true;
            }
            if (p === '/api/tables/send' && req.method === 'POST') {
                const body = parseOr((await readBody(req, MAX_MSG)).toString('utf8'), null);
                if (!body || typeof body !== 'object' || !('msg' in body)) {
                    fail(400, 'bad_request', 'send {"msg": ...}');
                    return true;
                }
                const why = lobby.send(q('room'), q('side'), q('k'), body.msg);
                if (why) {
                    fail(409, 'conflict', why);
                } else {
                    sendJson(res, 200, { result: { ok: true } }, req);
                }
                return true;
            }
            if (p === '/api/tables/leave' && req.method === 'POST') {
                await readBody(req, 4096);
                lobby.leave(q('room'), q('side'), q('k'));
                sendJson(res, 200, { result: { ok: true } }, req);
                return true;
            }
            if (p === '/api/tables/games' && req.method === 'POST') {
                await keepGame(req, res, login, { sendJson, readBody });
                return true;
            }
            if (p === '/api/tables/games' && req.method === 'GET') {
                const me = pid();
                const doc = runDoc();
                const out = { you: me, games: doc.games.filter((r) => r.p1 === me || r.p2 === me).slice(-200).reverse().map((r) => brief(r, me)) };
                if (who.role === 'admin') {
                    const by = people();
                    out.all = doc.games.slice(-300).reverse().map((r) => ({ ...brief(r, null), people: by[r.id] ?? null }));
                }
                sendJson(res, 200, { result: out }, req);
                return true;
            }
            const g = /^\/api\/tables\/games\/([\w-]+)\.jsonl$/.exec(p);
            if (g && req.method === 'GET') {
                const me = pid();
                const row = GAME.test(g[1]) ? runDoc().games.find((r) => r.id === g[1]) : null;
                const buf = row && (who.role === 'admin' || row.p1 === me || row.p2 === me) ? store.readReplay(RUN, row.id) : null;
                if (!buf) {
                    fail(404, 'not_found', 'no game of yours by that id');
                    return true;
                }
                sendText(res, req, 200, 'application/x-ndjson', buf.toString('utf8'));
                return true;
            }
            if (p === '/api/tables/me' && req.method === 'POST') {
                const body = parseOr((await readBody(req, 4096)).toString('utf8'), null);
                if (body?.renew === true && limited('renew', login, 5, 864e5)) {
                    fail(429, 'too_many', 'at most 5 new ids a day');
                    return true;
                }
                sendJson(res, 200, { result: { you: pidOf(login, body?.renew === true) } }, req);
                return true;
            }
        } catch (e) {
            if (e instanceof LobbyError) {
                fail(e.status, e.code, e.message);
                return true;
            }
            throw e;
        }
        fail(404, 'not_found', 'unknown tables path');
        return true;
    }

    return { route, openRoute, openTo, mode: on, lobby, close: () => lobby.close() };
}

module.exports = { createTables, checkReplay, rowOf, isoWeek, pageOf, tarEntry, RUN };
