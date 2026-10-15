#!/usr/bin/env node
'use strict';
// everything this file and what it loads logs goes to stderr: stdout carries only the one result line
console.log = console.error;
/**
 * The games machine's Node side (the Fly app swu-arena-games: fly.games.toml, Dockerfile.games). The games server
 * (server/src/main-games.ts, server/src/games/) runs the machine and plays the rounds; this does what still needs the
 * arena's Node code (its folders, the roster, the window's documents):
 *
 *   node bot/arena/gamesctl.js setup                                                   (root)
 *   node bot/arena/gamesctl.js warm                                                    (as arena)
 *   node bot/arena/gamesctl.js plan --arena open --settled-since <ms> [--replay-hours 24]   (as arena)
 *   node bot/arena/gamesctl.js round --arena open --round K [--games 2] [--cap-ms 60000]    (root)
 *   node bot/arena/gamesctl.js publish --arena open --round K                          (root)
 *   node bot/arena/gamesctl.js decks --file <deck file in bot/decks> [--skip a,b]      (root)
 *   node bot/arena/gamesctl.js intake --state <file> --boot <id>                       (root)
 *   node bot/arena/gamesctl.js push --arena open --state <file> --boot <id> [--only round]   (as arena)
 *
 * Each prints exactly one JSON line on stdout and exits 0; 1 is a failure (the reason on stderr), 2 a usage error,
 * 143 a stop by SIGTERM. intake and push reach the window through the server's loopback proxy (SWU_WINDOW), which adds
 * the token: no Node process on the games machine holds it.
 *
 *     setup        folders and who owns them, the round-seed secret, the roster:
 *                  {"ok":true,"residents":[..],"toolchain":null|"no .."}
 *     warm         the lineup's bundles compiled into the cache: {"ok":true,"warmed":[..],"failed":[{"name","error"}]}
 *     plan         planRound: {"round":K,"resume":bool,"why":".."} or {"round":null,"why":".."}
 *     round        what round K plays, for the server that plays it:
 *                  {"round":K,"bots":[..],"gamesPerPair":G,"capMs":C,"decks":{..}|null,"bundles":{..},"botInfo":{..}}
 *                  Its rules (a new round's --cap-ms becomes the roster's time limit; a round cut short keeps its own
 *                  games per pair and time limit), the lineup (every version a WebAssembly one), the deck lists it
 *                  deals, each version's canonical tar written to the bundles folder (bundles: version -> sha256), and
 *                  each bot as ladder.json describes it. No seed or key: those come from the secret, the server's alone.
 *     publish      round K's standings, report and panels from the ladder.json the server wrote:
 *                  {"ok":true,"status":"running"|"done"|null}
 *     decks        a deck file's lists, loaded and checked as round loads them (the replay check):
 *                  {"file","sha256","names","skipped","lists"}
 *     intake       one pass over the window's submissions: {"open":N|null,"accepted":N,"done":N[,"error":".."]}
 *     push         the arena's state and round replays to the window: {"ok":bool}; --only round sends just the newest
 *                  round's index and replays (the server's fast pass while a round plays)
 *
 * --state files keep what one pass learned for the next (intake: submissions finished and results the window did not
 * take; push: what was sent). They hold the --boot they were written in: a new boot pushes everything again and reads
 * every submission again, but keeps the results still to send.
 *
 * Who holds what: the server alone has the window token and reads the round-seed secret; nothing it starts gets
 * either. Bot code runs only in bot/arena/play-seed.js (the games, started by the server) and in the intake's checker
 * (intake.js), as the user arena with no capabilities, and submitted bots only as WebAssembly (no network, no files but
 * their own and the card data). The residents, the arena's own bots, are submitted entries too (intake.js house
 * submissions): the image builds no bot of its own.
 *
 * Everything lives on the volume (GAMES_DATA, default /data): arena/ (ARENA_HOME: roster, versions, standings),
 * results/ (round ladders and replays), bundles/ (the versions' canonical tars), work/ (the server's game jobs),
 * intake/, wasm-cache/, home/ (the bots' HOME), dash/, secret/ (root's), server/ (the server's own) and coord/ (the old
 * coordinator's). setup says who owns which.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
    secret: path.join(DATA, 'secret'),
    // each version's canonical tar as <sha256>.tar: round writes them, play-seed.js and the helper API read them
    bundles: process.env.GAMES_BUNDLES || path.join(DATA, 'bundles'),
    // one folder per game job the server plays on this machine, removed once its results are read
    work: path.join(DATA, 'work'),
    // the server's own (its database, settings, pidfiles): no child sees it
    server: path.join(DATA, 'server')
};
const SECRET = path.join(DIRS.secret, 'arena-secret');
// what nothing started here may see (isolate.sh --hide): Fly's API socket and config, the server's folder, the old
// Elixir coordinator's folder (its job database and state), or GAMES_HIDE's paths
const HIDE = (process.env.GAMES_HIDE || ['/.fly', DIRS.server, path.join(DATA, 'coord')].join(':')).split(':').filter(Boolean);
// Who owns what. The bots' user keeps what code running as that user writes: its HOME, the wasm cache, and arena/ and
// dash/, where the intake's checker (intake.js check, run as that user) registers competitors and submits their
// versions. results/ is root's and everyone may read it: only the server and root's children write rounds now. The
// rest is root's alone, with these modes (null: left as it is; isolate.sh makes the referee's /tmp 1777 when it runs).
const BOTS_TREES = ['home', 'cache', 'botHome', 'dash'];
const ROOT_TREES = ['results'];
const ROOT_DIRS = { intake: 0o755, secret: 0o700, tmp: null, bundles: 0o755, work: 0o755, server: 0o700 };
const THINK_CAP_MS = 60000; // per game, the local arena's rule (roster.thinkCapMs)
const SETTLE_MS = 90000; // a round waits this long after a version comes in, so a quick fix joins the same round
const VERSION = /^[a-z][a-z0-9_]*-v\d+$/; // registry.js
const DECKS_DIR = path.join(ROOT, 'bot', 'decks');
const DECK_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.json$/;
const MAX_TAR_BYTES = 80 << 20; // remote-lane.js tarOf's buffer (bundle.py unpack takes at most 64 MB)
const MAX_LADDER_BYTES = 256 << 20;

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
// no window token here: intake and push reach the window through the server's proxy, and nothing started from here
// may inherit one
for (const k of ['SWU_WINDOW_TOKEN', 'ARENA_PUSH_TOKEN', 'ARENA_ADMIN_TOKEN']) {
    delete process.env[k];
}
const home = require('./home');

const log = (msg) => console.log(`[gamesctl ${new Date().toISOString().slice(11, 19)}] ${msg}`);

const asRoot = () => process.getuid?.() === 0;
const idsOf = (user) => ['-u', '-g'].map((f) => Number(execFileSync('id', [f, user], { encoding: 'utf8' })));
/** cmd as the bots' user with no capabilities and no way to gain any (the drop isolate.sh --user and play-seed get). */
const asBots = (cmd) => {
    const [uid, gid] = idsOf(BOT_USER);
    return ['setpriv', `--reuid=${uid}`, `--regid=${gid}`, '--clear-groups', '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs', '--', ...cmd];
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

/** Folders and who owns them, the round-seed secret and the roster; idempotent, so every start runs it. */
function setupData() {
    for (const d of Object.values(DIRS)) {
        fs.mkdirSync(d, { recursive: true });
        // a link in place of one of these would take root's writes (and its chown -R) somewhere else
        if (!fs.lstatSync(d).isDirectory()) {
            throw new Error(`${d} is not a folder (a link?)`);
        }
    }
    // the intake's folder stays root's: each check gets a folder in it whose layout the checker cannot change
    // (intake.js checkIsolated); checks left by a stop are gone with the process that made them
    for (const f of fs.readdirSync(DIRS.intake).filter((x) => x.startsWith('job-'))) {
        home.removeTree(path.join(DIRS.intake, f));
    }
    // so are the game jobs a stop left: their games are played again from the round's record
    for (const f of fs.readdirSync(DIRS.work)) {
        home.removeTree(path.join(DIRS.work, f));
    }
    for (const [k, mode] of Object.entries(ROOT_DIRS)) {
        if (mode !== null) {
            fs.chmodSync(DIRS[k], mode);
        }
    }
    if (!fs.existsSync(SECRET) || !fs.statSync(SECRET).size) {
        fs.writeFileSync(SECRET, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
        log('made the round-seed secret');
    }
    fs.chmodSync(SECRET, 0o600);
    // no baselines: the image has no bots of its own, and the arena's own bots are resident entries; the competitors stay
    home.updateRoster((r) => ({ ...r, thinkCapMs: r.thinkCapMs ?? THINK_CAP_MS, baselines: [], agents: r.agents ?? [] }));
    const root = asRoot();
    if (root) {
        const [uid, gid] = idsOf(BOT_USER);
        for (const k of BOTS_TREES) {
            execFileSync('chown', ['-R', `${uid}:${gid}`, DIRS[k]]);
        }
        // once: until the server played rounds, the ladders wrote them as the bots' user
        for (const k of ROOT_TREES) {
            if (fs.lstatSync(DIRS[k]).uid !== 0) {
                log(`${DIRS[k]} becomes root's`);
                execFileSync('chown', ['-R', '0:0', DIRS[k]]);
            }
        }
        for (const k of Object.keys(ROOT_DIRS)) {
            fs.chownSync(DIRS[k], 0, 0);
        }
        fs.chownSync(SECRET, 0, 0);
    }
    for (const k of ROOT_TREES) {
        worldReadable(DIRS[k], { root });
    }
    return { residents: home.roster().agents.filter((a) => a.resident).map((a) => a.name) };
}

/**
 * The mode `chmod a+rX` gives in a folder only root writes: folders 0755; files keep their own bits less write for
 * group and others (and less setuid and setgid: nobody else writes here now), plus read for everyone, and execute for
 * everyone when anyone had it (as X does).
 */
function readableMode(mode, dir) {
    if (dir) {
        return 0o755;
    }
    const m = mode & 0o755;
    return m | 0o444 | (m & 0o111 ? 0o111 : 0);
}

/**
 * chmod -R a+rX over `top` (readableMode), never through a link: each folder or file is opened without following one
 * and changed through that handle; pipes, sockets and devices are left alone. setup runs before the server starts
 * anything, and after its chown nothing in the tree is the bots' user's. Not root: only what this user owns.
 */
function worldReadable(top, { root }) {
    const me = process.getuid?.();
    const visit = (p) => {
        const st = fs.lstatSync(p, { throwIfNoEntry: false });
        if (!st || !(st.isDirectory() || st.isFile())) {
            return;
        }
        let fd;
        try {
            fd = fs.openSync(p, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
        } catch (e) {
            if (['ELOOP', 'ENOENT', 'ENXIO'].includes(e.code)) {
                return; // replaced since (by a link, or gone)
            }
            throw e;
        }
        try {
            const now = fs.fstatSync(fd);
            if (now.ino !== st.ino || now.dev !== st.dev) {
                return;
            }
            const want = readableMode(now.mode & 0o7777, now.isDirectory());
            if ((now.mode & 0o7777) !== want && (root || now.uid === me)) {
                fs.fchmodSync(fd, want);
            }
        } finally {
            fs.closeSync(fd);
        }
        if (st.isDirectory()) {
            for (const name of fs.readdirSync(p)) {
                visit(path.join(p, name));
            }
        }
    };
    visit(top);
}

/**
 * Compiles the bundles of the lineup's versions (the residents' and the builders') into the cache, as the bots' user,
 * so their first game after a start does not pay for it. Returns {warmed: [name], failed: [{name, error}]}.
 */
function warmLineup() {
    const out = { warmed: [], failed: [] };
    for (const name of machineLineup()) {
        const dir = path.join(home.VERSIONS, name, 'bundle');
        if (!fs.existsSync(path.join(dir, 'arena.json'))) {
            continue; // not a WebAssembly version (an older bot.js one): nothing to compile
        }
        const cmd = ['python3', path.join(ROOT, 'bot', 'compiled', 'run.py'), '--warm', dir];
        const run = asRoot() ? asBots(cmd) : cmd;
        try {
            execFileSync(run[0], run.slice(1), { stdio: ['ignore', 'ignore', 'pipe'], env: botEnv(), timeout: 120000 });
            out.warmed.push(name);
        } catch (e) {
            const error = String(e.stderr ?? e.message).trim().split('\n').pop();
            log(`${name}: could not compile (${error})`);
            out.failed.push({ name, error });
        }
    }
    return out;
}

/** The environment of the bot tools started here (warm's run.py): the arena's folders and nothing else (no token, no
 *  Fly variables, no secret). */
function botEnv() {
    const keep = ['ARENA_HOME', 'ARENA_RESULTS', 'ARENA_PUBLIC_RESULTS', 'ARENA_DASH', 'SWU_WASM_CACHE', 'SWU_CARD_JSON'];
    return {
        PATH: process.env.PATH, HOME: DIRS.botHome, LANG: 'C.UTF-8', TZ: 'UTC',
        ...Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
    };
}

/**
 * The round to play now: {round: K, resume, why}, or {round: null, why}. resume: round K is the last one and a stop cut
 * it short. Otherwise K is the next round, played when the lineup changed (a new or withdrawn version) or the last
 * round is older than replayMs, and only once settledSince (when the last version came in) is SETTLE_MS old. A round
 * needs at least one competitor besides the arena's own bots, and two bots in all.
 */
function planRound({ replayMs, settledSince }) {
    const { anchorsOf } = require('./referee');
    const st = home.readJson(path.join(home.HOME, 'standings.json'), { rounds: [] });
    const last = st.rounds.at(-1);
    if (last && last.status !== 'done') {
        return { round: last.round, resume: true, why: 'resume' };
    }
    const bots = machineLineup();
    // the arena's own bots (residents, baselines) alone are no reason to play
    const own = anchorsOf(bots);
    if (!bots.some((b) => !own.includes(b))) {
        return { round: null, why: 'no-competitor' };
    }
    // a builder alone has no one to play (a new volume before the house submissions, or every resident withdrawn)
    if (bots.length < 2) {
        return { round: null, why: 'no-opponent' };
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

/** A JSON file only root writes, read without following a link; null when it is missing, not a plain file or not JSON. */
function readOwnJson(file, max) {
    let fd;
    try {
        fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch {
        return null;
    }
    try {
        const st = fs.fstatSync(fd);
        return st.isFile() && st.size <= max ? JSON.parse(fs.readFileSync(fd, 'utf8')) : null;
    } catch {
        return null;
    } finally {
        fs.closeSync(fd);
    }
}

/** The config of round K's ladder.json as its last run wrote it (the server, or a ladder before it), or null. */
function ladderConfig(k) {
    const dir = path.join(home.RESULTS, require('./referee').ladderIdOf(k));
    if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
        return null;
    }
    const doc = readOwnJson(path.join(dir, 'ladder.json'), MAX_LADDER_BYTES);
    return doc && typeof doc.config === 'object' ? doc.config : null;
}

/**
 * The rules round K plays under: {games, capMs}. A round a stop cut short keeps its own games per pair (the server
 * starts a round over when they change) and the time limit it started with: its ladder.json's, else the roster's. A
 * new round takes `games`, and `capMs` (Eric's setting, or the server's default) becomes the roster's time limit, which
 * the round plays by and the arena's status and report show.
 */
function roundRules(k, { games, capMs }) {
    const st = home.readJson(path.join(home.HOME, 'standings.json'), { rounds: [] });
    const cut = (st.rounds ?? []).find((r) => r.round === k && r.status !== 'done');
    if (cut) {
        const started = ladderConfig(k)?.capMs;
        return {
            games: Number.isInteger(cut.gamesPerPair) && cut.gamesPerPair > 0 ? cut.gamesPerPair : games,
            capMs: Number.isSafeInteger(started) && started > 0 ? started : home.roster().thinkCapMs
        };
    }
    if (capMs !== null && home.roster().thinkCapMs !== capMs) {
        home.updateRoster((r) => ({ ...r, thinkCapMs: capMs }));
    }
    return { games, capMs: home.roster().thinkCapMs };
}

/**
 * The lists of a deck file, loaded and checked against the engine's card data (decklists.js loadDecks, as ladder.js
 * --decks loads them before a round), less the lists named in `skip`: {file, sha256, names, skipped, lists}, the lists
 * in normalizeDeck form, as play-seed.js takes them in a job.
 */
function deckLists(file, skip) {
    const { loadDecks } = require('../decklists');
    const set = loadDecks(file, new (require('../env').Env)());
    const name = path.basename(file);
    const unknown = skip.filter((n) => !set.decks.some((d) => d.metadata.name === n));
    if (unknown.length) {
        throw new Error(`${name} has no deck list ${unknown.join(', ')} to skip`);
    }
    const lists = set.decks.filter((d) => !skip.includes(d.metadata.name));
    if (lists.length < 2) {
        throw new Error(`${name} less the skipped lists leaves fewer than 2 decks`);
    }
    return { file: name, sha256: set.sha256, names: lists.map((d) => d.metadata.name), skipped: [...skip], lists };
}

/**
 * The lineup the games machine plays, the same for plan, round and warm: each agent's newest version that is a
 * WebAssembly one (an agent whose newest playable version was withdrawn plays its newest earlier one; its JS starter v0,
 * which register makes, never plays here). Agents with none are left out at every look, so plan sees one change.
 */
function machineLineup() {
    const { describeBot } = require('../players');
    return require('./referee').lineup(null, { playable: (n) => wasmVersion(n, describeBot) });
}

/** True when `name` is a version that plays as a WebAssembly bundle (what play-seed.js plays, and nothing else). */
function wasmVersion(name, describeBot) {
    const d = VERSION.test(name) ? describeBot(name) : null;
    const dir = path.join(home.VERSIONS, name, 'bundle');
    // describeBot as play-seed.js checkResolved reads it: a version named like a built-in bot plays as that bot
    return d?.kind === 'arena' && d.lang === 'wasm' && !!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()
        && !!fs.lstatSync(path.join(dir, 'arena.json'), { throwIfNoEntry: false })?.isFile();
}

/** True when `file` is a plain file holding exactly the tar `hex` names (and readable by everyone). */
function holdsTar(file, hex, size) {
    let fd;
    try {
        fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch {
        return false;
    }
    try {
        const st = fs.fstatSync(fd);
        return st.isFile() && st.size === size && (st.mode & 0o7777) === 0o644 && sha256(fs.readFileSync(fd)) === hex;
    } catch {
        return false;
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * A version's canonical tar (bot/compiled/bundle.py tar of its bundle folder, as remote-lane.js tarOf packs it for a
 * helper) in the bundles folder as <sha256>.tar, mode 0644, written once: a file of that name holding those bytes stays.
 * Returns the sha256, the version's bundle id in a game job. As root it packs as the bots' user, as the ladder did:
 * arena/ is that user's, so root reads nothing there it could not (a link swapped in mid-pack), and a file's
 * execute bit, which the tar keeps, reads the same as it did for every round so far (bundle.py checks os.access).
 */
function storeBundle(name) {
    const pack = ['python3', path.join(ROOT, 'bot', 'compiled', 'bundle.py'), 'tar', path.join(home.VERSIONS, name, 'bundle')];
    const [cmd, ...args] = asRoot() ? asBots(pack) : pack;
    let tar;
    try {
        tar = execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: botEnv(), maxBuffer: MAX_TAR_BYTES, timeout: 120000 });
    } catch (e) {
        throw new Error(`${name}: its bundle cannot be packed (${String(e.stderr ?? '').trim().split('\n').pop() || e.message})`);
    }
    const hex = sha256(tar);
    const file = path.join(DIRS.bundles, `${hex}.tar`);
    if (!holdsTar(file, hex, tar.length)) {
        // whole or not at all: play-seed.js and the helper API may read it as soon as it has this name
        const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
            const fd = fs.openSync(tmp, 'wx', 0o644);
            try {
                fs.writeFileSync(fd, tar);
                fs.fchmodSync(fd, 0o644); // whatever the umask
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            fs.renameSync(tmp, file);
        } catch (e) {
            fs.rmSync(tmp, { force: true });
            throw e;
        }
    }
    return hex;
}

/**
 * What round K plays, for the server that plays it (server/src/games, checkRound): its rules, its lineup, its deck
 * lists, each version's tar in the bundles folder and each bot's description. Everything that can fail is done before
 * the roster's time limit changes. Only one round plays here at a time and the server takes the round's lock after
 * this answers, so a referee.lock left in the round's folder (a stop, a crash) is stale and goes.
 */
function roundSpec(k, { games, capMs = null }) {
    const { ladderIdOf, ROUND_DECKS } = require('./referee');
    const { describeBot } = require('../players');
    const bots = machineLineup();
    // machineLineup fields only WebAssembly versions, so this does not happen; if it did, the round stops here (a
    // version left out here alone would make the lineup look changed to plan at every look, and no round would end)
    const other = bots.filter((n) => !wasmVersion(n, describeBot));
    if (other.length) {
        throw new Error(`round ${k}: ${other.join(', ')} ${other.length === 1 ? 'is not a WebAssembly version' : 'are not WebAssembly versions'}`
            + ' (SUBMISSION.json bot.kind wasm and bundle/arena.json), and the games machine plays nothing else');
    }
    let decks = null;
    if (ROUND_DECKS) {
        const d = deckLists(ROUND_DECKS.file, ROUND_DECKS.skip ?? []);
        decks = { file: d.file, sha256: d.sha256, names: d.names, deal: 'seat', skipped: d.skipped, lists: d.lists };
    }
    fs.mkdirSync(DIRS.bundles, { recursive: true, mode: 0o755 });
    if (!fs.lstatSync(DIRS.bundles).isDirectory()) {
        throw new Error(`${DIRS.bundles} is not a folder (a link?)`);
    }
    const bundles = Object.fromEntries(bots.map((n) => [n, storeBundle(n)]));
    // ladder.js's bots rows (summarize): describeBot less the name
    const botInfo = Object.fromEntries(bots.map((n) => {
        const { name, ...info } = describeBot(n);
        return [n, info];
    }));
    const rules = roundRules(k, { games, capMs });
    if (!Number.isSafeInteger(rules.capMs) || rules.capMs < 1000) {
        throw new Error(`round ${k}: its time limit ${JSON.stringify(rules.capMs)} is not a whole number of milliseconds, 1000 or more (roster.json thinkCapMs)`);
    }
    // only in a real folder: one the bots' user once had could hold a link in its place
    const dir = path.join(home.RESULTS, ladderIdOf(k));
    if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
        fs.rmSync(path.join(dir, 'referee.lock'), { force: true });
    }
    return { round: k, bots, gamesPerPair: rules.games + (rules.games % 2), capMs: rules.capMs, decks, bundles, botInfo };
}

const ARENAS = ['open']; // the No-sims arena comes later

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

    round(o) {
        arena(o);
        const k = Number(need(o, 'round', int));
        const games = o.games === undefined ? 2 : Number(need(o, 'games', (v) => int(v) && Number(v) >= 1 && Number(v) <= 100));
        const capMs = o['cap-ms'] === undefined ? null : Number(need(o, 'cap-ms', (v) => int(v) && Number.isSafeInteger(Number(v)) && Number(v) >= 1000));
        return roundSpec(k, { games, capMs });
    },

    publish(o) {
        arena(o);
        const k = Number(need(o, 'round', int));
        const referee = require('./referee');
        // the results folder is root's (setup); a link in place of the round's folder or its ladder.json is refused
        // all the same, as root reads and publishes what is there
        const dir = path.join(home.RESULTS, referee.ladderIdOf(k));
        for (const [p, ok, what] of [[dir, (s) => s.isDirectory(), 'folder'], [path.join(dir, 'ladder.json'), (s) => s.isFile(), 'file']]) {
            const s = fs.lstatSync(p, { throwIfNoEntry: false });
            if (s && !ok(s)) {
                throw new Error(`${p} is not a ${what} (a link?): round ${k} is not published from it`);
            }
        }
        // null: no ladder.json yet, nothing to publish
        const rd = referee.publish(k);
        return { ok: true, status: rd?.status ?? null };
    },

    decks(o) {
        // a deck file of this checkout's bot/decks, by its plain name: never a path
        const file = need(o, 'file', (v) => typeof v === 'string' && DECK_FILE.test(v));
        const full = path.join(DECKS_DIR, file);
        if (!fs.lstatSync(full, { throwIfNoEntry: false })?.isFile()) {
            throw new Usage(`--file: no deck file ${file} in bot/decks`);
        }
        const skip = o.skip === undefined ? [] : need(o, 'skip').split(',').filter(Boolean);
        return deckLists(full, skip);
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
    const cmd = Object.hasOwn(commands, argv[0] ?? '') ? commands[argv[0]] : null;
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

module.exports = { commands, readState, planRound, botEnv, readableMode };
