'use strict';
/**
 * Runs the unattended competitors of a clocked tournament (referee.js --tournament). When a round's work window opens,
 * it starts every competitor's harness with the round's brief (brief.md, filled in), and stops it shortly before the
 * window ends, together with everything it started (evals included).
 *
 *   node bot/arena/runner.js [--only a,b] [--logs <dir>] [--repo <checkout, may contain {name}>] [--memo <path>]
 *                            [--budget-usd 50] [--stop-early-min 2] [--brake-5h 0.8] [--brake-7d 0.95]
 *                            [--mirror <local results> <shared results>] [--backup <dir>] [--once]
 *
 * The harness comes from the competitor's roster entry:
 *   {kind: 'claude-code', model, effort?, memory?: 'optmem'}   headless Claude Code (claude -p) with the arena MCP
 *                                                              server, working in the competitor's own folder
 *   {kind: 'script', cmd: 'node bot/arena/optimizer.js ...'}    a program, run from the repo each round
 *   {kind: 'command', cmd: ['prog', 'arg', '{prompt_file}']}    anything else: {prompt}, {prompt_file}, {name} and
 *                                                              {minutes} are filled in
 * Other kinds (a Codex or human competitor registered on the web page) run themselves; the runner skips them.
 *
 * Claude Code: a session that ends while 5 minutes or more are left is resumed with the time left (a fresh session, with
 * the brief, if the resume fails at once), at most every 5 minutes and up to 12 sessions a round. --budget-usd caps what one competitor may spend in
 * one round over all its sessions (each session gets claude --max-budget-usd = what is left; spend is kept in
 * usage.jsonl, so a restarted runner does not hand out a new budget). It gets only the tools in TOOLS plus the arena MCP
 * server (no subagents, web, schedules or messages to other sessions), no auto-memory and no CLAUDE.md files, and a HOME
 * of its own for each round (<logs>/homes/<name>-r<K>), so nothing carries over between rounds except its folder and
 * NOTES.md. memory 'optmem' adds OptMem (github.com/VictorTaelin/OptMem): `memo` (--memo, default <logs>/../tools/memo,
 * on local disk because the shared folder cannot hold an executable) on its PATH, its memory in <logs>/<name>/memory, and
 * the OptMem block in its system prompt; that memory does carry over.
 *
 * Every harness runs with a clean environment: PATH, locale, NO_PROXY and the certificate settings, ANTHROPIC_BASE_URL,
 * ARENA_HOME and ARENA_DASH, its own HOME and TMPDIR. Nothing else of the runner's environment: no tokens, no session of
 * the Claude Code that started the runner, no proxy (in the cloud container it adds the account's credentials). It runs under `timeout` in its own process group, so the window's end stops it
 * even if this process stalls, and its environment carries ARENA_RUN=<name>-r<round>: whatever it leaves running (an
 * eval in another process group too) is stopped with it, and a restarted runner first stops what an earlier one left.
 * --repo is the checkout competitors see as the repo (evals, reference code): give each one a copy of its own
 * (`{name}` in the path), so a stray edit cannot change the referee's code or another competitor's evals.
 * Logs stay in <logs>/<name>/ (r<K>-<n>.jsonl: claude's stream-json, usage.jsonl) while the tournament runs, where
 * other competitors are not told to look, and are copied to <ARENA_HOME>/logs/<name>/ when it is over. --mirror copies
 * the referee's results from local disk into the shared folder every 60 s from a separate process (each file written
 * whole, then renamed), so the ladder never appends to the synced mount and a stalled mount never delays a stop.
 * --backup <dir> copies what a restart needs from the logs (usage.jsonl, prompts, OptMem memory) there the same way.
 *
 * Usage brake: the competitors share the account's usage limits with everything else on it. The runner reads the
 * limits claude reports (rate_limit_event), from the sessions and from a tiny probe every 10 minutes, and while the
 * 5-hour window is over --brake-5h or the 7-day window over --brake-7d it stops every claude-code competitor and
 * starts none; they go on when the window resets, if their round is still open. Scripts keep running.
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

/** A usage fraction flag: missing or empty gives the default; anything outside (0, 1] is an error, not a brake at 0. */
function limitArg(name, dflt) {
    const v = arg(name, '');
    if (v === '' || v === undefined) {
        return dflt;
    }
    const x = Number(v);
    if (!(x > 0 && x <= 1)) {
        throw new Error(`--${name} must be a fraction in (0, 1], not "${v}"`);
    }
    return x;
}

const REPO = arg('repo', path.join(__dirname, '..', '..'));
const LOGS = path.resolve(arg('logs', path.join(os.homedir(), 'arena-run', 'logs')));
const MEMO = path.resolve(arg('memo', path.join(LOGS, '..', 'tools', 'memo')));
const BUDGET_USD = Number(arg('budget-usd', '50'));
const STOP_EARLY_MS = Number(arg('stop-early-min', '2')) * 60000;
const RESUME_MIN_MS = 5 * 60000;
const MAX_SESSIONS = 12;
const FAST_FAIL_MS = 60000; // a resumed session that ends this fast without a result is retried as a fresh one
const SESSION_GAP_MS = 5 * 60000; // a session that ends sooner is resumed only this long after it started
const POLL_MS = 5000;
const PROBE_MS = 10 * 60000;
const MIRROR_MS = 60000;
const BRAKE = { five_hour: limitArg('brake-5h', 0.8), seven_day: limitArg('brake-7d', 0.95) };
const ONLY = arg('only', null)?.split(',');
// what a harness may see of the runner's environment: what claude needs to reach the API, nothing else. No proxy
// settings: in the cloud container the egress proxy adds the account's credentials (GitHub too), while the API is in
// NO_PROXY and reached directly, so a competitor's shell reaches nothing outside by accident.
const PASS = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE', 'ANTHROPIC_BASE_URL', 'ARENA_DASH'];
// the built-in tools a claude-code harness gets (--tools). No subagents (4 cores are shared by every competitor, and the
// duel compares models, each working alone), no web, schedules, remote triggers or messages to other sessions.
const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'];
// a push to GitHub from a competitor's shell goes nowhere (its repo copy has no remote either)
const GITCONFIG = '[url "https://push-blocked.invalid/"]\n\tpushInsteadOf = https://github.com/\n\tpushInsteadOf = git@github.com:\n\tpushInsteadOf = ssh://git@github.com/\n';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const repoFor = (name) => path.resolve(REPO.replaceAll('{name}', name));

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

function cleanEnv(homeDir, tag) {
    const env = Object.fromEntries(PASS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
    env.HOME = homeDir;
    env.ARENA_HOME = home.HOME;
    env.ARENA_RUN = tag;
    // what a competitor knows comes from its folder, its notes and the brief: no Claude Code memory, no CLAUDE.md from
    // the folders above its own (another competitor could write one there)
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
    // its own temp folder: a tmux or other server it starts lives there, inside its tagged tree
    env.TMPDIR = env.TMUX_TMPDIR = path.join(homeDir, 'tmp');
    fs.mkdirSync(env.TMPDIR, { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.gitconfig'), GITCONFIG);
    return env;
}

/** Processes (other than this one) whose ARENA_RUN satisfies want(value): what harnesses started, in any group. */
function tagged(want) {
    const test = typeof want === 'function' ? want : (v) => v === want;
    const pids = [];
    for (const p of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(p) || Number(p) === process.pid) {
            continue;
        }
        try {
            const v = fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0').find((e) => e.startsWith('ARENA_RUN='));
            if (v && test(v.slice('ARENA_RUN='.length))) {
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

const groupAlive = (pgid) => {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch {
        return false;
    }
};

/** SIGTERM to the group and the tag, up to `graceMs` for them to go, then SIGKILL to whatever is left. */
async function settle(pgid, tag, graceMs) {
    stopAll(pgid, tag, 'SIGTERM');
    const end = Date.now() + graceMs;
    while (Date.now() < end && ((pgid && groupAlive(pgid)) || tagged(tag).length)) {
        await sleep(100);
    }
    stopAll(pgid, tag, 'SIGKILL');
}

// the newest usage limits claude reported: {five_hour: {utilization, resetsAt}, seven_day: ..., status, resetsAt, at}
let limits = null;
const running = new Map(); // tag -> {stop(), claude}: for the brake (claude sessions only) and the runner's own exit

function noteLimits(info) {
    if (!info) {
        return;
    }
    // an event may carry only some windows: the others keep their last reading (braked() ignores a window once it resets)
    limits = { ...(limits ?? {}), ...(info.unifiedWindows ?? {}), status: info.status ?? limits?.status, resetsAt: info.resetsAt ?? null, at: new Date().toISOString() };
    const why = braked();
    const sessions = [...running].filter(([, r]) => r.claude);
    if (why && sessions.length) {
        // scripts use no Claude usage, so they keep their window
        log(`usage brake: ${why}; stopping ${sessions.map(([tag]) => tag).join(', ')}`);
        for (const [, r] of sessions) {
            r.stop();
        }
    }
}

/** Why claude-code competitors must not run now (a usage window over its brake, until it resets), or null. */
function braked(now = Date.now()) {
    if (!limits) {
        return null;
    }
    const until = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 16) : '?');
    if (limits.status === 'rejected' && !(limits.resetsAt && now > limits.resetsAt * 1000)) {
        return `claude reports the account is over its limit until ${until(limits.resetsAt)}`;
    }
    for (const [w, max] of Object.entries(BRAKE)) {
        const u = limits[w];
        if (u && u.utilization >= max && !(u.resetsAt && now > u.resetsAt * 1000)) {
            return `${w} usage ${Math.round(u.utilization * 100)}% >= ${Math.round(max * 100)}% until ${until(u.resetsAt)}`;
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

/**
 * Runs cmd under `timeout` (so the deadline holds even if this process stalls) in its own process group until it exits
 * or `stopAt`. Then it stops the group and every process tagged `tag` (SIGTERM, SIGKILL after a grace period) and only
 * then resolves, so a next session with the same tag never meets a kill meant for this one. While it runs, `running`
 * holds a stop() for it (`claude`: the usage brake may stop it), and tick() (if given) is called every few seconds.
 * Resolves {code, signal, stopped, error}.
 */
function runUntil(cmd, args, { cwd, env, out, stopAt, tag, tick, claude = false }) {
    return new Promise((resolve) => {
        const fd = fs.openSync(out, 'a');
        const secs = Math.max(1, Math.ceil((stopAt - Date.now()) / 1000));
        const child = spawn('timeout', ['-k', '15', String(secs), cmd, ...args], { cwd, env, stdio: ['ignore', fd, fd], detached: true });
        fs.closeSync(fd);
        let stopped = false;
        let killer = null;
        const stop = () => {
            if (!stopped) {
                stopped = true;
                stopAll(child.pid, tag, 'SIGTERM');
                killer = setTimeout(() => stopAll(child.pid, tag, 'SIGKILL'), 15000);
            }
        };
        running.set(tag, { stop, claude });
        const timer = setTimeout(stop, Math.max(0, stopAt - Date.now()));
        const ticker = tick ? setInterval(tick, POLL_MS) : null;
        let once = false;
        const done = async (r) => {
            if (once) {
                return;
            }
            once = true;
            clearTimeout(timer);
            clearInterval(ticker);
            running.delete(tag);
            // whatever it left running (an eval, a server) goes with it, before the next session starts
            await settle(child.pid, tag, 5000);
            clearTimeout(killer);
            tick?.();
            // 124: `timeout` stopped it at the deadline
            resolve({ ...r, stopped: stopped || r.code === 124 });
        };
        child.on('error', (e) => done({ code: null, error: e.message }));
        child.on('exit', (code, signal) => done({ code, signal }));
    });
}

/** Asks claude for one word, only to read the account's current usage limits from its stream. */
async function probeLimits() {
    const dir = path.join(LOGS, '_probe');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'probe.jsonl');
    fs.writeFileSync(out, '');
    await runUntil('claude', ['-p', 'Reply with the single word ok.', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
        '--output-format', 'stream-json', '--verbose', '--max-turns', '1'], { cwd: dir, env: cleanEnv(path.join(dir, 'home'), 'probe'), out, stopAt: Date.now() + 120000, tag: 'probe', claude: true });
    noteLimits(lastLimits(fs.readFileSync(out, 'utf8')));
}

/** The OptMem block for a competitor with memory 'optmem' ('' otherwise); sets up its memory folder the first time. */
function memoryBlock(c, env) {
    if (c.harness?.memory !== 'optmem') {
        return '';
    }
    try {
        fs.accessSync(MEMO, fs.constants.X_OK);
    } catch {
        throw new Error(`${c.name}: memory 'optmem' needs an executable ${MEMO} (github.com/VictorTaelin/OptMem; --memo)`);
    }
    env.MEMORY_DIR = path.join(LOGS, c.name, 'memory');
    env.PATH = `${path.dirname(MEMO)}:${env.PATH}`;
    // init is safe to repeat: it only creates what is missing, and prints the block to put in the agent's instructions
    const out = execFileSync(path.basename(MEMO), ['init'], { env, encoding: 'utf8' });
    const i = out.indexOf('## Memory');
    if (i < 0) {
        throw new Error(`${c.name}: memo init printed no setup block`);
    }
    return out.slice(i);
}

function brief(c, st, extra) {
    const repo = repoFor(c.name);
    return fill(fs.readFileSync(path.join(__dirname, 'brief.md'), 'utf8'), {
        name: c.name, title: c.title ?? c.name, tournament: st.tournament?.title ?? 'Arena tournament', round: st.roundIndex ?? st.round,
        rounds: st.plannedRounds ?? '?', deadline: st.deadline, minutes: st.minutesLeft, agentDir: path.join(home.AGENTS, c.name), repo,
        capSeconds: home.roster().thinkCapMs / 1000, memory: c.harness?.memory === 'optmem' ? '\nYour memory across rounds is OptMem as well as NOTES.md (see your system prompt).\n' : ''
    }) + `\nThis session runs in ${path.join(home.AGENTS, c.name)} and is stopped at ${extra.stopAt} (UTC), ${Math.round(STOP_EARLY_MS / 60000)} minutes`
        + ' before the window ends: submit and update NOTES.md before then. Anything you leave running when your session'
        + ` ends is stopped. Your harness may also stop you if you reach this round's budget. Run evals from ${repo} (cd there first).\n`
        + (extra.again ? '\nThis round is already under way: an earlier session of yours this round has ended. Your folder, NOTES.md and arena_versions show where you are.\n' : '');
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

/**
 * What one claude run reported: session id, total_cost_usd (for the whole session so far: a resumed session counts its
 * earlier runs too), turns and result subtype (null fields when it ended without a result).
 */
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

/** What a competitor already spent in round k (usage.jsonl), so a restarted runner keeps the round's budget. */
function spentIn(dir, k) {
    try {
        return fs.readFileSync(path.join(dir, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
            .filter((u) => u.round === k).reduce((s, u) => s + (u.costUSD ?? 0), 0);
    } catch {
        return 0;
    }
}

/** When the tournament is over: every competitor's transcripts, prompts, usage and memory into <ARENA_HOME>/logs. */
function publishLogs(runners) {
    for (const c of runners) {
        const src = path.join(LOGS, c.name);
        if (!fs.existsSync(src)) {
            continue;
        }
        const errors = mirror(src, path.join(home.HOME, 'logs', c.name), (rel) => !/^mcp\.json$/.test(rel));
        log(`${c.name}: logs copied to ${path.join(home.HOME, 'logs', c.name)}${errors ? ` (${errors} files failed)` : ''}`);
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
    const usage = (u) => fs.appendFileSync(path.join(dir, 'usage.jsonl'), `${JSON.stringify({ round: k, at: new Date().toISOString(), ...u })}\n`);
    if (Date.now() > stopAt - 60000) {
        log(`${c.name}: round ${k} window is nearly over, skipping it`);
        return;
    }
    if (h.kind === 'claude-code') {
        const env = cleanEnv(path.join(LOGS, 'homes', `${c.name}-r${k}`), tag);
        const memory = memoryBlock(c, env);
        let spent = spentIn(dir, k);
        let sessionId = null;
        let sessionTotal = 0;
        let started = spent > 0;
        const done = new Set(fs.readdirSync(dir).filter((f) => f.startsWith(`r${k}-`)));
        for (let n = 1; n <= MAX_SESSIONS; n++) {
            let waiting = false;
            while (braked() && stopAt - Date.now() >= RESUME_MIN_MS) {
                if (!waiting) {
                    waiting = true;
                    log(`${c.name}: waiting: usage brake (${braked()})`);
                    usage({ waiting: `usage brake: ${braked()}` });
                }
                await sleep(POLL_MS * 6);
            }
            const left = stopAt - Date.now();
            const budget = BUDGET_USD - spent;
            if (braked() || left < (started ? RESUME_MIN_MS : 60000) || budget < 0.5) {
                break;
            }
            const minutes = Math.floor(left / 60000);
            const stopText = new Date(stopAt).toISOString().slice(11, 16);
            const prompt = !sessionId
                ? brief(c, { ...clock(), round: k }, { stopAt: stopText, again: started })
                : `Round ${st.roundIndex ?? k} is still open: ${minutes} minutes are left before you are stopped at ${stopText} UTC. Anything you left running when your last session ended (an eval) was stopped. Keep improving your bot: test the next idea against your last version and the baselines, submit when it is better, post a thought with arena_say, and keep NOTES.md current.`;
            let m = n;
            while (done.has(`r${k}-${m}.jsonl`)) {
                m++; // a restarted runner numbers on from the sessions already logged this round
            }
            done.add(`r${k}-${m}.jsonl`);
            const out = path.join(dir, `r${k}-${m}.jsonl`);
            fs.writeFileSync(path.join(dir, `r${k}-${m}.prompt.md`), prompt);
            log(`${c.name}: round ${k} session ${m}${sessionId ? ' (resumed)' : ''}, ${minutes} min, budget $${budget.toFixed(2)}`);
            say(c, !started ? `Round ${st.roundIndex ?? k}: working until ${stopText} UTC` : `Round ${st.roundIndex ?? k}: back to work (${minutes} min left)`);
            started = true;
            const t0 = Date.now();
            const follow = follower(out);
            const resumed = sessionId;
            const res = await runUntil('claude', claudeArgs(c, prompt, { sessionId, budget, system: memory || null }),
                { cwd: path.join(home.AGENTS, c.name), env, out, stopAt, tag, claude: true, tick: () => noteLimits(lastLimits(follow())) });
            const s = readSession(out);
            // total_cost_usd covers the whole session, earlier runs of a resumed one included: count only what is new
            const cost = Math.max(0, s.sessionId && s.sessionId === resumed ? s.costUSD - sessionTotal : s.costUSD);
            spent += cost;
            if (s.sessionId) {
                sessionTotal = s.sessionId === resumed ? Math.max(sessionTotal, s.costUSD) : s.costUSD;
                sessionId = s.sessionId;
            }
            const brakeStop = res.stopped && !!braked();
            usage({ session: m, sessionId: s.sessionId, resumed: !!resumed, exit: res.code, signal: res.signal ?? null, stopped: res.stopped, brake: brakeStop,
                minutes: +((Date.now() - t0) / 60000).toFixed(1), costUSD: +cost.toFixed(4), turns: s.turns, result: s.result, error: res.error });
            log(`${c.name}: session ${m} ended (${res.stopped ? (brakeStop ? 'stopped by the usage brake' : 'stopped at the deadline') : `exit ${res.code ?? res.signal}`}${s.result ? `, ${s.result}` : ''}), $${cost.toFixed(2)}, $${spent.toFixed(2)} this round`);
            if (res.stopped && !brakeStop) {
                break;
            }
            if (s.result === 'error_max_budget_usd') {
                break;
            }
            if (resumed && !s.result && Date.now() - t0 < FAST_FAIL_MS) {
                // the resume itself failed: start a fresh session with the brief next time, after a pause
                log(`${c.name}: the resumed session ended at once without a result, next one starts fresh`);
                sessionId = null;
                sessionTotal = 0;
                await sleep(30000);
            } else if (!s.sessionId) {
                await sleep(30000);
            } else if (Date.now() - t0 < SESSION_GAP_MS) {
                // it chose to stop: ask again later (its queued evals may be done by then), not every few seconds
                await sleep(Math.max(0, Math.min(t0 + SESSION_GAP_MS - Date.now(), stopAt - RESUME_MIN_MS - Date.now())));
            }
        }
        say(c, `Round ${st.roundIndex ?? k}: done working, waiting for the ladder`);
        return;
    }
    if (h.kind === 'script' || h.kind === 'command') {
        const env = cleanEnv(path.join(LOGS, 'homes', c.name), tag);
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
        const res = await runUntil(cmd, args, { cwd: repoFor(c.name), env, out, stopAt, tag });
        usage({ session: 1, exit: res.code, signal: res.signal ?? null, stopped: res.stopped, minutes: +((Date.now() - t0) / 60000).toFixed(1), error: res.error });
        return;
    }
    throw new Error(`${c.name}: harness ${JSON.stringify(h)} cannot run unattended (kind claude-code, script or command)`);
}

/**
 * Copies new or changed files from `from` to `to` (each written whole, then renamed; keep(rel) filters). A file that
 * fails is skipped (and counted), so one bad file never stops the rest. Returns the number of failures.
 */
function mirror(from, to, keep = () => true) {
    let errors = 0;
    const walk = (rel) => {
        let entries = [];
        try {
            entries = fs.readdirSync(path.join(from, rel), { withFileTypes: true });
        } catch {
            errors++;
            return;
        }
        for (const e of entries) {
            const r = path.join(rel, e.name);
            if (e.isDirectory()) {
                walk(r);
                continue;
            }
            if (!e.isFile() || e.name.endsWith('.tmp') || e.name === 'referee.lock' || !keep(r)) {
                continue;
            }
            try {
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
            } catch {
                errors++;
            }
        }
    };
    if (fs.existsSync(from)) {
        walk('');
    }
    return errors;
}

// what --backup keeps of the logs: small files a restart needs (spend, prompts, OptMem memory), not the transcripts
const BACKUP_KEEP = (rel) => !/^(homes|_probe)\//.test(rel) && /(^|\/)usage\.jsonl$|\.prompt\.md$|\/memory\//.test(rel);

/** --mirror-loop: the separate process that mirrors results (--mirror) and backs up logs (--backup) until the end. */
async function mirrorLoop() {
    const mi = process.argv.indexOf('--mirror');
    const pair = mi > 0 ? [path.resolve(process.argv[mi + 1]), path.resolve(process.argv[mi + 2])] : null;
    const backup = arg('backup', null);
    // the runner that started it went away (killed, crashed): a new runner starts its own mirror
    process.on('disconnect', () => process.exit(0));
    for (;;) {
        const done = clock().phase === 'done';
        const errors = (pair ? mirror(...pair) : 0) + (backup ? mirror(LOGS, path.resolve(backup), BACKUP_KEEP) : 0);
        if (errors) {
            log(`mirror: ${errors} files failed, retrying in ${MIRROR_MS / 1000} s`);
        }
        if (done) {
            process.disconnect?.(); // the IPC channel would keep this process alive
            return;
        }
        await sleep(MIRROR_MS);
    }
}

/** Whether the runner can start this harness: claude-code, a script with a command line, or a command array. */
function runnable(h) {
    return h?.kind === 'claude-code' || (h?.kind === 'script' && typeof h.cmd === 'string' && h.cmd.trim() !== '')
        || (h?.kind === 'command' && Array.isArray(h.cmd) && h.cmd.length > 0);
}

async function main() {
    if (process.argv.includes('--mirror-loop')) {
        return mirrorLoop();
    }
    const roster = home.roster();
    const chosen = roster.agents.filter((a) => a.harness && (!ONLY || ONLY.includes(a.name)));
    for (const a of chosen.filter((x) => !runnable(x.harness))) {
        // e.g. a Codex or human competitor registered through the web form: it runs itself
        log(`${a.name}: harness ${JSON.stringify(a.harness)} is not one the runner starts (claude-code, script with cmd, command), skipping it`);
    }
    const runners = chosen.filter((a) => runnable(a.harness));
    if (!runners.length) {
        throw new Error('no competitor with a harness the runner can start (roster.json agents[].harness)');
    }
    for (const c of runners) {
        const r = repoFor(c.name);
        if (!fs.existsSync(path.join(r, 'bot', 'arena', 'eval.js'))) {
            throw new Error(`${c.name}: no checkout at ${r} (--repo)`);
        }
    }
    log(`runner: ${runners.map((a) => a.name).join(', ')}; repo ${REPO}; logs ${LOGS}; $${BUDGET_USD} per competitor per round;`
        + ` usage brake at 5h ${BRAKE.five_hour}, 7d ${BRAKE.seven_day}`);
    // what an earlier runner left running (it crashed, or was killed) has no deadline any more
    const left = tagged(() => true);
    if (left.length) {
        log(`runner: stopping ${left.length} processes an earlier runner left`);
        await settle(null, () => true, 10000);
    }
    let mirrorChild = null;
    const mi = process.argv.indexOf('--mirror');
    if (mi > 0 || arg('backup', null)) {
        mirrorChild = spawn(process.execPath, [__filename, '--mirror-loop', '--logs', LOGS, ...(mi > 0 ? ['--mirror', process.argv[mi + 1], process.argv[mi + 2]] : []),
            ...(arg('backup', null) ? ['--backup', arg('backup')] : [])], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    }
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        process.on(sig, () => {
            log(`runner: ${sig}, stopping ${[...running.keys()].join(', ') || 'nothing'}`);
            for (const r of running.values()) {
                r.stop();
            }
            mirrorChild?.kill('SIGTERM');
            setTimeout(() => {
                stopAll(null, () => true, 'SIGKILL');
                process.exit(1);
            }, 15000);
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
        const st = clock();
        if (st.phase === 'done' && !busy.size) {
            publishLogs(runners);
            log('runner: the tournament is over');
            await new Promise((res) => (mirrorChild && mirrorChild.exitCode === null ? mirrorChild.on('exit', res) : res()));
            return;
        }
        if (st.phase === 'work' && st.round !== lastRound) {
            lastRound = st.round;
            // scripts start at once; Claude Code competitors first read the account's usage (the probe)
            const order = [...runners].sort((a, b) => (a.harness.kind === 'claude-code') - (b.harness.kind === 'claude-code'));
            let probed = false;
            for (const c of order) {
                if (anyClaude && !probed && c.harness.kind === 'claude-code') {
                    probed = true;
                    await probe();
                }
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
                mirrorChild?.kill('SIGTERM');
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

module.exports = { runUntil, cleanEnv, tagged, lastLimits, braked, noteLimits, mirror, runnable, running, settle };
