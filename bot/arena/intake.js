#!/usr/bin/env node
'use strict';
/**
 * Bots that people submit on the arena window (its /mcp, tool arena_submit) enter the arena here. The games machine
 * runs one pass at a time (intakeOnce): the arena server's games role through `node bot/arena/gamesctl.js intake`.
 *
 *   node bot/arena/intake.js --check <job.json> -      the checker for one submission (checkIsolated starts it)
 *
 * Reads the window's `submissions` collection with the project token (SWU_WINDOW and the token as for push.js). For each
 * pending submission a checker packs a WebAssembly bundle (bot/compiled/README.md): JavaScript through Javy, Python
 * with the pinned CPython for WASI, a ready bundle as it is, and starts it once in the sandbox (hello, expect ready).
 * Then the intake (root on the games machine) registers the builder's competitor the first time (owner
 * github:<login>) and enters the bundle as that competitor's next version (api.submit kind 'wasm'). The outcome goes
 * back to the window: the version, or the error lines, which the builder reads with arena_my_submissions. The source
 * is then dropped from the window; the arena keeps the bundle.
 * A house submission (owner HOUSE, which no GitHub login can be, so only a project or admin token can write one:
 * ops/house-submit.js) enters one of the arena's own bots: a resident entry under any free name, owner 'arena'
 * (api.js register resident), rated with everyone and anchoring the ratings.
 *
 * Submitted code never runs outside the wasmtime sandbox, which has no network, no files but its own and the card data,
 * and no other programs. On top of that, packing and checking run in a child process (--check) that gets no token and,
 * where it can (root, unshare), its own PID and mount namespace (ops/isolate.sh), as the user ARENA_USER when set (no
 * capabilities, so it cannot undo the hiding), like the referee. It reads and writes only its job folder, never the
 * arena's (ARENA_HIDE hides them on the games machine): it leaves the bundle there as a canonical tar, which root
 * unpacks (bundle.py unpack, no links) and enters without running anything (enter).
 * A builder's later versions go to wherever the competitor is: on the bench (api.js withdraw), they wait for rejoin.
 * The toolchain (Javy, CPython for WASI) must be in build/compiled/.tools: Dockerfile.games builds it, or
 * `python3 -c "import sys; sys.path.insert(0, 'bot/compiled'); import build; build.javy(); build.runtime('python-3.14-wasi')"`.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const COMPILED = path.join(ROOT, 'bot', 'compiled');
const TOOLCHAIN = require('../compiled/toolchain.json');
const TOOLS = path.join(ROOT, 'build', 'compiled', '.tools');
const NAME = /^[a-z][a-z0-9_]{0,31}$/;
const LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const HOUSE = '@arena'; // the owner of a house submission: the arena's own bots (residents)
const KINDS = ['js', 'python', 'wasm'];
const CHECK_MS = 5 * 60000; // packing (Javy) and the start check together
const STUCK_MS = 15 * 60000; // a submission left 'checking' this long (an intake that died) is checked again
const RETRIES = 3; // a check that ends with no result (the arena's fault) is tried this often before it is rejected
const RETRY_MS = 5 * 60000; // and waits this much longer before each new try
const ERROR_CHARS = 2000;
// the canonical tar a check leaves: bundle.py unpack's own limit (64 MiB of files) plus headers and padding
const MAX_TAR_BYTES = (64 << 20) + (4 << 20);
// the checker's working folders, outside /tmp: the checker gets a /tmp of its own (isolate.sh --tmp)
const WORK = process.env.ARENA_INTAKE_WORK || path.join(ROOT, 'build', 'intake');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// the packing tools (bundle.py, Javy) read submitted files: they get a plain environment, never the checker's token
const toolEnv = () => Object.fromEntries(['PATH', 'HOME', 'LANG', 'TZ'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

class IntakeError extends Error {}
const need = (cond, msg) => {
    if (!cond) {
        throw new IntakeError(msg);
    }
};

/** Writes a submission's files (text, or base64 for the paths listed in `base64`) into dir; returns their relative paths. */
function writeFiles(dir, files, base64 = []) {
    need(files && typeof files === 'object' && !Array.isArray(files), 'files: an object of path -> content');
    const out = [];
    for (const [rel, body] of Object.entries(files)) {
        const f = path.resolve(dir, rel);
        need(f.startsWith(dir + path.sep) && typeof body === 'string' && !rel.split(/[\\/]/).some((p) => p === '..' || p === '.git'), `bad file path ${rel}`);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, base64.includes(rel) ? Buffer.from(body, 'base64') : body);
        out.push(path.relative(dir, f).split(path.sep).join('/'));
    }
    return out;
}

const sha256 = (file) => require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function manifest(name, lang, entry, runtime, run, cards, owner) {
    return {
        schema: 'swu-arena-bot/1', name, lang, protocol: 2, kind: 'wasm', platform: 'wasm32-wasip1', runtime, run,
        entry_sha256: sha256(entry),
        resources: { memory_mb: 1024, start_ms: 30000, decide_ms: 10000 },
        cards: cards ? { use: 'mount', layout: 'dir', env: { SWU_CARD_JSON: '/cards' } } : { use: 'none' },
        network: 'none', deterministic: true, build: { source: owner === HOUSE ? 'an arena house submission' : `submitted by github:${owner}`, toolchain: lang === 'js' ? `javy ${TOOLCHAIN.javy.version}` : lang }
    };
}

/** Lines of a failed tool's output worth showing the builder, with our folders taken out. */
function tail(text, work) {
    return String(text ?? '').split(work).join('.').split('\n').filter((l) => l.trim()).slice(-12).join('\n');
}

/** The submission as a bundle folder (work/bundle); throws IntakeError with what is wrong. */
function pack(job, work) {
    const out = path.join(work, 'bundle');
    fs.mkdirSync(out, { recursive: true });
    if (job.kind === 'wasm') {
        writeFiles(out, job.files, job.base64);
        const r = spawnSync('python3', ['-I', path.join(COMPILED, 'bundle.py'), out], { encoding: 'utf8', timeout: 60000, env: toolEnv() });
        need(r.status === 0, `not a valid bundle (bot/compiled/README.md):\n${tail(r.stderr || r.stdout || r.error?.message, work)}`);
        return out;
    }
    if (job.kind === 'python') {
        const files = writeFiles(out, job.files, job.base64);
        const entry = job.entry ?? 'bot.py';
        need(files.includes(entry), `no ${entry}: a Python bot's files must include it (or name another entry)`);
        need(fs.existsSync(path.join(TOOLS, TOOLCHAIN.runtimes['python-3.14-wasi'].dir, 'python.wasm')), 'the arena has no CPython for WASI yet; try again later');
        const m = manifest(job.name, 'python', path.join(out, entry), 'python-3.14-wasi', { cmd: 'python3', args: [entry], env: {} }, true, job.owner);
        fs.writeFileSync(path.join(out, 'arena.json'), `${JSON.stringify(m, null, 2)}\n`);
        return out;
    }
    // JavaScript: the files in src/, bundled into one script (only files inside src/ can be required), then compiled
    // with QuickJS into bot.wasm by Javy. require('./stdio') gives the arena's serve(), next to the entry and at the top:
    // a stdio.js the bot brings (bot/stdio.js, copied to test at home) is replaced, since Node's needs Node.
    const src = path.join(work, 'src');
    fs.mkdirSync(src, { recursive: true });
    const files = writeFiles(src, job.files, job.base64);
    const entry = job.entry ?? 'bot.js';
    need(files.includes(entry), `no ${entry}: a JavaScript bot's files must include it (or name another entry)`);
    for (const dir of new Set([src, path.dirname(path.join(src, entry))])) {
        fs.copyFileSync(path.join(COMPILED, 'js', 'serve.js'), path.join(dir, 'stdio.js'));
    }
    let script;
    try {
        script = require('../compiled/js/bundle').bundle(path.join(src, entry), [job.name], { root: src });
    } catch (e) {
        throw new IntakeError(`could not bundle ${entry}: ${tail(e.message, work)}`);
    }
    const js = path.join(work, 'bot.bundle.js');
    fs.writeFileSync(js, script);
    const javy = path.join(TOOLS, `javy-${TOOLCHAIN.javy.version}`, 'javy');
    need(fs.existsSync(javy), 'the arena has no Javy yet; try again later');
    const wasm = path.join(out, 'bot.wasm');
    const r = spawnSync(javy, ['build', ...TOOLCHAIN.javy.flags, '-o', wasm, js], { encoding: 'utf8', timeout: 180000, cwd: work, env: toolEnv() });
    need(r.status === 0, `Javy could not compile it:\n${tail(r.stderr || r.error?.message, work)}`);
    const m = manifest(job.name, 'js', wasm, 'wasi-p1', { cmd: './bot.wasm', args: [], env: {} }, false, job.owner);
    fs.writeFileSync(path.join(out, 'arena.json'), `${JSON.stringify(m, null, 2)}\n`);
    return out;
}

/** api.submit's bot.files for a bundle folder: text files as they are, everything else as base64. */
function bundleFiles(folder) {
    const files = {};
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const f = path.join(dir, e.name);
            if (e.isDirectory()) {
                walk(f);
            } else if (e.isFile()) {
                const rel = path.relative(folder, f).split(path.sep).join('/');
                const buf = fs.readFileSync(f);
                const text = buf.toString('utf8');
                files[rel] = Buffer.from(text, 'utf8').equals(buf) && !text.includes('\u0000') ? text : { base64: buf.toString('base64') };
            }
        }
    };
    walk(folder);
    return files;
}

/**
 * Root's half before a check, and again before the entry (no submitted code runs here): the submission's fields, the
 * builder's right to the name, and a version already entered for this submission (an intake that died before it could
 * say so). Throws IntakeError. job = {id, owner, name, note, kind, files, base64?, entry?}, as the window holds it.
 */
function admit(job) {
    const home = require('./home');
    const house = job.owner === HOUSE;
    need(house || LOGIN.test(job.owner ?? ''), 'no owner');
    need(NAME.test(job.name ?? ''), 'name: 1-32 characters, lowercase letters, digits and _, starting with a letter');
    need(KINDS.includes(job.kind), `kind: one of ${KINDS.join(', ')}`);
    need(typeof job.note === 'string' && job.note.trim(), 'note: one line saying what this version changes');
    const { builderName, ownsName } = require('./api');
    need(house || ownsName(job.owner, job.name), `the name "${job.name}" is not yours: use your builder name ${builderName(job.owner)}, or it with _ and a suffix`);
    const owner = house ? 'arena' : `github:${job.owner}`;
    const r = home.roster();
    const entry = [...r.agents, ...(r.bench ?? [])].find((a) => a.name === job.name);
    need(!entry || entry.owner === owner, `the name "${job.name}" belongs to another competitor; submit under another name`);
    const ref = `window:${job.id}`;
    const versions = entry ? home.versionsOf(job.name) : [];
    const before = versions.find((n) => home.readJson(path.join(home.VERSIONS, `${job.name}-v${n}`, 'SUBMISSION.json'), {}).ref === ref);
    // the version this submission becomes unless another comes first: a builder's first bot is v1 (after the starter
    // v0), as is a resident's first
    const next = entry ? (versions.at(-1) ?? (entry.resident ? 0 : -1)) + 1 : 1;
    return { house, owner, entry, ref, before, next };
}

/**
 * The checker's half (a child process, as the bots' user and isolated on the games machine, with no token and none of
 * the arena's folders): packs the submission, checks the bundle's manifest and files (bundle.py), starts it once in the
 * sandbox (hello, expect ready), and leaves its canonical tar as <work>/bundle.tar for root to enter. Returns
 * {sha256} or throws. job.checkAs names the version in the hello.
 */
function packAndCheck(job, { work }) {
    const { startCheck } = require('./api');
    const folder = pack(job, work);
    const bundlePy = path.join(COMPILED, 'bundle.py');
    // every kind, Python packs too: what is entered must pass what play-seed and the round's packing will ask of it
    const ok = spawnSync('python3', ['-I', bundlePy, folder], { encoding: 'utf8', timeout: 60000, env: toolEnv() });
    need(ok.status === 0, `not a valid bundle (bot/compiled/README.md):\n${tail(ok.stderr || ok.stdout || ok.error?.message, work)}`);
    startCheck(work, job.checkAs, require('./registry').WASM_BOT, job.name);
    const tar = spawnSync('python3', ['-I', bundlePy, 'tar', folder], { timeout: 60000, env: toolEnv(), maxBuffer: MAX_TAR_BYTES });
    need(tar.status === 0, `the bundle cannot be packed:\n${tail(String(tar.stderr ?? '') || tar.error?.message, work)}`);
    fs.writeFileSync(path.join(work, 'bundle.tar'), tar.stdout, { flag: 'wx' });
    return { sha256: require('crypto').createHash('sha256').update(tar.stdout).digest('hex') };
}

/** A file the checker left, read without following a link: a plain file with no other names, of at most max bytes. */
function readLeft(file, max) {
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    let fd;
    try {
        fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch {
        return null;
    }
    try {
        const st = fs.fstatSync(fd);
        return st.isFile() && st.nlink === 1 && st.size <= max ? fs.readFileSync(fd) : null;
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Root's half after a check that passed (no submitted code runs here): unpacks the tar the checker left in the job's
 * home folder with bundle.py unpack (which trusts nothing in it, follows no link and makes a fresh folder) into a
 * folder only root can reach, checks its manifest, and enters it: the builder's competitor the first time, then the
 * bundle as its next version (api.submit, told the start check was made). Name, owner and note come from the window's
 * submission, never from the checker. sha256: the tar's hash as the checker printed it, so a tar another process of the
 * bots' user changed after the check is not entered. Returns {ok, name, version, benched} or throws.
 */
function enter(job, work, sha256) {
    const home = require('./home');
    const { api } = require('./api');
    const benched = () => !!home.roster().bench?.some((a) => a.name === job.name);
    // the roster as it is now (the check took a while)
    const { house, owner, entry, ref, before } = admit(job);
    if (before !== undefined) {
        return { ok: true, name: job.name, version: `${job.name}-v${before}`, benched: benched() };
    }
    // the checker and everything it started are gone (its process group was killed, and on the games machine its PID
    // namespace with it), and its home folder's place in work/ is root's: the file read here stays what it is
    const tar = readLeft(path.join(work, 'home', 'bundle.tar'), MAX_TAR_BYTES);
    need(tar, 'the check left no bundle');
    const hex = require('crypto').createHash('sha256').update(tar).digest('hex');
    need(hex === sha256, 'the bundle changed after its check');
    const mine = path.join(work, 'enter');
    fs.mkdirSync(mine, { mode: 0o700 });
    fs.writeFileSync(path.join(mine, 'bundle.tar'), tar, { flag: 'wx', mode: 0o600 });
    const bundlePy = path.join(COMPILED, 'bundle.py');
    const folder = path.join(mine, 'bundle');
    const unpacked = spawnSync('python3', ['-I', bundlePy, 'unpack', path.join(mine, 'bundle.tar'), folder, hex], { encoding: 'utf8', timeout: 60000, env: toolEnv() });
    need(unpacked.status === 0, `the bundle did not unpack:\n${tail(unpacked.stderr || unpacked.error?.message, work)}`);
    const ok = spawnSync('python3', ['-I', bundlePy, folder], { encoding: 'utf8', timeout: 60000, env: toolEnv() });
    need(ok.status === 0, `not a valid bundle (bot/compiled/README.md):\n${tail(ok.stderr || ok.error?.message, work)}`);
    const files = bundleFiles(folder);
    const token = process.env.ARENA_ADMIN_TOKEN; // a hosted arena (ARENA_AUTH=1) takes the admin token for this
    // the checker made the start check; nothing here runs a bot (a builder's starter v0 is not loaded either)
    const checked = { checked: true };
    if (!entry) {
        api.register(house
            ? { name: job.name, title: job.name, owner, resident: true, token, philosophy: 'One of the arena\'s own bots, played in every round with the builders\' bots.' }
            : { name: job.name, title: job.name, owner, harness: { kind: 'builder', selfRun: true }, token, philosophy: `Submitted on the arena window by @${job.owner}.` }, checked);
    }
    let v;
    try {
        v = api.submit({ name: job.name, note: job.note.trim().slice(0, 300), bot: { kind: 'wasm', files }, token, ref }, checked);
    } catch (e) {
        if (!entry) {
            // the starter version register made is not the builder's bot: no competitor until one of theirs is entered
            home.updateRoster((ro) => ({ ...ro, agents: ro.agents.filter((a) => a.name !== job.name), ...(ro.bench ? { bench: ro.bench.filter((a) => a.name !== job.name) } : {}) }));
            for (const n of home.versionsOf(job.name)) {
                home.removeDir(path.join(home.VERSIONS, `${job.name}-v${n}`));
            }
            home.removeDir(path.join(home.AGENTS, job.name));
            const dash = require('./dash');
            fs.rmSync(path.join(home.HOME, 'panels', `${job.name}.say.json`), { force: true });
            if (dash.enabled()) {
                fs.rmSync(path.join(dash.DASH, 'panels', `arena-${job.name}.json`), { force: true });
            }
        }
        throw e;
    }
    return { ok: true, name: job.name, version: v.version, benched: benched() };
}

/** Root's halves around the check: a submission refused before or after it, as the window reads it. */
function refused(e) {
    if (!(e instanceof IntakeError) && !e.code) {
        throw e; // a bug of ours
    }
    return { ok: false, error: String(e.message).slice(0, ERROR_CHARS) };
}

/**
 * One submission: root admits it, a child process packs and start-checks it (isolated when possible), and root enters
 * what the child left; returns {ok, ...} for the window.
 *
 *     WORK/job-XXXX/        root's (0755): the checker cannot swap what is in it
 *         tmp/              root's (1777): the checker's /tmp (isolate.sh --tmp)
 *         home/             the checker's user's (0700): job.json, its HOME, the packing, bundle.tar
 *         enter/            root's (0700), made after the check: the tar and the bundle root enters
 *
 * The checker's result comes back as the last line it prints, so the parent never opens a file the checker could
 * have replaced with a link; the one file it reads there (bundle.tar) it opens without following one.
 */
async function checkIsolated(job) {
    let admitted;
    try {
        admitted = admit(job);
    } catch (e) {
        return refused(e);
    }
    if (admitted.before !== undefined) {
        // entered already (an intake that died, or could not write the result back, before it said so): that version
        return { ok: true, name: job.name, version: `${job.name}-v${admitted.before}`, benched: !!require('./home').roster().bench?.some((a) => a.name === job.name) };
    }
    reapOrphan();
    fs.mkdirSync(WORK, { recursive: true });
    const work = fs.mkdtempSync(path.join(WORK, 'job-'));
    try {
        fs.chmodSync(work, 0o755);
        fs.mkdirSync(path.join(work, 'tmp'), { mode: 0o1777 });
        fs.chmodSync(path.join(work, 'tmp'), 0o1777);
        const jobHome = path.join(work, 'home');
        fs.mkdirSync(jobHome, { mode: 0o700 });
        const jobFile = path.join(jobHome, 'job.json');
        fs.writeFileSync(jobFile, JSON.stringify({ ...job, checkAs: `${job.name}-v${admitted.next}` }), { flag: 'wx' });
        // only what the checker needs: no token, no proxy (the toolchain is fetched beforehand), none of the arena's
        // folders (it reads and writes only its job folder)
        const keep = ['PATH', 'HOME', 'LANG', 'TZ', 'SWU_CARD_JSON'];
        const env = Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
        // compiled code of a bot that may be rejected stays with the job and goes with it; the ladders compile their own
        env.SWU_WASM_CACHE = path.join(jobHome, 'wasm-cache');
        const node = [process.execPath, __filename, '--check', jobFile, '-'];
        const isolated = process.getuid?.() === 0 && !process.env.ARENA_INTAKE_NO_ISOLATE;
        // as root, the checker runs as ARENA_USER (the games machine: arena), which cannot undo isolate.sh's hiding: it
        // gets the job's home folder, as its HOME
        const user = isolated ? process.env.ARENA_USER : null;
        if (user) {
            const [uid, gid] = ['-u', '-g'].map((flag) => Number(require('child_process').execFileSync('id', [flag, user], { encoding: 'utf8' })));
            // the file first, while its folder is still root's 0700 (nothing can swap it for a link yet), the folder last
            fs.lchownSync(jobFile, uid, gid);
            fs.chownSync(jobHome, uid, gid);
            env.HOME = jobHome;
        }
        const isolate = isolated
            ? ['bash', path.join(__dirname, 'ops', 'isolate.sh'), ...(user ? ['--user', user] : []), '--tmp', path.join(work, 'tmp'),
                ...hidden().flatMap((p) => ['--hide', p]), '--']
            : [];
        const [cmd, ...args] = [...isolate, ...node];
        // its own process group, so a stop reaches every process it started (isolate.sh, the checker, Javy, a bot)
        const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        const stop = (signal) => {
            try {
                process.kill(-child.pid, signal);
            } catch {} // gone already
        };
        // the group a stopped intake must take down with it: in memory for its own signal handler, and in a file, the
        // only trace of an orphaned check should the intake be killed before it can
        checkers.add(child.pid);
        fs.writeFileSync(CHECKER_PID, [child.pid, procStat(child.pid)?.start, bootId()].join(' '));
        let err = '';
        let out = '';
        child.stdout.on('data', (d) => {
            out = (out + d).slice(-OUT_CHARS);
        });
        child.stderr.on('data', (d) => {
            err = (err + d).slice(-20000);
        });
        // past its time it is stopped, and killed if it does not stop (a checker that never ends would hold the intake)
        let late = false;
        const timer = setTimeout(() => {
            late = true;
            stop('SIGTERM');
            setTimeout(() => stop('SIGKILL'), 10000).unref();
        }, CHECK_MS);
        const code = await new Promise((resolve) => child.on('close', resolve));
        clearTimeout(timer);
        stop('SIGKILL'); // whatever the checker left behind (a bot its start check gave up on, outside isolate.sh)
        checkers.delete(child.pid);
        fs.rmSync(CHECKER_PID, { force: true });
        const res = lastResult(out);
        if (!res) {
            log(`check of ${job.id} ended with ${code} and no result:\n${err}`);
            // stopped at its time limit: the bot's doing (Javy on a huge file, a bot that never answers). Any other end
            // with no result is the arena's (isolation, a bug of ours): the submission is tried again later
            return late ? { ok: false, error: `the check took more than ${CHECK_MS / 60000} minutes` }
                : { ok: false, retry: true, error: 'the arena could not check it (its error is in the intake log)' };
        }
        if (!res.ok) {
            // only its words: whether to try again is root's call
            return { ok: false, error: String(res.error ?? 'the check failed').slice(0, ERROR_CHARS) };
        }
        if (stopping) {
            return { ok: false, retry: true, error: 'the intake stopped' };
        }
        try {
            return enter(job, work, res.sha256);
        } catch (e) {
            return refused(e);
        }
    } finally {
        require('./home').removeTree(work);
    }
}

const OUT_CHARS = 64 * 1024; // what is kept of a checker's stdout: its result is the last line

/** The checker's result: its last stdout line, when that is {ok: true|false, ...}; null otherwise. */
function lastResult(out) {
    const line = String(out).trimEnd().split('\n').pop();
    try {
        const r = JSON.parse(line);
        return r && typeof r === 'object' && typeof r.ok === 'boolean' ? r : null;
    } catch {
        return null;
    }
}

const checkers = new Set(); // process groups of the checks running now
// stopCheckers ran: the intake is stopping. A check it killed is no result (not the bot's doing), and nothing more is
// claimed or written: release() puts the submission back, or the stuck rule picks it up later
let stopping = false;
// next to WORK, never in it: the checker's user may write in WORK's job folders, and could put a link there for us to
// write through. It holds "<pid> <start time> <boot id>" of the check running now.
const CHECKER_PID = `${WORK}.checker.pid`;

/** A process's state letter and start time (/proc/<pid>/stat fields 3 and 22), or null when there is none (or no /proc). */
function procStat(pid) {
    try {
        const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
        return { state: fields[0], start: fields[19] };
    } catch {
        return null;
    }
}

const bootId = () => {
    try {
        return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
        return '';
    }
};

/**
 * A check that an intake killed before it could stop it (a SIGKILL, a crash) is still running: its process group is
 * killed before a new check starts, and on the games machine its PID namespace with it, so it cannot reach the next
 * job's folder. The pid counts only with the start time and boot it was written with: a new process that got the same
 * pid is left alone.
 */
function reapOrphan() {
    let words;
    try {
        words = fs.readFileSync(CHECKER_PID, 'utf8').trim().split(' ');
    } catch {
        return; // none
    }
    const pid = Number(words[0]);
    const was = Number.isSafeInteger(pid) && pid > 1 && words[1] && words[2] === bootId() ? procStat(pid) : null;
    if (was && was.start === words[1]) {
        log(`a check left running by an earlier intake (process group ${pid}) is killed`);
        try {
            process.kill(-pid, 'SIGKILL');
        } catch {} // gone already
        // the group's first process (isolate.sh) gone or dead: its namespace goes with the namespace's first process
        const wait = new Int32Array(new SharedArrayBuffer(4));
        for (let i = 0; i < 100; i++) {
            const now = procStat(pid);
            if (!now || now.start !== was.start || now.state === 'Z' || now.state === 'X') {
                break;
            }
            Atomics.wait(wait, 0, 0, 50);
        }
    }
    fs.rmSync(CHECKER_PID, { force: true });
}

/** Kills every running check's process group (the intake is stopping). */
function stopCheckers() {
    stopping = true;
    for (const pgid of checkers) {
        try {
            process.kill(-pgid, 'SIGKILL');
        } catch {} // gone already
    }
    checkers.clear();
    fs.rmSync(CHECKER_PID, { force: true });
}

/** What the checker must not see: ARENA_HIDE's list (the games machine sets it), else a session's credential files. */
function hidden() {
    const list = (process.env.ARENA_HIDE ?? '').split(':').filter(Boolean);
    return list.length ? list : ['/root/.claude', '/root/.claude.json', '/root/.config', '/root/.fly', '/root/.aws', '/root/.boto', '/root/.ssh',
        '/root/.gitconfig', '/root/.git-credentials', '/root/.netrc', '/root/.npmrc', '/root/.docker', '/root/.kube', '/root/.pki',
        '/root/.arena-secret', '/root/.ccr-hearth-status-nudge', '/home/claude/.claude'];
}

let toolsReady = false;
/** Why the arena cannot check submissions yet (no wasmtime, Javy or CPython for WASI), or null once it can. */
function toolchainMissing() {
    if (toolsReady) {
        return null;
    }
    const missing = [
        !fs.existsSync(path.join(TOOLS, `javy-${TOOLCHAIN.javy.version}`, 'javy')) && 'Javy',
        !fs.existsSync(path.join(TOOLS, TOOLCHAIN.runtimes['python-3.14-wasi'].dir, 'python.wasm')) && 'CPython for WASI',
        spawnSync('python3', ['-I', '-c', 'import wasmtime'], { stdio: 'ignore', env: toolEnv() }).status !== 0 && 'wasmtime for Python'
    ].filter(Boolean);
    toolsReady = !missing.length;
    return missing.length ? `no ${missing.join(', ')} (the games image builds them; elsewhere see bot/compiled/README.md)` : null;
}

/**
 * One pass: every pending submission on the window, oldest first. Returns how many were handled. `finished` holds the
 * ids already accepted or rejected, which later passes of the same process skip without reading; `unsent` the results
 * the window did not take (it was down), sent again first. Nothing is checked while the toolchain is missing. A check
 * that ends with no result (the arena's fault) leaves the submission pending, tried again later, RETRIES times at most.
 */
async function intakeOnce({ window = require('./push'), finished = new Set(), unsent = new Map(), missing = toolchainMissing, checker = checkIsolated, stats = {}, current = {} } = {}) {
    // for the games machine (gamesctl intake): how many submissions are still open after this pass, and how many it accepted
    stats.open = 0;
    stats.accepted = 0;
    if (stopping) {
        stats.open = null;
        return 0;
    }
    // without the toolchain every check would fail: submissions stay pending until it is there
    const why = missing();
    if (why) {
        log(`intake: waiting, ${why}`);
        stats.open = null; // not known
        return 0;
    }
    for (const [id, out] of unsent) {
        await window.putDoc('submissions', id, out);
        unsent.delete(id);
        finished.add(id);
        log(`${id}: ${out.state} (sent again)`);
    }
    const list = await window.request('GET', '/api/docs/submissions');
    let done = 0;
    for (const { id } of [...(list ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
        if (stopping) {
            break;
        }
        if (finished.has(id)) {
            continue;
        }
        const doc = await window.request('GET', `/api/docs/submissions/${encodeURIComponent(id)}`);
        if (doc?.state === 'accepted' || doc?.state === 'rejected') {
            finished.add(id);
            continue;
        }
        const stuck = doc?.state === 'checking' && Date.now() - Date.parse(doc.checkingAt ?? 0) > STUCK_MS;
        if (doc) {
            stats.open++;
        }
        if (!doc || !(doc.state === 'pending' || stuck) || (doc.retryAt && Date.parse(doc.retryAt) > Date.now())) {
            continue;
        }
        // a check the arena never finished (it stopped or crashed) counts as a try, so a submission that takes the
        // machine down cannot be checked forever
        const claimed = stuck ? { ...doc, tries: (doc.tries ?? 0) + 1 } : doc;
        if (stuck && claimed.tries >= RETRIES) {
            const { files, base64, checkingAt, ...rest } = claimed;
            const out = { ...rest, fileNames: Object.keys(files ?? {}), state: 'rejected', checkedAt: new Date().toISOString(),
                error: `the arena stopped during its check ${claimed.tries} times; submit it again later` };
            await window.putDoc('submissions', id, out);
            finished.add(id);
            stats.open--;
            log(`${id}: rejected (the arena stopped during its check ${claimed.tries} times)`);
            done++;
            continue;
        }
        if (stopping) {
            break;
        }
        // what a stop puts back (release): the submission as it was before this claim, with the tries counted so far
        Object.assign(current, { id, doc: claimed });
        let res;
        try {
            await window.putDoc('submissions', id, { ...claimed, state: 'checking', checkingAt: new Date().toISOString() });
            if (stopping) {
                break; // stopped while claiming: release() puts it back
            }
            log(`${id}: checking ${doc.kind} bot "${doc.name}" from ${doc.owner === HOUSE ? 'the arena' : `@${doc.owner}`}`);
            res = await checker({ ...doc, id });
        } finally {
            delete current.id;
            delete current.doc;
        }
        if (stopping) {
            break; // the check was killed: no result to write
        }
        const tries = (claimed.tries ?? 0) + 1;
        if (res.retry && tries < RETRIES) {
            // the arena's fault: the submission waits, files and all, and is tried again later
            const { checkingAt, ...back } = claimed;
            await window.putDoc('submissions', id, { ...back, state: 'pending', tries, retryAt: new Date(Date.now() + RETRY_MS * tries).toISOString() });
            log(`${id}: no result (try ${tries} of ${RETRIES}), tried again later`);
            continue;
        }
        const { files, base64, checkingAt, ...rest } = claimed;
        const fileNames = Object.keys(files ?? {});
        const out = res.ok
            ? { ...rest, fileNames, state: 'accepted', version: res.version, benched: res.benched, checkedAt: new Date().toISOString() }
            : { ...rest, fileNames, state: 'rejected', error: `${res.error}${res.retry ? ` (tried ${tries} times; submit it again later)` : ''}`.slice(0, ERROR_CHARS), checkedAt: new Date().toISOString() };
        try {
            await window.putDoc('submissions', id, out);
        } catch (e) {
            unsent.set(id, out);
            throw e;
        }
        finished.add(id);
        stats.open--;
        stats.accepted += res.ok ? 1 : 0;
        log(`${id}: ${out.state}${res.ok ? ` as ${res.version}${res.benched ? ' (benched)' : ''}` : `: ${String(res.error).split('\n')[0]}`}`);
        done++;
    }
    return done;
}

/**
 * A stopping intake puts the submission it was checking back to pending (with the tries counted so far), so the next
 * start checks it at once instead of waiting for it to look stuck. `current` is the object intakeOnce was given.
 */
async function release(current, window = require('./push')) {
    const doc = current?.doc;
    if (!current?.id || !doc) {
        return false;
    }
    const { id } = current;
    const { checkingAt, ...back } = doc;
    await window.putDoc('submissions', id, { ...back, state: 'pending' });
    log(`${id}: put back to pending (the intake stopped during its check)`);
    return true;
}

async function main(argv) {
    if (!argv.includes('--check')) {
        console.error('usage: node bot/arena/intake.js --check <job.json> -  (the games machine runs the intake passes)');
        process.exitCode = 2;
        return;
    }
    // the result is the last line on stdout (checkIsolated reads it); everything else goes to stderr
    console.log = console.error;
    const [jobFile] = argv.slice(argv.indexOf('--check') + 1);
    const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    let res;
    try {
        res = { ok: true, ...packAndCheck(job, { work: path.dirname(jobFile) }) };
    } catch (e) {
        if (!(e instanceof IntakeError) && !e.code) {
            throw e; // a bug of ours: no result, so checkIsolated says to try later and logs this
        }
        // capped as intakeOnce caps it, so the line always fits what checkIsolated keeps (OUT_CHARS)
        res = { ok: false, error: String(e.message).slice(0, ERROR_CHARS) };
    }
    process.stdout.write(`${JSON.stringify(res)}\n`);
}

module.exports = { pack, admit, packAndCheck, enter, checkIsolated, intakeOnce, release, stopCheckers, toolchainMissing, lastResult, bundleFiles, writeFiles, RETRIES };
if (require.main === module) {
    main(process.argv.slice(2)).catch((e) => {
        console.error(e.stack ?? e.message);
        process.exit(1);
    });
}
