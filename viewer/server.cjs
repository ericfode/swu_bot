'use strict';
// Dependency-free local server: serves the built viewer, /api/tournaments and the replays/ folder.
//   node viewer/server.cjs      (PORT=5180, REPLAYS_DIR=<repo>/replays by default)
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = Number(process.env.PORT ?? 5180);
const REPLAYS = path.resolve(process.env.REPLAYS_DIR ?? path.join(__dirname, '..', 'replays'));
const DIST = path.join(__dirname, 'dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(req, res, status, body, type) {
    const accepts = String(req.headers['accept-encoding'] ?? '');
    const compressible = /json|text|javascript|ndjson|svg/.test(type) && body.length > 1024;
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
    if (compressible && accepts.includes('gzip')) {
        headers['Content-Encoding'] = 'gzip';
        body = zlib.gzipSync(body);
    }
    res.writeHead(status, headers);
    res.end(body);
}

function safeJoin(root, rel) {
    const full = path.resolve(root, '.' + path.sep + decodeURIComponent(rel));
    return full === root || full.startsWith(root + path.sep) ? full : null;
}

function listTournaments() {
    if (!fs.existsSync(REPLAYS)) {
        return [];
    }
    const out = [];
    for (const d of fs.readdirSync(REPLAYS, { withFileTypes: true })) {
        const f = path.join(REPLAYS, d.name, 'index.json');
        if (!d.isDirectory() || !fs.existsSync(f)) {
            continue;
        }
        try {
            const idx = JSON.parse(fs.readFileSync(f, 'utf8'));
            out.push({ id: d.name, createdAt: idx.createdAt, engine: idx.engine, bots: idx.bots, games: idx.games.length });
        } catch {
            // half-written index: skip until the next poll
        }
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
        if (p === '/api/tournaments') {
            return send(req, res, 200, Buffer.from(JSON.stringify(listTournaments())), TYPES['.json']);
        }
        const isReplay = p.startsWith('/replays/');
        const file = isReplay ? safeJoin(REPLAYS, p.slice('/replays/'.length)) : safeJoin(DIST, p === '/' ? 'index.html' : p.slice(1));
        if (!file) {
            return send(req, res, 400, Buffer.from('bad path'), 'text/plain');
        }
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
            return send(req, res, 200, fs.readFileSync(file), TYPES[path.extname(file)] ?? 'application/octet-stream');
        }
        if (!isReplay && fs.existsSync(path.join(DIST, 'index.html'))) {
            return send(req, res, 200, fs.readFileSync(path.join(DIST, 'index.html')), TYPES['.html']);
        }
        send(req, res, 404, Buffer.from(isReplay ? 'not found' : 'viewer not built: run npm run build in viewer/'), 'text/plain');
    } catch (e) {
        send(req, res, 500, Buffer.from(String(e && e.message)), 'text/plain');
    }
}).listen(PORT, () => console.log(`SWU bot viewer on http://localhost:${PORT}  (replays: ${REPLAYS})`));
