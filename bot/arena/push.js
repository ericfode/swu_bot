#!/usr/bin/env node
'use strict';
/**
 * The arena window's push client (window.js): how each part of the project sends its own data to the window's API.
 *
 *   node bot/arena/push.js doc <collection> <id> <file.json>    one document, e.g. `doc meta ratings meta/ratings.json`
 *   node bot/arena/push.js dir <collection> <folder>            every <id>.json in a folder that changed since last time
 *   node bot/arena/push.js run <run folder> [--follow] [--parent PID]
 *                                                              a ladder run: its index, report and replays; --follow keeps
 *                                                              sending new games and lines until the run (or PID) ends
 *   node bot/arena/push.js arena [--every 20] [--once]          the arena's state from its own API, and its round ladders
 *   node bot/arena/push.js invites <login>[,<login>...]         who may sign in, besides ARENA_ADMINS (replaces the list)
 *
 * SWU_WINDOW is the window's address (default https://swu-arena.fly.dev). In the project's cloud sessions the egress
 * proxy adds the push token for that host, so no thread holds it; elsewhere set SWU_WINDOW_TOKEN.
 * ladder.js starts `run --follow` for itself when SWU_WINDOW is set (followRun below).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BASE = String(process.env.SWU_WINDOW || 'https://swu-arena.fly.dev').replace(/\/+$/, '');
// any value works where the proxy adds the token: it replaces the Authorization header
const TOKEN = process.env.SWU_WINDOW_TOKEN || 'added-by-the-proxy';
const STATE = path.join(require('os').tmpdir(), 'swu-window-push');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class PushError extends Error {
    constructor(status, body) {
        super(`${status} ${body?.error?.message ?? 'error'}`);
        this.status = status;
        this.code = body?.error?.code;
        this.size = body?.error?.size;
    }
}

async function request(method, p, { body, query, type = 'application/json' } = {}) {
    const url = `${BASE}${p}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const res = await fetch(url, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': type }, body, signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    let j = null;
    try {
        j = JSON.parse(text);
    } catch {}
    if (!res.ok) {
        throw new PushError(res.status, j ?? { error: { message: text.slice(0, 200) } });
    }
    return j?.result;
}

const seg = (s) => encodeURIComponent(s);
const putDoc = (ns, id, doc) => request('PUT', `/api/docs/${seg(ns)}/${seg(id)}`, { body: typeof doc === 'string' ? doc : JSON.stringify(doc) });

/** Pushes documents whose content changed since the last push from this process (`seen`, by collection/id). */
async function putChanged(seen, ns, id, doc) {
    const text = typeof doc === 'string' ? doc : JSON.stringify(doc);
    const k = `${ns}/${id}`;
    const h = sha(text);
    if (seen.get(k) === h) {
        return false;
    }
    await putDoc(ns, id, text);
    seen.set(k, h);
    return true;
}

/**
 * Keeps one replay file in step with the window. Lines of a game being played go as appends (only whole lines); a
 * finished game, or a file rewritten in place (ladder.js adds the game's key at the end), goes whole.
 * st: {sent, mtime, size, whole} kept by the caller between calls.
 */
async function syncReplay(run, game, file, st, { finished }) {
    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        return false;
    }
    const changed = stat.size !== st.size || stat.mtimeMs !== st.mtime;
    if (!changed && (st.whole || !finished)) {
        return false;
    }
    const url = `/api/replays/${seg(run)}/${seg(game)}`;
    if (finished || stat.size < (st.sent ?? 0)) {
        await request('PUT', url, { body: fs.readFileSync(file), type: 'application/x-ndjson' });
        Object.assign(st, { sent: stat.size, size: stat.size, mtime: stat.mtimeMs, whole: finished });
        return true;
    }
    const buf = fs.readFileSync(file);
    const end = buf.lastIndexOf(10) + 1; // only whole lines
    let at = st.sent ?? 0;
    for (let tries = 0; tries < 2 && end > at; tries++) {
        try {
            await request('POST', url, { body: buf.subarray(at, end), query: { at }, type: 'application/x-ndjson' });
            at = end;
        } catch (e) {
            if (e.code !== 'conflict' || !Number.isInteger(e.size)) {
                throw e;
            }
            if (e.size > end) {
                await request('PUT', url, { body: buf.subarray(0, end), type: 'application/x-ndjson' }); // the window has more than we do: our file was rewritten
                at = end;
                break;
            }
            at = e.size; // a retry or a restart: send only what the window lacks
        }
    }
    Object.assign(st, { sent: at, size: stat.size, mtime: stat.mtimeMs, whole: false });
    return true;
}

const readJson = (f) => {
    try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
        return null;
    }
};

/** One pass over a ladder run folder: index, ladder report and replays. Returns whether the run is still going. */
async function pushRunOnce(dir, mem) {
    const id = path.basename(path.resolve(dir));
    const idx = readJson(path.join(dir, 'index.json'));
    const lad = readJson(path.join(dir, 'ladder.json'));
    if (idx) {
        await putChanged(mem.docs, 'runs', id, idx);
    }
    if (lad) {
        await putChanged(mem.docs, 'ladders', id, lad);
    }
    const running = new Set((idx?.games ?? []).filter((g) => g.outcome === 'running' || g.running).map((g) => g.id));
    const gamesDir = path.join(dir, 'games');
    const files = fs.existsSync(gamesDir) ? fs.readdirSync(gamesDir).filter((f) => f.endsWith('.jsonl')) : [];
    if (!mem.known && files.length) {
        // what the window already has, so a restarted pusher or a second backfill sends only what is missing
        mem.known = new Map(((await request('GET', `/api/replays/${seg(id)}`, { query: { sizes: 1 } }).catch(() => [])) || []).map((x) => [x.id, x.size]));
        for (const f of files) {
            const game = f.slice(0, -6);
            const stat = fs.statSync(path.join(gamesDir, f));
            if (mem.known.get(game) === stat.size && !running.has(game)) {
                mem.replays.set(game, { sent: stat.size, size: stat.size, mtime: stat.mtimeMs, whole: true });
            }
        }
    }
    let sent = 0;
    for (const f of files) {
        const game = f.slice(0, -6);
        const st = mem.replays.get(game) ?? {};
        mem.replays.set(game, st);
        try {
            if (await syncReplay(id, game, path.join(gamesDir, f), st, { finished: !running.has(game) })) {
                sent++;
            }
        } catch (e) {
            console.error(`push: replay ${id}/${game}: ${e.message}`);
        }
    }
    const going = running.size > 0 || lad?.status === 'running';
    return { going, sent };
}

/** A run folder: once, or (follow) until it is done, or until the parent process ends, then a last pass. */
async function pushRun(dir, { follow = false, parent = null, everyMs = 3000 } = {}) {
    const mem = { docs: new Map(), replays: new Map() };
    let quietDone = 0;
    for (;;) {
        let r = { going: false, sent: 0 };
        try {
            r = await pushRunOnce(dir, mem);
        } catch (e) {
            console.error(`push: run ${dir}: ${e.message}`);
        }
        if (!follow) {
            return r;
        }
        const parentGone = parent && !alive(parent);
        quietDone = !r.going ? quietDone + 1 : 0;
        if (parentGone || quietDone >= 3) {
            if (parentGone) {
                await pushRunOnce(dir, mem).catch(() => {});
            }
            return r;
        }
        await sleep(everyMs);
    }
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

/** Every <id>.json in a folder, pushed when its content changed since the last run of this command. */
async function pushDir(ns, dir) {
    const stateFile = path.join(STATE, `dir-${sha(`${BASE}|${ns}|${path.resolve(dir)}`).slice(0, 16)}.json`);
    const seen = new Map(Object.entries(readJson(stateFile) ?? {}));
    let n = 0;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        try {
            JSON.parse(text);
        } catch {
            continue; // being rewritten: next time
        }
        if (await putChanged(seen, ns, f.slice(0, -5), text)) {
            n++;
        }
    }
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(Object.fromEntries(seen)));
    return n;
}

/**
 * The arena's uplink, run by the arena: its state as its own API answers it (status, versions, panels), the files the
 * app's loader reads (tournament, roster without tokens, standings, round reports, the archived test tournament), and
 * the replays of its newest round ladders.
 */
async function pushArena({ everyMs = 20000, once = false } = {}) {
    const { call } = require('./api');
    const home = require('./home');
    const docs = new Map();
    const runs = new Map();
    const result = async (m, a) => {
        const r = await call(m, a);
        return r.error ? null : r.result;
    };
    for (;;) {
        try {
            const roster = home.roster();
            const t = home.readJson(path.join(home.HOME, 'tournament.json'), null);
            const put = (id, doc) => (doc == null ? null : putChanged(docs, 'arena', id, doc));
            await put('status', await result('status'));
            await put('standings', home.readJson(path.join(home.HOME, 'standings.json'), null));
            await put('tournament', t);
            await put('roster', { ...roster, agents: roster.agents.map(({ tokenHash, ...a }) => a) });
            const reports = async (dir, prefix) => {
                for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
                    const m = /^r(\d+)\.md$/.exec(f);
                    if (m) {
                        await put(`${prefix}${m[1]}`, { round: Number(m[1]), markdown: fs.readFileSync(path.join(dir, f), 'utf8') });
                    }
                }
            };
            await reports(path.join(home.HOME, 'rounds'), 'report-');
            for (const a of roster.agents) {
                const vs = home.versionsOf(a.name);
                const list = (await result('versions', { name: a.name })) ?? [];
                await put(`versions-${a.name}`, list.map((s, i) => ({ v: vs[i], ...s })));
                await put(`panel-${a.name}`, await result('panel', { name: a.name }));
            }
            const t0 = path.join(home.HOME, 'archive', 't0');
            if (fs.existsSync(t0)) {
                await put('archive-t0-standings', home.readJson(path.join(t0, 'standings.json'), null));
                await reports(path.join(t0, 'rounds'), 'archive-t0-report-');
                const pd = path.join(t0, 'panels');
                const panels = fs.existsSync(pd) ? fs.readdirSync(pd).filter((f) => /^arena-.*\.json$/.test(f) && f !== 'arena-leaderboard.json').map((f) => readJson(path.join(pd, f))).filter(Boolean) : [];
                await put('archive-t0-panels', panels);
            }
            // the newest two round ladders (the one playing and the one before), from the arena's results folder
            const ids = (t?.rounds ?? []).map((r) => r?.ladder).filter((x) => typeof x === 'string' && /^arena-[\w-]+$/.test(x)).slice(-2);
            for (const id of ids) {
                const dir = path.join(home.PUBLIC_RESULTS, id);
                if (fs.existsSync(dir)) {
                    if (!runs.has(id)) {
                        runs.set(id, { docs: new Map(), replays: new Map() });
                    }
                    await pushRunOnce(dir, runs.get(id));
                }
            }
        } catch (e) {
            console.error(`push: arena: ${e.message}`);
        }
        if (once) {
            return;
        }
        await sleep(everyMs);
    }
}

/**
 * For ladder.js: when SWU_WINDOW is set, a child process that follows this run into the window and ends with it.
 * The child gets NODE_USE_ENV_PROXY so Node's fetch goes through the cloud proxy (which adds the token).
 */
function followRun(dir) {
    if (!process.env.SWU_WINDOW) {
        return null;
    }
    const child = spawn(process.execPath, [__filename, 'run', dir, '--follow', '--parent', String(process.pid)], { stdio: ['ignore', 'ignore', 'inherit'], env: proxyEnv(process.env), detached: true });
    child.unref();
    return child;
}

function proxyEnv(env) {
    if ((env.HTTPS_PROXY || env.https_proxy) && !env.NODE_USE_ENV_PROXY) {
        return { ...env, NODE_USE_ENV_PROXY: '1', NODE_OPTIONS: [env.NODE_OPTIONS, '--disable-warning=UNDICI-EHPA'].filter(Boolean).join(' ') };
    }
    return env;
}

async function main(argv) {
    const [cmd, ...rest] = argv;
    const flag = (n) => rest.includes(`--${n}`);
    const opt = (n, d) => {
        const i = rest.indexOf(`--${n}`);
        return i >= 0 ? rest[i + 1] : d;
    };
    const pos = rest.filter((x, i) => !x.startsWith('--') && !(i > 0 && ['--every', '--parent'].includes(rest[i - 1])));
    if (cmd === 'doc' && pos.length === 3) {
        await putDoc(pos[0], pos[1], fs.readFileSync(pos[2], 'utf8'));
        return `pushed ${pos[0]}/${pos[1]}`;
    }
    if (cmd === 'dir' && pos.length === 2) {
        return `pushed ${await pushDir(pos[0], pos[1])} changed ${pos[0]} documents`;
    }
    if (cmd === 'run' && pos.length === 1) {
        const r = await pushRun(pos[0], { follow: flag('follow'), parent: opt('parent') ? Number(opt('parent')) : null });
        return `run ${path.basename(path.resolve(pos[0]))}: ${r.sent} replays sent${r.going ? ', still playing' : ''}`;
    }
    if (cmd === 'arena') {
        await pushArena({ everyMs: Number(opt('every', 20)) * 1000, once: flag('once') });
        return 'arena pushed';
    }
    if (cmd === 'invites' && pos.length === 1) {
        const logins = pos[0].split(',').map((x) => x.trim()).filter(Boolean);
        await putDoc('admin', 'invites', { logins, updatedAt: new Date().toISOString() });
        return `${logins.length} invited`;
    }
    throw new Error(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 14).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
}

if (require.main === module) {
    const env = proxyEnv(process.env);
    if (env !== process.env) {
        // Node's fetch only uses HTTPS_PROXY when NODE_USE_ENV_PROXY is set at start: run again with it
        const r = require('child_process').spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env });
        process.exit(r.status ?? 1);
    }
    main(process.argv.slice(2)).then((msg) => console.log(msg), (e) => {
        console.error(e.message);
        process.exit(1);
    });
}

module.exports = { putDoc, putChanged, syncReplay, pushRun, pushRunOnce, pushDir, pushArena, followRun, request };
