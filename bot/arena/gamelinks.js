'use strict';
/**
 * Every game's own link (Eric, 2026-10-16: "every game to have a deep link. you should be able to just copy paste it,
 * if it's in progress you should be able to spectate if its over it's a replay there is no privacy"): /g/<run>/<game>
 * opens that game in Holotable's viewer for anyone, with no sign-in, and nothing else of the arena. A game still being
 * played follows live; a finished one is a replay. ?step=<n> opens at decision n, and the address follows the reader,
 * so copying it gives the decision on screen. The app's game page links here (Share), and a signed-out visitor who
 * opens an app link to a game (/#/games/<run>/<game>) is sent here by the sign-in page (auth.js).
 *
 * A game against people (window.js peopleRun: Karabast, /play, /tables) reads as every arena reader gets it, the person
 * as "a person", and opens only once it has ended: watched live, it would show a person the other side's hidden cards.
 * Bot games are watched live with both hands, as in the app: a bot in its sandbox cannot read this page.
 *
 *   const games = createGameLinks({ store, publicUrl, kitFile, replayFor, peopleRun });
 *   if (await games.route(req, res, url, { sendJson, sendText })) return;
 *
 *   GET  /g/<run>/<game>                  the page (web/game.html), with its title and preview from the replay
 *   GET  /g/<run>/<game>/game.jsonl       the replay as a reader gets it; ?from=<byte> gives what came after (x-size: the
 *                                         whole size), so a live page fetches only new lines; x-gen changes when the
 *                                         replay is replaced whole, and the page then starts over
 *   GET  /g/kit.js                        the viewer kit (ETag, so a browser keeps it)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ID = /^[A-Za-z0-9][\w.#@+-]{0,159}$/; // the window's run and game ids (window.js ID)
const READER = { role: 'friend', via: 'link' }; // how the page reads a replay: as an arena reader (people masked)

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const parseOr = (s, d) => {
    try {
        return s == null ? d : JSON.parse(s);
    } catch {
        return d;
    }
};
const ended = (buf) => !!buf && /"t":"end"/.test(buf.subarray(Math.max(0, buf.length - 4000)).toString('utf8'));

/** The two seats and the result from a replay's header and end lines, for the page's title and preview. */
function gameFacts(buf) {
    const text = buf ? buf.toString('utf8') : '';
    const nl = text.indexOf('\n');
    const head = parseOr(nl < 0 ? text : text.slice(0, nl), null);
    const end = parseOr(text.slice(-4000).split('\n').filter(Boolean).pop() ?? '', null);
    const seat = (id) => {
        const p = Array.isArray(head?.players) ? head.players.find((x) => x?.id === id) : null;
        const n = typeof p?.name === 'string' && p.name ? p.name : typeof p?.bot === 'string' && p.bot ? p.bot : id;
        return n.slice(0, 60);
    };
    const done = end?.t === 'end';
    const winner = done && (end.winner === 'p1' || end.winner === 'p2') ? seat(end.winner) : null;
    return { p1: seat('p1'), p2: seat('p2'), winner, draw: done && end.winner === 'draw', round: done && Number.isInteger(end.round) ? end.round : null, done };
}

function createGameLinks({ store, publicUrl, kitFile, replayFor, peopleRun = () => false, page = path.join(__dirname, 'web', 'game.html') } = {}) {
    const base = String(publicUrl ?? '').replace(/\/+$/, '');
    let kit = null; // {mtimeMs, raw, gz, etag, etagGz}
    // the last few games read here (at most 16 and 48 MB), oldest first: run/game -> {sig, gen, size, buf}
    const hot = new Map();
    let hotBytes = 0;
    const drop = (k) => {
        hotBytes -= hot.get(k)?.size ?? 0;
        hot.delete(k);
    };

    const linkOf = (run, game) => `${base}/g/${encodeURIComponent(run)}/${encodeURIComponent(game)}`;
    /**
     * The replay as a reader gets it and its generation, or {buf: null}. Every spectator of a live game polls, so the
     * last few replays read are kept by their file's stat (plus, for a game against people, its run document's, which
     * says how its people read): they share one read per new move, and a poll with nothing new reads nothing. An append
     * grows the file and keeps its generation; a whole replacement (Store.putReplay, a resync) renames a new file in,
     * so the inode, and with it the generation, changes even at the same size, and a live page starts over.
     */
    function replay(run, game, people) {
        const k = `${run}/${game}`;
        const hit = hot.get(k);
        drop(k);
        let st;
        try {
            st = fs.statSync(store.replayFile(run, game));
        } catch {
            return { buf: null, gen: null };
        }
        const sig = `${st.ino}/${st.size}/${st.mtimeMs}${people ? `/${store.changedAt(run)}` : ''}`;
        const gen = hit?.sig === sig ? hit.gen : crypto.createHash('sha256').update(`${k}/${st.ino}/${st.birthtimeMs}`).digest('hex').slice(0, 16);
        const buf = hit?.sig === sig ? hit.buf : replayFor(READER, run, game);
        if (buf) {
            hot.set(k, { sig, gen, size: buf.length, buf });
            hotBytes += buf.length;
            while (hot.size > 16 || hotBytes > 48e6) {
                drop(hot.keys().next().value);
            }
        }
        return { buf, gen };
    }
    /** Whether the run's document lists the game (a game that has not sent its first moves yet). */
    const listed = (run, game) => {
        const d = parseOr(store.getDoc('runs', run), null);
        return Array.isArray(d?.games) && d.games.some((g) => g?.id === game);
    };

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
            const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
            kit = { mtimeMs: st.mtimeMs, raw, gz: zlib.gzipSync(raw), etag: `"${hash}"`, etagGz: `"${hash}-gz"` };
        }
        // q values, as the window's own answers (required on use: server.js requires the window); each encoding has its
        // own ETag, so a browser never revalidates one with the other
        const gzip = require('./server').acceptsGzip(req.headers['accept-encoding']);
        const etag = gzip ? kit.etagGz : kit.etag;
        const head = { 'cache-control': 'no-cache', etag, vary: 'accept-encoding' };
        if (String(req.headers['if-none-match'] ?? '').split(/\s*,\s*/).map((t) => t.replace(/^W\//, '')).includes(etag)) {
            res.writeHead(304, head);
            res.end();
            return;
        }
        res.writeHead(200, { 'content-type': 'text/javascript', ...head, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
        res.end(gzip ? kit.gz : kit.raw);
    }

    function sendMessage(req, res, code, text, sendText) {
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SWU Arena</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#060a13;color:#e6ecf8;font:16px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}main{max-width:420px}h1{font-size:22px;margin:0 0 8px}p{color:#8494b8}</style></head>
<body><main><h1>SWU Arena</h1><p>${esc(text)}</p></main></body></html>`;
        sendText(res, req, code, 'text/html; charset=utf-8', html);
    }

    function sendPage(req, res, run, game, buf, people, sendText) {
        const f = buf ? gameFacts(buf) : { p1: 'p1', p2: 'p2', done: false };
        const title = buf ? `${f.p1} vs ${f.p2}` : 'A game about to start';
        const result = !buf ? 'Waiting for its first moves.' : f.winner ? `${f.winner} won${f.round ? ` in round ${f.round}` : ''}.` : f.draw ? 'A draw.' : f.done ? 'No winner.' : people ? 'Still being played; the replay opens when it ends.' : 'Playing now: watch it live.';
        const desc = `${result} A game from the SWU Arena, where bots play Star Wars Unlimited on the real rules engine.`;
        const meta = [
            `<title>${esc(title)} · SWU Arena</title>`,
            `<meta name="description" content="${esc(desc)}">`,
            `<meta property="og:type" content="website">`,
            `<meta property="og:site_name" content="SWU Arena">`,
            `<meta property="og:title" content="${esc(title)}">`,
            `<meta property="og:description" content="${esc(desc)}">`,
            `<meta property="og:url" content="${esc(linkOf(run, game))}">`
        ].join('\n');
        const data = JSON.stringify({ run, game, title, people }).replace(/</g, '\\u003c');
        const html = fs.readFileSync(page, 'utf8').replace('<!--META-->', meta).replace('"__GAME__"', data);
        sendText(res, req, 200, 'text/html; charset=utf-8', html);
    }

    async function route(req, res, url, { sendText }) {
        const p = url.pathname;
        if (p !== '/g' && !p.startsWith('/g/')) {
            return false;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendText(res, req, 405, 'text/plain', 'GET only');
            return true;
        }
        if (p === '/g/kit.js') {
            sendKit(req, res);
            return true;
        }
        const m = /^\/g\/([^/]+)\/([^/]+)(\/game\.jsonl)?\/?$/.exec(p);
        let run = null;
        let game = null;
        try {
            [run, game] = m ? [decodeURIComponent(m[1]), decodeURIComponent(m[2])] : [];
        } catch {}
        if (!ID.test(run ?? '') || !ID.test(game ?? '')) {
            sendMessage(req, res, 404, 'There is no game at this address. Check the link, or ask whoever sent it.', sendText);
            return true;
        }
        const people = peopleRun(run);
        const { buf, gen } = replay(run, game, people);
        if (m[3]) {
            if (!buf) {
                sendText(res, req, 404, 'text/plain', listed(run, game) ? 'no moves yet' : 'not found');
                return true;
            }
            if (people && !ended(buf)) {
                sendText(res, req, 409, 'text/plain', 'a game against a person opens when it ends');
                return true;
            }
            const from = Math.min(buf.length, Math.max(0, Number(url.searchParams.get('from')) || 0));
            sendText(res, req, 200, 'application/x-ndjson', buf.subarray(from), { 'x-size': String(buf.length), 'x-gen': gen });
            return true;
        }
        if (!buf && !listed(run, game)) {
            sendMessage(req, res, 404, 'There is no game at this address. Check the link, or ask whoever sent it.', sendText);
            return true;
        }
        sendPage(req, res, run, game, buf, people, sendText);
        return true;
    }

    return { route, linkOf };
}

module.exports = { createGameLinks, gameFacts };
