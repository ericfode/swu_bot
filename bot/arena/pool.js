'use strict';
// Runs a list of game jobs ({id, seed, p1, p2, replayFile?}) on ladder-worker.js threads. Shared by eval.js.
const path = require('path');
const { Worker } = require('worker_threads');

function runJobs(jobs, { workers = 1, maxSteps = 6000, onResult = () => {} } = {}) {
    const queue = [...jobs];
    const results = [];
    return new Promise((resolve, reject) => {
        let live = 0;
        const n = Math.max(1, Math.min(workers, queue.length));
        for (let i = 0; i < n; i++) {
            live++;
            const w = new Worker(path.join(__dirname, '..', 'ladder-worker.js'), { workerData: { maxSteps } });
            const feed = () => {
                const job = queue.shift();
                if (job) {
                    w.postMessage(job);
                } else {
                    w.postMessage('exit');
                }
            };
            w.on('message', (msg) => {
                if (msg.ready) {
                    feed();
                    return;
                }
                results.push(msg);
                onResult(msg);
                feed();
            });
            w.on('error', reject);
            w.on('exit', () => {
                if (--live === 0) {
                    resolve(results);
                }
            });
        }
        if (!queue.length && n === 0) {
            resolve(results);
        }
    });
}

module.exports = { runJobs };
