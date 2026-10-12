#!/usr/bin/env node
'use strict';
/**
 * The hosted arena's games machine: the one process of the Fly app swu-arena-games (fly.games.toml, Dockerfile.games).
 *
 *   node bot/arena/games.js [--port 8080] [--games 2] [--workers 2] [--idle-min 10] [--replay-hours 24]
 *
 * People submit bots on the window (swu-arena.fly.dev, window.js); this machine plays them. Every minute it
 *   1. takes the window's pending submissions (intake.js: pack to WebAssembly, start once in the sandbox, enter),
 *   2. starts a rated round (referee.js) when the lineup changed: a new or withdrawn version, or the last round is
 *      older than --replay-hours (more games, so ratings settle). A round interrupted by a stop is resumed,
 *   3. sends the arena's state, standings and round replays to the window (push.js arenaPusher), every 20 s.
 * With no round playing, no submission open and no wake-up for --idle-min minutes, it exits 0 and the machine stops
 * (fly.games.toml: restart only on failure). The window wakes it with POST /wake over Fly's private network on every
 * submission and every 6 hours (window.js wakeGames); GET /healthz answers too. Both say nothing about the arena.
 *
 *     window ──POST /wake (flycast, private)──▶ games.js ──intake──▶ versions/ ──referee──▶ ladder (bots as arena)
 *        ▲                                         │
 *        └──────── submissions, standings, replays ┘ (the window token, only in this process)
 *
 * Who holds what: this process alone has the window token (SWU_WINDOW_TOKEN, a Fly secret). push.js reads it at load,
 * and it is then removed from the environment, so nothing started here inherits it. The referee runs as root in its
 * own PID and mount namespace (isolate.sh) with a minimal environment, /.fly hidden, and alone reads the round-seed
 * secret; the ladders it starts, where bot code runs, run as the user arena with no capabilities (referee.js
 * spawnBots), and the intake's checker likewise (intake.js). Submitted bots run only as WebAssembly (no network, no
 * files but their own and the card data). The residents are the project's own bots, entered as the roster's
 * baselines (ARENA_RESIDENTS overrides the list).
 *
 * Everything lives on the volume (GAMES_DATA, default /data): arena/ (ARENA_HOME: roster, versions, standings),
 * results/ (round ladders and replays), intake/, wasm-cache/, home/ (the bots' HOME), secret/ (root's).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DATA = process.env.GAMES_DATA || '/data';
const BOT_USER = process.env.ARENA_USER || 'arena';
const DIRS = {
    home: path.join(DATA, 'arena'),
    results: path.join(DATA, 'results'),
    intake: path.join(DATA, 'intake'),
    cache: path.join(DATA, 'wasm-cache'),
    botHome: path.join(DATA, 'home'),
    dash: path.join(DATA, 'dash'),
    tmp: path.join(DATA, 'tmp', 'referee'),
    secret: path.join(DATA, 'secret')
};
const SECRET = path.join(DIRS.secret, 'arena-secret');
// what nothing started here may see (isolate.sh --hide): Fly's API socket and config, and GAMES_HIDE's paths
const HIDE = (process.env.GAMES_HIDE || '/.fly').split(':').filter(Boolean);
// the project's own bots, rated with everyone (their mean is pinned to 1500): two in-process anchors and five
// WebAssembly bundles built into the image (bot/compiled)
const RESIDENTS = (process.env.ARENA_RESIDENTS || 'heuristic,rush,c-clock-wasm,rust-greedy2-wasm,rust-search-wasm,node-search-wasm,py-clock-wasm')
    .split(',').map((x) => x.trim()).filter(Boolean);
const THINK_CAP_MS = 60000; // per game, the local arena's rule (roster.thinkCapMs)
const SETTLE_MS = 90000; // a round waits this long after a version comes in, so a quick fix joins the same round

// the arena's folders, before home.js reads them
Object.assign(process.env, {
    ARENA_HOME: process.env.ARENA_HOME || DIRS.home,
    ARENA_RESULTS: process.env.ARENA_RESULTS || DIRS.results,
    ARENA_PUBLIC_RESULTS: process.env.ARENA_PUBLIC_RESULTS || process.env.ARENA_RESULTS || DIRS.results,
    ARENA_DASH: process.env.ARENA_DASH || DIRS.dash,
    ARENA_INTAKE_WORK: process.env.ARENA_INTAKE_WORK || DIRS.intake,
    SWU_WASM_CACHE: process.env.SWU_WASM_CACHE || DIRS.cache,
    ARENA_USER: BOT_USER,
    // what the intake's checker must not see (intake.js hidden()): the same, and the round-seed secret
    ARENA_HIDE: [...HIDE, DIRS.secret].join(':')
});
// push.js keeps the window token it reads now; nothing started from here gets it
const push = require('./push');
for (const k of ['SWU_WINDOW_TOKEN', 'ARENA_PUSH_TOKEN', 'ARENA_ADMIN_TOKEN']) {
    delete process.env[k];
}
const home = require('./home');
const intake = require('./intake');

const log = (msg) => console.log(`[games ${new Date().toISOString().slice(11, 19)}] ${msg}`);
const arg = (argv, name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
};

const asRoot = () => process.getuid?.() === 0;
const idsOf = (user) => ['-u', '-g'].map((f) => Number(execFileSync('id', [f, user], { encoding: 'utf8' })));

/** Folders, the round-seed secret and the roster; idempotent, so every start runs it. */
function setup() {
    for (const d of Object.values(DIRS)) {
        fs.mkdirSync(d, { recursive: true });
    }
    // the intake's folder stays root's: each check gets a folder in it whose layout the checker cannot change
    // (intake.js checkIsolated); checks left by a stop are gone with the process that made them
    for (const f of fs.readdirSync(DIRS.intake).filter((x) => x.startsWith('job-'))) {
        home.removeTree(path.join(DIRS.intake, f));
    }
    fs.chmodSync(DIRS.intake, 0o755);
    fs.chmodSync(DIRS.secret, 0o700);
    if (!fs.existsSync(SECRET) || !fs.statSync(SECRET).size) {
        fs.writeFileSync(SECRET, require('crypto').randomBytes(32).toString('hex'), { mode: 0o600 });
        log('made the round-seed secret');
    }
    fs.chmodSync(SECRET, 0o600);
    // the residents are the baselines; the competitors stay as they are
    home.updateRoster((r) => ({ ...r, thinkCapMs: r.thinkCapMs ?? THINK_CAP_MS, baselines: RESIDENTS, agents: r.agents ?? [] }));
    if (asRoot()) {
        // what bot code writes is the bots' user's; the secret, the intake's folder and the referee's /tmp stay root's
        const [uid, gid] = idsOf(BOT_USER);
        for (const k of ['home', 'results', 'cache', 'botHome', 'dash']) {
            execFileSync('chown', ['-R', `${uid}:${gid}`, DIRS[k]]);
        }
        for (const k of ['intake', 'secret', 'tmp']) {
            fs.chownSync(DIRS[k], 0, 0);
        }
        fs.chownSync(SECRET, 0, 0);
    }
    return { residents: RESIDENTS };
}

/**
 * Compiles the resident bundles into the cache, as the bots' user, so their first game does not pay for it. Returns
 * {warmed: [name], failed: [{name, error}]}.
 */
function warm() {
    const out = { warmed: [], failed: [] };
    for (const name of RESIDENTS.filter((n) => n.endsWith('-wasm'))) {
        const dir = path.join(ROOT, 'build', 'compiled', name.slice(0, -5));
        if (!fs.existsSync(path.join(dir, 'arena.json'))) {
            log(`resident ${name}: no bundle at ${dir}`);
            out.failed.push({ name, error: 'no bundle' });
            continue;
        }
        const cmd = ['python3', path.join(ROOT, 'bot', 'compiled', 'run.py'), '--warm', dir];
        const run = asRoot() ? ['setpriv', `--reuid=${idsOf(BOT_USER)[0]}`, `--regid=${idsOf(BOT_USER)[1]}`, '--clear-groups', '--', ...cmd] : cmd;
        try {
            const { ARENA_SECRET_FILE, ARENA_BOT_USER, ...env } = botEnv();
            execFileSync(run[0], run.slice(1), { stdio: ['ignore', 'ignore', 'pipe'], env, timeout: 120000 });
            out.warmed.push(name);
        } catch (e) {
            const error = String(e.stderr ?? e.message).trim().split('\n').pop();
            log(`resident ${name}: could not compile (${error})`);
            out.failed.push({ name, error });
        }
    }
    return out;
}

/** The referee's environment: the arena's folders and nothing else (no token, no Fly variables). */
function botEnv() {
    const keep = ['ARENA_HOME', 'ARENA_RESULTS', 'ARENA_PUBLIC_RESULTS', 'ARENA_DASH', 'SWU_WASM_CACHE', 'SWU_CARD_JSON'];
    return {
        PATH: process.env.PATH, HOME: DIRS.botHome, LANG: 'C.UTF-8', TZ: 'UTC',
        ...Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
        ARENA_SECRET_FILE: SECRET, ARENA_BOT_USER: BOT_USER
    };
}

/**
 * The round to play now: {round: K, resume, why}, or {round: null, why}. resume: round K is the last one and a stop cut
 * it short. Otherwise K is the next round, played when the lineup changed (a new or withdrawn version) or the last
 * round is older than replayMs, and only once settledSince (when the last version came in) is SETTLE_MS old. A round
 * needs at least one competitor.
 */
function planRound({ replayMs, settledSince }) {
    const { lineup } = require('./referee');
    const st = home.readJson(path.join(home.HOME, 'standings.json'), { rounds: [] });
    const last = st.rounds.at(-1);
    if (last && last.status !== 'done') {
        return { round: last.round, resume: true, why: 'resume' };
    }
    const bots = lineup();
    const baselines = home.roster().baselines ?? [];
    if (!bots.some((b) => !baselines.includes(b))) {
        return { round: null, why: 'no-competitor' };
    }
    const before = (last?.bots ?? []).map((b) => b.name);
    const changed = bots.some((b) => !before.includes(b)) || before.some((b) => !bots.includes(b));
    const stale = last && Date.now() - Date.parse(st.updatedAt ?? 0) > replayMs;
    if (!changed && !stale) {
        return { round: null, why: 'same' };
    }
    // a version that just came in may be followed by a quick fix: let it settle
    if (Date.now() - settledSince < SETTLE_MS) {
        return { round: null, why: 'settling' };
    }
    // the referee numbers rounds the same way (referee.js nextRound)
    return { round: (last?.round ?? -1) + 1, resume: false, why: changed ? 'changed' : 'stale' };
}

/** planRound as the referee's arguments: null, [] for the next round, or ['--round', K] to finish round K. */
function roundToPlay(opts) {
    const p = planRound(opts);
    return p.round === null ? null : p.resume ? ['--round', String(p.round)] : [];
}

/**
 * The command that plays round K: root in its own namespaces (isolate.sh) with HIDE hidden, and the minimal
 * environment. Only one referee runs here at a time, so a lock the last one left (a stop, a crash) is stale: removing
 * it spares the next one the wait for it to go stale.
 */
function refereeCommand(k, { games, workers }) {
    const { ladderIdOf } = require('./referee');
    // only in a real folder: the results folder is the bots' user's, who could put a link in its place
    const dir = path.join(home.RESULTS, ladderIdOf(k));
    if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
        fs.rmSync(path.join(dir, 'referee.lock'), { force: true });
    }
    const isolate = asRoot()
        ? ['bash', path.join(__dirname, 'ops', 'isolate.sh'), '--tmp', DIRS.tmp, ...HIDE.flatMap((p) => ['--hide', p]), '--']
        : [];
    const cmd = [...isolate, process.execPath, path.join(__dirname, 'referee.js'), '--round', String(k), '--games', String(games), '--workers', String(workers)];
    return { cmd, env: botEnv(), cwd: ROOT };
}

/** Starts the referee for round K (refereeCommand). */
function startReferee(k, { games, workers, resume }) {
    const { cmd, env, cwd } = refereeCommand(k, { games, workers });
    const child = spawn(cmd[0], cmd.slice(1), { cwd, env, stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    log(`round ${k} started (${resume ? 'finishing it' : 'new'}, pid ${child.pid})`);
    return child;
}

async function main(argv) {
    const port = Number(arg(argv, 'port', process.env.PORT || 8080));
    const games = Number(arg(argv, 'games', 2));
    const workers = Number(arg(argv, 'workers', 2));
    const idleMs = Number(arg(argv, 'idle-min', 10)) * 60000;
    const replayMs = Number(arg(argv, 'replay-hours', 24)) * 3600000;
    setup();
    warm();
    const pusher = push.arenaPusher();
    const finished = new Set();
    const unsent = new Map();
    let referee = null;
    let busyAt = Date.now(); // the last wake-up, check or round end: the idle clock starts here
    let settledSince = 0; // when the last version came in
    let wake = null; // resolves the current wait early
    let woken = false; // a wake-up came: the intake runs at the next tick
    let stopping = false;
    const failed = new Map(); // round arguments -> referee runs that ended in an error, in this process

    const server = http.createServer((req, res) => {
        const url = req.url.split('?')[0];
        if (req.method === 'POST' && url === '/wake') {
            busyAt = Date.now();
            woken = true;
            wake?.();
            res.writeHead(202, { 'content-type': 'application/json' });
            return res.end('{"ok":true}');
        }
        if (req.method === 'GET' && url === '/healthz') {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end('{"ok":true}');
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
    });
    // Fly's private network is IPv6; a machine without IPv6 listens on IPv4
    await new Promise((resolve, reject) => {
        server.once('error', (e) => (e.code === 'EAFNOSUPPORT' ? server.listen(port, '0.0.0.0', resolve) : reject(e)));
        server.listen(port, '::', resolve);
    });
    log(`listening on ${port}; residents ${RESIDENTS.join(', ')}`);

    const stop = async (code) => {
        if (stopping) {
            return;
        }
        stopping = true;
        if (referee) {
            try {
                process.kill(-referee.pid, 'SIGTERM'); // isolate.sh passes it on; the round resumes next start
            } catch {}
        }
        intake.stopCheckers();
        await pusher.once();
        log(`stopping (${code})`);
        process.exit(code);
    };
    for (const sig of ['SIGTERM', 'SIGINT']) {
        process.on(sig, () => stop(0));
    }

    let ticks = 0;
    for (;;) {
        // the intake every third tick (a minute), or at once after a wake-up
        if (ticks % 3 === 0 || woken) {
            woken = false;
            const stats = {};
            try {
                await intake.intakeOnce({ benchNew: false, window: push, finished, unsent, stats });
            } catch (e) {
                log(`intake: ${e.message}`);
                stats.open = null;
            }
            if (stats.accepted) {
                settledSince = Date.now();
            }
            if (stats.open > 0) {
                busyAt = Date.now(); // submissions still open (a check to retry, another's check): stay up
            }
        }
        if (!referee) {
            const plan = planRound({ replayMs, settledSince });
            const key = plan.round;
            // a round whose referee failed twice waits for the next start (a wake-up, or the next deploy)
            if (plan.round !== null && (failed.get(key) ?? 0) < 2) {
                referee = startReferee(plan.round, { games, workers, resume: plan.resume });
                referee.on('exit', (code, sig) => {
                    log(`round ended (${code ?? sig})`);
                    if (code !== 0) {
                        failed.set(key, (failed.get(key) ?? 0) + 1);
                    }
                    referee = null;
                    busyAt = Date.now();
                    wake?.();
                });
            }
        }
        await pusher.once();
        if (!referee && Date.now() - busyAt > idleMs && Date.now() - settledSince > SETTLE_MS) {
            log(`idle for ${Math.round((Date.now() - busyAt) / 60000)} minutes`);
            await stop(0);
        }
        ticks++;
        await new Promise((resolve) => {
            const t = setTimeout(resolve, 20000);
            wake = () => {
                clearTimeout(t);
                resolve();
            };
        });
        wake = null;
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).catch((e) => {
        console.error(e.stack ?? e.message);
        process.exit(1);
    });
}

module.exports = { setup, warm, planRound, roundToPlay, refereeCommand, botEnv, RESIDENTS, DIRS, HIDE, SECRET };
