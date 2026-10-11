'use strict';

/**
 * Meta-analyzer: reads every recorded tournament under a results folder and writes one JSON model of
 * each strategy's traits (strength, style, and where it wins or loses relative to expectation).
 *
 *   node meta/analyze.js [--results /mnt/project-files/results] [--out meta.json] [--panels dir] [--bots bots.json]
 *                        [--human /mnt/project-files/human-games]
 *
 * Pure reading: no engine, no card data. Replays are the recorder JSONL format (bot/recorder.js).
 */

const fs = require('fs');
const path = require('path');
const { bradleyTerry } = require('../bot/ratings');
const KIT = require('./atlas-kit');
// A source's credit links to its site, never to one game (a game link is an id).
const siteOf = (u) => { try { return u ? new URL(u).origin : null; } catch { return null; } };

const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const RESULTS = args.results || '/mnt/project-files/results';
const OUT = args.out || 'meta.json';
const PANELS = args.panels || '/mnt/project-files/dashboard/panels';
const BOTS_META = args.bots || '/mnt/project-files/dashboard/league/bots.json';
const CARDS = args.cards || '/mnt/project-files/dashboard/bots'; // dashboard bot cards: their `family` wins, so both pages agree
const HUMAN = args.human || '/mnt/project-files/human-games'; // imported karabast.net games (importer/import.js)
const RATINGS = args.ratings || path.join(path.dirname(OUT), 'ratings.json'); // one rating per bot for every page (Eric's app pick, 18:21)
const CACHE = args.cache || null; // replay features keyed by path, size and mtime, so refreshes only read new games

// ---------------------------------------------------------------------------------------------- identities

/**
 * Bot names are the p1/p2 strings in each index. A few names mean the same bot: random-a/b/c are seeds of one
 * random bot, and `legacy` is the heuristic before the base-danger sign fix. Runs made with the fixed code keep the
 * names as they are (that is what arena runs and new ladders call them). In runs made before the fix, the heuristic
 * is the old evaluation, so it is `legacy`, and its aggro, tempo and control profiles become `legacy-aggro` and so on.
 */
const HEURISTIC_PROFILES = new Set(['heuristic', 'aggro', 'tempo', 'control']);
// The fix reached main with fork PR #10 at this time; runs created later use it.
const FIX_ON_MAIN = Date.parse('2026-10-11T11:36:54Z');
// Earlier runs that already had the fix (made on its branch). Their aggro records give them away (wasm-ladder-1
// 58-12, lisp-ladder-1 40-10, against about 35% wins in the old-profile ladders). A run can also say so itself
// with `fixedEra: true` (or false) in index.json or in ladder.json's config, which wins over the date.
const FIXED_ERA_RUNS = new Set(['wasm-ladder-1', 'lisp-ladder-1']);
function isFixedEra(dir, idx, cfg, names) {
    if (names.has('legacy') || FIXED_ERA_RUNS.has(dir)) return true;
    const flag = idx.fixedEra ?? cfg.fixedEra;
    if (typeof flag === 'boolean') return flag;
    return Date.parse(idx.createdAt) >= FIX_ON_MAIN;
}
function canonical(name, run) {
    if (/^random(-[a-z])?$/.test(name)) return 'random';
    if (run.fixedEra || !HEURISTIC_PROFILES.has(name)) return name;
    return name === 'heuristic' ? 'legacy' : `legacy-${name}`;
}

// ---------------------------------------------------------------------------------------------- situations

/**
 * A situation is a predicate on a round-start snapshot, from one player's point of view. A game "enters" a
 * situation at the first round start where it holds; the player's result in that game is scored against the
 * baseline expectation at that moment.
 */
// Spot rules live in the shared Atlas kit, so every page that names a spot means the same test.
const SITUATIONS = KIT.SPOTS.map(({ id, group, label, short, test }) => ({ id, group, label, short, test }));

/** Style traits measured from replays: per game, then averaged per bot (words in the Atlas kit). */
const STYLE = KIT.TRAITS;

// ---------------------------------------------------------------------------------------------- replay features

const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

const view = KIT.view;
const sideOf = KIT.sideOf;

/** Reads one replay: round-start snapshots per player and per-player style counters. */
function readReplay(file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const snaps = []; // { pid, round, step, x }
    const st = { p1: blankStyle(), p2: blankStyle() };
    let prev = null;
    let lastRound = 0;
    let header = null;
    let end = null;
    let baseSlugs = null;
    let maxRound = 0;
    for (const line of lines) {
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.t === 'header') { header = o; continue; }
        if (o.t === 'end') { end = o; continue; }
        if (o.t !== 'step' || !o.state) continue;
        const s = o.state;
        if (!baseSlugs) baseSlugs = { p1: slug(s.players.p1.base.n), p2: slug(s.players.p2.base.n) };
        maxRound = Math.max(maxRound, s.round);
        if (s.phase === 'action' && s.round > lastRound) {
            lastRound = s.round;
            for (const pid of ['p1', 'p2']) snaps.push({ pid, round: s.round, step: o.n, x: view(s, pid) });
        }
        const pid = o.pid;
        if (pid && prev && o.action) {
            const opp = pid === 'p1' ? 'p2' : 'p1';
            const a = o.action;
            const c = st[pid];
            if (o.prompt && o.prompt.startsWith('actionWindow')) {
                c.windows++;
                if (a.kind === 'button' && a.label === 'Pass') c.passes++;
                if (a.kind === 'button' && a.label === 'Claim Initiative') c.initiative++;
            }
            if (/target for attack/i.test(o.title || '')) {
                c.attacks++;
                if (slug(a.label) === baseSlugs[opp]) c.baseAttacks++;
            }
            const before = sideOf(prev, opp);
            const after = sideOf(s, opp);
            c.baseDmg += Math.max(0, before.base - after.base);
            c.kills += Math.max(0, before.units - after.units);
            const mineBefore = sideOf(prev, pid).units;
            const mineAfter = sideOf(s, pid).units;
            c.deploys += Math.max(0, mineAfter - mineBefore);
        }
        prev = s;
    }
    return { header, end, snaps, style: st, rounds: Math.max(1, maxRound) };
}

function styleOf(rows) {
    const style = {};
    for (const S of STYLE) {
        const v = rows.map((s) => s[S.id]).filter((x) => x != null);
        style[S.id] = v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null;
    }
    return style;
}

function styleRow(bot, won, c, rounds) {
    return {
        bot, won,
        baseDmg: c.baseDmg / rounds, attacks: c.attacks / rounds, kills: c.kills / rounds, deploys: c.deploys / rounds,
        initiative: c.initiative / rounds, rounds,
        baseShare: c.attacks ? c.baseAttacks / c.attacks : null,
        passShare: c.windows ? c.passes / c.windows : null,
    };
}

function blankStyle() {
    return { windows: 0, passes: 0, initiative: 0, attacks: 0, baseAttacks: 0, baseDmg: 0, kills: 0, deploys: 0 };
}

// ---------------------------------------------------------------------------------------------- baseline model

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const FEATURES = ['baseLead', 'boardLead', 'hpLead', 'handLead', 'resLead', 'initiative', 'rd'];

/** Logistic regression by plain gradient descent on standardized features. Small data, so this is fast enough. */
function fitLogistic(rows) {
    if (!rows.length) return { predict: () => 0.5, coef: Object.fromEntries(FEATURES.map((f) => [f, 0])), intercept: 0 };
    const k = FEATURES.length;
    const mu = FEATURES.map((f) => rows.reduce((s, r) => s + r.x[f], 0) / rows.length);
    const sd = FEATURES.map((f, j) => Math.sqrt(rows.reduce((s, r) => s + (r.x[f] - mu[j]) ** 2, 0) / rows.length) || 1);
    const w = new Array(k).fill(0);
    let b = 0;
    const lr = 0.5;
    const l2 = 1e-3;
    for (let it = 0; it < 400; it++) {
        const g = new Array(k).fill(0);
        let gb = 0;
        for (const r of rows) {
            let z = b;
            for (let j = 0; j < k; j++) z += w[j] * (r.x[FEATURES[j]] - mu[j]) / sd[j];
            const e = sigmoid(z) - r.y;
            gb += e;
            for (let j = 0; j < k; j++) g[j] += e * (r.x[FEATURES[j]] - mu[j]) / sd[j];
        }
        b -= lr * gb / rows.length;
        for (let j = 0; j < k; j++) w[j] -= lr * (g[j] / rows.length + l2 * w[j]);
    }
    const predict = (x) => {
        let z = b;
        for (let j = 0; j < k; j++) z += w[j] * (x[FEATURES[j]] - mu[j]) / sd[j];
        return sigmoid(z);
    };
    return { predict, coef: Object.fromEntries(FEATURES.map((f, j) => [f, +(w[j] / sd[j]).toFixed(4)])), intercept: b };
}

// ---------------------------------------------------------------------------------------------- main

function readJson(f, fallback) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}

function main() {
    const t0 = Date.now();
    const runs = [];
    for (const dir of fs.readdirSync(RESULTS).sort()) {
        if (dir.startsWith('_')) continue;
        const idx = readJson(path.join(RESULTS, dir, 'index.json'), null);
        if (!idx || !Array.isArray(idx.games)) continue;
        const names = new Set(idx.bots || idx.games.flatMap((g) => [g.p1, g.p2]));
        const cfg = readJson(path.join(RESULTS, dir, 'ladder.json'), {}).config || {};
        runs.push({ id: dir, createdAt: idx.createdAt, idx, fixedEra: isFixedEra(dir, idx, cfg, names) });
    }

    // 1. Results (all runs, replay or not).
    const games = [];
    const skipped = {};
    for (const run of runs) {
        for (const g of run.idx.games) {
            const p1 = canonical(g.p1, run);
            const p2 = canonical(g.p2, run);
            let winner = null;
            let forfeit = null;
            if (g.outcome === 'won' && g.winnerSeat) winner = g.winnerSeat;
            else if (g.outcome === 'ERROR' && /^TIME_FORFEIT (\S+)/.test(g.error || '')) {
                const who = canonical(RegExp.$1, run);
                winner = who === p1 ? 'p2' : 'p1';
                forfeit = who === p1 ? 'p1' : 'p2';
            } else if (g.outcome === 'ERROR' && (g.by === 'p1' || g.by === 'p2')) {
                // Protocol v2: any bot failure (late, malformed or illegal reply, crash) ends the game as ERROR with
                // `by` = the failing seat, and the other seat wins (spec/MIGRATION.md).
                forfeit = g.by;
                winner = g.by === 'p1' ? 'p2' : 'p1';
            } else {
                skipped[g.outcome] = (skipped[g.outcome] || 0) + 1;
                continue;
            }
            const replay = path.join(RESULTS, run.id, 'games', `${g.id}.jsonl`);
            games.push({
                run: run.id, id: g.id, p1, p2, winner, forfeit, rounds: g.rounds, timing: g.timing || null,
                replay: fs.existsSync(replay) && !forfeit ? replay : null,
            });
        }
    }
    const botIds = [...new Set(games.flatMap((g) => [g.p1, g.p2]))].sort();

    // Human games: <HUMAN>/<source>/index.json + games/<id>.jsonl, written by importer/import.js. Players are
    // anonymous seats, and humans only play humans, so they stay out of the ratings and the baseline fit and are
    // scored as one competitor, "humans", against the bots' baseline.
    const humanGames = [];
    const humanSources = [];
    let humanDirs = [];
    try { humanDirs = fs.readdirSync(HUMAN).sort(); } catch { /* no human games folder */ }
    for (const dir of humanDirs) {
        const idx = readJson(path.join(HUMAN, dir, 'index.json'), null);
        if (!idx || !Array.isArray(idx.games)) continue;
        const src = { source: dir, createdAt: idx.createdAt || null, games: idx.games.length, credit: null, url: null };
        humanSources.push(src);
        for (const g of idx.games) {
            if (g.outcome !== 'won' || !g.winnerSeat) continue;
            const replay = path.join(HUMAN, dir, 'games', `${g.id}.jsonl`);
            if (!fs.existsSync(replay)) continue;
            humanGames.push({ run: dir, root: 'human-games', id: g.id, winner: g.winnerSeat, replay });
            // Public games must show their source's credit wherever their data appears (human-games/README.md).
            if (!src.credit) {
                let head = null;
                try { head = JSON.parse(fs.readFileSync(replay, 'utf8').split('\n', 1)[0]); } catch { /* unreadable header */ }
                const so = head && head.source;
                if (so && so.credit) { src.credit = so.credit; src.url = siteOf(so.url); }
            }
        }
    }

    // 2. Strength: Bradley-Terry on every decided game.
    const results = games.map((g) => ({ a: g.p1, b: g.p2, score: g.winner === 'p1' ? 1 : 0 }));
    const rating = bradleyTerry(botIds, results, { prior: 1 });
    const seatGames = games.length;
    const p1Wins = games.filter((g) => g.winner === 'p1').length;

    // 3. Replays: snapshots and style.
    const snapRows = []; // one per (game, player, round start)
    const styleRows = []; // one per (game, player)
    const cache = CACHE ? readJson(CACHE, {}) : {};
    const fresh = {};
    const unreadable = []; // a replay that throws is skipped, but said out loud: a silent skip once hid a reader bug
    for (const g of games) {
        if (!g.replay) continue;
        let r;
        try {
            const st = fs.statSync(g.replay);
            const key = `${g.replay}|${st.size}|${st.mtimeMs}`;
            r = cache[key] || readReplay(g.replay);
            delete r.header;
            fresh[key] = r;
        } catch (e) { unreadable.push(`${g.replay}: ${e.message}`); continue; }
        if (!r.end) continue; // still being written
        for (const pid of ['p1', 'p2']) {
            const bot = pid === 'p1' ? g.p1 : g.p2;
            const opp = pid === 'p1' ? g.p2 : g.p1;
            const won = g.winner === pid ? 1 : 0;
            const c = r.style[pid];
            const rounds = r.rounds;
            styleRows.push(styleRow(bot, won, c, rounds));
            for (const s of r.snaps.filter((q) => q.pid === pid)) {
                const rd = (rating[bot] - rating[opp]) / 400 * Math.LN10;
                snapRows.push({ game: g, pid, bot, opp, won, round: s.round, step: s.step, x: { ...s.x, rd } });
            }
        }
    }

    const humanSnaps = [];
    const humanStyle = [];
    for (const g of humanGames) {
        let r;
        try {
            const st = fs.statSync(g.replay);
            const key = `${g.replay}|${st.size}|${st.mtimeMs}`;
            r = cache[key] || readReplay(g.replay);
            delete r.header;
            fresh[key] = r;
        } catch (e) { unreadable.push(`${g.replay}: ${e.message}`); continue; }
        if (!r.end) continue;
        for (const pid of ['p1', 'p2']) {
            const won = g.winner === pid ? 1 : 0;
            humanStyle.push(styleRow('humans', won, r.style[pid], r.rounds));
            for (const s of r.snaps.filter((q) => q.pid === pid)) humanSnaps.push({ game: g, pid, bot: 'humans', opp: 'humans', won, round: s.round, step: s.step, x: { ...s.x, rd: 0 } });
        }
    }

    if (unreadable.length) console.warn(`meta: ${unreadable.length} replays could not be read, e.g. ${unreadable[0]}`);
    if (CACHE) { fs.writeFileSync(CACHE + '.tmp', JSON.stringify(fresh)); fs.renameSync(CACHE + '.tmp', CACHE); }

    // 4. Baseline: P(win | position, rating gap). Everything below is measured against it.
    const model = fitLogistic(snapRows.map((r) => ({ x: r.x, y: r.won })));

    // 5. Situations per bot: first entry per game and player.
    const sit = {}; // bot -> sid -> {n, wins, exp, examples}
    const fieldSit = {};
    const seen = new Set();
    for (const r of snapRows) {
        for (const S of SITUATIONS) {
            const key = `${r.game.run}/${r.game.id}/${r.pid}/${S.id}`;
            if (seen.has(key) || !S.test(r.x)) continue;
            seen.add(key);
            // e: with the bot's own rating (model misfit check). eAvg: an average-rated bot (1500) in the same
            // spot against the same opponent; the cell edge is measured against this one.
            const e = model.predict(r.x);
            const eAvg = model.predict({ ...r.x, rd: (1500 - rating[r.opp]) / 400 * Math.LN10 });
            const b = ((sit[r.bot] ||= {})[S.id] ||= { n: 0, wins: 0, exp: 0, expAvg: 0, examples: [] });
            b.n++; b.wins += r.won; b.exp += e; b.expAvg += eAvg;
            b.examples.push({ run: r.game.run, game: r.game.id, step: r.step, seat: r.pid, opp: r.opp, won: r.won, surprise: +(r.won - e).toFixed(3) });
            const f = (fieldSit[S.id] ||= { n: 0, wins: 0 });
            f.n++; f.wins += r.won;
        }
    }

    // 6. Per-bot summaries.
    const metaBots = readJson(BOTS_META, { bots: [] }).bots;
    const cardFamily = {};
    for (const f of fs.existsSync(CARDS) ? fs.readdirSync(CARDS).filter((x) => x.endsWith('.json')) : []) {
        const c = readJson(path.join(CARDS, f), null);
        if (c && c.id && c.family) for (const name of [c.id, ...(c.aliases || [])]) cardFamily[name] = c.family;
    }
    const panels = {};
    try {
        for (const f of fs.readdirSync(PANELS)) {
            const p = readJson(path.join(PANELS, f), null);
            // A panel describes its own bots; arena panels also list their opponents, so only the first-listed bot
            // or a bot named like the panel takes its summary.
            if (p && Array.isArray(p.bots) && !/leaderboard/.test(p.id)) {
                p.bots.forEach((b, i) => {
                    const own = i === 0 || b.startsWith(p.id) || p.id.startsWith(b.split('-')[0]) && !/^arena-/.test(p.id);
                    if (own) panels[b] ||= { id: p.id, title: p.title, summary: p.mentalModel && p.mentalModel.summary };
                });
            }
        }
    } catch { /* no panels folder */ }

    // Field residual per situation: the baseline is linear, so it is a little off in the tails (every bot looks
    // good "ahead" and bad "behind"). Subtracting the field's mean residual makes each cell read as
    // "compared with the other bots in the same spot".
    const fieldResid = {};
    for (const S of SITUATIONS) {
        let n = 0, r = 0;
        for (const id of botIds) { const b = sit[id] && sit[id][S.id]; if (b) { n += b.n; r += b.wins - b.exp; } }
        fieldResid[S.id] = n ? r / n : 0;
    }
    const SHRINK = 4; // virtual games at the expected rate, so 2-game cells do not shout
    const cellsOf = (byS) => Object.fromEntries(SITUATIONS.map((S) => {
        const b = byS[S.id];
        if (!b) return [S.id, { n: 0 }];
        const ex = b.examples.sort((p, q) => Math.abs(q.surprise) - Math.abs(p.surprise));
        return [S.id, {
            n: b.n, wins: b.wins, rate: +(b.wins / b.n).toFixed(3), expected: +(b.expAvg / b.n).toFixed(3),
            edge: +((b.wins - b.expAvg - b.n * fieldResid[S.id]) / (b.n + SHRINK)).toFixed(3),
            vsOwn: +((b.wins - b.exp - b.n * fieldResid[S.id]) / (b.n + SHRINK)).toFixed(3),
            se: +(0.5 / Math.sqrt(b.n + SHRINK)).toFixed(3),
            examples: [...ex.filter((e) => e.won).slice(0, 2), ...ex.filter((e) => !e.won).slice(0, 2)],
        }];
    }));
    const bots = botIds.map((id) => {
        const mine = games.filter((g) => g.p1 === id || g.p2 === id);
        const wins = mine.filter((g) => (g.p1 === id ? 'p1' : 'p2') === g.winner).length;
        const forfeits = mine.filter((g) => g.forfeit && (g.forfeit === 'p1' ? g.p1 : g.p2) === id).length;
        const sr = styleRows.filter((s) => s.bot === id);
        const style = styleOf(sr);
        const ms = [];
        for (const g of mine) {
            const t = g.timing && g.timing[g.p1 === id ? 'p1' : 'p2'];
            if (t && t.p50 != null) ms.push(t.p50);
        }
        ms.sort((a, b) => a - b);
        const situations = cellsOf(sit[id] || {});
        const m = metaBots.find((b) => b.id === id) || metaBots.find((b) => b.id === id.replace(/^legacy-/, '')) || {};
        return {
            id, family: cardFamily[id] || cardFamily[id.replace(/^legacy-/, '')] || (m.family && m.family !== 'other' ? m.family : guessFamily(id)), lang: m.lang || 'js', owner: m.owner || null, notes: m.notes || null,
            panel: panels[id] || panels[id.replace(/^legacy-/, '')] || null,
            rating: Math.round(rating[id]), games: mine.length, wins, winRate: +(wins / mine.length).toFixed(3), forfeits,
            replayGames: sr.length, msP50: ms.length ? +ms[Math.floor(ms.length / 2)].toFixed(2) : null,
            style, situations,
        };
    }).sort((a, b) => b.rating - a.rating);
    describe(bots);

    // 6b. Humans as one competitor, scored like an average bot facing an equal opponent (rd 0), so a human cell
    // reads "humans win from this spot this much more than an average bot would".
    let humans = null;
    if (humanSnaps.length) {
        const hs = {};
        const hseen = new Set();
        for (const r of humanSnaps) {
            for (const S of SITUATIONS) {
                const key = `${r.game.run}/${r.game.id}/${r.pid}/${S.id}`;
                if (hseen.has(key) || !S.test(r.x)) continue;
                hseen.add(key);
                const e = model.predict(r.x);
                const b = (hs[S.id] ||= { n: 0, wins: 0, exp: 0, expAvg: 0, examples: [] });
                b.n++; b.wins += r.won; b.exp += e; b.expAvg += e;
                b.examples.push({ root: 'human-games', run: r.game.run, game: r.game.id, step: r.step, seat: r.pid, opp: 'humans', won: r.won, surprise: +(r.won - e).toFixed(3) });
            }
        }
        humans = {
            id: 'humans', family: 'human', lang: null, owner: null, notes: 'Real karabast.net games, players anonymous',
            panel: null, rating: null, games: humanGames.length, wins: null, winRate: null, forfeits: 0,
            replayGames: humanStyle.length, msP50: null, style: styleOf(humanStyle), situations: cellsOf(hs),
        };
        describe([humans], bots);
    }

    // 7. Head to head.
    const pairs = {};
    for (const g of games) {
        const [a, b] = [g.p1, g.p2].sort();
        const p = (pairs[`${a}|${b}`] ||= { a, b, games: 0, aWins: 0 });
        p.games++;
        if ((g.winner === 'p1' ? g.p1 : g.p2) === a) p.aWins++;
    }

    // Field style ranges for normalizing glyphs.
    const styleRange = {};
    for (const S of STYLE) {
        const v = bots.map((b) => b.style[S.id]).filter((x) => x != null);
        styleRange[S.id] = { min: Math.min(...v), max: Math.max(...v), mean: v.reduce((a, b) => a + b, 0) / v.length };
    }

    const out = {
        schema: 'swu-meta/1',
        generatedAt: new Date().toISOString(),
        sources: runs.map((r) => ({ run: r.id, createdAt: r.createdAt, games: r.idx.games.length, fixedEra: r.fixedEra })),
        totals: { games: games.length, replays: styleRows.length / 2, snapshots: snapRows.length, humanGames: humanGames.length, skipped, p1WinRate: +(p1Wins / seatGames).toFixed(3) },
        baseline: { features: FEATURES, coef: model.coef, note: 'P(win) from position at round start plus rating gap (rd, natural-log units)' },
        situations: SITUATIONS.map(({ test, ...s }) => ({ ...s, fieldResid: +fieldResid[s.id].toFixed(3), field: fieldSit[s.id] ? { n: fieldSit[s.id].n, rate: +(fieldSit[s.id].wins / fieldSit[s.id].n).toFixed(3) } : { n: 0 } })),
        style: STYLE.map((s) => ({ ...s, range: styleRange[s.id] })),
        bots,
        humans,
        humanSources,
        pairs: Object.values(pairs),
        ms: Date.now() - t0,
    };
    fs.writeFileSync(OUT + '.tmp', JSON.stringify(out));
    fs.renameSync(OUT + '.tmp', OUT);
    writeRatings(botIds, results, rating, out.generatedAt);
    console.log(`meta: ${bots.length} bots, ${games.length} games, ${out.totals.replays} replays, ${snapRows.length} snapshots, ${humanGames.length} human games in ${out.ms} ms -> ${OUT}`);
}

/**
 * ratings.json: every bot's Atlas rating (canonical names, Bradley-Terry on decided games, forfeits count as losses),
 * mapped or not, so the app, console, arena and Atlas show one number. se is the rating's standard error in rating
 * points (from the Bradley-Terry Fisher information, the prior included).
 */
function writeRatings(ids, results, rating, generatedAt) {
    const g = Object.fromEntries(ids.map((id) => [id, Math.pow(10, (rating[id] - 1500) / 400)]));
    const info = Object.fromEntries(ids.map((id) => [id, g[id] / (g[id] + 1) ** 2])); // the prior's virtual game
    const games = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const r of results) {
        const v = g[r.a] * g[r.b] / (g[r.a] + g[r.b]) ** 2;
        info[r.a] += v; info[r.b] += v; games[r.a]++; games[r.b]++;
    }
    const bots = Object.fromEntries([...ids].sort((a, b) => rating[b] - rating[a]).map((id) => [id, {
        rating: Math.round(rating[id]), se: Math.round(400 / Math.LN10 / Math.sqrt(info[id])), games: games[id],
    }]));
    const doc = { schema: 'swu-ratings/1', generatedAt, rules: 'Strategy Atlas: canonical names (pre-fix heuristic = legacy), Bradley-Terry with prior 1, decided games only, forfeits are losses', bots };
    fs.writeFileSync(RATINGS + '.tmp', JSON.stringify(doc, null, 1));
    fs.renameSync(RATINGS + '.tmp', RATINGS);
}

/** Short plain-words summary per bot, used by the page and as the answer key for visual review quizzes. */
function describe(bots, field = bots) {
    const MIN = 5;
    const pct = (key, q) => {
        const v = field.filter((b) => b.replayGames >= MIN && b.style[key] != null).map((b) => b.style[key]).sort((a, b) => a - b);
        return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : 0;
    };
    const killsHi = pct('kills', 0.66);
    const dmgHi = pct('baseDmg', 0.66);
    const dmgLo = pct('baseDmg', 0.33);
    for (const b of bots) {
        if (b.replayGames < MIN) { b.summary = { style: null, best: null, worst: null, groups: null }; continue; }
        const s = b.style;
        let style = 'Balanced';
        if (b.family === 'random') style = 'Random';
        else if (s.baseShare >= 0.8 && s.baseDmg >= dmgHi) style = 'Racer';
        else if (s.kills >= killsHi && s.baseDmg >= dmgHi) style = 'Bruiser';
        else if (s.kills >= killsHi && s.baseShare < 0.6) style = 'Controller';
        else if (s.baseDmg <= dmgLo) style = 'Cautious';
        const groups = {};
        for (const S of SITUATIONS) {
            const c = b.situations[S.id];
            if (!c.n) continue;
            const g = (groups[S.group] ||= { n: 0, w: 0 });
            g.n += c.n; g.w += c.edge * c.n;
        }
        for (const g of Object.values(groups)) g.edge = +(g.w / g.n).toFixed(3);
        // Best and worst spots are relative to the bot's own level (vsOwn), so a strong bot still has a weak spot.
        const cells = SITUATIONS.map((S) => ({ id: S.id, ...b.situations[S.id] })).filter((c) => c.n >= MIN);
        cells.sort((p, q) => q.vsOwn - p.vsOwn);
        b.summary = {
            style,
            best: cells.length ? { id: cells[0].id, edge: cells[0].edge, vsOwn: cells[0].vsOwn } : null,
            worst: cells.length ? { id: cells[cells.length - 1].id, edge: cells[cells.length - 1].edge, vsOwn: cells[cells.length - 1].vsOwn } : null,
            groups: Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, { n: g.n, edge: g.edge }])),
        };
    }
}

function guessFamily(id) {
    if (/-v\d+$/.test(id)) return 'other'; // arena entrants
    if (/random/.test(id)) return 'random';
    if (/ismcts|omni|search/.test(id)) return 'search';
    if (/learned/.test(id)) return 'learned';
    if (/jev|llm/.test(id)) return 'llm';
    return 'heuristic';
}

if (require.main === module) main();

module.exports = { readReplay, view, canonical, SITUATIONS, STYLE, fitLogistic };
