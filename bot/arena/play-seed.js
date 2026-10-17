#!/usr/bin/env node
'use strict';
/**
 * A helper's game runner: plays the games of one seed that the games machine handed to a helper, and prints their
 * results. The helper (coord/, COORD_ROLE=helper) runs it as the bots' user, from the repo root:
 *
 *   node bot/arena/play-seed.js --job <job.json> --bundles <dir> --work <dir>
 *   node bot/arena/play-seed.js --warm [--bundles <dir> <sha256>...]
 *
 * The job comes from the ladder's remote lane (bot/remote-lane.js):
 *   { v: 1, seed, key, maxSteps, capMs, hangMs, gameMs, games: [{ id, p1, p2, decks? }],
 *     bots: { <name>: { kind, bundle? } }, decks?, requiredProtocol?: 2, context? }
 * key is the seed's game key (rng.js gameKey), never the run key; null deals from the seed alone. In a round of deck
 * lists, decks holds the lists the games play (decklists.js normalizeDeck form) and every game's decks [i, j] the
 * indices of p1's and p2's (the shape ladder-worker.js takes); without them the games deal random decks. Only bots
 * that run sandboxed or are the project's own play here: heuristic and rush (in-process), the old WebAssembly residents when
 * this image still builds them (RESIDENTS, kind 'resident'; the arena's own bots are now submitted entries, played as
 * versions), and versions <agent>-v<N> of kind 'wasm' whose bundle, a
 * canonical tar (bot/compiled/bundle.py), is <bundles>/<bundle>.tar. Never another bot program, never a bot.js. The
 * whole job is checked before anything runs. New hosted jobs require protocol 2 and play only sandboxed versions;
 * jobs without requiredProtocol retain the historical resident choices for local replay.
 *
 * ARENA_HOME is <work>/arena, so registry.js finds each version where this runner unpacks it:
 * <work>/arena/versions/<name>/bundle, beside a SUBMISSION.json of kind 'wasm'. The games play on game-pool.js as the
 * ladder plays them (one worker per game), each dealt from the job's key and recorded to <work>/out/<id>.jsonl.
 *
 * stdout gets exactly one JSON line, {ok: true, results: [{id, result}], replays: {<id>: <path>}} (a game whose bot
 * failed to load has no replay); everything else, the engine's and the bots' logging included, goes to stderr.
 * Exit 0 ok, 1 failed (the reason is the last line on stderr), 2 usage or a refused job.
 * --warm compiles the bundles of the old residents this image builds into $SWU_WASM_CACHE (run.py --warm, as gamesctl.js
 * warm does; none in an image that builds no bot of its own) and prints {ok: true, warmed: [name], failed: [{name, error}]}.
 * With --bundles it compiles those versions' bundles instead, <dir>/<sha256>.tar each, and names them by their sha256:
 * the server runs it as root before games that play them (the plays, as the bots' user, only read the cache root writes),
 * and each bundle is unpacked in a folder of its own that only this user can enter. Compiling runs nothing of the bot.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { normalizeDeck } = require('../decklists');

const ROOT = path.join(__dirname, '..', '..');
const COMPILED = path.join(ROOT, 'bot', 'compiled');
// the bots the games image used to play as built-in residents, before they became entries (resident versions, kind
// wasm): an image that still builds these bundles plays them; heuristic and rush, the other two, run in-process
const RESIDENTS = ['c-clock-wasm', 'rust-greedy2-wasm', 'rust-search-wasm', 'node-search-wasm', 'py-clock-wasm'];
const IN_PROCESS = ['heuristic', 'rush'];
const VERSION = /^[a-z][a-z0-9_]*-v\d+$/; // registry.js
const HEX = /^[0-9a-f]{64}$/;
// a game id names its replay file: no slash, no leading dot
const GAME_ID = /^[A-Za-z0-9_][A-Za-z0-9_.#-]{0,199}$/;
const MAX_GAMES = 8;
const MAX_DECKS = 2 * MAX_GAMES;
const MAX_JOB_BYTES = 1 << 20;
const WARM_MS = 120000;

/** A job this runner does not play, or a command line it does not take: exit 2. */
class Refused extends Error {}

const residentDir = (name) => path.join(ROOT, 'build', 'compiled', name.slice(0, -'-wasm'.length));
/** The residents this image can play: those whose bundle is built (build/compiled/<name>/arena.json). */
const residentsHere = () => RESIDENTS.filter((n) => fs.existsSync(path.join(residentDir(n), 'arena.json')));

const plain = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const positive = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;
const sameKeys = (o, keys) => Object.keys(o).sort().join() === [...keys].sort().join();

/** The same JSON value with the keys of every object sorted, as the coordinator writes the job (Elixir's Jason). */
const sortedKeys = (x) => (Array.isArray(x) ? x.map(sortedKeys) : plain(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortedKeys(x[k])])) : x);

/**
 * A deck list as the lane sends it: normalizeDeck changes nothing in it, but maybe the order of its keys (the
 * helper's coordinator sorts them on the way).
 */
function isDeck(d) {
    try {
        return JSON.stringify(sortedKeys(normalizeDeck(d))) === JSON.stringify(sortedKeys(d));
    } catch {
        return false;
    }
}

/** Throws Refused unless every part of the job is what the lane sends and every bot in it may play here. */
function checkJob(job, bundles) {
    const no = (why) => {
        throw new Refused(why);
    };
    if (!plain(job)) {
        no('the job is not a JSON object');
    }
    if (job.v !== 1) {
        no(`job version ${JSON.stringify(job.v)}; this runner plays version 1`);
    }
    if (Object.hasOwn(job, 'requiredProtocol') && job.requiredProtocol !== 2) {
        no('requiredProtocol must be 2 when present');
    }
    if (job.requiredProtocol === 2 && Object.hasOwn(job, 'context')) {
        const c = job.context;
        if (!plain(c) || c.schema !== 1 || c.arenaId !== 'v2' || c.protocol !== 2 || typeof c.engineRevision !== 'string'
            || !HEX.test(c.engineRevision) || typeof c.runnerRevision !== 'string' || !c.runnerRevision.length) {
            no('context must be a v2 comparison descriptor with engine and runner revisions');
        }
    }
    if (!Number.isSafeInteger(job.seed) || job.seed < 0) {
        no('seed must be a non-negative integer');
    }
    if (job.key !== null && !(typeof job.key === 'string' && HEX.test(job.key))) {
        no('key must be a game key (64 hex digits) or null');
    }
    if (!Number.isSafeInteger(job.maxSteps) || job.maxSteps < 1) {
        no('maxSteps must be a positive integer');
    }
    if (job.capMs !== null && !positive(job.capMs)) {
        no('capMs must be a positive number or null');
    }
    if (!positive(job.hangMs)) {
        no('hangMs must be a positive number');
    }
    if (!(typeof job.gameMs === 'number' && Number.isFinite(job.gameMs) && job.gameMs >= 0)) {
        no('gameMs must be a number, 0 or more');
    }
    if (!Array.isArray(job.games) || job.games.length < 1 || job.games.length > MAX_GAMES) {
        no(`games must list 1 to ${MAX_GAMES} games`);
    }
    const lists = Object.hasOwn(job, 'decks');
    if (lists && !(Array.isArray(job.decks) && job.decks.length >= 1 && job.decks.length <= MAX_DECKS && job.decks.every(isDeck))) {
        no(`decks must list 1 to ${MAX_DECKS} deck lists, each as decklists.js normalizeDeck gives it`);
    }
    const ids = new Set();
    const names = new Set();
    for (const g of job.games) {
        if (!plain(g) || !sameKeys(g, lists ? ['id', 'p1', 'p2', 'decks'] : ['id', 'p1', 'p2']) || ![g.id, g.p1, g.p2].every((x) => typeof x === 'string')) {
            no(lists ? 'every game is {id, p1, p2, decks} with strings and two deck indices' : 'every game is {id, p1, p2} with strings');
        }
        if (lists && !(Array.isArray(g.decks) && g.decks.length === 2 && g.decks.every((i) => Number.isSafeInteger(i) && i >= 0 && i < job.decks.length))) {
            no(`game ${JSON.stringify(g.id)}: decks must be two indices into the job's decks`);
        }
        if (!GAME_ID.test(g.id) || ids.has(g.id)) {
            no(`game id ${JSON.stringify(g.id)} is not a usable file name, or appears twice`);
        }
        ids.add(g.id);
        names.add(g.p1).add(g.p2);
    }
    if (!plain(job.bots) || !sameKeys(job.bots, names)) {
        no('bots must name every bot in the games, and nothing else');
    }
    const here = residentsHere();
    for (const [name, b] of Object.entries(job.bots)) {
        if (job.requiredProtocol === 2 && b?.kind !== 'wasm') {
            no(`${name}: protocol v2 jobs require sandboxed WebAssembly versions; resident bots are not allowed`);
        }
        if (plain(b) && sameKeys(b, ['kind']) && b.kind === 'resident' && (IN_PROCESS.includes(name) || here.includes(name))) {
            continue;
        }
        if (plain(b) && sameKeys(b, ['kind', 'bundle']) && b.kind === 'wasm' && VERSION.test(name) && typeof b.bundle === 'string' && HEX.test(b.bundle)) {
            const tar = path.join(bundles, `${b.bundle}.tar`);
            if (!fs.lstatSync(tar, { throwIfNoEntry: false })?.isFile()) {
                no(`${name}: no bundle ${b.bundle}.tar`);
            }
            continue;
        }
        no(`${name}: not a bot a helper plays (heuristic, rush, ${here.join(', ') || 'no resident bundles built'}, or a WebAssembly version with its bundle)`);
    }
    return job;
}

/**
 * After the versions are unpacked: every name must resolve to the bot the job says (a version named like a built-in
 * bot, random-v1 say, would otherwise play as that built-in).
 */
function checkResolved(job) {
    const { describeBot, programSpec } = require('../players');
    for (const [name, b] of Object.entries(job.bots)) {
        if (job.requiredProtocol === 2 && b.kind !== 'wasm') {
            throw new Refused(`${name}: protocol v2 jobs require sandboxed WebAssembly versions`);
        }
        const d = describeBot(name);
        const ok = b.kind === 'wasm' ? d?.kind === 'arena' && d.lang === 'wasm'
            : name === 'heuristic' ? d?.kind === 'search' && d.profile === 'balanced' && d.depth === 1
            : name === 'rush' ? d?.kind === 'rules'
            : d?.kind === 'external' && path.resolve(ROOT, String(programSpec(name)?.args?.[1])) === residentDir(name);
        if (!ok) {
            throw new Refused(`${name} does not resolve to the bot the job names`);
        }
    }
}

/** A version's bundle, from its canonical tar (checked against its sha256 and unpacked by bundle.py). */
function unpackVersion(arena, name, tar, hex) {
    const dir = path.join(arena, 'versions', name);
    fs.mkdirSync(dir, { recursive: true });
    try {
        execFileSync('python3', ['-I', path.join(COMPILED, 'bundle.py'), 'unpack', tar, path.join(dir, 'bundle'), hex], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
    } catch (e) {
        const why = String(e.stderr ?? '').trim().split('\n').pop() || e.message;
        throw new Refused(`${name}: its bundle does not unpack (${why})`);
    }
    // all registry.js needs to run it as a WebAssembly bundle
    fs.writeFileSync(path.join(dir, 'SUBMISSION.json'), JSON.stringify({ bot: { kind: 'wasm' } }));
}

/** Compiles the bundles of the residents this image builds into $SWU_WASM_CACHE, so the first game does not pay for it. */
function warm() {
    const out = { ok: true, warmed: [], failed: [] };
    for (const name of residentsHere()) {
        const dir = residentDir(name);
        try {
            execFileSync('python3', ['-I', path.join(COMPILED, 'run.py'), '--warm', dir], { stdio: ['ignore', 'ignore', 'pipe'], timeout: WARM_MS });
            out.warmed.push(name);
        } catch (e) {
            out.failed.push({ name, error: String(e.stderr ?? '').trim().split('\n').pop() || e.message });
        }
    }
    return out;
}

/** Compiles the bundles <bundles>/<hex>.tar (each checked against its sha256) into $SWU_WASM_CACHE, as warm() does. */
function warmBundles(bundles, hexes) {
    const out = { ok: true, warmed: [], failed: [] };
    for (const hex of hexes) {
        // 0700: whoever else runs here cannot reach the bundle between its check and its compiling
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-'));
        try {
            const dir = path.join(tmp, 'bundle');
            execFileSync('python3', ['-I', path.join(COMPILED, 'bundle.py'), 'unpack', path.join(bundles, `${hex}.tar`), dir, hex], { stdio: ['ignore', 'ignore', 'pipe'], timeout: WARM_MS });
            execFileSync('python3', ['-I', path.join(COMPILED, 'run.py'), '--warm', dir], { stdio: ['ignore', 'ignore', 'pipe'], timeout: WARM_MS });
            out.warmed.push(hex);
        } catch (e) {
            out.failed.push({ name: hex, error: String(e.stderr ?? '').trim().split('\n').pop() || e.message });
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }
    return out;
}

/** Plays the job's games; {ok, results, replays}. */
async function play(job, { bundles, work }) {
    const arena = path.join(work, 'arena');
    const out = path.join(work, 'out');
    // before anything loads arena/home.js (players/index.js does): registry.js then finds the versions here, and the
    // workers, which get this process's environment, too
    process.env.ARENA_HOME = arena;
    // the repo's own list of bot programs, whatever the environment says
    delete process.env.SWU_EXTERNAL_BOTS;
    fs.mkdirSync(path.join(arena, 'versions'), { recursive: true });
    fs.mkdirSync(out, { recursive: true });
    for (const [name, b] of Object.entries(job.bots).filter(([, x]) => x.kind === 'wasm')) {
        unpackVersion(arena, name, path.join(bundles, `${b.bundle}.tar`), b.bundle);
    }
    checkResolved(job);
    const { runPool } = require('../game-pool');
    const policy = job.requiredProtocol === 2 ? { requiredProtocol: 2 } : {};
    const queue = job.games.map((g) => ({ id: g.id, seed: job.seed, p1: g.p1, p2: g.p2, key: job.key, ...policy, ...(g.decks ? { decks: g.decks } : {}), replayFile: path.join(out, `${g.id}.jsonl`) }));
    const results = new Map();
    await runPool(queue, {
        workers: queue.length,
        hangMs: job.hangMs,
        gameMs: job.gameMs,
        // normalizeDeck puts the keys back in the order the games machine's lists have, so the replays match its own
        workerData: { maxSteps: job.maxSteps, engineRev: null, capMs: job.capMs ?? Infinity, key: null, decks: job.decks ? job.decks.map((d) => normalizeDeck(d)) : null, pool: null, ...policy },
        onResult: ({ job: g, result }) => results.set(g.id, result)
    });
    const missing = job.games.filter((g) => !results.has(g.id)).map((g) => g.id);
    if (missing.length) {
        throw new Error(`no result for ${missing.join(', ')}`);
    }
    const replays = {};
    for (const g of job.games) {
        const file = path.join(out, `${g.id}.jsonl`);
        if (fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
            replays[g.id] = file;
        }
    }
    return { ok: true, results: job.games.map((g) => ({ id: g.id, result: results.get(g.id) })), replays };
}

function readJob(file) {
    let text;
    try {
        if (fs.statSync(file).size > MAX_JOB_BYTES) {
            throw new Error(`more than ${MAX_JOB_BYTES} bytes`);
        }
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        throw new Refused(`cannot read the job (${e.message})`);
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Refused(`the job is not JSON (${e.message})`);
    }
}

async function main(argv) {
    const arg = (name) => {
        const i = argv.indexOf(`--${name}`);
        return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? path.resolve(argv[i + 1]) : null;
    };
    if (argv.includes('--warm')) {
        const at = argv.indexOf('--bundles');
        if (at < 0) {
            return warm();
        }
        const [dir, ...hexes] = argv.slice(at + 1);
        if (!dir || dir.startsWith('--') || hexes.some((h) => !HEX.test(h)) || argv.indexOf('--warm') > at) {
            throw new Refused('usage: node bot/arena/play-seed.js --warm --bundles <dir> <sha256>...');
        }
        return warmBundles(path.resolve(dir), [...new Set(hexes)]);
    }
    const [jobFile, bundles, work] = ['job', 'bundles', 'work'].map(arg);
    if (!jobFile || !bundles || !work) {
        throw new Refused('usage: node bot/arena/play-seed.js --job <job.json> --bundles <dir> --work <dir> | --warm [--bundles <dir> <sha256>...]');
    }
    // resident bot programs are named from the repo root (external-bots.json)
    process.chdir(ROOT);
    const job = checkJob(readJob(jobFile), bundles);
    return play(job, { bundles, work });
}

if (require.main === module) {
    // stdout carries the one result line. console.log and the workers' output (piped into process.stdout) go to stderr
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (...a) => process.stderr.write(...a);
    const done = (code) => {
        // bot programs a worker left running end with this process
        require('../game-pool').killChildren(null);
        process.exit(code);
    };
    // started by the dev harness (bot/dev.js), in a process group of its own: once the harness is gone, even killed by
    // SIGKILL, so is the group (this process, its workers' bot programs), so no game plays on alone. The games machine
    // and helpers never set SWU_DEV_PARENT.
    const parent = Number(process.env.SWU_DEV_PARENT);
    if (Number.isSafeInteger(parent) && parent > 1) {
        setInterval(() => {
            if (process.ppid !== parent) {
                try {
                    process.kill(-process.pid, 'SIGKILL');
                } catch {} // not a group leader: this process alone
                done(1);
            }
        }, 1000).unref();
    }
    main(process.argv.slice(2)).then((doc) => write(`${JSON.stringify(doc)}\n`, () => done(0)), (e) => {
        console.error(`play-seed: ${String(e?.message ?? e).split('\n')[0]}`);
        done(e instanceof Refused ? 2 : 1);
    });
}

/**
 * A job for some games of one seed (each {id, p1, p2, decks?}), as the games machine builds it (server/src/games/
 * Schedule.ts jobFor, which a server test pins equal to this) and as the remote lane offers it: `key` is the seed's game
 * key (rng.js gameKey of the run key, never the run key) or null, gameMs whole milliseconds, `bots` each bot's entry
 * ({kind: 'wasm', bundle} or {kind: 'resident'}, only the bots these games play are kept), and with deck lists (`decks`,
 * all of them) only the lists these games use, in first-use order, each game's indices pointing into them.
 */
function seedJob(seed, games, { key, limits, bots, decks = null, requiredProtocol, context }) {
    const named = {};
    for (const n of games.flatMap((g) => [g.p1, g.p2])) {
        if (!bots[n]) {
            throw new Error(`${n} has no entry in bots`);
        }
        named[n] = bots[n];
    }
    const job = {
        v: 1, seed, key, maxSteps: limits.maxSteps, capMs: limits.capMs, hangMs: limits.hangMs, gameMs: Math.round(limits.gameMs),
        games: games.map((g) => ({ id: g.id, p1: g.p1, p2: g.p2 })), bots: named,
        ...(requiredProtocol === undefined ? {} : { requiredProtocol }), ...(context === undefined ? {} : { context })
    };
    if (decks && games.some((g) => g.decks)) {
        // the lists this seed plays, each once (a seed's games deal the same two)
        const used = [...new Set(games.flatMap((g) => g.decks))];
        job.decks = used.map((i) => decks[i]);
        job.games.forEach((jg, n) => (jg.decks = games[n].decks.map((i) => used.indexOf(i))));
    }
    return job;
}

/**
 * A checked job's game g's two deck lists as playGame takes them ({p1, p2}: new copies, keys in the games machine's
 * order), or null for random decks.
 */
function gameDecks(job, g) {
    return g.decks ? { p1: normalizeDeck(job.decks[g.decks[0]]), p2: normalizeDeck(job.decks[g.decks[1]]) } : null;
}

module.exports = { RESIDENTS, IN_PROCESS, GAME_ID, residentsHere, checkJob, checkResolved, gameDecks, seedJob, Refused };
