'use strict';

/**
 * Do decks that win for humans also win for our bots? Real tournament deck lists, played by one bot against itself.
 *
 *   node analysis/realdeck/compare.js --runs <run dir>[,<run dir>...] --decks bot/decks/ash-meta-2026-09.json \
 *        --human bot/decks/ash-meta-2026-09.human.json [--online <human-summary.json or its dir>] [--out file.json] \
 *        [--permute 1000] [--min-games 10]
 *
 * A run is one `node bot/ladder.js --decks <file> --bots <bot>#a,<bot>#b` directory (index.json, ladder.json). Both
 * seats run the same bot, so the decks are what differs between games. A run is named by its bot ('#a' tags dropped).
 *
 * Games: only decided games count (winnerSeat p1 or p2; a draw counts half). Games that ended with ERROR, STEP_CAP,
 * STUCK or any other outcome are left out of every rate and model, but each deck reports them as `incomplete`: a deck
 * with a buggy card can lose games to engine errors, and that should stay visible. Games still running are ignored.
 *
 * Per run:
 *  1. Per deck: decided games, wins, win rate with a Wilson 95% CI, incomplete games, and a strength from one logistic
 *     model P(p1 wins) = σ(s[p1 deck] − s[p2 deck] + seat). Strengths get a small ridge (prior SD 1.4 logit, so a deck
 *     that never lost stays finite) and are centred; their SEs are for the centred value.
 *  2. Deck agreement with humans: bot strength (and bot win rate, as a centred logit) vs the human archetype game win
 *     rate (centred logit): Pearson with a Fisher-z 95% CI, tie-aware Spearman, and a one-sided permutation p-value
 *     that shuffles the human values across decks.
 *  3. Pair agreement: bot win rate of a over b (both seats pooled) vs the human cell for a over b, non-thin cells only:
 *     Pearson weighted by human games, and how often both pick the same favourite.
 *  4. Leader agreement with online play (--online, SWU Stats): decks pooled by leader vs the SWU Stats leader win rate.
 *  5. Reliability: even vs odd seeds (split-half, Spearman-Brown corrected), and run vs run when there are 2+ runs.
 *  6. By style (hyperaggro .. hardcontrol): pooled bot win rate vs the human mean of those decks.
 */

const fs = require('fs');
const path = require('path');
const { weightedCorr, ranks, humanStrength } = require('../swustats/compare');

const CREDIT_DECKS = 'Tournament deck lists and results: TCGEngine / SWU Stats (github.com/TCG-Engine/TCGEngine, MIT), from public melee.gg decklists';
const CREDIT_ONLINE = 'Online leader win rates: SWU Stats (swustats.net)';
const STYLES = ['hyperaggro', 'softaggro', 'midrange', 'softcontrol', 'hardcontrol'];
const RIDGE = 0.5; // 1/σ² on deck strengths, σ ≈ 1.4 logit: shrinks a deck with 500 games by well under 1%
const LOOSE = 0.01; // the seat term is almost free
const MIN_GAMES = 10; // decided games a deck (or leader) needs to enter a correlation
const NEAR = 0.02; // favourite agreement ignores win rates within 2 points of 50%
const ONLINE_MIN_PLAYS = 200; // the same cut as analysis/swustats (humanStrength)
const Z95 = 1.959964;

function parseArgs(argv) {
    const a = { runs: [], decks: null, human: null, online: null, out: null, permute: 1000, minGames: MIN_GAMES };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const value = () => {
            if (i + 1 >= argv.length) {
                throw new Error(`${k} needs a value`);
            }
            return argv[++i];
        };
        if (k === '--runs') {
            a.runs.push(...value().split(',').filter(Boolean));
        } else if (k === '--decks') {
            a.decks = value();
        } else if (k === '--human') {
            a.human = value();
        } else if (k === '--online') {
            a.online = value();
        } else if (k === '--out') {
            a.out = value();
        } else if (k === '--permute') {
            a.permute = Math.max(0, Math.floor(Number(value())) || 0);
        } else if (k === '--min-games') {
            a.minGames = Math.max(1, Math.floor(Number(value())) || 1);
        } else {
            throw new Error(`unknown option ${k}`);
        }
    }
    return a;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** 'c-clock#a', 'c-clock#b' -> 'c-clock'. Two different bots give 'x vs y' (then deck and bot effects can mix). */
function botName(entries) {
    const bases = [...new Set(entries.map((e) => String(e).replace(/#.*$/, '')))];
    return { bot: bases.join(' vs '), mirror: bases.length === 1 };
}

/**
 * One run directory. index.json is rewritten atomically after every game, so reading a run in progress is safe: it is
 * just a smaller run. ladder.json is optional (status, and the deck names the run was made with).
 */
function readRun(dir) {
    const index = readJson(path.join(dir, 'index.json'));
    let ladder = null;
    try {
        ladder = readJson(path.join(dir, 'ladder.json'));
    } catch {
        ladder = null;
    }
    const games = Array.isArray(index.games) ? index.games : [];
    const entries = index.bots ?? ladder?.config?.bots ?? [...new Set(games.flatMap((g) => [g.p1, g.p2]))];
    return {
        id: String(index.id ?? path.basename(path.resolve(dir))), dir, entries, ...botName(entries),
        status: ladder?.status ?? null, deckNames: ladder?.config?.decks?.names ?? null, games
    };
}

/** Deck file (array or {decks}) -> [{name, leader, base, style}] in file order. */
function deckMeta(raw) {
    const list = Array.isArray(raw) ? raw : raw?.decks;
    if (!Array.isArray(list) || !list.length) {
        throw new Error('deck file: expected a JSON array of deck lists');
    }
    return list.map((d, i) => ({
        name: String(d?.metadata?.name ?? `deck-${i}`), leader: d?.leader?.id ?? null, base: d?.base?.id ?? null,
        style: d?.metadata?.style ?? null
    }));
}

/**
 * Sort a run's index entries. decided: [{a, b, y, seed}] with a/b the deck index at p1/p2 and y P1's score (1, 0 or
 * ½). incomplete: finished games with no normal result. Games without known decks, or a deck against itself, are skipped.
 */
function sortGames(games, deckIndex) {
    const out = { decided: [], incomplete: [], running: 0, skipped: 0 };
    for (const g of games) {
        if (g.outcome === 'running') {
            out.running++;
            continue;
        }
        const a = deckIndex.get(g.decks?.p1);
        const b = deckIndex.get(g.decks?.p2);
        if (a === undefined || b === undefined || a === b) {
            out.skipped++;
            continue;
        }
        const seat = g.winnerSeat;
        if ((g.outcome ?? 'won') === 'won' && (seat === 'p1' || seat === 'p2' || seat === 'draw')) {
            out.decided.push({ a, b, y: seat === 'p1' ? 1 : seat === 'p2' ? 0 : 0.5, seed: g.seed });
        } else {
            out.incomplete.push({ a, b, outcome: String(g.outcome ?? 'unknown'), error: g.error ?? null });
        }
    }
    return out;
}

/** Wilson score interval for a rate; `score` may be fractional (draws count half). null with no games. */
function wilson(score, n, z = Z95) {
    if (!n) {
        return null;
    }
    const p = score / n;
    const d = 1 + (z * z) / n;
    const c = p + (z * z) / (2 * n);
    const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

/** Fisher-z 95% CI for a Pearson r on n points; null when n < 4 or r is null. */
function fisherCI(r, n, z = Z95) {
    if (r === null || r === undefined || n < 4) {
        return null;
    }
    const c = Math.min(Math.max(r, -0.999999), 0.999999);
    const f = Math.atanh(c);
    const h = z / Math.sqrt(n - 3);
    return [Math.tanh(f - h), Math.tanh(f + h)];
}

const logit = (p) => Math.log(p / (1 - p));
const clampRate = (p) => Math.min(Math.max(p, 1e-4), 1 - 1e-4);
const centred = (xs) => {
    const m = xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
    return xs.map((x) => x - m);
};

/** Deterministic shuffle (mulberry32), so the permutation test gives the same answer on every run. */
function shuffled(a, seed) {
    const out = [...a];
    let s = seed >>> 0;
    const rnd = () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let j = out.length - 1; j > 0; j--) {
        const k = Math.floor(rnd() * (j + 1));
        [out[j], out[k]] = [out[k], out[j]];
    }
    return out;
}

/** Inverse of a symmetric positive definite matrix (Gauss-Jordan with partial pivoting). */
function invert(A) {
    const n = A.length;
    const M = A.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) {
            if (Math.abs(M[r][c]) > Math.abs(M[p][c])) {
                p = r;
            }
        }
        [M[c], M[p]] = [M[p], M[c]];
        const d = M[c][c];
        for (let k = 0; k < 2 * n; k++) {
            M[c][k] /= d;
        }
        for (let r = 0; r < n; r++) {
            const f = M[r][c];
            if (r !== c && f) {
                for (let k = 0; k < 2 * n; k++) {
                    M[r][k] -= f * M[c][k];
                }
            }
        }
    }
    return M.map((row) => row.slice(n));
}

/**
 * Ridge logistic regression by Newton's method. rows: [{x: [[column, value]...], y}] with y in [0, 1] (½ for a draw).
 * Returns the weights and their covariance (inverse of the penalised Hessian).
 */
function fitLogistic(rows, dim, penalty) {
    const w = new Array(dim).fill(0);
    for (let it = 0; it < 100; it++) {
        const g = new Array(dim).fill(0);
        const H = Array.from({ length: dim }, () => new Array(dim).fill(0));
        for (const r of rows) {
            let z = 0;
            for (const [j, v] of r.x) {
                z += w[j] * v;
            }
            const p = 1 / (1 + Math.exp(-z));
            for (const [j, v] of r.x) {
                g[j] += (r.y - p) * v;
                for (const [k, u] of r.x) {
                    H[j][k] += p * (1 - p) * v * u;
                }
            }
        }
        for (let j = 0; j < dim; j++) {
            g[j] -= penalty[j] * w[j];
            H[j][j] += penalty[j];
        }
        const cov = invert(H);
        const step = cov.map((row) => row.reduce((s, v, k) => s + v * g[k], 0));
        step.forEach((d, j) => (w[j] += d));
        if (Math.max(0, ...step.map(Math.abs)) < 1e-9) {
            return { w, cov };
        }
    }
    throw new Error('the model did not converge');
}

/**
 * Deck strengths for K decks from decided games: P(p1 wins) = σ(s[a] − s[b] + seat). Strengths are centred over the
 * decks that played, and each SE is the SE of that centred value (the shift all decks share drops out). A deck with
 * no decided game gets null.
 */
function fitStrengths(decided, K, { ridge = RIDGE } = {}) {
    const played = new Array(K).fill(false);
    for (const g of decided) {
        played[g.a] = true;
        played[g.b] = true;
    }
    const idx = [...Array(K).keys()].filter((i) => played[i]);
    if (!decided.length) {
        return { strength: new Array(K).fill(null), se: new Array(K).fill(null), seat: null, seatSe: null };
    }
    const rows = decided.map((g) => ({ x: [[g.a, 1], [g.b, -1], [K, 1]], y: g.y }));
    const { w, cov } = fitLogistic(rows, K + 1, [...new Array(K).fill(ridge), LOOSE]);
    const m = idx.length;
    const mean = idx.reduce((s, i) => s + w[i], 0) / m;
    // Var(s_i − mean) = cov_ii − 2/m Σ_j cov_ij + 1/m² Σ_jk cov_jk, sums over the decks that played
    const rowSum = (i) => idx.reduce((s, j) => s + cov[i][j], 0);
    const total = idx.reduce((s, i) => s + rowSum(i), 0);
    const strength = new Array(K).fill(null);
    const se = new Array(K).fill(null);
    for (const i of idx) {
        strength[i] = w[i] - mean;
        se[i] = Math.sqrt(Math.max(0, cov[i][i] - (2 * rowSum(i)) / m + total / (m * m)));
    }
    return { strength, se, seat: w[K], seatSe: Math.sqrt(cov[K][K]) };
}

/** Per-deck tallies: decided games, wins, draws, losses, score (wins + draws/2), incomplete games by outcome. */
function deckTallies(sorted, K) {
    const rows = Array.from({ length: K }, () => ({ games: 0, wins: 0, draws: 0, losses: 0, score: 0, incomplete: 0, incompleteOutcomes: {} }));
    for (const g of sorted.decided) {
        for (const [d, y] of [[g.a, g.y], [g.b, 1 - g.y]]) {
            const r = rows[d];
            r.games++;
            r.score += y;
            if (y === 1) {
                r.wins++;
            } else if (y === 0) {
                r.losses++;
            } else {
                r.draws++;
            }
        }
    }
    for (const g of sorted.incomplete) {
        for (const d of [g.a, g.b]) {
            rows[d].incomplete++;
            rows[d].incompleteOutcomes[g.outcome] = (rows[d].incompleteOutcomes[g.outcome] ?? 0) + 1;
        }
    }
    return rows;
}

/** Least-squares slope of y on x; null without spread. */
function slope(xs, ys) {
    if (xs.length < 2) {
        return null;
    }
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
    const my = ys.reduce((s, y) => s + y, 0) / ys.length;
    let sxy = 0;
    let sxx = 0;
    xs.forEach((x, i) => {
        sxy += (x - mx) * (ys[i] - my);
        sxx += (x - mx) ** 2;
    });
    return sxx > 0 ? sxy / sxx : null;
}

/**
 * Agreement of bot values xs with human values ys (one point each): Pearson + Fisher CI, tie-aware Spearman, the
 * slope of bot on human, and with permute > 0 a one-sided permutation p-value for a positive association:
 * shuffle ys `permute` times, p = (k + 1) / (N + 1) with k the shuffles that reach the observed value.
 */
function agreement(xs, ys, { permute = 0, seed = 12345 } = {}) {
    const n = xs.length;
    const pearson = weightedCorr(xs, ys);
    const rx = ranks(xs);
    const spearman = weightedCorr(rx, ranks(ys));
    const out = { n, pearson, pearsonCI95: fisherCI(pearson, n), spearman, slopeBotPerHuman: slope(ys, xs) };
    if (permute > 0) {
        let kp = 0;
        let ks = 0;
        for (let i = 0; i < permute; i++) {
            const sh = shuffled(ys, seed + i);
            const p = weightedCorr(xs, sh);
            const s = weightedCorr(rx, ranks(sh));
            if (pearson !== null && p !== null && p >= pearson - 1e-12) {
                kp++;
            }
            if (spearman !== null && s !== null && s >= spearman - 1e-12) {
                ks++;
            }
        }
        out.permutationP = { pearson: pearson === null ? null : (kp + 1) / (permute + 1), spearman: spearman === null ? null : (ks + 1) / (permute + 1), shuffles: permute };
    }
    return out;
}

/** 2. Decks with enough decided games and a human rate: bot strength and bot win rate vs the human archetype rate. */
function deckAgreement(meta, tallies, fit, { minGames = MIN_GAMES, permute = 0 } = {}) {
    const use = meta.map((m, i) => i).filter((i) => tallies[i].games >= minGames && fit.strength[i] !== null && typeof meta[i].human?.gameWinPct === 'number');
    const human = centred(use.map((i) => logit(clampRate(meta[i].human.gameWinPct))));
    const botRate = centred(use.map((i) => logit((tallies[i].score + 0.5) / (tallies[i].games + 1))));
    return {
        n: use.length, minGames,
        strength: agreement(use.map((i) => fit.strength[i]), human, { permute }),
        winRate: agreement(botRate, human, { permute }),
        left: meta.filter((_, i) => !use.includes(i)).map((m) => m.name)
    };
}

/** One-sided sign test: P(X >= k) for X ~ Binomial(n, ½). */
function signTestP(k, n) {
    if (!n) {
        return null;
    }
    let pmf = 0.5 ** n;
    let tail = 0;
    for (let i = 0; i <= n; i++) {
        if (i >= k) {
            tail += pmf;
        }
        pmf *= (n - i) / (i + 1);
    }
    return Math.min(1, tail);
}

/**
 * 3. Per unordered deck pair: bot win rate of a over b (both seat orders pooled) vs the human cell a over b. Thin cells
 * (fewer than 10 human matches) and cells without a game win rate are left out. Weights are the human games behind
 * the cell's rate (wins + losses; the human rate leaves draws out). Favourite agreement ignores pairs where either
 * rate is within `near` of 50%.
 */
function pairAgreement(meta, decided, cells, { near = NEAR } = {}) {
    const K = meta.length;
    const tally = new Map();
    for (const g of decided) {
        const [i, j, y] = g.a < g.b ? [g.a, g.b, g.y] : [g.b, g.a, 1 - g.y];
        const t = tally.get(i * K + j) ?? { n: 0, score: 0 };
        t.n++;
        t.score += y;
        tally.set(i * K + j, t);
    }
    const list = [];
    const left = { thin: 0, noHuman: 0 };
    for (const [key, t] of [...tally].sort((p, q) => p[0] - q[0])) {
        const a = meta[Math.floor(key / K)].name;
        const b = meta[key % K].name;
        const cell = cells?.[a]?.[b];
        const humanGames = (cell?.games?.[0] ?? 0) + (cell?.games?.[1] ?? 0);
        if (!cell || typeof cell.gameWinPct !== 'number' || !humanGames) {
            left.noHuman++;
        } else if (cell.thin) {
            left.thin++;
        } else {
            list.push({ a, b, botGames: t.n, bot: t.score / t.n, human: cell.gameWinPct, humanGames });
        }
    }
    const xs = list.map((p) => p.bot);
    const ys = list.map((p) => p.human);
    const clear = list.filter((p) => Math.abs(p.bot - 0.5) > near + 1e-9 && Math.abs(p.human - 0.5) > near + 1e-9);
    const agree = clear.filter((p) => p.bot > 0.5 === p.human > 0.5).length;
    const games = list.map((p) => p.botGames).sort((p, q) => p - q);
    return {
        n: list.length, pairsPlayed: tally.size, left,
        pearsonWeighted: weightedCorr(xs, ys, list.map((p) => p.humanGames)),
        pearson: weightedCorr(xs, ys), spearman: weightedCorr(ranks(xs), ranks(ys)),
        favourite: { n: clear.length, agree, share: clear.length ? agree / clear.length : null, signTestP: signTestP(agree, clear.length), near },
        botGamesPerPair: games.length ? { min: games[0], median: games[Math.floor(games.length / 2)], max: games[games.length - 1] } : null,
        list
    };
}

/**
 * 4. Decks pooled by leader id (games-weighted mean strength) vs the SWU Stats online leader strength (centred logit
 * of the win rate, leaders with >= 200 plays; see analysis/swustats humanStrength).
 */
function leaderAgreement(meta, tallies, fit, online, { minGames = MIN_GAMES, permute = 0 } = {}) {
    const hs = humanStrength(online?.leaders ?? []);
    const byLeader = new Map();
    meta.forEach((m, i) => {
        if (!m.leader || !tallies[i].games || fit.strength[i] === null) {
            return;
        }
        const e = byLeader.get(m.leader) ?? { id: m.leader, decks: [], games: 0, sum: 0 };
        e.decks.push(m.name);
        e.games += tallies[i].games;
        e.sum += tallies[i].games * fit.strength[i];
        byLeader.set(m.leader, e);
    });
    const list = [...byLeader.values()].map((e) => {
        const h = hs.get(e.id);
        return { id: e.id, name: h?.name ?? null, decks: e.decks, games: e.games, strength: e.sum / e.games, online: h ? { winRate: h.winRate, plays: h.plays, logit: h.v } : null };
    });
    const use = list.filter((e) => e.games >= minGames && e.online);
    return { ...agreement(use.map((e) => e.strength), use.map((e) => e.online.logit), { permute }), minGames, minPlays: ONLINE_MIN_PLAYS, list };
}

/** 5a. Even vs odd seeds: two independent fits, correlated over decks with enough games in both halves. */
function splitHalf(decided, K, { minGames = MIN_GAMES, ridge = RIDGE } = {}) {
    const seeded = decided.filter((g) => Number.isInteger(g.seed));
    const halves = [seeded.filter((g) => g.seed % 2 === 0), seeded.filter((g) => g.seed % 2 !== 0)];
    const fits = halves.map((h) => fitStrengths(h, K, { ridge }));
    const counts = halves.map((h) => {
        const c = new Array(K).fill(0);
        for (const g of h) {
            c[g.a]++;
            c[g.b]++;
        }
        return c;
    });
    const need = Math.max(1, Math.ceil(minGames / 2));
    const use = [...Array(K).keys()].filter((i) => counts[0][i] >= need && counts[1][i] >= need);
    const xs = use.map((i) => fits[0].strength[i]);
    const ys = use.map((i) => fits[1].strength[i]);
    const r = weightedCorr(xs, ys);
    return {
        n: use.length, games: halves.map((h) => h.length), minGamesPerHalf: need, r,
        spearmanBrown: r === null || r <= -1 ? null : (2 * r) / (1 + r), spearman: weightedCorr(ranks(xs), ranks(ys))
    };
}

/** 6. Per style: pooled bot win rate (all games, and against other styles only) vs the human mean of those decks. */
function styleSummary(meta, tallies, fit, decided) {
    const styleOf = meta.map((m) => m.style ?? 'unknown');
    const styles = [...STYLES, ...[...new Set(styleOf)].filter((s) => !STYLES.includes(s))].filter((s) => styleOf.includes(s));
    const vsOther = new Map(styles.map((s) => [s, { games: 0, score: 0 }]));
    for (const g of decided) {
        if (styleOf[g.a] !== styleOf[g.b]) {
            const A = vsOther.get(styleOf[g.a]);
            const B = vsOther.get(styleOf[g.b]);
            A.games++;
            A.score += g.y;
            B.games++;
            B.score += 1 - g.y;
        }
    }
    const out = {};
    for (const s of styles) {
        const idx = meta.map((_, i) => i).filter((i) => styleOf[i] === s);
        const games = idx.reduce((a, i) => a + tallies[i].games, 0);
        const score = idx.reduce((a, i) => a + tallies[i].score, 0);
        const played = idx.filter((i) => fit.strength[i] !== null);
        const pw = played.reduce((a, i) => a + tallies[i].games, 0);
        const hum = idx.map((i) => meta[i].human?.gameWinPct).filter((v) => typeof v === 'number');
        const o = vsOther.get(s);
        out[s] = {
            decks: idx.map((i) => meta[i].name), games, winRate: games ? score / games : null, ci: wilson(score, games),
            vsOtherStyles: { games: o.games, winRate: o.games ? o.score / o.games : null, ci: wilson(o.score, o.games) },
            meanStrength: pw ? played.reduce((a, i) => a + tallies[i].games * fit.strength[i], 0) / pw : null,
            human: { meanGameWinPct: hum.length ? hum.reduce((a, v) => a + v, 0) / hum.length : null, n: hum.length }
        };
    }
    return out;
}

/**
 * The whole comparison. runs: from readRun; deckFile: the parsed deck file; human: the parsed .human.json; online: the
 * parsed SWU Stats human-summary.json or null. Pure apart from `now`.
 */
function compareRuns(runs, deckFile, human, online = null, { permute = 1000, minGames = MIN_GAMES, ridge = RIDGE, now = new Date() } = {}) {
    const decks = deckMeta(deckFile);
    const K = decks.length;
    const deckIndex = new Map(decks.map((d, i) => [d.name, i]));
    const onlineById = new Map((online?.leaders ?? []).map((l) => [l.id, l]));
    const meta = decks.map((d) => {
        const h = human?.archetypes?.[d.name];
        const o = d.leader ? onlineById.get(d.leader) : null;
        return {
            ...d, label: h?.label ?? null,
            human: h ? { gameWinPct: h.gameWinPct ?? null, fieldDecks: h.fieldDecks ?? null } : null,
            online: o && o.plays ? { winRate: o.wins / o.plays, plays: o.plays } : null
        };
    });
    const out = {
        credit: online ? [CREDIT_DECKS, CREDIT_ONLINE] : [CREDIT_DECKS],
        generatedAt: now.toISOString(),
        options: { permute, minGames, ridge, near: NEAR, onlineMinPlays: ONLINE_MIN_PLAYS },
        humanSource: human?.source ?? null, onlineSource: online ? { source: online.source ?? null, fetchedAt: online.fetchedAt ?? null } : null,
        runs: [],
        decks: meta.map((m) => ({ ...m, runs: {} })),
        agreement: { deck: {}, pair: {}, leader: {}, style: {}, splitHalf: {}, betweenRuns: [] }
    };
    const fits = [];
    const taken = new Set();
    for (const run of runs) {
        let id = run.id;
        for (let k = 2; taken.has(id); k++) {
            id = `${run.id}#${k}`;
        }
        taken.add(id);
        const sorted = sortGames(run.games, deckIndex);
        const tallies = deckTallies(sorted, K);
        const fit = fitStrengths(sorted.decided, K, { ridge });
        const p1 = sorted.decided.reduce((s, g) => s + g.y, 0);
        const errors = new Map();
        for (const g of sorted.incomplete) {
            const key = g.error ? `${g.outcome}: ${g.error}` : g.outcome;
            errors.set(key, (errors.get(key) ?? 0) + 1);
        }
        const warnings = [];
        if (!run.mirror) {
            warnings.push('not a mirror run: bot and deck effects can mix');
        }
        if (run.deckNames && (run.deckNames.length !== K || run.deckNames.some((n) => !deckIndex.has(n)))) {
            warnings.push('the run was made with a different deck list than --decks');
        }
        if (sorted.skipped) {
            warnings.push(`${sorted.skipped} games skipped (no decks, a deck not in --decks, or a deck against itself)`);
        }
        out.runs.push({
            id, bot: run.bot, mirror: run.mirror, dir: run.dir ?? null, status: run.status ?? null,
            games: sorted.decided.length + sorted.incomplete.length, decided: sorted.decided.length,
            draws: sorted.decided.filter((g) => g.y === 0.5).length, incomplete: sorted.incomplete.length,
            running: sorted.running, skipped: sorted.skipped,
            p1WinRate: sorted.decided.length ? p1 / sorted.decided.length : null, p1WinRateCI: wilson(p1, sorted.decided.length),
            seat: { logit: fit.seat, se: fit.seatSe },
            errors: [...errors].sort((p, q) => q[1] - p[1]).slice(0, 5).map(([error, count]) => ({ error, count })),
            warnings
        });
        out.decks.forEach((d, i) => {
            const t = tallies[i];
            d.runs[id] = {
                games: t.games, wins: t.wins, draws: t.draws, losses: t.losses, winRate: t.games ? t.score / t.games : null,
                ci: wilson(t.score, t.games), strength: fit.strength[i], se: fit.se[i], incomplete: t.incomplete, incompleteOutcomes: t.incompleteOutcomes
            };
        });
        out.agreement.deck[id] = deckAgreement(meta, tallies, fit, { minGames, permute });
        out.agreement.pair[id] = pairAgreement(meta, sorted.decided, human?.cells);
        if (online) {
            out.agreement.leader[id] = leaderAgreement(meta, tallies, fit, online, { minGames, permute });
        }
        out.agreement.style[id] = styleSummary(meta, tallies, fit, sorted.decided);
        out.agreement.splitHalf[id] = splitHalf(sorted.decided, K, { minGames, ridge });
        fits.push({ id, fit, tallies });
    }
    for (let i = 0; i < fits.length; i++) {
        for (let j = i + 1; j < fits.length; j++) {
            const [A, B] = [fits[i], fits[j]];
            const use = [...Array(K).keys()].filter((d) => A.tallies[d].games >= minGames && B.tallies[d].games >= minGames);
            const xs = use.map((d) => A.fit.strength[d]);
            const ys = use.map((d) => B.fit.strength[d]);
            out.agreement.betweenRuns.push({ a: A.id, b: B.id, n: use.length, pearson: weightedCorr(xs, ys), pearsonCI95: fisherCI(weightedCorr(xs, ys), use.length), spearman: weightedCorr(ranks(xs), ranks(ys)) });
        }
    }
    return out;
}

const f2 = (x, d = 2) => (x === null || x === undefined ? '-' : (x >= 0 ? '+' : '') + x.toFixed(d));
const pc = (x) => (x === null || x === undefined ? '-' : (100 * x).toFixed(1));
const pv = (x) => (x === null || x === undefined ? '-' : x < 0.001 ? '<0.001' : x.toFixed(3));
const ci = (c) => (c ? ` [${f2(c[0])}, ${f2(c[1])}]` : '');

/** A short plain-text summary of compareRuns' result. */
function summaryText(r) {
    const L = [];
    const nLeaders = new Set(r.decks.map((d) => d.leader)).size;
    const src = r.humanSource ? `, human results from ${r.humanSource.events} events / ${r.humanSource.decks} decks` : '';
    L.push(`realdeck: ${r.decks.length} decks (${nLeaders} leaders)${src}`);
    for (const run of r.runs) {
        const id = run.id;
        L.push('');
        L.push(`run ${id} (${run.bot}${run.status ? `, ${run.status}` : ''}): ${run.games} finished, ${run.decided} decided, ${run.incomplete} incomplete, ${run.running} running; ` +
            `p1 wins ${pc(run.p1WinRate)}% (seat ${f2(run.seat.logit)} ± ${run.seat.se === null ? '-' : run.seat.se.toFixed(2)} logit)`);
        for (const w of run.warnings) {
            L.push(`  warning: ${w}`);
        }
        const d = r.agreement.deck[id];
        const perm = (a) => (a.permutationP ? ` p=${pv(a.permutationP.pearson)}` : '');
        L.push(`  deck vs human archetype (n=${d.n}, >= ${d.minGames} games): strength r=${f2(d.strength.pearson)}${ci(d.strength.pearsonCI95)} rho=${f2(d.strength.spearman)}${perm(d.strength)}` +
            ` | win rate r=${f2(d.winRate.pearson)} rho=${f2(d.winRate.spearman)}${perm(d.winRate)}`);
        const p = r.agreement.pair[id];
        L.push(`  pair vs human cell (n=${p.n} non-thin of ${p.pairsPlayed} played): weighted r=${f2(p.pearsonWeighted)} rho=${f2(p.spearman)}; ` +
            `same favourite ${pc(p.favourite.share)}% of ${p.favourite.n} (sign p=${pv(p.favourite.signTestP)})`);
        const l = r.agreement.leader[id];
        if (l) {
            L.push(`  leader vs online (n=${l.n}): r=${f2(l.pearson)}${ci(l.pearsonCI95)} rho=${f2(l.spearman)}${perm(l)}`);
        }
        const s = r.agreement.splitHalf[id];
        L.push(`  reliability: split-half r=${f2(s.r)} (n=${s.n}, ${s.games[0]}/${s.games[1]} games) -> Spearman-Brown ${f2(s.spearmanBrown)}`);
        const st = r.agreement.style[id];
        L.push(`  style, bot win% / human mean%: ${Object.entries(st).map(([k, v]) => `${k} ${pc(v.winRate)}/${pc(v.human.meanGameWinPct)}`).join(', ')}`);
        const inc = r.decks.filter((x) => x.runs[id].incomplete).sort((a, b) => b.runs[id].incomplete - a.runs[id].incomplete).slice(0, 5);
        if (inc.length) {
            L.push(`  most incomplete: ${inc.map((x) => `${x.name} ${x.runs[id].incomplete}`).join(', ')}`);
        }
        L.push(`  ${'deck'.padEnd(38)} style        games  win%  strength       human%`);
        const rows = [...r.decks].sort((a, b) => (b.runs[id].strength ?? -99) - (a.runs[id].strength ?? -99));
        for (const x of rows) {
            const v = x.runs[id];
            const se = v.se === null ? '' : `±${v.se.toFixed(2)}`;
            L.push(`  ${x.name.padEnd(38)} ${String(x.style ?? '-').padEnd(12)} ${String(v.games).padStart(5)} ${pc(v.winRate).padStart(5)}  ${(f2(v.strength) + se).padEnd(13)}  ${pc(x.human?.gameWinPct)}`);
        }
    }
    for (const b of r.agreement.betweenRuns) {
        L.push(`between runs ${b.a} vs ${b.b}: r=${f2(b.pearson)}${ci(b.pearsonCI95)} rho=${f2(b.spearman)} (n=${b.n})`);
    }
    L.push('');
    L.push(`Credit: ${r.credit.join('; ')}`);
    return L.join('\n');
}

const USAGE = 'usage: node analysis/realdeck/compare.js --runs <run dir>[,<run dir>...] --decks <deck file> --human <.human.json> ' +
    '[--online <human-summary.json or dir>] [--out file.json] [--permute N] [--min-games N]';

function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`${e.message}\n${USAGE}`);
        process.exit(2);
    }
    if (!args.runs.length || !args.decks || !args.human) {
        console.error(USAGE);
        process.exit(2);
    }
    let onlineFile = args.online;
    if (onlineFile && fs.statSync(onlineFile).isDirectory()) {
        onlineFile = path.join(onlineFile, 'human-summary.json');
    }
    const r = compareRuns(args.runs.map(readRun), readJson(args.decks), readJson(args.human), onlineFile ? readJson(onlineFile) : null,
        { permute: args.permute, minGames: args.minGames });
    console.log(summaryText(r));
    if (args.out) {
        fs.writeFileSync(args.out, JSON.stringify(r, null, 1));
        console.log(`wrote ${args.out}`);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    CREDIT_DECKS, CREDIT_ONLINE, STYLES, parseArgs, botName, readRun, deckMeta, sortGames, wilson, fisherCI, shuffled,
    fitLogistic, fitStrengths, deckTallies, agreement, deckAgreement, signTestP, pairAgreement, leaderAgreement,
    splitHalf, styleSummary, compareRuns, summaryText
};
