import type { Game, Snapshot } from './types';
import type { LensFile, LensSide, LensStep, Weights } from './lensFile';
import { estimateOmniV1, OMNI_V1_WEIGHTS } from './omniV1';
import { zonesFit } from './score';

/**
 * Deprecated: the lens types and helpers of earlier builds, kept for one release so kit callers keep working. The
 * contract lives in lensFile.ts, the built-in Omni v1 score in omniV1.ts, and every view reads a resolved series
 * (score.ts) instead of these.
 */
export type { LensEvaluator, LensFile, LensIndex, LensSearch, LensSide, LensStep, TermDef, Weights, WinMap } from './lensFile';

/** @deprecated a ScoreStep (score.ts) carries the values, the status and the weights of a step */
export interface LensView extends LensStep {
    p1: LensSide;
    p2: LensSide;
    /** read from the lens file; otherwise the Omni v1 estimate */
    exact: boolean;
    weights: Weights;
}

/** @deprecated Omni v1 computed from a snapshot alone (no cost term); use estimateOmniV1 (omniV1.ts) */
export function estimateLens(s: Snapshot, w: Weights = OMNI_V1_WEIGHTS): LensStep {
    return estimateOmniV1(s, w);
}

/** @deprecated Lens steps keyed by replay step index (matched on Step.n); use resolveScore (score.ts) */
export function lensByIndex(game: Game, lens: LensFile | null | undefined): Map<number, LensStep> {
    const out = new Map<number, LensStep>();
    if (!lens?.steps?.length) {
        return out;
    }
    const indexOfN = new Map(game.steps.map((s, i) => [s.n, i]));
    for (const st of lens.steps) {
        const i = indexOfN.get(st.n);
        if (i != null) {
            out.set(i, st);
        }
    }
    return out;
}

/**
 * @deprecated The lens at step index i, as earlier builds read it: the step from `byIndex` when it lines up with the
 * board, else the Omni v1 estimate; weights are the file's over the Omni v1 ones. Use resolveScore (score.ts).
 * Not a wrapper over the series on purpose: the series never fills a file's gaps or weights from Omni v1 (W1), and
 * earlier callers expect exactly that merge, so the numbers stay as they were.
 */
export function lensAt(game: Game, i: number, byIndex: Map<number, LensStep>, lens?: LensFile | null): LensView {
    const w = { ...OMNI_V1_WEIGHTS, ...(lens?.weights ?? {}) };
    const s = game.steps[i].state;
    const st = byIndex.get(i);
    if (st && st.p1 && st.p2 && zonesFit(st.p1, s.players.p1) && zonesFit(st.p2, s.players.p2)) {
        return { ...st, p1: st.p1!, p2: st.p2!, exact: true, weights: w };
    }
    return { ...estimateOmniV1(s, w), n: game.steps[i].n, exact: false, weights: w };
}
