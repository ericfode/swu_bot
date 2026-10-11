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
// Submitted bots run in this thread and get the same module object from require('worker_threads') (and import()):
// take the parent's channel and the watchdog's control array out of it, so a bot cannot post a result of its own or
// mark itself idle. Not a sandbox (a bot still shares this thread); the parent's per-game limit backs this up.
for (const k of ['parentPort', 'workerData']) {
    Object.defineProperty(require('worker_threads'), k, { value: null, writable: false, configurable: false });
}
const { AsyncLocalStorage } = require('async_hooks');
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

// Which bot started the async work that is running. Timers and promises a bot creates in createBot() or choose() carry
// { game, seat } from that call, so a delayed throw or rejection that kills the worker is that bot's forfeit (the parent
// reads the seat from the control array) rather than an unrated ERROR. Work left over from an earlier game (whose result
// is already in) marks the worker idle, so the parent plays the interrupted job again on a fresh worker.
const origin = new AsyncLocalStorage();
let thisGame = null;
process.on('uncaughtException', (e) => {
    const o = origin.getStore();
    if (o && o.game === thisGame) {
        ctl.set(PHASE.choose, o.seat);
    } else if (o) {
        ctl.set(PHASE.idle);
        throw new Error(`async work left by ${o.name} from an earlier game: ${firstLine(e)}`);
    }
    throw e; // the worker dies as before
});
const r3 = (x) => Math.round(x * 1000) / 1000;
// bound before any bot loads, so a bot that replaces process.threadCpuUsage while it loads cannot shrink its load time
const threadCpu = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage.bind(process) : null;
const perfNow = performance.now.bind(performance);
const cpuMs = () => {
    const u = threadCpu?.();
    return u ? (u.user + u.system) / 1000 : perfNow();
};

/** Builds and guards the bot for seat i (0 or 1); { bot } or { error }. */
function load(name, i) {
    const mine = { game: thisGame, seat: i + 1, name };
    ctl.set(PHASE.load, i + 1);
    origin.enterWith(mine);
    try {
        const t0 = cpuMs();
        const bot = makeBot(name);
        const loadMs = Math.max(0, cpuMs() - t0);
        if (!bot || typeof bot.choose !== 'function') {
            throw new Error('createBot() did not return a bot with a choose() method');
        }
        let game = null;
        let guarded = null;
        const hooks = {
            onEnter: (ctx) => {
                game = ctx?.game ?? null;
                ctl.set(PHASE.choose, i + 1);
                origin.enterWith(mine);
            },
            onExit: () => {
                origin.enterWith(undefined);
                ctl.chose(i + 1, game?.round, guarded.thinkMs);
                ctl.set(PHASE.engine);
            },
            // the bot's other code (close, stats) runs as this seat too: a hang there, or async work it starts, is its own
            around: (fn) => {
                ctl.set(PHASE.choose, i + 1);
                origin.enterWith(mine);
                try {
                    return fn();
                } finally {
                    origin.enterWith(undefined);
                    ctl.set(PHASE.engine);
                }
            }
        };
        // the engine only ever sees the guard's object, so a bot cannot unwrap the guard or reset its counters
        guarded = guard(bot, { capMs, loadMs, ...hooks });
        return { bot: guarded };
    } catch (e) {
        return { error: firstLine(e) };
    } finally {
        origin.enterWith(undefined);
        ctl.set(PHASE.engine);
    }
}

parentPort.on('message', async (job) => {
    if (job === 'exit') {
        process.exit(0);
    }
    const t0 = Date.now();
    thisGame = job;
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
        // the game runs without yielding, so a bot's timers and rejected promises can only fire now: let the ones that
        // are due run while this game is still the current one (a throw there is that bot's forfeit, see origin)
        await new Promise((resolve) => setTimeout(resolve, 1));
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
    thisGame = null;
    ctl.set(PHASE.idle);
    parentPort.postMessage({ job, result: r });
});
parentPort.postMessage({ ready: true });
