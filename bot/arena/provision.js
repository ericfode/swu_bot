'use strict';
/** Provision a logical arena on the existing volume. No historical scores or unchecked bot flags are copied. */
const fs = require('fs');
const path = require('path');
const identity = require('./identity');
const { bundleDigest, compatibilityStatus } = require('./compatibility');

const read = (file) => {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink !== 1) throw new Error(`${file} is not a plain unlinked file`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
};
function plainDirectory(dir) {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a plain directory`);
}
function createJson(file, value) {
    try { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o644 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
}
function atomicJson(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    try { fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
}

/** Idempotent empty provisioning. Unknown image identity creates an empty, explicitly blocked arena. */
function initialize({ data, context = identity.comparisonContext() }) {
    const root = identity.stateRoot(data, 'v2');
    const home = path.join(root, 'arena');
    for (const dir of [path.resolve(data), path.join(path.resolve(data), 'arenas'), root, home, path.join(root, 'results')]) plainDirectory(dir);
    const file = path.join(home, 'ARENA.json');
    const valid = context !== null && identity.contextProblem(context, context) === null;
    if (context !== null && !valid) throw new Error('cannot provision an invalid v2 comparison context');
    createJson(file, { schema: 1, arenaId: 'v2', requiredProtocol: 2, createdAt: new Date().toISOString(), context });
    const saved = read(file);
    if (saved.arenaId !== 'v2' || saved.requiredProtocol !== 2) throw new Error('the target is not a fresh v2 arena namespace');
    if (saved.context && (!valid || !identity.contextMatches(saved.context, context))) {
        throw new Error('the v2 namespace belongs to another or unavailable comparison context; preserve it and provision a new logical arena');
    }
    const rosterFile = path.join(home, 'roster.json');
    const standingsFile = path.join(home, 'standings.json');
    createJson(rosterFile, { arenaId: 'v2', requiredProtocol: 2, thinkCapMs: 60000, baselines: [], agents: [] });
    createJson(standingsFile, { schema: 'swu-arena/1', arenaId: 'v2', requiredProtocol: 2, context,
        startedAt: saved.createdAt, rounds: [], global: {} });
    const roster = read(rosterFile);
    const standings = read(standingsFile);
    if (roster.arenaId !== 'v2' || roster.requiredProtocol !== 2 || standings.arenaId !== 'v2' || standings.requiredProtocol !== 2) {
        throw new Error('refusing historical roster or standings in the new namespace');
    }
    if (saved.context && !identity.contextMatches(standings.context, saved.context)) {
        throw new Error('the standings context differs from the immutable arena identity');
    }
    if (!saved.context && valid) {
        const versions = path.join(home, 'versions');
        if (roster.agents.length || roster.baselines?.length || roster.bench?.length || standings.rounds.length
            || Object.keys(standings.global ?? {}).length || (fs.existsSync(versions) && fs.readdirSync(versions).length)
            || fs.readdirSync(path.join(root, 'results')).length) {
            throw new Error('an unverified namespace containing bots or results cannot be relabeled');
        }
        atomicJson(file, { ...saved, context });
        atomicJson(standingsFile, { ...standings, context });
    }
    return { arenaId: 'v2', root, home, results: path.join(root, 'results'), context,
        ready: valid, reason: valid ? 'verified empty comparison namespace' : 'image build/card identity unavailable; no bot is eligible' };
}

/** Read immutable source metadata and validate/identify bundles, never execute a bot. */
function candidates(sourceHome) {
    const roster = read(path.join(sourceHome, 'roster.json'));
    const versions = path.join(sourceHome, 'versions');
    const dirs = fs.readdirSync(versions);
    return (roster.agents ?? []).map((agent) => {
        const result = { name: agent.name, sourceArena: roster.arenaId ?? 'open' };
        try {
            if (!/^[a-z][a-z0-9_]{0,31}$/.test(agent.name)) throw new Error('invalid source competitor name');
            const prefix = `${agent.name}-v`;
            const available = dirs.filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
                .map((name) => Number(name.slice(prefix.length))).filter((v) => !(agent.withdrawn ?? []).includes(v)).sort((a, b) => a - b);
            if (!available.length) throw new Error('no non-withdrawn immutable version');
            result.sourceVersion = `${agent.name}-v${available.at(-1)}`;
            const dir = path.join(versions, result.sourceVersion);
            if (!fs.lstatSync(dir).isDirectory()) throw new Error('source version is not a plain directory');
            const meta = read(path.join(dir, 'SUBMISSION.json'));
            if (meta.bot?.kind !== 'wasm') throw new Error('source version is not a sandboxed bundle; submit a new v2 bundle');
            const bundle = path.join(dir, 'bundle');
            if (!fs.lstatSync(bundle).isDirectory()) throw new Error('source bundle is not a plain directory');
            const manifest = read(path.join(bundle, 'arena.json'));
            if (manifest.protocol !== 2) throw new Error('manifest protocol must be exactly 2; the old bot is left unchanged');
            result.bundleSha256 = bundleDigest(bundle);
            const owner = agent.resident && agent.owner === 'arena' ? '@arena' : /^github:[a-zA-Z0-9-]+$/.test(agent.owner ?? '') ? agent.owner.slice(7) : null;
            if (!owner) throw new Error('source ownership cannot be verified');
            return { ...result, owner, bundle, status: 'unverified', reason: 'requires an explicit v2 handshake in the isolated checker' };
        } catch (e) { return { ...result, status: 'rejected', reason: e.message }; }
    });
}

function migrationBlocker(intake) {
    if (process.platform !== 'linux' || process.getuid?.() !== 0 || !process.env.ARENA_USER || process.env.ARENA_INTAKE_NO_ISOLATE) {
        return 'migration requires the existing Linux root controller, ARENA_USER and enabled checker isolation';
    }
    const missing = intake.toolsMissing(['wasm']);
    return missing.length ? `isolated checker unavailable: ${missing.join(', ')}` : null;
}

/** Called only after preflight in the root controller; the checker is the same established intake path. */
async function verifyCandidates(rows, { check, context, readFiles = require('./intake').bundleFiles }) {
    const results = [];
    for (const row of rows) {
        if (row.status === 'rejected') { results.push(row); continue; }
        try {
            // Re-read and compare immediately before checking, rather than trusting a plan's labels or files.
            if (bundleDigest(row.bundle) !== row.bundleSha256) throw new Error('the source bundle changed after planning');
            const packed = readFiles(row.bundle);
            const base64 = Object.keys(packed).filter((name) => typeof packed[name] !== 'string');
            const files = Object.fromEntries(Object.entries(packed).map(([name, value]) => [name, typeof value === 'string' ? value : value.base64]));
            const job = { id: `v2-migration.${row.name}.${row.bundleSha256}`, owner: row.owner, name: row.name, kind: 'wasm', files, base64,
                note: `V2 arena copy of ${row.sourceArena}/${row.sourceVersion}; source SHA256 ${row.bundleSha256}` };
            const checked = await check(job, { requireIsolation: true, expectedBundleSha256: row.bundleSha256 });
            const status = compatibilityStatus(checked.compatibility, { bundleSha256: row.bundleSha256, context });
            if (!checked.ok || !status.compatible) throw new Error(checked.error ?? status.reason);
            results.push({ ...row, status: 'accepted', reason: status.reason, version: checked.version, compatibility: checked.compatibility });
        } catch (e) { results.push({ ...row, status: 'rejected', reason: e.message }); }
    }
    return results.map(({ bundle, owner, ...row }) => row);
}

async function main(argv) {
    const value = (flag) => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1]; };
    const data = value('--data');
    if (!data || argv.includes('--help')) throw new Error('usage: ARENA_ID=v2 node bot/arena/provision.js --data <existing volume> [--source-home <old arena>] [--apply]');
    if (identity.id !== 'v2') throw new Error('provisioning requires ARENA_ID=v2');
    const sourceHome = value('--source-home');
    const context = identity.comparisonContext();
    const rows = sourceHome ? candidates(path.resolve(sourceHome)) : [];
    if (!argv.includes('--apply')) {
        console.log(JSON.stringify({ arenaId: 'v2', root: identity.stateRoot(data, 'v2'), context, dryRun: true,
            candidates: rows.map(({ bundle, owner, ...r }) => r) }, null, 2));
        return;
    }
    const initialized = initialize({ data, context });
    if (!sourceHome) { console.log(JSON.stringify(initialized, null, 2)); return; }
    const expectedHome = path.join(identity.stateRoot(data, 'v2'), 'arena');
    if (process.env.ARENA_HOME && path.resolve(process.env.ARENA_HOME) !== expectedHome) throw new Error('ARENA_HOME must name the new namespace');
    Object.assign(process.env, { ARENA_HOME: expectedHome, ARENA_RESULTS: path.join(initialized.root, 'results'),
        ARENA_DASH: path.join(initialized.root, 'dash'), ARENA_INTAKE_WORK: path.join(initialized.root, 'intake'),
        ARENA_HIDE: ['/.fly', path.join(data, 'secret'), path.join(data, 'server'), path.join(data, 'arena'), path.join(data, 'results'),
            path.join(data, 'coord'), path.join(initialized.root, 'server')].join(':') });
    const intake = require('./intake');
    const blocker = initialized.ready ? migrationBlocker(intake) : initialized.reason;
    const results = blocker ? rows.map(({ bundle, owner, ...r }) => ({ ...r, status: 'blocked', reason: blocker }))
        : await verifyCandidates(rows, { check: intake.checkIsolated, context });
    const report = { arenaId: 'v2', context, sourceHome: path.resolve(sourceHome), checkedAt: new Date().toISOString(), blocker, candidates: results };
    atomicJson(path.join(expectedHome, 'migration.json'), report);
    console.log(JSON.stringify(report, null, 2));
    if (blocker) process.exitCode = 1;
}

module.exports = { initialize, candidates, verifyCandidates, migrationBlocker };
if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
