'use strict';
// Worker thread for play.js: loads the engine once, then plays the deck-vs-deck games it is sent.
const { parentPort, workerData } = require('worker_threads');
const { Env } = require('../env');
const { playGame } = require('../match');
const { makeBot, closeBots } = require('../players');
const { gameKey } = require('../rng');

const env = new Env();

parentPort.on('message', async (job) => {
    if (job === 'exit') {
        await closeBots();
        process.exit(0);
    }
    const bots = [];
    [job.pilots[0], job.pilots[1]].forEach((n) => bots.push(makeBot(n, bots)));
    let r;
    try {
        r = await playGame(env, {
            seed: job.seed, bots, decks: { p1: job.p1, p2: job.p2 },
            key: workerData.key && gameKey(workerData.key, job.seed), maxSteps: workerData.maxSteps
        });
        delete r.events;
    } catch (e) {
        r = { outcome: 'error', error: String(e?.message ?? e), steps: 0, round: 0, ms: 0 };
    }
    parentPort.postMessage({ job: { id: job.id }, result: { outcome: r.outcome, winner: r.winner, round: r.round, steps: r.steps, ms: r.ms, error: r.error ?? null } });
});
parentPort.postMessage({ ready: true });
