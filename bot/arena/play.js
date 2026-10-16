'use strict';
/**
 * The window's /play page: a person against a bot on Holotable's play screen, Eric's JEPA bot (jepa-tx-gate) or a bot of
 * the arena's latest round (Eric, 2026-10-16: "you should be able to chose what bot you want so it doesnt have to
 * download as much"). The referee and the bot run in a worker of the person's tab (bot/swarm/build.js play-worker.js,
 * on the swarm's engine pack, served by the swarm relay), so neither the window nor the games machine plays the game.
 * When it ends, the tab sends the replay here, and the window keeps it in the run "play" (Eric, 2026-10-15: "post game
 * histories back to my system"). Games are unrated: the person's own tab played them and could have changed them.
 *
 *   const play = createPlay({ store, swarm, auth, kitFile, wake });
 *   if (await play.route(req, res, url, who, { sendJson, sendText, readBody })) return;
 *   play.openTo(next)   // whether GitHub sign-in may return a login with no role to `next` (auth.js openTo)
 *
 * ARENA_PLAY says who may play: 'invited' (the default: people signed in with GitHub and invited to the arena),
 * 'github' (anyone signed in with GitHub), or 'off'. A view link's guest has no GitHub login, so it may not play.
 *
 *   GET  /play                        the page (play.html), the sign-in page, or why not; cross-origin isolated
 *                                     (require-corp, which Safari has too; card art comes through the window, art.js):
 *                                     a bundle's stdin is a SharedArrayBuffer
 *   GET  /play/kit.js                 the viewer kit, for people who may play but not read the arena
 *   GET  /play/<file>?b=<build>       a swarm file of that build (swarm-relay.js): engine.json, play-worker.js,
 *                                     bot-worker.js, the JEPA bot's models, python-lib.json and python.wasm; each
 *                                     answer says its unzipped size in x-raw-length
 *   GET  /play/bundle/<sha256>        an arena version's canonical tar, for a version of the latest round only (the
 *                                     swarm relay's lineup and sendBot: kept on the window's disk, so it loads while the
 *                                     games machine sleeps)
 *   GET  /api/play/info               {on, login, admin, ready, build, files, why?, waking?, decks, games}: the engine's
 *                                     files to load ({url, bytes} each), the deck lists ({name, leader, base, style}) and
 *                                     the person's last games (an admin also gets every game, with who played it). Not
 *                                     ready: why, and waking when the games machine is starting (the page asks again)
 *   GET  /api/play/bots               {ready, round, capMs, bots, runtimes}: the bots a person may pick, the JEPA bot first,
 *                                     then the latest round's versions by rating, each with what it downloads (see
 *                                     below); runtimes: the interpreters a bundle may need, {lib, wasm} each
 *   POST /api/play/games {replay}     keeps a finished game: {id}; the same replay again gives the same id
 *   GET  /api/play/games/<id>.jsonl   a game's replay, for the person who played it and admins
 *
 * The run document is a people run (window.js peopleRun: it has `feed`), so readers see the person as "opponent" and
 * the app leaves it out; who played each game is kept in admin/people as "@<login>", as for the Karabast feed's names.
 *
 * A bot of /api/play/bots is {name, title, kind, about, elo, bytes, ...}: kind 'jepa' runs in the play worker and
 * brings files, [{url, path, bytes, wire}] (the page fetches each and sends [[path, bytes]] with its first game); kind
 * 'arena' is a WebAssembly version that brings bundle, {url, hex, bytes, wire}, runtime ('wasi-p1', or an interpreter of
 * runtimes the page also fetches) and capMs, its time per game; it needs a cross-origin isolated page. bytes: what the
 * bot itself is, unzipped, its runtime not counted; wire: about what it downloads (gzipped), null when the window does
 * not know yet. Every name, title and number is data from the arena: set them with textContent.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { atLeast, LOGIN } = require('./auth');
const { normalizeDeck } = require('../decklists');

const RUN = 'play';
const BOT = 'jepa-tx-gate';
const PERSON = 'person'; // the person's seat name in the replay (bot/table/host.js)
// the files every game loads, the JEPA bot's models (bot/swarm/pack.js MODELS: where the worker puts each), and a
// Python bundle's interpreter
const FILES = ['engine.json', 'play-worker.js', 'bot-worker.js'];
const MODELS = { 'tx-t10.safetensors': '/app/vendor/jepa/tx-t10.safetensors', 'tx-t10-e.safetensors': '/app/vendor/jepa/tx-t10-e.safetensors' };
const PYTHON = { runtime: 'python-3.14-wasi', lib: 'python-lib.json', wasm: 'python.wasm' };
const READY = [...FILES, ...Object.keys(MODELS)];
// the deck lists people pick from: the same file the engine pack carries (bot/swarm/pack.js), so names match the worker's
const DECKS = path.join(__dirname, '..', 'decks', 'ash-meta-2026-09.json');
const KEPT = [...READY, PYTHON.lib, PYTHON.wasm];
// an arena version: a competitor's name as api.js allows it (at most 32 characters) and its version number
const VERSION = /^[a-z][a-z0-9_]{0,31}-v\d{1,6}$/;
const HEX = /^[0-9a-f]{64}$/;
const TITLE = "Eric's JEPA bot";
const ABOUT = 'A learned model of the game that looks ahead on simulations, as it plays in the arena. Its two models download once.';
// the page's isolation, as the swarm's pages have it: require-corp, since Safari has no credentialless. It blocks the
// CDN's card art (no CORP header there), so the page shows the art through the window (art.js)
const PAGE_ISOLATED = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };
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

/** The bytes of file `name` at the top of a canonical bundle tar (bot/compiled/bundle.py: ustar, plain files), or null. */
function tarFile(tar, name) {
    for (let off = 0; off + 512 <= tar.length;) {
        const h = tar.subarray(off, off + 512);
        if (h.every((x) => x === 0)) {
            break;
        }
        const field = (o, n) => h.subarray(o, o + n).toString('latin1').split('\0')[0];
        const size = parseInt(field(124, 12).trim() || '0', 8);
        if (!Number.isSafeInteger(size) || size < 0) {
            return null;
        }
        const prefix = field(345, 155);
        const rel = (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100)).replace(/^\.\//, '');
        if (rel === name && String.fromCharCode(h[156] || 48) === '0') {
            return tar.subarray(off + 512, off + 512 + size);
        }
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return null;
}

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
    const bot = p[1]?.bot;
    if (header.t !== 'header' || header.v !== 1 || p.length !== 2 || p[0]?.id !== 'p1' || p[0]?.bot !== PERSON || p[1]?.id !== 'p2' || !(bot === BOT || VERSION.test(String(bot)))) {
        throw new Error(`replay header: you in seat 1 (${PERSON}) and ${BOT} or an arena version in seat 2`);
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
    return { header, end, steps: lines.length - 2, bot };
}

/** The run row of a checked game (window.js feedRun's fields, plus the decks and when it was played). */
function rowOf(id, { header, end, bot = BOT }, { sha256, bytes, at }) {
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
    const seatName = (s) => (s === 'p1' ? 'opponent' : bot);
    return {
        id, p1: 'opponent', p2: bot, outcome, winnerSeat, winner: outcome === 'draw' ? 'draw' : winnerSeat ? seatName(winnerSeat) : null,
        // an error's text could hold anything the tab wrote, so the row keeps only that there was one
        rounds: end.round, steps: end.steps, error: (end.outcome === 'ERROR' && !conceded) || outcome === 'abandoned' ? 'no result' : null,
        conceded, decks: { p1: header.decks.p1.metadata.name, p2: header.decks.p2.metadata.name }, playedAt: at, bytes, sha256
    };
}

function createPlay({ store, swarm, auth, kitFile, wake = () => undefined, mode = process.env.ARENA_PLAY || 'invited', page = path.join(__dirname, 'web', 'play.html'), decksFile = DECKS, now = Date.now } = {}) {
    const on = MODES.has(mode) ? mode : 'invited';
    // the versus screen shows the lists before the engine is in the tab: {name, leader, base, style} each
    let decks = [];
    try {
        const raw = parseOr(fs.readFileSync(decksFile, 'utf8'), []);
        decks = (Array.isArray(raw) ? raw : raw?.decks ?? []).map((d, i) => normalizeDeck(d, i)).map((d) => ({ name: d.metadata.name, leader: d.leader.id, base: d.base.id, style: d.metadata.style ?? null }));
    } catch (e) {
        console.error(`play: no deck lists (${e.message})`);
    }
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
    const brief = (r) => ({ id: r.id, bot: r.p2 ?? BOT, outcome: r.outcome, winner: r.winnerSeat === 'p1' ? 'you' : r.winnerSeat === 'p2' ? r.p2 ?? BOT : r.outcome === 'draw' ? 'draw' : null, conceded: !!r.conceded, rounds: r.rounds, steps: r.steps, decks: r.decks, playedAt: r.playedAt });

    function sendPage(req, res, code, html, sendText) {
        sendText(res, req, code, 'text/html; charset=utf-8', html, PAGE_ISOLATED);
        return true;
    }

    /** The build whose files a page loads now: the machine's, else the one on the window's disk; null when neither. */
    async function buildNow() {
        const m = await swarm.currentManifest();
        if (m) {
            // kept on the window's disk, so the page loads while the games machine sleeps
            swarm.keep(KEPT).catch(() => undefined);
        }
        return { build: m?.build ?? swarm.cachedBuild(READY), m };
    }
    // bytes: as the page reads it (unzipped); wire: about what it downloads (gzipped), null when not known
    const fileOf = (build, name) => ({ url: `/play/${name}?b=${encodeURIComponent(build)}`, bytes: swarm.fileSize(build, name), wire: swarm.fileSize(build, name, { gz: true }) });
    const wireOf = (hex) => {
        const f = swarm.botHere(hex);
        return f ? (typeof f.gz === 'string' ? fs.statSync(f.gz).size : f.gz.length) : null;
    };
    // bundle sha256 -> the runtime its arena.json names, read once the window has the bundle (null until then)
    const runtimes = new Map();
    const runtimeOf = (hex) => {
        if (!runtimes.has(hex)) {
            const f = swarm.botHere(hex);
            if (!f) {
                return null;
            }
            const m = tarFile(typeof f.raw === 'string' ? fs.readFileSync(f.raw) : f.raw, 'arena.json');
            const r = parseOr(m?.toString('utf8'), null)?.runtime;
            runtimes.set(hex, typeof r === 'string' ? r : null);
        }
        return runtimes.get(hex);
    };

    // ---- the bots: the JEPA bot, then the latest round's versions (swarm-relay.js lineup) by rating
    async function bots(req, res, sendJson) {
        const { build } = await buildNow();
        const l = swarm.on() ? await swarm.lineup().catch(() => null) : null;
        const arena = parseOr(store.getDoc('arena', 'standings'), null)?.global ?? {};
        // a version's title is its builder's name (nova-v3: nova); the builders' own titles stay on the arena's pages
        const titleOf = (name) => name.replace(/-v\d+$/, '');
        const models = build ? Object.keys(MODELS).map((n) => ({ ...fileOf(build, n), path: MODELS[n] })) : [];
        const total = (fs2, k) => (fs2.every((f) => Number.isSafeInteger(f[k])) ? fs2.reduce((a, f) => a + f[k], 0) : null);
        const out = [{ name: BOT, title: TITLE, kind: 'jepa', about: ABOUT, elo: null, files: models, bytes: total(models, 'bytes'), wire: total(models, 'wire') }];
        // each version thinks for as long as it did in that round (a lineup with no time limit offers none)
        const cap = l?.capMs ?? null;
        const rows = (cap ? l.bots : []).filter((b) => Number.isSafeInteger(b.bytes)).map((b) => ({
            name: b.name, title: titleOf(b.name), kind: 'arena', about: null, elo: Number.isFinite(arena[b.name]) ? Math.round(arena[b.name]) : null,
            runtime: runtimeOf(b.bundle), capMs: cap, bundle: { url: `/play/bundle/${b.bundle}`, hex: b.bundle, bytes: b.bytes, wire: wireOf(b.bundle) }, bytes: b.bytes, wire: wireOf(b.bundle)
        }));
        rows.sort((a, b) => (b.elo ?? -Infinity) - (a.elo ?? -Infinity) || a.name.localeCompare(b.name));
        // an interpreter is offered when this build has it (its sizes known: the machine's manifest or the window's disk)
        const python = build ? { lib: fileOf(build, PYTHON.lib), wasm: fileOf(build, PYTHON.wasm) } : null;
        const runtimesNow = python && python.lib.bytes && python.wasm.bytes ? { [PYTHON.runtime]: python } : {};
        return sendJson(res, 200, { result: { ready: !!build, round: l?.round ?? null, capMs: cap, bots: [...out, ...rows], runtimes: runtimesNow } }, req);
    }

    /** A bundle of the lineup (swarm-relay.js sendBot); the machine is woken when the window does not have it yet. */
    async function sendBundle(req, res, hex, sendJson) {
        if (!swarm.botHere(hex) && now() - woke > WAKE_MS) {
            woke = now();
            wake();
        }
        return swarm.sendBot(req, res, hex, { sendJson });
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
        const out = { on: true, mode: on, login, admin, decks, games: mine };
        if (admin) {
            out.all = all.slice(-200).reverse().map((r) => ({ ...brief(r), person: by[r.id] ?? null }));
            out.played = all.length;
        }
        if (!swarm.on()) {
            return sendJson(res, 200, { result: { ...out, ready: false, why: 'The game files are off on this window (no SWARM_HELPER_TOKEN).' } }, req);
        }
        const { build } = await buildNow();
        if (!build) {
            if (now() - woke > WAKE_MS) {
                woke = now();
                wake();
            }
            return sendJson(res, 200, { result: { ...out, ready: false, waking: true, why: 'The game files come from the games machine, which is starting. This takes about a minute.' } }, req);
        }
        return sendJson(res, 200, { result: { ...out, ready: true, build, files: { pack: fileOf(build, 'engine.json'), worker: fileOf(build, 'play-worker.js'), botWorker: fileOf(build, 'bot-worker.js') } } }, req);
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
        // the bots of the games kept, so the list stays as short as the rows
        doc.bots = [...new Set(doc.games.map((r) => r.p2 ?? BOT))];
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
                return sendPage(req, res, 403, auth.shell(`<h1>Play against a bot</h1><p>You are signed in to GitHub as <b>@${esc(who.login)}</b>. The play page is open to people Eric invited to the arena, and <b>@${esc(who.login)}</b> is not on the list yet.</p><p>Send Eric your GitHub username, <b>${esc(who.login)}</b>. Once he has added it, reload this page.</p><p><a href="/auth/logout">Sign out</a></p>`), sendText);
            }
            const who2 = on === 'github' ? 'Anyone with a GitHub account can play.' : 'The play page is open to people Eric invited to the arena.';
            return sendPage(req, res, 200, auth.shell(`<h1>Play against a bot</h1><p>Play Star Wars Unlimited against Eric's JEPA bot or a bot from the arena. The game runs in your browser, and it is saved to the arena when it ends.</p><p>${who2} Sign in with GitHub so your games are kept as yours: GitHub asks once whether SWU Arena may see your username, and nothing else is shared.</p><p><a class="btn" href="/auth/github?next=%2Fplay">Sign in with GitHub</a></p>`), sendText);
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
        const tar = /^\/play\/bundle\/([0-9a-f]{64})$/.exec(p);
        if (tar && req.method === 'GET') {
            return sendBundle(req, res, tar[1], sendJson);
        }
        const file = /^\/play\/([a-z0-9.-]+)$/.exec(p);
        if (file && req.method === 'GET') {
            if (!KEPT.includes(file[1])) {
                sendText(res, req, 404, 'text/plain', 'not found');
                return true;
            }
            return swarm.sendFile(req, res, url, file[1], { sendJson, sendText });
        }
        if (p === '/api/play/bots' && req.method === 'GET') {
            await bots(req, res, sendJson);
            return true;
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
