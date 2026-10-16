#!/usr/bin/env node
'use strict';
/**
 * The bot dev harness: plays the bot you are writing the way the arena plays it, here, and says how it did. The bot
 * only reads protocol messages on stdin and writes its replies on stdout (spec/protocol.md); the harness does the rest
 * with the arena's own code, and never sends anything anywhere.
 *
 *   npm run dev -- <folder> [--entry FILE] [--vs LIST] [--games N] [--seed S] [--cap-sec N] [--jobs N] [--out DIR]
 *                  [--name NAME] [--owner LOGIN]
 *   node bot/dev.js --view <run folder> [--port P]
 *
 * <folder> is what arena_submit takes: a bundle (it has an arena.json: kind wasm), the source of a Python bot
 * (--entry X.py: kind python) or of a JavaScript bot (bot.js, or --entry X.js: kind js). A file path such as
 * ../v3/main.py is short for its folder and --entry main.py. Every file goes, except dot files and folders,
 * __pycache__ and node_modules (ops/house-submit.js houseDoc).
 *   --vs LIST     opponents, comma separated (default heuristic,rush): heuristic and rush (the referee's own bots, run
 *                 in process), random (the protocol random bot, build/compiled/node-random), or a bot folder (or entry
 *                 file) packed like yours: a previous version, a resident's bundle. Each plays as <folder name>-v1.
 *   --games N     games per opponent, made even: every seed is played from both seats (default 10). --games 0 only
 *                 packs and start-checks: the check to make before arena_submit.
 *   --seed S      the first seed (default 1). The same seed gives the same deals and keys, so a bot that seeds itself
 *                 from hello.seed plays the same games again. Vary it: one seed plays one deck pair.
 *   --cap-sec N   each bot's thinking time per game, 10..600 s (default 60, the games machine's default)
 *   --jobs N      seeds played at once, two games each (default: half the CPUs less one, at least 1)
 *   --out DIR     the run folder (default <folder>/.runs/<UTC time>-s<seed>: a dot folder, so it is never packed)
 *   --name NAME   the competitor name (default: the folder's name); the bot plays as NAME-v1
 *   --owner LOGIN pack as LOGIN's arena_submit would (default: as a house submission), held to arena_submit's limits
 *                 (files, size, paths: window.js submitFiles), which a house submission only gets a warning about.
 *                 Only a Python bot's bundle id changes with it (its arena.json names the submitter).
 *
 * How (each step is the arena's code, run as the arena runs it):
 *   1. pack and start-check every bot folder with the arena's checker (`node bot/arena/intake.js --check`): Javy for
 *      JavaScript, CPython for WASI for Python, bundle.py, a hello with two real deck lists and their card data in the
 *      sandbox, the canonical tar. A refusal prints the intake's own words.
 *   2. deal like a rated round: ratings.js gauntlet (every opponent gets the same seeds, each seed from both seats),
 *      the round's deck lists (referee.js roundDeckLists) dealt by seat (decklists.js dealDecks), a game key per seed
 *      from a run key fixed by --seed, the round's limits for the cap (game-pool.js roundLimits).
 *   3. play each seed's games as one play-seed.js job (play-seed.js seedJob, checked by checkJob), as the games
 *      machine plays them: the bundles in the wasmtime sandbox (bot/compiled/run.py), heuristic and rush in process,
 *      the guard's time cap, the watchdog, replays.
 *   4. record and report: run.json, index.json and ladder.json (the ladder's formats), games/<id>.jsonl (replays with
 *      their keys, so `node bot/trace.js check` plays them again), and per game the bots' transcripts in bots/
 *      (stdio.js StdioClient log: protocol lines as sent and read, stderr, sandbox stats).
 *
 * Every child gets an environment built here (no window address, no token, no NODE_ENV), in a process group of its
 * own that is killed when it ends, on a time-out, on an error and on Ctrl-C. Nothing here loads arena/push.js or
 * ladder.js. Exit 0: every game played and the bot never lost one by its own fault; 1: it did, or a job failed;
 * 2: usage, or the sandbox is not set up (npm run setup); 3: the arena would refuse a bot (its words are printed).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const COMPILED = path.join(ROOT, 'build', 'compiled');
const VENV_BIN = path.join(COMPILED, 'venv', 'bin');
const INTAKE = path.join(__dirname, 'arena', 'intake.js');
const PLAY_SEED = path.join(__dirname, 'arena', 'play-seed.js');
const KIT = path.join(ROOT, 'vendor', 'holotable', 'swu-viewer-kit.js');
const RESIDENTS = ['heuristic', 'rush']; // play-seed.js IN_PROCESS
const RANDOM = { name: 'node_random', folder: path.join(COMPILED, 'node-random') };
const NAME = /^[a-z][a-z0-9_]{0,31}$/; // house-submit.js, intake.js
const LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/; // intake.js
const SLACK_MS = 120000; // server/src/games/Executor.ts: a job's time past its gameMs
const OUT_MAX = 16 << 20; // play-seed's answer line, at most (Executor.ts MAX_ANSWER_BYTES)
const NEVER = ['SWU_WINDOW', 'SWU_WINDOW_TOKEN', 'ARENA_PUSH_TOKEN', 'ARENA_REMOTE', 'ARENA_ADMIN_TOKEN'];

// nothing this process starts may reach a window, whatever the caller's environment holds
for (const k of NEVER) {
    delete process.env[k];
}

const USAGE = `usage:
  npm run dev -- <folder | entry file> [--entry FILE] [--vs heuristic,rush,random,<folder>...] [--games N] [--seed S]
                 [--cap-sec N] [--jobs N] [--out DIR] [--name NAME] [--owner LOGIN]
  node bot/dev.js --view <run folder> [--port P]
Plays your bot as the arena does: packed and start-checked by the arena's intake, in the same sandbox, dealt the
rated rounds' deck lists by seat, under the rated games' time rules. --games 0 only packs and checks. bot/dev.js and
bot/arena/BUILD.md ("Test locally") say more.`;

class Usage extends Error {}
const usage = (msg) => {
    throw new Usage(msg);
};

// `npm run dev -- ../mybot` runs here from the repo root: paths are the caller's
const CWD = process.env.npm_lifecycle_event === 'dev' && process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd();
const absolute = (p) => path.resolve(CWD, p);

/** The command line as options; throws Usage. */
function parseArgs(argv) {
    const o = { vs: 'heuristic,rush', games: '10', seed: '1', 'cap-sec': '60' };
    const takes = new Set(['entry', 'vs', 'games', 'seed', 'cap-sec', 'jobs', 'out', 'name', 'owner', 'view', 'port']);
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') {
            o.help = true;
        } else if (a.startsWith('--')) {
            const [k, inline] = a.slice(2).split(/=(.*)/s);
            if (!takes.has(k)) {
                usage(`unknown option ${a}`);
            }
            const v = inline ?? argv[++i];
            if (v === undefined || (inline === undefined && v.startsWith('--'))) {
                usage(`${a} takes a value`);
            }
            o[k] = v;
        } else {
            rest.push(a);
        }
    }
    if (o.help) {
        return o;
    }
    const int = (k, lo, hi) => {
        const n = Number(o[k]);
        if (!Number.isSafeInteger(n) || n < lo || n > hi) {
            usage(`--${k}: a whole number from ${lo} to ${hi}`);
        }
        return n;
    };
    if (o.view !== undefined) {
        if (rest.length) {
            usage('--view takes a run folder and nothing else');
        }
        return { view: absolute(o.view), port: o.port === undefined ? 0 : int('port', 0, 65535) };
    }
    if (rest.length !== 1) {
        usage('give one bot folder (or its entry file): npm run dev -- <folder>');
    }
    const games = int('games', 0, 1000);
    return {
        target: absolute(rest[0]), entry: o.entry ?? null, vs: o.vs.split(',').map((s) => s.trim()).filter(Boolean),
        games: games + (games % 2), seed: int('seed', 0, 2 ** 31), capSec: int('cap-sec', 10, 600),
        jobs: o.jobs === undefined ? Math.max(1, Math.floor((os.cpus().length - 1) / 2)) : int('jobs', 1, 32),
        out: o.out === undefined ? null : absolute(o.out), name: o.name ?? null, owner: o.owner === undefined ? null : o.owner.toLowerCase()
    };
}

/** A bot to pack: {folder, entry} from a folder, or from an entry file inside one. */
function botAt(p, entry = null) {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (!st) {
        usage(`${p}: no such file or folder`);
    }
    if (st.isDirectory()) {
        return { folder: p, entry };
    }
    if (entry) {
        usage(`${p} is a file and names the entry itself: no --entry`);
    }
    return { folder: path.dirname(p), entry: path.basename(p) };
}

/**
 * A folder with no arena.json and no bot.js but a bot.py is a Python bot: its entry is bot.py, as arena_submit takes
 * kind python with no entry.
 */
function withDefaultEntry(b) {
    const has = (f) => fs.existsSync(path.join(b.folder, f));
    return !b.entry && !has('arena.json') && !has('bot.js') && has('bot.py') ? { ...b, entry: 'bot.py' } : b;
}

/** A competitor name from a folder's name: lowercase letters, digits and _, starting with a letter. */
function nameOf(folder) {
    let n = path.basename(folder).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!/^[a-z]/.test(n)) {
        n = `bot_${n}`;
    }
    return n.slice(0, 32);
}

/**
 * The environment of every child: PATH with the sandbox's virtualenv first (run.py, bundle.py and the checker run the
 * python3 they find there), HOME, LANG, TZ, the compiled-code cache, ARENA_HOME in the run, and `extra`. Nothing else:
 * no window address, no token, no NODE_ENV (the engine words its prompts by it), as the games machine's children
 * (server/src/games/Proc.ts childEnv). Node is started by its path.
 */
function childEnv(run, extra = {}) {
    const dirs = [VENV_BIN, ...(process.env.PATH ?? '').split(path.delimiter)].filter((d) => d && (d !== VENV_BIN || fs.existsSync(d)));
    return {
        PATH: [...new Set(dirs)].join(path.delimiter), HOME: process.env.HOME ?? os.homedir(), LANG: process.env.LANG || 'C.UTF-8', TZ: 'UTC',
        SWU_WASM_CACHE: process.env.SWU_WASM_CACHE || path.join(COMPILED, '.cache'), ARENA_HOME: path.join(run, 'arena'), ...extra
    };
}

// process groups of the children running now: killed when they end, and all of them when this process stops
const groups = new Set();
const killGroup = (pgid) => {
    try {
        process.kill(-pgid, 'SIGKILL');
    } catch {} // gone already
};
process.on('exit', () => groups.forEach(killGroup));
// Ctrl-C (and a TERM or HUP) stops every child; a run in progress first writes what it has (onStop)
let onStop = () => undefined;
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
        if (stopping) {
            return;
        }
        stopping = true;
        groups.forEach(killGroup);
        try {
            onStop(sig);
        } catch {} // as much as there is
        process.exit(130);
    });
}

/**
 * Runs argv in a process group of its own; resolves to {code, signal, out, err, ms, timedOut}. Its group is killed when
 * it exits (whatever it left running goes with it) or after timeoutMs. stderr goes to `errFile` when given.
 */
function runChild(argv, { env, timeoutMs = 0, errFile = null }) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const errFd = errFile ? fs.openSync(errFile, 'w') : 'pipe';
        const child = spawn(argv[0], argv.slice(1), { cwd: ROOT, env, stdio: ['ignore', 'pipe', errFd], detached: true });
        if (errFile) {
            fs.closeSync(errFd);
        }
        let out = '';
        let err = '';
        let timedOut = false;
        child.stdout.on('data', (d) => {
            out = (out + d).slice(-OUT_MAX);
        });
        child.stderr?.on('data', (d) => {
            err = (err + d).slice(-64000);
        });
        if (child.pid) {
            groups.add(child.pid);
        }
        const timer = timeoutMs ? setTimeout(() => {
            timedOut = true;
            killGroup(child.pid);
        }, timeoutMs) : null;
        const end = (code, signal, why = null) => {
            clearTimeout(timer);
            if (child.pid) {
                killGroup(child.pid);
                groups.delete(child.pid);
            }
            resolve({ code, signal, out, err: why ? `${err}${why}\n` : err, ms: Date.now() - t0, timedOut });
        };
        child.on('exit', () => child.pid && killGroup(child.pid));
        child.on('error', (e) => end(null, null, e.message));
        child.on('close', (code, signal) => end(code, signal));
    });
}

/** The last stdout line as JSON, or null. */
function lastJson(out) {
    try {
        return JSON.parse(String(out).trimEnd().split('\n').pop());
    } catch {
        return null;
    }
}

const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const dur = (ms) => (ms == null ? '-' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const secs = (ms) => (ms / 1000).toFixed(1);
// a path as the caller would type it: relative to where they are when that is short, else absolute
const rel = (p) => {
    const r = path.relative(CWD, p);
    return r && !path.isAbsolute(r) && r.split(path.sep).filter((x) => x === '..').length <= 2 ? r : p;
};
// one of the repo's scripts, for a command to paste where the caller is (npm --prefix runs from anywhere)
const script = (p) => rel(path.join(ROOT, p));
const readLines = (file) => {
    try {
        return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    } catch {
        return null;
    }
};

/** The tools missing for these kinds of bot, as one line, or null (intake.js toolsMissing, with the child's PATH). */
function sandboxMissing(kinds, run) {
    const missing = [];
    if (!fs.existsSync(path.join(ROOT, 'forceteki', 'build', 'server')) || !fs.existsSync(path.join(ROOT, 'forceteki', 'test', 'json'))) {
        missing.push('the engine and its card data');
    }
    const was = process.env.PATH;
    process.env.PATH = childEnv(run).PATH;
    try {
        missing.push(...require('./arena/intake').toolsMissing(kinds));
    } finally {
        process.env.PATH = was;
    }
    return missing.length ? `the sandbox is not set up (no ${missing.join(', ')}): npm run setup` : null;
}

/**
 * Packs and start-checks one bot with the arena's checker (intake.js --check, in <run>/check/<name>/) and stores its
 * canonical tar in <run>/bundles/<sha256>.tar. Resolves to {ok, sha256, ms} or {ok: false, error} (the arena's words)
 * or {ok: false, broken} (the checker gave no result).
 */
async function packAndCheck(bot, run) {
    const work = path.join(run, 'check', bot.name);
    fs.mkdirSync(work, { recursive: true });
    const job = path.join(work, 'job.json');
    // as intake.js checkIsolated writes it: the submission, its owner, and the version its hello names
    fs.writeFileSync(job, JSON.stringify({ ...bot.doc, owner: bot.owner ?? bot.doc.owner, checkAs: bot.version }), { flag: 'wx' });
    const { CHECK_MS, lastResult } = require('./arena/intake');
    const r = await runChild([process.execPath, INTAKE, '--check', job, '-'], { env: childEnv(run), timeoutMs: CHECK_MS });
    fs.writeFileSync(path.join(work, 'check.log'), r.err);
    const res = lastResult(r.out);
    if (r.timedOut) {
        return { ok: false, ms: r.ms, error: `the check took more than ${CHECK_MS / 60000} minutes` };
    }
    if (!res) {
        return { ok: false, ms: r.ms, broken: `the checker ended with ${r.code ?? r.signal} and no result:\n${r.err.trim().split('\n').slice(-12).join('\n')}` };
    }
    if (!res.ok) {
        return { ok: false, ms: r.ms, error: String(res.error) };
    }
    const tar = fs.readFileSync(path.join(work, 'bundle.tar'));
    if (crypto.createHash('sha256').update(tar).digest('hex') !== res.sha256) {
        return { ok: false, ms: r.ms, broken: 'the bundle changed after its check' };
    }
    fs.mkdirSync(path.join(run, 'bundles'), { recursive: true });
    fs.writeFileSync(path.join(run, 'bundles', `${res.sha256}.tar`), tar);
    return { ok: true, ms: r.ms, sha256: res.sha256 };
}

/**
 * The games: ratings.js gauntlet (each opponent against the bot, the same seeds for every opponent, every seed from
 * both seats), dealt by seat from `lists` (decklists.js dealDecks), with ladder.js game ids.
 */
function schedule(bot, opponents, games, seed, nLists) {
    const { gauntlet } = require('./ratings');
    const { dealDecks } = require('./decklists');
    const plain = gauntlet(opponents, [bot], games, seed);
    return dealDecks(plain, nLists, seed, { by: 'seat' }).map((g) => ({ ...g, id: `${g.p1}-vs-${g.p2}-${g.seed}` }));
}

/** One play-seed job per seed and opponent, in seed order, each checked by play-seed's own checkJob. */
function jobsFor(games, bot, { runKey, limits, bots, lists, bundles }) {
    const { seedJob, checkJob } = require('./arena/play-seed');
    const { gameKey } = require('./rng');
    const by = new Map();
    for (const g of games) {
        const k = `${g.seed}|${g.p1 === bot ? g.p2 : g.p1}`;
        by.set(k, [...(by.get(k) ?? []), g]);
    }
    return [...by.values()].sort((a, b) => a[0].seed - b[0].seed).map((gs) => {
        const job = seedJob(gs[0].seed, gs, { key: gameKey(runKey, gs[0].seed), limits, bots, decks: lists });
        // as the job file holds it
        return checkJob(JSON.parse(JSON.stringify(job)), bundles);
    });
}

/** The last `n` exchanges of a transcript: [{sent, reply}], reply null when the bot wrote none; null without one. */
function lastExchanges(prefix, n = 2) {
    const sent = readLines(`${prefix}.in.jsonl`);
    if (!sent) {
        return null;
    }
    const replies = readLines(`${prefix}.out.jsonl`) ?? [];
    const from = Math.max(0, sent.length - n);
    return sent.slice(from).map((s, k) => ({ sent: s, reply: replies[from + k] ?? null }));
}

/** A referee line in a few words: its type, decision number, time left, prompt and how many actions. */
function sentLine(text) {
    let m;
    try {
        m = JSON.parse(text);
    } catch {
        return text.slice(0, 120);
    }
    if (m.t === 'decide') {
        const title = m.prompt?.title ?? m.prompt?.promptTitle ?? m.prompt?.type ?? '';
        return `decide ${m.seq}, ${m.ms == null ? 'no limit' : `${dur(m.ms)} left`}, "${String(title).slice(0, 60)}", ${m.actions?.length ?? 0} actions`;
    }
    if (m.t === 'hello') {
        return `hello as ${m.you}, ${m.ms == null ? 'no limit' : `${dur(m.ms)} left`}, ${m.cards?.length ?? 0} cards`;
    }
    if (m.t === 'simulated') {
        return `simulated${m.op ? ` ${m.op}` : ''}${m.error ? `: ${String(m.error).slice(0, 80)}` : ''}`;
    }
    return m.t ?? text.slice(0, 120);
}

/** Up to the last n lines of a file. */
const tailOf = (file, n) => (readLines(file) ?? []).slice(-n);

/** The sandbox's stats of a seat's program (run.py WASM_HOST_STATS), or null. */
function hostStats(prefix) {
    const lines = readLines(`${prefix}.host.json`);
    try {
        return lines?.length ? JSON.parse(lines.at(-1)) : null;
    } catch {
        return null;
    }
}

/**
 * Keeps what a game's transcripts are worth (about 1 MB per seat per game): the bot's stderr and sandbox stats every
 * game, its protocol lines in the games it did not win; an opponent's files only in a game it lost by its own fault.
 */
function prune(dir, g, r, botVersion) {
    for (const seat of ['p1', 'p2']) {
        const prefix = path.join(dir, `${g.id}.${seat}`);
        const mine = g[seat] === botVersion;
        const keep = mine ? ['stderr', 'host.json', ...(r.winner !== botVersion ? ['in.jsonl', 'out.jsonl'] : [])]
            : r.by === seat ? ['stderr', 'host.json', 'in.jsonl', 'out.jsonl'] : [];
        for (const ext of ['stderr', 'host.json', 'in.jsonl', 'out.jsonl']) {
            if (!keep.includes(ext)) {
                fs.rmSync(`${prefix}.${ext}`, { force: true });
            }
        }
    }
}

/** A table: rows of cells, columns padded to their widest cell. */
function table(rows) {
    const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
    return rows.map((r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd()).join('\n');
}

const git = (dir) => {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (r.status !== 0) {
        return null;
    }
    const dirty = spawnSync('git', ['-C', dir, 'status', '--porcelain', '--', '.'], { encoding: 'utf8' }).stdout?.trim();
    return `${r.stdout.trim()}${dirty ? '+dirty' : ''}`;
};

async function main(argv) {
    const o = parseArgs(argv);
    if (o.help) {
        console.log(USAGE);
        return 0;
    }
    if (o.view) {
        return view(o.view, o.port);
    }
    const t0 = Date.now();
    const { houseDoc } = require('./arena/ops/house-submit');
    const target = botAt(o.target, o.entry);
    if (o.owner !== null && !LOGIN.test(o.owner)) {
        usage('--owner: a GitHub login (letters, digits and single hyphens)');
    }
    if (o.name !== null && !NAME.test(o.name)) {
        usage('--name: 1-32 characters, lowercase letters, digits and _, starting with a letter');
    }

    // the bots: yours first, then each opponent
    const bot = { ...withDefaultEntry(target), owner: o.owner };
    const opponents = [];
    const seen = new Set();
    for (const item of o.vs) {
        if (seen.has(item)) {
            usage(`--vs names ${item} twice`);
        }
        seen.add(item);
        if (RESIDENTS.includes(item)) {
            opponents.push({ name: item, resident: true });
        } else if (item === 'random') {
            if (!fs.existsSync(path.join(RANDOM.folder, 'arena.json'))) {
                usage(`--vs random plays ${rel(RANDOM.folder)}, which is not built: npm run setup`);
            }
            opponents.push({ folder: RANDOM.folder, entry: null, want: RANDOM.name });
        } else if (/^[a-z][a-z0-9_#-]*$/.test(item) && !fs.existsSync(absolute(item))) {
            usage(`--vs ${item}: the opponents are heuristic, rush, random, or a bot folder (other built-in bots do not play in the arena's games)`);
        } else {
            opponents.push(withDefaultEntry(botAt(absolute(item))));
        }
    }
    if (!opponents.length && o.games > 0) {
        usage('--vs: at least one opponent');
    }
    const packed = [bot, ...opponents.filter((x) => !x.resident)];

    // the run folder: never one that would be packed with a bot
    const stamp = new Date(t0).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const run = o.out ?? path.join(bot.folder, '.runs', `${stamp}-s${o.seed}`);
    for (const b of packed) {
        const inside = path.relative(b.folder, run);
        if (!inside.startsWith('..') && !path.isAbsolute(inside) && !inside.split(path.sep).some((p) => p.startsWith('.'))) {
            usage(`--out ${rel(run)} is inside ${rel(b.folder)}, so the arena would get it with the bot: put it under a dot folder (the default is ${rel(path.join(b.folder, '.runs'))})`);
        }
    }
    if (fs.existsSync(run) && fs.readdirSync(run).length) {
        usage(`${rel(run)} is not empty: give another --out`);
    }
    // before anything loads arena/home.js (players/index.js does): this run's own arena folder, never a shared one, and
    // the repo's own list of bot programs (as play-seed.js reads it)
    process.env.ARENA_HOME = path.join(run, 'arena');
    delete process.env.SWU_EXTERNAL_BOTS;

    // names: each once, and none a built-in bot would answer to (play-seed.js checkResolved refuses that)
    const taken = new Set(RESIDENTS);
    const named = (want) => {
        let n = want;
        for (let k = 2; taken.has(n) || isBuiltIn(`${n}-v1`); k++) {
            n = `${want.slice(0, 32 - `_${k}`.length)}_${k}`;
        }
        taken.add(n);
        return n;
    };
    for (const b of packed) {
        b.name = named(b === bot ? o.name ?? nameOf(b.folder) : b.want ?? nameOf(b.folder));
        b.version = `${b.name}-v1`;
        try {
            b.doc = houseDoc(b.name, b.folder, { note: 'a dev harness run', entry: b.entry });
        } catch (e) {
            // what arena_submit or the intake would say about the folder itself
            console.log(`${b.version} (${rel(b.folder)}): the arena would refuse it:\n${e.message}`);
            return 3;
        }
        b.kind = b.doc.kind;
        b.files = Object.fromEntries(Object.keys(b.doc.files).map((p) => [p, fs.statSync(path.join(b.folder, p)).size]));
    }
    // arena_submit's own limits (count, size, paths) bind a builder's bot; a house submission is held only to the intake's
    try {
        require('./arena/window').submitFiles(bot.doc);
    } catch (e) {
        if (bot.owner !== null) {
            console.log(`${bot.version} (${rel(bot.folder)}): arena_submit would refuse it:\n${e.message}`);
            return 3;
        }
        bot.submitProblem = e.message;
    }
    const why = sandboxMissing([...new Set(packed.map((b) => b.kind))], run);
    if (why) {
        console.log(why);
        return 2;
    }
    fs.mkdirSync(run, { recursive: true });

    const capMs = o.capSec * 1000;
    const limits = require('./game-pool').roundLimits(capMs);
    const runKey = crypto.createHash('sha256').update(`swu-dev:${o.seed}`).digest('hex').slice(0, 32);
    const keyId = crypto.createHash('sha256').update(runKey).digest('hex').slice(0, 12);
    const doc = {
        schema: 'swu-dev-run/1', status: 'running', command: ['node', path.relative(ROOT, __filename), ...argv].join(' '), createdAt: new Date(t0).toISOString(),
        versions: { node: process.version, repo: git(ROOT), engine: git(path.join(ROOT, 'forceteki')), toolchain: describeToolchain() },
        limits: { capMs, hangMs: limits.hangMs, gameMs: limits.gameMs, maxSteps: limits.maxSteps, jobs: o.jobs },
        seeds: null, keyId, decks: null, bot: null, opponents: null, games: [], table: [], failures: [], jobFailures: []
    };
    const save = () => fs.writeFileSync(path.join(run, 'run.json'), `${JSON.stringify(doc, null, 1)}\n`);
    const botRow = (b, check) => ({
        name: b.name, version: b.version, kind: b.kind, folder: b.folder, entry: b.doc.entry ?? (b.kind === 'wasm' ? null : 'bot.js'), owner: b.owner ?? '@arena',
        files: b.files, bundle: check?.sha256 ?? null, checkMs: check?.ms ?? null
    });

    // 1. pack and check (the checkers run while this process loads the deck lists, which takes the engine a few seconds)
    const checking = new Map();
    for (const b of packed) {
        const same = packed.find((x) => x !== b && checking.has(x) && x.folder === b.folder && x.entry === b.entry && (x.owner ?? null) === (b.owner ?? null));
        checking.set(b, same ? checking.get(same) : packAndCheck(b, run));
    }
    let decks = null;
    if (o.games > 0) {
        decks = require('./arena/referee').roundDeckLists();
    }
    const checks = new Map();
    for (const [b, p] of checking) {
        checks.set(b, await p);
    }
    doc.bot = { ...botRow(bot, checks.get(bot)), ...(bot.submitProblem ? { arenaSubmitRefuses: bot.submitProblem } : {}) };
    doc.opponents = opponents.map((x) => (x.resident ? { name: x.name, version: x.name, kind: 'resident' } : botRow(x, checks.get(x))));
    const files = Object.entries(bot.files);
    const bytes = files.reduce((s, [, n]) => s + n, 0);
    console.log(`${bot.version}: ${bot.kind}, ${files.length} file${files.length === 1 ? '' : 's'} (${kb(bytes)}) from ${rel(bot.folder)}`);
    console.log(`  files the arena gets: ${files.slice(0, 12).map(([p, n]) => `${p} (${kb(n)})`).join(', ')}${files.length > 12 ? `, and ${files.length - 12} more` : ''}`);
    if (bot.submitProblem) {
        console.log(`  warning: arena_submit would refuse these files (${bot.submitProblem}); only a house submission (ops/house-submit.js) can enter them`);
    }
    for (const b of packed) {
        const c = checks.get(b);
        if (c.ok) {
            console.log(`  ${b === bot ? '' : `${b.version}: `}packed and start-checked by the arena's checker in ${secs(c.ms)} s: bundle ${c.sha256}`);
        }
    }
    const refused = packed.filter((b) => !checks.get(b).ok);
    if (refused.length) {
        for (const b of refused) {
            const c = checks.get(b);
            console.log(c.error ? `\n${b.version} (${rel(b.folder)}): the arena would refuse it:\n${c.error}`
                : `\n${b.version}: the check failed (${rel(path.join(run, 'check', b.name, 'check.log'))}):\n${c.broken}`);
        }
        doc.status = 'refused';
        doc.failures = refused.map((b) => ({ bot: b.version, error: checks.get(b).error ?? checks.get(b).broken }));
        save();
        return refused.some((b) => checks.get(b).error) ? 3 : 1;
    }
    if (o.games === 0) {
        doc.status = 'checked';
        save();
        console.log(`\nno games (--games 0). ${rel(run)} has the check: check/${bot.name}/bundle holds the arena.json the arena would build.`);
        return 0;
    }

    // 2. the deal
    const versions = (x) => (x.resident ? x.name : x.version);
    const opp = opponents.map(versions);
    const games = schedule(bot.version, opp, o.games, o.seed, decks.lists.length);
    const bots = Object.fromEntries([bot, ...opponents].map((x) => [versions(x), x.resident ? { kind: 'resident' } : { kind: 'wasm', bundle: checks.get(x).sha256 }]));
    const bundles = path.join(run, 'bundles');
    const jobs = jobsFor(games, bot.version, { runKey, limits, bots, lists: decks.lists, bundles });
    const seeds = [...new Set(games.map((g) => g.seed))];
    const { deckPairs } = require('./decklists');
    const pairs = deckPairs(decks.lists.length);
    doc.seeds = { first: seeds[0], last: seeds.at(-1), gamesPerOpponent: o.games };
    doc.decks = {
        file: decks.file, sha256: decks.sha256, names: decks.names, skipped: decks.skipped, deal: 'seat',
        pairs: seeds.map((s) => {
            const g = games.find((x) => x.seed === s);
            return { seed: s, pair: ((s % pairs.length) + pairs.length) % pairs.length, p1: decks.names[g.decks[0]], p2: decks.names[g.decks[1]] };
        })
    };
    console.log(`  opponents: ${opponents.map((x) => (x.resident ? `${x.name} (in process)` : `${x.version} (${rel(x.folder)})`)).join(', ')}`);
    console.log(`  seeds ${seeds[0]}-${seeds.at(-1)}: ${o.games} games per opponent, ${seeds.length} of the ${pairs.length} deck pairs of ${decks.file}${decks.skipped.length ? ` less ${decks.skipped.join(', ')}` : ''}`);
    console.log(`  ${o.capSec} s thinking per bot per game, ${o.jobs} seed${o.jobs === 1 ? '' : 's'} at a time -> ${rel(run)}`);
    save();

    // 3. compile the bundles, then play
    const hexes = [...new Set([...checks.values()].map((c) => c.sha256))];
    const warmed = await runChild([process.execPath, PLAY_SEED, '--warm', '--bundles', bundles, ...hexes], { env: childEnv(run), timeoutMs: 60000 + hexes.length * 120000 });
    for (const f of lastJson(warmed.out)?.failed ?? []) {
        console.log(`  warning: could not compile ${f.name.slice(0, 12)} before its games (${f.error}); its games compile it`);
    }
    const botsDir = path.join(run, 'bots');
    const gamesDir = path.join(run, 'games');
    fs.mkdirSync(botsDir, { recursive: true });
    fs.mkdirSync(gamesDir, { recursive: true });
    console.log('');
    const total = games.length;
    const results = new Map(); // game id -> result
    const queue = [...jobs];
    const record = () => {
        const out = finish(doc, { bot, opponents, versions, games, results, capMs, decks, run, keyId, limits, o });
        save();
        return out;
    };
    onStop = (sig) => {
        doc.status = 'stopped';
        console.log(`\nstopped (${sig}) after ${results.size} of ${total} games; ${rel(run)} has them`);
        record();
    };
    const playJob = async (job) => {
        const work = path.join(run, 'work', `${job.seed}-${job.games[0].p1 === bot.version ? job.games[0].p2 : job.games[0].p1}`);
        fs.mkdirSync(work, { recursive: true });
        fs.writeFileSync(path.join(work, 'job.json'), JSON.stringify(job));
        const log = path.join(work, 'play-seed.log');
        const r = await runChild([process.execPath, PLAY_SEED, '--job', path.join(work, 'job.json'), '--bundles', bundles, '--work', work],
            { env: childEnv(run, { SWU_BOT_LOG: botsDir }), timeoutMs: job.gameMs + SLACK_MS, errFile: log });
        if (stopping) {
            return;
        }
        // play-seed's answer, read as the games machine reads it (Executor.ts readAnswer)
        const answer = lastJson(r.out);
        const ids = job.games.map((g) => g.id);
        const got = new Map((Array.isArray(answer?.results) ? answer.results : []).filter((e) => ids.includes(e?.id) && e.result).map((e) => [e.id, e.result]));
        if (r.code !== 0 || answer?.ok !== true || got.size !== ids.length) {
            const why = r.timedOut ? `it ran past its time (${secs(job.gameMs + SLACK_MS)} s)` : r.code !== 0 ? `play-seed exited ${r.code ?? r.signal}` : 'play-seed gave no result for every game';
            doc.jobFailures.push({ seed: job.seed, games: ids, why, log: path.relative(run, log), tail: tailOf(log, 12) });
            console.log(`[seed ${job.seed}] ${ids.join(', ')}: ${why}; ${rel(log)} has its output`);
            return;
        }
        const { addReplayKey } = require('./recorder');
        for (const g of job.games) {
            const res = got.get(g.id);
            const from = path.join(work, 'out', `${g.id}.jsonl`);
            if (fs.existsSync(from)) {
                const to = path.join(gamesDir, `${g.id}.jsonl`);
                fs.renameSync(from, to);
                if (res.key) {
                    addReplayKey(to, res.key);
                }
            }
            prune(botsDir, g, res, bot.version);
            results.set(g.id, res);
            console.log(`[${results.size}/${total}] ${gameLine(g, res, bot.version, capMs)}`);
        }
        fs.rmSync(work, { recursive: true, force: true });
        record();
    };
    const lanes = Array.from({ length: Math.min(o.jobs, queue.length) }, async () => {
        for (let job; (job = queue.shift());) {
            await playJob(job);
        }
    });
    await Promise.all(lanes);
    // a failed job's folder stays, with its play-seed.log
    for (const d of ['work', 'arena']) {
        try {
            fs.rmdirSync(path.join(run, d));
        } catch {} // not there, or not empty
    }
    doc.status = 'done';
    doc.finishedAt = new Date().toISOString();
    const report = record();
    console.log(`\n${report.text}`);
    console.log(`\n${games.length} games in ${secs(Date.now() - t0)} s. ${rel(run)}: run.json, index.json, ladder.json, games/ (replays), bots/ (transcripts), bundles/, check/`);
    console.log(`  watch:        node ${script('bot/dev.js')} --view ${rel(run)}`);
    console.log(`  play again:   node ${script('bot/trace.js')} check ${rel(gamesDir)}`);
    return report.exit;
}

/** True when a version name would play as one of the referee's built-in bots (play-seed.js checkResolved refuses it). */
function isBuiltIn(version) {
    return require('./players').describeBot(version) !== null;
}

/** The pinned sandbox tools, for run.json. */
function describeToolchain() {
    const t = require('./compiled/toolchain.json');
    return { wasmtime: t.python.wasmtime, javy: t.javy.version, python: t.runtimes['python-3.14-wasi']?.dir ?? null };
}

/** One finished game in a line, from the bot's side: `[3/20] rush-vs-mybot-v1-2: won mybot-v1 R9 211 steps 8.1 s think 6.2/60 s`. */
function gameLine(g, r, botVersion, capMs) {
    const seat = g.p1 === botVersion ? 'p1' : 'p2';
    const loser = r.by ? g[r.by] : null;
    const what = r.outcome === 'won' ? `won ${r.winner}` : r.by ? `${loser} lost by ${r.faultKind ?? 'error'}` : r.outcome === 'ERROR' ? 'engine error' : r.outcome;
    const think = r.think?.[seat];
    return `${g.id}: ${what} R${r.round} ${r.steps} steps ${secs(r.ms)} s think ${think == null ? '-' : secs(think)}/${capMs / 1000} s${r.by && r.error ? `: ${String(r.error).split('\n')[0].slice(0, 160)}` : ''}`;
}

/**
 * Writes index.json and ladder.json and fills the run's games, table and failures; gives {text, exit}: the report and
 * the exit code (1 when the bot lost a game by its own fault or a job failed).
 */
function finish(doc, { bot, opponents, versions, games, results, capMs, decks, run, keyId, limits, o }) {
    const { summarize } = require('./ladder-report');
    const botDir = path.join(run, 'bots');
    const played = games.filter((g) => results.has(g.id));
    const entry = (g) => {
        const r = results.get(g.id);
        return {
            id: g.id, seed: g.seed, p1: g.p1, p2: g.p2, winner: r.winner ?? null, winnerSeat: r.winnerSeat ?? null, outcome: r.outcome, rounds: r.round, steps: r.steps, ms: r.ms,
            error: r.error ?? null, by: r.by ?? null, faultKind: r.faultKind ?? null, timing: r.timing ?? null, host: null,
            decks: { p1: decks.names[g.decks[0]], p2: decks.names[g.decks[1]] }, ...(r.versions ? { versions: r.versions } : {}), ...(r.key ? { key: r.key } : {})
        };
    };
    const names = [...opponents.map(versions), bot.version];
    const index = { id: path.basename(run), createdAt: doc.createdAt, engine: null, bots: names, gamesPerPairing: o.games, games: played.map(entry) };
    fs.writeFileSync(path.join(run, 'index.json'), JSON.stringify(index));
    const botInfo = Object.fromEntries(names.map((n) => {
        // a version is unpacked only inside its job, so here it reads as registry.js describes a WebAssembly version
        const { name, ...info } = require('./players').describeBot(n) ?? { name: n, kind: 'arena', profile: n.replace(/-v\d+$/, ''), depth: null, lang: 'wasm', version: 1 };
        return [n, info];
    }));
    const config = {
        bots: names, gamesPerPair: o.games, firstSeed: o.seed, maxSteps: limits.maxSteps, workers: o.jobs, capMs, hangMs: limits.hangMs, keyId, record: true,
        format: 'gauntlet', vs: [bot.version], decks: { file: decks.file, sha256: decks.sha256, names: decks.names, deal: 'seat', skipped: decks.skipped }
    };
    const ladderGames = played.map((g) => ({ ...entry(g), think: results.get(g.id).think ?? null, botStats: results.get(g.id).botStats ?? null }));
    fs.writeFileSync(path.join(run, 'ladder.json'), JSON.stringify(summarize({
        id: path.basename(run), createdAt: doc.createdAt, status: doc.status === 'done' ? 'done' : 'running', engine: null, config, botInfo, games: ladderGames, scheduled: games.length
    })));
    doc.games = played.map((g) => ({ id: g.id, seed: g.seed, p1: g.p1, p2: g.p2, decks: { p1: decks.names[g.decks[0]], p2: decks.names[g.decks[1]] }, result: results.get(g.id) }));

    // the table, one row per opponent, from the bot's side
    const seatOf = (g) => (g.p1 === bot.version ? 'p1' : 'p2');
    const rows = [];
    for (const x of opponents) {
        const v = versions(x);
        const gs = played.filter((g) => g.p1 === v || g.p2 === v);
        const rs = gs.map((g) => ({ g, r: results.get(g.id), s: seatOf(g) }));
        const faults = {};
        for (const { r, s } of rs.filter(({ r, s }) => r.by === s)) {
            faults[r.faultKind ?? 'error'] = (faults[r.faultKind ?? 'error'] ?? 0) + 1;
        }
        const think = rs.map(({ r, s }) => r.think?.[s]).filter((t) => typeof t === 'number');
        const timing = rs.map(({ r, s }) => r.timing?.[s]).filter((t) => t && t.n > 0);
        const memory = rs.map(({ g, s }) => hostStats(path.join(botDir, `${g.id}.${s}`))?.guest_memory_mb).filter((m) => typeof m === 'number');
        rows.push({
            opponent: v, games: gs.length,
            wins: rs.filter(({ r }) => r.winner === bot.version).length, losses: rs.filter(({ r }) => r.winner === v).length, draws: rs.filter(({ r }) => r.winner === 'draw').length,
            botFaults: faults, opponentFaults: rs.filter(({ r, s }) => r.by && r.by !== s).length, noResult: rs.filter(({ r }) => !r.by && r.outcome !== 'won').length,
            thinkMeanMs: think.length ? think.reduce((a, b) => a + b, 0) / think.length : null, thinkMaxMs: think.length ? Math.max(...think) : null,
            // per decision: the worst game's p95, and the longest decision of all
            decideP95Ms: timing.length ? Math.max(...timing.map((t) => t.p95)) : null, decideMaxMs: timing.length ? Math.max(...timing.map((t) => t.max)) : null,
            memoryMb: memory.length ? Math.max(...memory) : null
        });
    }
    doc.table = rows;
    const lines = [];
    lines.push(table([
        [`${bot.version} vs`, 'games', 'W-L-D', 'bot faults', 'no result', `think mean/max (cap ${capMs / 1000} s)`, 'decide p95/max', 'memory'],
        ...rows.map((r) => [
            r.opponent, r.games, `${r.wins}-${r.losses}-${r.draws}`, Object.entries(r.botFaults).map(([k, n]) => `${n} ${k}`).join(', ') || '0', r.noResult,
            r.thinkMeanMs === null ? '-' : `${secs(r.thinkMeanMs)}/${secs(r.thinkMaxMs)} s`, `${dur(r.decideP95Ms)}/${dur(r.decideMaxMs)}`, r.memoryMb === null ? '-' : `${Math.round(r.memoryMb)} MB`
        ])
    ]));
    const slow = played.map((g) => ({ g, t: results.get(g.id).think?.[seatOf(g)] })).filter(({ t }) => t > capMs / 2);
    if (slow.length) {
        const worst = slow.reduce((a, b) => (b.t > a.t ? b : a));
        lines.push(`\nwarning: in ${slow.length} game${slow.length === 1 ? '' : 's'} ${bot.version} used more than half its thinking time (most: ${secs(worst.t)} of ${capMs / 1000} s in ${worst.g.id}).`
            + ' The games machine is slower than most computers: a bot this close to its cap can lose on time there.');
    }

    // the failures: the bot's faults, the opponents', then games with no result
    doc.failures = [];
    const faultGames = played.filter((g) => results.get(g.id).by);
    const noResult = played.filter((g) => !results.get(g.id).by && results.get(g.id).outcome !== 'won');
    const ordered = [...faultGames.filter((g) => results.get(g.id).by === seatOf(g)), ...faultGames.filter((g) => results.get(g.id).by !== seatOf(g))];
    if (ordered.length) {
        lines.push(`\nGames lost by a fault (${ordered.length})`);
    }
    for (const g of ordered) {
        const r = results.get(g.id);
        const seat = r.by;
        const prefix = path.join(botDir, `${g.id}.${seat}`);
        const exchanges = lastExchanges(prefix);
        const stats = hostStats(prefix);
        const stderr = tailOf(`${prefix}.stderr`, 10);
        const files = ['in.jsonl', 'out.jsonl', 'stderr', 'host.json'].map((x) => `${prefix}.${x}`).filter((f) => fs.existsSync(f));
        const replay = path.join(run, 'games', `${g.id}.jsonl`);
        const f = {
            game: g.id, bot: g[seat], seat, decks: { p1: decks.names[g.decks[0]], p2: decks.names[g.decks[1]] }, faultKind: r.faultKind ?? 'error', error: r.error ?? null,
            step: r.steps + 1, round: r.round, think: r.think?.[seat] ?? null, exchanges, stderr, trap: stats?.trap ?? null,
            files: [...files, ...(fs.existsSync(replay) ? [replay] : [])].map((x) => path.relative(run, x))
        };
        doc.failures.push(f);
        lines.push(`\n${g.id}: ${f.bot} (${seat}, deck ${f.decks[seat]} vs ${f.decks[seat === 'p1' ? 'p2' : 'p1']}) lost by ${f.faultKind} at step ${f.step}, round ${f.round}`
            + `${f.faultKind === 'time' && f.think !== null ? `, after ${secs(f.think)} s of its ${capMs / 1000} s` : ''}`);
        if (f.error) {
            lines.push(`  ${String(f.error).split('\n').slice(0, 4).join('\n  ')}`);
        }
        if (f.trap) {
            lines.push(`  sandbox: trap: ${f.trap}`);
        }
        for (const x of exchanges ?? []) {
            lines.push(`  referee: ${sentLine(x.sent)}`);
            lines.push(`  bot:     ${x.reply === null ? '(no reply)' : x.reply.length > 300 ? `${x.reply.slice(0, 300)}...` : x.reply}`);
        }
        if (stderr.length) {
            lines.push(`  stderr (last ${stderr.length} lines):`, ...stderr.map((l) => `    ${l.slice(0, 300)}`));
        }
        lines.push(`  files: ${f.files.join(', ')}`);
        if (files.some((x) => x.endsWith('.in.jsonl')) && fs.existsSync(path.join(run, 'check', f.bot.replace(/-v1$/, ''), 'bundle'))) {
            // the same input again, to the bot alone: a bot that seeds itself from hello.seed answers the same
            const py = fs.existsSync(path.join(VENV_BIN, 'python3')) ? script('build/compiled/venv/bin/python3') : 'python3';
            lines.push(`  again:  ${py} -I ${script('bot/compiled/run.py')} ${rel(path.join(run, 'check', f.bot.replace(/-v1$/, ''), 'bundle'))} < ${rel(`${prefix}.in.jsonl`)}`);
        }
    }
    if (noResult.length) {
        lines.push(`\nGames with no result, counted against neither bot (${noResult.length})`);
        const why = {
            STEP_CAP: `${limits.maxSteps} decisions and no end: often a bot that takes back its own choices (a card clicked on and off)`,
            STUCK: 'the engine stopped asking either bot',
            ERROR: 'an engine error, which the referee blames on no bot: report it to the arena (CLAUDE.md "Known engine bugs")'
        };
        for (const g of noResult) {
            const r = results.get(g.id);
            doc.failures.push({ game: g.id, bot: null, outcome: r.outcome, error: r.error ?? null, step: r.steps, round: r.round });
            lines.push(`  ${g.id}: ${r.outcome} at step ${r.steps}, round ${r.round}: ${why[r.outcome] ?? r.outcome}${r.error ? `\n    ${String(r.error).split('\n')[0].slice(0, 200)}` : ''}`);
        }
    }
    for (const j of doc.jobFailures) {
        lines.push(`\nseed ${j.seed} (${j.games.join(', ')}): ${j.why}`, ...j.tail.map((l) => `  ${l.slice(0, 300)}`));
    }
    const own = rows.reduce((s, r) => s + Object.values(r.botFaults).reduce((a, b) => a + b, 0), 0);
    const exit = own || doc.jobFailures.length || played.length < games.length ? 1 : 0;
    lines.push(exit ? `\nexit 1: ${[own && `${bot.version} lost ${own} game${own === 1 ? '' : 's'} by its own fault`, doc.jobFailures.length && `${doc.jobFailures.length} job${doc.jobFailures.length === 1 ? '' : 's'} failed`, played.length < games.length && `${games.length - played.length} games not played`].filter(Boolean).join('; ')}`
        : `\n${bot.version} played every game without a fault of its own.`);
    return { text: lines.join('\n'), exit };
}

/** Serves a run's replays to the viewer kit on 127.0.0.1 until stopped. */
function view(run, port) {
    const { GAME_ID } = require('./arena/play-seed');
    if (!fs.existsSync(path.join(run, 'index.json'))) {
        usage(`${rel(run)} has no index.json: give a run folder of bot/dev.js`);
    }
    const ids = () => {
        try {
            return new Set(JSON.parse(fs.readFileSync(path.join(run, 'index.json'), 'utf8')).games.map((g) => g.id));
        } catch {
            return new Set();
        }
    };
    const send = (res, code, type, body) => {
        res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(body);
    };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return send(res, 405, 'text/plain', 'GET only\n');
        }
        if (url.pathname === '/') {
            return send(res, 200, 'text/html; charset=utf-8', PAGE);
        }
        if (url.pathname === '/kit.js') {
            res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
            return fs.createReadStream(KIT).pipe(res);
        }
        if (url.pathname === '/index.json') {
            return send(res, 200, 'application/json', fs.readFileSync(path.join(run, 'index.json')));
        }
        const m = /^\/games\/([^/]+)\.jsonl$/.exec(url.pathname);
        let id = null;
        try {
            id = m ? decodeURIComponent(m[1]) : null;
        } catch {} // not a name
        const file = id && GAME_ID.test(id) && ids().has(id) ? path.join(run, 'games', `${id}.jsonl`) : null;
        if (file && fs.existsSync(file)) {
            return send(res, 200, 'application/x-ndjson; charset=utf-8', fs.readFileSync(file));
        }
        return send(res, 404, 'text/plain', 'not found\n');
    });
    return new Promise((resolve) => {
        server.on('error', (e) => {
            console.log(`--view: ${e.message}`);
            resolve(2);
        });
        serving = true;
        server.listen(port, '127.0.0.1', () => {
            console.log(`http://127.0.0.1:${server.address().port}/  (${rel(run)}; Ctrl-C stops it)`);
        });
    });
}

let serving = false; // --view: the server keeps this process running

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dev run</title>
<style>
:root { --bg: #060a13; --panel: #0f1829; --line: #1d2a44; --ink: #e6ecf8; --dim: #8494b8; --good: #4fe0a8; --bad: #ff7b72; color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, sans-serif; }
header { padding: 10px 16px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
header b { font-size: 16px; }
header span { color: var(--dim); }
main { display: grid; grid-template-columns: minmax(220px, 320px) 1fr; min-height: calc(100vh - 48px); }
nav { border-right: 1px solid var(--line); overflow: auto; max-height: calc(100vh - 48px); }
nav button { display: block; width: 100%; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--line); color: var(--ink); padding: 8px 12px; font: inherit; cursor: pointer; }
nav button:hover, nav button[aria-current] { background: var(--panel); }
nav small { display: block; color: var(--dim); }
.won { color: var(--good); } .lost { color: var(--bad); }
#viewer { min-height: 70vh; }
#empty { padding: 24px; color: var(--dim); }
@media (max-width: 700px) { main { grid-template-columns: 1fr; } nav { max-height: 40vh; border-right: 0; border-bottom: 1px solid var(--line); } }
</style>
</head>
<body>
<header><b id="title">Dev run</b><span id="sub"></span></header>
<main><nav id="games"></nav><section><div id="empty">Pick a game.</div><div id="viewer"></div></section></main>
<script src="/kit.js"></script>
<script>
(async () => {
  const $ = (id) => document.getElementById(id);
  const index = await (await fetch('/index.json')).json();
  const me = index.bots[index.bots.length - 1];
  $('title').textContent = index.id;
  $('sub').textContent = me + ' against ' + index.bots.slice(0, -1).join(', ') + ', ' + index.games.length + ' games';
  let viewer = null;
  for (const g of index.games) {
    const b = document.createElement('button');
    const res = g.winner === me ? 'won' : g.winner && g.winner !== 'draw' ? 'lost' : '';
    b.innerHTML = '<span class="' + res + '"></span><small></small>';
    b.firstChild.textContent = g.p1 + ' vs ' + g.p2 + ' (seed ' + g.seed + ')';
    b.lastChild.textContent = (g.outcome === 'won' ? g.winner + ' won' : g.outcome + (g.by ? ', ' + g[g.by] + ' ' + (g.faultKind || 'fault') : '')) + ', R' + g.rounds + ', ' + g.steps + ' steps';
    b.onclick = async () => {
      document.querySelectorAll('nav button').forEach((x) => x.removeAttribute('aria-current'));
      b.setAttribute('aria-current', 'true');
      const r = await fetch('/games/' + encodeURIComponent(g.id) + '.jsonl');
      viewer?.destroy?.();
      $('empty').hidden = r.ok;
      if (!r.ok) { $('empty').textContent = 'No replay for ' + g.id + ' (a bot that failed to load leaves none).'; return; }
      viewer = SWUViewer.mount($('viewer'), { jsonl: await r.text(), follow: false });
    };
    $('games').appendChild(b);
  }
})();
</script>
</body>
</html>
`;

module.exports = { parseArgs, nameOf, botAt, withDefaultEntry, childEnv, schedule, jobsFor, lastExchanges, sentLine };
if (require.main === module) {
    main(process.argv.slice(2)).then((code) => {
        if (code !== undefined && code !== null && typeof code === 'number') {
            process.exitCode = code;
        }
    }, (e) => {
        console.log(e instanceof Usage ? `dev: ${e.message}` : `dev: ${e?.stack ?? e}`);
        process.exitCode = e instanceof Usage ? 2 : 1;
    }).finally(() => {
        // a view keeps serving; anything else ends here, with whatever is still running
        if (!serving || process.exitCode) {
            groups.forEach(killGroup);
            process.exit(process.exitCode ?? 0);
        }
    });
}
