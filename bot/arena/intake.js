#!/usr/bin/env node
'use strict';
/**
 * Bots that people submit on the arena window (its /mcp, tool arena_submit) enter the arena here.
 *
 *   node bot/arena/intake.js [--every 60] [--once] [--bench-new]
 *
 * Reads the window's `submissions` collection with the project token (SWU_WINDOW and the token as for push.js). For each
 * pending submission it packs a WebAssembly bundle (bot/compiled/README.md): JavaScript through Javy, Python with the
 * pinned CPython for WASI, a ready bundle as it is. It registers the builder's competitor the first time (owner
 * github:<login>), then submits the bundle as that competitor's next version (api.submit kind 'wasm', which starts it
 * once in the sandbox and expects ready). The outcome goes back to the window: the version, or the error lines, which
 * the builder reads with arena_my_submissions. The source is then dropped from the window; the arena keeps the bundle.
 *
 * Submitted code never runs outside the wasmtime sandbox, which has no network, no files but its own and the card data,
 * and no other programs. On top of that, packing and checking run in a child process (--check) that gets no token and,
 * where it can (root, unshare), its own PID and mount namespace (ops/isolate.sh), as the user ARENA_USER when set (no
 * capabilities, so it cannot undo the hiding), like the referee.
 * --bench-new puts a builder's new competitor on the bench (api.js withdraw), so it is rated only once rejoined: for a
 * tournament whose lineup is fixed. A builder's later versions go to wherever the competitor is.
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
const KINDS = ['js', 'python', 'wasm'];
const CHECK_MS = 5 * 60000; // packing (Javy) and the start check together
const STUCK_MS = 15 * 60000; // a submission left 'checking' this long (an intake that died) is checked again
const RETRIES = 3; // a check that ends with no result (the arena's fault) is tried this often before it is rejected
const RETRY_MS = 5 * 60000; // and waits this much longer before each new try
const ERROR_CHARS = 2000;
// the checker's working folders, outside /tmp: the checker gets a /tmp of its own (isolate.sh --tmp)
const WORK = process.env.ARENA_INTAKE_WORK || path.join(ROOT, 'build', 'intake');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// the packing tools (bundle.py, Javy) read submitted files: they get a plain environment, never the checker's token
const toolEnv = () => Object.fromEntries(['PATH', 'HOME', 'LANG', 'TZ'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        network: 'none', deterministic: true, build: { source: `submitted by github:${owner}`, toolchain: lang === 'js' ? `javy ${TOOLCHAIN.javy.version}` : lang }
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
        const r = spawnSync('python3', [path.join(COMPILED, 'bundle.py'), out], { encoding: 'utf8', timeout: 60000, env: toolEnv() });
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
 * The checker (a child process without the token): packs one submission and enters it. Returns {version, name} or
 * throws. job = {id, owner, name, note, kind, files, base64?, entry?}.
 */
function check(job, { benchNew = false, work }) {
    const { api } = require('./api');
    const home = require('./home');
    need(LOGIN.test(job.owner ?? ''), 'no owner');
    need(NAME.test(job.name ?? ''), 'name: 1-32 characters, lowercase letters, digits and _, starting with a letter');
    need(KINDS.includes(job.kind), `kind: one of ${KINDS.join(', ')}`);
    need(typeof job.note === 'string' && job.note.trim(), 'note: one line saying what this version changes');
    const { builderName, ownsName } = require('./api');
    need(ownsName(job.owner, job.name), `the name "${job.name}" is not yours: use your builder name ${builderName(job.owner)}, or it with _ and a suffix`);
    const owner = `github:${job.owner}`;
    const r = home.roster();
    const entry = [...r.agents, ...(r.bench ?? [])].find((a) => a.name === job.name);
    need(!entry || entry.owner === owner, `the name "${job.name}" belongs to another competitor; submit under another name`);
    const benched = () => !!home.roster().bench?.some((a) => a.name === job.name);
    // entered already (an intake that died, or could not write the result back, before it said so): that version
    const ref = `window:${job.id}`;
    const before = !entry ? undefined : home.versionsOf(job.name).find((n) => home.readJson(path.join(home.VERSIONS, `${job.name}-v${n}`, 'SUBMISSION.json'), {}).ref === ref);
    if (before !== undefined) {
        return { name: job.name, version: `${job.name}-v${before}`, benched: benched() };
    }
    const folder = pack(job, work);
    const token = process.env.ARENA_ADMIN_TOKEN; // a hosted arena (ARENA_AUTH=1) takes the admin token for this
    if (!entry) {
        // a builder's first bot must start before a competitor is made for it (api.submit checks it again)
        const { startCheck } = require('./api');
        startCheck(path.dirname(folder), `${job.name}-v1`, require('./registry').WASM_BOT, job.name);
        api.register({ name: job.name, title: job.name, owner, harness: { kind: 'builder', selfRun: true }, token,
            philosophy: `Submitted on the arena window by @${job.owner}.` });
        if (benchNew) {
            api.withdraw({ name: job.name, token });
        }
    }
    let v;
    try {
        v = api.submit({ name: job.name, note: job.note.trim().slice(0, 300), bot: { kind: 'wasm', files: bundleFiles(folder) }, token, ref });
    } catch (e) {
        if (!entry) {
            // the starter version register made is not the builder's bot: no competitor until one of theirs starts
            home.updateRoster((ro) => ({ ...ro, agents: ro.agents.filter((a) => a.name !== job.name), ...(ro.bench ? { bench: ro.bench.filter((a) => a.name !== job.name) } : {}) }));
            for (const n of home.versionsOf(job.name)) {
                home.removeDir(path.join(home.VERSIONS, `${job.name}-v${n}`));
            }
            home.removeDir(path.join(home.AGENTS, job.name));
        }
        throw e;
    }
    return { name: job.name, version: v.version, benched: benched() };
}

/**
 * Runs check() for one submission in a child process, isolated when possible; returns {ok, ...} for the window.
 *
 *     WORK/job-XXXX/        root's (0755): the checker cannot swap what is in it
 *         tmp/              root's (1777): the checker's /tmp (isolate.sh --tmp)
 *         home/             the checker's user's (0700): job.json, its HOME, the packing, the bundle's compiled code
 *
 * The result comes back as the last line the checker prints, so the parent never opens a file the checker could have
 * replaced with a link.
 */
async function checkIsolated(job, { benchNew }) {
    fs.mkdirSync(WORK, { recursive: true });
    const work = fs.mkdtempSync(path.join(WORK, 'job-'));
    try {
        fs.chmodSync(work, 0o755);
        fs.mkdirSync(path.join(work, 'tmp'), { mode: 0o1777 });
        fs.chmodSync(path.join(work, 'tmp'), 0o1777);
        const jobHome = path.join(work, 'home');
        fs.mkdirSync(jobHome, { mode: 0o700 });
        const jobFile = path.join(jobHome, 'job.json');
        fs.writeFileSync(jobFile, JSON.stringify(job), { flag: 'wx' });
        // only what the checker needs: no token, no proxy (the toolchain is fetched beforehand)
        // (a hosted arena's register and submit take the admin token; the tools that read submitted files never get it)
        const keep = ['PATH', 'HOME', 'LANG', 'TZ', 'ARENA_HOME', 'ARENA_DASH', 'ARENA_RESULTS', 'SWU_CARD_JSON', 'ARENA_ADMIN_TOKEN', 'ARENA_AUTH'];
        const env = Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
        // compiled code of a bot that may be rejected stays with the job and goes with it; the ladders compile their own
        env.SWU_WASM_CACHE = path.join(jobHome, 'wasm-cache');
        const node = [process.execPath, __filename, '--check', jobFile, '-', ...(benchNew ? ['--bench-new'] : [])];
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
        fs.writeFileSync(CHECKER_PID, String(child.pid));
        let err = '';
        let out = '';
        child.stdout.on('data', (d) => {
            out = (out + d).slice(-OUT_CHARS);
        });
        child.stderr.on('data', (d) => {
            err = (err + d).slice(-20000);
        });
        // past its time it is stopped, and killed if it does not stop (a checker that never ends would hold the intake)
        const timer = setTimeout(() => {
            stop('SIGTERM');
            setTimeout(() => stop('SIGKILL'), 10000).unref();
        }, CHECK_MS);
        const code = await new Promise((resolve) => child.on('close', resolve));
        clearTimeout(timer);
        stop('SIGKILL'); // whatever the checker left behind (a bot its start check gave up on, outside isolate.sh)
        checkers.delete(child.pid);
        fs.rmSync(CHECKER_PID, { force: true });
        const res = lastResult(out);
        if (res) {
            return res;
        }
        log(`check of ${job.id} ended with ${code} and no result:\n${err}`);
        // stopped at its time limit: the bot's doing (Javy on a huge file, a bot that never answers). Any other end with
        // no result is the arena's (isolation, a bug of ours): the submission is tried again later
        return code === null ? { ok: false, error: `the check took more than ${CHECK_MS / 60000} minutes` }
            : { ok: false, retry: true, error: 'the arena could not check it (its error is in the intake log)' };
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
// next to WORK, never in it: WORK belongs to the checker's user, who could put a link there for us to write through
const CHECKER_PID = `${WORK}.checker.pid`;

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
        spawnSync('python3', ['-c', 'import wasmtime'], { stdio: 'ignore', env: toolEnv() }).status !== 0 && 'wasmtime for Python'
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
async function intakeOnce({ benchNew = false, window = require('./push'), finished = new Set(), unsent = new Map(), missing = toolchainMissing, checker = checkIsolated, stats = {}, current = {} } = {}) {
    // for the games machine (games.js): how many submissions are still open after this pass, and how many it accepted
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
            log(`${id}: checking ${doc.kind} bot "${doc.name}" from @${doc.owner}`);
            res = await checker({ ...doc, id }, { benchNew });
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

/** One intake at a time (a second would check the same submission twice): its pid in WORK/intake.pid. */
function onlyIntake() {
    const file = path.join(WORK, 'intake.pid');
    fs.mkdirSync(WORK, { recursive: true });
    for (let i = 0; i < 2; i++) {
        try {
            fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
            process.on('exit', () => fs.rmSync(file, { force: true }));
            return true;
        } catch (e) {
            if (e.code !== 'EEXIST') {
                throw e;
            }
        }
        const pid = Number(fs.readFileSync(file, 'utf8'));
        let cmd = '';
        try {
            cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        } catch {}
        if (pid && cmd.includes('intake.js')) {
            return false;
        }
        fs.rmSync(file, { force: true }); // left by an intake that is gone
    }
    return false;
}

async function main(argv) {
    const flag = (n) => argv.includes(`--${n}`);
    const opt = (n, d) => {
        const i = argv.indexOf(`--${n}`);
        return i >= 0 ? argv[i + 1] : d;
    };
    if (flag('check')) {
        // the result is the last line on stdout (checkIsolated reads it); everything else goes to stderr
        console.log = console.error;
        const [jobFile] = argv.slice(argv.indexOf('--check') + 1);
        const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
        let res;
        try {
            res = { ok: true, ...check(job, { benchNew: flag('bench-new'), work: path.dirname(jobFile) }) };
        } catch (e) {
            if (!(e instanceof IntakeError) && !e.code) {
                throw e; // a bug of ours: no result, so the main loop says to try later and logs this
            }
            // capped as intakeOnce caps it, so the line always fits what checkIsolated keeps (OUT_CHARS)
            res = { ok: false, error: String(e.message).slice(0, ERROR_CHARS) };
        }
        process.stdout.write(`${JSON.stringify(res)}\n`);
        return;
    }
    if (!onlyIntake()) {
        log('intake: another intake is running for this arena; this one stops');
        return;
    }
    // a stopped intake takes its running check with it (the check is a process group of its own), and puts that
    // submission back (at most 5 s: a window that does not answer leaves it to the stuck rule)
    const current = {};
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        process.on(sig, () => {
            stopCheckers();
            const code = 128 + require('os').constants.signals[sig];
            setTimeout(() => process.exit(code), 5000).unref();
            release(current).catch((e) => log(`intake: ${e.message}`)).finally(() => process.exit(code));
        });
    }
    const benchNew = flag('bench-new');
    const everyMs = Number(opt('every', 60)) * 1000;
    const finished = new Set();
    const unsent = new Map();
    for (;;) {
        try {
            await intakeOnce({ benchNew, finished, unsent, current });
        } catch (e) {
            log(`intake: ${e.message}`);
            if (flag('once')) {
                process.exitCode = 1;
            }
        }
        if (flag('once')) {
            return;
        }
        await sleep(everyMs);
    }
}

module.exports = { pack, check, checkIsolated, intakeOnce, release, onlyIntake, stopCheckers, toolchainMissing, lastResult, bundleFiles, writeFiles, RETRIES };
if (require.main === module) {
    main(process.argv.slice(2)).catch((e) => {
        console.error(e.stack ?? e.message);
        process.exit(1);
    });
}
