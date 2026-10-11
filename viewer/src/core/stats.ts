import type { IndexGame } from './types';

/** A game with a result: won, or an ERROR a bot caused (`by`), which that bot loses. */
const decided = (g: IndexGame) => !!g.winner && (g.outcome === 'won' || (g.outcome === 'ERROR' && !!g.by));

export interface BotRow { bot: string; games: number; wins: number; losses: number; draws: number; errors: number; elo: number }

/** Win/loss table plus a simple sequential Elo (K=24) in play order. */
export function standings(bots: string[], games: IndexGame[]): BotRow[] {
    const rows = new Map<string, BotRow>(bots.map((b) => [b, { bot: b, games: 0, wins: 0, losses: 0, draws: 0, errors: 0, elo: 1000 }]));
    for (const g of games) {
        const a = rows.get(g.p1);
        const b = rows.get(g.p2);
        if (!a || !b) {
            continue;
        }
        if (g.outcome === 'running') {
            continue;
        }
        if (g.outcome === 'ERROR') {
            // charged to the bot that caused it, or to both when the engine did
            for (const [seat, row] of [['p1', a], ['p2', b]] as const) {
                if (!g.by || g.by === seat) {
                    row.errors++;
                }
            }
        }
        if (!decided(g)) {
            continue;
        }
        a.games++;
        b.games++;
        const sa = g.winner === 'draw' ? 0.5 : g.winner === g.p1 ? 1 : 0;
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
    }
    return [...rows.values()].sort((x, y) => y.elo - x.elo);
}

/** Row bot's win rate against column bot, over finished games between the two. */
export function headToHead(games: IndexGame[], row: string, col: string): { wins: number; n: number } {
    let wins = 0;
    let n = 0;
    for (const g of games) {
        const pair = (g.p1 === row && g.p2 === col) || (g.p1 === col && g.p2 === row);
        if (!pair || !decided(g)) {
            continue;
        }
        n++;
        if (g.winner === row) {
            wins++;
        }
    }
    return { wins, n };
}
