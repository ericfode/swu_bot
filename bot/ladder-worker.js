'use strict';
// Worker thread for ladder.js: loads the engine once, then plays the games it is sent.
const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const { Env } = require('./env');
const { playGame } = require('./match');
const { snapshot } = require('./recorder');
const { makeBot, closeBots } = require('./players');
const { gameKey } = require('./rng');

const env = new Env();
env.engineRev = workerData.engineRev ?? null;

parentPort.on('message', async (job) => {
    if (job === 'exit') {
        await closeBots();
        process.exit(0);
    }
    const bots = [];
    [job.p1, job.p2].forEach((n) => bots.push(makeBot(n, bots)));
    let onEvent = null;
    if (job.replayFile) {
        fs.mkdirSync(path.dirname(job.replayFile), { recursive: true });
        fs.writeFileSync(job.replayFile, '');
        onEvent = (e) => fs.appendFileSync(job.replayFile, `${JSON.stringify(e)}\n`);
    }
    const r = await playGame(env, { seed: job.seed, bots, key: workerData.key && gameKey(workerData.key, job.seed), maxSteps: workerData.maxSteps, record: !!job.replayFile, snapshot, onEvent });
    delete r.events;
    parentPort.postMessage({ job, result: r });
});
parentPort.postMessage({ ready: true });
