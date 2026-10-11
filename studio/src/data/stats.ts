import type { IndexGame } from './types';
import { failedSeat, ratedSeat, ratedWinner } from './result';

export interface BotRow {
    bot: string;
    games: number;
    wins: number;
    losses: number;
    draws: number;
    errors: number;
    /** losses because this bot broke the game (v2: an ERROR with `by` set); counted in losses too */
    failed: number;
    elo: number;
    /** Last results, oldest first: W, L, D. */
    form: ('W' | 'L' | 'D')[];
    avgRounds: number;
}

// rated: won, or an ERROR a bot caused (that bot loses); an ERROR with by null, STEP_CAP and STUCK have no result
const finished = (g: IndexGame) => ratedWinner(g) != null;

/**
 * Win/loss table and sequential Elo (K=24) in play order, the same rules as the original viewer's stats.ts, plus the
 * v2 rule: an ERROR with `by` set is a loss for that bot and a win for the other.
 */
export function standings(bots: string[], games: IndexGame[]): { rows: BotRow[]; history: Record<string, number>[] } {
    const rows = new Map<string, BotRow & { roundSum: number }>(
        bots.map((b) => [b, { bot: b, games: 0, wins: 0, losses: 0, draws: 0, errors: 0, failed: 0, elo: 1000, form: [], avgRounds: 0, roundSum: 0 }])
    );
    const history: Record<string, number>[] = [Object.fromEntries(bots.map((b) => [b, 1000]))];
    for (const g of games) {
        const a = rows.get(g.p1);
        const b = rows.get(g.p2);
        if (!a || !b || g.outcome === 'running') {
            continue;
        }
        if (!finished(g)) {
            a.errors++;
            b.errors++;
            continue;
        }
        a.games++;
        b.games++;
        a.roundSum += g.rounds;
        b.roundSum += g.rounds;
        const won = ratedWinner(g);
        const sa = won === 'draw' ? 0.5 : won === g.p1 ? 1 : 0;
        const by = failedSeat(g);
        if (by) {
            (by === 'p1' ? a : b).failed++;
        }
        const ra = sa === 1 ? 'W' : sa === 0 ? 'L' : 'D';
        const rb = sa === 1 ? 'L' : sa === 0 ? 'W' : 'D';
        a.form.push(ra);
        b.form.push(rb);
        if (sa === 1) {
            a.wins++;
            b.losses++;
        } else if (sa === 0) {
            b.wins++;
            a.losses++;
        } else {
            a.draws++;
            b.draws++;
        }
        const ea = 1 / (1 + 10 ** ((b.elo - a.elo) / 400));
        a.elo += 24 * (sa - ea);
        b.elo += 24 * ((1 - sa) - (1 - ea));
        history.push(Object.fromEntries([...rows.values()].map((r) => [r.bot, Math.round(r.elo)])));
    }
    const out = [...rows.values()].map(({ roundSum, ...r }) => ({ ...r, avgRounds: r.games ? roundSum / r.games : 0 }));
    return { rows: out.sort((x, y) => y.elo - x.elo), history };
}

/** Row bot's wins against column bot, over finished games between the two. */
export function headToHead(games: IndexGame[], row: string, col: string): { wins: number; n: number } {
    let wins = 0;
    let n = 0;
    for (const g of games) {
        const pair = (g.p1 === row && g.p2 === col) || (g.p1 === col && g.p2 === row);
        if (!pair || !finished(g)) {
            continue;
        }
        n++;
        if (ratedWinner(g) === row) {
            wins++;
        }
    }
    return { wins, n };
}

/** How often the first seat (p1) wins, over finished games. */
export function seatEdge(games: IndexGame[]): { p1: number; n: number } {
    const done = games.filter(finished);
    return { p1: done.filter((g) => ratedSeat(g) === 'p1').length, n: done.length };
}
