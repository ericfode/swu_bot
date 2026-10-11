'use strict';

/**
 * Ratings from a list of game results. Pure functions, no engine dependency.
 * A result is { a, b, score } where score is 1 (a won), 0 (b won) or 0.5 (draw).
 * Games that did not finish (ERROR, STUCK, STEP_CAP) should be left out by the caller.
 */

/** Sequential Elo in game order. Returns { ratings, history } where history[i] is the ratings after game i. */
function sequentialElo(names, results, { k = 24, start = 1500 } = {}) {
    const r = Object.fromEntries(names.map((n) => [n, start]));
    const history = [];
    for (const g of results) {
        const ea = 1 / (1 + 10 ** ((r[g.b] - r[g.a]) / 400));
        r[g.a] += k * (g.score - ea);
        r[g.b] -= k * (g.score - ea);
        history.push({ ...r });
    }
    return { ratings: r, history };
}

/**
 * Bradley-Terry maximum likelihood ratings on the Elo scale (order-independent, so better than sequential Elo for
 * a finished round robin). Fitted with the MM algorithm (Hunter 2004). Draws count as half a win each way.
 * `prior` adds that many virtual draws against an average opponent per bot, so an unbeaten bot gets a finite rating.
 * The scale is anchored so the mean rating is `mean`.
 */
function bradleyTerry(names, results, { prior = 1, iters = 500, mean = 1500 } = {}) {
    const n = names.length;
    const idx = new Map(names.map((x, i) => [x, i]));
    const wins = new Array(n).fill(prior / 2);
    const games = Array.from({ length: n }, () => new Array(n).fill(0));
    for (const g of results) {
        const i = idx.get(g.a);
        const j = idx.get(g.b);
        wins[i] += g.score;
        wins[j] += 1 - g.score;
        games[i][j]++;
        games[j][i]++;
    }
    let gamma = new Array(n).fill(1);
    for (let it = 0; it < iters; it++) {
        // the virtual opponent has fixed strength 1, which also pins the scale; without a prior, renormalise instead
        const next = gamma.map((gi, i) => {
            let denom = prior / (gi + 1);
            for (let j = 0; j < n; j++) {
                if (games[i][j]) {
                    denom += games[i][j] / (gi + gamma[j]);
                }
            }
            return denom > 0 ? wins[i] / denom : gi;
        });
        const norm = prior > 0 ? next : next.map((x) => x / geoMean(next));
        const delta = norm.reduce((m, x, i) => Math.max(m, Math.abs(x - gamma[i])), 0);
        gamma = norm;
        if (delta < 1e-10) {
            break;
        }
    }
    const g = geoMean(gamma);
    return Object.fromEntries(names.map((x, i) => [x, mean + 400 * Math.log10(gamma[i] / g)]));
}

function geoMean(xs) {
    return Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);
}

/** Wilson score interval for a win rate (draws count half). z = 1.96 is 95%. */
function wilson(score, n, z = 1.96) {
    if (!n) {
        return [0, 1];
    }
    const p = score / n;
    const d = 1 + (z * z) / n;
    const c = p + (z * z) / (2 * n);
    const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return [(c - s) / d, (c + s) / d];
}

/** Round-robin schedule: every unordered pair plays `perPair` games, alternating seats; seeds are paired so each
 *  seed is played once from each seat (random decks follow the seat, so mirrored seeds cancel deck luck). */
function roundRobin(names, perPair, firstSeed = 1) {
    const out = [];
    let seed = firstSeed;
    const even = perPair + (perPair % 2);
    for (let a = 0; a < names.length; a++) {
        for (let b = a + 1; b < names.length; b++) {
            for (let k = 0; k < even; k += 2, seed++) {
                out.push({ seed, p1: names[a], p2: names[b] });
                out.push({ seed, p1: names[b], p2: names[a] });
            }
        }
    }
    return out;
}

/**
 * Gauntlet: every challenger plays every opponent (not each other), same seeds and seat swaps as roundRobin.
 * Seeds are reused across challengers, so all challengers face the same decks: their results compare directly.
 */
function gauntlet(challengers, opponents, perPair, firstSeed = 1) {
    const out = [];
    const even = perPair + (perPair % 2);
    for (const a of challengers) {
        let seed = firstSeed;
        for (const b of opponents) {
            for (let k = 0; k < even; k += 2, seed++) {
                out.push({ seed, p1: a, p2: b });
                out.push({ seed, p1: b, p2: a });
            }
        }
    }
    return out;
}

module.exports = { sequentialElo, bradleyTerry, wilson, roundRobin, gauntlet };
