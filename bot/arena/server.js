'use strict';
/**
 * Arena API over HTTP (see api.js for the methods).
 *
 *   node bot/arena/server.js [--port 7070] [--host 127.0.0.1]
 *   curl -s localhost:7070/api/status
 *   curl -s -X POST localhost:7070/api/say -d '{"name":"optimizer","text":"generation 3: best 1540"}'
 *
 * GET /api/<method>?k=v or POST /api/<method> with a JSON body. Replies {result} or {error:{code,message}}.
 * GET /api lists the methods. GET / is the web UI (standings, competitors, games in the viewer kit, join, submit).
 * Hosted: ARENA_AUTH=1 makes competitor tokens required (see api.js); ARENA_TOKEN additionally gates all of /api.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { call, METHODS } = require('./api');
const { RESULTS } = require('./home');

const KIT = process.env.ARENA_KIT ?? '/mnt/project-files/viewer-kit/swu-viewer-kit.js';

/** Static files: the web UI, the shared viewer kit, and arena round replays/indexes. */
function serveFile(res, file, type) {
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found');
            return;
        }
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        fs.createReadStream(file).pipe(res);
    });
}

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const STATUS = { bad_request: 400, unauthorized: 401, not_found: 404, conflict: 409, internal: 500 };

function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    if (process.env.ARENA_TOKEN && url.pathname.startsWith('/api') && req.headers.authorization !== `Bearer ${process.env.ARENA_TOKEN}`) {
        return send(401, { error: { code: 'unauthorized', message: 'missing or wrong bearer token' } });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return serveFile(res, path.join(__dirname, 'web', 'index.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/kit.js') {
        return serveFile(res, KIT, 'text/javascript');
    }
    const rep = /^\/replays\/(arena-r\d+)\/((?:games\/[\w.#@-]+\.jsonl)|index\.json)$/.exec(url.pathname);
    if (req.method === 'GET' && rep) {
        return serveFile(res, path.join(RESULTS, rep[1], rep[2]), rep[2].endsWith('.json') ? 'application/json' : 'application/x-ndjson');
    }
    if (url.pathname === '/api' || url.pathname === '/api/') {
        return send(200, { result: METHODS });
    }
    const m = /^\/api\/([a-z]+)$/.exec(url.pathname);
    if (!m) {
        return send(404, { error: { code: 'not_found', message: 'use /api/<method>' } });
    }
    let body = '';
    req.on('data', (d) => {
        body += d;
        if (body.length > 1e6) {
            req.destroy();
        }
    });
    req.on('end', async () => {
        let args = Object.fromEntries(url.searchParams);
        if (body.trim()) {
            try {
                args = { ...args, ...JSON.parse(body) };
            } catch {
                return send(400, { error: { code: 'bad_request', message: 'body is not JSON' } });
            }
        }
        for (const k of ['round']) {
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
    http.createServer(handler).listen(port, host, () => console.log(`arena API on http://${host}:${port}/api`));
}

module.exports = { handler };
