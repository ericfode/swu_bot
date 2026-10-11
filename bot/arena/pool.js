'use strict';
/**
 * Runs a list of game jobs ({id, seed, p1, p2, replayFile?}) on ladder-worker.js threads. Shared by eval.js.
 *
 *   runJobs(jobs, { workers, maxSteps, capMs, hangMs, onResult }) -> Promise<[{ job, result }]>
 *
 * Same rules as ladder.js (bot/game-pool.js does the work): every bot is guarded with capMs of thinking per game
 * (default roster.thinkCapMs), a bot call that runs longer than hangMs (default 30 s past the 2x wall cap) is stopped by the
 * watchdog, and a bot that fails to load, throws, answers wrong, goes over the cap or hangs loses. result has winner
 * (bot name), winnerSeat, outcome ('won', 'ERROR', ...), by (null | 'p1' | 'p2': the seat whose bot broke the game)
 * and faultKind; see ladder-worker.js. Games are seeded from the seed alone (no key), so practice runs repeat exactly.
 */
const { runPool } = require('../game-pool');
const { roster } = require('./home');

function runJobs(jobs, { workers = 1, maxSteps = 6000, capMs = roster().thinkCapMs ?? Infinity, hangMs = null, onResult = () => {} } = {}) {
    const results = [];
    hangMs ??= Number.isFinite(capMs) ? 2 * capMs + 30000 : 600000;
    return runPool([...jobs], {
        workers,
        hangMs,
        workerData: { maxSteps, capMs },
        onResult: (msg) => {
            results.push(msg);
            onResult(msg);
        }
    }).then(() => results);
}

module.exports = { runJobs };
