'use strict';
/**
 * The lobby loop's watchdog (Eric, 2026-10-11: "monitor it while it's playing ... so it never gets stuck"). Once a
 * minute it reads the newest run's status.json, checks that a queue.js process is alive, and restarts the loop when it
 * is stuck or died. It gives up after --max-restarts restarts in two hours and raises an alert instead, which a
 * watching agent reads from --out. It never starts a loop while the stop file exists, and leaves a loop that stopped
 * on purpose (people cap reached, games done) alone.
 *
 *   CAP=30 node bot/karabast/watchdog.js --runs ~/karabast/runs --stop-file ~/karabast/STOP \
 *     --start "bash /home/sprite/run-held.sh loop /home/sprite/karabast/loop.sh" --out ~/karabast/watchdog.json \
 *     [--viewer http://127.0.0.1:8080/status] [--every 60] [--max-restarts 3]
 *
 * The --start command inherits this process's environment (CAP for loop.sh).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const MIN = 60000;
/** How long the loop may sit in one state before it counts as stuck. queued: the 10 minute match wait plus slack. */
const LIMITS = { starting: 5 * MIN, queued: 15 * MIN, playing: 90 * MIN, 'between games': 5 * MIN, stopped: 5 * MIN };
const STALE_MS = 3 * MIN; // the loop rewrites status.json every 30 s
const GRACE_MS = 5 * MIN; // after a restart, the new loop gets this long to write its first status
const NO_MATCH_COOLDOWN_MS = 20 * MIN; // a loop that stopped for lack of opponents waits this long before queueing again
const WINDOW_MS = 120 * MIN;
/** A node process running queue.js as its script: never a shell or this watchdog that merely names it. */
const LOOP_PATTERN = '^[^ ]*node [^ ]*bot/karabast/queue\\.js( |$)';

/**
 * What to do now. `alive`: a queue.js process runs; `status`: the newest status.json (or null); `restarts`: times of
 * past restarts (ms); `noStatusSince`: since when a live loop has had no readable status (ms, or null). A live loop
 * whose newest status says stopped is one that hangs before writing its own. Returns
 * { action: 'none' | 'restart' | 'report' | 'alert', why }.
 */
function judge({ now, alive, status, stopFile, restarts = [], maxRestarts = 3, lastRestart = null, noStatusSince = null }) {
    if (stopFile) {
        return { action: 'none', why: 'the stop file exists' };
    }
    if (lastRestart !== null && now - lastRestart < GRACE_MS) {
        return { action: 'none', why: 'waiting for the restarted loop' };
    }
    let why = null;
    if (alive) {
        if (!status) {
            if (noStatusSince === null || now - noStatusSince <= LIMITS.starting) {
                return { action: 'none', why: 'the loop has not written a status yet' };
            }
            why = `the loop has had no readable status since ${new Date(noStatusSince).toISOString()}`;
        } else {
            const at = Date.parse(status.at);
            const since = Date.parse(status.since);
            if (status.state !== 'stopped' && !(now - at < STALE_MS)) {
                why = `the loop stopped writing its status (last ${status.at})`;
            } else if (LIMITS[status.state] && now - since > LIMITS[status.state]) {
                why = `the loop has been ${status.state} since ${status.since}`;
            } else {
                return { action: 'none', why: `ok: ${status.state}` };
            }
        }
    } else if (status?.state === 'stopped' && status.ok) {
        return { action: 'report', why: `the loop stopped: ${status.reason}` };
    } else if (status?.state === 'stopped' && /^no match in/.test(status.reason ?? '')) {
        if (now - Date.parse(status.since) < NO_MATCH_COOLDOWN_MS) {
            return { action: 'none', why: `no opponents; queueing again ${NO_MATCH_COOLDOWN_MS / MIN} minutes after ${status.since}` };
        }
        why = `queueing again after: ${status.reason}`;
    } else {
        why = status ? `no loop runs (last state ${status.state}${status.reason ? `: ${status.reason}` : ''})` : 'no loop runs';
    }
    const recent = restarts.filter((t) => now - t < WINDOW_MS).length;
    if (recent >= maxRestarts) {
        return { action: 'alert', why: `${why}; not restarting: ${recent} restarts in the last ${WINDOW_MS / MIN} minutes` };
    }
    return { action: 'restart', why };
}

/** The status.json written most recently under `runs`, or null. */
function newestStatus(runs) {
    let best = null;
    for (const d of fs.existsSync(runs) ? fs.readdirSync(runs) : []) {
        const f = path.join(runs, d, 'status.json');
        try {
            const t = fs.statSync(f).mtimeMs;
            if (!best || t > best.t) {
                best = { t, f };
            }
        } catch {
            // a run without a status (the recorder's, or an old one)
        }
    }
    if (!best) {
        return null;
    }
    try {
        return { run: path.basename(path.dirname(best.f)), ...JSON.parse(fs.readFileSync(best.f, 'utf8')) };
    } catch {
        return null; // caught between the loop's write and rename: the next check reads it
    }
}

function loopPids() {
    try {
        return execFileSync('pgrep', ['-f', LOOP_PATTERN], { encoding: 'utf8' }).split('\n').map(Number).filter((n) => n > 0 && n !== process.pid);
    } catch {
        return []; // pgrep exits 1 when nothing matches
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stopLoop(log) {
    for (const sig of ['SIGTERM', 'SIGKILL']) {
        const pids = loopPids();
        if (!pids.length) {
            return;
        }
        log(`sending ${sig} to ${pids.join(' ')}`);
        for (const pid of pids) {
            try {
                process.kill(pid, sig);
            } catch {
                // already gone
            }
        }
        for (let i = 0; i < 20 && loopPids().length; i++) {
            await sleep(500);
        }
    }
}

async function main() {
    const argv = process.argv.slice(2);
    const arg = (name, dflt) => {
        const i = argv.indexOf(`--${name}`);
        return i >= 0 ? argv[i + 1] : dflt;
    };
    const runs = arg('runs');
    const stopFile = arg('stop-file');
    const start = arg('start');
    const out = arg('out');
    const viewer = arg('viewer', null);
    const every = Number(arg('every', 60));
    const maxRestarts = Number(arg('max-restarts', 3));
    if (!runs || !stopFile || !start || !out) {
        throw new Error('usage: watchdog.js --runs DIR --stop-file FILE --start "COMMAND" --out FILE [--viewer URL] [--every 60] [--max-restarts 3]');
    }
    if (!(every >= 10 && every <= 600) || !(Number.isInteger(maxRestarts) && maxRestarts >= 1)) {
        throw new Error('--every must be 10-600 seconds and --max-restarts an integer of at least 1');
    }
    const log = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    // a restarted watchdog keeps the restart budget of the one before it
    let prior = null;
    try {
        prior = JSON.parse(fs.readFileSync(out, 'utf8'));
    } catch {
        // first run
    }
    const restarts = (prior?.restarts ?? []).map(Date.parse).filter((t) => Date.now() - t < WINDOW_MS);
    const events = Array.isArray(prior?.events) ? prior.events.slice(-20) : [];
    let lastRestart = restarts.length ? Math.max(...restarts) : null;
    let noStatusSince = null;
    let viewerDown = 0;
    let reported = null;
    log(`watchdog start, every ${every} s, at most ${maxRestarts} restarts in ${WINDOW_MS / MIN} minutes (${restarts.length} so far)`);
    for (;;) {
        const now = Date.now();
        const status = newestStatus(runs);
        const alive = loopPids().length > 0;
        noStatusSince = alive && !status ? noStatusSince ?? now : null;
        const v = judge({ now, alive, status, stopFile: fs.existsSync(stopFile), restarts, maxRestarts, lastRestart, noStatusSince });
        const note = (text) => {
            events.push({ at: new Date(now).toISOString(), text });
            events.splice(0, events.length - 20);
            log(text);
        };
        if (v.action === 'restart') {
            note(`restart: ${v.why}`);
            await stopLoop(log);
            await sleep(3000); // let the old loop's task hold go before the new one takes it
            spawn('bash', ['-c', start], { detached: true, stdio: 'ignore', env: process.env }).unref();
            restarts.push(now);
            lastRestart = Date.now();
        } else if ((v.action === 'report' || v.action === 'alert') && reported !== v.why) {
            note(`${v.action}: ${v.why}`);
            reported = v.why;
        }
        if (v.action === 'none' && /^ok/.test(v.why)) {
            reported = null;
        }
        let viewerOk = null;
        if (viewer) {
            viewerOk = await fetch(viewer, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
            viewerDown = viewerOk ? 0 : viewerDown + 1;
            if (viewerDown === 3) {
                note(`alert: the live view at ${viewer} did not answer 3 checks in a row`);
            }
        }
        const alert = v.action === 'alert' ? v.why : viewerDown >= 3 ? `the live view at ${viewer} does not answer` : null;
        const report = {
            at: new Date().toISOString(), alive, run: status?.run ?? null, state: status?.state ?? null, since: status?.since ?? null,
            played: status?.played ?? null, won: status?.won ?? null, lost: status?.lost ?? null, errors: status?.errors ?? null,
            verdict: v.action, why: v.why, alert, viewerOk, restarts: restarts.filter((t) => now - t < WINDOW_MS).map((t) => new Date(t).toISOString()), events
        };
        const tmp = `${out}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(report) + '\n');
        fs.renameSync(tmp, out);
        await sleep(every * 1000);
    }
}

module.exports = { judge, newestStatus, LOOP_PATTERN, LIMITS, STALE_MS, GRACE_MS, NO_MATCH_COOLDOWN_MS };

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
}
