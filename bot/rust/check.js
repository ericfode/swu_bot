'use strict';
// node bot/rust/check.js [gamesPerSeat] [startSeed] [cardJsonDir]
// Plays the Rust bots (bot/external-bots.json) on the real engine against random-a, both seats, and prints each game
// plus a win tally. Needs the release binary: cargo build --release --manifest-path bot/rust/Cargo.toml
const path = require('path');
const { Env } = require('../env');
const { playGame } = require('../match');
const { makeBot, closeBots } = require('../players');

(async () => {
    const n = Number(process.argv[2] ?? 5);
    const start = Number(process.argv[3] ?? 1);
    const env = process.argv[4] ? new Env(path.resolve(process.argv[4])) : new Env();
    const tally = {};
    let bad = 0;
    for (const bot of ['rust-random', 'rust-greedy']) {
        for (let seed = start; seed < start + n; seed++) {
            for (const seats of [[bot, 'random-a'], ['random-a', bot]]) {
                const bots = [];
                seats.forEach((name) => bots.push(makeBot(name, bots)));
                const r = await playGame(env, { seed, bots });
                const w = r.winner === 'p1' ? seats[0] : r.winner === 'p2' ? seats[1] : r.outcome;
                const key = `${bot} vs random-a`;
                tally[key] ??= { [bot]: 0, 'random-a': 0, other: 0 };
                tally[key][w in tally[key] ? w : 'other']++;
                bad += r.outcome === 'won' ? 0 : 1;
                console.log(JSON.stringify({ seed, p1: seats[0], p2: seats[1], outcome: r.outcome, winner: w, steps: r.steps, round: r.round, ms: r.ms, error: r.error ?? null }));
            }
        }
    }
    console.log(JSON.stringify(tally));
    await closeBots();
    process.exitCode = bad ? 1 : 0;
})();
