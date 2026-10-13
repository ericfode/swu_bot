'use strict';
/**
 * Where the arena's shared state lives. Code is in the repo (bot/arena/*.js); data is in ARENA_HOME so every project
 * thread (each in its own container) sees the same bots and standings:
 *   roster.json                 competitors and baselines
 *   agents/<agent>/             each competitor's live, editable bot (bot.js + anything it requires from its own folder)
 *   versions/<agent>-v<N>/      frozen submissions; the referee only rates these
 *   versions/.staging-*         submissions being copied and checked (invisible to versionsOf and the registry)
 *   standings.json, rounds/     referee output
 *   inbox/<agent>.jsonl         messages, one JSON object per line
 * Default: /mnt/project-files/arena when the project folder exists, else arena-home/ in the repo (gitignored).
 * Keep file access to ARENA_HOME behind the helpers here.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOME = path.resolve(process.env.ARENA_HOME ?? (fs.existsSync('/mnt/project-files') ? '/mnt/project-files/arena' : path.join(__dirname, '..', '..', 'arena-home')));
const AGENTS = path.join(HOME, 'agents');
const VERSIONS = path.join(HOME, 'versions');
const ROSTER = path.join(HOME, 'roster.json');
const RESULTS = path.resolve(process.env.ARENA_RESULTS ?? (fs.existsSync('/mnt/project-files') ? '/mnt/project-files/results' : path.join(__dirname, '..', '..', 'results')));
// where competitors read RESULTS: the same folder, or a mirror of it when the referee writes to local disk
const PUBLIC_RESULTS = path.resolve(process.env.ARENA_PUBLIC_RESULTS ?? RESULTS);

/**
 * Replaces file with text in one step. The temporary file gets a random name and is created with O_EXCL, which never
 * follows a symlink: the arena's folders belong to the bots' user, and a root writer (the referee) must not write
 * through a link planted there.
 */
function writeAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${require('crypto').randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(tmp, text, { flag: 'wx' });
        fs.renameSync(tmp, file);
    } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
    }
}

function writeJson(file, data) {
    writeAtomic(file, JSON.stringify(data, null, 1));
}

function readJson(file, dflt) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return dflt;
    }
}

/** Competitors and baselines. A missing roster is the default; a roster that exists but does not parse throws, so a
 *  bad hand edit stops the arena instead of silently running (and later writing) an empty roster. */
function roster() {
    let text;
    try {
        text = fs.readFileSync(ROSTER, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') {
            return { thinkCapMs: 60000, baselines: ['rush', 'heuristic'], agents: [] };
        }
        throw e;
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`${ROSTER} is not valid JSON (${e.message}); fix it by hand`);
    }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const LOCK_STALE_MS = 30000;

/**
 * Runs fn() while holding the lock file `lock` (created with O_EXCL), for read-modify-write steps that clients in
 * different processes (MCP, CLI, HTTP) can run at the same time. A lock older than 30 s is taken as abandoned.
 */
function withLock(lock, fn) {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    for (const t0 = Date.now(); ;) {
        try {
            fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
            break;
        } catch (e) {
            if (e.code !== 'EEXIST') {
                throw e;
            }
        }
        let age = 0;
        try {
            age = Date.now() - fs.statSync(lock).mtimeMs;
        } catch {
            continue; // released meanwhile
        }
        if (age > LOCK_STALE_MS) {
            fs.rmSync(lock, { force: true });
        } else if (Date.now() - t0 > 10000) {
            throw new Error(`${lock} is held by another process; try again`);
        } else {
            sleepSync(50);
        }
    }
    try {
        return fn();
    } finally {
        fs.rmSync(lock, { force: true });
    }
}

/** Read-modify-write of roster.json under roster.json.lock: fn(roster) returns the new roster. */
function updateRoster(fn) {
    return withLock(`${ROSTER}.lock`, () => {
        const r = fn(roster());
        writeJson(ROSTER, r);
        return r;
    });
}

/** Submitted version numbers of an agent, ascending (staging folders and other dot-folders are ignored). */
function versionsOf(agent) {
    if (!fs.existsSync(VERSIONS)) {
        return [];
    }
    const prefix = `${agent}-v`;
    return fs.readdirSync(VERSIONS)
        .filter((d) => !d.startsWith('.') && d.startsWith(prefix) && /^\d+$/.test(d.slice(prefix.length)))
        .map((d) => Number(d.slice(prefix.length)))
        .sort((a, b) => a - b);
}

const exists = (file) => fs.existsSync(file);

/** Creates dir; false when it already exists (a cheap claim on a name, e.g. a new competitor's folder). */
function claimDir(dir) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    try {
        fs.mkdirSync(dir);
        return true;
    } catch (e) {
        if (e.code === 'EEXIST') {
            return false;
        }
        throw e;
    }
}

/** Writes [[relative path, text], ...] into dir (the caller has checked that every path stays inside dir). */
function writeFiles(dir, entries) {
    for (const [rel, text] of entries) {
        const f = path.join(dir, rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, text);
    }
}

/**
 * Makes dst (a live folder) hold the files of src (a submitted version, its SUBMISSION.json aside): removes what src does
 * not have, then copies src over. .git, node_modules and a SUBMISSION.json at the top of dst are left alone; a symlink
 * in dst is replaced, never written through.
 */
function mirror(src, dst) {
    const prune = (s, d, top) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name === '.git' || e.name === 'node_modules' || (top && e.name === 'SUBMISSION.json')) {
                continue;
            }
            let st = null;
            try {
                st = fs.lstatSync(path.join(s, e.name));
            } catch {
                // not in src
            }
            if (e.isDirectory() && st?.isDirectory()) {
                prune(path.join(s, e.name), path.join(d, e.name), false);
            } else if (!st || e.isSymbolicLink() || e.isDirectory() !== st.isDirectory()) {
                fs.rmSync(path.join(d, e.name), { recursive: true, force: true });
            }
        }
    };
    fs.mkdirSync(dst, { recursive: true });
    prune(src, dst, true);
    fs.cpSync(src, dst, { recursive: true, force: true, filter: (f) => path.relative(src, f) !== 'SUBMISSION.json' });
}

function removeDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Removes a folder whose contents another user may be changing (a check's job folder), as root. GNU rm never follows a
 * link it meets inside, where Node's rmSync resolves each path again and can be raced onto a link. What rm cannot
 * remove stays, for the next start's cleanup.
 */
function removeTree(dir) {
    require('child_process').spawnSync('rm', ['-rf', '--', dir], { stdio: 'ignore' });
}

/** A fresh, empty versions/.staging-<agent>-<random> folder for a submission being assembled. (Not mkdtemp: its 0700
 *  mode would survive the rename and hide the version from other users of the shared folder.) */
function stagingDir(agent) {
    fs.mkdirSync(VERSIONS, { recursive: true });
    const dir = path.join(VERSIONS, `.staging-${agent}-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(dir);
    return dir;
}

/** Copies a bot folder into dst: follows symlinks (a version must not point outside itself), keeps dot-files, skips
 *  .git and node_modules. */
function copyBot(src, dst) {
    fs.cpSync(src, dst, { recursive: true, dereference: true, filter: (f) => !path.relative(src, f).split(path.sep).some((p) => p === '.git' || p === 'node_modules') });
}

/** Renames a finished staging folder to dst in one step; false (nothing moved) when dst is already taken. */
function promote(staging, dst) {
    if (fs.existsSync(dst)) {
        return false;
    }
    try {
        fs.renameSync(staging, dst);
        return true;
    } catch (e) {
        if (e.code === 'EEXIST' || e.code === 'ENOTEMPTY') {
            return false;
        }
        throw e;
    }
}

function appendJsonl(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // never through a symlink (see writeAtomic)
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o644);
    try {
        fs.writeSync(fd, `${JSON.stringify(obj)}\n`);
    } finally {
        fs.closeSync(fd);
    }
}

/** The objects of a JSON Lines file, oldest first; [] when it is missing. Lines that do not parse are skipped. */
function readJsonl(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            out.push(JSON.parse(line));
        } catch {
            // a torn or hand-edited line must not hide the rest
        }
    }
    return out;
}

module.exports = {
    HOME, AGENTS, VERSIONS, ROSTER, RESULTS, PUBLIC_RESULTS, writeAtomic, writeJson, readJson, roster, updateRoster, versionsOf,
    exists, claimDir, writeFiles, mirror, removeDir, removeTree, stagingDir, copyBot, promote, appendJsonl, readJsonl, withLock
};
