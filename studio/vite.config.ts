import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Serves the same two routes as viewer/server.cjs (GET /api/tournaments and /replays/*), straight from a replays
 * folder, so `npm run dev` and `npm run preview` need no second server. REPLAYS_DIR overrides <repo>/replays.
 */
function replays(): Plugin {
    const root = path.resolve(process.env.REPLAYS_DIR ?? path.join(__dirname, '..', 'replays'));
    // position evaluations, one <gameId>.json per game (the research dashboard's evals contract)
    const evalsDir = path.resolve(process.env.EVALS_DIR ?? path.join(__dirname, '..', 'evals'));
    // the omni bot's card values, one <gameId>.json per game (swu-lens/1, see bot/omni/lens.js)
    const lensDir = path.resolve(process.env.LENS_DIR ?? path.join(__dirname, '..', 'lens'));
    const send = (req: IncomingMessage, res: ServerResponse, status: number, body: Buffer, type: string) => {
        const gz = /json|ndjson/.test(type) && body.length > 1024 && String(req.headers['accept-encoding'] ?? '').includes('gzip');
        res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
        res.end(gz ? zlib.gzipSync(body) : body);
    };
    const list = () => {
        if (!fs.existsSync(root)) {
            return [];
        }
        const out = [];
        for (const d of fs.readdirSync(root, { withFileTypes: true })) {
            const f = path.join(root, d.name, 'index.json');
            if (!d.isDirectory() || !fs.existsSync(f)) {
                continue;
            }
            try {
                const idx = JSON.parse(fs.readFileSync(f, 'utf8'));
                out.push({ id: d.name, createdAt: idx.createdAt, engine: idx.engine, bots: idx.bots, games: idx.games.length });
            } catch {
                // half-written index: picked up on the next poll
            }
        }
        return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    };
    const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const p = new URL(req.url ?? '/', 'http://x').pathname;
        if (p === '/api/tournaments') {
            return send(req, res, 200, Buffer.from(JSON.stringify(list())), 'application/json');
        }
        const ev = p.match(/^\/(evals|lens)\/([^/]+\.json)$/);
        if (ev) {
            const dir = ev[1] === 'lens' ? lensDir : evalsDir;
            const f = path.join(dir, decodeURIComponent(ev[2]));
            return f.startsWith(dir + path.sep) && fs.existsSync(f) ? send(req, res, 200, fs.readFileSync(f), 'application/json') : send(req, res, 404, Buffer.from(`no ${ev[1]}`), 'text/plain');
        }
        if (!p.startsWith('/replays/')) {
            return next();
        }
        const file = path.resolve(root, '.' + path.sep + decodeURIComponent(p.slice('/replays/'.length)));
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            return send(req, res, 404, Buffer.from('not found'), 'text/plain');
        }
        send(req, res, 200, fs.readFileSync(file), file.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json');
    };
    return {
        name: 'swu-replays',
        configureServer: (s) => void s.middlewares.use(handler),
        configurePreviewServer: (s) => void s.middlewares.use(handler)
    };
}

// `--mode static` bakes the fixture tournaments into one self-contained HTML file (for sharing a preview).
export default defineConfig(({ mode }) => ({
    plugins: [react(), tailwindcss(), mode === 'static' ? viteSingleFile() : replays()],
    base: './',
    server: { port: 5190 },
    preview: { port: 5190 },
    build: { outDir: mode === 'static' ? 'dist-static' : 'dist', chunkSizeWarningLimit: 4000 }
}));
