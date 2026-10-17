'use strict';
/**
 * Optional, durable placement requests. This module reads admission metadata and registry descriptions only: it
 * never loads a submitted bot. Intake calls enqueue after the existing isolated check and root's promotion; the
 * games scheduler reserves a round and uses its usual worker lane to play it. Every version has one immutable job.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const home = require('./home');

const DIR = path.join(home.HOME, 'placements');
const VERSION = /^([a-z][a-z0-9_]{0,31})-v([1-9]\d*)$/;
const PENDING = new Set(['queued', 'waiting', 'running', 'retrying', 'held']);
const TERMINAL = new Set(['complete', 'unrated', 'failed', 'cancelled']);
const MAX_OPPONENTS = 4;
const MAX_RECORD_BYTES = 8 << 20;
const enabled = () => process.env.GAMES_PLACEMENT_MODE === 'immediate';
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const versionParts = (v) => typeof v === 'string' && VERSION.exec(v);
const fileOf = (version) => path.join(DIR, `${version}.json`);
const isDirectory = (p) => !!fs.lstatSync(p, { throwIfNoEntry: false })?.isDirectory();

/** Plain files only: a placement request never follows a submission's or another process's link. */
function readJson(file) {
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const st = fs.fstatSync(fd);
        return st.isFile() && st.size <= MAX_RECORD_BYTES ? JSON.parse(fs.readFileSync(fd, 'utf8')) : null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

/** Admission backstop, not another validator: only a frozen, checked wasm version in the active roster qualifies. */
function admitted(version, ref = undefined) {
    const parts = versionParts(version);
    if (!parts || !Number.isSafeInteger(Number(parts[2]))) return false;
    const [, agent, n] = parts;
    const entry = home.roster().agents.find((a) => a.name === agent);
    if (!entry || (entry.withdrawn ?? []).includes(Number(n))) return false;
    const dir = path.join(home.VERSIONS, version);
    if (!isDirectory(home.VERSIONS) || !isDirectory(dir) || !isDirectory(path.join(dir, 'bundle'))) return false;
    const sub = readJson(path.join(dir, 'SUBMISSION.json'));
    if (sub?.name !== version || sub.checked !== true || sub.bot?.kind !== 'wasm' ||
        (sub.agent !== undefined && sub.agent !== agent) || (sub.version !== undefined && sub.version !== Number(n)) ||
        (ref !== undefined && sub.ref !== ref) || !plain(readJson(path.join(dir, 'bundle', 'arena.json')))) return false;
    // A name shadowed by an external or built-in bot must not become an arbitrary program in a placement job.
    const d = require('../players').describeBot(version);
    return d?.kind === 'arena' && d.lang === 'wasm';
}

/** One anchor, then the strongest/middle/weakest available versions by existing all-round BT, with stable ties. */
function opponentsOf(version, excludeAgents = new Set()) {
    const agent = versionParts(version)?.[1];
    const referee = require('./referee');
    const names = referee.lineup(null, { playable: (n) => admitted(n) })
        .filter((n) => versionParts(n)?.[1] !== agent && !excludeAgents.has(versionParts(n)?.[1]));
    const ratings = readJson(path.join(home.HOME, 'standings.json'))?.global ?? {};
    const rating = (n) => typeof ratings[n] === 'number' && Number.isFinite(ratings[n]) ? ratings[n] : 1500;
    const ranked = names.sort((a, b) => rating(b) - rating(a) || (a < b ? -1 : a > b ? 1 : 0));
    const own = new Set(referee.anchorsOf(ranked));
    const picked = [];
    const add = (n) => { if (n && !picked.includes(n) && picked.length < MAX_OPPONENTS) picked.push(n); };
    add(ranked.find((n) => own.has(n)));
    const rest = ranked.filter((n) => !picked.includes(n));
    add(rest[0]);
    add(rest[Math.floor(rest.length / 2)]);
    add(rest.at(-1));
    for (const n of ranked) add(n);
    return picked;
}

/** Keep every eligible frozen version; only an ineligible slot may take a newly selected opponent before start. */
function eligibleOpponents(job) {
    if (job.opponents.length && job.opponents.every((n) => admitted(n))) return [...job.opponents];
    const kept = job.opponents.filter((n) => admitted(n));
    const replacements = opponentsOf(job.version, new Set(kept.map((n) => versionParts(n)?.[1])));
    if (!job.opponents.length) return replacements;
    return job.opponents.flatMap((n) => admitted(n) ? [n] : replacements.length ? [replacements.shift()] : []);
}

function records() {
    if (!isDirectory(DIR)) return [];
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && versionParts(f.slice(0, -5)))
        .map((f) => ({ file: f, record: readJson(path.join(DIR, f)) }))
        .filter(({ file, record: r }) => plain(r) && versionParts(r.version) && file === `${r.version}.json` &&
            typeof r.ref === 'string' && typeof r.queuedAt === 'string' && Array.isArray(r.opponents))
        .map(({ record }) => record)
        .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

const publicRecord = (r) => ({
    version: r.version, ref: r.ref, round: r.round ?? null, state: r.state, queuedAt: r.queuedAt, updatedAt: r.updatedAt,
    opponents: [...r.opponents], finished: r.finished ?? 0, rated: r.rated ?? 0, scheduled: r.scheduled ?? null,
    progress: { finished: r.finished ?? 0, rated: r.rated ?? 0, scheduled: r.scheduled ?? null }, error: r.error ?? null
});

function ensureDir() {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o755 });
    if (!isDirectory(DIR)) throw new Error('placements is not a plain folder');
    fs.chmodSync(DIR, 0o755);
}

/** Flush the name as well as the file's contents (some filesystems do not support directory fsync). */
function syncDirectory() {
    let fd;
    try {
        fd = fs.openSync(DIR, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        fs.fsyncSync(fd);
    } catch (e) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(e.code)) throw e;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

/** A crash leaves only an ignored temp file: no reader ever sees an empty canonical job. */
function storeFile(file, value, exclusive = false) {
    const tmp = path.join(DIR, `.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
    let fd;
    try {
        fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
        fs.fchmodSync(fd, 0o644);
        fs.writeFileSync(fd, JSON.stringify(value));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        if (exclusive) fs.linkSync(tmp, file);
        else fs.renameSync(tmp, file);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        fs.rmSync(tmp, { force: true });
        syncDirectory();
    }
}

const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
// Python's fd 3 is a forked copy of the parent's open file description. flock therefore stays held by the parent
// after this tiny helper exits, and the OS releases it on parent close/crash. No PID file, reaper or stale timeout.
const FLOCK = 'import fcntl, sys\ntry:\n fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError:\n sys.exit(75)\n';
function locked(fn) {
    ensureDir();
    const lock = path.join(DIR, '.reserve.lock');
    const fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o644);
    try {
        if (!fs.fstatSync(fd).isFile()) throw new Error('placement lock is not a plain file');
        fs.fchmodSync(fd, 0o644);
        for (const start = Date.now(); ;) {
            const claimed = spawnSync('python3', ['-I', '-c', FLOCK], {
                stdio: ['ignore', 'ignore', 'pipe', fd], env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, timeout: 5000, maxBuffer: 4096
            });
            if (claimed.status === 0) return fn();
            if (claimed.status !== 75) throw new Error(`placement lock failed: ${claimed.error?.message || String(claimed.stderr ?? '').trim() || claimed.status}`);
            if (Date.now() - start > 10000) throw new Error('placement reservation is held by another process; try again');
            sleep();
        }
    } finally {
        // The lock file stays at one inode for every contender; unlinking it could allow two independent holders.
        fs.closeSync(fd);
    }
}

/** Exactly one request per admitted version, even when intake retries or two intake processes finish together. */
function enqueue({ version, ref, benched = false } = {}) {
    if (!enabled() || benched || typeof ref !== 'string' || !ref.startsWith('window:') || ref.length <= 7 || ref.length > 300 || !admitted(version, ref)) return null;
    ensureDir();
    const now = new Date().toISOString();
    const opponents = opponentsOf(version);
    const record = { version, ref, round: null, state: opponents.length ? 'queued' : 'waiting', queuedAt: now, updatedAt: now,
        opponents, finished: 0, rated: 0, scheduled: null, error: null };
    try {
        storeFile(fileOf(version), record, true);
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const before = readJson(fileOf(version));
        if (before?.version !== version || before.ref !== ref) throw new Error(`${version}: placement record conflicts with its admission`);
        return publicRecord(before);
    }
    return publicRecord(record);
}

const statuses = () => records().map((r) => {
    if (!PENDING.has(r.state) || r.round != null) return publicRecord(r);
    if (!admitted(r.version, r.ref)) return publicRecord({ ...r, state: 'blocked', error: 'version is benched, withdrawn, or no longer admitted' });
    const opponents = eligibleOpponents(r);
    return publicRecord({ ...r, opponents, state: opponents.length ? 'queued' : 'waiting',
        error: opponents.length ? null : 'waiting for an admitted opponent' });
});

/** Read-only: gamesctl plan runs as the bots' user and has no right to change the queue. */
function next() {
    return records().find((r) => PENDING.has(r.state) &&
        (r.round !== null && r.round !== undefined || enabled() && admitted(r.version, r.ref) &&
            eligibleOpponents(r).length > 0)) ?? null;
}

/** Works with the option off too: a started round must still finish under its frozen rules. */
function getRound(k) {
    return records().find((r) => r.round === k) ?? null;
}

/** Root alone reconciles queue eligibility; plan/status remain read-only and assigned rounds keep their snapshot. */
function reconcile() {
    for (const job of records().filter((r) => PENDING.has(r.state) && r.round == null)) {
        if (!admitted(job.version, job.ref)) {
            storeFile(fileOf(job.version), { ...job, state: 'cancelled', error: 'version is benched, withdrawn, or no longer admitted', updatedAt: new Date().toISOString() });
            continue;
        }
        const opponents = eligibleOpponents(job);
        const state = opponents.length ? 'queued' : 'waiting';
        const error = opponents.length ? null : 'waiting for an admitted opponent';
        if (job.state !== state || job.error !== error || JSON.stringify(job.opponents) !== JSON.stringify(opponents)) {
            storeFile(fileOf(job.version), { ...job, opponents, state, error, updatedAt: new Date().toISOString() });
        }
    }
}

function reserve(k, makeSpec) {
    if (!Number.isSafeInteger(k) || k < 0 || typeof makeSpec !== 'function') throw new Error('placement round and spec builder required');
    if (!enabled() && !getRound(k)) return null;
    return locked(() => {
        reconcile();
        let job = getRound(k);
        if (job?.spec) return job.spec;
        if (!job) {
            if (!enabled()) return null;
            // The hook also runs when an ordinary round resumes. A new placement cannot take its number or files.
            const before = readJson(path.join(home.HOME, 'standings.json'))?.rounds ?? [];
            const ladder = readJson(path.join(home.RESULTS, `arena-r${k}`, 'ladder.json'));
            if (before.some((r) => r.round === k && !r.placement) || ladder?.config && !ladder.config.placement) return null;
            job = next();
            if (!job) return null;
            // A still-running request belongs to its first round, never another one.
            if (job.round !== null && job.round !== undefined) return null;
            if (!job.opponents.length) job.opponents = eligibleOpponents(job);
            if (!job.opponents.length) return null;
            job = { ...job, round: k, state: 'running', error: null, updatedAt: new Date().toISOString() };
            // Reserve before a fallible pack/warm: a retry always prepares this version under this same round number.
            storeFile(fileOf(job.version), job);
        }
        try {
            const spec = makeSpec(structuredClone(job));
            const bots = [job.version, ...job.opponents];
            if (!plain(spec) || spec.round !== k || JSON.stringify(spec.bots) !== JSON.stringify(bots) ||
                !Number.isInteger(spec.gamesPerPair) || spec.gamesPerPair < 2 || spec.gamesPerPair > 10 || spec.gamesPerPair % 2) {
                throw new Error('placement spec must keep its frozen lineup and 2..10 even games per pair');
            }
            const frozen = { ...spec, placement: { version: job.version, ref: job.ref } };
            storeFile(fileOf(job.version), { ...job, spec: frozen, state: 'running', error: null,
                scheduled: job.opponents.length * frozen.gamesPerPair, updatedAt: new Date().toISOString() });
            return frozen;
        } catch (e) {
            storeFile(fileOf(job.version), { ...job, state: 'retrying', error: String(e?.message ?? e).slice(0, 1000), updatedAt: new Date().toISOString() });
            throw e;
        }
    });
}

/** Only scheduler/publisher counts go here. This queue never manufactures results or changes ratings. */
function update(k, patch = {}) {
    return locked(() => {
        const job = getRound(k);
        if (!job) return null;
        // A delayed publisher/failure callback cannot resurrect a completed placement or erase its progress.
        if (TERMINAL.has(job.state)) return publicRecord(job);
        const changed = { ...job, updatedAt: new Date().toISOString() };
        for (const key of ['finished', 'rated', 'scheduled']) {
            if (patch[key] !== undefined) {
                if (!Number.isSafeInteger(patch[key]) || patch[key] < 0) throw new Error(`placement ${key} must be a nonnegative integer`);
                changed[key] = Math.max(job[key] ?? 0, patch[key]);
            }
        }
        if (patch.error !== undefined) changed.error = patch.error === null ? null : String(patch.error).slice(0, 1000);
        if (patch.state !== undefined) {
            const state = patch.state === 'done' || patch.state === 'complete' ? changed.rated > 0 ? 'complete' : 'unrated' : patch.state;
            if (!PENDING.has(state) && !TERMINAL.has(state)) throw new Error(`unknown placement state ${state}`);
            changed.state = state;
        }
        storeFile(fileOf(job.version), changed);
        return publicRecord(changed);
    });
}

module.exports = { enabled, enqueue, statuses, next, getRound, reserve, update, MAX_OPPONENTS };
