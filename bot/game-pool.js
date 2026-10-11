'use strict';
/**
 * Runs game jobs ({id, seed, p1, p2, replayFile?}) on ladder-worker.js threads, with a watchdog. Shared by ladder.js
 * and arena/pool.js.
 *
 *   runPool(queue, { workers, workerData, hangMs, gameMs, onStart(job), onResult({ job, result }) }) -> Promise
 *
 * `queue` is consumed (shifted) as games start. onStart runs just before a job is posted to a worker, onResult once per
 * job with its finished result (fields: ladder-worker.js). Each worker shares a small control array with the parent
 * (SharedArrayBuffer, layout SLOT) where it keeps what it is doing: idle, engine, loading a bot or inside a bot's
 * choose(), for which seat, and since when. Every 2 s the parent looks at it:
 *   - one choose() call (or one bot load) has run longer than hangMs of wall time: that seat forfeits, faultKind 'hang'
 *     ('load' while loading). The worker is terminated and replaced, and the queue carries on.
 *   - the engine has gone hangMs without asking either bot anything: the game is an ERROR (no fault), same treatment.
 *   - the game has run longer than gameMs (default 4 x workerData.capMs + 10 min when there is a cap, else no limit),
 *     by the parent's own clock: whoever the control array says is thinking forfeits (faultKind 'hang'), else ERROR.
 *     This one holds even when a bot fakes its `since` from inside the worker.
 * A worker that dies mid-game (crash, out of memory, a bot calling process.exit) is replaced the same way; the game is
 * that seat's forfeit (faultKind 'error') when a bot was running, else an ERROR. Only a worker that dies before it has
 * loaded the engine fails the whole run.
 */
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { spawnSync } = require('child_process');

const WORKER = path.join(__dirname, 'ladder-worker.js');
const SLOT = { phase: 0, seat: 1, since: 2, steps: 3, round: 4, think1: 5, think2: 6 };
const SLOTS = 7;
const PHASE = { idle: 0, engine: 1, load: 2, choose: 3 };
const CHECK_MS = 2000;
const KILL_AFTER_MS = 5000;
const POOL_WORKER = 'SWU_POOL_WORKER';
const DEFAULT_GAME_MS = (capMs) => (Number.isFinite(capMs) && capMs > 0 ? 4 * capMs + 600000 : 0);
let workerIds = 0;
// bound when this module loads, before any bot code runs in the worker, so a bot that later replaces Date.now or
// Atomics.store cannot make the control array say something else (ladder-worker.js also hides the array itself)
const clockNow = Date.now;
const { store, load } = Atomics;

/** The worker's side of the control array (`since` is ms after `base`, a Date.now() the parent picked). */
function workerControl(sab, base = clockNow()) {
    const a = new Int32Array(sab ?? new SharedArrayBuffer(SLOTS * 4));
    const put = (k, v) => store(a, k, v | 0);
    return {
        // `since` first and `phase` last, so a reader that sees a stale `since` also sees the stale phase and seat
        set(phase, seat = 0) {
            put(SLOT.since, clockNow() - base);
            put(SLOT.seat, seat);
            put(SLOT.phase, phase);
        },
        newGame() {
            for (const k of [SLOT.steps, SLOT.round, SLOT.think1, SLOT.think2]) {
                put(k, 0);
            }
            this.set(PHASE.engine);
        },
        /** Bookkeeping after seat (1 or 2) returned from choose(): one more step, and that bot's think time so far. */
        chose(seat, round, thinkMs) {
            put(SLOT.steps, load(a, SLOT.steps) + 1);
            put(SLOT.round, round ?? 0);
            put(seat === 1 ? SLOT.think1 : SLOT.think2, thinkMs);
        }
    };
}

function readControl(a) {
    return {
        phase: Atomics.load(a, SLOT.phase), seat: Atomics.load(a, SLOT.seat), since: Atomics.load(a, SLOT.since),
        steps: Atomics.load(a, SLOT.steps), round: Atomics.load(a, SLOT.round), think: [Atomics.load(a, SLOT.think1), Atomics.load(a, SLOT.think2)]
    };
}

/** Result fields of a game that seat index i (0 = p1, 1 = p2) forfeits. */
function forfeit(job, i, kind) {
    return { outcome: 'forfeit', fault: `p${i + 1}`, faultKind: kind, winner: [job.p1, job.p2][1 - i], winnerSeat: `p${2 - i}` };
}

/** The result of a game the worker could not finish: seat 1|2 forfeits with `kind`, or 0 = nobody's fault (ERROR). */
function stoppedResult(job, st, { seat, kind, error, ms }) {
    const r = {
        seed: job.seed, steps: st.steps, outcome: 'ERROR', winner: null, winnerSeat: null, round: st.round, ms, error,
        fault: null, faultKind: null, timing: null, think: { p1: st.think[0], p2: st.think[1] }, botStats: [null, null]
    };
    if (seat) {
        Object.assign(r, forfeit(job, seat - 1, kind));
    }
    if (job.replayFile && fs.existsSync(job.replayFile)) {
        fs.appendFileSync(job.replayFile, `${JSON.stringify({ t: 'end', winner: r.winnerSeat, round: r.round, steps: r.steps, outcome: r.outcome, error, fault: r.fault, faultKind: r.faultKind })}\n`);
    }
    return r;
}

/**
 * Kills the child processes of this process, with their children: all of them, or with `worker` only those started by
 * that worker thread. Bots run in worker threads, so a child process can only come from a bot (stdio bots own one
 * each; in-process bots may not start any). A bot stuck in execSync blocks its worker thread until the child ends, so
 * the watchdog (when terminate() did not help) kills that worker's children and the final exit kills the rest.
 * A worker's children are told apart by POOL_WORKER in their environment: each worker gets its own process.env, and
 * child processes inherit it, so stdio bots playing on other workers are left alone.
 */
function killChildren(worker = null) {
    try {
        // the whole tree: execSync('cmd') runs /bin/sh -c cmd, and the grandchild keeps the call's pipes open
        const ps = spawnSync('ps', ['-e', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 }).stdout ?? '';
        const kids = new Map();
        for (const line of ps.trim().split('\n')) {
            const [pid, ppid] = line.trim().split(/\s+/).map(Number);
            kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
        }
        const tag = worker === null ? null : `${POOL_WORKER}=${worker}`;
        const ours = (pid) => {
            try {
                return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(tag);
            } catch {
                return false; // gone, or no /proc: leave it to the final exit
            }
        };
        const tree = [];
        for (let todo = (kids.get(process.pid) ?? []).filter((pid) => tag === null || ours(pid)); todo.length;) {
            const pid = todo.pop();
            tree.push(pid);
            todo.push(...(kids.get(pid) ?? []));
        }
        for (const pid of tree) {
            try {
                process.kill(pid, 'SIGKILL');
            } catch {
                // already gone
            }
        }
    } catch {
        // no ps: a stuck call ends on its own
    }
}

function runPool(queue, { workers = 1, workerData = {}, hangMs = 600000, gameMs = DEFAULT_GAME_MS(workerData.capMs), onStart = () => {}, onResult = () => {} } = {}) {
    return new Promise((resolve, reject) => {
        const base = Date.now();
        const slots = new Set();
        let timer = null;
        let ended = false;
        const finish = (err) => {
            if (!ended) {
                ended = true;
                clearInterval(timer);
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            }
        };
        const nameOf = (job, seat) => (seat === 1 ? job.p1 : job.p2);
        const feed = (s) => {
            const job = queue.shift();
            if (!job) {
                s.w.postMessage('exit');
                return;
            }
            s.job = job;
            s.jobStart = Date.now();
            onStart(job);
            s.w.postMessage(job);
        };
        // records the game a worker could not finish and retires that worker; a replacement takes over the queue
        const stop = (s, result) => {
            const job = s.job;
            s.job = null;
            s.retired = true;
            // a retired worker no longer counts: if terminate() cannot interrupt it (a bot blocked in a synchronous
            // child process), the run still finishes, and unref() lets the process exit without waiting for it
            slots.delete(s);
            s.w.unref();
            onResult({ job, result });
            if (queue.length && !ended) {
                spawn();
            } else if (!slots.size) {
                finish();
            }
        };
        const spawn = () => {
            const sab = new SharedArrayBuffer(SLOTS * 4);
            const s = { id: `${process.pid}.${++workerIds}`, ctl: new Int32Array(sab), job: null, ready: false, retired: false, error: null };
            // its own process.env with its id, inherited by every process a bot on it starts (killChildren(worker))
            s.w = new Worker(WORKER, { workerData: { ...workerData, control: sab, base }, env: { ...process.env, [POOL_WORKER]: s.id } });
            slots.add(s);
            s.w.on('message', (msg) => {
                if (s.retired) {
                    return;
                }
                if (!msg.ready) {
                    const job = s.job;
                    s.job = null;
                    onResult({ job, result: msg.result });
                }
                s.ready = true;
                feed(s);
            });
            s.w.on('error', (e) => {
                s.error = e;
            });
            s.w.on('exit', (code) => {
                s.exited = true;
                slots.delete(s);
                if (!s.retired) {
                    if (s.job) {
                        const st = readControl(s.ctl);
                        const seat = st.phase === PHASE.choose || st.phase === PHASE.load ? st.seat : 0;
                        const why = String(s.error?.message ?? `exit code ${code}`).split('\n')[0].slice(0, 160);
                        const error = seat ? `CRASH ${nameOf(s.job, seat)}: worker died (${why})` : `worker died (${why})`;
                        stop(s, stoppedResult(s.job, st, { seat, kind: st.phase === PHASE.load ? 'load' : 'error', error, ms: Date.now() - s.jobStart }));
                    } else if (!s.ready) {
                        finish(s.error ?? new Error(`game worker exited with code ${code} before it was ready`));
                        return;
                    } else if (queue.length && !ended) {
                        spawn();
                    }
                }
                if (!slots.size) {
                    finish();
                }
            });
        };
        timer = setInterval(() => {
            const now = Date.now() - base;
            for (const s of slots) {
                if (!s.job || s.retired) {
                    continue;
                }
                const st = readControl(s.ctl);
                const ms = now - st.since;
                const gameTime = Date.now() - s.jobStart;
                const hung = st.phase !== PHASE.idle && ms > hangMs;
                // the parent's own clock only, so a worker that reports a wrong `since` (or idle) cannot run forever
                const overtime = gameMs > 0 && gameTime > gameMs;
                if (!hung && !overtime) {
                    continue;
                }
                const job = s.job;
                const sec = Math.round(ms / 1000);
                const seat = st.phase === PHASE.choose || st.phase === PHASE.load ? st.seat : 0;
                const late = `the game passed ${Math.round(gameMs / 1000)} s`;
                let result;
                if (!seat) {
                    const error = hung ? `ENGINE_HANG no decision asked for ${sec} s` : `GAME_TIMEOUT ${late} (no bot was thinking)`;
                    result = stoppedResult(job, st, { seat: 0, error, ms: gameTime });
                } else {
                    const loading = st.phase === PHASE.load;
                    // the hung call's own time counts too (its worker is about to be stopped, so it never reports it)
                    st.think[seat - 1] += Math.max(0, ms);
                    const doing = loading ? 'still loading' : 'no answer from choose()';
                    result = stoppedResult(job, st, {
                        seat, kind: loading ? 'load' : 'hang', ms: gameTime,
                        error: hung ? `HANG ${nameOf(job, seat)} ${doing} after ${sec} s (limit ${Math.round(hangMs / 1000)} s)` : `GAME_TIMEOUT ${nameOf(job, seat)} ${doing} when ${late}`
                    });
                }
                stop(s, result);
                s.w.terminate();
                // terminate() interrupts JS and Atomics.wait, but not a thread blocked in execSync: then kill the child
                // processes this worker started (games on other workers keep their stdio bots)
                setTimeout(() => {
                    if (!s.exited) {
                        killChildren(s.id);
                    }
                }, KILL_AFTER_MS).unref();
            }
        }, CHECK_MS);
        const n = Math.max(0, Math.min(workers, queue.length));
        for (let i = 0; i < n; i++) {
            spawn();
        }
        if (!n) {
            finish();
        }
    });
}

module.exports = { runPool, killChildren, workerControl, forfeit, PHASE, SLOT };
