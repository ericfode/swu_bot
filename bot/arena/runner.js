'use strict';
/**
 * Runs the unattended competitors of a clocked tournament (referee.js --tournament). When a round's work window opens,
 * it starts every competitor's harness with the round's brief (brief.md, filled in), and stops it shortly before the
 * window ends, together with everything it started (evals included).
 *
 *   node bot/arena/runner.js [--only a,b] [--logs <dir>] [--repo <checkout>] [--budget-usd 50] [--stop-early-min 2]
 *                            [--mirror <local results> <shared results>] [--once]
 *
 * The harness comes from the competitor's roster entry:
 *   {kind: 'claude-code', model, effort?, memory?: 'optmem'}   headless Claude Code (claude -p) with the arena MCP
 *                                                              server, working in the competitor's own folder
 *   {kind: 'script', cmd: 'node bot/arena/optimizer.js ...'}    a program, run from the repo each round
 *   {kind: 'command', cmd: ['prog', 'arg', '{prompt_file}']}    anything else: {prompt}, {prompt_file}, {name} and
 *                                                              {minutes} are filled in
 * A claude-code harness that stops while 5 minutes or more are left is resumed (same session) with the time left, up to
 * 5 times a round. --budget-usd caps what one competitor may spend in one round (claude --max-budget-usd, over all of
 * its sessions that round). memory 'optmem' gives the competitor OptMem (github.com/VictorTaelin/OptMem): `memo` from
 * <ARENA_HOME>/tools on its PATH, its memory in <ARENA_HOME>/memory/<name>, and the OptMem block in its system prompt.
 * A claude-code harness gets only the tools in TOOLS plus the arena MCP server: no subagents, web, schedules or messages
 * to other sessions.
 *
 * Every harness runs with a clean environment: PATH, locale, the proxy and certificate settings, ANTHROPIC_BASE_URL,
 * ARENA_HOME and ARENA_DASH, and its own HOME (<logs>/homes/<name>). Nothing else of the runner's environment (no
 * tokens, no session of the Claude Code that started the runner). Each one runs in its own process group, and its
 * environment carries ARENA_RUN=<name>-r<round>, so whatever it leaves running (an eval in another process group too) is
 * stopped with it when its session ends or the window closes.
 * --repo is the checkout competitors see as the repo (evals, reference code): give them a copy, so a stray edit cannot
 * change the referee's code. Logs go to <logs>/<name>/ (r<K>-<n>.jsonl: claude's stream-json, usage.jsonl) and are
 * copied to <ARENA_HOME>/logs/<name>/ after every session. --mirror copies the referee's results from local disk into
 * the shared folder every 60 s (each file written whole, then renamed), so the ladder never appends to the synced mount.
 *
 * Usage brake: the competitors share the account's usage limits with everything else on it. The runner reads the
 * limits claude reports (rate_limit_event), from the sessions and from a tiny probe every 10 minutes, and when the
 * 5-hour window passes --brake-5h (default 0.8) or the 7-day window passes --brake-7d (default 0.95) it stops every
 * claude-code competitor and starts none until that window resets. Scripts keep running.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const home = require('./home');
const { api, clock } = require('./api');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const REPO = path.resolve(arg('repo', path.join(__dirname, '..', '..')));
const LOGS = path.resolve(arg('logs', path.join(os.homedir(), 'arena-run', 'logs')));
const BUDGET_USD = Number(arg('budget-usd', '50'));
const STOP_EARLY_MS = Number(arg('stop-early-min', '2')) * 60000;
const RESUME_MIN_MS = 5 * 60000;
const MAX_SESSIONS = 6;
const POLL_MS = 5000;
const PROBE_MS = 10 * 60000;
const BRAKE = { five_hour: Number(arg('brake-5h', '0.8')), seven_day: Number(arg('brake-7d', '0.95')) };
const ONLY = arg('only', null)?.split(',');
// what a harness may see of the runner's environment: what it needs to reach the network and the API, nothing else
const PASS = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GLOBAL_AGENT_HTTPS_PROXY', 'GLOBAL_AGENT_NO_PROXY',
    'NODE_USE_ENV_PROXY', 'JAVA_TOOL_OPTIONS', 'ANTHROPIC_BASE_URL', 'ARENA_DASH'];
// the built-in tools a claude-code harness gets (--tools). No subagents (4 cores are shared by every competitor, and the
// duel compares models, each working alone), no web, schedules, remote triggers or messages to other sessions.
const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** Writes a file whole and renames it into place, so a reader (or a synced folder) never sees half of it. */
function copyWhole(src, dst) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = `${dst}.${process.pid}.tmp`;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
}

function fill(tpl, vars) {
    return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function cleanEnv(name, tag) {
    const env = Object.fromEntries(PASS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
    env.HOME = path.join(LOGS, 'homes', name);
    env.ARENA_HOME = home.HOME;
    env.ARENA_RUN = tag;
    fs.mkdirSync(env.HOME, { recursive: true });
    return env;
}

/** Processes whose environment carries ARENA_RUN=<tag>: everything a harness started, in any process group. */
function tagged(tag) {
    const want = `ARENA_RUN=${tag}`;
    const pids = [];
    for (const p of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(p) || Number(p) === process.pid) {
            continue;
        }
        try {
            if (fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0').includes(want)) {
                pids.push(Number(p));
            }
        } catch {
            // gone already
        }
    }
    return pids;
}

/** Sends sig to process group pgid (if given) and to every process tagged `tag`. */
function stopAll(pgid, tag, sig) {
    for (const pid of [...(pgid ? [-pgid] : []), ...tagged(tag)]) {
        try {
            process.kill(pid, sig);
        } catch {
            // gone already
        }
    }
}

// the newest usage limits claude reported: {five_hour: {utilization, resetsAt}, seven_day: ..., status, at}
let limits = null;
const running = new Map(); // tag -> stop(), for the brake and for the runner's own exit

function noteLimits(info) {
    if (!info) {
        return;
    }
    limits = { ...info.unifiedWindows, status: info.status, at: new Date().toISOString() };
    const why = braked();
    if (why && running.size) {
        log(`usage brake: ${why}; stopping ${[...running.keys()].join(', ')}`);
        for (const stop of running.values()) {
            stop();
        }
    }
}

/** Why claude-code competitors must not run now (a usage window over its brake, until it resets), or null. */
function braked(now = Date.now()) {
    if (!limits) {
        return null;
    }
    if (limits.status === 'rejected') {
        return 'claude reports the account is over its limit';
    }
    for (const [w, max] of Object.entries(BRAKE)) {
        const u = limits[w];
        if (u && u.utilization >= max && !(u.resetsAt && now > u.resetsAt * 1000)) {
            return `${w} usage ${Math.round(u.utilization * 100)}% >= ${Math.round(max * 100)}% until ${u.resetsAt ? new Date(u.resetsAt * 1000).toISOString().slice(0, 16) : '?'}`;
        }
    }
    return null;
}

/** The last rate_limit_event's info in stream-json text, or null. */
function lastLimits(text) {
    let info = null;
    for (const line of text.split('\n')) {
        if (line.includes('"rate_limit_event"')) {
            try {
                info = JSON.parse(line).rate_limit_info ?? info;
            } catch {
                // a line still being written
            }
        }
    }
    return info;
}

/** Follows a growing file: each call returns the text added since the last call (whole lines only). */
function follower(file) {
    let pos = 0;
    return () => {
        let text = '';
        try {
            const fd = fs.openSync(file, 'r');
            try {
                const size = fs.fstatSync(fd).size;
                const buf = Buffer.alloc(Math.max(0, size - pos));
                fs.readSync(fd, buf, 0, buf.length, pos);
                const end = buf.lastIndexOf(10) + 1;
                pos += end;
                text = buf.subarray(0, end).toString('utf8');
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            // not there yet
        }
        return text;
    };
}

/** Asks claude for one word, only to read the account's current usage limits from its stream. */
async function probeLimits() {
    const dir = path.join(LOGS, '_probe');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'probe.jsonl');
    fs.writeFileSync(out, '');
    await runUntil('claude', ['-p', 'Reply with the single word ok.', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
        '--output-format', 'stream-json', '--verbose', '--max-turns', '1'], { cwd: dir, env: cleanEnv('_probe', 'probe'), out, stopAt: Date.now() + 120000, tag: 'probe' });
    noteLimits(lastLimits(fs.readFileSync(out, 'utf8')));
}

/** The OptMem block for a competitor with memory 'optmem' ('' otherwise); sets up its memory folder the first time. */
function memoryBlock(c, env) {
    if (c.harness?.memory !== 'optmem') {
        return '';
    }
    const tools = path.join(home.HOME, 'tools');
    if (!fs.existsSync(path.join(tools, 'memo'))) {
        throw new Error(`${c.name}: memory 'optmem' needs ${tools}/memo (github.com/VictorTaelin/OptMem)`);
    }
    env.MEMORY_DIR = path.join(home.HOME, 'memory', c.name);
    env.PATH = `${tools}:${env.PATH}`;
    // init is safe to repeat: it only creates what is missing, and prints the block to put in the agent's instructions
    const out = execFileSync('memo', ['init'], { env, encoding: 'utf8' });
    const i = out.indexOf('## Memory');
    if (i < 0) {
        throw new Error(`${c.name}: memo init printed no setup block`);
    }
    return out.slice(i);
}

function brief(c, st, extra) {
    return fill(fs.readFileSync(path.join(__dirname, 'brief.md'), 'utf8'), {
        name: c.name, title: c.title ?? c.name, tournament: st.tournament?.title ?? 'Arena tournament', round: st.roundIndex ?? st.round,
        rounds: st.plannedRounds ?? '?', deadline: st.deadline, minutes: st.minutesLeft, agentDir: path.join(home.AGENTS, c.name), repo: REPO,
        capSeconds: home.roster().thinkCapMs / 1000, memory: c.harness?.memory === 'optmem' ? '\nYour memory across rounds is OptMem as well as NOTES.md (see your system prompt).\n' : ''
    }) + `\nThis session runs in ${path.join(home.AGENTS, c.name)} and is stopped at ${extra.stopAt} (UTC), ${Math.round(STOP_EARLY_MS / 60000)} minutes`
        + ' before the window ends: submit and update NOTES.md before then. Anything you leave running when your session'
        + ` ends is stopped. Your harness may also stop you if you reach this round's budget. Run evals from ${REPO} (cd there first).\n`;
}

function claudeArgs(c, prompt, { sessionId, budget, system }) {
    const h = c.harness;
    const mcp = { mcpServers: { arena: { command: process.execPath, args: [path.join(__dirname, 'mcp.js')],
        env: { ARENA_HOME: home.HOME, ARENA_COMPETITOR: c.name, ...(process.env.ARENA_DASH ? { ARENA_DASH: process.env.ARENA_DASH } : {}) } } } };
    const mcpFile = path.join(LOGS, c.name, 'mcp.json');
    fs.writeFileSync(mcpFile, JSON.stringify(mcp));
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--mcp-config', mcpFile, '--strict-mcp-config',
        '--tools', TOOLS.join(','), '--allowedTools', [...TOOLS, 'mcp__arena'].join(','), '--disable-slash-commands',
        '--permission-mode', 'acceptEdits', '--max-budget-usd', budget.toFixed(2)];
    if (h.model) {
        args.push('--model', h.model);
    }
    if (h.effort) {
        args.push('--effort', h.effort);
    }
    if (system) {
        args.push('--append-system-prompt', system);
    }
    if (sessionId) {
        args.push('--resume', sessionId);
    }
    return args;
}

/** What one claude session reported: its session id, cost and turns (null fields when it ended without a result). */
function readSession(file) {
    const r = { sessionId: null, costUSD: 0, turns: null, result: null };
    let text = '';
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return r;
    }
    for (const line of text.split('\n')) {
        if (!line.startsWith('{')) {
            continue;
        }
        let j;
        try {
            j = JSON.parse(line);
        } catch {
            continue;
        }
        r.sessionId = j.session_id ?? r.sessionId;
        if (j.type === 'result') {
            r.costUSD = j.total_cost_usd ?? 0;
            r.turns = j.num_turns ?? null;
            r.result = j.subtype ?? null;
        }
    }
    return r;
}

/**
 * Runs cmd in its own process group until it exits or `stopAt`, then stops the group and every process tagged `tag`
 * (SIGTERM, SIGKILL 15 s later). While it runs, `running` holds a stop() for it, and tick() (if given) is called every
 * few seconds. Resolves {code, signal, stopped, error}.
 */
function runUntil(cmd, args, { cwd, env, out, stopAt, tag, tick }) {
    return new Promise((resolve) => {
        const fd = fs.openSync(out, 'a');
        const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd], detached: true });
        fs.closeSync(fd);
        let stopped = false;
        const stop = () => {
            if (!stopped) {
                stopped = true;
                stopAll(child.pid, tag, 'SIGTERM');
                setTimeout(() => stopAll(child.pid, tag, 'SIGKILL'), 15000).unref();
            }
        };
        running.set(tag, stop);
        const timer = setTimeout(stop, Math.max(0, stopAt - Date.now()));
        const ticker = tick ? setInterval(tick, POLL_MS) : null;
        const done = (r) => {
            clearTimeout(timer);
            clearInterval(ticker);
            running.delete(tag);
            // whatever it left running (an eval, a server) goes with it
            stopAll(child.pid, tag, 'SIGTERM');
            setTimeout(() => stopAll(child.pid, tag, 'SIGKILL'), 5000).unref();
            tick?.();
            resolve({ ...r, stopped });
        };
        child.on('error', (e) => done({ code: null, error: e.message }));
        child.on('exit', (code, signal) => done({ code, signal }));
    });
}

function saveLogs(c) {
    const dir = path.join(LOGS, c.name);
    for (const f of fs.readdirSync(dir)) {
        if (/^r\d+-\d+\.(jsonl|log)$|^usage\.jsonl$/.test(f)) {
            try {
                copyWhole(path.join(dir, f), path.join(home.HOME, 'logs', c.name, f));
            } catch (e) {
                log(`${c.name}: could not copy ${f} to the arena folder: ${e.message}`);
            }
        }
    }
}

const say = (c, now) => {
    try {
        api.say({ name: c.name, now, token: process.env.ARENA_ADMIN_TOKEN });
    } catch (e) {
        log(`${c.name}: say failed: ${e.message}`);
    }
};

/** One competitor's work in one round's window. */
async function work(c, st) {
    const dir = path.join(LOGS, c.name);
    fs.mkdirSync(dir, { recursive: true });
    const k = st.round;
    const stopAt = Date.parse(st.deadline) - STOP_EARLY_MS;
    const h = c.harness ?? {};
    const tag = `${c.name}-r${k}`;
    const env = cleanEnv(c.name, tag);
    const usage = (u) => fs.appendFileSync(path.join(dir, 'usage.jsonl'), `${JSON.stringify({ round: k, at: new Date().toISOString(), ...u })}\n`);
    if (Date.now() > stopAt - 60000) {
        log(`${c.name}: round ${k} window is nearly over, skipping it`);
        return;
    }
    if (h.kind === 'claude-code') {
        const memory = memoryBlock(c, env);
        let spent = 0;
        let sessionId = null;
        for (let n = 1; n <= MAX_SESSIONS; n++) {
            const left = stopAt - Date.now();
            const budget = BUDGET_USD - spent;
            if (left < (n === 1 ? 60000 : RESUME_MIN_MS) || budget < 0.5) {
                break;
            }
            if (braked()) {
                log(`${c.name}: not starting session ${n}: usage brake (${braked()})`);
                usage({ session: n, skipped: `usage brake: ${braked()}` });
                break;
            }
            const minutes = Math.floor(left / 60000);
            const stopText = new Date(stopAt).toISOString().slice(11, 16);
            const prompt = n === 1
                ? brief(c, { ...clock(), round: k }, { stopAt: stopText })
                : `Round ${st.roundIndex ?? k} is still open: ${minutes} minutes are left before you are stopped at ${stopText} UTC. Anything you left running when your last session ended (an eval) was stopped. Keep improving your bot: test the next idea against your last version and the baselines, submit when it is better, post a thought with arena_say, and keep NOTES.md current.`;
            const out = path.join(dir, `r${k}-${n}.jsonl`);
            fs.writeFileSync(path.join(dir, `r${k}-${n}.prompt.md`), prompt);
            log(`${c.name}: round ${k} session ${n}, ${minutes} min, budget $${budget.toFixed(2)}`);
            say(c, n === 1 ? `Round ${st.roundIndex ?? k}: working until ${stopText} UTC` : `Round ${st.roundIndex ?? k}: back to work (${minutes} min left)`);
            const t0 = Date.now();
            const follow = follower(out);
            const res = await runUntil('claude', claudeArgs(c, prompt, { sessionId, budget, system: memory || null }),
                { cwd: path.join(home.AGENTS, c.name), env, out, stopAt, tag, tick: () => noteLimits(lastLimits(follow())) });
            const s = readSession(out);
            sessionId = s.sessionId ?? sessionId;
            spent += s.costUSD;
            usage({ session: n, exit: res.code, signal: res.signal ?? null, stopped: res.stopped, minutes: +((Date.now() - t0) / 60000).toFixed(1), costUSD: s.costUSD, turns: s.turns, result: s.result, error: res.error });
            saveLogs(c);
            log(`${c.name}: session ${n} ended (${res.stopped ? (braked() ? 'stopped by the usage brake' : 'stopped at the deadline') : `exit ${res.code ?? res.signal}`}), $${s.costUSD.toFixed(2)}`);
            if (res.stopped || !sessionId) {
                break;
            }
        }
        say(c, `Round ${st.roundIndex ?? k}: done working, waiting for the ladder`);
        return;
    }
    if (h.kind === 'script' || h.kind === 'command') {
        const out = path.join(dir, `r${k}-1.log`);
        let cmd;
        let args;
        if (h.kind === 'script' && typeof h.cmd === 'string') {
            [cmd, ...args] = h.cmd.split(/\s+/).filter(Boolean);
        } else if (h.kind === 'command' && Array.isArray(h.cmd) && h.cmd.length) {
            const promptFile = path.join(dir, `r${k}-1.prompt.md`);
            const prompt = brief(c, { ...clock(), round: k }, { stopAt: new Date(stopAt).toISOString().slice(11, 16) });
            fs.writeFileSync(promptFile, prompt);
            const sub = (x) => x.replaceAll('{prompt_file}', promptFile).replaceAll('{prompt}', prompt).replaceAll('{name}', c.name)
                .replaceAll('{minutes}', String(Math.floor((stopAt - Date.now()) / 60000)));
            [cmd, ...args] = h.cmd.map(sub);
        } else {
            throw new Error(`${c.name}: harness ${JSON.stringify(h)} has no command`);
        }
        log(`${c.name}: round ${k}, running ${cmd} ${args.join(' ')}`);
        const t0 = Date.now();
        const res = await runUntil(cmd, args, { cwd: REPO, env, out, stopAt, tag });
        usage({ session: 1, exit: res.code, signal: res.signal ?? null, stopped: res.stopped, minutes: +((Date.now() - t0) / 60000).toFixed(1), error: res.error });
        saveLogs(c);
        return;
    }
    throw new Error(`${c.name}: harness ${JSON.stringify(h)} cannot run unattended (kind claude-code, script or command)`);
}

/** Copies new or changed files from `from` to `to` (each written whole, then renamed). */
function mirror(from, to) {
    const walk = (rel) => {
        for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
            const r = path.join(rel, e.name);
            if (e.isDirectory()) {
                walk(r);
                continue;
            }
            if (!e.isFile() || e.name.endsWith('.tmp') || e.name === 'referee.lock') {
                continue;
            }
            const a = fs.statSync(path.join(from, r));
            let b = null;
            try {
                b = fs.statSync(path.join(to, r));
            } catch {
                // new
            }
            if (!b || b.size !== a.size || b.mtimeMs < a.mtimeMs) {
                copyWhole(path.join(from, r), path.join(to, r));
            }
        }
    };
    if (fs.existsSync(from)) {
        walk('');
    }
}

async function main() {
    const roster = home.roster();
    const runners = roster.agents.filter((a) => a.harness && (!ONLY || ONLY.includes(a.name)));
    if (!runners.length) {
        throw new Error('no competitor with a harness to run (roster.json agents[].harness)');
    }
    const mi = process.argv.indexOf('--mirror');
    const mirrorPair = mi > 0 ? [path.resolve(process.argv[mi + 1]), path.resolve(process.argv[mi + 2])] : null;
    let lastMirror = 0;
    log(`runner: ${runners.map((a) => a.name).join(', ')}; repo ${REPO}; logs ${LOGS}; $${BUDGET_USD} per competitor per round;`
        + ` usage brake at 5h ${BRAKE.five_hour}, 7d ${BRAKE.seven_day}`);
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        process.on(sig, () => {
            log(`runner: ${sig}, stopping ${[...running.keys()].join(', ') || 'nothing'}`);
            for (const stop of running.values()) {
                stop();
            }
            setTimeout(() => process.exit(1), 16000);
        });
    }
    const anyClaude = runners.some((a) => a.harness.kind === 'claude-code');
    let lastProbe = 0;
    let probing = null;
    const probe = () => {
        lastProbe = Date.now();
        probing ??= probeLimits().catch((e) => log(`usage probe: ${e.message}`)).finally(() => {
            probing = null;
            log(`usage: ${limits ? ['five_hour', 'seven_day'].map((w) => `${w} ${limits[w] ? Math.round(limits[w].utilization * 100) : '?'}%`).join(', ') : 'not reported'}`);
        });
        return probing;
    };
    let lastRound = null;
    const busy = new Set();
    for (;;) {
        if (anyClaude && busy.size && Date.now() - lastProbe > PROBE_MS) {
            probe();
        }
        if (mirrorPair && Date.now() - lastMirror > 60000) {
            lastMirror = Date.now();
            try {
                mirror(...mirrorPair);
            } catch (e) {
                log(`mirror: ${e.message}`);
            }
        }
        const st = clock();
        if (st.phase === 'done' && !busy.size) {
            if (mirrorPair) {
                mirror(...mirrorPair);
            }
            log('runner: the tournament is over');
            return;
        }
        if (st.phase === 'work' && st.round !== lastRound) {
            lastRound = st.round;
            if (anyClaude) {
                await probe();
            }
            for (const c of runners) {
                if (busy.has(c.name)) {
                    log(`${c.name}: still busy from the last round, skipping round ${st.round}`);
                    continue;
                }
                busy.add(c.name);
                work(c, st)
                    .catch((e) => log(`${c.name}: ${e.message}`))
                    .finally(() => busy.delete(c.name));
            }
            if (process.argv.includes('--once')) {
                while (busy.size) {
                    await sleep(POLL_MS);
                }
                if (mirrorPair) {
                    mirror(...mirrorPair);
                }
                return;
            }
        }
        await sleep(POLL_MS);
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message || e);
        process.exit(1);
    });
}

module.exports = { runUntil, cleanEnv, tagged, lastLimits, braked, noteLimits, mirror };
