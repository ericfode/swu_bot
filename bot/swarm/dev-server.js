#!/usr/bin/env node
'use strict';
/**
 * The browser swarm on one computer, for checking it end to end (bot/swarm/README.md): the window's real relay
 * (bot/arena/swarm-relay.js) and page, signed in as a fixed person, in front of a stand-in games machine that serves the
 * swarm files, hands out seeds and checks every result with the ladder's own checkDone (bot/remote-lane.js), printing
 * what the real machine would record.
 *
 *   node bot/swarm/pack.js --root <games image /app> --out DIR && node bot/swarm/build.js --out DIR
 *   node bot/swarm/dev-server.js --files DIR [--port 5190] [--seeds 4] [--bundle tar:hex ...]
 *   open http://localhost:5190/swarm           (and /check?p1=..&p2=.. plays one game and prints its replay's sha256)
 *
 * The stand-in pairs the residents in the files (and each --bundle as a version test_N-v1) seed after seed.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createSwarmRelay } = require('../arena/swarm-relay');
const { checkDone } = require('../remote-lane');

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const all = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
const PORT = Number(arg('--port', process.env.PORT || 5190));
const FILES = path.resolve(arg('--files', path.join(__dirname, '..', '..', 'build', 'swarm')));
const SEEDS = Number(arg('--seeds', 4));
// --asleep S: the stand-in machine does not answer for its first S seconds, as a games machine between rounds
const AWAKE_AT = Date.now() + Number(arg('--asleep', 0)) * 1000;
const manifest = JSON.parse(fs.readFileSync(path.join(FILES, 'manifest.json'), 'utf8'));
// each start of the dev server is its own build, so a browser never keeps files from an earlier start (the window's
// URLs name the build and browsers keep their files)
manifest.build = `${manifest.build.slice(0, 12)}.dev${Date.now().toString(36)}`;

// --- the stand-in games machine (/v1)
const bundles = new Map(all('--bundle').map((s, i) => {
    const [file, hex] = s.split(':');
    return [hex, { name: `test_${i + 1}-v1`, bytes: fs.readFileSync(file) }];
}));
// heuristic and rush, and the WebAssembly residents the pack has (games images before the residents became entries)
const packed = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(FILES, 'engine.json'), 'utf8')).files));
const residents = ['heuristic', 'rush', ...['rust-greedy2-wasm', 'c-clock-wasm', 'node-search-wasm', 'py-clock-wasm'].filter((n) => packed.has(`/app/build/compiled/${n.slice(0, -5)}/arena.json`))];
const roster = [...residents.map((n) => ({ name: n, bot: { kind: 'resident' } })), ...[...bundles].map(([hex, b]) => ({ name: b.name, bot: { kind: 'wasm', bundle: hex } }))];
let handed = 0;
const leases = new Map();
const waiting = [];
// The round's index as the window has it (bot/ladder.js tIndex): tabs take seeds from the front, and the stand-in
// machine and a helper "play" seeds from the back, one every 2 s, so the page's round grid fills from both ends.
const index = { id: 'arena-r1', bots: [...new Set(roster.map((r) => r.name))], gamesPerPairing: 0, games: [] };
let back = SEEDS;
const entry = (job, outcome, host, winnerSeat = null) => job.games.map((g) => ({ id: g.id, seed: job.seed, p1: g.p1, p2: g.p2, outcome, winner: winnerSeat ? g[winnerSeat] : null, winnerSeat, host, rounds: 0, steps: 0 }));
const putEntries = (list) => {
    for (const e of list) {
        const i = index.games.findIndex((g) => g.id === e.id);
        if (i < 0) {
            index.games.push(e);
        } else {
            index.games[i] = e;
        }
    }
};
setInterval(() => {
    if (back > handed && Date.now() >= AWAKE_AT) {
        const k = --back;
        const job = jobAt(k);
        putEntries(entry(job, 'won', k % 3 ? null : 'eric', 'p1'));
    }
}, 2000).unref();
function jobAt(k) {
    const a = roster[(k * 2) % roster.length];
    const b = roster[(k * 2 + 1) % roster.length];
    const seed = 900000 + k;
    return {
        v: 1, seed, key: crypto.createHash('sha256').update(`dev-${seed}`).digest('hex'), maxSteps: 3000, capMs: 60000, hangMs: 120000, gameMs: 1800000,
        games: [{ id: `${a.name}-vs-${b.name}-${seed}`, p1: a.name, p2: b.name }, { id: `${b.name}-vs-${a.name}-${seed}`, p1: b.name, p2: a.name }],
        bots: { [a.name]: a.bot, [b.name]: b.bot }
    };
}
function nextJob() {
    if (handed >= back) {
        return null;
    }
    const k = handed++;
    const a = roster[(k * 2) % roster.length];
    const b = roster[(k * 2 + 1) % roster.length];
    const seed = 900000 + k;
    return {
        v: 1, seed, key: crypto.createHash('sha256').update(`dev-${seed}`).digest('hex'), maxSteps: 3000, capMs: 60000, hangMs: 120000, gameMs: 1800000,
        games: [{ id: `${a.name}-vs-${b.name}-${seed}`, p1: a.name, p2: b.name }, { id: `${b.name}-vs-${a.name}-${seed}`, p1: b.name, p2: a.name }],
        bots: { [a.name]: a.bot, [b.name]: b.bot }
    };
}
const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
};
const readAll = (req) => new Promise((resolve) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => resolve(Buffer.concat(c)));
});
async function machine(req, res, url) {
    if (Date.now() < AWAKE_AT) {
        req.socket.destroy(); // asleep: no address, the connection fails
        return undefined;
    }
    if (req.headers.authorization !== 'Bearer dev') {
        return json(res, 401, { error: { code: 'unauthorized' } });
    }
    const p = url.pathname.split('/').filter(Boolean);
    if (p[1] === 'swarm' && p[2] === 'manifest.json') {
        return json(res, 200, manifest);
    }
    if (p[1] === 'swarm') {
        const f = path.join(FILES, path.basename(p[2] ?? ''));
        if (!fs.existsSync(f)) {
            return json(res, 404, { error: { code: 'not_found' } });
        }
        res.writeHead(200, { 'content-type': f.endsWith('.wasm') ? 'application/wasm' : f.endsWith('.js') ? 'text/javascript' : 'application/json' });
        return res.end(fs.readFileSync(f));
    }
    if (req.headers['x-helper-build'] !== manifest.build) {
        return json(res, 409, { error: { code: 'build', want: { build: manifest.build, cards: manifest.cards } } });
    }
    if (p[1] === 'hello') {
        const body = JSON.parse(await readAll(req));
        console.log(`hello: ${body.slots} slots, build ${String(body.build).slice(0, 7)}`);
        return json(res, body.cards === manifest.cards ? 200 : 409, { ok: true, name: 'swarm', heartbeatMs: 30000, leaseLostMs: 90000, claimMs: 25000 });
    }
    if (p[1] === 'claim') {
        const { slot } = JSON.parse(await readAll(req));
        const job = nextJob();
        if (!job) {
            return setTimeout(() => res.writableEnded || (res.writeHead(204), res.end()), 25000);
        }
        const id = crypto.randomBytes(8).toString('hex');
        leases.set(id, { job, slot, at: Date.now(), beats: 0 });
        putEntries(entry(job, 'running', 'swarm'));
        console.log(`seed ${job.seed} -> ${slot} (lease ${id}): ${job.games[0].id}`);
        // as coord's Remote lists them: {id, bytes}
        const listed = Object.values(job.bots).filter((b) => b.bundle).map((b) => ({ id: b.bundle, bytes: bundles.get(b.bundle).bytes.length }));
        return json(res, 200, { lease: id, job, bundles: listed, deadlineMs: Date.now() + 3600000 });
    }
    if (p[1] === 'bundle') {
        const b = bundles.get(p[2]);
        if (!b) {
            return json(res, 404, {});
        }
        res.writeHead(200, { 'content-type': 'application/x-tar' });
        return res.end(b.bytes);
    }
    if (p[1] === 'lease') {
        const l = leases.get(p[2]);
        if (!l) {
            return json(res, 410, {});
        }
        if (p[3] === 'heartbeat') {
            l.beats++;
            return json(res, 200, { continue: true });
        }
        const body = JSON.parse(await readAll(req));
        leases.delete(p[2]);
        putEntries(body.failed ? entry(l.job, 'won', null, 'p2') : body.results.map(({ id, result: r }) => ({ ...entry(l.job, 'won', 'swarm').find((e) => e.id === id), outcome: r.outcome, winner: r.winner, winnerSeat: r.winnerSeat, rounds: r.round, steps: r.steps })));
        if (body.failed) {
            console.log(`seed ${l.job.seed}: FAILED (${body.failed})`);
        } else {
            const why = checkDone(l.job.games, body, { seed: l.job.seed, key: l.job.key });
            const outcomes = body.results.map((r) => `${r.result.winner ?? r.result.outcome} (${r.result.steps} steps)`).join(', ');
            console.log(`seed ${l.job.seed}: ${why ? `REFUSED: ${why}` : 'checkDone OK'} after ${Math.round((Date.now() - l.at) / 1000)} s, ${l.beats} heartbeats: ${outcomes}`);
        }
        return json(res, 200, { ok: true });
    }
    return json(res, 404, {});
}

// --- the window: the relay and page, signed in as one person
// the window keeps the files on disk by build, as on Fly (WINDOW_HOME/swarm)
const relay = createSwarmRelay({ token: 'dev', machine: `http://localhost:${PORT}`, cacheDir: path.resolve(arg('--cache', path.join(require('os').tmpdir(), 'swarm-window-cache'))) });
const who = { via: 'cookie', login: 'devuser', role: 'admin' };
const helpers = {
    sendJson: (res, code, body) => json(res, code, body),
    sendText: (res, _req, code, type, text, headers = {}) => {
        res.writeHead(code, { 'content-type': type, ...headers });
        res.end(text);
    },
    readBody: (req) => readAll(req)
};

const CHECK = `<!doctype html><meta charset="utf-8"><title>Swarm check</title><body style="font:14px ui-monospace,monospace;background:#0d1220;color:#d6dbe8;margin:16px">
<div id="log"></div><script>
const log = (s) => { const d = document.createElement('div'); d.textContent = s; document.getElementById('log').append(d); };
const q = new URLSearchParams(location.search);
const job = { v: 1, seed: Number(q.get('seed') || 3250146062), key: q.get('key') || 'b'.repeat(64), maxSteps: 3000, capMs: 60000, hangMs: 120000, gameMs: 1800000,
  games: [{ id: 'check', p1: q.get('p1') || 'rust-greedy2-wasm', p2: q.get('p2') || 'heuristic' }], bots: {} };
job.bots[job.games[0].p1] = { kind: 'resident' }; job.bots[job.games[0].p2] = { kind: 'resident' };
log('crossOriginIsolated: ' + self.crossOriginIsolated + ', cores: ' + navigator.hardwareConcurrency);
fetch('/api/swarm/info').then((r) => r.json()).then((info) => {
  const w = new Worker(info.files.referee); let t0 = performance.now();
  w.onmessage = async (e) => { const m = e.data;
    if (m.t === 'ready') { log('engine ready in ' + m.ms + ' ms'); t0 = performance.now(); w.postMessage({ t: 'play', job, game: 'check', bundles: {} }); }
    else if (m.t === 'result') { const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m.replay || '')))].map((x) => x.toString(16).padStart(2, '0')).join('');
      log('RESULT ' + JSON.stringify({ outcome: m.result.outcome, winner: m.result.winner, steps: m.result.steps, error: m.result.error, ms: Math.round(performance.now() - t0), sha: sha.slice(0, 16) })); window.swarmResult = { result: m.result, sha }; }
    else if (m.t === 'error') { log('ERROR ' + m.message); window.swarmResult = { error: m.message }; } };
  w.postMessage({ t: 'init', pack: info.files.pack, botWorker: info.files.bot, pythonLib: info.files.pythonLib, pythonWasm: info.files.pythonWasm });
});
</script>`;

http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
        if (url.pathname.startsWith('/v1/')) {
            return await machine(req, res, url);
        }
        if (url.pathname === '/') {
            res.writeHead(302, { location: '/swarm' });
            return res.end();
        }
        // the window's own reads that the page's round grid uses
        if (url.pathname === '/api/standings') {
            return json(res, 200, { result: { rounds: [{ round: 1, status: 'running', ladderId: 'arena-r1' }] } });
        }
        if (url.pathname === '/api/docs/runs/arena-r1') {
            return json(res, 200, { result: { ...index, gamesPerPairing: 0, games: index.games, scheduled: SEEDS * 2 } });
        }
        if (url.pathname === '/check') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
            return res.end(CHECK);
        }
        if (!(await relay.route(req, res, url, who, helpers))) {
            json(res, 404, { error: { code: 'not_found' } });
        }
    } catch (e) {
        console.error(e);
        json(res, 500, { error: { code: 'internal', message: e.message } });
    }
}).listen(PORT, () => console.log(`swarm on http://localhost:${PORT}/swarm (files ${FILES}, build ${manifest.build.slice(0, 7)}, ${SEEDS} seeds)`));
