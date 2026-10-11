'use strict';

/**
 * Fetch SWU Stats' public meta tables (premier) and summarize them per leader, per base and per leader pair.
 *
 *   node analysis/swustats/fetch.js --out /mnt/project-files/human-meta/swustats [--format premier] [--delay 3000]
 *
 * Polite: reads robots.txt first, two GETs at least 1 s apart (3 s by default), a User-Agent that names this project.
 * Writes <out>/human-summary.json (with the credit line every page showing these numbers must carry); the raw tables
 * go to <out>/raw/. SWU Stats' aggregate APIs are free to use with visible credit.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE = 'https://swustats.net';
const USER_AGENT = 'swu_bot-research/0.1 (+https://github.com/ericfode/swu_bot; slow, public aggregates only)';
const CREDIT = 'SWU Stats (swustats.net)';

function parseArgs(argv) {
    const a = { out: path.join('replays', 'swustats'), format: 'premier', delay: 3000 };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--out') {
            a.out = argv[++i];
        } else if (k === '--format') {
            a.format = argv[++i];
        } else if (k === '--delay') {
            a.delay = Math.max(1000, Number(argv[++i]));
        }
    }
    return a;
}

/** True when a robots.txt group for * (or us) disallows a prefix of p. Longest match wins; Allow beats a tie. */
function robotsAllows(robots, p, agent = 'swu_bot-research') {
    const groups = [];
    let cur = null;
    for (const raw of robots.split('\n')) {
        const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(raw.replace(/#.*/, '').trim());
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
        } else if (cur && (key === 'allow' || key === 'disallow') && m[2]) {
            cur.rules.push({ allow: key === 'allow', path: m[2] });
        }
    }
    const mine = groups.filter((g) => g.agents.some((x) => x !== '*' && agent.toLowerCase().includes(x)));
    const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
    let best = null;
    for (const r of rules) {
        if (p.startsWith(r.path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) {
            best = r;
        }
    }
    return !best || best.allow;
}

/** Per-leader, per-base and leader-vs-leader win counts from the two tables. */
function summarize(deckMeta, matchups, { format, fetchedAt }) {
    const add = (m, k, w, n, extra) => {
        const r = m.get(k) ?? { id: k, wins: 0, plays: 0, ...extra };
        r.wins += w;
        r.plays += n;
        m.set(k, r);
    };
    const leaders = new Map();
    const bases = new Map();
    for (const r of deckMeta) {
        const n = Number(r.numPlays) || 0;
        const w = Math.round(n * Number(r.winRate) / 100);
        add(leaders, r.leaderID, w, n, { name: [r.leaderTitle, r.leaderSubtitle].filter(Boolean).join(', ') });
        add(bases, r.baseID, w, n, { name: r.baseTitle });
    }
    const pairs = new Map();
    let plays = 0;
    let firstPlays = 0;
    let firstWins = 0;
    for (const r of matchups) {
        const n = Number(r.numPlays) || 0;
        plays += n;
        firstPlays += Number(r.playsGoingFirst) || 0;
        firstWins += Number(r.winsGoingFirst) || 0;
        if (r.leaderID !== r.opponentLeaderID) {
            add(pairs, `${r.leaderID}|${r.opponentLeaderID}`, Number(r.numWins) || 0, n);
        }
    }
    const sorted = (m) => [...m.values()].sort((a, b) => b.plays - a.plays);
    return {
        credit: CREDIT, source: `${BASE}/TCGEngine (DeckMetaStatsAPI, MetaMatchupStatsAPI), format ${format}, all weeks`, fetchedAt,
        // only games played with a deck imported from SWU Stats are counted, so absolute win rates run high
        totals: { deckPlays: sorted(leaders).reduce((a, r) => a + r.plays, 0), matchupPlays: plays, firstPlayerWinRate: firstPlays ? firstWins / firstPlays : null },
        leaders: sorted(leaders), bases: sorted(bases), pairs: sorted(pairs).filter((p) => p.plays >= 20)
    };
}

async function run(args, fetchImpl = fetch, log = console.log) {
    const headers = { 'user-agent': USER_AGENT, accept: 'application/json' };
    const robotsRes = await fetchImpl(`${BASE}/robots.txt`, { headers });
    const robots = robotsRes.ok ? await robotsRes.text() : '';
    const urls = {
        deckMeta: `/TCGEngine/Stats/DeckMetaStatsAPI.php?format=${encodeURIComponent(args.format)}`,
        matchups: `/TCGEngine/APIs/MetaMatchupStatsAPI.php?format=${encodeURIComponent(args.format)}`
    };
    for (const p of Object.values(urls)) {
        if (!robotsAllows(robots, p)) {
            throw new Error(`robots.txt disallows ${p}; stopping`);
        }
    }
    const data = {};
    for (const [k, p] of Object.entries(urls)) {
        await new Promise((r) => setTimeout(r, args.delay));
        const res = await fetchImpl(BASE + p, { headers });
        if (!res.ok) {
            throw new Error(`${p}: HTTP ${res.status}`);
        }
        data[k] = await res.json();
        log(`${p}: ${data[k].length} rows`);
    }
    fs.mkdirSync(path.join(args.out, 'raw'), { recursive: true });
    for (const [k, v] of Object.entries(data)) {
        fs.writeFileSync(path.join(args.out, 'raw', `${k}.json`), JSON.stringify(v));
    }
    const summary = summarize(data.deckMeta, data.matchups, { format: args.format, fetchedAt: new Date().toISOString() });
    fs.writeFileSync(path.join(args.out, 'human-summary.json'), JSON.stringify(summary));
    return summary;
}

async function main() {
    const env = process.env;
    // Node's fetch only uses HTTPS_PROXY when NODE_USE_ENV_PROXY is set at startup (Node 22.21+, 24+)
    if ((env.HTTPS_PROXY || env.https_proxy) && !env.NODE_USE_ENV_PROXY) {
        const r = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...env, NODE_USE_ENV_PROXY: '1' } });
        process.exit(r.status ?? 1);
    }
    const s = await run(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(s.totals), `${s.leaders.length} leaders, ${s.bases.length} bases. Credit: ${s.credit}`);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message ?? e);
        process.exit(1);
    });
}

module.exports = { run, summarize, robotsAllows, parseArgs, USER_AGENT, CREDIT };
