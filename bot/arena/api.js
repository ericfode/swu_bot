'use strict';
/**
 * Arena API: the tournament layer every competitor uses, whatever its harness. One implementation, exposed three
 * ways with the same method names and JSON shapes:
 *   server.js  HTTP:  POST /api/<method> with a JSON body  (scripts, optimizers, a hosted arena later)
 *   mcp.js     MCP:   tool arena_<method>                  (Claude Code, Codex and other LLM harnesses)
 *   cli.js     CLI:   node bot/arena/cli.js <method> '{json}'
 * Storage is ARENA_HOME (see home.js): the project's shared folder, so every thread's container sees the same arena.
 * How a bot plays a game (observations, actions, timing) is not defined here: a submitted bot is a JS folder whose
 * createBot returns a native bot or a protocol client (spec/bot-interface.md), or a bot program (spec/protocol.md).
 *
 * Methods (args -> result):
 *   status {}                                   tournament, current round (+ roundIndex of plannedRounds) + phase +
 *                                               deadline, competitors
 *   register {name, title?, philosophy?, start?, harness?, owner?}   create a competitor (starter bot, v0 submitted)
 *   submit {name, note, bot?}                   freeze the live bot as the next version; bot = {kind:'js'} (default:
 *                                               agents/<name>/) or {kind:'stdio', cmd, args?}: the folder is frozen either way and a stdio cmd
 *                                               runs in it. bot.files (text) is laid over the folder first. A JS bot must load
 *                                               (require bot.js, createBot) or the submit fails with code bad_bot.
 *   versions {name}                             submitted versions with notes
 *   standings {}                                every rated round so far, all-round Elo
 *   report {round?}                             a round's markdown report (default: latest)
 *   say {name, text?, now?, idea?, plan?, diagram?}  post thoughts (and a strategy diagram, strategy.js) to the live panel
 *   send {to, text, from?}                      leave a message in a competitor's inbox ("all" = everyone)
 *   inbox {name, since?}                        messages for a competitor, oldest first
 *   eval {name, vs?, seeds?, version?}          queue test games on the server (for clients without the engine)
 *   eval_result {id}                            queued / running / done with results
 *   wait {timeoutSec?, round?}                  long-poll until a round's work window is open (status started /
 *                                               waiting / done)
 * A remote client submits its code with submit {bot: {kind:'js', files: {"bot.js": "...", ...}}}.
 * Server-side callers (the referee) message competitors with notify(), which is not a method: no client can call it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const home = require('./home');
const dash = require('./dash');
const { botSource, STARTS } = require('./starters');
const { validateDiagram } = require('./strategy');

const NAME = /^[a-z][a-z0-9_]{0,31}$/;
// Hosted arenas set ARENA_AUTH=1: then changing a competitor (submit, say, eval, inbox) needs the token register
// returned, and messaging everyone needs ARENA_ADMIN_TOKEN. In the project's shared folder it is off.
const AUTH = process.env.ARENA_AUTH === '1';
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const TOURNAMENT = () => path.join(home.HOME, 'tournament.json');
const INBOX = (n) => path.join(home.HOME, 'inbox', `${n}.jsonl`);
// error codes a client may see; anything else is reported as 'internal'
const CODES = new Set(['bad_request', 'unauthorized', 'not_found', 'conflict', 'bad_bot', 'unsupported']);
const LOAD_CHECK_MS = 30000;

class ArenaError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function need(cond, code, msg) {
    if (!cond) {
        throw new ArenaError(code, msg);
    }
}

// bot/players pulls in the engine wrapper (~1 s), and mcp.js --remote must work without the engine: load it on use
const describeBot = (name) => require('../players').describeBot(name);

/** An integer argument that may arrive as a string (query strings, shells); anything else is returned unchanged. */
const int = (v) => (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v);

function competitor(name) {
    const c = home.roster().agents.find((a) => a.name === name);
    need(c, 'not_found', `no competitor "${name}" (see status)`);
    return c;
}

/** The competitor, checked against its token when the arena requires tokens. */
function owned(name, token) {
    const c = competitor(name);
    if (AUTH) {
        const admin = process.env.ARENA_ADMIN_TOKEN && token === process.env.ARENA_ADMIN_TOKEN;
        need(admin || (c.tokenHash && token && hash(token) === c.tokenHash), 'unauthorized', `wrong or missing token for "${name}"`);
    }
    return c;
}

/**
 * Where the tournament clock stands: phase is 'work', 'ladder', 'done' or 'idle' (no tournament running). round is the
 * current round's number (they continue across tournaments), roundIndex its 1-based position in this tournament.
 */
function clock(now = Date.now()) {
    const t = home.readJson(TOURNAMENT(), null);
    if (!t) {
        return { tournament: null, round: null, roundIndex: null, plannedRounds: null, phase: 'idle', deadline: null, minutesLeft: null };
    }
    const cur = t.rounds?.[t.rounds.length - 1] ?? null;
    const phase = t.state === 'done' ? 'done' : cur?.ladderStart && !cur?.ladderEnd ? 'ladder' : 'work';
    const deadline = phase === 'work' && cur ? cur.workEnd : null;
    return { tournament: { id: t.id, title: t.title, rounds: t.plannedRounds, roundMinutes: t.roundMinutes, task: t.task ?? null }, round: cur?.n ?? null,
             roundIndex: cur ? t.rounds.length : null, plannedRounds: t.plannedRounds ?? null, phase, deadline,
             minutesLeft: deadline ? Math.max(0, Math.round((Date.parse(deadline) - now) / 60000)) : null };
}

/**
 * Inbox messages from server-side callers (the referee): to = a competitor, a list of them or "all". No auth check, and
 * deliberately not an api method (nor in METHODS), so no HTTP, MCP or CLI client can call it.
 */
function notify({ to, from = 'referee', text } = {}) {
    need(typeof text === 'string' && text.trim(), 'bad_request', 'text is required');
    const targets = to === 'all' ? home.roster().agents.map((a) => a.name) : (Array.isArray(to) ? to : [to]).map((n) => competitor(n).name);
    const msg = { t: new Date().toISOString(), from: String(from), text: text.trim() };
    for (const n of targets) {
        home.appendJsonl(INBOX(n), msg);
    }
    return { delivered: targets };
}

// Runs in a child process: a bot that fails to load, loops at load time or exits must not take the server down.
// Errors from require and createBot are left uncaught, so node prints them with file, line and caret.
const LOAD_CHECK = `
const [file, name] = process.argv.slice(1);
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
const m = require(file);
if (typeof m?.createBot !== 'function') fail('bot.js must export createBot(name)');
const bot = m.createBot(name);
if (!bot || (typeof bot.choose !== 'function' && typeof bot.decide !== 'function')) fail('createBot(name) must return an object with a choose() method (native bot) or a decide() method (protocol client)');
process.exit(0);
`;

/** Throws bad_bot unless dir/bot.js loads and createBot returns a bot. Paths in the error read as `shownAs`. */
function loadCheck(dir, version, shownAs) {
    const r = spawnSync(process.execPath, ['-e', LOAD_CHECK, path.join(dir, 'bot.js'), version], {
        // submitted code must not see the arena's secrets
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/TOKEN|SECRET|KEY|PASSWORD|AUTH/i.test(k))), ARENA_HOME: home.HOME }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: LOAD_CHECK_MS, killSignal: 'SIGKILL'
    });
    if (r.status === 0) {
        return;
    }
    const why = r.error?.code === 'ETIMEDOUT' ? `took more than ${LOAD_CHECK_MS / 1000} s` : r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit code ${r.status}`;
    const lines = String(r.stderr ?? '').split(dir).join(shownAs).split('\n').filter((l) => l.trim()).slice(0, 8);
    throw new ArenaError('bad_bot', `${version} failed the load check (require bot.js, call createBot): ${why}${lines.length ? `\n${lines.join('\n')}` : ''}`);
}

/** Whether `o` may be an eval opponent: a built-in bot, a baseline, or an existing <agent>-v<N> of any competitor. */
function opponentOk(o) {
    if (typeof o !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(o)) {
        return false;
    }
    const r = home.roster();
    if (r.baselines.includes(o)) {
        return true;
    }
    const v = /^([a-z][a-z0-9_]*)-v(\d+)$/.exec(o);
    if (v && r.agents.some((a) => a.name === v[1])) {
        return home.versionsOf(v[1]).includes(Number(v[2]));
    }
    const info = describeBot(o);
    return !!info && info.kind !== 'arena';
}

const api = {
    status() {
        const r = home.roster();
        const st = home.readJson(path.join(home.HOME, 'standings.json'), { rounds: [], global: {} });
        return {
            ...clock(),
            thinkCapMs: r.thinkCapMs,
            baselines: r.baselines,
            competitors: r.agents.map((a) => ({
                name: a.name, title: a.title, harness: a.harness ?? null, owner: a.owner ?? null, philosophy: a.philosophy ?? '',
                latest: (() => { const v = home.versionsOf(a.name).pop(); return v === undefined ? null : `${a.name}-v${v}`; })(),
                elo: (() => { const v = home.versionsOf(a.name).pop(); return v === undefined ? null : st.global?.[`${a.name}-v${v}`] ?? null; })()
            }))
        };
    },

    register({ name, title, philosophy, start = 'heuristic', harness = null, owner = null } = {}) {
        need(NAME.test(name ?? ''), 'bad_request', 'name: 1-32 chars, lowercase letters, digits, _; starts with a letter');
        need(STARTS.includes(start), 'bad_request', `start: one of ${STARTS.join(', ')}`);
        need(!home.roster().baselines.includes(name), 'conflict', `"${name}" is a baseline bot name`);
        const builtin = describeBot(name);
        need(!builtin || builtin.kind === 'arena', 'conflict', `"${name}" is the name of a built-in bot (see bot/players/index.js); pick another name`);
        const dir = path.join(home.AGENTS, name);
        need(home.claimDir(dir), 'conflict', `competitor "${name}" already exists`);
        for (const f of ['heuristic.js', 'rush.js']) {
            fs.copyFileSync(path.join(__dirname, 'starters', f), path.join(dir, f));
        }
        fs.writeFileSync(path.join(dir, 'bot.js'), botSource(start));
        fs.writeFileSync(path.join(dir, 'NOTES.md'), `# ${name} notes\n\nWhat you tried, what you measured, what you plan next. Read this first when you come back.\n`);
        const token = crypto.randomBytes(18).toString('base64url');
        const entry = { name, title: title ?? name, start, philosophy: philosophy ?? '', harness, owner, tokenHash: hash(token), registeredAt: new Date().toISOString() };
        home.updateRoster((r) => ({ ...r, agents: [...r.agents.filter((a) => a.name !== name), entry] }));
        let v;
        try {
            v = api.submit({ name, note: `starting strategy: ${start}`, token });
        } catch (e) {
            // no token was handed out, so undo the registration: the name can be registered again
            home.updateRoster((r) => ({ ...r, agents: r.agents.filter((a) => a.name !== name) }));
            home.removeDir(dir);
            throw e;
        }
        dash.updatePanel(name, { now: 'Registered', status: 'running' });
        return { name, dir, version: v.version, token, tokenNote: 'Keep this token; it is shown once. Pass it as `token` to submit, say, eval and inbox on a hosted arena.' };
    },

    submit({ name, note, bot = { kind: 'js' }, token } = {}) {
        // Atomic: the version is assembled and load-checked in versions/.staging-*, then renamed into place in one step,
        // so the referee never sees a half-copied or unloadable version.
        owned(name, token);
        need(typeof note === 'string' && note.trim(), 'bad_request', 'note: one line saying what changed and why');
        need(bot && typeof bot === 'object' && ['js', 'stdio'].includes(bot.kind), 'bad_request', "bot.kind: 'js' or 'stdio'");
        const live = path.join(home.AGENTS, name);
        let upload = null;
        if (bot.kind === 'stdio') {
            // the program is frozen with the version: cmd is a file in the folder (./bot) or a program on PATH (python3),
            // and it runs in the version's folder, so editing the live folder later cannot change a submitted version
            need(typeof bot.cmd === 'string' && bot.cmd && !path.isAbsolute(bot.cmd) && !bot.cmd.split(/[\\/]/).includes('..'), 'bad_request',
                'bot.cmd: the program to run (spec/protocol.md), a path inside your folder (./my-bot) or a program on PATH (python3); it runs in your submitted folder');
            // an argument may not name a file outside the folder either (/abs/live/bot.py would read the live copy)
            const inside = (a) => a.split('=').every((p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..'));
            need(bot.args === undefined || (Array.isArray(bot.args) && bot.args.every((a) => typeof a === 'string' && inside(a))), 'bad_request',
                'bot.args: a list of strings; file arguments are paths inside your folder (no absolute paths, no ..)');
            need(bot.cwd === undefined, 'bad_request', 'bot.cwd: not allowed; the program runs in your submitted folder');
        }
        if (bot.files !== undefined) {
            // remote clients upload their bot as text files: {"bot.js": "...", "lib/x.js": "..."} on top of the live folder's files
            need(bot.files && typeof bot.files === 'object' && !Array.isArray(bot.files) && (bot.kind === 'stdio' || typeof bot.files['bot.js'] === 'string'), 'bad_request', 'bot.files must include "bot.js"');
            upload = Object.entries(bot.files).map(([rel, text]) => {
                const f = path.resolve(live, rel);
                const ok = f.startsWith(live + path.sep) && typeof text === 'string' && !path.relative(live, f).split(path.sep).some((p) => p === '.git' || p === 'node_modules');
                need(ok, 'bad_request', `bad file path ${rel}`);
                return [path.relative(live, f), text];
            });
        }
        const { files, ...botMeta } = bot;
        const round = clock().round;
        // stamped just before the version is renamed into place, after its load check: a submit that finishes after the
        // round's deadline is late (lineup() rates it next round), however early it started
        const meta = (n) => ({ name: `${name}-v${n}`, agent: name, version: n, note: note.trim(), bot: botMeta, files: files ? Object.keys(files) : undefined,
                               submittedAt: new Date().toISOString(), round, checked: bot.kind === 'js' });
        const staging = home.stagingDir(name);
        try {
            if (home.exists(live)) {
                try {
                    home.copyBot(live, staging);
                } catch (e) {
                    throw new ArenaError('bad_bot', `could not copy ${live}: ${e.message}`);
                }
            }
            if (upload) {
                home.writeFiles(staging, upload);
            }
            if (bot.kind === 'js') {
                need(home.exists(path.join(staging, 'bot.js')), 'bad_request', `no bot.js in ${live}`);
            } else if (/[\\/]/.test(bot.cmd)) {
                need(home.exists(path.join(staging, bot.cmd)), 'bad_request', `bot.cmd ${bot.cmd} is not in your folder`);
            }
            let n = (home.versionsOf(name).pop() ?? -1) + 1;
            if (bot.kind === 'js') {
                loadCheck(staging, `${name}-v${n}`, upload ? `(uploaded) ${name}` : live);
            }
            // a concurrent submit may take the number first: then take the next free one (and load-check under that
            // name, since createBot gets the version name)
            for (let retry = 0; ; retry++) {
                home.writeJson(path.join(staging, 'SUBMISSION.json'), meta(n));
                if (home.promote(staging, path.join(home.VERSIONS, `${name}-v${n}`))) {
                    break;
                }
                need(retry < 5, 'conflict', 'too many concurrent submits; submit again');
                n = Math.max(n + 1, (home.versionsOf(name).pop() ?? -1) + 1);
                if (bot.kind === 'js') {
                    loadCheck(staging, `${name}-v${n}`, upload ? `(uploaded) ${name}` : live);
                }
            }
            if (upload) {
                // the live folder follows what was uploaded, so eval of the live bot plays it; only the newest version
                // may write it, so a slower concurrent submit cannot overwrite a newer one. It becomes a copy of that
                // version, not the live folder plus this upload: a concurrent submit may have written the live folder
                // after this one copied it.
                home.withLock(path.join(home.HOME, 'locks', `live-${name}.lock`), () => {
                    if ((home.versionsOf(name).pop() ?? -1) === n) {
                        home.mirror(path.join(home.VERSIONS, `${name}-v${n}`), live);
                    }
                });
            }
            return { version: `${name}-v${n}`, round };
        } finally {
            home.removeDir(staging); // gone already when promoted
        }
    },

    versions({ name } = {}) {
        competitor(name);
        return home.versionsOf(name).map((n) => home.readJson(path.join(home.VERSIONS, `${name}-v${n}`, 'SUBMISSION.json'), { name: `${name}-v${n}` }));
    },

    standings() {
        return home.readJson(path.join(home.HOME, 'standings.json'), { rounds: [], global: {} });
    },

    report({ round } = {}) {
        const dir = path.join(home.HOME, 'rounds');
        const all = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => /^r(\d+)\.md$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b) : [];
        const k = Number(int(round ?? all[all.length - 1]));
        need(Number.isInteger(k) && all.includes(k), 'not_found', 'no round report yet');
        return { round: k, markdown: fs.readFileSync(path.join(dir, `r${k}.md`), 'utf8') };
    },

    say({ name, text, now, idea, plan, diagram, token } = {}) {
        owned(name, token);
        const p = Array.isArray(plan) ? plan.map((x) => (typeof x === 'string' ? { text: x, state: 'todo' } : x)) : undefined;
        dash.updatePanel(name, { thought: text, now, idea, plan: p, diagram: diagram ? validateDiagram(diagram) : undefined });
        return { ok: true };
    },

    send({ to, text, from, token } = {}) {
        need(typeof text === 'string' && text.trim(), 'bad_request', 'text is required');
        need(typeof to === 'string' && to, 'bad_request', 'to: a competitor name or "all"');
        if (AUTH && !(process.env.ARENA_ADMIN_TOKEN && token === process.env.ARENA_ADMIN_TOKEN)) {
            // a competitor's token sends as that competitor (from may be left out), to one competitor
            from ??= home.roster().agents.find((a) => a.tokenHash && token && hash(token) === a.tokenHash)?.name;
            need(from && from !== 'eric' && to !== 'all', 'unauthorized', 'messages need the admin token, or your own token (they are sent as you, to one competitor)');
            owned(from, token);
        }
        return notify({ to, from: from ?? 'eric', text });
    },

    eval({ name, vs = ['rush', 'heuristic'], seeds = 2, version, token } = {}) {
        owned(name, token);
        const opps = typeof vs === 'string' ? vs.split(',').map((s) => s.trim()).filter(Boolean) : vs;
        need(Array.isArray(opps) && opps.length >= 1 && opps.length <= 6, 'bad_request', 'vs: 1-6 opponent names');
        for (const o of opps) {
            need(opponentOk(o), 'bad_request', `vs: "${o}" is not a built-in bot (rush, heuristic, aggro, tempo, control, random), a baseline or an existing <agent>-v<N>`);
        }
        const k = int(seeds);
        need(Number.isInteger(k) && k >= 1 && k <= 10, 'bad_request', 'seeds: an integer 1-10 (each played from both seats)');
        let bot = name;
        if (version !== undefined && version !== null) {
            const v = int(version);
            need(Number.isInteger(v) && v >= 0, 'bad_request', 'version: your version number N (an integer >= 0), to test <name>-v<N> instead of your live bot');
            need(home.versionsOf(name).includes(v), 'not_found', `no version ${v} of "${name}" (see versions)`);
            bot = `${name}-v${v}`;
        }
        // one eval at a time per competitor, so nobody can fill the queue the referee plays in order
        const qdir = path.join(home.HOME, 'queue');
        const mine = fs.existsSync(qdir) ? fs.readdirSync(qdir).filter((f) => f.endsWith('.json')).map((f) => home.readJson(path.join(qdir, f), null))
            .filter((j) => j && (j.state === 'queued' || j.state === 'running') && (j.bot === name || j.bot.startsWith(`${name}-v`))) : [];
        need(!mine.length, 'conflict', `eval ${mine[0]?.id} is still ${mine[0]?.state}: one eval at a time per competitor (poll eval_result)`);
        const id = `${bot}-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`.replace(/[^a-z0-9_-]/g, '');
        home.writeJson(path.join(home.HOME, 'queue', `${id}.json`), { id, bot, vs: opps, seeds: k, state: 'queued', queuedAt: new Date().toISOString() });
        return { id, state: 'queued', note: 'the referee plays queued evals between ladders; poll eval_result' };
    },

    eval_result({ id } = {}) {
        const safe = String(id ?? '').replace(/[^a-z0-9_-]/g, '');
        need(safe, 'bad_request', 'id: the id eval returned');
        const j = home.readJson(path.join(home.HOME, 'queue', `${safe}.json`), null);
        need(j, 'not_found', `no eval "${safe}"`);
        return j;
    },

    panel({ name } = {}) {
        competitor(name);
        // composed from the halves kept in ARENA_HOME, so it works without the research dashboard folder
        return dash.composePanel(name);
    },

    games({ round } = {}) {
        const st = api.standings();
        const k = int(round ?? st.rounds[st.rounds.length - 1]?.round);
        need(k !== undefined, 'not_found', 'no rounds yet');
        need(Number.isInteger(k) && k >= 0, 'bad_request', 'round: an integer');
        const idx = home.readJson(path.join(home.RESULTS, `arena-r${k}`, 'index.json'), null);
        need(idx, 'not_found', `no games for round ${k}`);
        return { round: k, replayBase: `replays/arena-r${k}/games/`, games: idx.games };
    },

    async wait({ timeoutSec = 45, round } = {}) {
        // Long-poll for a work window. Without `round` it returns at once when a window is open now; with it, when the
        // window of a round after `round` opens. Otherwise after timeoutSec (max 200, so MCP and HTTP clients do not time
        // out first) with status 'waiting', or at once with 'done' when the tournament is over.
        const secs = Math.min(200, Math.max(1, Number.isFinite(Number(timeoutSec)) ? Number(timeoutSec) : 45));
        const r = int(round);
        need(r === undefined || r === null || Number.isInteger(r), 'bad_request', 'round: an integer');
        const start = clock();
        const after = r ?? (start.phase === 'work' ? start.round - 1 : start.round ?? -1);
        const until = Date.now() + secs * 1000;
        for (;;) {
            const c = clock();
            if (c.phase === 'work' && c.round > after) {
                return { status: 'started', started: true, ...api.status() };
            }
            if (c.phase === 'done') {
                return { status: 'done', started: false, ...api.status() };
            }
            if (Date.now() >= until) {
                return { status: 'waiting', started: false, ...api.status() };
            }
            await new Promise((res) => setTimeout(res, Math.min(2000, Math.max(10, until - Date.now()))));
        }
    },

    inbox({ name, since, token } = {}) {
        owned(name, token);
        const all = home.readJsonl(INBOX(name));
        return { messages: since ? all.filter((m) => typeof m?.t === 'string' && m.t > since) : all };
    }
};

/** Calls a method by name with an args object; resolves {result} or {error: {code, message}}. */
async function call(method, args = {}) {
    if (!Object.prototype.hasOwnProperty.call(METHODS, method) || typeof api[method] !== 'function') {
        return { error: { code: 'not_found', message: `unknown method "${method}" (known: ${Object.keys(METHODS).join(', ')})` } };
    }
    if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
        return { error: { code: 'bad_request', message: 'arguments must be a JSON object' } };
    }
    try {
        return { result: await api[method](args ?? {}) };
    } catch (e) {
        return { error: { code: CODES.has(e.code) ? e.code : 'internal', message: e.message } };
    }
}

// readOnly: changes nothing (MCP readOnlyHint); destructive: may overwrite existing data (the live folder, on upload)
const METHODS = {
    status: { readOnly: true, desc: 'Tournament clock (round, roundIndex of plannedRounds, phase work/ladder/done, deadline, minutes left), time cap, and every competitor with its latest version and Elo.', props: {} },
    register: { desc: 'Register a new competitor with a starting bot; submits it as v0.', props: { name: 'string', title: 'string', philosophy: 'string', start: 'string', harness: 'object', owner: 'string' }, required: ['name'] },
    submit: { token: true, destructive: true, desc: 'Freeze your bot as your next version; the referee rates your newest version at the end of each round. With no bot, freezes your live folder (agents/<name>/ in the arena folder). From another machine pass bot = {kind:"js", files:{"bot.js": source, ...}} (self-contained CommonJS, exports createBot(name); the files are laid over your live folder), or {kind:"stdio", cmd, args} for a bot program (spec/protocol.md: JSON lines on stdin and stdout). The bot must load (require bot.js, createBot) or the submit fails with code bad_bot and the first lines of the error.', props: { name: 'string', note: 'string', bot: 'object' }, required: ['name', 'note'] },
    versions: { readOnly: true, desc: 'Your submitted versions and their notes.', props: { name: 'string' }, required: ['name'] },
    standings: { readOnly: true, desc: 'Every rated round so far with per-bot results and the all-round Elo.', props: {} },
    report: { readOnly: true, desc: 'A round report in markdown: standings, results per opponent, lost games with replay paths. Default: latest round.', props: { round: 'integer' } },
    say: { token: true, desc: 'Post your current thinking to your live dashboard panel. text = one thought, now = what you are doing, idea = current idea, plan = list of steps, diagram = a strategy diagram (schema swu-strategy/1: {title, caption, nodes:[{id,label,kind:input|memory|feature|decision|action,value,note}], edges:[{from,to,weight,label}], highlight:[ids], steps:[{caption,highlight}]}) that the arena animates to show the essence of your current strategy.', props: { name: 'string', text: 'string', now: 'string', idea: 'string', plan: 'array', diagram: 'object' }, required: ['name'] },
    send: { token: true, desc: 'Leave a message in a competitor inbox (to = name or "all").', props: { to: 'string', text: 'string', from: 'string' }, required: ['to', 'text'] },
    eval: { token: true, desc: 'Queue test games on the arena server: your live bot (or your submitted version N) vs each name in `vs` (1-6 of: built-in bots rush, heuristic, aggro, tempo, control, random; baselines; your own or another competitor\'s existing <agent>-v<N>), `seeds` seeds (1-10) from both seats. Returns an id for eval_result. Use this when you cannot run the engine yourself.', props: { name: 'string', vs: 'array', seeds: 'integer', version: 'integer' }, required: ['name'] },
    eval_result: { readOnly: true, desc: 'State and results of a queued eval: queued, running, done (W-L per opponent, ms per decision, lost games with replay paths).', props: { id: 'string' }, required: ['id'] },
    wait: { readOnly: true, desc: 'Wait for a work window. Call it in a loop: it returns at once if a work window is already open (unless round is given: then it waits for the window of a round after that one), else when one opens or after timeoutSec (default 45, max 200). Result: status started / waiting / done, started, and the status (round, phase, deadline).', props: { timeoutSec: 'integer', round: 'integer' } },
    panel: { readOnly: true, desc: "A competitor's live dashboard panel: now, idea, plan, thoughts, Elo and speed widgets.", props: { name: 'string' }, required: ['name'] },
    games: { readOnly: true, desc: 'Games of a round (default latest) with outcome, winner and timing; replays at replayBase + id + .jsonl.', props: { round: 'integer' } },
    inbox: { token: true, readOnly: true, desc: 'Messages for you (from Eric, the referee or others), oldest first. Read it at the start of every round.', props: { name: 'string', since: 'string' }, required: ['name'] }
};

module.exports = { api, call, clock, notify, METHODS, ArenaError, TOURNAMENT };
