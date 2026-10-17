'use strict';
/**
 * Pure placement policy over real, exact-version results. Published point ratings remain the arena's Bradley-Terry
 * fit. Planning uses a full Fisher covariance, with the same prior=1 virtual draw, for target-minus-reference and
 * target-minus-peer contrasts. Seat twins of a known round/seed contribute one information unit; unknown-seed games of a pair
 * are conservatively one unit together. This is a scheduling approximation, not a calibrated confidence guarantee.
 * There is deliberately no battle budget here: a resource cap is an inconclusive stop owned by the caller.
 */
const { bradleyTerry } = require('../ratings');

const SCALE = 400 / Math.LN10;
const THRESHOLDS = Object.freeze({ targetSeElo: 100, minRelativeGain: 0.05 });
const MODEL_LIMITS = Object.freeze({ maxNodes: 256, maxObservations: 250000 });
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const name = (n) => typeof n === 'string' && n.length > 0;
const seedOK = (n) => Number.isSafeInteger(n) && n >= 0;
const uniqueNames = (ns) => [...new Set(ns)].sort(lexical);
const pair = (a, b) => JSON.stringify(a < b ? [a, b] : [b, a]);
const sigmoid = (z) => z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
const information = (z) => { const e = Math.exp(-Math.abs(z)); return e / (1 + e) ** 2; };

/** Identity aliases are unioned, so an id-only copy and a later seed-bearing copy still count exactly once. */
function observationsOf(input) {
    const rows = [];
    const parents = [];
    const identities = new Map();
    const root = (i) => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
    for (const g of input) {
        if (!g || !name(g.a) || !name(g.b) || g.a === g.b || ![0, 0.5, 1].includes(g.score) ||
            (g.seed !== undefined && g.seed !== null && !seedOK(g.seed)) ||
            (g.id !== undefined && g.id !== null && !name(g.id)) ||
            (g.scope !== undefined && g.scope !== null && typeof g.scope !== 'string')) return { error: 'invalid-results' };
        const hasSeed = seedOK(g.seed);
        const hasId = name(g.id);
        if (!hasSeed && !hasId) return { error: 'unidentified-results' };
        const forward = g.a < g.b;
        const row = { a: forward ? g.a : g.b, b: forward ? g.b : g.a, score: forward ? g.score : 1 - g.score,
            seat: forward ? 0 : 1, seed: hasSeed ? g.seed : null, id: hasId ? g.id : null, scope: g.scope ?? '' };
        const i = rows.length;
        rows.push(row);
        parents.push(i);
        const keys = [hasId ? `id:${g.id}` : null, hasSeed ? `seed:${JSON.stringify([row.scope, row.a, row.b, g.seed, row.seat])}` : null].filter(Boolean);
        for (const key of keys) {
            if (identities.has(key)) parents[root(i)] = root(identities.get(key));
            else identities.set(key, i);
        }
    }
    const groups = new Map();
    rows.forEach((g, i) => { const r = root(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(g); });
    const games = [];
    for (const group of groups.values()) {
        const first = group[0];
        const seeds = [...new Set(group.map((g) => g.seed).filter((s) => s !== null))];
        const scopes = uniqueNames(group.map((g) => g.scope).filter(Boolean));
        if (seeds.length > 1 || scopes.length > 1 || group.some((g) => g.a !== first.a || g.b !== first.b || g.score !== first.score || g.seat !== first.seat)) {
            return { error: 'data-conflict' };
        }
        games.push({ ...first, scope: scopes[0] ?? '', seed: seeds[0] ?? null, ids: uniqueNames(group.map((g) => g.id).filter(Boolean)) });
    }
    games.sort((a, b) => lexical(pair(a.a, a.b), pair(b.a, b.b)) || lexical(a.scope, b.scope) || (a.seed ?? -1) - (b.seed ?? -1) || a.seat - b.seat || lexical(a.ids[0] ?? '', b.ids[0] ?? ''));
    return { games, duplicates: input.length - games.length };
}

/** Cholesky inverse of the positive-definite prior plus graph Laplacian; no artificial precision is added. */
function inverse(matrix) {
    const n = matrix.length;
    const l = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let v = matrix[i][j];
            for (let k = 0; k < j; k++) v -= l[i][k] * l[j][k];
            if (i === j) {
                if (!(v > 0) || !Number.isFinite(v)) return null;
                l[i][j] = Math.sqrt(v);
            } else l[i][j] = v / l[j][j];
        }
    }
    const out = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let col = 0; col < n; col++) {
        const y = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
            let v = i === col ? 1 : 0;
            for (let k = 0; k < i; k++) v -= l[i][k] * y[k];
            y[i] = v / l[i][i];
        }
        for (let i = n - 1; i >= 0; i--) {
            let v = y[i];
            for (let k = i + 1; k < n; k++) v -= l[k][i] * out[k][col];
            out[i][col] = v / l[i][i];
        }
    }
    return out;
}

function components(names, games) {
    const edges = new Map(names.map((n) => [n, new Set()]));
    for (const g of games) { edges.get(g.a).add(g.b); edges.get(g.b).add(g.a); }
    const componentOf = new Map();
    for (const start of names) {
        if (componentOf.has(start)) continue;
        const members = new Set([start]);
        const pending = [start];
        while (pending.length) for (const n of edges.get(pending.pop())) if (!members.has(n)) { members.add(n); pending.push(n); }
        for (const n of members) componentOf.set(n, members);
    }
    return componentOf;
}

/** Seeds/ids to exclude from future dispatch; attempted/unrated games add no rating information or graph edges. */
function avoided(target, opponent, games, attempted) {
    const key = pair(target, opponent);
    const rows = [...games.filter((g) => pair(g.a, g.b) === key), ...attempted.filter((g) => g && pair(g.a, g.b) === key)];
    const seeds = [...new Set(rows.map((g) => g.seed).filter(seedOK))].sort((a, b) => a - b);
    const ids = uniqueNames(rows.flatMap((g) => g.ids ?? (name(g.id) ? [g.id] : [])));
    const knownIds = new Set(rows.filter((g) => seedOK(g.seed)).flatMap((g) => g.ids ?? (name(g.id) ? [g.id] : [])));
    const unknown = new Set(rows.filter((g) => !seedOK(g.seed) && !(g.ids ?? [g.id]).some((id) => knownIds.has(id)))
        .map((g, i) => (g.ids?.[0] ?? g.id) || `unknown-${i}`));
    return { avoidSeeds: seeds, avoidIds: ids, unknownSeedAttempts: unknown.size };
}

function select({ target, opponents = [], anchors = [], observations = [], attempted = [] } = {}) {
    const base = { state: 'waiting', reason: 'invalid-input', uncertainty: null, expectedGain: 0, expectedVarianceReduction: 0,
        connected: false, unanchored: !Array.isArray(anchors) || anchors.length === 0, reference: [], estimate: null,
        calibrationUncertainty: null, comparisons: [], observations: 0, effectiveUnits: 0,
        duplicates: 0, avoidSeeds: [], avoidIds: [], unknownSeedAttempts: 0, thresholds: { ...THRESHOLDS }, candidates: [] };
    if (!name(target) || !Array.isArray(opponents) || !opponents.every(name) || !Array.isArray(anchors) || !anchors.every(name) ||
        !Array.isArray(observations) || !Array.isArray(attempted)) return base;
    if (observations.length > MODEL_LIMITS.maxObservations || attempted.length > MODEL_LIMITS.maxObservations) return { ...base, reason: 'model-limit' };
    const parsed = observationsOf(observations);
    if (parsed.error) return { ...base, reason: parsed.error };
    const games = parsed.games;
    const choices = uniqueNames(opponents.filter((n) => n !== target));
    const own = uniqueNames(anchors);
    const names = uniqueNames([target, ...choices, ...own, ...games.flatMap((g) => [g.a, g.b])]);
    if (names.length > MODEL_LIMITS.maxNodes) return { ...base, reason: 'model-limit' };
    const idx = new Map(names.map((n, i) => [n, i]));
    const graph = components(names, games);
    const targetComponent = graph.get(target);
    const units = new Map();
    for (const g of games) {
        // Mirrored results remain separate in the BT point fit. They share one Fisher unit, even if only one seat
        // ended. With unknown seeds, conservatively pool that pair instead of guessing independent deals.
        const key = JSON.stringify([g.a, g.b, g.scope, g.seed === null ? 'unknown' : g.seed]);
        if (!units.has(key)) units.set(key, g);
    }
    const references = own.length ? own : (() => {
        const pools = [...new Set(choices.map((n) => graph.get(n)))];
        const evidence = new Map();
        for (const g of units.values()) { const pool = graph.get(g.a); evidence.set(pool, (evidence.get(pool) ?? 0) + 1); }
        pools.sort((a, b) => (evidence.get(b) ?? 0) - (evidence.get(a) ?? 0) || lexical([...a].sort(lexical)[0], [...b].sort(lexical)[0]));
        return pools.length ? [...pools[0]].filter((n) => n !== target).sort(lexical) : [];
    })();
    const diagnostics = { ...base, observations: games.length, effectiveUnits: units.size, duplicates: parsed.duplicates,
        reference: references, unanchored: own.length === 0,
        connected: [...own, ...choices].every((n) => targetComponent.has(n)) };
    if (!references.length || references.every((n) => n === target)) return { ...diagnostics, reason: 'no-reference' };

    const ratings = bradleyTerry(names, games);
    const theta = names.map((n) => (ratings[n] - 1500) / SCALE);
    // bradleyTerry returns centered log strengths. Recover the fixed-prior opponent's origin using the translation
    // score equation sum sigmoid(theta_i + offset) = n/2, preserving the existing prior rather than adding a ridge.
    const bound = Math.max(...theta.map(Math.abs), 0) + 50;
    let lo = -bound;
    let hi = bound;
    for (let i = 0; i < 100; i++) {
        const mid = (lo + hi) / 2;
        if (theta.reduce((s, t) => s + sigmoid(t + mid), 0) > names.length / 2) hi = mid;
        else lo = mid;
    }
    const offset = (lo + hi) / 2;
    const h = Array.from({ length: names.length }, (_, i) => names.map((_, j) => i === j ? information(theta[i] + offset) : 0));
    for (const g of units.values()) {
        const a = idx.get(g.a);
        const b = idx.get(g.b);
        const w = information(theta[a] - theta[b]);
        h[a][a] += w; h[b][b] += w; h[a][b] -= w; h[b][a] -= w;
    }
    const covariance = inverse(h);
    if (!covariance) return { ...diagnostics, reason: 'numerical-uncertainty' };
    const t = idx.get(target);
    const measured = (against) => {
        const contrast = names.map((_, i) => (i === t ? 1 : 0) - (against.includes(names[i]) ? 1 / against.length : 0));
        const cv = covariance.map((row) => row.reduce((s, v, i) => s + v * contrast[i], 0));
        const variance = contrast.reduce((s, v, i) => s + v * cv[i], 0);
        return { cv, variance, uncertainty: SCALE * Math.sqrt(variance),
            difference: ratings[target] - against.reduce((s, n) => s + ratings[n], 0) / against.length };
    };
    const calibration = measured(references);
    const comparisons = choices.map((opponent) => ({ opponent, ...measured([opponent]) }));
    const contrasts = [calibration, ...comparisons];
    if (contrasts.some((m) => !(m.variance > 0) || !Number.isFinite(m.variance))) return { ...diagnostics, reason: 'numerical-uncertainty' };
    const missingAnchors = own.filter((n) => !targetComponent.has(n));
    const candidates = choices.map((opponent) => {
        const o = idx.get(opponent);
        const w = information(theta[t] - theta[o]);
        const denominator = 1 + w * (covariance[t][t] + covariance[o][o] - 2 * covariance[t][o]);
        const gains = contrasts.map((m) => {
            const reduction = Math.max(0, w * (m.cv[t] - m.cv[o]) ** 2 / denominator);
            return { expectedGain: Math.max(0, Math.min(1, reduction / m.variance)), expectedVarianceReduction: reduction * SCALE ** 2 };
        }).sort((a, b) => b.expectedGain - a.expectedGain);
        const component = graph.get(opponent);
        return { opponent, ...gains[0],
            bridge: missingAnchors.some((n) => component.has(n)) ? 'reference' : !targetComponent.has(opponent) ? 'pool' : null,
            ...avoided(target, opponent, games, attempted) };
    });
    const gainOrder = (a, b) => {
        const delta = b.expectedGain - a.expectedGain;
        return Math.abs(delta) > 1e-12 ? delta : lexical(a.opponent, b.opponent);
    };
    candidates.sort(gainOrder);
    const referenceBridges = candidates.filter((c) => c.bridge === 'reference');
    const poolBridges = candidates.filter((c) => c.bridge === 'pool');
    const priority = referenceBridges.length ? referenceBridges : poolBridges.length ? poolBridges : candidates;
    const best = priority.find((c) => c.unknownSeedAttempts === 0);
    const potential = diagnostics.connected ? candidates[0] : priority[0];
    const answer = { ...diagnostics, uncertainty: Math.max(...contrasts.map((m) => m.uncertainty)),
        calibrationUncertainty: calibration.uncertainty, estimate: calibration.difference,
        comparisons: comparisons.map(({ opponent, difference, uncertainty }) => ({ opponent, difference, uncertainty })),
        expectedGain: potential?.expectedGain ?? 0, expectedVarianceReduction: potential?.expectedVarianceReduction ?? 0, candidates,
        ...(best ? avoided(target, best.opponent, games, attempted) : {}) };
    if (missingAnchors.length && !referenceBridges.length) return { ...answer, reason: 'no-reference-bridge' };
    if (answer.connected && answer.uncertainty <= THRESHOLDS.targetSeElo && answer.expectedGain < THRESHOLDS.minRelativeGain) {
        return { ...answer, state: 'complete', reason: 'information-sufficient' };
    }
    if (!best) return { ...answer, reason: priority.length ? 'unknown-seed-history' : 'no-opponents' };
    if (answer.connected && answer.expectedGain < THRESHOLDS.minRelativeGain) return { ...answer, reason: 'gain-plateau' };
    if (answer.connected && best.expectedGain < THRESHOLDS.minRelativeGain) return { ...answer, reason: 'unknown-seed-history' };
    return { ...answer, state: 'play', opponent: best.opponent,
        reason: best.bridge === 'reference' ? 'connect-reference' : best.bridge === 'pool' ? 'connect-pool' : 'reduce-uncertainty' };
}

module.exports = { select, THRESHOLDS, MODEL_LIMITS, SCALE };
