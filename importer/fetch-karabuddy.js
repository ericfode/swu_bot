'use strict';

/**
 * Fetch the replays KaraBuddy users chose to publish (its public list, at most 200) and import them.
 *
 *   node importer/fetch-karabuddy.js --out replays/karabuddy-public [--limit 200] [--delay 3000] [--dry-run]
 *
 * Polite by design:
 *   - reads robots.txt first and stops if it disallows the API;
 *   - one request at a time, --delay ms apart (default 3 s), with a User-Agent that names this project;
 *   - fetches each replay once: re-runs skip games already in <out>/games;
 *   - follows KaraBuddy's own privacy choices for strangers: public replays come without names or deck lists, so
 *     the replay keeps neither (the downloaded file still holds them and is never written to disk), and chat is
 *     dropped as in every import;
 *   - credits KaraBuddy in every header (source.credit, source.url = the replay's page on karabuddy.app).
 * Replays that are encrypted, pruned, or not in the KaraBuddy v1/v2 format are skipped and counted. Three network
 * failures in a row (a blocked or down host) stop the run.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { readKaraBuddy } = require('./sources');
const { convertFrames } = require('./karabast');
const { indexEntry } = require('./import');

const BASE = 'https://karabuddy.app';
const MAX_NETWORK_FAILURES = 3;
const USER_AGENT = 'swu_bot-research/0.1 (+https://github.com/ericfode/swu_bot; slow, public replays only)';

function parseArgs(argv) {
    const a = { out: path.join('replays', 'karabuddy-public'), limit: 200, delay: 3000, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--out') {
            a.out = argv[++i];
        } else if (k === '--limit') {
            a.limit = Number(argv[++i]);
        } else if (k === '--delay') {
            a.delay = Math.max(1000, Number(argv[++i]));
        } else if (k === '--dry-run') {
            a.dryRun = true;
        }
    }
    return a;
}

/** Disallow rules that apply to us (our agent or *) in a robots.txt. */
function disallowed(robots, agent = 'swu_bot-research') {
    const groups = [];
    let cur = null;
    for (const raw of robots.split('\n')) {
        const line = raw.replace(/#.*/, '').trim();
        const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
        if (!m) {
            continue;
        }
        const key = m[1].toLowerCase();
        if (key === 'user-agent') {
            if (!cur || cur.rules.length) {
                cur = { agents: [], rules: [] };
                groups.push(cur);
            }
            cur.agents.push(m[2].toLowerCase());
        } else if (cur && (key === 'disallow' || key === 'allow')) {
            cur.rules.push({ allow: key === 'allow', path: m[2] });
        }
    }
    const mine = groups.filter((g) => g.agents.some((x) => x !== '*' && agent.toLowerCase().includes(x)));
    const use = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
    return use.flatMap((g) => g.rules);
}

/** Longest matching rule wins; an empty Disallow allows everything. */
function allowedPath(rules, p) {
    let best = null;
    for (const r of rules) {
        if (r.path && p.startsWith(r.path) && (!best || r.path.length > best.path.length)) {
            best = r;
        }
    }
    return !best || best.allow;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Download one replay payload: gzip bytes (Vercel Blob), gzip encoding (R2), or plain JSON. */
async function payloadJson(res) {
    const buf = Buffer.from(await res.arrayBuffer());
    const raw = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
    return JSON.parse(raw.toString('utf8'));
}

async function run(args, fetchImpl = fetch, log = console.log) {
    const get = async (url) => {
        let res;
        try {
            res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } });
        } catch (e) {
            const err = new Error(`${new URL(url).host}: ${e.cause?.message ?? e.message}`);
            err.network = true;
            throw err;
        }
        if (!res.ok) {
            throw new Error(`${url}: HTTP ${res.status}`);
        }
        return res;
    };
    const robotsRes = await fetchImpl(`${BASE}/robots.txt`, { headers: { 'user-agent': USER_AGENT } });
    const rules = robotsRes.ok ? disallowed(await robotsRes.text()) : [];
    for (const p of ['/api/replays/public', '/api/replays/']) {
        if (!allowedPath(rules, p)) {
            throw new Error(`robots.txt disallows ${p}; stopping`);
        }
    }
    await sleep(args.delay);
    const list = (await (await get(`${BASE}/api/replays/public`)).json())?.data ?? [];
    const gamesDir = path.join(args.out, 'games');
    const have = fs.existsSync(gamesDir) ? new Set(fs.readdirSync(gamesDir).map((f) => f.replace(/\.jsonl$/, ''))) : new Set();
    const todo = list.filter((r) => r?.slug && /^[A-Za-z0-9_-]+$/.test(r.slug) && !r.encrypted && !have.has(r.slug)).slice(0, args.limit);
    log(`${list.length} public replays listed, ${have.size} already imported, fetching ${todo.length}`);
    const counts = { imported: 0, pruned: 0, failed: 0 };
    let networkFailures = 0; // in a row; a blocked or down host should not cost the site 200 more requests
    if (args.dryRun) {
        return { listed: list.length, todo: todo.map((r) => r.slug), ...counts };
    }
    fs.mkdirSync(gamesDir, { recursive: true });
    const indexFile = path.join(args.out, 'index.json');
    const index = fs.existsSync(indexFile)
        ? JSON.parse(fs.readFileSync(indexFile, 'utf8'))
        : { id: path.basename(args.out), createdAt: new Date().toISOString(), engine: null, bots: [], gamesPerPairing: 1, games: [], human: true, credit: 'Replays published by their owners on KaraBuddy (karabuddy.app)' };
    for (const r of todo) {
        try {
            await sleep(args.delay);
            const meta = (await (await get(`${BASE}/api/replays/${r.slug}`)).json())?.data;
            if (!meta?.payloadBlobUrl || meta.payloadPrunedAt || meta.encrypted) {
                counts.pruned++;
                continue;
            }
            await sleep(args.delay);
            const payload = await payloadJson(await get(meta.payloadBlobUrl));
            delete payload.decks; // KaraBuddy shows strangers no deck lists; keep it that way
            const cap = readKaraBuddy(payload);
            const { events } = convertFrames(cap.frames, {
                source: { kind: 'karabuddy-public', slug: r.slug, url: `${BASE}/r/${r.slug}`, credit: 'KaraBuddy (karabuddy.app)', publishedAt: r.publicAt ?? meta.publicAt ?? null }
            });
            fs.writeFileSync(path.join(gamesDir, `${r.slug}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
            const entry = indexEntry(r.slug, events);
            index.games = index.games.filter((g) => g.id !== r.slug).concat(entry);
            for (const b of [entry.p1, entry.p2]) {
                if (!index.bots.includes(b)) {
                    index.bots.push(b);
                }
            }
            fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
            counts.imported++;
            networkFailures = 0;
            log(`${r.slug}: ${events.length - 2} steps, pov ${events[0].source.pov}, winner ${entry.winnerSeat ?? '-'}`);
        } catch (e) {
            counts.failed++;
            log(`${r.slug}: ${e.message}`);
            if (e.network && ++networkFailures >= MAX_NETWORK_FAILURES) {
                log(`${networkFailures} network failures in a row; stopping`);
                return { listed: list.length, ...counts, stopped: e.message };
            }
        }
    }
    return { listed: list.length, ...counts };
}

async function main() {
    const env = process.env;
    // Node's fetch only uses HTTPS_PROXY when NODE_USE_ENV_PROXY is set at startup (Node 22.21+, 24+)
    if ((env.HTTPS_PROXY || env.https_proxy) && !env.NODE_USE_ENV_PROXY) {
        const r = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...env, NODE_USE_ENV_PROXY: '1' } });
        process.exit(r.status ?? 1);
    }
    const res = await run(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(res));
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message ?? e);
        process.exit(1);
    });
}

module.exports = { run, disallowed, allowedPath, parseArgs, USER_AGENT };
