'use strict';

/**
 * Deck-vs-deck games on worker threads, with the same pilot bot in both seats so that only the decks differ.
 *
 *   const { playDecks, pairJobs } = require('./play');
 *   const results = await playDecks(pairJobs([[deckA, deckB], ...], { firstSeed: 1, pilot: 'c-clock' }), { workers: 4, key });
 *
 * A job is { id, seed, p1, p2, pilots: [bot, bot], ...tags } with p1/p2 SWUDB-format lists (decks.js toList).
 * pairJobs plays every pair twice on one seed with the seats swapped, so seat and shuffle luck cancel within a pair.
 * Results: { id, ...tags, seed, p1, p2 (deck names), winner ('p1'|'p2'|null), outcome, round, steps, ms, error }.
 * Engine errors (outcome ERROR with no bot to blame) come back with winner null: leave them out of win rates.
 */
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

function pairJobs(pairs, { firstSeed = 1, pilot = 'c-clock', tag = null } = {}) {
    const jobs = [];
    pairs.forEach(([a, b, extra], i) => {
        const seed = firstSeed + i;
        const pilots = [`${pilot}#a`, `${pilot}#b`];
        const base = { ...(tag ? { tag } : {}), ...(extra ?? {}) };
        jobs.push({ id: `${seed}-a`, seed, p1: a, p2: b, pilots, ...base, aSeat: 'p1' });
        jobs.push({ id: `${seed}-b`, seed, p1: b, p2: a, pilots, ...base, aSeat: 'p2' });
    });
    return jobs;
}

async function playDecks(jobs, { workers = 4, key = null, maxSteps = 6000, out = null, log = true } = {}) {
    const results = [];
    const queue = [...jobs];
    const t0 = Date.now();
    if (out) {
        fs.mkdirSync(path.dirname(out), { recursive: true });
    }
    let done = 0;
    await new Promise((resolve, reject) => {
        let live = 0;
        const feed = (w) => {
            const job = queue.shift();
            if (!job) {
                w.postMessage('exit');
                return;
            }
            w.postMessage(job);
        };
        const byId = new Map(jobs.map((j) => [j.id, j]));
        for (let i = 0; i < Math.min(workers, queue.length); i++) {
            live++;
            const w = new Worker(path.join(__dirname, 'play-worker.js'), { workerData: { key, maxSteps } });
            w.on('message', (msg) => {
                if (msg.ready) {
                    feed(w);
                    return;
                }
                const job = byId.get(msg.job.id);
                const { p1, p2, pilots, ...tags } = job;
                const r = { ...tags, p1: p1.metadata.name, p2: p2.metadata.name, pilots, ...msg.result };
                results.push(r);
                if (out) {
                    fs.appendFileSync(out, `${JSON.stringify(r)}\n`);
                }
                done++;
                if (log && (done % 100 === 0 || done === jobs.length)) {
                    const s = (Date.now() - t0) / 1000;
                    process.stderr.write(`  ${done}/${jobs.length} games, ${(done / s).toFixed(2)}/s\n`);
                }
                feed(w);
            });
            w.on('error', reject);
            w.on('exit', () => {
                if (--live === 0) {
                    resolve();
                }
            });
        }
        if (live === 0) {
            resolve();
        }
    });
    return results;
}

/** Score of deck A in a result made by pairJobs: 1 win, 0 loss, 0.5 draw/step cap, null engine error. */
function scoreA(r) {
    if (r.outcome === 'ERROR' && !r.winner) {
        return null;
    }
    if (!r.winner) {
        return 0.5;
    }
    return r.winner === r.aSeat ? 1 : 0;
}

module.exports = { pairJobs, playDecks, scoreA };
