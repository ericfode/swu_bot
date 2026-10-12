'use strict';
/**
 * Arena API over HTTP (see api.js for the methods).
 *
 *   node bot/arena/server.js [--port 7070] [--host 127.0.0.1]
 *   curl -s localhost:7070/api/status
 *   curl -s -X POST localhost:7070/api/say -d '{"name":"optimizer","text":"generation 3: best 1540"}'
 *
 * GET /api/<method>?k=v or POST /api/<method> with a JSON body. Replies {result} or {error:{code,message}}.
 * GET /api lists the methods. GET /arena is the arena's web UI (standings, competitors, games in the viewer kit, join,
 * submit). GET / is the SWU Arena app (app/README.md) when its friends build exists (ARENA_APP, default
 * app/dist/public.html from `npm run app -- --public`), else the arena's web UI too.
 * Hosted: ARENA_AUTH=1 makes competitor tokens required (see api.js); ARENA_TOKEN additionally gates all of /api.
 * ARENA_MODE=window serves the arena window instead (window.js): the read-only arena and research for invited friends,
 * fed through its API by the arena and the project's other parts, behind GitHub sign-in (auth.js).
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { call, METHODS } = require('./api');
const { RESULTS } = require('./home');

const KIT = process.env.ARENA_KIT ?? '/mnt/project-files/viewer-kit/swu-viewer-kit.js';
const WEB = path.join(__dirname, 'web', 'index.html');
// read per request, so a rebuilt app shows without a restart (ARENA_APP= with no value keeps the arena UI at /)
const appFile = () => process.env.ARENA_APP ?? path.join(__dirname, '..', '..', 'app', 'dist', 'public.html');

/** Whether an Accept-Encoding header allows gzip: a gzip (or else *) entry whose q value is above 0. */
function acceptsGzip(header) {
    let gzip = null;
    let star = null;
    for (const part of String(header ?? '').toLowerCase().split(',')) {
        const [token, ...params] = part.split(';').map((x) => x.trim());
        const q = params.find((x) => x.startsWith('q='));
        const ok = !q || Number(q.slice(2)) > 0;
        if (token === 'gzip' || token === 'x-gzip') {
            gzip = ok;
        } else if (token === '*') {
            star = ok;
        }
    }
    return gzip ?? star ?? false;
}

/**
 * Static files: the app, the web UI, the shared viewer kit, and arena round replays/indexes. Gzipped when the client
 * accepts it: the app build is ~10 MB and a replay ~1 MB, and both shrink a lot.
 */
function serveFile(req, res, file, type) {
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found');
            return;
        }
        const gzip = acceptsGzip(req.headers['accept-encoding']);
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', vary: 'accept-encoding', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
        const body = fs.createReadStream(file);
        body.on('error', () => res.destroy());
        (gzip ? body.pipe(zlib.createGzip()) : body).pipe(res);
    });
}

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const STATUS = { bad_request: 400, unauthorized: 401, not_found: 404, conflict: 409, too_large: 413, bad_bot: 422, internal: 500, unsupported: 501 };
const MAX_BODY = 1e6;
// query-string values arrive as text; these arguments are integers
const INTS = ['round', 'version', 'seeds', 'timeoutSec'];

function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, headers = {}) => {
        if (res.headersSent) {
            return;
        }
        res.writeHead(code, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
    };
    if (process.env.ARENA_TOKEN && url.pathname.startsWith('/api') && req.headers.authorization !== `Bearer ${process.env.ARENA_TOKEN}`) {
        return send(401, { error: { code: 'unauthorized', message: 'missing or wrong bearer token' } });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const app = appFile();
        return serveFile(req, res, app && fs.existsSync(app) ? app : WEB, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && (url.pathname === '/arena' || url.pathname === '/arena.html')) {
        return serveFile(req, res, WEB, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/strategy-diagram.js') {
        return serveFile(req, res, path.join(__dirname, 'web', 'strategy-diagram.js'), 'text/javascript');
    }
    if (req.method === 'GET' && url.pathname === '/kit.js') {
        return serveFile(req, res, KIT, 'text/javascript');
    }
    // a round's replays (<ladder id>/games/<id>.jsonl, index.json; the ladder id is arena-r<K> or <tournament id>-r<K>)
    // and a queued eval's (arena-evals/<eval id>/<game>.jsonl)
    const rep = /^\/replays\/(arena-(?:[\w-]+-)?r\d+)\/((?:games\/[\w.#@-]+\.jsonl)|index\.json)$/.exec(url.pathname)
        ?? /^\/replays\/(arena-evals\/[\w-]+)\/([\w.#@-]+\.jsonl)$/.exec(url.pathname);
    if (req.method === 'GET' && rep) {
        return serveFile(req, res, path.join(RESULTS, rep[1], rep[2]), rep[2].endsWith('.json') ? 'application/json' : 'application/x-ndjson');
    }
    if (url.pathname === '/api' || url.pathname === '/api/') {
        return send(200, { result: METHODS });
    }
    const m = /^\/api\/([a-z_]+)$/.exec(url.pathname);
    if (!m) {
        return send(404, { error: { code: 'not_found', message: 'use /api/<method>' } });
    }
    // collect raw chunks and decode once: decoding chunk by chunk would split multi-byte UTF-8 characters
    const chunks = [];
    let size = 0;
    req.on('error', () => {}); // client went away
    req.on('data', (d) => {
        size += d.length;
        if (size > MAX_BODY) {
            if (!res.headersSent) {
                send(413, { error: { code: 'too_large', message: `request body over ${MAX_BODY} bytes` } }, { connection: 'close' });
                res.on('finish', () => req.destroy());
            }
            return;
        }
        chunks.push(d);
    });
    req.on('end', async () => {
        if (size > MAX_BODY) {
            return;
        }
        const body = Buffer.concat(chunks).toString('utf8');
        let args = Object.fromEntries(url.searchParams);
        if (body.trim()) {
            let parsed;
            try {
                parsed = JSON.parse(body);
            } catch {
                return send(400, { error: { code: 'bad_request', message: 'body is not JSON' } });
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return send(400, { error: { code: 'bad_request', message: 'body must be a JSON object of arguments' } });
            }
            args = { ...args, ...parsed };
        }
        for (const k of INTS) {
            if (typeof args[k] === 'string' && /^\d+$/.test(args[k])) {
                args[k] = Number(args[k]);
            }
        }
        const out = await call(m[1], args);
        send(out.error ? STATUS[out.error.code] ?? 400 : 200, out);
    });
}

if (require.main === module) {
    const port = Number(arg('port', process.env.PORT ?? 7070));
    const host = arg('host', '127.0.0.1');
    if (process.env.ARENA_MODE === 'window') {
        const { createWindow } = require('./window');
        const w = createWindow();
        http.createServer((req, res) => w.handle(req, res)).listen(port, host, () => console.log(`arena window on http://${host}:${port}/ (data in ${w.store.dir})`));
        // the games machine stops when idle: woken on every submission, and every 6 hours for its daily replays
        setInterval(() => w.wakeGames(), 6 * 3600000).unref();
    } else {
        http.createServer(handler).listen(port, host, () => console.log(`arena API on http://${host}:${port}/api`));
    }
}

module.exports = { handler, acceptsGzip };
