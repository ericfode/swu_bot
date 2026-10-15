#!/usr/bin/env node
'use strict';
/**
 * A table on one computer: people play bots in Holotable's play page (#/play), the referee runs here.
 *
 *   node bot/table/serve.js [--port 8790] [--host 127.0.0.1] [--site DIR] [--card-text FILE] [--decks FILE] [--out DIR]
 *                           [--bots-file FILE [--bots-root DIR]] [--offer a,b,c] [--bot-deck NAME] [--idle-min 30]
 *
 * --site serves a built Holotable (its dist/) at /, so one address holds the page and the table; --card-text the
 * printed card data it draws text faces from (default the shared folder's viewer-kit/card-text.json when it exists). --bots-file adds
 * programs from an external-bots.json (holocron's bots/external-bots.json: cmd and args relative to --bots-root,
 * default the folder above the file's folder); --offer lists the bots people may pick (default: rush, heuristic,
 * random and every bot in --bots-file). Every game is written to --out (default replays/table) in the replay format,
 * so Holotable lists it as the tournament "table". A person who leaves a decision open for --idle-min minutes concedes.
 *
 * API (JSON; the person's messages are protocol v2, spec/protocol.md, plus table.js `move` and `end`):
 *   GET  /table/api/options                 {bots, decks, botDeck}
 *   POST /table/api/games  {bot, deck, botDeck?}   -> {id, seat}
 *   GET  /table/api/games/<id>/events?from=N        server-sent events, one message each, numbered from 1
 *   POST /table/api/games/<id>/act  {t:"act", seq, i, split?}   -> {ok:true} or 400 {error}
 *   POST /table/api/games/<id>/concede
 *   GET  /table/api/games/<id>/replay.jsonl
 * This is a local demo: no sign-in and no limits on games at once. The hosted table (the window, or the person's own
 * browser) is a separate step.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Env } = require('../env');
const { StdioClient } = require('../stdio');
const { makeBot } = require('../players');
const { loadDecks } = require('../decklists');
const { PersonSeat } = require('./person');
const { playTable } = require('./table');

const REPO = path.resolve(__dirname, '..', '..');
const ID = /^[a-z0-9-]{1,80}$/;
const MAX_BODY = 64 << 10;
// a finished game stays here this long for its page (the end, the replay link); its replay stays on disk after
const KEEP_MS = 60 * 60000;
// printed card data for Holotable's text faces (swu-card-text/1), served as /card-text.json
const CARD_TEXT = '/mnt/project-files/viewer-kit/card-text.json';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.jsonl': 'application/x-ndjson' };

function parseArgs(argv) {
    const o = { port: 8790, host: '127.0.0.1', site: null, cardText: fs.existsSync(CARD_TEXT) ? CARD_TEXT : null, decks: path.join(REPO, 'bot/decks/ash-meta-2026-09.json'), out: path.join(REPO, 'replays/table'), botsFile: null, botsRoot: null, offer: null, botDeck: 'luke-skywalker_jtl_data-vault', idleMin: 30 };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const v = () => {
            if (i + 1 >= argv.length) {
                throw new Error(`${k} needs a value`);
            }
            return argv[++i];
        };
        if (k === '--port') o.port = Number(v());
        else if (k === '--host') o.host = v();
        else if (k === '--site') o.site = path.resolve(v());
        else if (k === '--card-text') o.cardText = path.resolve(v());
        else if (k === '--decks') o.decks = path.resolve(v());
        else if (k === '--out') o.out = path.resolve(v());
        else if (k === '--bots-file') o.botsFile = path.resolve(v());
        else if (k === '--bots-root') o.botsRoot = path.resolve(v());
        else if (k === '--offer') o.offer = v().split(',').filter(Boolean);
        else if (k === '--bot-deck') o.botDeck = v();
        else if (k === '--idle-min') o.idleMin = Number(v());
        else throw new Error(`unknown option ${k}`);
    }
    return o;
}

/** The bots people may pick: name -> () => a fresh protocol client or native bot for one game. */
function botMakers(o) {
    const makers = new Map();
    for (const name of ['rush', 'heuristic', 'random']) {
        makers.set(name, () => makeBot(name));
    }
    if (o.botsFile) {
        const root = o.botsRoot ?? path.dirname(path.dirname(o.botsFile));
        const cards = path.join(REPO, 'forceteki/test/json');
        for (const [name, spec] of Object.entries(JSON.parse(fs.readFileSync(o.botsFile, 'utf8')))) {
            const cmd = spec.cmd.includes('/') ? path.resolve(root, spec.cmd) : spec.cmd;
            makers.set(name, () => new StdioClient(name, { cmd, args: spec.args ?? [], cwd: root, env: { SWU_CARD_JSON: cards }, stderr: 'ignore', lang: spec.lang }));
        }
    }
    const offer = o.offer ?? [...makers.keys()];
    for (const name of offer) {
        if (!makers.has(name)) {
            throw new Error(`--offer: unknown bot ${name} (known: ${[...makers.keys()].join(', ')})`);
        }
    }
    return { makers, offer };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const parts = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(Object.assign(new Error('body too large'), { status: 413 }));
                req.destroy();
            } else {
                parts.push(c);
            }
        });
        req.on('end', () => {
            try {
                resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {});
            } catch {
                reject(Object.assign(new Error('body is not JSON'), { status: 400 }));
            }
        });
        req.on('error', reject);
    });
}

const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
};

function main() {
    const o = parseArgs(process.argv.slice(2));
    const { makers, offer } = botMakers(o);
    console.log('loading the engine and card data ...');
    const env = new Env();
    const { decks } = loadDecks(o.decks, env);
    const deckByName = new Map(decks.map((d) => [d.metadata.name, d]));
    if (!deckByName.has(o.botDeck)) {
        o.botDeck = decks[0].metadata.name;
    }
    fs.mkdirSync(path.join(o.out, 'games'), { recursive: true });
    const indexFile = path.join(o.out, 'index.json');
    const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : { id: path.basename(o.out), createdAt: new Date().toISOString(), engine: null, bots: [], gamesPerPairing: 1, games: [] };
    const saveIndex = () => {
        index.bots = [...new Set(index.games.flatMap((g) => [g.p1, g.p2]))];
        fs.writeFileSync(indexFile + '.tmp', JSON.stringify(index, null, 1));
        fs.renameSync(indexFile + '.tmp', indexFile);
    };
    const games = new Map();

    function start(body) {
        const { bot: botName, deck, botDeck } = body && typeof body === 'object' ? body : {};
        if (!offer.includes(botName)) {
            throw Object.assign(new Error(`no bot ${botName}`), { status: 400 });
        }
        const mine = deckByName.get(deck);
        const theirs = deckByName.get(botDeck || o.botDeck);
        if (!mine || !theirs) {
            throw Object.assign(new Error('unknown deck'), { status: 400 });
        }
        let seed;
        let id;
        do {
            seed = crypto.randomInt(0, 2 ** 32);
            id = `you-vs-${botName}-${seed}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        } while (games.has(id) || index.games.some((e) => e.id === id));
        const g = { id, events: [], clients: new Set(), replay: null, done: false };
        const push = (msg) => {
            // a person who walks away concedes: no decision stays open longer than --idle-min
            clearTimeout(g.idle);
            if (msg.t === 'decide') {
                g.idle = setTimeout(() => g.person.concede(), o.idleMin * 60000);
                g.idle.unref?.();
            }
            const { replay, ...rest } = msg;
            if (msg.t === 'end') {
                g.replay = replay;
                rest.replay = `/table/api/games/${id}/replay.jsonl`;
                g.done = true;
                // forget the game after a while, and hang up on pages still listening
                setTimeout(() => {
                    games.delete(id);
                    for (const c of g.clients) {
                        c.end();
                    }
                }, KEEP_MS).unref?.();
            }
            g.events.push(rest);
            const k = g.events.length;
            for (const c of g.clients) {
                c.write(`id: ${k}\ndata: ${JSON.stringify(rest)}\n\n`);
            }
        };
        g.person = new PersonSeat({ name: 'you', send: push });
        const bot = makers.get(botName)();
        games.set(id, g);
        const entry = { id, seed, p1: 'you', p2: botName, winner: null, winnerSeat: null, rounds: 0, steps: 0, outcome: 'running', error: null, by: null, ms: 0, decks: { p1: deck, p2: theirs.metadata.name } };
        index.games.push(entry);
        saveIndex();
        const t0 = Date.now();
        playTable({ env, person: g.person, personSeat: 'p1', bot, decks: { p1: mine, p2: theirs }, seed, key: crypto.randomBytes(32).toString('hex'), send: push })
            .then(({ result, replay }) => {
                fs.writeFileSync(path.join(o.out, 'games', `${id}.jsonl`), replay);
                Object.assign(entry, {
                    winner: result.winner ? (result.winner === 'p1' ? 'you' : botName) : null, winnerSeat: result.winner ?? null,
                    rounds: result.round, steps: result.steps, outcome: result.outcome, error: result.error ?? null, by: result.by ?? null, ms: Date.now() - t0
                });
                saveIndex();
                console.log(`${id}: ${result.outcome}, winner ${entry.winner ?? 'none'}, ${result.steps} moves`);
            })
            .catch((e) => {
                console.error(`${id}: ${e.stack ?? e}`);
                push({ t: 'end', winner: null, outcome: 'ERROR', error: String(e.message ?? e).slice(0, 200), by: null, conceded: false, replay: null });
            })
            .finally(() => bot.close?.());
        return { id, seat: 'p1' };
    }

    function serveStatic(req, res) {
        if (!o.site) {
            return json(res, 404, { error: 'not found' });
        }
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
        const file = path.resolve(o.site, rel);
        if (!file.startsWith(o.site + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            return json(res, 404, { error: 'not found' });
        }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const parts = url.pathname.split('/').filter(Boolean);
        try {
            if (parts[0] !== 'table' || parts[1] !== 'api') {
                // Holotable's own data routes, so the replays of these games open in the same page
                if (url.pathname === '/card-text.json' && o.cardText) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    return fs.createReadStream(o.cardText).pipe(res);
                }
                if (url.pathname === '/api/tournaments') {
                    return json(res, 200, [{ id: index.id, createdAt: index.createdAt, engine: index.engine, bots: index.bots, games: index.games.length }]);
                }
                if (parts[0] === 'replays' && parts[1] === index.id) {
                    const rest = parts.slice(2).join('/');
                    if (rest === 'index.json') {
                        return json(res, 200, index);
                    }
                    const m = /^games\/([a-z0-9-]+)\.jsonl$/.exec(rest);
                    const f = m && path.join(o.out, 'games', `${m[1]}.jsonl`);
                    if (f && fs.existsSync(f)) {
                        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
                        return fs.createReadStream(f).pipe(res);
                    }
                    return json(res, 404, { error: 'not found' });
                }
                return serveStatic(req, res);
            }
            if (req.method === 'GET' && parts[2] === 'options') {
                return json(res, 200, { bots: offer, decks: decks.map((d) => ({ name: d.metadata.name, leader: d.leader.id, base: d.base.id, style: d.metadata.style ?? null })), botDeck: o.botDeck });
            }
            if (req.method === 'POST' && parts[2] === 'games' && parts.length === 3) {
                return json(res, 200, start(await readBody(req)));
            }
            const g = parts[2] === 'games' && ID.test(parts[3] ?? '') ? games.get(parts[3]) : null;
            if (!g) {
                return json(res, 404, { error: 'no such game' });
            }
            if (req.method === 'GET' && parts[4] === 'events') {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
                const from = Math.max(0, Number(url.searchParams.get('from') ?? req.headers['last-event-id'] ?? 0) || 0);
                g.events.slice(from).forEach((e, k) => res.write(`id: ${from + k + 1}\ndata: ${JSON.stringify(e)}\n\n`));
                g.clients.add(res);
                const beat = setInterval(() => res.write(': beat\n\n'), 15000);
                req.on('close', () => {
                    clearInterval(beat);
                    g.clients.delete(res);
                });
                return undefined;
            }
            if (req.method === 'POST' && parts[4] === 'act') {
                const why = g.person.answer(await readBody(req));
                return why ? json(res, 400, { error: why }) : json(res, 200, { ok: true });
            }
            if (req.method === 'POST' && parts[4] === 'concede') {
                g.person.concede();
                return json(res, 200, { ok: true });
            }
            if (req.method === 'GET' && parts[4] === 'replay.jsonl' && g.replay) {
                res.writeHead(200, { 'content-type': 'application/x-ndjson' });
                return res.end(g.replay);
            }
            return json(res, 404, { error: 'not found' });
        } catch (e) {
            return json(res, e.status ?? 500, { error: String(e.message ?? e).split('\n')[0] });
        }
    });
    server.listen(o.port, o.host, () => console.log(`table on http://${o.host}:${o.port}/${o.site ? '#/play' : 'table/api/options'} (bots: ${offer.join(', ')})`));
}

if (require.main === module) {
    main();
}

module.exports = { parseArgs, botMakers };
