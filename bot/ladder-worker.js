'use strict';
/**
 * Worker thread for ladder.js and arena/pool.js (both through game-pool.js): loads the engine once, then plays the
 * games it is sent. workerData: { maxSteps, engineRev, capMs, key, control, base }.
 *
 * Both bots are built here and guarded (players/guard.js) with the same capMs. While a bot loads or runs (its calls,
 * and the timers and promise callbacks its code left behind) the worker writes its seat and start time into the
 * control array, so the parent's watchdog can stop a call that never returns and blame the right bot. The posted
 * result is playGame's (match.js: a bot that broke the game makes it an ERROR with `by` = its seat, and the other
 * seat wins) plus:
 *   winner      bot name, 'draw' or null      winnerSeat  'p1' | 'p2' | 'draw' | null
 *   faultKind   with `by`: 'load' | 'error' | 'time' | 'hang' (game-pool.js); null otherwise
 *   think       { p1, p2 } guarded thinking time in ms (CPU for bots that run here); timing stays the referee's
 * A bot that cannot be built loses before the game starts; when neither can, the game is an ERROR with `by` null.
 * Bot programs from bot/external-bots.json keep running between games (players/index.js makeBot); every other bot is
 * built for one game and closed after it.
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
const { AsyncLocalStorage, createHook } = require('async_hooks');
const { Env } = require('./env');
const { playGame, timingSummary } = require('./match');
const { snapshot } = require('./recorder');
const { makeBot, closeBots, describeBot } = require('./players');
const { guard } = require('./players/guard');
const { gameKey } = require('./rng');
const { workerControl, forfeit, PHASE } = require('./game-pool');

const env = new Env();
env.engineRev = workerData.engineRev ?? null;
const capMs = workerData.capMs ?? Infinity;
// with a cap, the guard's per-game budget decides a slow bot program, so protocol.js's per-message limits only back it up
const limits = Number.isFinite(capMs) ? { hello: capMs + 5000, decide: capMs + 5000, over: 10000 } : {};
const ctl = workerControl(workerData.control, workerData.base);
const firstLine = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);
// bound before any bot loads (a bot may replace the global)
const later = setTimeout;
// how long the worker waits for a bot's close() after the game (a bot program gets EOF and is killed 2 s later)
const CLOSE_MS = 3000;
const r3 = (x) => Math.round(x * 1000) / 1000;
// bound before any bot loads, so a bot that replaces process.threadCpuUsage while it loads cannot shrink its load time
const threadCpu = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage.bind(process) : null;
const perfNow = performance.now.bind(performance);
const cpuMs = () => {
    const u = threadCpu?.();
    return u ? (u.user + u.system) / 1000 : perfNow();
};

// Whose code is running. Everything a bot's code starts (timers, promises, I/O callbacks) carries { game, seat, name }
// from that bot, so the watchdog can blame it for a hang, a delayed throw or process.exit() names its seat (the parent
// reads it from the control array), and its time outside its own calls is its own. Work left over from an earlier game
// (whose result is already in) marks the worker stale instead: the parent plays the interrupted job again on a fresh
// worker.
const origin = new AsyncLocalStorage();
let thisGame = null;
let guards = [];
const mark = (o) => (o.game === thisGame ? ctl.set(PHASE.choose, o.seat) : ctl.set(PHASE.stale));
const frames = [];
createHook({
    before() {
        const o = origin.getStore();
        if (o) {
            const was = ctl.get();
            mark(o);
            frames.push({ o, was, now: ctl.get(), cpu: cpuMs(), wall: perfNow() });
        }
    },
    after() {
        if (!origin.getStore() || !frames.length) {
            return;
        }
        const f = frames.pop();
        // put back what was there, unless the callback itself moved on (a bot's call ended in it)
        if (ctl.same(f.now)) {
            ctl.restore(f.was);
        }
        if (f.o.game === thisGame && guards.length) {
            const used = { cpu: cpuMs() - f.cpu, wall: perfNow() - f.wall };
            guards.forEach((g, i) => (i === f.o.seat - 1 ? g.charge(used) : g.excuse(used)));
        }
    }
}).enable();
// process.exit() skips uncaughtException: a bot's own exit, from its async work too, names its seat the same way
const exit = process.exit.bind(process);
process.exit = (code) => {
    const o = origin.getStore();
    if (o) {
        mark(o);
    }
    exit(code);
};
process.on('uncaughtException', (e) => {
    const o = origin.getStore();
    if (o) {
        mark(o);
        if (o.game !== thisGame) {
            throw new Error(`async work left by ${o.name} from an earlier game: ${firstLine(e)}`);
        }
    }
    throw e; // the worker dies as before
});

/** Builds and guards the bot for seat i (0 or 1); { bot, raw } or { error }. `taken`: the bots already seated. */
function load(name, i, taken) {
    const mine = { game: thisGame, seat: i + 1, name };
    ctl.set(PHASE.load, i + 1);
    try {
        return origin.run(mine, () => {
            const t0 = cpuMs();
            const raw = makeBot(name, taken);
            const loadMs = Math.max(0, cpuMs() - t0);
            if (!raw || (typeof raw.choose !== 'function' && typeof raw.decide !== 'function')) {
                throw new Error('createBot() did not return a bot with a choose() or decide() method');
            }
            let guarded = null;
            let round = 0;
            const hooks = {
                enter: (r) => {
                    round = r ?? round;
                    ctl.set(PHASE.choose, i + 1);
                },
                leave: () => {
                    ctl.chose(i + 1, round, guarded.thinkMs);
                    ctl.set(PHASE.engine);
                },
                // the bot's code runs as this seat, also outside its calls (close, stats, over): a hang there is its own
                within: (fn) => {
                    const was = ctl.get();
                    ctl.set(PHASE.choose, i + 1);
                    const now = ctl.get();
                    try {
                        return origin.run(mine, fn);
                    } finally {
                        if (ctl.same(now)) {
                            ctl.restore(was);
                        }
                    }
                }
            };
            // the engine only ever sees the guard's object, so a bot cannot unwrap the guard or reset its counters
            guarded = guard(raw, { capMs, loadMs, ...hooks });
            return { bot: guarded, raw };
        });
    } catch (e) {
        return { error: firstLine(e) };
    } finally {
        ctl.set(PHASE.engine);
    }
}

parentPort.on('message', async (job) => {
    if (job === 'exit') {
        // every bot program sees the end of its input and exits
        await closeBots();
        process.exit(0);
    }
    const t0 = Date.now();
    thisGame = job;
    ctl.newGame();
    const names = [job.p1, job.p2];
    const loaded = [];
    for (const [i, n] of names.entries()) {
        loaded.push(load(n, i, loaded.map((x) => x.raw).filter(Boolean)));
    }
    let r;
    if (loaded.some((x) => x.error)) {
        // a bot that cannot be built loses before the game starts (no replay)
        const bad = [0, 1].filter((i) => loaded[i].error);
        r = {
            seed: job.seed, steps: 0, outcome: 'ERROR', winner: null, winnerSeat: null, round: 0, ms: Date.now() - t0,
            error: bad.map((i) => `LOAD ${names[i]}: ${loaded[i].error}`).join('; ').slice(0, 300), by: null, faultKind: null,
            botStats: loaded.map((x) => x.bot?.stats ?? null), timing: { p1: timingSummary([]), p2: timingSummary([]) }, think: { p1: 0, p2: 0 }
        };
        if (bad.length === 1) {
            Object.assign(r, forfeit(job, bad[0], 'load'));
        }
    } else {
        const bots = loaded.map((x) => x.bot);
        guards = bots;
        let onEvent = null;
        if (job.replayFile) {
            fs.mkdirSync(path.dirname(job.replayFile), { recursive: true });
            fs.writeFileSync(job.replayFile, '');
            // the end event is written below, once the fault kind is known
            onEvent = (e) => {
                if (e.t !== 'end') {
                    fs.appendFileSync(job.replayFile, `${JSON.stringify(e)}\n`);
                }
            };
        }
        const key = workerData.key ? gameKey(workerData.key, job.seed) : null;
        r = await playGame(env, { seed: job.seed, bots, key, limits, maxSteps: workerData.maxSteps, record: !!job.replayFile, snapshot, onEvent });
        // let the timers and promise callbacks a bot left that are due now run while this game is still the current one
        // (a throw there is that bot's loss, see origin)
        await new Promise((resolve) => later(resolve, 1));
        delete r.events;
        r.winnerSeat = r.winner;
        r.winner = r.winner === 'p1' ? job.p1 : r.winner === 'p2' ? job.p2 : r.winner;
        r.by ??= null;
        const culprit = r.by === 'p1' ? 0 : r.by === 'p2' ? 1 : -1;
        r.faultKind = culprit < 0 ? null : bots[culprit].fault?.kind ?? 'error';
        r.think = { p1: r3(bots[0].thinkMs), p2: r3(bots[1].thinkMs) };
        if (job.replayFile) {
            fs.appendFileSync(job.replayFile, `${JSON.stringify({ t: 'end', winner: r.winnerSeat, round: r.round, steps: r.steps, outcome: r.outcome, error: r.error ?? null, by: r.by, faultKind: r.faultKind, ...(r.key ? { key: r.key } : {}) })}\n`);
        }
    }
    // bots built for this game end here (a program sees the end of its input); programs kept between games stay up.
    // The result is in already: a close() that never settles is not waited for, so it cannot hold the result back until
    // the watchdog takes the game for a hang (a close() whose own code never returns is that bot's hang, see within).
    const closing = Promise.all(loaded.map((x, i) => (x.bot && describeBot(names[i])?.kind !== 'external' ? x.bot.close() : null)));
    await Promise.race([closing, new Promise((resolve) => later(resolve, CLOSE_MS).unref())]);
    guards = [];
    thisGame = null;
    ctl.set(PHASE.idle);
    parentPort.postMessage({ job, result: r });
});
parentPort.postMessage({ ready: true });
