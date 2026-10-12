import type { End, IndexGame, Seat, SeatTiming } from './types';

const otherSeat = (s: Seat): Seat => (s === 'p1' ? 'p2' : 'p1');

/** The seat whose bot broke the game (v2: an ERROR with `by` set); it loses. null otherwise. */
export const failedSeat = (end: Pick<End, 'outcome' | 'by'> | null | undefined): Seat | null =>
    end?.outcome === 'ERROR' && (end.by === 'p1' || end.by === 'p2') ? end.by : null;

/** Who won: the end's winner, or the other seat when a bot broke the game; null when the game has no result. */
export function endWinner(end: End | null | undefined): Seat | 'draw' | null {
    const by = failedSeat(end);
    return by ? otherSeat(by) : end?.winner ?? null;
}

/** The result in words: "X wins", "Draw", "X failed (error); Y wins", or the outcome when there is no winner. */
export function resultText(end: End, bots: Record<Seat, string>): string {
    const by = failedSeat(end);
    if (by) {
        return `${bots[by]} failed (error); ${bots[otherSeat(by)]} wins`;
    }
    return end.winner === 'draw' ? 'Draw' : end.winner ? `${bots[end.winner]} wins` : end.outcome;
}

/** An index game's winning bot for the standings: a won game's winner, or the other bot when one broke the game; null when unrated. */
export function ratedWinner(g: IndexGame): string | null {
    const by = failedSeat(g);
    if (by) {
        return by === 'p1' ? g.p2 : g.p1;
    }
    return g.outcome === 'won' && g.winner ? g.winner : null;
}

/** The winning seat of an index game, the same rule. */
export function ratedSeat(g: IndexGame): Seat | 'draw' | null {
    const by = failedSeat(g);
    return by ? otherSeat(by) : g.outcome === 'won' ? g.winnerSeat : null;
}

/** A decision time: "0.42 ms", "38 ms", "1.3 s". */
export function fmtMs(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(2)} ms`;
}

/** One seat's timing in words, for a title. */
export function timingText(bot: string, t: SeatTiming): string {
    return `${bot}: ${t.n} decisions, ${fmtMs(t.ms)} in all; per decision p50 ${fmtMs(t.p50)}, p95 ${fmtMs(t.p95)}, max ${fmtMs(t.max)}`;
}
