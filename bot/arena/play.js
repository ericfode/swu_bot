'use strict';
/**
 * The window's /play page: a person against Eric's JEPA bot (jepa-tx-gate) on Holotable's play screen. The referee and
 * the bot run in a worker of the person's tab (bot/swarm/build.js play-worker.js, on the swarm's engine pack, served by
 * the swarm relay), so neither the window nor the games machine plays the game. When it ends, the tab sends the replay
 * here, and the window keeps it in the run "play" (Eric, 2026-10-15: "post game histories back to my system").
 * Games are unrated: the person's own tab played them and could have changed them.
 *
 *   const play = createPlay({ store, swarm, auth, kitFile, wake });
 *   if (await play.route(req, res, url, who, { sendJson, sendText, readBody })) return;
 *   play.openTo(next)   // whether GitHub sign-in may return a login with no role to `next` (auth.js openTo)
 *
 * ARENA_PLAY says who may play: 'invited' (the default: people signed in with GitHub and invited to the arena),
 * 'github' (anyone signed in with GitHub), or 'off'. A view link's guest has no GitHub login, so it may not play.
 *
 *   GET  /play                        the page (play.html), the sign-in page, or why not
 *   GET  /play/kit.js                 the viewer kit, for people who may play but not read the arena
 *   GET  /play/engine.json?b=<build>  the swarm's engine pack and the play worker of that build (swarm-relay.js)
 *   GET  /play/play-worker.js?b=<build>
 *   GET  /api/play/info               {on, login, admin, ready, build, files, why?, games}: the files to load and the
 *                                     person's last games (an admin also gets every game, with who played it)
 *   POST /api/play/games {replay}     keeps a finished game: {id}; the same replay again gives the same id
 *   GET  /api/play/games/<id>.jsonl   a game's replay, for the person who played it and admins
 *
 * The run document is a people run (window.js peopleRun: it has `feed`), so readers see the person as "opponent" and
 * the app leaves it out; who played each game is kept in admin/people as "@<login>", as for the Karabast feed's names.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { atLeast, LOGIN } = require('./auth');

const RUN = 'play';
const BOT = 'jepa-tx-gate';
const PERSON = 'person'; // the person's seat name in the replay (bot/table/host.js)
const FILES = ['engine.json', 'play-worker.js'];
const MODES = new Set(['off', 'invited', 'github']);
const MAX_REPLAY = 16e6; // a whole game; the longest arena game so far is ~14 MB
const MAX_LINES = 40000;
const MAX_ROWS = 5000; // rows kept in the run document; replays stay
const PER_DAY = 40; // games a person may send a day
const WAKE_MS = 15 * 60000;
const NAME = /^[A-Za-z0-9][\w .@#+()-]{0,79}$/;
const GAME = /^play-[0-9a-f]{8}-[0-9a-f]{8}$/;

const parseOr = (text, dflt) => {
    try {
        return text == null ? dflt : JSON.parse(text);
    } catch {
        return dflt;
    }
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A finished game's replay as the play worker writes it (spec/replay-format.md): a header with the person in seat 1
 * and the JEPA bot in seat 2, step lines, and an end line. Returns {header, end, steps} or throws a reason.
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
        // step lines carry the board; each must parse (the viewer reads every line), only its kind is checked
        if (!lines[i].startsWith('{"t":"step"') || parse(lines[i], i).t !== 'step') {
            throw new Error(`replay line ${i + 1}: a step`);
        }
    }
    const p = Array.isArray(header.players) ? header.players : [];
    const deckName = (seat) => header.decks?.[seat]?.metadata?.name;
    if (header.t !== 'header' || header.v !== 1 || p.length !== 2 || p[0]?.id !== 'p1' || p[0]?.bot !== PERSON || p[1]?.id !== 'p2' || p[1]?.bot !== BOT) {
        throw new Error(`replay header: you in seat 1 (${PERSON}) and ${BOT} in seat 2`);
    }
    if (!Number.isInteger(header.seed) || header.seed < 0 || header.seed >= 2 ** 32) {
        throw new Error('replay header: the game seed');
    }
    if (!['p1', 'p2'].every((s) => typeof deckName(s) === 'string' && NAME.test(deckName(s)))) {
        throw new Error('replay header: both deck lists, by name');
    }
    const n = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : null);
    if (end.t !== 'end' || typeof end.outcome !== 'string' || n(end.steps) === null || n(end.round) === null) {
        throw new Error('replay: the last line is the end of the game');
    }
    return { header, end, steps: lines.length - 2 };
}

/** The run row of a checked game (window.js feedRun's fields, plus the decks and when it was played). */
function rowOf(id, { header, end }, { sha256, bytes, at }) {
    let outcome = 'abandoned';
    let winnerSeat = null;
    let conceded = false;
    if (end.outcome === 'won' && (end.winner === 'p1' || end.winner === 'p2')) {
        outcome = 'won';
        winnerSeat = end.winner;
    } else if (end.outcome === 'ERROR' && (end.by === 'p1' || end.by === 'p2')) {
        // a seat that breaks the game loses it; the person's concession ends it that way too (bot/table/person.js)
        outcome = 'won';
        winnerSeat = end.by === 'p1' ? 'p2' : 'p1';
        conceded = end.by === 'p1' && /conceded/.test(String(end.error ?? ''));
    } else if (end.winner === 'draw') {
        outcome = 'draw';
    }
    const seatName = (s) => (s === 'p1' ? 'opponent' : BOT);
    return {
        id, p1: 'opponent', p2: BOT, outcome, winnerSeat, winner: outcome === 'draw' ? 'draw' : winnerSeat ? seatName(winnerSeat) : null,
        // an error's text could hold anything the tab wrote, so the row keeps only that there was one
        rounds: end.round, steps: end.steps, error: (end.outcome === 'ERROR' && !conceded) || outcome === 'abandoned' ? 'no result' : null,
        conceded, decks: { p1: header.decks.p1.metadata.name, p2: header.decks.p2.metadata.name }, playedAt: at, bytes, sha256
    };
}

function createPlay({ store, swarm, auth, kitFile, wake = () => undefined, mode = process.env.ARENA_PLAY || 'invited', page = path.join(__dirname, 'web', 'play.html'), now = Date.now } = {}) {
    const on = MODES.has(mode) ? mode : 'invited';
    const sent = new Map(); // login -> times of the games they sent, the last day
    let woke = 0;
    let kit = null; // {mtimeMs, raw, gz}

    /** The GitHub login of a person signed in on this site who may play, or null. */
    const player = (who) => {
        const login = who.via === 'cookie' && !who.guest && typeof who.login === 'string' && LOGIN.test(who.login) ? who.login.toLowerCase() : null;
        return login && (on === 'github' || atLeast(who.role, 'friend')) ? login : null;
    };
    const openTo = (next) => on === 'github' && typeof next === 'string' && /^\/play(?:[?#]|$)/.test(next);

    const runDoc = () => {
        const d = parseOr(store.getDoc('runs', RUN), null);
        return d && typeof d === 'object' && Array.isArray(d.games) ? d : { id: RUN, feed: RUN, kind: 'play', createdAt: new Date(now()).toISOString(), bots: [BOT], games: [] };
    };
    const names = () => {
        const d = parseOr(store.getDoc('admin', 'people'), null)?.names;
        return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    };
    const brief = (r) => ({ id: r.id, outcome: r.outcome, winner: r.winnerSeat === 'p1' ? 'you' : r.winnerSeat === 'p2' ? BOT : r.outcome === 'draw' ? 'draw' : null, conceded: !!r.conceded, rounds: r.rounds, steps: r.steps, decks: r.decks, playedAt: r.playedAt });

    function sendPage(req, res, code, html, sendText) {
        sendText(res, req, code, 'text/html; charset=utf-8', html);
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
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache', vary: 'accept-encoding', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
        res.end(gzip ? kit.gz : kit.raw);
        return true;
    }

    async function info(req, res, who, login, sendJson) {
        const all = runDoc().games;
        const by = names();
        const mine = all.filter((r) => by[r.id] === `@${login}`).slice(-20).reverse().map(brief);
        const admin = who.role === 'admin';
        const out = { on: true, mode: on, login, admin, games: mine };
        if (admin) {
            out.all = all.slice(-200).reverse().map((r) => ({ ...brief(r), person: by[r.id] ?? null }));
            out.played = all.length;
        }
        if (!swarm.on()) {
            return sendJson(res, 200, { result: { ...out, ready: false, why: 'The game files are off on this window (no SWARM_HELPER_TOKEN).' } }, req);
        }
        const m = await swarm.currentManifest();
        const build = m?.build ?? swarm.cachedBuild(FILES);
        if (m) {
            // kept on the window's disk, so the page loads while the games machine sleeps
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
        return sendJson(res, 200, { result: { ...out, ready: true, build, files: { pack: `/play/engine.json${q}`, worker: `/play/play-worker.js${q}` } } }, req);
    }

    async function keepGame(req, res, login, { sendJson, readBody }) {
        const fail = (status, code, message) => sendJson(res, status, { error: { code, message } }, req);
        if (req.headers.origin !== auth.origin) {
            return fail(403, 'forbidden', "games are sent only from this site's own play page");
        }
        if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
            return fail(400, 'bad_request', 'send JSON: {"replay": "<the game as JSON Lines>"}');
        }
        const t = now();
        const times = (sent.get(login) ?? []).filter((x) => t - x < 864e5);
        if (times.length >= PER_DAY) {
            return fail(429, 'too_many', `at most ${PER_DAY} games a day; this one was not kept`);
        }
        const body = await readBody(req, MAX_REPLAY + 4096);
        const q = parseOr(body.toString('utf8'), null);
        const replay = typeof q?.replay === 'string' ? q.replay : null;
        if (!replay || Buffer.byteLength(replay) > MAX_REPLAY) {
            return fail(400, 'bad_request', `send {"replay": "<the game as JSON Lines>"}, at most ${MAX_REPLAY} bytes`);
        }
        let game;
        try {
            game = checkReplay(replay);
        } catch (e) {
            return fail(400, 'bad_request', e.message);
        }
        const sha256 = crypto.createHash('sha256').update(replay).digest('hex');
        const doc = runDoc();
        const again = doc.games.find((r) => r.sha256 === sha256);
        if (again) {
            return sendJson(res, 200, { result: { id: again.id, again: true } }, req);
        }
        const id = `play-${game.header.seed.toString(16).padStart(8, '0')}-${sha256.slice(0, 8)}`;
        store.putReplay(RUN, id, Buffer.from(replay, 'utf8'));
        doc.games = [...doc.games, rowOf(id, game, { sha256, bytes: Buffer.byteLength(replay), at: new Date(t).toISOString() })].slice(-MAX_ROWS);
        store.putDoc('runs', RUN, JSON.stringify(doc));
        // who played it, for admins only (window.js keepPeopleNames keeps the Karabast feed's names the same way)
        const all = names();
        all[id] = `@${login}`;
        const ids = Object.keys(all).slice(-20000);
        store.putDoc('admin', 'people', JSON.stringify({ names: Object.fromEntries(ids.map((k) => [k, all[k]])), updatedAt: new Date(t).toISOString() }));
        sent.set(login, [...times, t]);
        return sendJson(res, 200, { result: { id } }, req);
    }

    async function route(req, res, url, who, { sendJson, sendText, readBody }) {
        const p = url.pathname;
        if (p !== '/play' && !p.startsWith('/play/') && !p.startsWith('/api/play/')) {
            return false;
        }
        const fail = (status, code, message) => sendJson(res, status, { error: { code, message } }, req);
        if (on === 'off') {
            if (p.startsWith('/api/')) {
                fail(404, 'not_found', 'the play page is off');
            } else {
                sendPage(req, res, 404, auth.shell('<h1>SWU Arena</h1><p>The play page is closed for now.</p>'), sendText);
            }
            return true;
        }
        const login = player(who);
        if (!login) {
            if (p.startsWith('/api/')) {
                fail(who.login ? 403 : 401, who.login ? 'forbidden' : 'unauthorized', who.login ? `@${who.login} may not play here yet` : 'sign in with GitHub at /auth/github?next=/play');
                return true;
            }
            if (who.via === 'cookie' && who.login && !who.guest) {
                return sendPage(req, res, 403, auth.shell(`<h1>Play against Eric's bot</h1><p>You are signed in to GitHub as <b>@${esc(who.login)}</b>. The play page is open to people Eric invited to the arena, and <b>@${esc(who.login)}</b> is not on the list yet.</p><p>Send Eric your GitHub username, <b>${esc(who.login)}</b>. Once he has added it, reload this page.</p><p><a href="/auth/logout">Sign out</a></p>`), sendText);
            }
            const who2 = on === 'github' ? 'Anyone with a GitHub account can play.' : 'The play page is open to people Eric invited to the arena.';
            return sendPage(req, res, 200, auth.shell(`<h1>Play against Eric's bot</h1><p>Play Star Wars Unlimited against Eric's JEPA bot. The game runs in your browser, and it is saved to the arena when it ends.</p><p>${who2} Sign in with GitHub so your games are kept as yours: GitHub asks once whether SWU Arena may see your username, and nothing else is shared.</p><p><a class="btn" href="/auth/github?next=%2Fplay">Sign in with GitHub</a></p>`), sendText);
        }
        if (p === '/play' || p === '/play/') {
            if (req.method !== 'GET') {
                sendText(res, req, 405, 'text/plain', 'GET only');
                return true;
            }
            return sendPage(req, res, 200, fs.readFileSync(page, 'utf8'), sendText);
        }
        if (p === '/play/kit.js') {
            return sendKit(req, res, sendText);
        }
        const file = /^\/play\/([a-z0-9.-]+)$/.exec(p);
        if (file && req.method === 'GET') {
            if (!FILES.includes(file[1])) {
                sendText(res, req, 404, 'text/plain', 'not found');
                return true;
            }
            return swarm.sendFile(req, res, url, file[1], { sendJson, sendText });
        }
        if (p === '/api/play/info' && req.method === 'GET') {
            await info(req, res, who, login, sendJson);
            return true;
        }
        if (p === '/api/play/games' && req.method === 'POST') {
            await keepGame(req, res, login, { sendJson, readBody });
            return true;
        }
        const g = /^\/api\/play\/games\/([\w-]+)\.jsonl$/.exec(p);
        if (g && req.method === 'GET') {
            const mine = GAME.test(g[1]) && (who.role === 'admin' || names()[g[1]] === `@${login}`);
            const buf = mine ? store.readReplay(RUN, g[1]) : null;
            if (!buf) {
                fail(404, 'not_found', 'no game of yours by that id');
                return true;
            }
            sendText(res, req, 200, 'application/x-ndjson', buf.toString('utf8'));
            return true;
        }
        fail(404, 'not_found', 'unknown play path');
        return true;
    }

    return { route, openTo, mode: on };
}

module.exports = { createPlay, checkReplay, rowOf, RUN, BOT };
