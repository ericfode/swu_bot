#!/usr/bin/env node
'use strict';
/**
 * A helper's game runner: plays the games of one seed that the games machine handed to a helper, and prints their
 * results. The helper (coord/, COORD_ROLE=helper) runs it as the bots' user, from the repo root:
 *
 *   node bot/arena/play-seed.js --job <job.json> --bundles <dir> --work <dir>
 *   node bot/arena/play-seed.js --warm
 *
 * The job comes from the ladder's remote lane (bot/remote-lane.js):
 *   { v: 1, seed, key, maxSteps, capMs, hangMs, gameMs, games: [{ id, p1, p2 }], bots: { <name>: { kind, bundle? } } }
 * key is the seed's game key (rng.js gameKey), never the run key; null deals from the seed alone. Only bots that run
 * sandboxed or are the project's own play here: heuristic and rush (in-process), the WebAssembly residents built into
 * this image (RESIDENTS, kind 'resident'), and competitor versions <agent>-v<N> of kind 'wasm' whose bundle, a
 * canonical tar (bot/compiled/bundle.py), is <bundles>/<bundle>.tar. Never another bot program, never a bot.js. The
 * whole job is checked before anything runs.
 *
 * ARENA_HOME is <work>/arena, so registry.js finds each version where this runner unpacks it:
 * <work>/arena/versions/<name>/bundle, beside a SUBMISSION.json of kind 'wasm'. The games play on game-pool.js as the
 * ladder plays them (one worker per game), each dealt from the job's key and recorded to <work>/out/<id>.jsonl.
 *
 * stdout gets exactly one JSON line, {ok: true, results: [{id, result}], replays: {<id>: <path>}} (a game whose bot
 * failed to load has no replay); everything else, the engine's and the bots' logging included, goes to stderr.
 * Exit 0 ok, 1 failed (the reason is the last line on stderr), 2 usage or a refused job.
 * --warm compiles the residents' bundles into $SWU_WASM_CACHE (run.py --warm, as games.js warm does) and prints
 * {ok: true, warmed: [name], failed: [{name, error}]}.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const COMPILED = path.join(ROOT, 'bot', 'compiled');
// the WebAssembly bots among games.js's default residents (its RESIDENTS when ARENA_RESIDENTS is not set); heuristic
// and rush, the other two, run in-process
const RESIDENTS = ['c-clock-wasm', 'rust-greedy2-wasm', 'rust-search-wasm', 'node-search-wasm', 'py-clock-wasm'];
const IN_PROCESS = ['heuristic', 'rush'];
const VERSION = /^[a-z][a-z0-9_]*-v\d+$/; // registry.js
const HEX = /^[0-9a-f]{64}$/;
// a game id names its replay file: no slash, no leading dot
const GAME_ID = /^[A-Za-z0-9_][A-Za-z0-9_.#-]{0,199}$/;
const MAX_GAMES = 8;
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
    const ids = new Set();
    const names = new Set();
    for (const g of job.games) {
        if (!plain(g) || !sameKeys(g, ['id', 'p1', 'p2']) || ![g.id, g.p1, g.p2].every((x) => typeof x === 'string')) {
            no('every game is {id, p1, p2} with strings');
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
        execFileSync('python3', [path.join(COMPILED, 'bundle.py'), 'unpack', tar, path.join(dir, 'bundle'), hex], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
    } catch (e) {
        const why = String(e.stderr ?? '').trim().split('\n').pop() || e.message;
        throw new Refused(`${name}: its bundle does not unpack (${why})`);
    }
    // all registry.js needs to run it as a WebAssembly bundle
    fs.writeFileSync(path.join(dir, 'SUBMISSION.json'), JSON.stringify({ bot: { kind: 'wasm' } }));
}

/** Compiles the residents' bundles into $SWU_WASM_CACHE, so the first game does not pay for it. */
function warm() {
    const out = { ok: true, warmed: [], failed: [] };
    for (const name of RESIDENTS) {
        const dir = residentDir(name);
        if (!fs.existsSync(path.join(dir, 'arena.json'))) {
            out.failed.push({ name, error: 'no bundle' });
            continue;
        }
        try {
            execFileSync('python3', [path.join(COMPILED, 'run.py'), '--warm', dir], { stdio: ['ignore', 'ignore', 'pipe'], timeout: WARM_MS });
            out.warmed.push(name);
        } catch (e) {
            out.failed.push({ name, error: String(e.stderr ?? '').trim().split('\n').pop() || e.message });
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
    const queue = job.games.map((g) => ({ id: g.id, seed: job.seed, p1: g.p1, p2: g.p2, key: job.key, replayFile: path.join(out, `${g.id}.jsonl`) }));
    const results = new Map();
    await runPool(queue, {
        workers: queue.length,
        hangMs: job.hangMs,
        gameMs: job.gameMs,
        workerData: { maxSteps: job.maxSteps, engineRev: null, capMs: job.capMs ?? Infinity, key: null, decks: null, pool: null },
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
        return warm();
    }
    const [jobFile, bundles, work] = ['job', 'bundles', 'work'].map(arg);
    if (!jobFile || !bundles || !work) {
        throw new Refused('usage: node bot/arena/play-seed.js --job <job.json> --bundles <dir> --work <dir> | --warm');
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
    main(process.argv.slice(2)).then((doc) => write(`${JSON.stringify(doc)}\n`, () => done(0)), (e) => {
        console.error(`play-seed: ${String(e?.message ?? e).split('\n')[0]}`);
        done(e instanceof Refused ? 2 : 1);
    });
}

module.exports = { RESIDENTS, IN_PROCESS, residentsHere, checkJob, Refused };
