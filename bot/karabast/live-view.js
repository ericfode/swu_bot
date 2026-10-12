#!/usr/bin/env node
'use strict';
/**
 * Watch recorded Karabast games in the Holotable viewer (the shared viewer kit) while they are played.
 *
 *   node bot/karabast/live-view.js --runs ~/karabast/runs --kit <viewer-kit dir> [--port 8080] [--host 127.0.0.1]
 *        [--key <secret>] [--predict mlp-g5] [--names <file>]
 *
 * It reads the frame files that spectate.js (<run>/<hash>.jsonl) and queue.js (<run>/frames/<hash>.jsonl) write,
 * turns each into a replay with the importer (importer/karabast.js convertFrames) every time the file grows, and
 * serves it to the kit. A game still being played has no `end` line, so the kit re-fetches it every second and
 * follows the newest move. Frame files are scrubbed when written (frame.js), so nothing here has names or chat.
 *
 * Routes, under /<key>/ when --key is set (anything else is a 404):
 *   /             the page: a game picker and the viewer; it follows the newest live game unless you pick one
 *   /games        recorded games, newest first, as JSON; in a bot game `ours` is our seat and `bot` our bot's name
 *   /status       what the newest queue run is doing (queue.js writes <run>/status.json): queued, playing, stopped
 *   /game/<id>    one game as a replay (spec/replay-format.md)
 *   /lens/<id>    with --predict: the evaluator's P(p1 wins) at every step, as a swu-lens/1 file (no hands seen)
 *   /kit/swu-viewer-kit.js, /kit/card-text.json   from --kit
 * <id> is <run>/<hash> or <run>/frames/<hash>. Only GET, only those files: the server never reads anything else.
 *
 * --names <file> is queue.js's private file of opponents' Karabast names (Eric, 2026-10-12: "I also want to know who on
 * karabast i'm playing"). With it, a bot game names the opponent's seat and the picker says who it is. It works only on a
 * view that stays on this machine (local host, no --key), such as the one tailscale serves to Eric's own devices: the
 * share link, the window feed and every file the project shares never carry names.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { readText } = require('../../importer/sources');
const { convertFrames, splitGames } = require('../../importer/karabast');

/** A frame file stays "live" this long after its last write when it has no winner yet (prompt timer + bank). */
const LIVE_MS = 5 * 60000;
const RUN = /^[A-Za-z0-9][\w.-]*$/;
const ID = new RegExp(`^(${RUN.source.slice(1, -1)})\\/(?:(frames)\\/)?([0-9a-f]{12})$`);
/** Full games kept in memory; the picker's summaries are kept for every file. */
const KEEP = 8;
/** queue.js rewrites status.json every 30 s; a running state older than this means the run died. */
const STATUS_STALE_MS = 2 * 60000;
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', jsonl: 'application/x-ndjson' };

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

/** Converts frame files to replays, once per file version. */
class Games {
    constructor(runs, { predict = null, now = () => Date.now(), names = null } = {}) {
        this.runs = path.resolve(runs);
        this.namesFile = names ? path.resolve(names) : null;
        this.nameCache = { version: null, map: new Map() };
        this.now = now;
        this.cache = new Map(); // file -> { version, game }, the KEEP most recently used
        this.summaries = new Map(); // file -> { version, info }
        this.ev = predict ? require('../eval/evaluators').loadEvaluator(predict) : null;
        this.predictName = predict;
    }

    /** Opponents' names by game id from the --names file, or null without one. */
    opponentNames() {
        if (!this.namesFile) {
            return null;
        }
        let st;
        try {
            st = fs.statSync(this.namesFile);
        } catch {
            return new Map(); // no game recorded a name yet
        }
        const version = `${st.size}-${st.mtimeMs}`;
        if (this.nameCache.version !== version) {
            const map = new Map();
            for (const line of fs.readFileSync(this.namesFile, 'utf8').split('\n')) {
                try {
                    const r = JSON.parse(line);
                    if (typeof r.game === 'string' && typeof r.name === 'string') {
                        map.set(r.game, r.name);
                    }
                } catch {
                    // a blank line, or one being written
                }
            }
            this.nameCache = { version, map };
        }
        return this.nameCache.map;
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
        // only names a game id can carry, so every listed game can be opened
        for (const d of dirs.filter((x) => x.isDirectory() && RUN.test(x.name))) {
            for (const sub of [null, 'frames']) {
                const dir = path.join(this.runs, d.name, ...(sub ? [sub] : []));
                if (!fs.existsSync(dir)) {
                    continue;
                }
                for (const f of fs.readdirSync(dir).filter((x) => /^[0-9a-f]{12}\.jsonl$/.test(x))) {
                    const id = [d.name, sub, f.slice(0, -6)].filter(Boolean).join('/');
                    const st = fs.statSync(path.join(dir, f));
                    out.push({ id, mtime: st.mtimeMs, size: st.size, kind: sub ? 'bot game' : 'watched' });
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
            if (hit.game && ID.exec(id)[2]) {
                this.nameSeats(hit.game, ID.exec(id)[1], path.basename(file));
            }
        }
        this.cache.delete(file);
        this.cache.set(file, hit);
        while (this.cache.size > KEEP) {
            this.cache.delete(this.cache.keys().next().value);
        }
        if (!hit.game) {
            return null;
        }
        const end = hit.game.events[hit.game.events.length - 1];
        const live = !end.winner && this.now() - st.mtimeMs < LIVE_MS;
        return { ...hit.game, live, version: `${version}-${live ? 'live' : 'done'}` };
    }

    convert(text) {
        try {
            // the recorder may be halfway through writing a line
            const cap = readText(text.slice(0, text.lastIndexOf('\n') + 1));
            const games = splitGames(cap.frames.filter((f) => Object.keys(f.state?.players ?? f.players ?? {}).length >= 2));
            if (!games.length) {
                return null;
            }
            const { events } = convertFrames(games[games.length - 1], { seats: cap.meta.capture?.seats, source: { kind: cap.meta.reader } });
            return { events };
        } catch {
            return null; // no board yet, or not a frame file
        }
    }

    /**
     * A bot game's frames are our seat's view (source.pov): name that seat after our bot and the other one "opponent",
     * so the viewer says who is who. The bot's name comes from the run's games.jsonl row or status.json.
     */
    nameSeats(game, run, base) {
        const h = game.events[0];
        const ours = h.source?.pov;
        if (!h.players.some((p) => p.id === ours)) {
            return;
        }
        const dir = path.join(this.runs, run);
        let bot = null;
        try {
            const st = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
            bot = st.file === base ? st.bot : null;
        } catch {
            // no status file: an older run
        }
        try {
            const rows = fs.readFileSync(path.join(dir, 'games.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
            bot = rows.find((r) => r.file === base)?.bot ?? bot;
        } catch {
            // no rows yet: the first game of a run
        }
        bot = typeof bot === 'string' && bot ? bot : 'our bot';
        const opponent = this.opponentNames()?.get(`${run}/frames/${base.replace(/\.jsonl$/, '')}`) ?? null;
        h.players = h.players.map((p) => ({ ...p, bot: p.id === ours ? `${bot} (ours)` : opponent ?? 'opponent', human: p.id !== ours }));
        h.ours = opponent ? { seat: ours, bot, opponent } : { seat: ours, bot };
    }

    /** One line per game for the picker (an entry from list()). `board` says whether the game can be shown yet. */
    summary(entry) {
        const file = this.file(entry.id);
        const version = `${entry.size}-${Math.round(entry.mtime)}`;
        let s = this.summaries.get(file);
        if (!s || s.version !== version) {
            const g = this.get(entry.id);
            const h = g?.events[0];
            const end = g?.events[g.events.length - 1];
            s = {
                version,
                info: g && {
                    steps: end.steps, round: end.round, winner: end.winner, how: end.how ?? null, decks: h.players.map((p) => p.deck), pov: h.source.pov,
                    ours: h.ours?.seat ?? null, bot: h.ours?.bot ?? null, ...(h.ours?.opponent ? { opponent: h.ours.opponent } : {})
                }
            };
            this.summaries.set(file, s);
        }
        const fresh = this.now() - entry.mtime < LIVE_MS;
        const base = { id: entry.id, kind: entry.kind, mtime: entry.mtime };
        return s.info ? { ...base, ...s.info, board: true, live: !s.info.winner && fresh } : { ...base, board: false, live: fresh, steps: 0 };
    }

    /**
     * What the newest queue run says it is doing (its status.json), with `game` the id of the game it is playing and
     * `stale` when a running state has not been rewritten for STATUS_STALE_MS (the run died). Null when no run has one.
     */
    status() {
        let best = null;
        const dirs = fs.existsSync(this.runs) ? fs.readdirSync(this.runs, { withFileTypes: true }) : [];
        for (const d of dirs.filter((x) => x.isDirectory() && RUN.test(x.name))) {
            const file = path.join(this.runs, d.name, 'status.json');
            if (fs.existsSync(file)) {
                const mtime = fs.statSync(file).mtimeMs;
                if (!best || mtime > best.mtime) {
                    best = { run: d.name, file, mtime };
                }
            }
        }
        if (!best) {
            return null;
        }
        let st;
        try {
            st = JSON.parse(fs.readFileSync(best.file, 'utf8'));
        } catch {
            return null; // queue.js renames a whole file into place, so this is a file someone else wrote
        }
        const game = typeof st.file === 'string' && /^[0-9a-f]{12}\.jsonl$/.test(st.file) ? `${best.run}/frames/${st.file.slice(0, -6)}` : null;
        const keep = ['bot', 'deck', 'state', 'since', 'at', 'played', 'won', 'lost', 'errors', 'reason', 'last'];
        const out = Object.fromEntries(keep.filter((k) => st[k] != null).map((k) => [k, st[k]]));
        return { ...out, run: best.run, game, stale: st.state !== 'stopped' && this.now() - best.mtime > STATUS_STALE_MS };
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

/** True when Accept-Encoding allows gzip: named with q above 0, or covered by "*" when not named. */
function acceptsGzip(header) {
    const q = {};
    for (const part of String(header ?? '').split(',')) {
        const [name, ...params] = part.trim().toLowerCase().split(';').map((x) => x.trim());
        const qp = params.find((x) => x.startsWith('q='));
        q[name] = qp ? Number(qp.slice(2)) : 1;
    }
    return (q.gzip ?? q['*'] ?? 0) > 0;
}

function send(req, res, status, body, type, etag = null) {
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
    if (etag) {
        headers.ETag = `"${etag}"`;
        if (req.headers['if-none-match'] === headers.ETag) {
            res.writeHead(304, headers);
            res.end();
            return;
        }
    }
    let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (buf.length > 1024 && acceptsGzip(req.headers['accept-encoding'])) {
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
                return send(req, res, 200, JSON.stringify(games.list().map((e) => games.summary(e))), TYPES.json);
            }
            if (rel === 'status') {
                return send(req, res, 200, JSON.stringify(games.status()), TYPES.json);
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

/**
 * Refuses to serve beyond this machine without --key: a live bot game shows our bot's hand, and anyone who can reach
 * the port (the opponent included) could read it during play. Opponents' names (--names) never go beyond it.
 */
function checkBinding(host, key, names = null) {
    const local = ['127.0.0.1', '::1', 'localhost'].includes(host);
    if (!local && !key) {
        throw new Error(`--host ${host} reaches beyond this machine: add --key <secret>, since a live bot game shows our hand`);
    }
    if (names && (!local || key)) {
        throw new Error('--names shows opponents\' Karabast names: only on a view that stays on this machine (local --host, no --key)');
    }
}

function main() {
    const runs = arg('runs');
    const kit = arg('kit');
    if (!runs || !kit) {
        throw new Error('usage: live-view.js --runs <runs dir> --kit <viewer-kit dir> [--port 8080] [--host 127.0.0.1] [--key <secret>] [--predict mlp-g5] [--names <file>]');
    }
    const key = arg('key', null);
    if (key && !/^[\w-]{8,}$/.test(key)) {
        throw new Error('--key must be at least 8 letters, digits, - or _');
    }
    const port = Number(arg('port', 8080));
    const host = arg('host', '127.0.0.1');
    const names = arg('names', null);
    checkBinding(host, key, names);
    const games = new Games(runs, { predict: arg('predict', null), names });
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

module.exports = { Games, makeServer, acceptsGzip, checkBinding, LIVE_MS, STATUS_STALE_MS };
