'use strict';
/**
 * Game links (Eric, 2026-10-16: "I need a way to share a replay of a specific game"): a link that opens one game's replay,
 * and nothing else of the arena, for anyone holding it, with no sign-in. The app's Share panel on a game makes one; the
 * reader's step rides along as ?step=<n>.
 *
 * ARENA_GAME_LINKS says who may make one: 'off' (the default: no one, and every link made earlier stops opening until it
 * is on again), 'admin', or 'invited' (anyone invited to the arena and signed in with GitHub; not a view link's guest,
 * who has no login). A link is one game's: whoever shares that game again gets the same link, and only an admin removes
 * it (the Share page). A game against people (window.js peopleRun: Karabast, /play, /tables) is shared only by an admin,
 * and its people show as "a person", as for every reader of the arena.
 *
 *   const links = createGameLinks({ store, origin, publicUrl, kitFile, replayFor, peopleRun, mode });
 *   if (await links.route(req, res, url, who, { sendJson, sendText, readBody })) return;
 *   links.may(who)   // whether this reader may make a link (for /api/me)
 *   links.list()     // every link, for an admin's Share page
 *
 *   GET  /g/<key>              the replay page (web/game.html): Holotable's viewer, at ?step=<n> when given
 *   GET  /g/<key>/game.jsonl   that game's replay, as a reader sees it
 *   GET  /g/kit.js             the viewer kit, for the replay page
 *   GET  /api/gamelinks        {mode, may, links}: links only for an admin
 *   POST /api/gamelinks        {run, game} makes (or finds) that game's link: {id, run, game, url}; {remove: <id>} removes
 *                              one (an admin). From a browser only from this site's own pages (Origin) and as JSON, as on
 *                              the Share page.
 *
 * The page is the game alone: its header names the two bots (from the replay a reader gets) for link previews; the
 * person who made the link is kept in the link, for the Share page, and never shown on the page.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { atLeast } = require('./auth');

const MODES = new Set(['off', 'admin', 'invited']);
const ID = /^[A-Za-z0-9][\w.#@+-]{0,159}$/; // the window's run and game ids (window.js ID)
const KEY = /^[A-Za-z0-9_-]{32}$/;
const MAX_LINKS = 2000;
const DOC = 'gamelinks'; // admin/gamelinks: {links: [{id, key, run, game, by, createdAt}]}
const READER = { role: 'friend', via: 'link' }; // how the page reads its replay: as an arena reader (people masked)

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const parseOr = (s, d) => {
    try {
        return s == null ? d : JSON.parse(s);
    } catch {
        return d;
    }
};

class LinkError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
const need = (ok, status, code, message) => {
    if (!ok) {
        throw new LinkError(status, code, message);
    }
};

/** The two seats and the result from a replay's header and end lines, for the page's title and preview; null fields when absent. */
function gameFacts(buf) {
    const text = buf ? buf.toString('utf8') : '';
    const first = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
    const tail = text.slice(-4000).split('\n').filter(Boolean).pop() ?? '';
    const head = parseOr(first, null);
    const end = parseOr(tail, null);
    const seat = (id) => {
        const p = Array.isArray(head?.players) ? head.players.find((x) => x?.id === id) : null;
        const n = typeof p?.name === 'string' && p.name ? p.name : typeof p?.bot === 'string' && p.bot ? p.bot : id;
        return n.slice(0, 60);
    };
    const done = end?.t === 'end';
    const winner = done && (end.winner === 'p1' || end.winner === 'p2') ? seat(end.winner) : null;
    return { p1: seat('p1'), p2: seat('p2'), winner, draw: done && end.winner === 'draw', round: done && Number.isInteger(end.round) ? end.round : null, steps: done && Number.isInteger(end.steps) ? end.steps : null, done };
}

function createGameLinks({ store, origin, publicUrl, kitFile, replayFor, peopleRun = () => false, mode = process.env.ARENA_GAME_LINKS || 'off', page = path.join(__dirname, 'web', 'game.html'), now = Date.now } = {}) {
    const on = MODES.has(mode) ? mode : 'off';
    const base = String(publicUrl ?? origin ?? '').replace(/\/+$/, '');
    let kit = null; // {mtimeMs, raw, gz}

    const links = () => {
        const d = parseOr(store.getDoc('admin', DOC), null);
        return Array.isArray(d?.links) ? d.links.filter((l) => l && typeof l.id === 'string' && KEY.test(l.key ?? '') && ID.test(l.run ?? '') && ID.test(l.game ?? '')) : [];
    };
    const save = (next) => store.putDoc('admin', DOC, JSON.stringify({ links: next, updatedAt: new Date(now()).toISOString() }));
    const urlOf = (l) => `${base}/g/${l.key}`;
    const shown = (l) => ({ id: l.id, run: l.run, game: l.game, url: urlOf(l), by: l.by ?? null, createdAt: l.createdAt ?? null });

    /** Whether this reader may make a link now. */
    function may(who) {
        if (on === 'off') {
            return false;
        }
        if (who.role === 'admin') {
            return true;
        }
        return on === 'invited' && who.via === 'cookie' && !who.guest && typeof who.login === 'string' && atLeast(who.role, 'friend');
    }

    const list = () => (on === 'off' ? [] : links().map(shown));

    function sendKit(req, res) {
        let st;
        try {
            st = fs.statSync(kitFile);
        } catch {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found');
            return;
        }
        if (!kit || kit.mtimeMs !== st.mtimeMs) {
            const raw = fs.readFileSync(kitFile);
            kit = { mtimeMs: st.mtimeMs, raw, gz: zlib.gzipSync(raw) };
        }
        const gzip = require('./server').acceptsGzip(req.headers['accept-encoding']); // q values, as the window's own answers (required on use: server.js requires the window)
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache', vary: 'accept-encoding', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
        res.end(gzip ? kit.gz : kit.raw);
    }

    /** The replay page for one link: the title and preview come from the replay as a reader sees it. */
    function sendPage(req, res, link, sendText) {
        const f = gameFacts(replayFor(READER, link.run, link.game));
        const title = `${f.p1} vs ${f.p2}`;
        const result = f.winner ? `${f.winner} won${f.round ? ` in round ${f.round}` : ''}.` : f.draw ? 'A draw.' : f.done ? 'No winner.' : 'Still playing.';
        const desc = `${result} A replay from the SWU Arena, where bots play Star Wars Unlimited on the real rules engine.`;
        const meta = [
            `<title>${esc(title)} · SWU Arena replay</title>`,
            `<meta name="description" content="${esc(desc)}">`,
            `<meta property="og:type" content="website">`,
            `<meta property="og:site_name" content="SWU Arena">`,
            `<meta property="og:title" content="${esc(title)}">`,
            `<meta property="og:description" content="${esc(desc)}">`,
            `<meta property="og:url" content="${esc(urlOf(link))}">`,
            `<meta name="robots" content="noindex">`
        ].join('\n');
        const data = JSON.stringify({ key: link.key, title }).replace(/</g, '\\u003c');
        const html = fs.readFileSync(page, 'utf8').replace('<!--META-->', meta).replace('"__GAME__"', data);
        sendText(res, req, 200, 'text/html; charset=utf-8', html, { 'referrer-policy': 'no-referrer' });
    }

    function sendMessage(req, res, code, text, sendText) {
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SWU Arena</title><meta name="robots" content="noindex">
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#060a13;color:#e6ecf8;font:16px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}main{max-width:420px}h1{font-size:22px;margin:0 0 8px}p{color:#8494b8}</style></head>
<body><main><h1>SWU Arena</h1><p>${esc(text)}</p></main></body></html>`;
        sendText(res, req, code, 'text/html; charset=utf-8', html);
    }

    async function api(req, res, who, { sendJson, readBody }) {
        need(atLeast(who.role, 'friend'), who.login ? 403 : 401, who.login ? 'forbidden' : 'unauthorized', who.login ? `@${who.login} is not invited yet` : 'sign in at /auth/github');
        if (req.method === 'GET') {
            return sendJson(res, 200, { result: { mode: on, may: may(who), ...(who.role === 'admin' ? { links: list() } : {}) } }, req);
        }
        need(req.method === 'POST', 400, 'bad_request', 'GET, or POST {"run", "game"} or {"remove": "<id>"}');
        if (who.via === 'cookie') {
            need(req.headers.origin === origin, 403, 'forbidden', "game links are made only from this site's own pages");
            need(/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? ''), 400, 'bad_request', 'send JSON');
        }
        let q;
        try {
            q = JSON.parse((await readBody(req, 4096)).toString('utf8'));
        } catch (e) {
            if (e?.code === 'too_large') {
                throw new LinkError(413, 'too_large', e.message);
            }
            throw new LinkError(400, 'bad_request', 'body is not JSON');
        }
        if (typeof q?.remove === 'string') {
            need(who.role === 'admin', 403, 'forbidden', 'only an admin removes a game link');
            need(/^[0-9a-f]{12}$/.test(q.remove), 400, 'bad_request', 'remove: the id of a game link');
            save(links().filter((l) => l.id !== q.remove));
            return sendJson(res, 200, { result: { links: list() } }, req);
        }
        need(on !== 'off', 403, 'forbidden', 'game links are turned off on this arena (ARENA_GAME_LINKS)');
        need(may(who), 403, 'forbidden', on === 'admin' ? 'only an admin makes game links' : "a view link's guest cannot make game links; sign in with GitHub");
        const run = q?.run;
        const game = q?.game;
        need(typeof run === 'string' && ID.test(run) && typeof game === 'string' && ID.test(game), 400, 'bad_request', 'send {"run": "<run id>", "game": "<game id>"}');
        need(store.hasReplay(run, game), 404, 'not_found', `no replay ${run}/${game}`);
        need(who.role === 'admin' || !peopleRun(run), 403, 'forbidden', 'a game against people is shared only by an admin');
        const cur = links();
        let link = cur.find((l) => l.run === run && l.game === game);
        if (!link) {
            need(cur.length < MAX_LINKS, 413, 'too_large', `at most ${MAX_LINKS} game links; an admin removes old ones on the Share page`);
            link = { id: crypto.randomBytes(6).toString('hex'), key: crypto.randomBytes(24).toString('base64url'), run, game, by: who.login ?? 'admin token', createdAt: new Date(now()).toISOString() };
            save([...cur, link]);
        }
        return sendJson(res, 200, { result: { id: link.id, run, game, url: urlOf(link) } }, req);
    }

    async function route(req, res, url, who, { sendJson, sendText, readBody }) {
        const p = url.pathname;
        try {
            if (p === '/api/gamelinks') {
                await api(req, res, who, { sendJson, readBody });
                return true;
            }
            if (p !== '/g' && !p.startsWith('/g/')) {
                return false;
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                sendText(res, req, 405, 'text/plain', 'GET only');
                return true;
            }
            if (on === 'off') {
                sendMessage(req, res, 404, 'Game links are turned off on this arena right now. Ask whoever sent you this link.', sendText);
                return true;
            }
            if (p === '/g/kit.js') {
                sendKit(req, res);
                return true;
            }
            const m = /^\/g\/([A-Za-z0-9_-]{32})(\/game\.jsonl)?\/?$/.exec(p);
            const link = m ? links().find((l) => crypto.timingSafeEqual(Buffer.from(l.key), Buffer.from(m[1]))) : null;
            if (!link) {
                sendMessage(req, res, 404, 'That game link was removed, or it never existed. Ask whoever sent it for a new one.', sendText);
                return true;
            }
            if (m[2]) {
                const buf = replayFor(READER, link.run, link.game);
                if (!buf) {
                    sendText(res, req, 404, 'text/plain', 'not found');
                    return true;
                }
                sendText(res, req, 200, 'application/x-ndjson', buf);
                return true;
            }
            sendPage(req, res, link, sendText);
            return true;
        } catch (e) {
            if (!(e instanceof LinkError)) {
                throw e;
            }
            sendJson(res, e.status, { error: { code: e.code, message: e.message } }, req);
            return true;
        }
    }

    return { route, may, list, mode: on };
}

module.exports = { createGameLinks, gameFacts, MODES };
