'use strict';
/**
 * Runs a list of game jobs ({id, seed, p1, p2, replayFile?}) on ladder-worker.js threads. Shared by eval.js.
 *
 *   runJobs(jobs, { workers, maxSteps, capMs, hangMs, onResult }) -> Promise<[{ job, result }]>
 *
 * Same rules as ladder.js (bot/game-pool.js does the work): every bot is guarded with capMs of thinking per game
 * (default roster.thinkCapMs), a choose() call that runs longer than hangMs (default capMs + 30 s) is stopped by the
 * watchdog, and a bot that fails to load, throws, goes over the cap or hangs forfeits. result has winner (bot name),
 * winnerSeat, outcome ('won', 'forfeit', 'ERROR', ...), fault (null | 'p1' | 'p2') and faultKind; see ladder-worker.js.
 */
const { runPool } = require('../game-pool');
const { roster } = require('./home');

function runJobs(jobs, { workers = 1, maxSteps = 6000, capMs = roster().thinkCapMs ?? Infinity, hangMs = null, onResult = () => {} } = {}) {
    const results = [];
    hangMs ??= Number.isFinite(capMs) ? capMs + 30000 : 600000;
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
