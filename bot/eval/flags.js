#!/usr/bin/env node
'use strict';
/**
 * Find the moments where what a player did disagrees with the board: a concession while the board favoured the
 * player who conceded, and single actions after which the acting player's chance to win dropped sharply (likely
 * blunders). The board is judged by an evaluator in the spectator view (neither hand visible), so the same check can
 * run on a live spectated game.
 *
 *   node bot/eval/flags.js --data <dataset dir>[,...] [--eval mlp-g5] [--drop 0.25] [--ahead 0.5] [--lethal 0]
 *                          [--tournament karabuddy-public] [--json out.json]
 *
 * Datasets are replays.js output. A game "ends by concession" when the loser's base still has more than --lethal HP
 * on the final frame (one-seat captures cannot tell a concession from a disconnect or a timeout). A blunder candidate is
 * an action-window checkpoint after which, within the same round, the actor's chance fell by at least --drop by the
 * next checkpoint. The next checkpoint can include the opponent's reply, so these are leads to watch, not proof.
 * With --tournament each flag gets a viewer link (#/t/<tournament>/g/<game>?step=<n>).
 */
const fs = require('fs');
const { loadPositions } = require('./data');
const { loadEvaluator } = require('./evaluators');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const other = (seat) => (seat === 'p1' ? 'p2' : 'p1');
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Flags for one game's positions (sorted by step). pOf(pos, seat) = that seat's chance to win. */
function flagGame(ps, pOf, { drop = 0.25, ahead = 0.5, lethal = 0 } = {}) {
    const last = ps[ps.length - 1];
    const loser = other(last.winner);
    // base HP the loser had left on the final frame; older datasets without endLeft fall back to the last checkpoint,
    // which comes before the deciding action and so overcounts concessions
    const base = last.state.players?.[loser]?.base;
    const left = last.endLeft?.[loser] ?? (base ? base.hp - base.d : 0);
    const ending = left > lethal ? 'concession' : 'lethal';
    const pLoserAtEnd = pOf(last, loser);
    const blunders = [];
    for (let i = 0; i + 1 < ps.length; i++) {
        const a = ps[i];
        const b = ps[i + 1];
        // a new round brings draws and resources that no player chose; only compare inside one round
        if (!a.toAct || a.round !== b.round) {
            continue;
        }
        const before = pOf(a, a.toAct);
        const after = pOf(b, a.toAct);
        if (before - after >= drop) {
            blunders.push({ n: a.n, round: a.round, actor: a.toAct, before: r3(before), after: r3(after) });
        }
    }
    return {
        id: last.id, source: last.source, winner: last.winner, rounds: last.round, ending, loserBaseLeft: left, pLoserAtEnd: r3(pLoserAtEnd),
        concededAhead: ending === 'concession' && pLoserAtEnd >= ahead, lastStep: last.n, blunders
    };
}

function main() {
    const dirs = arg('data', '').split(',').filter(Boolean);
    if (!dirs.length) {
        console.error('usage: node bot/eval/flags.js --data <dataset dir>[,...] [--eval mlp-g5] [--json out.json]');
        process.exit(2);
    }
    const evName = arg('eval', 'mlp-g5');
    const ev = loadEvaluator(evName);
    const opts = { drop: Number(arg('drop', 0.25)), ahead: Number(arg('ahead', 0.5)), lethal: Number(arg('lethal', 0)) };
    const tournament = arg('tournament', null);
    const games = new Map();
    for (const p of loadPositions(dirs, { testShare: 0 })) {
        // the same game id can appear in two datasets (same bot names and seeds), so key by source too
        const key = `${p.source}\u0000${p.id}`;
        (games.get(key) ?? games.set(key, []).get(key)).push(p);
    }
    const pOf = (p, seat) => ev.predict(p.state, seat, { view: 'spectator', decks: p.decks, toAct: p.toAct });
    const link = (id, n) => (tournament ? `#/t/${tournament}/g/${id}?step=${n}` : undefined);
    const out = [];
    for (const ps of games.values()) {
        ps.sort((a, b) => a.n - b.n);
        const g = flagGame(ps, pOf, opts);
        if (tournament) {
            g.link = link(g.id, g.lastStep);
            for (const bl of g.blunders) {
                bl.link = link(g.id, bl.n);
            }
        }
        out.push(g);
    }
    const conceded = out.filter((g) => g.ending === 'concession');
    const ahead = conceded.filter((g) => g.concededAhead);
    const blunders = out.flatMap((g) => g.blunders.map((b) => ({ id: g.id, winner: g.winner, ...b })));
    const summary = {
        evaluator: evName, view: 'spectator', ...opts, games: out.length, concessions: conceded.length, concededAhead: ahead.length,
        blunderCandidates: blunders.length, gamesWithBlunder: out.filter((g) => g.blunders.length).length,
        blundersByLoser: blunders.filter((b) => b.winner !== b.actor).length
    };
    console.log(`${summary.games} games: ${summary.concessions} end by concession, ${summary.concededAhead} of them while the board favoured the player who conceded`);
    console.log(`${summary.blunderCandidates} blunder candidates (drop >= ${opts.drop}) in ${summary.gamesWithBlunder} games; ${summary.blundersByLoser} by the player who lost`);
    for (const g of ahead.sort((a, b) => b.pLoserAtEnd - a.pLoserAtEnd).slice(0, 10)) {
        console.log(`  conceded ahead: ${g.id} round ${g.rounds}, ${(100 * g.pLoserAtEnd).toFixed(0)}% for the conceder, base ${g.loserBaseLeft} left${g.link ? ' ' + g.link : ''}`);
    }
    const json = arg('json', null);
    if (json) {
        fs.writeFileSync(json, JSON.stringify({ summary, games: out }, null, 1));
    }
}

if (require.main === module) {
    main();
}

module.exports = { flagGame };
