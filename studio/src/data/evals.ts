import type { Game } from './types';

/** Position evaluations for one game: the dashboard's evals contract (dashboard/evals/<gameId>.json, schema 1). Every value is P(p1 wins), 0..1. */
export interface EvalPoint {
    step: number;
    round?: number;
    p1_subjective?: number;
    p2_subjective?: number;
    objective_state?: number;
    objective_hindsight?: number;
    note?: string;
}
export interface EvalFile {
    schema: number;
    gameId: string;
    tournament?: string;
    evaluator?: { model?: string; prompt?: string; note?: string };
    points: EvalPoint[];
}

export const EVAL_KEYS = [
    { key: 'p1_subjective', label: 'P1 view', hint: 'Player 1 judging from its own hand and the public board' },
    { key: 'p2_subjective', label: 'P2 view', hint: 'Player 2 judging from its own hand and the public board' },
    { key: 'objective_state', label: 'Both hands', hint: 'An observer who sees both hands and decks, but not the future' },
    { key: 'objective_hindsight', label: 'Hindsight', hint: 'An observer who knows how the game ends' }
] as const;
export type EvalKey = (typeof EVAL_KEYS)[number]['key'];

/** Points keyed by replay step index; steps are matched on Step.n. */
export function evalsByIndex(game: Game, evals: EvalFile | null | undefined): Map<number, EvalPoint> {
    const out = new Map<number, EvalPoint>();
    if (!evals?.points?.length) {
        return out;
    }
    const indexOfN = new Map(game.steps.map((s, i) => [s.n, i]));
    for (const p of evals.points) {
        const i = indexOfN.get(p.step);
        if (i != null) {
            out.set(i, p);
        }
    }
    return out;
}

/** The latest evaluated point at or before step index i. */
export function evalAt(byIndex: Map<number, EvalPoint>, i: number): { index: number; point: EvalPoint } | null {
    let best: { index: number; point: EvalPoint } | null = null;
    for (const [k, p] of byIndex) {
        if (k <= i && (!best || k > best.index)) {
            best = { index: k, point: p };
        }
    }
    return best;
}
