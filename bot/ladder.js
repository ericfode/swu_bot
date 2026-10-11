'use strict';
/**
 * Round-robin ladder with ratings, run on worker threads.
 *
 *   node bot/ladder.js --bots rush,aggro,tempo,control,heuristic,random --games 10
 *       [--seed 1] [--workers 3] [--max-steps 6000] [--id my-run] [--out <dir>] [--record] [--vs a,b,c] [--key K|none]
 *       [--resume] [--cap-ms 60000] [--hang-ms 600000]
 * --resume keeps the finished games of an earlier run with the same id and config and plays only the rest (same engine,
 * uncommitted engine source changes included (config.engineDiff), and same bot code and models: config.harness is the
 * git trees of bot/ and models/, plus a hash of uncommitted changes there and of the $SWU_LEARNED_MODEL file when set;
 * config.programs hashes the bot programs' entries and the files they name). Without the earlier run's --key, the rest is dealt from a
 * new run key; the games kept have their own keys in their entries.
 * --cap-ms caps each bot's thinking per game (players/guard.js; default none): over it, that bot loses. --hang-ms is the
 * watchdog (game-pool.js): one bot call running longer than that (wall clock) loses the game, and its worker is
 * replaced. A bot that fails to load, throws or answers wrong also loses. Such a game is an ERROR with `by` set to the
 * bot's seat (as match.js reports one), and `faultKind` says how it failed: load, error, time or hang.
 *
 * Each pair plays `--games` games (rounded up to even): every seed twice, once from each seat, so random-deck luck
 * cancels out. Everything goes in <out>/<id>/, rewritten atomically after every finished game:
 *   index.json   the same tournament index tournament.js writes (viewer and dashboard read it as is)
 *   ladder.json  the full report (schema "swu-ladder/1", see ladder-report.js): ratings, CIs, pair matrix, Elo history
 *   games/       per-game recordings (<id>.jsonl, same format as tournament.js), only with --record
 * --vs a,b,c makes it a gauntlet: each --bots entry plays each --vs entry (and --bots entries do not play each
 * other). Every challenger gets the same seeds, so a parameter sweep compares variants on the same decks.
 * Games are dealt from a secret run key (rng.js runKey), so bots cannot rebuild hidden cards from their seed. Each
 * game's key goes into its index entry when it ends, and the run key into ladder.json when the run is done: give it as
 * --key to play the same games again (two runs with the same --key and --seed get the same decks). --key none: seed alone.
 * --out defaults to /mnt/project-files/results when that folder exists, else results/ in the repo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { describeBot, programSpec } = require('./players');
const { runKey } = require('./rng');
const { roundRobin, gauntlet } = require('./ratings');
const { summarize } = require('./ladder-report');
const { runPool, killChildren } = require('./game-pool');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

function engineRev() {
    try {
        return execFileSync('git', ['-C', path.join(__dirname, '..', 'forceteki'), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}

/**
 * A hash of the engine's uncommitted source changes and new files (forceteki/ is read-only here, but a local edit and
 * rebuild would change games without moving its HEAD), or null when it is clean or has no git. Its build/ is
 * generated from that source, so it is not hashed.
 */
function engineDiff() {
    const dir = path.join(__dirname, '..', 'forceteki');
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
    try {
        const diff = git('diff', 'HEAD');
        const extra = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort();
        if (!diff && !extra.length) {
            return null;
        }
        const h = crypto.createHash('sha256').update(diff);
        for (const f of extra) {
            h.update(`\0${f}\0`).update(fs.readFileSync(path.join(dir, f)));
        }
        return h.digest('hex').slice(0, 10);
    } catch {
        return null;
    }
}

/**
 * The revision of the harness and the built-in bots with their models: the git tree ids of bot/ and models/ at HEAD,
 * plus a hash of uncommitted changes and new files there, and of the file $SWU_LEARNED_MODEL names (the learned bots
 * read it instead of models/learned/current.json), when there are any. Arena versions live outside the repo and never
 * change. null without git.
 */
function harnessRev() {
    const root = path.join(__dirname, '..');
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
    const dirs = ['bot', 'models'].filter((d) => fs.existsSync(path.join(root, d)));
    try {
        const tree = dirs.map((d) => git('rev-parse', '--short', `HEAD:${d}`).trim()).join('.');
        const extra = git('ls-files', '--others', '--exclude-standard', '-z', '--', ...dirs).split('\0').filter(Boolean).sort();
        const diff = git('diff', 'HEAD', '--', ...dirs);
        const model = process.env.SWU_LEARNED_MODEL;
        if (!diff && !extra.length && !model) {
            return tree;
        }
        const h = crypto.createHash('sha256').update(diff);
        for (const f of extra) {
            h.update(`\0${f}\0`).update(fs.readFileSync(path.join(root, f)));
        }
        if (model) {
            h.update(`\0model\0`).update(fs.existsSync(model) ? fs.readFileSync(model) : 'missing');
        }
        return `${tree}+${h.digest('hex').slice(0, 10)}`;
    } catch {
        return null;
    }
}

/**
 * A hash of the bot programs in this ladder ($SWU_EXTERNAL_BOTS or bot/external-bots.json): each one's entry and the
 * files it names (its program, the scripts and model files in its arguments, its adapter), which may be built files git
 * does not track (bot/c/swu-c) or live outside the repo. null when no bot program plays.
 */
function programsRev(names) {
    const root = path.join(__dirname, '..');
    const h = crypto.createHash('sha256');
    let any = false;
    for (const n of [...new Set(names.map((x) => x.split('#')[0]))].sort()) {
        const spec = programSpec(n);
        if (!spec) {
            continue;
        }
        any = true;
        h.update(`\0${n}\0${JSON.stringify(spec)}`);
        const cwd = path.resolve(root, spec.cwd ?? '.');
        const named = [spec.cmd, ...(Array.isArray(spec.args) ? spec.args : [])].filter((a) => typeof a === 'string').flatMap((a) => a.split('='));
        const files = [...named.map((a) => path.resolve(cwd, a)), ...(typeof spec.adapter === 'string' ? [path.join(root, spec.adapter)] : [])];
        for (const f of files) {
            try {
                if (fs.statSync(f).isFile()) {
                    h.update(`\0${f}\0`).update(fs.readFileSync(f));
                }
            } catch {
                // not a file (a program on PATH, a flag, a word)
            }
        }
    }
    return any ? h.digest('hex').slice(0, 12) : null;
}

function writeJson(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
}

/**
 * Names the run key without giving it away (ladder.json is written during the run, where bots can read it): null for
 * --key none, else 12 hex digits of its SHA-256.
 */
const keyId = (key) => (key === null ? null : crypto.createHash('sha256').update(key).digest('hex').slice(0, 12));

/** The games of an earlier run in the same folder, when its bots, schedule, limits and engine match this one; else null. */
function readPrevious(file, config, engine) {
    if (!fs.existsSync(file)) {
        return null;
    }
    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        console.log(`resume: ${file} is not readable JSON (${e.message.split('\n')[0]}), starting over`);
        return null;
    }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const c = doc?.config ?? {};
    // everything that changes a game's result: who plays, which seeds, the step cap, the time cap and watchdog, the engine
    // and the harness code (guard, game runner, env, built-in bots)
    if (!same(c.bots, config.bots) || c.gamesPerPair !== config.gamesPerPair || c.firstSeed !== config.firstSeed || c.maxSteps !== config.maxSteps
        || (c.capMs ?? null) !== (config.capMs ?? null) || c.hangMs !== config.hangMs || !same(c.vs ?? null, config.vs ?? null) || (doc.engine ?? null) !== engine
        || (c.harness ?? null) !== (config.harness ?? null) || (c.engineDiff ?? null) !== (config.engineDiff ?? null) || (c.programs ?? null) !== (config.programs ?? null)
        || (c.keyId === null) !== (config.keyId === null)) {
        console.log('resume: the earlier run used other bots, seeds, format, limits, engine, bot/ code, bot programs or seeding (--key none), starting over');
        return null;
    }
    if (c.keyId !== config.keyId) {
        console.log('resume: the earlier run had another key, so the games left are dealt from this run\'s key (kept games keep theirs)');
    }
    return { games: Array.isArray(doc.games) ? doc.games : [] };
}

function defaultOut() {
    return fs.existsSync('/mnt/project-files') ? '/mnt/project-files/results' : path.join(__dirname, '..', 'results');
}

async function main() {
    const challengers = arg('bots', 'rush,aggro,tempo,control,heuristic,random').split(',');
    const vs = arg('vs', null)?.split(',') ?? null;
    const names = vs ? [...challengers, ...vs] : challengers;
    if (new Set(names).size !== names.length) {
        throw new Error('bot names must be unique (use name#2 to enter the same bot twice)');
    }
    const botInfo = {};
    for (const n of names) {
        botInfo[n] = describeBot(n);
        if (!botInfo[n]) {
            throw new Error(`unknown bot "${n}"`);
        }
        delete botInfo[n].name;
    }
    const perPair = Number(arg('games', 10));
    const firstSeed = Number(arg('seed', 1));
    const maxSteps = Number(arg('max-steps', 6000));
    const workers = Math.max(1, Number(arg('workers', Math.max(1, os.cpus().length - 1))));
    const capMs = arg('cap-ms') === undefined ? Infinity : Number(arg('cap-ms'));
    const hangMs = Number(arg('hang-ms', 600000));
    if (!(capMs > 0) || !(hangMs > 0)) {
        throw new Error('--cap-ms and --hang-ms must be positive numbers of milliseconds');
    }
    const createdAt = new Date().toISOString();
    const id = arg('id', `ladder-${createdAt.replace(/[:.]/g, '-').slice(0, 19)}`);
    const out = path.join(path.resolve(arg('out', defaultOut())), id);
    const record = process.argv.includes('--record');
    const key = runKey(arg('key', null));
    fs.mkdirSync(path.join(out, 'games'), { recursive: true });

    const engine = engineRev();
    const schedule = vs ? gauntlet(challengers, vs, perPair, firstSeed) : roundRobin(names, perPair, firstSeed);
    // capMs null = no cap (JSON has no Infinity)
    const config = { bots: names, gamesPerPair: perPair + (perPair % 2), firstSeed, maxSteps, workers, capMs: Number.isFinite(capMs) ? capMs : null, hangMs,
                     harness: harnessRev(), engineDiff: engineDiff(), programs: programsRev(names), keyId: keyId(key), ...(vs ? { format: 'gauntlet', vs } : {}) };
    const games = [];
    let status = 'running';
    const prev = process.argv.includes('--resume') ? readPrevious(path.join(out, 'ladder.json'), config, engine) : null;
    const save = () => {
        const doc = summarize({ id, createdAt, status, engine, config, botInfo, games, scheduled: schedule.length });
        writeJson(path.join(out, 'ladder.json'), doc);
        writeJson(path.join(out, 'index.json'), tIndex);
        return doc;
    };
    // tournament.js-format index (TournamentIndex in viewer/src/core/types.ts)
    const tIndex = { id, createdAt, engine, bots: names, gamesPerPairing: config.gamesPerPair, games: [] };
    let queue = schedule.map((s) => ({ ...s, id: `${s.p1}-vs-${s.p2}-${s.seed}` }));
    if (prev) {
        const kept = prev.games.filter((g) => g?.id && g.outcome !== 'running' && queue.some((q) => q.id === g.id));
        games.push(...kept);
        tIndex.games.push(...kept.map(({ botStats, think, ...g }) => g));
        queue = queue.filter((q) => !kept.some((g) => g.id === q.id));
        console.log(`${id}: resuming, ${kept.length} games already played`);
    }
    save();
    console.log(`${id}: ${queue.length} of ${schedule.length} games to play, ${names.length} bots, ${workers} workers -> ${out}`);

    const t0 = Date.now();
    await runPool(queue, {
        workers,
        hangMs,
        workerData: { maxSteps, engineRev: engine, capMs, key },
        onStart: (job) => {
            const entry = { id: job.id, seed: job.seed, p1: job.p1, p2: job.p2, winner: null, winnerSeat: null, outcome: 'running', rounds: 0, steps: 0, ms: 0, error: null, by: null, faultKind: null };
            games.push(entry);
            tIndex.games.push({ ...entry });
            if (record) {
                job.replayFile = path.join(out, 'games', `${job.id}.jsonl`);
            }
            save();
        },
        onResult: ({ job, result: r }) => {
            const done = {
                winner: r.winner ?? null, winnerSeat: r.winnerSeat ?? null, outcome: r.outcome, rounds: r.round, steps: r.steps, ms: r.ms, error: r.error ?? null,
                by: r.by ?? null, faultKind: r.faultKind ?? null, timing: r.timing ?? null, ...(r.key ? { key: r.key } : {})
            };
            Object.assign(games.find((g) => g.id === job.id), done, { think: r.think ?? null, botStats: r.botStats });
            Object.assign(tIndex.games.find((g) => g.id === job.id), done);
            const doc = save();
            const top = doc.bots.slice(0, 3).map((b) => `${b.name} ${b.btElo}`).join(', ');
            const fault = r.by ? ` (${r.by} ${r.faultKind})` : '';
            console.log(`[${doc.progress.finished}/${schedule.length}] ${job.id}: ${r.outcome}${fault} ${r.winner ?? ''} R${r.round} ${r.steps} steps ${r.ms}ms${r.error ? ' ' + r.error : ''} | ${top}`);
        }
    });
    status = 'done';
    if (key) {
        config.key = key;
    }
    const doc = save();
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    for (const b of doc.bots) {
        console.log(`${b.name.padEnd(14)} BT ${String(b.btElo).padStart(5)}  Elo ${String(b.elo).padStart(5)}  ${b.wins}-${b.losses}-${b.draws}  incomplete ${b.incomplete}  forfeits ${b.forfeits}  ${b.winRate === null ? '' : (b.winRate * 100).toFixed(0) + '%'}`);
    }
}

// exit explicitly: a worker retired by the watchdog may still be stuck in a bot's synchronous call
main().then(() => {
    killChildren();
    process.exit(0);
}, (e) => {
    killChildren();
    console.error(e);
    process.exit(1);
});
