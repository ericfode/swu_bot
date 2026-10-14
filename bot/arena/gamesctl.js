#!/usr/bin/env node
'use strict';
// everything this file and what it loads logs goes to stderr: stdout carries only the one result line
console.log = console.error;
/**
 * The games machine's Node side (the Fly app swu-arena-games: fly.games.toml, Dockerfile.games). The Elixir
 * coordinator (coord/, coord/README.md) runs the machine and decides when; this decides what:
 *
 *   node bot/arena/gamesctl.js setup                                                   (root)
 *   node bot/arena/gamesctl.js warm                                                    (as arena)
 *   node bot/arena/gamesctl.js plan --arena open --settled-since <ms> [--replay-hours 24]   (as arena)
 *   node bot/arena/gamesctl.js referee-cmd --arena open --round K [--games 2] [--workers 2] [--cap-ms 60000]   (root)
 *   node bot/arena/gamesctl.js intake --state <file> --boot <id>                       (root)
 *   node bot/arena/gamesctl.js push --arena open --state <file> --boot <id> [--only round]   (as arena)
 *
 * Each prints exactly one JSON line on stdout and exits 0; 1 is a failure (the reason on stderr), 2 a usage error,
 * 143 a stop by SIGTERM. intake and push reach the window through the coordinator's loopback proxy (SWU_WINDOW), which
 * adds the token: no Node process on the games machine holds it.
 *
 *     setup        folders, the round-seed secret, the roster: {"ok":true,"residents":[..],"toolchain":null|"no .."}
 *     warm         the lineup's bundles compiled into the cache: {"ok":true,"warmed":[..],"failed":[{"name","error"}]}
 *     plan         planRound: {"round":K,"resume":bool,"why":".."} or {"round":null,"why":".."}
 *     referee-cmd  the command that plays round K, run by the coordinator: {"cmd":[..],"env":{..},"cwd":".."}
 *                  (a new round's --cap-ms becomes the roster's time limit; a round cut short keeps its own rules)
 *     intake       one pass over the window's submissions: {"open":N|null,"accepted":N,"done":N[,"error":".."]}
 *     push         the arena's state and round replays to the window: {"ok":bool}; --only round sends just the newest
 *                  round's index and replays (the coordinator's fast pass while a round plays)
 *
 * --state files keep what one pass learned for the next (intake: submissions finished and results the window did not
 * take; push: what was sent). They hold the --boot they were written in: a new boot pushes everything again and reads
 * every submission again, but keeps the results still to send.
 *
 * Who holds what: the coordinator alone has the window token. The referee runs as root in its own PID and mount
 * namespace (isolate.sh) with a minimal environment, /.fly hidden, and alone reads the round-seed secret; the ladders
 * it starts, where bot code runs, run as the user arena with no capabilities (referee.js spawnBots), and the intake's
 * checker likewise (intake.js). Submitted bots run only as WebAssembly (no network, no files but their own and the
 * card data). The residents, the arena's own bots, are submitted entries too (intake.js house submissions): the image
 * builds no bot of its own.
 *
 * Everything lives on the volume (GAMES_DATA, default /data): arena/ (ARENA_HOME: roster, versions, standings),
 * results/ (round ladders and replays), intake/, wasm-cache/, home/ (the bots' HOME), secret/ (root's), coord/ (the
 * coordinator's).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
// what nothing started here may see (isolate.sh --hide): Fly's API socket and config, the Elixir coordinator's folder
// (its job database and state), or GAMES_HIDE's paths
const HIDE = (process.env.GAMES_HIDE || ['/.fly', path.join(DATA, 'coord')].join(':')).split(':').filter(Boolean);
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
// no window token here: intake and push reach the window through the coordinator's proxy, and nothing started from
// here may inherit one
for (const k of ['SWU_WINDOW_TOKEN', 'ARENA_PUSH_TOKEN', 'ARENA_ADMIN_TOKEN']) {
    delete process.env[k];
}
const home = require('./home');

const log = (msg) => console.log(`[gamesctl ${new Date().toISOString().slice(11, 19)}] ${msg}`);

const asRoot = () => process.getuid?.() === 0;
const idsOf = (user) => ['-u', '-g'].map((f) => Number(execFileSync('id', [f, user], { encoding: 'utf8' })));

/** Folders, the round-seed secret and the roster; idempotent, so every start runs it. */
function setupData() {
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
    // no baselines: the image has no bots of its own, and the arena's own bots are resident entries; the competitors stay
    home.updateRoster((r) => ({ ...r, thinkCapMs: r.thinkCapMs ?? THINK_CAP_MS, baselines: [], agents: r.agents ?? [] }));
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
    return { residents: home.roster().agents.filter((a) => a.resident).map((a) => a.name) };
}

/**
 * Compiles the bundles of the lineup's versions (the residents' and the builders') into the cache, as the bots' user,
 * so their first game after a start does not pay for it. Returns {warmed: [name], failed: [{name, error}]}.
 */
function warmLineup() {
    const out = { warmed: [], failed: [] };
    for (const name of require('./referee').lineup()) {
        const dir = path.join(home.VERSIONS, name, 'bundle');
        if (!fs.existsSync(path.join(dir, 'arena.json'))) {
            continue; // not a WebAssembly version (an older bot.js one): nothing to compile
        }
        const cmd = ['python3', path.join(ROOT, 'bot', 'compiled', 'run.py'), '--warm', dir];
        const run = asRoot() ? ['setpriv', `--reuid=${idsOf(BOT_USER)[0]}`, `--regid=${idsOf(BOT_USER)[1]}`, '--clear-groups', '--', ...cmd] : cmd;
        try {
            const { ARENA_SECRET_FILE, ARENA_BOT_USER, ...env } = botEnv();
            execFileSync(run[0], run.slice(1), { stdio: ['ignore', 'ignore', 'pipe'], env, timeout: 120000 });
            out.warmed.push(name);
        } catch (e) {
            const error = String(e.stderr ?? e.message).trim().split('\n').pop();
            log(`${name}: could not compile (${error})`);
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
 * needs at least one competitor besides the arena's own bots.
 */
function planRound({ replayMs, settledSince }) {
    const { lineup, anchorsOf } = require('./referee');
    const st = home.readJson(path.join(home.HOME, 'standings.json'), { rounds: [] });
    const last = st.rounds.at(-1);
    if (last && last.status !== 'done') {
        return { round: last.round, resume: true, why: 'resume' };
    }
    const bots = lineup();
    // the arena's own bots (residents, baselines) alone are no reason to play
    const own = anchorsOf(bots);
    if (!bots.some((b) => !own.includes(b))) {
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

/**
 * The command that plays round K: root in its own namespaces (isolate.sh) with HIDE hidden, and the minimal
 * environment. Only one referee runs here at a time, so a lock the last one left (a stop, a crash) is stale: removing
 * it spares the next one the wait for it to go stale.
 */
function refereeCommand(k, { games, workers, capMs = null }) {
    const { ladderIdOf } = require('./referee');
    ({ games } = roundRules(k, { games, capMs }));
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

/**
 * The rules round K plays under. A round a stop cut short keeps its own games per pair (ladder.js starts a resumed run
 * over when they change) and the time limit it started with. A new round takes `games`, and `capMs` (Eric's setting,
 * or the coordinator's default) becomes the roster's time limit, which the referee plays by and the arena's status shows.
 */
function roundRules(k, { games, capMs }) {
    const st = home.readJson(path.join(home.HOME, 'standings.json'), { rounds: [] });
    const cut = st.rounds.find((r) => r.round === k && r.status !== 'done');
    if (cut) {
        return { games: Number.isInteger(cut.gamesPerPair) && cut.gamesPerPair > 0 ? cut.gamesPerPair : games };
    }
    if (capMs !== null && home.roster().thinkCapMs !== capMs) {
        home.updateRoster((r) => ({ ...r, thinkCapMs: capMs }));
    }
    return { games };
}

const ARENAS = ['open']; // the No-sims arena comes later (coord/README.md)

class Usage extends Error {}

function opts(argv) {
    const o = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) {
            throw new Usage(`unexpected argument ${argv[i]}`);
        }
        o[argv[i].slice(2)] = argv[i + 1];
        i++;
    }
    return o;
}

function need(o, name, test = (v) => v !== undefined && v !== '') {
    if (!test(o[name])) {
        throw new Usage(`--${name} is missing or wrong`);
    }
    return o[name];
}

const arena = (o) => need(o, 'arena', (v) => ARENAS.includes(v));
const int = (v) => /^\d+$/.test(String(v ?? ''));

/** A --state file's contents when it was written in this boot, else {}. Never fails: a broken file starts over. */
function readState(file, boot) {
    try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        return s?.boot === boot ? s : { boot: null, carry: s };
    } catch {
        return {};
    }
}

function writeState(file, state) {
    require('./home').writeAtomic(file, JSON.stringify(state));
}

const commands = {
    setup() {
        const { residents } = setupData();
        return { ok: true, residents, toolchain: require('./intake').toolchainMissing() };
    },

    warm() {
        return { ok: true, ...warmLineup() };
    },

    plan(o) {
        arena(o);
        const settledSince = Number(need(o, 'settled-since', int));
        const replayMs = Number(o['replay-hours'] ?? 24) * 3600000;
        const p = planRound({ replayMs, settledSince });
        return p.round === null ? { round: null, why: p.why } : { round: p.round, resume: p.resume, why: p.why };
    },

    'referee-cmd'(o) {
        arena(o);
        const k = Number(need(o, 'round', int));
        const n = Number(o.games ?? 2);
        const workers = Number(o.workers ?? 2);
        const capMs = o['cap-ms'] === undefined ? null : Number(need(o, 'cap-ms', (v) => int(v) && Number(v) >= 1000));
        return refereeCommand(k, { games: n, workers, capMs });
    },

    async intake(o) {
        const file = need(o, 'state');
        const boot = need(o, 'boot');
        const intake = require('./intake');
        const s = readState(file, boot);
        // results the window did not take are kept across boots; what was finished is read again
        const unsent = new Map(s.unsent ?? s.carry?.unsent ?? []);
        const finished = new Set(s.boot === boot ? s.finished ?? [] : []);
        const stats = {};
        const current = {};
        const save = () => writeState(file, { boot, finished: [...finished], unsent: [...unsent] });
        // a stop ends the pass early; the submission being checked goes back to pending, then this exits 143
        let stopped = null;
        process.on('SIGTERM', () => {
            intake.stopCheckers();
            setTimeout(() => process.exit(143), 5000).unref();
            stopped = intake.release(current).catch((e) => console.error(`gamesctl intake: ${e.message}`)).finally(() => {
                save();
                process.exit(143);
            });
        });
        let error;
        let done = 0;
        try {
            done = await intake.intakeOnce({ finished, unsent, stats, current });
        } catch (e) {
            error = e.message;
            stats.open = null;
        }
        save();
        if (stopped) {
            await stopped; // ends in process.exit(143)
        }
        if (stats.open === null && error === undefined) {
            error = intake.toolchainMissing() ?? 'unknown';
        }
        return { open: stats.open ?? null, accepted: stats.accepted ?? 0, done, ...(error !== undefined ? { error } : {}) };
    },

    async push(o) {
        arena(o);
        const file = need(o, 'state');
        const boot = need(o, 'boot');
        const s = readState(file, boot);
        const docs = new Map(Object.entries(s.docs ?? {}));
        const runs = new Map(Object.entries(s.runs ?? {}).map(([id, r]) => [id, {
            docs: new Map(Object.entries(r.docs ?? {})),
            replays: new Map(Object.entries(r.replays ?? {})),
            ...(r.known ? { known: new Map(r.known) } : {})
        }]));
        const only = o.only === undefined ? null : need(o, 'only', (v) => v === 'round');
        const pusher = require('./push').arenaPusher({ docs, runs });
        const ok = await pusher.once({ only });
        writeState(file, {
            boot,
            docs: Object.fromEntries(pusher.docs),
            runs: Object.fromEntries([...pusher.runs].map(([id, r]) => [id, {
                docs: Object.fromEntries(r.docs), replays: Object.fromEntries(r.replays), known: r.known ? [...r.known] : null
            }]))
        });
        return { ok };
    }
};

async function main(argv) {
    const cmd = commands[argv[0]];
    if (!cmd) {
        throw new Usage(`no command ${argv[0] ?? ''}; one of ${Object.keys(commands).join(', ')}`);
    }
    const r = await cmd(opts(argv.slice(1)));
    process.stdout.write(`${JSON.stringify(r)}\n`);
}

if (require.main === module) {
    main(process.argv.slice(2)).then(() => process.exit(0), (e) => {
        console.error(e instanceof Usage ? `gamesctl: ${e.message}` : (e.stack ?? e.message));
        process.exit(e instanceof Usage ? 2 : 1);
    });
}

module.exports = { commands, readState, planRound, botEnv };
