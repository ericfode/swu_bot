'use strict';
/**
 * Time cap and fault tracking around a bot, the same for every bot (baselines included).
 *
 *   guard(bot, { capMs = Infinity, wallCapMs, loadMs = 0, program, enter, leave, within }) -> what match.js plays instead:
 *     a native bot ({ name, choose })      { name, lang, needsUndo, stats, choose, close, thinkMs, wallMs, fault }
 *     a protocol client ({ name, decide }) { name, lang, stats, hello, decide, over, close, thinkMs, wallMs, fault }
 *   plus charge(used) and excuse(used) for the game runner (below). Getters and the guard's own functions: the bot never
 *   sees this object, so it cannot unwrap the guard or reset its counters.
 *
 * Thinking time is every choose(), hello and decide call. It is this thread's CPU time (process.threadCpuUsage, user
 * + system) for bots that run here, so a busy engine on another worker does not count against them, and wall time
 * for bot programs (bot/stdio.js StdioClient, or a bot the caller marks with program: true). Wall time is also capped for
 * bots that run here, at wallCapMs (default 2 x capMs), so work moved off this thread (worker threads, Atomics.wait,
 * child processes, waiting on a timer) is not free. loadMs (the time createBot took, or a function giving it, read
 * after the bot's properties) starts the CPU counter.
 *
 * A call ends the game as the bot's loss (match.js makes a throw from it an ERROR with `by` = the bot's seat) when
 *   - the bot throws or its promise rejects: fault = { kind: 'error', message };
 *   - it goes over a cap: fault = { kind: 'time', ms, wallMs } and TIME_FORFEIT. A call that returns a promise is
 *     stopped when the wall time it has left runs out; the CPU cap is checked when it returns. The match runner
 *     closing a client during a call (its own reply limit, protocol.js) also counts as time.
 * A wrong answer (an action that is not legal, a bad split, a malformed reply) is also the bot's loss; match.js
 * (protocol.js) decides it and fault stays null. What match.js reads afterwards is data the guard copied inside the
 * bot's call, never the bot's own object (which may have getters): a native bot's action as kind, label, cardUuid,
 * arg and split, each a primitive; a client's reply as JSON. A client is told the time it has left in `ms`.
 *
 * enter(round) and leave() mark the start and end of each timed call (the ladder worker tells its watchdog who is
 * thinking); within(fn) runs the bot's own code, every call and also close, stats and over, as this bot's seat (not
 * for programs, whose code runs in their own process).
 * charge(used) adds the time of the bot's own async work that ran outside its calls (timers and promise callbacks it
 * left, { cpu, wall } in ms); excuse(used) takes the other bot's async work out of the call in progress.
 * stats is read as plain JSON data (at most 64 KB; anything else reads as null), so it can always go in the result.
 * A throw from close() is ignored: the game is over by then and its result stands.
 *
 * The clocks and timer functions are bound when this module loads, before any bot code runs, so a bot that replaces
 * process.threadCpuUsage, performance.now or setTimeout later does not change them.
 */
const { StdioClient } = require('../stdio');

const wallClock = performance.now.bind(performance);
const threadCpu = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage.bind(process) : null;
const cpuClock = threadCpu
    ? () => {
        const u = threadCpu();
        return (u.user + u.system) / 1000;
    }
    : wallClock;
const later = setTimeout;
const cancel = clearTimeout;

const firstLine = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);
const LATE = Symbol('late');
const MAX_TIMER = 2 ** 31 - 2;
const STATS_MAX = 65536;

/** A primitive in place of what the bot gave (its own toString, if any, runs here, inside its call). */
const prim = (v) => ((v !== null && typeof v === 'object') || typeof v === 'function' || typeof v === 'symbol' ? String(v) : v);

/** The fields of a native bot's answer that pick an action and its split, each read once as a primitive. */
function plainAction(a) {
    if (!a || typeof a !== 'object') {
        return null;
    }
    const { kind, label, cardUuid, arg, split } = a;
    const p = { kind: prim(kind), label: prim(label), cardUuid: prim(cardUuid), arg: prim(arg) };
    if (split !== undefined) {
        // anything but an array is refused by env.splitError, so it need not be read
        p.split = Array.isArray(split) ? Array.from(split, (e) => ({ id: prim(e?.id), amount: prim(e?.amount) })) : 'not an array';
    }
    return p;
}

/** A client's reply as plain JSON data. */
const plainReply = (r) => (r === undefined ? undefined : JSON.parse(JSON.stringify(r) ?? 'null'));

function guard(bot, { capMs = Infinity, wallCapMs = 2 * capMs, loadMs = 0, program: isProgram = false, enter = () => {}, leave = () => {}, within = (fn) => fn() } = {}) {
    // read once, now (while the bot loads): these may be getters, and the game runner reads them outside any bot call
    const fns = {};
    for (const k of ['choose', 'hello', 'decide', 'over', 'close']) {
        const f = bot[k];
        if (typeof f === 'function') {
            fns[k] = f.bind(bot);
        }
    }
    if (!fns.choose && !fns.decide) {
        throw new Error('a bot needs choose() (native bot) or decide() (protocol client)');
    }
    const name = String(bot.name);
    const lang = bot.lang == null ? undefined : String(bot.lang);
    const needsUndo = bot.needsUndo === true;
    // the bot's class or the caller decide this, never a property the bot sets: a program's calls are not tracked as the
    // bot's own code (own, below), so a bot here that claimed to be one would escape that tracking
    const program = bot instanceof StdioClient || isProgram === true;
    const limit = (v) => (typeof v === 'number' && v > 0 ? v : undefined);
    const timeoutMs = limit(bot.timeoutMs);
    const startTimeoutMs = limit(bot.startTimeoutMs);
    const clock = program ? wallClock : cpuClock;
    // a program's code runs in its own process: what runs here for it (bot/stdio.js) is the referee's transport, which
    // must not pass for the bot's own async work (a program may also serve game after game)
    const own = program ? (fn) => fn() : within;
    // loadMs may be a clock read now, so reading the bot's properties above (they may be getters) is charged to it too
    let thinkMs = program ? 0 : (typeof loadMs === 'function' ? loadMs() : loadMs);
    let wallMs = 0;
    let fault = null;
    // the call in progress: what other bots' async work took from it (ms), so it can be given back
    let call = null;

    const overCap = () => thinkMs > capMs || wallMs > wallCapMs;
    const timeFault = () => {
        fault = { kind: 'time', ms: Math.round(thinkMs), wallMs: Math.round(wallMs) };
        const ms = Math.round(thinkMs);
        return new Error(`TIME_FORFEIT ${name} thought ${program ? `${ms} ms (cap ${capMs})` : `${ms} ms CPU, ${Math.round(wallMs)} ms wall (caps ${capMs} / ${wallCapMs})`}`);
    };
    // what is left of the binding budget: the cap on this bot's own clock, and for bots that run here the wall cap too
    const left = () => Math.min(capMs - thinkMs, program ? Infinity : wallCapMs - wallMs);

    /** One timed call: fn() may return a value or a promise; copy(result) runs inside the call too. */
    async function timed(round, fn, copy) {
        if (overCap()) {
            throw timeFault(); // async work it left outside its calls already took it past the cap
        }
        enter(round);
        const mine = { cpu: 0, wall: 0 };
        call = mine;
        const t0 = clock();
        const w0 = wallClock();
        // the timer measures wall time: for a program its cap, for a bot that runs here its wall cap (its CPU is checked
        // when the call returns, so a call that waits without using CPU may run up to the wall cap)
        const budget = program ? capMs - thinkMs : wallCapMs - wallMs;
        let timer = null;
        let out;
        try {
            const answer = own(async () => copy(await fn()));
            const late = budget < MAX_TIMER ? new Promise((resolve) => (timer = later(resolve, Math.max(0, Math.ceil(budget)) + 1, LATE))) : null;
            out = late ? await Promise.race([answer, late]) : await answer;
        } catch (e) {
            fault ??= { kind: 'error', message: firstLine(e) };
            throw e;
        } finally {
            cancel(timer);
            call = null;
            thinkMs += Math.max(0, clock() - t0 - (program ? mine.wall : mine.cpu));
            wallMs += Math.max(0, wallClock() - w0 - mine.wall);
            leave();
        }
        if (out === LATE || overCap()) {
            throw timeFault();
        }
        return out;
    }

    /** The bot's code outside the timed calls (close, stats, over): its seat's, untimed, failures its own business. */
    const untimed = (fn) => own(fn);

    const g = {
        get name() {
            return name;
        },
        get lang() {
            return lang;
        },
        get thinkMs() {
            return thinkMs;
        },
        get wallMs() {
            return wallMs;
        },
        get fault() {
            return fault;
        },
        get stats() {
            // optional numbers for the record: a getter that throws, or a value that cannot be copied into the result
            // (functions, cycles, BigInt, huge), must not cost the finished game its result
            return untimed(() => {
                try {
                    const s = bot.stats;
                    const j = s === undefined || s === null ? null : JSON.stringify(s);
                    return typeof j === 'string' && j.length <= STATS_MAX ? JSON.parse(j) : null;
                } catch {
                    return null;
                }
            });
        },
        /** Time of this bot's own async work that ran outside its calls. */
        charge({ cpu, wall }) {
            if (!call) {
                thinkMs += program ? wall : cpu;
                wallMs += wall;
            }
        },
        /** Time of the other bot's async work that ran during this bot's call. */
        excuse({ cpu, wall }) {
            if (call) {
                call.cpu += cpu;
                call.wall += wall;
            }
        },
        // match.js does not close bots; the game runner does, after the game. A client closed during one of its calls was
        // stopped by protocol.js for taking too long.
        close: () => {
            if (call && !fault) {
                fault = { kind: 'time', ms: Math.round(thinkMs), wallMs: Math.round(wallMs) };
            }
            return untimed(() => {
                try {
                    return Promise.resolve(fns.close?.()).catch(() => undefined);
                } catch {
                    return Promise.resolve(); // cleanup only: the game is over and its result stands
                }
            });
        }
    };
    if (fns.choose) {
        Object.defineProperty(g, 'needsUndo', { get: () => needsUndo, enumerable: true });
        g.choose = (ctx) => timed(ctx?.game?.round, () => fns.choose(ctx), plainAction);
        return g;
    }
    // a protocol client: hello and over are optional (bot/stdio.js answer() replies for a client without them)
    const told = (msg) => {
        const ms = Math.floor(left());
        return Number.isFinite(ms) && msg && typeof msg === 'object' ? { ...msg, ms: Math.max(1, msg.ms == null ? ms : Math.min(msg.ms, ms)) } : msg;
    };
    g.hello = (msg) => timed(0, () => (fns.hello ? fns.hello(told(msg)) : { t: 'ready', v: 2, name }), plainReply);
    g.decide = (msg, sim) => {
        // every `simulated` reply also says how much of this bot's own budget is left
        const t0 = clock();
        const before = left();
        const simTold = async (req) => {
            const r = await sim(req);
            const ms = Math.floor(before - (clock() - t0));
            return Number.isFinite(ms) && r && typeof r === 'object' ? { ...r, ms: Math.max(0, r.ms == null ? ms : Math.min(r.ms, ms)) } : r;
        };
        return timed(msg?.state?.round, () => fns.decide(told(msg), simTold), plainReply);
    };
    g.over = (msg) => untimed(async () => plainReply(await (fns.over ? fns.over(msg) : { t: 'ok' })));
    if (timeoutMs !== undefined) {
        g.timeoutMs = timeoutMs;
    }
    if (startTimeoutMs !== undefined) {
        g.startTimeoutMs = startTimeoutMs;
    }
    return g;
}

module.exports = { guard, plainAction };
