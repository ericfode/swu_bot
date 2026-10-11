'use strict';
/**
 * Time cap and fault tracking around a bot's choose(), the same for every bot (baselines included).
 *
 *   guard(bot, { capMs = Infinity, wallCapMs, loadMs = 0, onEnter, onExit }) -> a new object for the game runner:
 *       { name, needsUndo, stats, choose, close, thinkMs, wallMs, fault }   (getters; the bot cannot reach or change them)
 *
 * The game runner hands the engine this object, never the bot, so a bot cannot unwrap its own guard or reset its
 * counters. Thinking time is this thread's CPU time (process.threadCpuUsage, user + system) for in-process bots, so a
 * busy engine on another worker does not count against them, and wall time for bots that run a child process
 * (bot.external or bot.stdio). Wall time inside choose() is also capped, at wallCapMs (default 2 x capMs), so work
 * moved off this thread (worker threads, Atomics.wait, child processes) is not free. loadMs (the time createBot took)
 * starts the CPU counter.
 *
 * A throw from the bot, or a return value that is not a legal action now (matched on kind, label, cardUuid and arg
 * by env.refetch; a distribute action's own split is kept, see narrowed), sets fault = { kind: 'error', message } and
 * throws. Going over a cap sets
 * fault = { kind: 'time', ms } and throws TIME_FORFEIT. Either way the game ends there, and the game runner reads
 * fault (never the error text) to decide who forfeits. The engine's own live action (not the bot's object) is played.
 *
 * onEnter(ctx) / onExit() run around every call; the ladder worker uses them to show its watchdog who is thinking.
 * A choose() that calls this.choose() (e.g. to model the opponent) reaches the bot's own method and is timed as part
 * of the outer call.
 */

const wallClock = () => performance.now();
const cpuClock = typeof process.threadCpuUsage === 'function'
    ? () => {
        const u = process.threadCpuUsage();
        return (u.user + u.system) / 1000;
    }
    : wallClock;

const firstLine = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);
const same = (a, b) => a.kind === b.kind && a.label === b.label && a.cardUuid === b.cardUuid && a.arg === b.arg;

/**
 * A distribute action may carry the bot's own split as narrowed targets and caps (players/external.js
 * forcedDistribution: each chosen target with its exact amount); env.apply then plays that split. Keep it on the live
 * action when every target is a live one, no cap grows past the live cap and the caps can still hold the amount;
 * null when they cannot (an illegal split).
 */
function narrowed(live, a) {
    if (live.kind !== 'distribute' || a === live) {
        return live;
    }
    const { targets, caps } = a;
    if (!Array.isArray(targets) || !Array.isArray(caps) || targets.length !== caps.length || new Set(targets).size !== targets.length) {
        return null;
    }
    if (targets.length === live.targets.length && targets.every((t, i) => t === live.targets[i] && caps[i] === live.caps[i])) {
        return live; // the bot left the split to the engine
    }
    let sum = 0;
    for (let i = 0; i < targets.length; i++) {
        const k = live.targets.indexOf(targets[i]);
        // live caps are Infinity where the amount is uncapped (env.js), so a copy of the live action passes too
        if (k < 0 || !(Number.isInteger(caps[i]) || caps[i] === Infinity) || caps[i] < 0 || caps[i] > live.caps[k]) {
            return null;
        }
        sum += caps[i];
    }
    const spec = live.spec;
    if (sum < spec.amount && !spec.canDistributeLess && !(sum === 0 && spec.canChooseNoTargets)) {
        return null;
    }
    return { ...live, targets: [...targets], caps: [...caps], spec: { ...spec, maxTargets: Math.min(targets.length, spec.maxTargets ?? targets.length) } };
}

function guard(bot, { capMs = Infinity, wallCapMs = 2 * capMs, loadMs = 0, onEnter = null, onExit = null } = {}) {
    const inner = bot.choose.bind(bot);
    const external = bot.external === true || bot.stdio === true;
    const clock = external ? wallClock : cpuClock;
    let thinkMs = external ? 0 : loadMs;
    let wallMs = 0;
    let fault = null;
    const fail = (f, msg) => {
        fault = f;
        throw new Error(msg);
    };
    const choose = (ctx) => {
        onEnter?.(ctx);
        const t0 = clock();
        const w0 = wallClock();
        let action;
        try {
            action = inner(ctx);
        } catch (e) {
            fault = { kind: 'error', message: firstLine(e) };
            throw e;
        } finally {
            thinkMs += clock() - t0;
            wallMs += wallClock() - w0;
            onExit?.();
        }
        // A search bot rolls back and re-fetches, so its action can carry newer prompt uuids than ctx.actions: ask the
        // engine for the live legal action with the same fields (env.refetch) and play that one.
        let legal = null;
        if (action && typeof action === 'object') {
            legal = typeof ctx.game?.refetch === 'function' ? ctx.game.refetch(ctx.pid, action) : ctx.actions.find((a) => a === action || same(a, action)) ?? null;
            legal = legal && narrowed(legal, action);
        }
        if (!legal) {
            const what = action && typeof action === 'object' ? `${action.kind} "${action.label}"` : String(action);
            fail({ kind: 'error', message: `choose() returned ${what}, not one of the legal actions` }, `${bot.name}: choose() returned ${what}, not one of the legal actions`);
        }
        if (thinkMs > capMs || wallMs > wallCapMs) {
            fail({ kind: 'time', ms: Math.round(thinkMs), wallMs: Math.round(wallMs) }, `TIME_FORFEIT ${bot.name} thought ${Math.round(thinkMs)} ms CPU, ${Math.round(wallMs)} ms wall (caps ${capMs} / ${wallCapMs})`);
        }
        return legal;
    };
    return {
        get name() {
            return bot.name;
        },
        get needsUndo() {
            return bot.needsUndo === true;
        },
        get stats() {
            return bot.stats ?? null;
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
        choose,
        // match.js closes bots after every game (stdio bots end their process and thread)
        close: () => bot.close?.()
    };
}

module.exports = { guard };
