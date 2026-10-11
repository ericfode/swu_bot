import type { LensStep } from '../data/lensFile';
import { scoreOfBoard, type ScoreSeries, type ScoreStep, type ScoreView } from '../data/score';
import { loadedCardCost } from '../lib/cardText';
import { displayScales } from '../data/format';
import type { Seat, Snapshot } from '../data/types';
import { NoScore, ScoreBreakdown } from './ScoreBreakdown';

const isView = (v: ScoreView | LensStep): v is ScoreView => 'source' in v && 'step' in v;

/**
 * The breakdown for one board, as earlier kit builds took it (ScoreBreakdown with a one-step series).
 * `lens` is the source and step to show (a bare lens step of earlier builds is read as "lens step (evaluator unknown)":
 * six rows, no rules, no chance; left out, the board is estimated with Omni v1; null: no score for this game).
 * `prevLens` is the step before, for the changes: a series step, or (earlier builds) a bare lens step for `prev`; with
 * `prev` and no `prevLens` the previous board is estimated with Omni v1 when the step shown is the estimate, else no
 * change is shown.
 */
export function EdgeBreakdown({ state, prev = null, bots, lens, prevLens = null, previewN = null }: {
    state: Snapshot; prev?: Snapshot | null; bots: Record<Seat, string>; lens?: ScoreView | LensStep | null; prevLens?: ScoreStep | LensStep | null;
    /** set while the pointer previews another step on the timeline: that step's Step.n */
    previewN?: number | null;
}) {
    // the estimate takes card cost from the loaded card data, as the viewer does
    const opts = { cardCost: loadedCardCost };
    const view = lens === undefined ? scoreOfBoard(state, true, opts) : lens === null ? null : isView(lens) ? lens : scoreOfBoard(state, lens, opts);
    // `prev` with no `prevLens` is estimated with Omni v1 only when the step shown is the estimate too: another
    // evaluator's rows are never compared with Omni v1's
    const before = prevLens != null && 'i' in prevLens && 'status' in prevLens ? prevLens
        : prev && (prevLens != null || view?.source.origin === 'estimate') ? scoreOfBoard(prev, prevLens ?? true, opts)?.step ?? null : null;
    if (!view) {
        return <NoScore />;
    }
    const step = view.step;
    const series: ScoreSeries = {
        source: view.source, steps: [step], scales: displayScales(view.source.kEff, view.source.unit),
        coverage: { file: 0, estimate: 0, held: 0, missing: 0, mismatch: 0, [step.status]: 1 }, unsplit: step.other ? 1 : 0
    };
    return <ScoreBreakdown series={series} step={step} prev={before} state={state} bots={bots} previewN={previewN} />;
}
