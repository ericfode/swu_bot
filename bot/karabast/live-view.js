#!/usr/bin/env node
'use strict';
/**
 * Watch recorded Karabast games in the Holotable viewer (the shared viewer kit) while they are played.
 *
 *   node bot/karabast/live-view.js --runs ~/karabast/runs --kit <viewer-kit dir> [--port 8080] [--host 127.0.0.1]
 *        [--key <secret>] [--predict mlp-g5]
 *
 * It reads the frame files that spectate.js (<run>/<hash>.jsonl) and queue.js (<run>/frames/<hash>.jsonl) write,
 * turns each into a replay with the importer (importer/karabast.js convertFrames) every time the file grows, and
 * serves it to the kit. A game still being played has no `end` line, so the kit re-fetches it every second and
 * follows the newest move. Frame files are scrubbed when written (frame.js), so nothing here has names or chat.
 *
 * Routes, under /<key>/ when --key is set (anything else is a 404):
 *   /             the page: a game picker and the viewer; it follows the newest live game unless you pick one
 *   /games        recorded games, newest first, as JSON
 *   /game/<id>    one game as a replay (spec/replay-format.md)
 *   /lens/<id>    with --predict: the evaluator's P(p1 wins) at every step, as a swu-lens/1 file (no hands seen)
 *   /kit/swu-viewer-kit.js, /kit/card-text.json   from --kit
 * <id> is <run>/<hash> or <run>/frames/<hash>. Only GET, only those files: the server never reads anything else.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { readText } = require('../../importer/sources');
const { convertFrames, splitGames } = require('../../importer/karabast');

/** A frame file stays "live" this long after its last write when it has no winner yet (prompt timer + bank). */
const LIVE_MS = 5 * 60000;
const ID = /^([A-Za-z0-9][\w.-]*)\/(?:(frames)\/)?([0-9a-f]{12})$/;
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', jsonl: 'application/x-ndjson' };

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

/** Converts frame files to replays, once per file version. */
class Games {
    constructor(runs, { predict = null, now = () => Date.now() } = {}) {
        this.runs = path.resolve(runs);
        this.now = now;
        this.cache = new Map(); // file -> { version, game }
        this.ev = predict ? require('../eval/evaluators').loadEvaluator(predict) : null;
        this.predictName = predict;
    }

    /** The frame file of a game id, or null when the id is not one of ours. */
    file(id) {
        const m = ID.exec(id);
        return m ? path.join(this.runs, m[1], ...(m[2] ? [m[2]] : []), `${m[3]}.jsonl`) : null;
    }

    /** Every frame file under the runs folder, newest first. */
    list() {
        const out = [];
        const dirs = fs.existsSync(this.runs) ? fs.readdirSync(this.runs, { withFileTypes: true }) : [];
        for (const d of dirs.filter((x) => x.isDirectory() && /^[A-Za-z0-9]/.test(x.name))) {
            for (const sub of [null, 'frames']) {
                const dir = path.join(this.runs, d.name, ...(sub ? [sub] : []));
                if (!fs.existsSync(dir)) {
                    continue;
                }
                for (const f of fs.readdirSync(dir).filter((x) => /^[0-9a-f]{12}\.jsonl$/.test(x))) {
                    const id = [d.name, sub, f.slice(0, -6)].filter(Boolean).join('/');
                    out.push({ id, mtime: fs.statSync(path.join(dir, f)).mtimeMs, kind: sub ? 'bot game' : 'watched' });
                }
            }
        }
        return out.sort((a, b) => b.mtime - a.mtime);
    }

    /** The game as { events, live, version }, or null for an unknown id or a file with no board yet. */
    get(id) {
        const file = this.file(id);
        if (!file || !fs.existsSync(file)) {
            return null;
        }
        const st = fs.statSync(file);
        const version = `${st.size}-${Math.round(st.mtimeMs)}`;
        let hit = this.cache.get(file);
        if (!hit || hit.version !== version) {
            hit = { version, game: this.convert(fs.readFileSync(file, 'utf8')) };
            this.cache.set(file, hit);
        }
        if (!hit.game) {
            return null;
        }
        const end = hit.game.events[hit.game.events.length - 1];
        const live = !end.winner && this.now() - st.mtimeMs < LIVE_MS;
        return { ...hit.game, live, version: `${version}-${live ? 'live' : 'done'}` };
    }

    convert(text) {
        // the recorder may be halfway through writing a line
        const cap = readText(text.slice(0, text.lastIndexOf('\n') + 1));
        const games = splitGames(cap.frames.filter((f) => Object.keys(f.state?.players ?? f.players ?? {}).length >= 2));
        if (!games.length) {
            return null;
        }
        try {
            const { events } = convertFrames(games[games.length - 1], { seats: cap.meta.capture?.seats, source: { kind: cap.meta.reader } });
            return { events };
        } catch {
            return null; // too few frames for a board
        }
    }

    /** One line per game for the picker. */
    summary(entry) {
        const g = this.get(entry.id);
        if (!g) {
            return { id: entry.id, kind: entry.kind, live: this.now() - entry.mtime < LIVE_MS, steps: 0, mtime: entry.mtime };
        }
        const h = g.events[0];
        const end = g.events[g.events.length - 1];
        return {
            id: entry.id, kind: entry.kind, live: g.live, mtime: entry.mtime, steps: end.steps, round: end.round,
            winner: end.winner, how: end.how ?? null, decks: h.players.map((p) => p.deck), pov: h.source.pov
        };
    }

    /** The replay text the kit reads: no end line while the game is live. */
    replay(g) {
        const events = g.live ? g.events.slice(0, -1) : g.events;
        return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    }

    /** P(p1 wins) at every step from the predictor, as a swu-lens/1 file. */
    lens(id, g) {
        const clamp = (p) => Math.min(1 - 1e-4, Math.max(1e-4, p));
        const steps = g.events.filter((e) => e.t === 'step').map((e) => {
            const p = clamp(this.ev.predict(e.state, 'p1', { view: 'spectator' }));
            return { n: e.n, edge: +Math.log(p / (1 - p)).toFixed(4), p1Win: +p.toFixed(4) };
        });
        const h = g.events[0];
        return {
            schema: 'swu-lens/1', gameId: id.split('/').pop(), seed: h.seed, players: h.players.map((p) => ({ id: p.id, bot: p.bot })),
            source: 'bot/karabast/live-view.js',
            evaluator: {
                id: this.predictName, label: `${this.predictName} win chance`.slice(0, 24), source: `bot/eval (${this.predictName})`,
                description: 'A small model fitted on bot games. It reads the public board, without either hand, and gives the chance that p1 wins. Human games are harder for it to call than bot games.',
                sees: 'public', cardValues: 'none', constantWeights: true, scale: { unit: 'logit' }, quality: null,
                terms: { unit: [], base: [], side: [] }
            },
            weights: null,
            steps
        };
    }
}

function send(req, res, status, body, type, etag = null) {
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
    if (etag) {
        headers.ETag = `"${etag}"`;
        if (req.headers['if-none-match'] === headers.ETag) {
            res.writeHead(304, headers);
            res.end();
            return;
        }
    }
    let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (buf.length > 1024 && String(req.headers['accept-encoding'] ?? '').includes('gzip')) {
        headers['Content-Encoding'] = 'gzip';
        buf = zlib.gzipSync(buf);
    }
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : buf);
}

function makeServer({ games, kit, key = null }) {
    const page = fs.readFileSync(path.join(__dirname, 'live-view.html'), 'utf8').replace('__PREDICT__', JSON.stringify(Boolean(games.ev)));
    const kitFiles = { 'swu-viewer-kit.js': TYPES.js, 'card-text.json': TYPES.json };
    const prefix = key ? `/${key}/` : '/';
    return http.createServer((req, res) => {
        // the raw path, not new URL(): a path like "//x" parses as a host there, or throws
        const pathname = String(req.url).split('?')[0];
        if (!['GET', 'HEAD'].includes(req.method) || !pathname.startsWith(prefix)) {
            return send(req, res, 404, 'not found', 'text/plain');
        }
        let rel = pathname.slice(prefix.length);
        try {
            rel = decodeURIComponent(rel);
        } catch {
            return send(req, res, 400, 'bad request', 'text/plain');
        }
        try {
            if (rel === '') {
                return send(req, res, 200, page, TYPES.html);
            }
            if (rel === 'games') {
                return send(req, res, 200, JSON.stringify(games.list().slice(0, 40).map((e) => games.summary(e))), TYPES.json);
            }
            if (rel.startsWith('kit/') && Object.hasOwn(kitFiles, rel.slice(4))) {
                return send(req, res, 200, fs.readFileSync(path.join(kit, rel.slice(4))), kitFiles[rel.slice(4)]);
            }
            const m = /^(game|lens)\/(.+)$/.exec(rel);
            const g = m ? games.get(m[2]) : null;
            if (!g || (m[1] === 'lens' && !games.ev)) {
                return send(req, res, 404, 'no such game, or no board yet', 'text/plain');
            }
            if (m[1] === 'game') {
                return send(req, res, 200, games.replay(g), TYPES.jsonl, g.version);
            }
            return send(req, res, 200, JSON.stringify(games.lens(m[2], g)), TYPES.json, `lens-${g.version}`);
        } catch (e) {
            console.error(`${rel}: ${e.message}`);
            return send(req, res, 500, 'server error', 'text/plain');
        }
    });
}

function main() {
    const runs = arg('runs');
    const kit = arg('kit');
    if (!runs || !kit) {
        throw new Error('usage: live-view.js --runs <runs dir> --kit <viewer-kit dir> [--port 8080] [--host 127.0.0.1] [--key <secret>] [--predict mlp-g5]');
    }
    const key = arg('key', null);
    if (key && !/^[\w-]{8,}$/.test(key)) {
        throw new Error('--key must be at least 8 letters, digits, - or _');
    }
    const games = new Games(runs, { predict: arg('predict', null) });
    const port = Number(arg('port', 8080));
    const host = arg('host', '127.0.0.1');
    makeServer({ games, kit, key }).listen(port, host, () => {
        console.error(`live view on http://${host}:${port}/${key ? '<key>/' : ''} (runs ${games.runs})`);
    });
}

if (require.main === module) {
    try {
        main();
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}

module.exports = { Games, makeServer, LIVE_MS };
