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
const identity = require('./identity');

const DIR = path.join(home.HOME, 'placements');
const VERSION = /^([a-z][a-z0-9_]{0,31})-v([1-9]\d*)$/;
const PENDING = new Set(['queued', 'waiting', 'running', 'retrying', 'held']);
const TERMINAL = new Set(['complete', 'unrated', 'failed', 'cancelled', 'inconclusive']);
const MAX_OPPONENTS = 1;
const MAX_GAMES = 40;
const MAX_RECORD_BYTES = 8 << 20;
const MAX_HISTORY_BYTES = 64 << 20;
const MAX_HISTORY_ROWS = 250000;
const MAX_EXCLUDED_SEEDS = 10000;
const enabled = () => process.env.GAMES_PLACEMENT_MODE === 'immediate';
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const versionParts = (v) => typeof v === 'string' && VERSION.exec(v);
const fileOf = (version) => path.join(DIR, `${version}.json`);
const isDirectory = (p) => !!fs.lstatSync(p, { throwIfNoEntry: false })?.isDirectory();

/** Plain files only: a placement request never follows a submission's or another process's link. */
function readJson(file, maxBytes = MAX_RECORD_BYTES) {
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const st = fs.fstatSync(fd);
        return st.isFile() && st.size <= maxBytes ? JSON.parse(fs.readFileSync(fd, 'utf8')) : null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

/** Read and hash trusted admission files only; historical versions need not remain on the active roster. */
function checkedDigest(version, context = identity.comparisonContext()) {
    const parts = versionParts(version);
    if (!parts || !Number.isSafeInteger(Number(parts[2])) || !identity.contextMatches(context, context)) return null;
    const dir = path.join(home.VERSIONS, version), bundle = path.join(dir, 'bundle');
    if (!isDirectory(home.VERSIONS) || !isDirectory(dir) || !isDirectory(bundle)) return null;
    const sub = readJson(path.join(dir, 'SUBMISSION.json'));
    if (sub?.name !== version || sub.arenaId !== 'v2' || sub.checked !== true || sub.bot?.kind !== 'wasm' ||
        (sub.agent !== undefined && sub.agent !== parts[1]) || (sub.version !== undefined && sub.version !== Number(parts[2]))) return null;
    try {
        const compatibility = require('./compatibility');
        const digest = compatibility.bundleDigest(bundle);
        if (sub.bundleSha256 !== digest || !compatibility.compatibilityStatus(sub.compatibility,
            { bundleSha256: digest, context }).compatible) return null;
        return digest;
    } catch { return null; }
}

/** A frozen execution policy cannot adopt another image identity or rebind an immutable version's bytes. */
function specProblem(spec, context = identity.comparisonContext()) {
    if (spec?.arena !== 'v2' || spec.requiredProtocol !== 2) return 'placement spec must require the v2 arena and protocol';
    const why = identity.contextProblem(spec.context, context);
    if (why) return why;
    if (!Array.isArray(spec.bots) || !spec.bots.length) return 'placement spec has no immutable bot versions';
    const bundles = Object.fromEntries(spec.bots.map((v) => [v, checkedDigest(v, context)]));
    return identity.bundleProblem(spec.bundles, bundles);
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
    if (identity.id === 'v2' && !checkedDigest(version)) return false;
    // A name shadowed by an external or built-in bot must not become an arbitrary program in a placement job.
    const d = require('../players').describeBot(version);
    return d?.kind === 'arena' && d.lang === 'wasm';
}

/** Latest checked versions only. Older versions remain distinct historical fit nodes. */
function opponentsOf(version) {
    const agent = versionParts(version)?.[1];
    const referee = require('./referee');
    const names = referee.lineup(null, { playable: (n) => admitted(n) })
        .filter((n) => versionParts(n)?.[1] !== agent);
    return names.sort();
}

/** Read each authoritative ladder once. Aggregate standings results are deliberately not counted a second time. */
function history() {
    const context = identity.id === 'v2' ? identity.comparisonContext() : null;
    if (identity.id === 'v2' && !identity.contextMatches(context, context)) return null;
    const file = path.join(home.HOME, 'standings.json');
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
        // An empty arena is legitimate. Existing ladders without their manifest are not evidence of an empty arena.
        if (fs.lstatSync(home.RESULTS, { throwIfNoEntry: false }) &&
            (!isDirectory(home.RESULTS) || fs.readdirSync(home.RESULTS).length > 0)) return null;
        return { observations: [], attempted: [] };
    }
    const st = readJson(file, MAX_HISTORY_BYTES);
    if (!plain(st) || !Array.isArray(st.rounds)) return null;
    const observations = [], attempted = [], seen = new Set(), revisions = new Map(), digests = new Map();
    let rowCount = 0;
    const referee = require('./referee');
    for (const rd of st.rounds) {
        if (!plain(rd)) return null;
        if (rd.pool === 'holdout') continue;
        const id = rd.ladderId;
        if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)) return null;
        if (seen.has(id)) continue;
        seen.add(id);
        const dir = path.join(home.RESULTS, id);
        if (!isDirectory(home.RESULTS) || !isDirectory(dir)) return null;
        const ladder = readJson(path.join(dir, 'ladder.json'), MAX_HISTORY_BYTES);
        if (!plain(ladder) || !Array.isArray(ladder.games) || !plain(ladder.config) || !Array.isArray(ladder.config.bots)) return null;
        rowCount += ladder.games.length;
        if (rowCount > MAX_HISTORY_ROWS) return null;
        if (identity.id === 'v2') {
            // Keep foreign/unknown rounds on disk for inspection, without borrowing their outcomes or seeds.
            if (ladder.config.arena !== 'v2' || ladder.config.requiredProtocol !== 2 ||
                !identity.contextMatches(ladder.config.context, context)) continue;
            const declared = Object.fromEntries(ladder.config.bots.map((v) => [v, ladder.config.bundles?.[v]]));
            if (identity.bundleProblem(ladder.config.bundles, declared)) continue;
            for (const [v, digest] of Object.entries(declared)) {
                if (revisions.has(v) && revisions.get(v) !== digest) return null;
                revisions.set(v, digest);
            }
            const expected = Object.fromEntries(ladder.config.bots.map((v) => {
                if (!digests.has(v)) digests.set(v, checkedDigest(v, context));
                return [v, digests.get(v)];
            }));
            if (identity.bundleProblem(ladder.config.bundles, expected)) continue;
        }
        for (const g of ladder.games) {
            if (!plain(g) || typeof g.p1 !== 'string' || typeof g.p2 !== 'string' || typeof g.outcome !== 'string' || g.p1 === g.p2 ||
                !ladder.config.bots.includes(g.p1) || !ladder.config.bots.includes(g.p2)) return null;
            const row = { id: typeof g.id === 'string' && g.id ? `${id}/${g.id}` : undefined, scope: id,
                a: g.p1, b: g.p2, ...(Number.isSafeInteger(g.seed) && g.seed >= 0 && g.seed <= 0xffffffff ? { seed: g.seed } : {}) };
            attempted.push(row);
            if (g.outcome === 'running') continue;
            // Frozen config/bundles establish an attempted pair, including starts lost before a worker responds.
            // Only the individual game's complete runtime evidence can establish fit or connectivity.
            if (identity.id === 'v2' && identity.observationProblem(g, ladder.config)) continue;
            const { score } = referee.cappedScore(g);
            if (score !== null) observations.push({ ...row, score });
        }
    }
    return { observations, attempted };
}

const episodes = (job) => Array.isArray(job.rounds) ? job.rounds : [];
const counts = (job) => job.adaptive ? episodes(job).reduce((out, ep) => {
    for (const key of ['finished', 'rated', 'scheduled']) out[key] += ep[key] ?? 0;
    return out;
}, { finished: 0, rated: 0, scheduled: 0 }) : { finished: job.finished ?? 0, rated: job.rated ?? 0, scheduled: job.scheduled ?? null };

/** Explain the choice without publishing or repeatedly storing historical game identities and seed lists. */
function criterionOf(selected) {
    const keys = ['state', 'opponent', 'reason', 'uncertainty', 'calibrationUncertainty', 'comparisons', 'expectedGain',
        'expectedVarianceReduction', 'connected', 'unanchored', 'reference', 'estimate', 'observations', 'effectiveUnits',
        'duplicates', 'unknownSeedAttempts', 'thresholds'];
    return { ...Object.fromEntries(keys.filter((k) => selected[k] !== undefined).map((k) => [k, selected[k]])),
        ...(selected.candidates ? { candidates: selected.candidates.map(({ opponent, expectedGain, expectedVarianceReduction, bridge }) =>
            ({ opponent, expectedGain, expectedVarianceReduction, bridge })) } : {}) };
}

/** Selection is read-only, deterministic, and based entirely on existing real results. */
function decision(job) {
    // Only an assigned legacy round has frozen execution rules. Never-started requests adopt the adaptive policy.
    if (!job.adaptive && job.round == null && !job.spec && PENDING.has(job.state)) {
        job = { ...job, adaptive: true, rounds: [], opponents: [], excludedSeeds: [], finished: 0, rated: 0, scheduled: 0 };
    }
    if (!job.adaptive || job.round != null || TERMINAL.has(job.state)) return job;
    if (identity.id === 'v2' && (!identity.contextMatches(job.context, identity.comparisonContext()) ||
        identity.bundleProblem(job.bundles, { [job.version]: checkedDigest(job.version) }))) {
        return { ...job, state: 'blocked', opponents: [], error: 'placement context or immutable bundle identity changed' };
    }
    if (!admitted(job.version, job.ref)) return { ...job, state: 'blocked', error: 'version is benched, withdrawn, or no longer admitted' };
    let data;
    try { data = history(); } catch { data = null; }
    if (!data || episodes(job).some((ep) => ep.state === 'complete') && !fs.existsSync(path.join(home.HOME, 'standings.json'))) {
        return { ...job, state: 'waiting', reason: 'history-unavailable', opponents: [], error: 'authoritative ladder history is missing or invalid' };
    }
    const candidates = opponentsOf(job.version);
    const unknown = new Set(data.attempted.filter((r) => r.seed === undefined && (r.a === job.version || r.b === job.version))
        .map((r) => r.a === job.version ? r.b : r.a));
    const opponents = candidates.filter((n) => !unknown.has(n));
    const anchors = require('./referee').anchorsOf(candidates).filter((n) => n !== job.version);
    // Keep every candidate in connectivity diagnostics, but never dispatch a pair whose old seed is unknown.
    const selected = require('./information').select({ target: job.version, opponents: candidates, anchors, ...data });
    const criterion = criterionOf(selected);
    if (selected.state !== 'complete' && counts(job).scheduled >= MAX_GAMES) return { ...job, state: 'inconclusive',
        reason: 'budget', opponents: [], criterion, error: 'placement safety budget reached before the information criterion' };
    if ((selected.avoidSeeds ?? []).length > MAX_EXCLUDED_SEEDS) return { ...job, state: 'waiting', reason: 'seed-history-limit',
        opponents: [], criterion, error: 'pair seed history exceeds the bounded placement planner limit' };
    if (selected.state === 'play' && !opponents.includes(selected.opponent)) {
        return { ...job, state: 'waiting', reason: 'unknown-seed-history', opponents: [], criterion,
            error: 'a useful opponent has historical attempts without seeds; refusing a possible duplicate' };
    }
    const state = selected.state === 'play' ? 'queued' : selected.state === 'waiting' && selected.reason === 'gain-plateau' ? 'inconclusive' : selected.state;
    return { ...job, state, opponents: selected.opponent ? [selected.opponent] : [],
        excludedSeeds: selected.avoidSeeds ?? [], reason: selected.reason, criterion,
        error: state === 'waiting' || state === 'inconclusive' ? selected.reason : null };
}

function records() {
    if (!isDirectory(DIR)) return [];
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && versionParts(f.slice(0, -5)))
        .map((f) => ({ file: f, record: readJson(path.join(DIR, f)) }))
        .filter(({ file, record: r }) => plain(r) && versionParts(r.version) && file === `${r.version}.json` &&
            typeof r.ref === 'string' && typeof r.queuedAt === 'string' && Array.isArray(r.opponents))
        .map(({ record }) => record)
        .sort((a, b) => (a.lastDispatchedAt ?? a.queuedAt).localeCompare(b.lastDispatchedAt ?? b.queuedAt) ||
            a.queuedAt.localeCompare(b.queuedAt) || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

const publicRecord = (r) => ({
    version: r.version, ref: r.ref, round: r.round ?? null, state: r.state, queuedAt: r.queuedAt, updatedAt: r.updatedAt,
    opponents: [...r.opponents], ...counts(r), progress: counts(r), error: r.error ?? null,
    reason: r.reason ?? null,
    ...(r.adaptive ? { adaptive: true, criterion: r.criterion ?? null,
        safetyGames: MAX_GAMES, rounds: episodes(r).map(({ round, state, finished = 0, rated = 0, scheduled = 0 }) => ({ round, state, finished, rated, scheduled })) } : { legacy: true })
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
    const record = decision({ version, ref, ...(identity.id === 'v2' ? { context: identity.comparisonContext(),
        bundles: { [version]: checkedDigest(version) } } : {}), adaptive: true, rounds: [], round: null, state: 'queued', queuedAt: now, updatedAt: now,
        opponents: [], finished: 0, rated: 0, scheduled: 0, error: null });
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

const statuses = () => records().map((r) => publicRecord(decision(r)));

/** Read-only: gamesctl plan runs as the bots' user and has no right to change the queue. */
function next() {
    const jobs = records().map(decision).filter((r) => PENDING.has(r.state));
    const active = jobs.find((r) => r.round != null);
    return (active ? getRound(active.round) : null) ?? (enabled() ? jobs.find((r) =>
        r.state === 'queued' && admitted(r.version, r.ref) && r.opponents.length > 0) : null) ?? null;
}

/** Works with the option off too: a started round must still finish under its frozen rules. */
function getRound(k) {
    for (const job of records()) {
        if (job.adaptive) {
            const ep = episodes(job).find((r) => r.round === k);
            if (ep) return { ...job, ...ep, round: k };
        } else if (job.round === k) return job;
    }
    return null;
}

/** Root alone reconciles queue eligibility; plan/status remain read-only and assigned rounds keep their snapshot. */
function reconcile() {
    for (const job of records().filter((r) => PENDING.has(r.state) && r.round == null)) {
        if (!admitted(job.version, job.ref)) {
            storeFile(fileOf(job.version), { ...job, state: 'cancelled', error: 'version is benched, withdrawn, or no longer admitted', updatedAt: new Date().toISOString() });
            continue;
        }
        const changed = decision(job);
        if (JSON.stringify(job) !== JSON.stringify(changed)) storeFile(fileOf(job.version), { ...changed, updatedAt: new Date().toISOString() });
    }
}

function reserve(k, makeSpec) {
    if (!Number.isSafeInteger(k) || k < 0 || typeof makeSpec !== 'function') throw new Error('placement round and spec builder required');
    if (!enabled() && !getRound(k)) return null;
    return locked(() => {
        reconcile();
        let assigned = getRound(k);
        if (assigned?.spec) {
            const why = identity.id === 'v2' ? specProblem(assigned.spec) : null;
            if (why) throw new Error(`frozen placement identity is incompatible: ${why}`);
            return assigned.spec;
        }
        let job = assigned ? records().find((r) => r.version === assigned.version) : null;
        if (!job) {
            if (!enabled()) return null;
            // The hook also runs when an ordinary round resumes. A new placement cannot take its number or files.
            const before = readJson(path.join(home.HOME, 'standings.json'))?.rounds ?? [];
            const ladder = readJson(path.join(home.RESULTS, identity.ladderId(k), 'ladder.json'));
            if (before.some((r) => r.round === k && !r.placement) || ladder?.config && !ladder.config.placement) return null;
            job = next();
            if (!job) return null;
            // A still-running request belongs to its first round, never another one.
            if (job.round !== null && job.round !== undefined) return null;
            if (!job.opponents.length) return null;
            const now = new Date().toISOString();
            const executionIdentity = identity.id === 'v2' ? { context: identity.comparisonContext(),
                bundles: Object.fromEntries([job.version, ...job.opponents].map((v) => [v, checkedDigest(v)])) } : {};
            job = { ...job, round: k, state: 'running', error: null, updatedAt: now, lastDispatchedAt: now,
                ...(job.adaptive ? { rounds: [...episodes(job), { round: k, state: 'running', finished: 0, rated: 0, scheduled: 0,
                    ...executionIdentity, opponents: [...job.opponents], excludedSeeds: [...(job.excludedSeeds ?? [])] }] } : executionIdentity) };
            // Reserve before a fallible pack/warm: a retry always prepares this version under this same round number.
            storeFile(fileOf(job.version), job);
        }
        try {
            if (identity.id === 'v2') {
                const why = identity.contextProblem(job.context, identity.comparisonContext());
                if (why || ![job.version, ...job.opponents].every((v) => admitted(v, v === job.version ? job.ref : undefined))) {
                    throw new Error(`placement admission or context changed: ${why ?? 'immutable version is no longer admitted'}`);
                }
                const frozenBundles = assigned?.bundles ?? (job.adaptive ? episodes(job).find((ep) => ep.round === k)?.bundles : job.bundles);
                const expected = Object.fromEntries([job.version, ...job.opponents].map((v) => [v, checkedDigest(v)]));
                if (identity.bundleProblem(frozenBundles, expected)) {
                    throw new Error('placement immutable version bundle changed');
                }
            }
            const spec = makeSpec(structuredClone(job));
            const bots = [job.version, ...job.opponents];
            if (!plain(spec) || spec.round !== k || JSON.stringify(spec.bots) !== JSON.stringify(bots) ||
                !Number.isInteger(spec.gamesPerPair) || (job.adaptive ? spec.gamesPerPair !== 2 || job.opponents.length !== 1 :
                    spec.gamesPerPair < 2 || spec.gamesPerPair > 10 || spec.gamesPerPair % 2)) {
                throw new Error(job.adaptive ? 'adaptive placement requires one opponent and exactly two mirrored games' :
                    'placement spec must keep its frozen lineup and 2..10 even games per pair');
            }
            if (identity.id === 'v2') {
                const why = specProblem(spec);
                if (why) throw new Error(`placement spec identity is incompatible: ${why}`);
            }
            const frozen = { ...spec, placement: { version: job.version, ref: job.ref,
                ...(job.adaptive ? { adaptive: true, excludedSeeds: [...(job.excludedSeeds ?? [])] } : {}) } };
            const scheduled = job.opponents.length * frozen.gamesPerPair;
            storeFile(fileOf(job.version), { ...job, ...(job.adaptive ? { rounds: episodes(job).map((ep) => ep.round === k ?
                { ...ep, spec: frozen, state: 'running', scheduled } : ep) } : { spec: frozen, scheduled }),
                state: 'running', error: null, updatedAt: new Date().toISOString() });
            return frozen;
        } catch (e) {
            storeFile(fileOf(job.version), { ...job, ...(job.adaptive ? { rounds: episodes(job).map((ep) => ep.round === k ? { ...ep, state: 'retrying' } : ep) } : {}),
                state: 'retrying', error: String(e?.message ?? e).slice(0, 1000), updatedAt: new Date().toISOString() });
            throw e;
        }
    });
}

/** Only scheduler/publisher counts go here. This queue never manufactures results or changes ratings. */
function update(k, patch = {}) {
    return locked(() => {
        const assigned = getRound(k);
        if (!assigned) return null;
        const job = records().find((r) => r.version === assigned.version);
        // A delayed publisher/failure callback cannot resurrect a completed placement or erase its progress.
        if (TERMINAL.has(job.state) || job.adaptive && (job.round !== k || episodes(job).find((ep) => ep.round === k)?.state === 'complete')) return publicRecord(job);
        const changed = { ...job, updatedAt: new Date().toISOString() };
        const progress = job.adaptive ? { ...episodes(job).find((ep) => ep.round === k) } : changed;
        for (const key of ['finished', 'rated', 'scheduled']) {
            if (patch[key] !== undefined) {
                if (!Number.isSafeInteger(patch[key]) || patch[key] < 0) throw new Error(`placement ${key} must be a nonnegative integer`);
                if (job.adaptive && patch[key] > 2) throw new Error('adaptive placement step counts cannot exceed two games');
                progress[key] = Math.max(progress[key] ?? 0, patch[key]);
            }
        }
        if (patch.error !== undefined) changed.error = patch.error === null ? null : String(patch.error).slice(0, 1000);
        if (patch.state !== undefined) {
            const done = patch.state === 'done' || patch.state === 'complete';
            const state = done ? progress.rated > 0 ? 'complete' : 'unrated' : patch.state;
            if (!PENDING.has(state) && !TERMINAL.has(state)) throw new Error(`unknown placement state ${state}`);
            if (job.adaptive) {
                progress.state = done ? 'complete' : state;
                changed.state = done ? progress.rated > 0 ? 'queued' : 'inconclusive' : state;
                if (done) {
                    changed.round = null;
                    changed.reason = progress.rated > 0 ? null : 'unrated';
                    changed.error = progress.rated > 0 ? null : 'the placement step produced no rated evidence';
                }
            } else {
                changed.state = state;
                if (done) changed.reason = 'legacy-fixed-batch';
            }
        }
        if (job.adaptive) changed.rounds = episodes(job).map((ep) => ep.round === k ? progress : ep);
        const evaluated = decision(changed);
        storeFile(fileOf(job.version), evaluated);
        return publicRecord(evaluated);
    });
}

module.exports = { enabled, enqueue, statuses, next, getRound, reserve, update, MAX_OPPONENTS, MAX_GAMES };
