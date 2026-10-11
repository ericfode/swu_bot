'use strict';
/*
 * Position evaluations as a fitness signal for bots, and as a check on the evaluator itself.
 *
 *   node analysis/fitness.js <analysis.json | dir> [...] [--view objective] [--blunder 0.12] [--json]
 *
 * Per game, for every checkpoint the change in the chosen view's P(win) is credited to the player who acted in
 * that turn (in that player's own frame). Summed over a game, a player's credit plus the opponent's equals the
 * final minus the starting value, so credit splits the result between the two players' decisions.
 *
 *   credit/turn   mean change in own win probability per own turn: the decision-quality fitness
 *   blunders      own turns that cost more than --blunder (default 0.12) win probability
 *   brier         mean (P(p1 wins) - outcome)^2 per view: how well that view predicts the result
 *   info gap      mean |subjective - objective|: how much the hidden hand mattered to that player
 *   hindsight gap mean |objective - omniscient|: how much the future (draws, later play) was still open
 *
 * Draws in the regroup phase are credited to whoever acted last, so per-turn credit is noisy; aggregate many
 * games before comparing bots.
 */

const fs = require('fs');
const path = require('path');

const VIEWS = ['subjective_p1', 'subjective_p2', 'objective', 'omniscient'];
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function series(a, view) {
    return a.checkpoints.map((c) => c.views[view]?.p1 ?? null);
}

/** Fitness and evaluator-quality numbers for one analysis file. */
function gameFitness(a, { view = 'objective', blunder = 0.12 } = {}) {
    const outcome = a.game.winner === 'p1' ? 1 : a.game.winner === 'p2' ? 0 : a.game.winner === 'draw' ? 0.5 : null;
    const v = series(a, view);
    const seats = {};
    for (const p of a.game.players) {
        seats[p.id] = { bot: p.bot, turns: 0, credit: 0, blunders: 0, worst: null, best: null };
    }
    let prev = null;
    a.checkpoints.forEach((c, j) => {
        if (v[j] == null) {
            return;
        }
        if (prev != null && c.actor && seats[c.actor]) {
            const d = (v[j] - prev) * (c.actor === 'p1' ? 1 : -1);
            const s = seats[c.actor];
            s.turns++;
            s.credit += d;
            if (d < -blunder) {
                s.blunders++;
            }
            if (!s.worst || d < s.worst.delta) {
                s.worst = { i: c.i, step: c.step, delta: Number(d.toFixed(3)), actions: c.actions };
            }
            if (!s.best || d > s.best.delta) {
                s.best = { i: c.i, step: c.step, delta: Number(d.toFixed(3)), actions: c.actions };
            }
        }
        prev = v[j];
    });
    for (const s of Object.values(seats)) {
        s.creditPerTurn = s.turns ? s.credit / s.turns : null;
    }

    const views = {};
    for (const w of VIEWS) {
        const xs = series(a, w).filter((x) => x != null);
        if (!xs.length) {
            continue;
        }
        views[w] = { n: xs.length, brier: outcome == null ? null : mean(xs.map((x) => (x - outcome) ** 2)) };
    }
    const gap = (x, y) => {
        const sx = series(a, x);
        const sy = series(a, y);
        const ds = sx.map((p, j) => (p != null && sy[j] != null ? Math.abs(p - sy[j]) : null)).filter((d) => d != null);
        return mean(ds);
    };
    return {
        game: a.game.id,
        evaluator: a.evaluator,
        view,
        outcome: a.game.winner,
        seats,
        views,
        gaps: { info_p1: gap('subjective_p1', 'objective'), info_p2: gap('subjective_p2', 'objective'), hindsight: gap('objective', 'omniscient') }
    };
}

/** Aggregate per bot over many games: the number a tuner or a training loop would optimise. */
function botFitness(results) {
    const bots = {};
    for (const r of results) {
        for (const [seat, s] of Object.entries(r.seats)) {
            const b = (bots[s.bot] ??= { bot: s.bot, games: 0, wins: 0, turns: 0, credit: 0, blunders: 0 });
            b.games++;
            b.wins += r.outcome === seat ? 1 : 0;
            b.turns += s.turns;
            b.credit += s.credit;
            b.blunders += s.blunders;
        }
    }
    return Object.values(bots).map((b) => ({ ...b, winRate: b.wins / b.games, creditPerTurn: b.turns ? b.credit / b.turns : null, blundersPer100: b.turns ? (100 * b.blunders) / b.turns : null }))
        .sort((x, y) => (y.creditPerTurn ?? 0) - (x.creditPerTurn ?? 0));
}

function files(p) {
    if (fs.statSync(p).isFile()) {
        return [p];
    }
    return fs.readdirSync(p).filter((f) => f.endsWith('.json')).map((f) => path.join(p, f));
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    const opt = (k, d) => {
        const i = argv.indexOf(`--${k}`);
        return i >= 0 ? argv[i + 1] : d;
    };
    const paths = argv.filter((x, i) => !x.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--json'));
    const analyses = paths.flatMap(files).map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))).filter((a) => a.t === 'analysis');
    const view = opt('view', 'objective');
    const results = analyses.map((a) => gameFitness(a, { view, blunder: Number(opt('blunder', 0.12)) }));
    const bots = botFitness(results);
    if (argv.includes('--json')) {
        console.log(JSON.stringify({ view, games: results, bots }, null, 1));
    } else {
        const f = (x, d = 3) => (x == null ? '-' : x.toFixed(d));
        console.log(`view: ${view}, ${results.length} game(s)\n`);
        console.log('bot'.padEnd(24) + 'games  win%   credit/turn  blunders/100');
        for (const b of bots) {
            console.log(`${b.bot.padEnd(24)}${String(b.games).padEnd(7)}${f(100 * b.winRate, 0).padEnd(7)}${f(b.creditPerTurn, 4).padEnd(13)}${f(b.blundersPer100, 1)}`);
        }
        console.log('\nevaluator (lower brier = better predictor of the result):');
        for (const r of results) {
            const vs = Object.entries(r.views).map(([k, x]) => `${k} ${f(x.brier)}`).join('  ');
            console.log(`  ${r.game} [${r.evaluator.model}]: ${vs} | info gap p1 ${f(r.gaps.info_p1)} p2 ${f(r.gaps.info_p2)}, hindsight gap ${f(r.gaps.hindsight)}`);
        }
    }
}

module.exports = { gameFitness, botFitness };
