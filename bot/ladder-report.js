'use strict';

/**
 * Builds the ladder results document (schema "swu-ladder/1") from finished games. Pure, no engine dependency.
 *
 * A game record: { id, seed, p1, p2, winner, winnerSeat, outcome, rounds, steps, ms, error, fault, faultKind, botStats }
 * where winner is a bot name, 'draw' or null. Outcomes 'won' and 'forfeit' (one seat's bot failed to load, threw, went
 * over the time cap or hung: fault is that seat, winner the other bot) count towards ratings; ERROR / STUCK / STEP_CAP
 * games are kept in the list and counted under `incomplete` so engine bugs stay visible. Each bot row also counts the
 * games it forfeited (`forfeits`, included in its losses).
 */
const { sequentialElo, bradleyTerry, wilson } = require('./ratings');

const isDecided = (g) => g.outcome === 'won' || g.outcome === 'forfeit';

function scoreOf(g) {
    if (!isDecided(g)) {
        return null;
    }
    if (g.winner === 'draw') {
        return 0.5;
    }
    return g.winner === g.p1 ? 1 : g.winner === g.p2 ? 0 : null;
}

function summarize({ id, createdAt, status, engine, config, botInfo, games, scheduled }) {
    const names = config.bots;
    const finished = games.filter((g) => g.outcome !== 'running');
    const results = [];
    for (const g of finished) {
        const s = scoreOf(g);
        if (s !== null) {
            results.push({ a: g.p1, b: g.p2, score: s });
        }
    }
    const { ratings: elo, history } = sequentialElo(names, results);
    const bt = bradleyTerry(names, results);

    const bots = names.map((name) => {
        const mine = finished.filter((g) => g.p1 === name || g.p2 === name);
        const row = { name, ...(botInfo?.[name] ?? {}), games: mine.length, wins: 0, losses: 0, draws: 0, incomplete: 0, forfeits: 0, asP1: { games: 0, wins: 0 }, msPerWindow: null };
        let ms = 0;
        let windows = 0;
        for (const g of mine) {
            const seat = g.p1 === name ? 0 : 1;
            if (seat === 0) {
                row.asP1.games++;
            }
            const st = g.botStats?.[seat];
            if (st?.windows && st.ms !== undefined) {
                ms += st.ms;
                windows += st.windows;
            }
            if (g.fault === (seat === 0 ? 'p1' : 'p2')) {
                row.forfeits++;
            }
            if (!isDecided(g)) {
                row.incomplete++;
            } else if (g.winner === 'draw') {
                row.draws++;
            } else if (g.winner === name) {
                row.wins++;
                if (seat === 0) {
                    row.asP1.wins++;
                }
            } else {
                row.losses++;
            }
        }
        const decided = row.wins + row.losses + row.draws;
        const score = row.wins + row.draws / 2;
        row.winRate = decided ? score / decided : null;
        row.winRateCI95 = decided ? wilson(score, decided) : null;
        row.elo = Math.round(elo[name]);
        row.btElo = Math.round(bt[name]);
        row.msPerWindow = windows ? Math.round(ms / windows) : null;
        return row;
    });

    const pairs = [];
    for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
            const [a, b] = [names[i], names[j]];
            const gs = finished.filter((g) => (g.p1 === a && g.p2 === b) || (g.p1 === b && g.p2 === a));
            const p = { a, b, games: gs.length, aWins: 0, bWins: 0, draws: 0, incomplete: 0 };
            for (const g of gs) {
                if (!isDecided(g)) {
                    p.incomplete++;
                } else if (g.winner === 'draw') {
                    p.draws++;
                } else if (g.winner === a) {
                    p.aWins++;
                } else {
                    p.bWins++;
                }
            }
            const decided = p.aWins + p.bWins + p.draws;
            p.aScore = decided ? (p.aWins + p.draws / 2) / decided : null;
            pairs.push(p);
        }
    }

    const outcomes = {};
    for (const g of finished) {
        outcomes[g.outcome] = (outcomes[g.outcome] ?? 0) + 1;
    }
    // seat advantage from played-out games only (a forfeit says nothing about the seat)
    const p1Decided = finished.filter((g) => g.outcome === 'won').map(scoreOf).filter((x) => x === 0 || x === 1);

    return {
        schema: 'swu-ladder/1',
        id,
        status,
        createdAt,
        updatedAt: new Date().toISOString(),
        engine,
        config,
        progress: { scheduled, finished: finished.length, rated: results.length, outcomes },
        firstSeatWinRate: p1Decided.length ? p1Decided.filter((x) => x === 1).length / p1Decided.length : null,
        bots: bots.sort((x, y) => y.btElo - x.btElo),
        pairs,
        // Elo after each rated game, in finish order (for rating-over-time charts)
        eloHistory: history.map((h, i) => ({ n: i + 1, ...Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Math.round(v)])) })),
        games
    };
}

module.exports = { summarize, scoreOf };
