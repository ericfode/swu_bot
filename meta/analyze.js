'use strict';

/**
 * Meta-analyzer: reads every recorded tournament under a results folder and writes one JSON model of
 * each strategy's traits (strength, style, and where it wins or loses relative to expectation).
 *
 *   node meta/analyze.js [--results /mnt/project-files/results] [--out meta.json] [--panels dir] [--bots bots.json]
 *
 * Pure reading: no engine, no card data. Replays are the recorder JSONL format (bot/recorder.js).
 */

const fs = require('fs');
const path = require('path');
const { bradleyTerry } = require('../bot/ratings');

const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const RESULTS = args.results || '/mnt/project-files/results';
const OUT = args.out || 'meta.json';
const PANELS = args.panels || '/mnt/project-files/dashboard/panels';
const BOTS_META = args.bots || '/mnt/project-files/dashboard/league/bots.json';
const CACHE = args.cache || null; // replay features keyed by path, size and mtime, so refreshes only read new games

// ---------------------------------------------------------------------------------------------- identities

/**
 * Bot names are the p1/p2 strings in each index. A few names mean the same bot (random-a/b/c are seeds of one
 * random bot; `legacy` is the heuristic bot before the base-danger sign fix). Runs that list `legacy` are the
 * ones with the fixed heuristic profiles, so those profiles get a `+fix` suffix there.
 */
const HEURISTIC_PROFILES = new Set(['heuristic', 'aggro', 'tempo', 'control']);
function canonical(name, run) {
    if (/^random(-[a-z])?$/.test(name)) return 'random';
    if (name === 'legacy') return 'heuristic';
    if (run.fixedEra && HEURISTIC_PROFILES.has(name)) return `${name}+fix`;
    return name;
}

// ---------------------------------------------------------------------------------------------- situations

/**
 * A situation is a predicate on a round-start snapshot, from one player's point of view. A game "enters" a
 * situation at the first round start where it holds; the player's result in that game is scored against the
 * baseline expectation at that moment.
 */
const SITUATIONS = [
    { id: 'base_behind', group: 'Behind', label: 'Base behind', short: 'your base 5+ HP lower', test: (x) => x.round >= 2 && x.baseLead <= -5 },
    { id: 'board_behind', group: 'Behind', label: 'Board behind', short: '4+ less power on board', test: (x) => x.round >= 2 && x.boardLead <= -4 },
    { id: 'low_base', group: 'Behind', label: 'Near death', short: 'your base at 8 HP or less', test: (x) => x.myBase <= 8 },
    { id: 'cards_behind', group: 'Behind', label: 'Fewer cards', short: '2+ fewer cards in hand', test: (x) => x.round >= 2 && x.handLead <= -2 },
    { id: 'close_mid', group: 'Even', label: 'Close at R4', short: 'even at round 4', test: (x) => x.round === 4 && Math.abs(x.baseLead) <= 3 && Math.abs(x.boardLead) <= 3 },
    { id: 'long_game', group: 'Even', label: 'Long game', short: 'round 8 or later', test: (x) => x.round >= 8 },
    { id: 'base_ahead', group: 'Ahead', label: 'Base ahead', short: 'your base 5+ HP higher', test: (x) => x.round >= 2 && x.baseLead >= 5 },
    { id: 'board_ahead', group: 'Ahead', label: 'Board ahead', short: '4+ more power on board', test: (x) => x.round >= 2 && x.boardLead >= 4 },
    { id: 'kill_range', group: 'Ahead', label: 'Lethal range', short: 'their base at 8 HP or less', test: (x) => x.oppBase <= 8 },
];

/** Style traits measured from replays: per game, then averaged per bot. `dir` says which end reads as "more". */
const STYLE = [
    { id: 'baseDmg', label: 'Base damage / round', fmt: 'num' },
    { id: 'baseShare', label: 'Attacks at base', fmt: 'pct' },
    { id: 'attacks', label: 'Attacks / round', fmt: 'num' },
    { id: 'kills', label: 'Units killed / round', fmt: 'num' },
    { id: 'deploys', label: 'Units added / round', fmt: 'num' },
    { id: 'passShare', label: 'Passes', fmt: 'pct' },
    { id: 'initiative', label: 'Initiative claims / round', fmt: 'num' },
    { id: 'rounds', label: 'Game length (rounds)', fmt: 'num' },
];

// ---------------------------------------------------------------------------------------------- replay features

const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

function sideOf(state, pid) {
    const p = state.players[pid];
    const units = [...p.ground, ...p.space];
    return {
        base: p.base.hp - p.base.d,
        power: units.reduce((s, u) => s + (u.p || 0), 0),
        hpLeft: units.reduce((s, u) => s + Math.max(0, (u.h || 0) - (u.d || 0)), 0),
        units: units.length,
        hand: p.hand.length,
        res: p.res.total,
    };
}

function view(state, pid) {
    const opp = pid === 'p1' ? 'p2' : 'p1';
    const me = sideOf(state, pid);
    const them = sideOf(state, opp);
    return {
        round: state.round,
        myBase: me.base,
        oppBase: them.base,
        baseLead: me.base - them.base,
        boardLead: me.power - them.power,
        hpLead: me.hpLeft - them.hpLeft,
        handLead: me.hand - them.hand,
        resLead: me.res - them.res,
        initiative: state.initiative === pid ? 1 : 0,
    };
}

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

function blankStyle() {
    return { windows: 0, passes: 0, initiative: 0, attacks: 0, baseAttacks: 0, baseDmg: 0, kills: 0, deploys: 0 };
}

// ---------------------------------------------------------------------------------------------- baseline model

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const FEATURES = ['baseLead', 'boardLead', 'hpLead', 'handLead', 'resLead', 'initiative', 'rd'];

/** Logistic regression by plain gradient descent on standardized features. Small data, so this is fast enough. */
function fitLogistic(rows) {
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
        runs.push({ id: dir, createdAt: idx.createdAt, idx, fixedEra: names.has('legacy') });
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
    for (const g of games) {
        if (!g.replay) continue;
        let r;
        try {
            const st = fs.statSync(g.replay);
            const key = `${g.replay}|${st.size}|${st.mtimeMs}`;
            r = cache[key] || readReplay(g.replay);
            delete r.header;
            fresh[key] = r;
        } catch { continue; }
        if (!r.end) continue; // still being written
        for (const pid of ['p1', 'p2']) {
            const bot = pid === 'p1' ? g.p1 : g.p2;
            const opp = pid === 'p1' ? g.p2 : g.p1;
            const won = g.winner === pid ? 1 : 0;
            const c = r.style[pid];
            const rounds = r.rounds;
            styleRows.push({
                bot, won,
                baseDmg: c.baseDmg / rounds, attacks: c.attacks / rounds, kills: c.kills / rounds, deploys: c.deploys / rounds,
                initiative: c.initiative / rounds, rounds,
                baseShare: c.attacks ? c.baseAttacks / c.attacks : null,
                passShare: c.windows ? c.passes / c.windows : null,
            });
            for (const s of r.snaps.filter((q) => q.pid === pid)) {
                const rd = (rating[bot] - rating[opp]) / 400 * Math.LN10;
                snapRows.push({ game: g, pid, bot, opp, won, round: s.round, step: s.step, x: { ...s.x, rd } });
            }
        }
    }

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
    const bots = botIds.map((id) => {
        const mine = games.filter((g) => g.p1 === id || g.p2 === id);
        const wins = mine.filter((g) => (g.p1 === id ? 'p1' : 'p2') === g.winner).length;
        const forfeits = mine.filter((g) => g.forfeit && (g.forfeit === 'p1' ? g.p1 : g.p2) === id).length;
        const sr = styleRows.filter((s) => s.bot === id);
        const style = {};
        for (const S of STYLE) {
            const v = sr.map((s) => s[S.id]).filter((x) => x != null);
            style[S.id] = v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null;
        }
        const ms = [];
        for (const g of mine) {
            const t = g.timing && g.timing[g.p1 === id ? 'p1' : 'p2'];
            if (t && t.p50 != null) ms.push(t.p50);
        }
        ms.sort((a, b) => a - b);
        const situations = {};
        for (const S of SITUATIONS) {
            const b = sit[id] && sit[id][S.id];
            if (!b) { situations[S.id] = { n: 0 }; continue; }
            const ex = b.examples.sort((p, q) => Math.abs(q.surprise) - Math.abs(p.surprise));
            situations[S.id] = {
                n: b.n, wins: b.wins, rate: +(b.wins / b.n).toFixed(3), expected: +(b.expAvg / b.n).toFixed(3),
                edge: +((b.wins - b.expAvg - b.n * fieldResid[S.id]) / (b.n + SHRINK)).toFixed(3),
                vsOwn: +((b.wins - b.exp - b.n * fieldResid[S.id]) / (b.n + SHRINK)).toFixed(3),
                se: +(0.5 / Math.sqrt(b.n + SHRINK)).toFixed(3),
                examples: [...ex.filter((e) => e.won).slice(0, 2), ...ex.filter((e) => !e.won).slice(0, 2)],
            };
        }
        const m = metaBots.find((b) => b.id === id) || metaBots.find((b) => b.id === id.replace(/\+fix$/, '')) || {};
        return {
            id, family: m.family && m.family !== 'other' ? m.family : guessFamily(id), lang: m.lang || 'js', owner: m.owner || null, notes: m.notes || null,
            panel: panels[id] || panels[id.replace(/\+fix$/, '')] || null,
            rating: Math.round(rating[id]), games: mine.length, wins, winRate: +(wins / mine.length).toFixed(3), forfeits,
            replayGames: sr.length, msP50: ms.length ? +ms[Math.floor(ms.length / 2)].toFixed(2) : null,
            style, situations,
        };
    }).sort((a, b) => b.rating - a.rating);
    describe(bots);

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
        totals: { games: games.length, replays: styleRows.length / 2, snapshots: snapRows.length, skipped, p1WinRate: +(p1Wins / seatGames).toFixed(3) },
        baseline: { features: FEATURES, coef: model.coef, note: 'P(win) from position at round start plus rating gap (rd, natural-log units)' },
        situations: SITUATIONS.map(({ test, ...s }) => ({ ...s, fieldResid: +fieldResid[s.id].toFixed(3), field: fieldSit[s.id] ? { n: fieldSit[s.id].n, rate: +(fieldSit[s.id].wins / fieldSit[s.id].n).toFixed(3) } : { n: 0 } })),
        style: STYLE.map((s) => ({ ...s, range: styleRange[s.id] })),
        bots,
        pairs: Object.values(pairs),
        ms: Date.now() - t0,
    };
    fs.writeFileSync(OUT + '.tmp', JSON.stringify(out));
    fs.renameSync(OUT + '.tmp', OUT);
    console.log(`meta: ${bots.length} bots, ${games.length} games, ${out.totals.replays} replays, ${snapRows.length} snapshots in ${out.ms} ms -> ${OUT}`);
}

/** Short plain-words summary per bot, used by the page and as the answer key for visual review quizzes. */
function describe(bots) {
    const MIN = 5;
    const pct = (key, q) => {
        const v = bots.filter((b) => b.replayGames >= MIN && b.style[key] != null).map((b) => b.style[key]).sort((a, b) => a - b);
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
