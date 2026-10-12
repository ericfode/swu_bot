import type { Evaluator, WinMap } from './lensFile';

/**
 * From a score to a chance that p1 wins. A file's chance comes from (spec 5.4, in order) the step's own p1Win, the
 * file's map applied to the edge (the byRound entry for the step's round, else the top level), or for log-odds the
 * logistic of the edge. A score with none of these has no chance; the viewer then sizes things with a stand-in
 * logistic(kEff·edge) and says so.
 */

/** fitted: a map fitted to results; model: the evaluator's own chance (p1Win, or log-odds); rough: a hand-set map; none: no chance */
export type Chance = 'fitted' | 'model' | 'rough' | 'none';

/**
 * 1 / (1 + e^−x), written through tanh so that sigmoid(−x) = 1 − sigmoid(x) exactly: mirrored plays get bit-identical
 * swings, and the earlier one stays first when they tie (as with the viewer's old 50·(1 + tanh(edge / 25))).
 */
export const sigmoid = (x: number) => 0.5 * (1 + Math.tanh(x / 2));
/** log-odds of p, with p clipped to [1e-6, 1 − 1e-6] */
export const logit = (p: number) => {
    const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
    return Math.log(q / (1 - q));
};

/** The parameters in force at a round: the first byRound entry with from <= round <= to, else the top level. */
export function mapAt(map: WinMap, round: number): WinMap {
    const r = map.byRound?.find((e) => e.from <= round && round <= e.to);
    if (!r) {
        return map;
    }
    return map.kind === 'logistic' ? { kind: 'logistic', k: r.k ?? map.k, b: r.b ?? map.b, fitted: map.fitted }
        : { kind: 'table', edge: r.edge ?? map.edge, p: r.p ?? map.p, fitted: map.fitted };
}

/** Linear between the table's points, flat past both ends. */
function tableAt(edge: number[], p: number[], x: number): number {
    if (x <= edge[0]) {
        return p[0];
    }
    const last = edge.length - 1;
    if (x >= edge[last]) {
        return p[last];
    }
    let k = 0;
    while (x > edge[k + 1]) {
        k++;
    }
    return p[k] + ((p[k + 1] - p[k]) * (x - edge[k])) / (edge[k + 1] - edge[k]);
}

/** P(p1 wins) from a map at an edge, at the given round (state.round of the replay snapshot; setup is round 0). */
export function winProb(map: WinMap, edge: number, round: number): number {
    const m = mapAt(map, round);
    // edge / (2 / k) and not k·edge / 2: for k = 0.08, 2 / k is exactly 25, so the rough map gives the very same bits as
    // the old (1 + tanh(edge / 25)) / 2 and the swings and pivotal picks of today's files stay identical
    return m.kind === 'logistic' ? 0.5 * (1 + Math.tanh(edge / (2 / m.k) + m.b / 2)) : tableAt(m.edge, m.p, edge);
}

/** The chance state of an evaluator; `stepP1Win`: every step of the file writes its own p1Win. */
export function chanceState(ev: Pick<Evaluator, 'unit' | 'toWinProb'>, stepP1Win: boolean): Chance {
    if (stepP1Win) {
        return 'model';
    }
    // a map that is not fitted is a hand-set guess (spec 5.4), log-odds or not; log-odds with no map are the model's own (C3)
    if (ev.toWinProb) {
        return ev.toWinProb.fitted ? 'fitted' : 'rough';
    }
    return ev.unit === 'logit' ? 'model' : 'none';
}

/**
 * Log-odds per unit of edge, which sets every display scale: a logistic map's top-level k (one length per point for
 * the whole game), 4 × a table's slope where p crosses 0.5, 1 for log-odds with no map, else 2 / typical.
 */
export function kEffOf(ev: Pick<Evaluator, 'unit' | 'toWinProb'>, typical: number): number {
    const m = ev.toWinProb;
    if (m?.kind === 'logistic' && m.k > 0) {
        return m.k;
    }
    if (m?.kind === 'table') {
        const { edge, p } = m;
        for (let i = 0; i + 1 < edge.length; i++) {
            if (p[i] <= 0.5 && p[i + 1] >= 0.5 && p[i + 1] > p[i]) {
                return (4 * (p[i + 1] - p[i])) / (edge[i + 1] - edge[i]);
            }
        }
        const slope = (p[p.length - 1] - p[0]) / (edge[edge.length - 1] - edge[0]);
        if (slope > 0) {
            return 4 * slope;
        }
    }
    if (ev.unit === 'logit') {
        return 1;
    }
    return 2 / typical;
}

/** v rounded up to 1, 2 or 5 × 10^k */
export function niceUp(v: number): number {
    if (!(v > 0) || !Number.isFinite(v)) {
        return 1;
    }
    const e = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 5, 10]) {
        const x = Number((m * e).toPrecision(12));
        if (x >= v * (1 - 1e-12)) {
            return x;
        }
    }
    return Number((10 * e).toPrecision(12));
}

/**
 * The |edge| that reads as "clearly ahead" (spec 5.11): scale.typical (the Omni v1 descriptor gives 25), 2 for
 * log-odds, else the 90th percentile of |edge| over the file, rounded up to 1, 2 or 5 × 10^k.
 */
export function typicalOf(ev: Pick<Evaluator, 'unit' | 'typical'>, edges: number[]): { value: number; from: 'file' | 'logit' | 'percentile' } {
    if (ev.typical != null && ev.typical > 0) {
        return { value: ev.typical, from: 'file' };
    }
    if (ev.unit === 'logit') {
        return { value: 2, from: 'logit' };
    }
    const abs = edges.filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
    const p90 = abs.length ? abs[Math.max(0, Math.ceil(0.9 * abs.length) - 1)] : 1;
    return { value: niceUp(p90), from: 'percentile' };
}
