import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { atlasKit } from './vite.atlas.ts';

const DEFAULT_CARD_TEXT = '/mnt/project-files/viewer-kit/card-text.json';
import { effectSourceManifest } from './scripts/effect-source-manifest.mjs';

/** Capture provenance from the served build, even while the next batch is being authored. */
function effectReviewManifest(): Plugin {
    let source: ReturnType<typeof effectSourceManifest>;
    return {
        name: 'swu-effect-review-manifest', apply: 'build',
        buildStart() { source = effectSourceManifest(); },
        generateBundle() {
            if (effectSourceManifest().sourceFingerprint !== source.sourceFingerprint) {
                this.error('Effect sources changed during the build; rerun after writers finish.');
            }
            this.emitFile({ type: 'asset', fileName: 'effect-source-manifest.json', source: JSON.stringify(source) });
        }
    };
}

/**
 * Serves the replay routes of spec/replay-format.md (GET /api/tournaments and /replays/*), straight from a replays
 * folder, so `npm run dev` and `npm run preview` need no second server. REPLAYS_DIR overrides <repo>/replays. Also
 * /evals/<gameId>.json, /lens/<gameId>.json, /lens/<dir>/<gameId>.json (one subfolder per score, plus evaluators.json
 * and each folder's index.json) and /card-text.json (CARD_TEXT, default DEFAULT_CARD_TEXT when it exists).
 */
function replays(): Plugin {
    const root = path.resolve(process.env.REPLAYS_DIR ?? path.join(__dirname, '..', 'replays'));
    // position evaluations, one <gameId>.json per game (the research dashboard's evals contract)
    const evalsDir = path.resolve(process.env.EVALS_DIR ?? path.join(__dirname, '..', 'evals'));
    // the omni bot's card values, one <gameId>.json per game (swu-lens/1, see bot/omni/lens.js)
    const lensDir = path.resolve(process.env.LENS_DIR ?? path.join(__dirname, '..', 'lens'));
    // printed card data (swu-card-text/1), served as /card-text.json for text faces and aspect colours on cards without
    // art; CARD_TEXT overrides the path, CARD_TEXT= (empty) turns it off
    const cardText = process.env.CARD_TEXT ?? DEFAULT_CARD_TEXT;
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
        if (p === '/card-text.json') {
            return cardText && fs.existsSync(cardText) ? send(req, res, 200, fs.readFileSync(cardText), 'application/json') : send(req, res, 404, Buffer.from('no card text'), 'text/plain');
        }
        // lens files may sit in one subfolder (another score's dir: [a-z0-9._@-], never '.' or '..'); evals may not.
        // Matched on the path as sent, before URL() resolves '..' (/lens/../x.json is refused, not served as /x.json)
        const sent = (req.url ?? '/').split('?')[0];
        const ev = sent.match(/^\/(evals|lens)\/(?:([^/]+)\/)?([^/]+\.json)$/);
        const route = [sent, p].map((x) => x.match(/^\/(evals|lens)\//)?.[1]).find(Boolean);
        if (route) {
            const what = ev?.[1] ?? route;
            const dir = what === 'lens' ? lensDir : evalsDir;
            let f: string | null = null;
            try {
                const sub = ev?.[2] == null ? '' : decodeURIComponent(ev[2]);
                if (ev && (!sub || (what === 'lens' && /^[a-z0-9._@-]+$/.test(sub) && sub !== '.' && sub !== '..'))) {
                    f = path.join(dir, sub, decodeURIComponent(ev[3]));
                }
            } catch {
                // a bad %-escape
            }
            return f && f.startsWith(dir + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? send(req, res, 200, fs.readFileSync(f), 'application/json') : send(req, res, 404, Buffer.from(`no ${what}`), 'text/plain');
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
    plugins: [react(), tailwindcss(), atlasKit(), effectReviewManifest(), mode === 'static' ? viteSingleFile() : replays()],
    base: './',
    server: { port: 5190 },
    preview: { port: 5190 },
    build: { outDir: mode === 'static' ? 'dist-static' : 'dist', chunkSizeWarningLimit: 4000 }
}));
