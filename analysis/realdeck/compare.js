'use strict';

/**
 * Do decks that win for humans also win for our bots? Real tournament deck lists, played by one bot against itself.
 *
 *   node analysis/realdeck/compare.js --runs <run dir>[,<run dir>...] --decks bot/decks/ash-meta-2026-09.json \
 *        --human bot/decks/ash-meta-2026-09.human.json [--online <human-summary.json or its dir>] [--out file.json] \
 *        [--permute 1000] [--min-games 10] [--max-incomplete 0.10]
 *
 * A run is one `node bot/ladder.js --decks <file> --bots <bot>#a,<bot>#b` directory (index.json, ladder.json). Both
 * seats run the same bot, so the decks are what differs between games. A run is keyed by its index.json id (or its
 * directory name); its bot ('#a' tags dropped) is a separate field.
 *
 * Decks are read the way bot/decklists.js normalizeDeck reads them (padded ids, the same default name), and the deck
 * file's sha256 (of the raw bytes, as loadDecks hashes it) is checked against the one in each run's ladder.json.
 *
 * Games: only decided games count (winnerSeat p1 or p2; a draw counts half). Games that ended with ERROR, STEP_CAP,
 * STUCK or any other outcome are left out of every rate and model, but each deck reports them as `incomplete`: a deck
 * with a buggy card can lose games to engine errors, and that should stay visible. Games still running are ignored.
 * A deck whose finished games are more than --max-incomplete incomplete (default 10%) is left out of every
 * correlation (deck, pair, leader, style, reliability) but stays in the model and the deck table, marked.
 *
 * Human side: one Bradley-Terry model over every human cell among these decks (thin cells too, draws count half)
 * gives each deck a human strength with an SE on the same deck pool the bot plays. The field game win rate of each
 * archetype (against the whole meta, best of three with sideboards) is compared too, but the BT one is like for like.
 *
 * Per run:
 *  1. Per deck: decided games, wins, win rate with a Wilson 95% CI, incomplete games, and a strength from one logistic
 *     model P(p1 wins) = σ(s[p1 deck] − s[p2 deck] + seat). Strengths get a small ridge (prior SD 1.4 logit, so a deck
 *     that never lost stays finite) and are centred; their SEs are for the centred value.
 *  2. Deck agreement with humans: bot strength vs human BT strength (Pearson with a Fisher-z 95% CI, tie-aware
 *     Spearman, a one-sided permutation p-value that shuffles the human values across decks, the reliability of both
 *     sides from their SEs and the disattenuated r), and bot strength / bot win rate vs the field game win rate.
 *  3. Pair agreement: bot win rate of a over b (both seats pooled) vs the human cell for a over b, non-thin cells only:
 *     Pearson weighted by human games, and how often both pick the same favourite. Pairs share decks, so the p-values
 *     come from shuffling deck labels on the bot side (rows and columns of the pair matrix together, QAP / Mantel).
 *  4. Leader agreement with online play (--online, SWU Stats): decks pooled by leader vs the SWU Stats leader win rate.
 *  5. Reliability: split-half (games split by the rank of their seed within their deck pair, Spearman-Brown corrected),
 *     and run vs run when there are 2+ runs (bot vs bot agreement when the runs use different bots).
 *  6. By style (hyperaggro .. hardcontrol): pooled bot win rate against other styles vs the human mean of those decks.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeDeck, padId } = require('../../bot/decklists');
const { weightedCorr, ranks, humanStrength } = require('../swustats/compare');

const CREDIT_DECKS = 'Tournament deck lists and match results: TCGEngine / SWU Stats (github.com/TCG-Engine/TCGEngine, MIT), from public melee.gg Premier events (event list via swu-competitivehub.com)';
const CREDIT_ONLINE = 'Online leader win rates: SWU Stats (swustats.net)';
const STYLES = ['hyperaggro', 'softaggro', 'midrange', 'softcontrol', 'hardcontrol'];
const RIDGE = 0.5; // 1/σ² on deck strengths, σ ≈ 1.4 logit: shrinks a deck with 500 games by well under 1%
const LOOSE = 0.01; // the seat term is almost free
const MIN_GAMES = 10; // decided games a deck (or leader) needs to enter a correlation
const MAX_INCOMPLETE = 0.1; // share of a deck's finished games that may end incomplete before it leaves the correlations
const NEAR = 0.02; // favourite agreement ignores win rates within 2 points of 50%
const ONLINE_MIN_PLAYS = 200; // the same cut as analysis/swustats (humanStrength)
const Z95 = 1.959964;

function parseArgs(argv) {
    const a = { runs: [], decks: null, human: null, online: null, out: null, permute: 1000, minGames: MIN_GAMES, maxIncomplete: MAX_INCOMPLETE };
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
        } else if (k === '--max-incomplete') {
            const v = Number(value());
            if (!Number.isFinite(v)) {
                throw new Error('--max-incomplete needs a share between 0 and 1');
            }
            a.maxIncomplete = Math.min(1, Math.max(0, v));
        } else {
            throw new Error(`unknown option ${k}`);
        }
    }
    return a;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The deck file, parsed, and the sha256 of its raw bytes (the hash bot/decklists.js loadDecks puts in ladder.json). */
function readDeckFile(file) {
    const bytes = fs.readFileSync(file);
    return { raw: JSON.parse(bytes.toString('utf8')), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/** 'c-clock#a', 'c-clock#b' -> 'c-clock'. Two different bots give 'x vs y' (then deck and bot effects can mix). */
function botName(entries) {
    const bases = [...new Set(entries.map((e) => String(e).replace(/#.*$/, '')))];
    return { bot: bases.join(' vs '), mirror: bases.length === 1 };
}

/**
 * One run directory. index.json is rewritten atomically after every game, so reading a run in progress is safe: it is
 * just a smaller run. ladder.json is optional (status, and the deck names and file hash the run was made with).
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
        status: ladder?.status ?? null, deckNames: ladder?.config?.decks?.names ?? null,
        decksSha256: ladder?.config?.decks?.sha256 ?? null, games
    };
}

/** Deck file (array or {decks}) -> [{name, leader, base, style}] in file order, read as bot/decklists.js reads it. */
function deckMeta(raw) {
    const list = Array.isArray(raw) ? raw : raw?.decks;
    if (!Array.isArray(list) || !list.length) {
        throw new Error('deck file: expected a JSON array of deck lists');
    }
    const decks = list.map((d, i) => {
        const n = normalizeDeck(d, i);
        return { name: n.metadata.name, leader: n.leader.id, base: n.base.id, style: n.metadata.style ?? null };
    });
    const seen = new Set();
    for (const d of decks) {
        if (seen.has(d.name)) {
            throw new Error(`deck file: ${d.name} is used twice`);
        }
        seen.add(d.name);
    }
    return decks;
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
 * Ridge logistic regression by Newton's method. rows: [{x: [[column, value]...], y, n}] with y in [0, 1] (½ for a
 * draw, or a share when the row stands for n games; n defaults to 1). Returns the weights and their covariance (inverse
 * of the penalised Hessian).
 */
function fitLogistic(rows, dim, penalty) {
    const w = new Array(dim).fill(0);
    for (let it = 0; it < 100; it++) {
        const g = new Array(dim).fill(0);
        const H = Array.from({ length: dim }, () => new Array(dim).fill(0));
        for (const r of rows) {
            const n = r.n ?? 1;
            let z = 0;
            for (const [j, v] of r.x) {
                z += w[j] * v;
            }
            const p = 1 / (1 + Math.exp(-z));
            for (const [j, v] of r.x) {
                g[j] += n * (r.y - p) * v;
                for (const [k, u] of r.x) {
                    H[j][k] += n * p * (1 - p) * v * u;
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
 * Deck strengths for K decks: P(a beats b) = σ(s[a] − s[b] (+ seat when `seat`, a at p1)). games: [{a, b, y, n}] with
 * n games (default 1) and a score share y for a. Strengths are centred over the decks that played, and each SE is the
 * SE of that centred value (the shift all decks share drops out). A deck with no game gets null.
 */
function fitStrengths(decided, K, { ridge = RIDGE, seat = true } = {}) {
    const played = new Array(K).fill(false);
    for (const g of decided) {
        played[g.a] = true;
        played[g.b] = true;
    }
    const idx = [...Array(K).keys()].filter((i) => played[i]);
    if (!decided.length) {
        return { strength: new Array(K).fill(null), se: new Array(K).fill(null), seat: null, seatSe: null };
    }
    const rows = decided.map((g) => ({ x: seat ? [[g.a, 1], [g.b, -1], [K, 1]] : [[g.a, 1], [g.b, -1]], y: g.y, n: g.n ?? 1 }));
    const { w, cov } = fitLogistic(rows, seat ? K + 1 : K, [...new Array(K).fill(ridge), ...(seat ? [LOOSE] : [])]);
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
    return seat ? { strength, se, seat: w[K], seatSe: Math.sqrt(cov[K][K]) } : { strength, se, seat: null, seatSe: null };
}

/**
 * Reliability of strengths measured with error: (observed variance − mean SE²) / observed variance over the decks with
 * a value, so the share of the spread that is real. null with fewer than 3 decks or no spread; can be below 0.
 */
function reliability(values, ses) {
    const use = values.map((v, i) => i).filter((i) => typeof values[i] === 'number' && typeof ses[i] === 'number');
    if (use.length < 3) {
        return null;
    }
    const m = use.reduce((s, i) => s + values[i], 0) / use.length;
    const observed = use.reduce((s, i) => s + (values[i] - m) ** 2, 0) / (use.length - 1);
    const error = use.reduce((s, i) => s + ses[i] ** 2, 0) / use.length;
    return observed > 0 ? 1 - error / observed : null;
}

/**
 * The correlation two noisy measures would have without their noise: r / sqrt(relA · relB). Undefined (null) when a
 * reliability is missing or not above 0; a value above 1 in size is clamped to ±1 and marked.
 */
function disattenuate(r, relA, relB) {
    if (r === null || r === undefined || !(relA > 0) || !(relB > 0)) {
        return { value: null, raw: null, note: 'undefined: a reliability is missing or not above 0' };
    }
    const raw = r / Math.sqrt(relA * relB);
    return Math.abs(raw) > 1 ? { value: Math.sign(raw), raw, note: 'above 1 in size, clamped: the reliabilities are estimates' } : { value: raw, raw, note: null };
}

/**
 * Human Bradley-Terry strengths for the decks in `meta` from every human cell between two of them, thin cells
 * included: P(a beats b) = σ(h[a] − h[b]), no seat term, the same ridge as the bot model. games [wins, losses, draws]
 * per cell; a draw counts half a win for each side (as on the bot side). Each unordered pair is read once.
 */
function humanBradleyTerry(meta, cells, { ridge = RIDGE } = {}) {
    const K = meta.length;
    const rows = [];
    const games = new Array(K).fill(0);
    let draws = 0;
    let thin = 0;
    for (let i = 0; i < K; i++) {
        for (let j = i + 1; j < K; j++) {
            const cell = cells?.[meta[i].name]?.[meta[j].name];
            const [w, l, d] = [0, 1, 2].map((k) => Number(cell?.games?.[k]) || 0);
            const n = w + l + d;
            if (!n) {
                continue;
            }
            rows.push({ a: i, b: j, y: (w + d / 2) / n, n });
            games[i] += n;
            games[j] += n;
            draws += d;
            thin += cell.thin ? 1 : 0;
        }
    }
    const fit = fitStrengths(rows, K, { ridge, seat: false });
    return {
        strength: fit.strength, se: fit.se, games,
        summary: {
            model: 'Bradley-Terry over the human cells among these decks', draws: 'count half', ridge,
            pairs: rows.length, thinPairs: thin, games: rows.reduce((s, r) => s + r.n, 0), drawnGames: draws,
            reliability: reliability(fit.strength, fit.se)
        }
    };
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

/** Decks over the incomplete-game limit: Map deck index -> reason. They leave every correlation of the run. */
function leftDecks(tallies, { maxIncomplete = MAX_INCOMPLETE } = {}) {
    const left = new Map();
    tallies.forEach((t, i) => {
        const finished = t.games + t.incomplete;
        if (finished && t.incomplete / finished > maxIncomplete + 1e-12) {
            left.set(i, `${t.incomplete} of ${finished} finished games incomplete, ${(100 * t.incomplete / finished).toFixed(1)}% > ${+(100 * maxIncomplete).toFixed(1)}%`);
        }
    });
    return left;
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

/**
 * 2. Deck agreement over decks with enough decided games that are not left out:
 *  - bt: bot strength vs human BT strength (like for like: the same deck pool), with the reliability of both sides
 *    from their SEs and the disattenuated r;
 *  - field: bot strength and bot win rate vs the human field game win rate (centred logits);
 *  - withLeft: the same two Pearson r with the left-out decks put back, as a check.
 */
function deckAgreement(meta, tallies, fit, { minGames = MIN_GAMES, permute = 0, left = new Map(), botSplitHalf = null } = {}) {
    const enough = (i) => tallies[i].games >= minGames && fit.strength[i] !== null;
    const hasField = (i) => typeof meta[i].human?.gameWinPct === 'number';
    const hasBT = (i) => typeof meta[i].humanBT?.strength === 'number';
    const all = meta.map((_, i) => i);
    const fieldOf = (use) => centred(use.map((i) => logit(clampRate(meta[i].human.gameWinPct))));
    const field = all.filter((i) => !left.has(i) && enough(i) && hasField(i));
    const bt = all.filter((i) => !left.has(i) && enough(i) && hasBT(i));
    const botRate = centred(field.map((i) => logit((tallies[i].score + 0.5) / (tallies[i].games + 1))));
    const btAgreement = agreement(bt.map((i) => fit.strength[i]), bt.map((i) => meta[i].humanBT.strength), { permute });
    const rel = {
        bot: reliability(bt.map((i) => fit.strength[i]), bt.map((i) => fit.se[i])),
        human: reliability(bt.map((i) => meta[i].humanBT.strength), bt.map((i) => meta[i].humanBT.se)),
        botSplitHalf
    };
    const fieldAll = all.filter((i) => enough(i) && hasField(i));
    const btAll = all.filter((i) => enough(i) && hasBT(i));
    return {
        minGames,
        bt: { n: bt.length, strength: btAgreement, reliability: rel, disattenuated: disattenuate(btAgreement.pearson, rel.bot, rel.human) },
        field: {
            n: field.length,
            strength: agreement(field.map((i) => fit.strength[i]), fieldOf(field), { permute }),
            winRate: agreement(botRate, fieldOf(field), { permute })
        },
        withLeft: {
            n: btAll.length,
            bt: weightedCorr(btAll.map((i) => fit.strength[i]), btAll.map((i) => meta[i].humanBT.strength)),
            field: weightedCorr(fieldAll.map((i) => fit.strength[i]), fieldOf(fieldAll))
        },
        left: all.filter((i) => !bt.includes(i) || !field.includes(i)).map((i) => {
            const why = [];
            if (left.has(i)) {
                why.push(left.get(i));
            }
            if (!enough(i)) {
                why.push(`fewer than ${minGames} decided games`);
            }
            if (!hasBT(i)) {
                why.push('no human BT strength');
            }
            if (!hasField(i)) {
                why.push('no human field rate');
            }
            return { deck: meta[i].name, reason: why.join('; ') };
        })
    };
}

/**
 * One-sided sign test: P(X >= k) for X ~ Binomial(n, ½), summed in log space so a large n does not underflow. Pairs
 * share decks, so this treats them as more independent than they are: it is a description, not the test.
 */
function signTestP(k, n) {
    if (!n) {
        return null;
    }
    if (k <= 0) {
        return 1;
    }
    let logC = 0; // log C(n, i)
    const terms = [];
    for (let i = 0; i <= n; i++) {
        if (i >= k) {
            terms.push(logC - n * Math.LN2);
        }
        logC += Math.log(n - i) - Math.log(i + 1);
    }
    if (!terms.length) {
        return 0;
    }
    const top = Math.max(...terms);
    return Math.min(1, Math.exp(top + Math.log(terms.reduce((s, t) => s + Math.exp(t - top), 0))));
}

/**
 * 3. Per unordered deck pair: bot win rate of a over b (both seat orders pooled) vs the human cell a over b. Thin cells
 * (fewer than 10 human matches), cells without a game win rate and pairs with a left-out deck are left out. Weights are
 * the human games behind the cell's rate (wins + losses; the human rate leaves draws out). Favourite agreement ignores
 * pairs where either rate is within `near` of 50%.
 * With permute > 0, p-values for the weighted r and the favourite share come from a deck-label permutation test (QAP /
 * Mantel): shuffle the deck labels on the bot side, rows and columns of the pair matrix together, p = (k + 1) / (N + 1).
 * Only decks that are not left out are shuffled; a pair whose shuffled bot pair was not played drops out of that shuffle.
 */
function pairAgreement(meta, decided, cells, { near = NEAR, permute = 0, seed = 12345, left = new Map() } = {}) {
    const K = meta.length;
    const tally = new Map();
    for (const g of decided) {
        const [i, j, y] = g.a < g.b ? [g.a, g.b, g.y] : [g.b, g.a, 1 - g.y];
        const t = tally.get(i * K + j) ?? { n: 0, score: 0 };
        t.n++;
        t.score += y;
        tally.set(i * K + j, t);
    }
    // bot rate of deck i over deck j, or null when the pair was not played
    const rate = (i, j) => {
        const t = tally.get(Math.min(i, j) * K + Math.max(i, j));
        return !t ? null : i < j ? t.score / t.n : 1 - t.score / t.n;
    };
    const list = [];
    const idx = [];
    const leftOut = { thin: 0, noHuman: 0, deck: 0 };
    for (const [key, t] of [...tally].sort((p, q) => p[0] - q[0])) {
        const [i, j] = [Math.floor(key / K), key % K];
        const [a, b] = [meta[i].name, meta[j].name];
        const cell = cells?.[a]?.[b];
        const humanGames = (cell?.games?.[0] ?? 0) + (cell?.games?.[1] ?? 0);
        if (left.has(i) || left.has(j)) {
            leftOut.deck++;
        } else if (!cell || typeof cell.gameWinPct !== 'number' || !humanGames) {
            leftOut.noHuman++;
        } else if (cell.thin) {
            leftOut.thin++;
        } else {
            list.push({ a, b, botGames: t.n, bot: t.score / t.n, human: cell.gameWinPct, humanGames });
            idx.push([i, j]);
        }
    }
    const clear = (bot, hum) => Math.abs(bot - 0.5) > near + 1e-9 && Math.abs(hum - 0.5) > near + 1e-9;
    // weighted r and favourite share for one set of bot rates (bots[k] for list[k], null to drop the pair)
    const stats = (bots) => {
        const xs = [];
        const ys = [];
        const ws = [];
        let n = 0;
        let agree = 0;
        list.forEach((p, k) => {
            const b = bots[k];
            if (b === null) {
                return;
            }
            xs.push(b);
            ys.push(p.human);
            ws.push(p.humanGames);
            if (clear(b, p.human)) {
                n++;
                agree += b > 0.5 === p.human > 0.5 ? 1 : 0;
            }
        });
        return { r: weightedCorr(xs, ys, ws), n, agree, share: n ? agree / n : null };
    };
    const seen = stats(list.map((p) => p.bot));
    const xs = list.map((p) => p.bot);
    const ys = list.map((p) => p.human);
    const games = list.map((p) => p.botGames).sort((p, q) => p - q);
    const out = {
        n: list.length, pairsPlayed: tally.size, left: leftOut,
        pearsonWeighted: seen.r, pearson: weightedCorr(xs, ys), spearman: weightedCorr(ranks(xs), ranks(ys)),
        favourite: { n: seen.n, agree: seen.agree, share: seen.share, near, signTestP: signTestP(seen.agree, seen.n) },
        botGamesPerPair: games.length ? { min: games[0], median: games[Math.floor(games.length / 2)], max: games[games.length - 1] } : null,
        list
    };
    if (permute > 0) {
        const pool = [...Array(K).keys()].filter((d) => !left.has(d));
        let kr = 0;
        let kf = 0;
        for (let s = 0; s < permute; s++) {
            const perm = shuffled(pool, seed + s);
            const to = new Array(K);
            pool.forEach((d, k) => (to[d] = perm[k]));
            const st = stats(idx.map(([i, j]) => rate(to[i], to[j])));
            if (seen.r !== null && st.r !== null && st.r >= seen.r - 1e-12) {
                kr++;
            }
            if (seen.share !== null && st.share !== null && st.share >= seen.share - 1e-12) {
                kf++;
            }
        }
        out.permutationP = {
            method: 'deck labels shuffled on the bot side', shuffles: permute,
            pearsonWeighted: seen.r === null ? null : (kr + 1) / (permute + 1),
            favouriteShare: seen.share === null ? null : (kf + 1) / (permute + 1)
        };
    }
    return out;
}

/**
 * 4. Decks pooled by leader id (games-weighted mean strength) vs the SWU Stats online leader strength (centred logit
 * of the win rate, leaders with >= 200 plays; see analysis/swustats humanStrength). Left-out decks are not pooled.
 */
function leaderAgreement(meta, tallies, fit, online, { minGames = MIN_GAMES, permute = 0, left = new Map() } = {}) {
    const hs = humanStrength((online?.leaders ?? []).map((l) => ({ ...l, id: padId(l.id) })));
    const byLeader = new Map();
    meta.forEach((m, i) => {
        if (!m.leader || !tallies[i].games || fit.strength[i] === null || left.has(i)) {
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
    return {
        ...agreement(use.map((e) => e.strength), use.map((e) => e.online.logit), { permute }), minGames, minPlays: ONLINE_MIN_PLAYS,
        left: [...left].map(([i, reason]) => ({ deck: meta[i].name, reason })), list
    };
}

/**
 * Two halves of the decided games for split-half reliability. Within each unordered deck pair the seeds are ranked
 * (ascending); games of an even-ranked seed go to half A, odd to half B. So both games of a seed share a half and
 * every pair with 2+ seeds is in both halves, whatever the number of pairs (a split by seed parity puts every seed of
 * a pair in one half when the deal walks an even number of pairs). Games without an integer seed are dropped.
 */
function splitHalves(decided) {
    const pairKey = (g) => (g.a < g.b ? `${g.a}|${g.b}` : `${g.b}|${g.a}`);
    const seeded = decided.filter((g) => Number.isInteger(g.seed));
    const seeds = new Map();
    for (const g of seeded) {
        const k = pairKey(g);
        if (!seeds.has(k)) {
            seeds.set(k, new Set());
        }
        seeds.get(k).add(g.seed);
    }
    const rank = new Map();
    for (const [k, set] of seeds) {
        [...set].sort((p, q) => p - q).forEach((s, r) => rank.set(`${k}|${s}`, r));
    }
    const halves = [[], []];
    for (const g of seeded) {
        halves[rank.get(`${pairKey(g)}|${g.seed}`) % 2].push(g);
    }
    return halves;
}

/** 5a. Two independent fits on the split halves, correlated over decks (not left out) with enough games in both. */
function splitHalf(decided, K, { minGames = MIN_GAMES, ridge = RIDGE, left = new Map() } = {}) {
    const halves = splitHalves(decided);
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
    const use = [...Array(K).keys()].filter((i) => !left.has(i) && counts[0][i] >= need && counts[1][i] >= need);
    const xs = use.map((i) => fits[0].strength[i]);
    const ys = use.map((i) => fits[1].strength[i]);
    const r = weightedCorr(xs, ys);
    return {
        n: use.length, games: halves.map((h) => h.length), minGamesPerHalf: need, r,
        spearmanBrown: r === null || r <= -1 ? null : (2 * r) / (1 + r), spearman: weightedCorr(ranks(xs), ranks(ys))
    };
}

/**
 * 6. Per style, over decks that are not left out (games with a left-out deck do not count):
 *  - vsOtherStyles: bot win rate in games against decks of another style, with a Wilson CI;
 *  - allGamesInclSameStyle: the rate over all games; a same-style game adds a win and a loss to the same pool, so this
 *    rate is pulled toward 50% and gets no CI;
 * and the games-weighted mean strength and the human mean field game win rate of those decks.
 */
function styleSummary(meta, tallies, fit, decided, { left = new Map() } = {}) {
    const styleOf = meta.map((m) => m.style ?? 'unknown');
    const styles = [...STYLES, ...[...new Set(styleOf)].filter((s) => !STYLES.includes(s))].filter((s) => styleOf.includes(s));
    const pool = () => new Map(styles.map((x) => [x, { games: 0, score: 0 }]));
    const all = pool();
    const vsOther = pool();
    for (const g of decided) {
        if (left.has(g.a) || left.has(g.b)) {
            continue;
        }
        const other = styleOf[g.a] !== styleOf[g.b];
        for (const [d, y] of [[g.a, g.y], [g.b, 1 - g.y]]) {
            for (const p of other ? [all, vsOther] : [all]) {
                const e = p.get(styleOf[d]);
                e.games++;
                e.score += y;
            }
        }
    }
    const out = {};
    for (const s of styles) {
        const idx = meta.map((_, i) => i).filter((i) => styleOf[i] === s && !left.has(i));
        const played = idx.filter((i) => fit.strength[i] !== null);
        const pw = played.reduce((a, i) => a + tallies[i].games, 0);
        const hum = idx.map((i) => meta[i].human?.gameWinPct).filter((v) => typeof v === 'number');
        const [A, O] = [all.get(s), vsOther.get(s)];
        out[s] = {
            decks: idx.map((i) => meta[i].name), leftOut: meta.filter((_, i) => styleOf[i] === s && left.has(i)).map((m) => m.name),
            vsOtherStyles: { games: O.games, winRate: O.games ? O.score / O.games : null, ci: wilson(O.score, O.games) },
            allGamesInclSameStyle: { games: A.games, winRate: A.games ? A.score / A.games : null },
            meanStrength: pw ? played.reduce((a, i) => a + tallies[i].games * fit.strength[i], 0) / pw : null,
            human: { meanGameWinPct: hum.length ? hum.reduce((a, v) => a + v, 0) / hum.length : null, n: hum.length }
        };
    }
    return out;
}

/**
 * The whole comparison. runs: from readRun; deckFile: the parsed deck file; human: the parsed .human.json; online: the
 * parsed SWU Stats human-summary.json or null; deckSha256: the hash of the deck file's bytes (readDeckFile), checked
 * against each run's ladder.json when both are known. Pure apart from `now`.
 */
function compareRuns(runs, deckFile, human, online = null, { permute = 1000, minGames = MIN_GAMES, maxIncomplete = MAX_INCOMPLETE, ridge = RIDGE, deckSha256 = null, now = new Date() } = {}) {
    const decks = deckMeta(deckFile);
    const K = decks.length;
    const deckIndex = new Map(decks.map((d, i) => [d.name, i]));
    const onlineById = new Map((online?.leaders ?? []).map((l) => [padId(l.id), l]));
    const bt = humanBradleyTerry(decks, human?.cells, { ridge });
    const meta = decks.map((d, i) => {
        const h = human?.archetypes?.[d.name];
        const o = d.leader ? onlineById.get(d.leader) : null;
        return {
            ...d, label: h?.label ?? null,
            human: h ? { gameWinPct: h.gameWinPct ?? null, fieldDecks: h.fieldDecks ?? null } : null,
            humanBT: { strength: bt.strength[i], se: bt.se[i], games: bt.games[i] },
            online: o && o.plays ? { winRate: o.wins / o.plays, plays: o.plays } : null
        };
    });
    const out = {
        credit: online ? [CREDIT_DECKS, CREDIT_ONLINE] : [CREDIT_DECKS],
        generatedAt: now.toISOString(),
        options: { permute, minGames, maxIncomplete, ridge, near: NEAR, onlineMinPlays: ONLINE_MIN_PLAYS },
        deckFile: { decks: K, sha256: deckSha256 },
        humanSource: human?.source ?? null, onlineSource: online ? { source: online.source ?? null, fetchedAt: online.fetchedAt ?? null } : null,
        humanModel: bt.summary,
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
        const left = leftDecks(tallies, { maxIncomplete });
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
        if (deckSha256 && run.decksSha256 && deckSha256 !== run.decksSha256) {
            warnings.push(`--decks differs from the deck file the run was made with (sha256 ${deckSha256.slice(0, 12)} vs ${String(run.decksSha256).slice(0, 12)})`);
        }
        if (sorted.skipped) {
            warnings.push(`${sorted.skipped} games skipped (no decks, a deck not in --decks, or a deck against itself)`);
        }
        out.runs.push({
            id, bot: run.bot, mirror: run.mirror, dir: run.dir ?? null, status: run.status ?? null, decksSha256: run.decksSha256 ?? null,
            games: sorted.decided.length + sorted.incomplete.length, decided: sorted.decided.length,
            draws: sorted.decided.filter((g) => g.y === 0.5).length, incomplete: sorted.incomplete.length,
            running: sorted.running, skipped: sorted.skipped,
            p1WinRate: sorted.decided.length ? p1 / sorted.decided.length : null, p1WinRateCI: wilson(p1, sorted.decided.length),
            seat: { logit: fit.seat, se: fit.seatSe },
            errors: [...errors].sort((p, q) => q[1] - p[1]).slice(0, 5).map(([error, count]) => ({ error, count })),
            leftOut: [...left].map(([i, reason]) => ({ deck: meta[i].name, reason })),
            warnings
        });
        out.decks.forEach((d, i) => {
            const t = tallies[i];
            const finished = t.games + t.incomplete;
            d.runs[id] = {
                games: t.games, wins: t.wins, draws: t.draws, losses: t.losses, winRate: t.games ? t.score / t.games : null,
                ci: wilson(t.score, t.games), strength: fit.strength[i], se: fit.se[i], incomplete: t.incomplete,
                incompleteShare: finished ? t.incomplete / finished : null, incompleteOutcomes: t.incompleteOutcomes,
                leftOut: left.get(i) ?? null
            };
        });
        out.agreement.splitHalf[id] = splitHalf(sorted.decided, K, { minGames, ridge, left });
        out.agreement.deck[id] = deckAgreement(meta, tallies, fit, { minGames, permute, left, botSplitHalf: out.agreement.splitHalf[id].spearmanBrown });
        out.agreement.pair[id] = pairAgreement(meta, sorted.decided, human?.cells, { permute, left });
        if (online) {
            out.agreement.leader[id] = leaderAgreement(meta, tallies, fit, online, { minGames, permute, left });
        }
        out.agreement.style[id] = styleSummary(meta, tallies, fit, sorted.decided, { left });
        fits.push({ id, bot: run.bot, fit, tallies, left });
    }
    for (let i = 0; i < fits.length; i++) {
        for (let j = i + 1; j < fits.length; j++) {
            const [A, B] = [fits[i], fits[j]];
            const use = [...Array(K).keys()].filter((d) => A.tallies[d].games >= minGames && B.tallies[d].games >= minGames && !A.left.has(d) && !B.left.has(d));
            const xs = use.map((d) => A.fit.strength[d]);
            const ys = use.map((d) => B.fit.strength[d]);
            const r = weightedCorr(xs, ys);
            out.agreement.betweenRuns.push({
                a: A.id, b: B.id, bots: [A.bot, B.bot], kind: A.bot === B.bot ? 'run vs run (same bot)' : 'bot vs bot',
                n: use.length, pearson: r, pearsonCI95: fisherCI(r, use.length), spearman: weightedCorr(ranks(xs), ranks(ys))
            });
        }
    }
    return out;
}

const f2 = (x, d = 2) => (x === null || x === undefined ? '-' : (x >= 0 ? '+' : '') + x.toFixed(d));
const pc = (x) => (x === null || x === undefined ? '-' : (100 * x).toFixed(1));
const pv = (x) => (x === null || x === undefined ? '-' : x < 0.001 ? '<0.001' : x.toFixed(3));
const ci = (c) => (c ? ` [${f2(c[0])}, ${f2(c[1])}]` : '');
const r2 = (x) => (x === null || x === undefined ? '-' : x.toFixed(2));

/** A short plain-text summary of compareRuns' result. */
function summaryText(r) {
    const L = [];
    const nLeaders = new Set(r.decks.map((d) => d.leader)).size;
    const src = r.humanSource ? `, human results from ${r.humanSource.events} events / ${r.humanSource.decks} decks` : '';
    L.push(`realdeck: ${r.decks.length} decks (${nLeaders} leaders)${src}`);
    const hm = r.humanModel;
    L.push(`human BT strengths: ${hm.pairs} deck pairs (${hm.thinPairs} thin, all used), ${hm.games} games, draws count half; reliability ${r2(hm.reliability)}`);
    for (const run of r.runs) {
        const id = run.id;
        L.push('');
        L.push(`run ${id} (${run.bot}${run.status ? `, ${run.status}` : ''}): ${run.games} finished, ${run.decided} decided, ${run.incomplete} incomplete, ${run.running} running; ` +
            `p1 wins ${pc(run.p1WinRate)}% (seat ${f2(run.seat.logit)} ± ${run.seat.se === null ? '-' : run.seat.se.toFixed(2)} logit)`);
        for (const w of run.warnings) {
            L.push(`  warning: ${w}`);
        }
        L.push(`  left out of every correlation: ${run.leftOut.length ? run.leftOut.map((x) => `${x.deck} (${x.reason})`).join(', ') : 'none'}`);
        const d = r.agreement.deck[id];
        const perm = (a) => (a.permutationP ? ` p=${pv(a.permutationP.pearson)}` : '');
        const b = d.bt;
        const da = b.disattenuated;
        L.push(`  deck vs human BT, same deck pool, like for like (n=${b.n}, >= ${d.minGames} games): r=${f2(b.strength.pearson)}${ci(b.strength.pearsonCI95)} rho=${f2(b.strength.spearman)}${perm(b.strength)}; ` +
            `reliability bot ${r2(b.reliability.bot)} (split-half ${r2(b.reliability.botSplitHalf)}) human ${r2(b.reliability.human)} -> disattenuated r=${f2(da.value)}${da.note ? ` (${da.note})` : ''}`);
        L.push(`  deck vs human field rate, whole meta, Bo3 with sideboards (n=${d.field.n}): strength r=${f2(d.field.strength.pearson)}${ci(d.field.strength.pearsonCI95)} rho=${f2(d.field.strength.spearman)}${perm(d.field.strength)}` +
            ` | win rate r=${f2(d.field.winRate.pearson)} rho=${f2(d.field.winRate.spearman)}${perm(d.field.winRate)}`);
        L.push(`  check, left-out decks put back (n=${d.withLeft.n}): BT r=${f2(d.withLeft.bt)}, field r=${f2(d.withLeft.field)}`);
        const p = r.agreement.pair[id];
        const pp = p.permutationP;
        L.push(`  pair vs human cell (n=${p.n} non-thin of ${p.pairsPlayed} played): weighted r=${f2(p.pearsonWeighted)}${pp ? ` (deck-label p=${pv(pp.pearsonWeighted)})` : ''}, unweighted r=${f2(p.pearson)} rho=${f2(p.spearman)}; ` +
            `same favourite ${pc(p.favourite.share)}% of ${p.favourite.n}${pp ? ` (deck-label p=${pv(pp.favouriteShare)})` : ''}, sign test p=${pv(p.favourite.signTestP)} if pairs were independent`);
        const l = r.agreement.leader[id];
        if (l) {
            L.push(`  leader vs online (n=${l.n}): r=${f2(l.pearson)}${ci(l.pearsonCI95)} rho=${f2(l.spearman)}${perm(l)}`);
        }
        const s = r.agreement.splitHalf[id];
        L.push(`  reliability: split-half r=${f2(s.r)} (n=${s.n}, ${s.games[0]}/${s.games[1]} games) -> Spearman-Brown ${f2(s.spearmanBrown)}`);
        const st = r.agreement.style[id];
        L.push(`  style, bot win% vs other styles [95% CI] (all games incl. same-style) / human mean%: ${Object.entries(st).map(([k, v]) => {
            const c = v.vsOtherStyles.ci;
            return `${k} ${pc(v.vsOtherStyles.winRate)}${c ? ` [${pc(c[0])}, ${pc(c[1])}]` : ''} (${pc(v.allGamesInclSameStyle.winRate)}) / ${pc(v.human.meanGameWinPct)}`;
        }).join(', ')}`);
        const inc = r.decks.filter((x) => x.runs[id].incomplete).sort((a, c) => c.runs[id].incomplete - a.runs[id].incomplete).slice(0, 5);
        if (inc.length) {
            L.push(`  most incomplete: ${inc.map((x) => `${x.name} ${x.runs[id].incomplete}`).join(', ')}`);
        }
        L.push(`  ${'deck'.padEnd(38)} style        games  inc%  win%  strength       field%  human BT`);
        const rows = [...r.decks].sort((a, c) => (c.runs[id].strength ?? -99) - (a.runs[id].strength ?? -99));
        for (const x of rows) {
            const v = x.runs[id];
            const se = v.se === null ? '' : `±${v.se.toFixed(2)}`;
            const hb = x.humanBT.strength === null ? '-' : `${f2(x.humanBT.strength)}±${x.humanBT.se.toFixed(2)}`;
            L.push(`  ${x.name.padEnd(38)} ${String(x.style ?? '-').padEnd(12)} ${String(v.games).padStart(5)} ${pc(v.incompleteShare).padStart(5)} ${pc(v.winRate).padStart(5)}  ` +
                `${(f2(v.strength) + se).padEnd(13)}  ${pc(x.human?.gameWinPct).padStart(6)}  ${hb.padEnd(11)}${v.leftOut ? '  left out' : ''}`.trimEnd());
        }
    }
    for (const b of r.agreement.betweenRuns) {
        const what = b.kind === 'bot vs bot' ? `bot vs bot agreement, ${b.a} (${b.bots[0]}) vs ${b.b} (${b.bots[1]})` : `run vs run, same bot ${b.bots[0]}: ${b.a} vs ${b.b}`;
        L.push(`${what}: r=${f2(b.pearson)}${ci(b.pearsonCI95)} rho=${f2(b.spearman)} (n=${b.n})`);
    }
    L.push('');
    L.push(`Credit: ${r.credit.join('; ')}`);
    return L.join('\n');
}

const USAGE = 'usage: node analysis/realdeck/compare.js --runs <run dir>[,<run dir>...] --decks <deck file> --human <.human.json> ' +
    '[--online <human-summary.json or dir>] [--out file.json] [--permute N] [--min-games N] [--max-incomplete 0.10]';

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
    const deckFile = readDeckFile(args.decks);
    const r = compareRuns(args.runs.map(readRun), deckFile.raw, readJson(args.human), onlineFile ? readJson(onlineFile) : null,
        { permute: args.permute, minGames: args.minGames, maxIncomplete: args.maxIncomplete, deckSha256: deckFile.sha256 });
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
    CREDIT_DECKS, CREDIT_ONLINE, STYLES, MAX_INCOMPLETE, parseArgs, readDeckFile, botName, readRun, deckMeta, sortGames, wilson,
    fisherCI, shuffled, fitLogistic, fitStrengths, reliability, disattenuate, humanBradleyTerry, deckTallies, leftDecks,
    agreement, deckAgreement, signTestP, pairAgreement, leaderAgreement, splitHalves, splitHalf, styleSummary, compareRuns,
    summaryText
};
