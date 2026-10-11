'use strict';
/**
 * Worker thread for ladder.js and arena/pool.js (both through game-pool.js): loads the engine once, then plays the
 * games it is sent. workerData: { maxSteps, engineRev, capMs, control, base }.
 *
 * Both bots are built here and guarded (players/guard.js) with the same capMs. Around every bot load and choose() call
 * the worker writes the seat and start time into the control array, so the parent's watchdog can stop a call that
 * never returns. The posted result is playGame's plus:
 *   winner      bot name, 'draw' or null      winnerSeat  'p1' | 'p2' | 'draw' | null
 *   fault       null | 'p1' | 'p2'            faultKind   null | 'load' | 'error' | 'time' | 'hang'
 *   think       { p1, p2 } guarded thinking time in ms (CPU for in-process bots); timing stays wall clock
 * Exactly one seat at fault (its bot failed to build, threw, or went over capMs): outcome 'forfeit', the other seat
 * wins. Both seats, or an engine error outside choose(): outcome 'ERROR', fault null.
 */
const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const { Env } = require('./env');
const { playGame, timingSummary } = require('./match');
const { snapshot } = require('./recorder');
const { makeBot } = require('./players');
const { guard } = require('./players/guard');
const { workerControl, forfeit, PHASE } = require('./game-pool');

const env = new Env();
env.engineRev = workerData.engineRev ?? null;
const capMs = workerData.capMs ?? Infinity;
const ctl = workerControl(workerData.control, workerData.base);
const firstLine = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);
const r3 = (x) => Math.round(x * 1000) / 1000;
const cpuMs = () => {
    const u = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null;
    return u ? (u.user + u.system) / 1000 : performance.now();
};

/** Builds and guards the bot for seat i (0 or 1); { bot } or { error }. */
function load(name, i) {
    ctl.set(PHASE.load, i + 1);
    try {
        const t0 = cpuMs();
        const bot = makeBot(name);
        const loadMs = cpuMs() - t0;
        if (!bot || typeof bot.choose !== 'function') {
            throw new Error('createBot() did not return a bot with a choose() method');
        }
        let game = null;
        let guarded = null;
        const hooks = {
            onEnter: (ctx) => {
                game = ctx?.game ?? null;
                ctl.set(PHASE.choose, i + 1);
            },
            onExit: () => {
                ctl.chose(i + 1, game?.round, guarded.thinkMs);
                ctl.set(PHASE.engine);
            }
        };
        // the engine only ever sees the guard's object, so a bot cannot unwrap the guard or reset its counters
        guarded = guard(bot, { capMs, loadMs, ...hooks });
        return { bot: guarded };
    } catch (e) {
        return { error: firstLine(e) };
    } finally {
        ctl.set(PHASE.engine);
    }
}

parentPort.on('message', async (job) => {
    if (job === 'exit') {
        process.exit(0);
    }
    const t0 = Date.now();
    ctl.newGame();
    const names = [job.p1, job.p2];
    const loaded = names.map(load);
    let r;
    if (loaded.some((x) => x.error)) {
        // a bot that cannot be built forfeits before the game starts (no replay)
        const bad = [0, 1].filter((i) => loaded[i].error);
        r = {
            seed: job.seed, steps: 0, outcome: 'ERROR', winner: null, winnerSeat: null, round: 0, ms: Date.now() - t0,
            error: bad.map((i) => `LOAD ${names[i]}: ${loaded[i].error}`).join('; ').slice(0, 300), fault: null, faultKind: null,
            botStats: loaded.map((x) => x.bot?.stats ?? null), timing: { p1: timingSummary([]), p2: timingSummary([]) }, think: { p1: 0, p2: 0 }
        };
        if (bad.length === 1) {
            Object.assign(r, forfeit(job, bad[0], 'load'));
        }
    } else {
        const bots = loaded.map((x) => x.bot);
        let onEvent = null;
        if (job.replayFile) {
            fs.mkdirSync(path.dirname(job.replayFile), { recursive: true });
            fs.writeFileSync(job.replayFile, '');
            // the end event is written below, once faults are settled
            onEvent = (e) => {
                if (e.t !== 'end') {
                    fs.appendFileSync(job.replayFile, `${JSON.stringify(e)}\n`);
                }
            };
        }
        r = await playGame(env, { seed: job.seed, bots, maxSteps: workerData.maxSteps, record: !!job.replayFile, snapshot, onEvent });
        delete r.events;
        r.winnerSeat = r.winner;
        r.winner = r.winner === 'p1' ? job.p1 : r.winner === 'p2' ? job.p2 : r.winner;
        r.fault = null;
        r.faultKind = null;
        r.think = { p1: r3(bots[0].thinkMs), p2: r3(bots[1].thinkMs) };
        const faulty = [0, 1].filter((i) => bots[i].fault);
        if (faulty.length === 1) {
            Object.assign(r, forfeit(job, faulty[0], bots[faulty[0]].fault.kind));
        } else if (faulty.length === 2) {
            Object.assign(r, { outcome: 'ERROR', winner: null, winnerSeat: null });
        }
        if (job.replayFile) {
            fs.appendFileSync(job.replayFile, `${JSON.stringify({ t: 'end', winner: r.winnerSeat, round: r.round, steps: r.steps, outcome: r.outcome, error: r.error ?? null, fault: r.fault, faultKind: r.faultKind })}\n`);
        }
    }
    ctl.set(PHASE.idle);
    parentPort.postMessage({ job, result: r });
});
parentPort.postMessage({ ready: true });
