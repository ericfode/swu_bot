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
 *                                               (require bot.js, createBot) and a bot program must start and answer hello
 *                                               with ready, or the submit fails with code bad_bot.
 *   withdraw {name, version?} / rejoin {...}    bench a competitor or stop rating one version, from the next ladder to start; undo
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
 *   panel {name} / panels {}                    one competitor's live panel / all of them + leaderboard + experiment
 *   games {round?} / ladder {round?}            a round's game list (replays at /replays/...) / its full ladder results
 *   archive {id?}                               archived tournaments, or one archived tournament's standings and panels
 * Readers (the app, the dashboard, ratings) use these calls instead of reading the arena's files.
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
// a bot program's hello: the referee's own budget for it (30 s, it includes starting the program)
const START_CHECK_MS = 30000;
const ARCHIVE_ID = /^[\w-]{1,64}$/;

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
const cardJson = () => require('./registry').CARD_JSON;

/** An integer argument that may arrive as a string (query strings, shells); anything else is returned unchanged. */
const int = (v) => (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v);

function competitor(name, { benched = false } = {}) {
    const r = home.roster();
    const c = r.agents.find((a) => a.name === name) ?? (benched ? (r.bench ?? []).find((a) => a.name === name) : undefined);
    need(c, 'not_found', `no competitor "${name}" (see status)`);
    return c;
}

/** The competitor (benched ones too when asked), checked against its token when the arena requires tokens. */
function owned(name, token, opts) {
    const c = competitor(name, opts);
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
    const h = t.rules?.holdout;
    // a holdout tournament's card rule: what competitors may build and test with (the held-out list stays unnamed here)
    const rules = h ? { holdout: { fraction: h.fraction, trainPool: path.join(home.HOME, h.train), trainCards: h.counts?.train ?? null, holdoutCards: h.counts?.holdout ?? null } } : null;
    // roundIndex counts work rounds (plannedRounds counts those): a holdout tournament's extra ladder is `holdout: true`
    const holdout = cur?.kind === 'holdout';
    return { tournament: { id: t.id, title: t.title, rounds: t.plannedRounds, roundMinutes: t.roundMinutes, task: t.task ?? null, rules }, round: cur?.n ?? null,
             roundIndex: cur ? t.rounds.filter((r) => r.kind !== 'holdout').length : null, plannedRounds: t.plannedRounds ?? null, ...(holdout ? { holdout } : {}), phase, deadline,
             minutesLeft: deadline ? Math.max(0, Math.round((Date.parse(deadline) - now) / 60000)) : null };
}

/**
 * Inbox messages from server-side callers (the referee): to = a competitor, a list of them or "all". No auth check, and
 * deliberately not an api method (nor in METHODS), so no HTTP, MCP or CLI client can call it.
 */
function notify({ to, from = 'referee', text } = {}) {
    need(typeof text === 'string' && text.trim(), 'bad_request', 'text is required');
    // "all" is the competitors playing; a benched one named directly still gets the message, to read once it rejoins
    const targets = to === 'all' ? home.roster().agents.map((a) => a.name) : (Array.isArray(to) ? to : [to]).map((n) => competitor(n, { benched: true }).name);
    const msg = { t: new Date().toISOString(), from: String(from), text: text.trim() };
    for (const n of targets) {
        home.appendJsonl(INBOX(n), msg);
    }
    return { delivered: targets };
}

// submitted code must not see the arena's secrets, nor the egress proxy (in a cloud session it adds credentials)
const checkEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/TOKEN|SECRET|KEY|PASSWORD|AUTH|PROXY/i.test(k)));

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
        env: { ...checkEnv(), ARENA_HOME: home.HOME }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: LOAD_CHECK_MS, killSignal: 'SIGKILL'
    });
    if (r.status === 0) {
        return;
    }
    const why = r.error?.code === 'ETIMEDOUT' ? `took more than ${LOAD_CHECK_MS / 1000} s` : r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit code ${r.status}`;
    const lines = String(r.stderr ?? '').split(dir).join(shownAs).split('\n').filter((l) => l.trim()).slice(0, 8);
    throw new ArenaError('bad_bot', `${version} failed the load check (require bot.js, call createBot): ${why}${lines.length ? `\n${lines.join('\n')}` : ''}`);
}

// Runs in a child process: starts a submitted bot program in its folder, as the registry does for a game, and sends it the
// hello the referee sends (two real deck lists), then expects ready. Never resolves on its own: the timer ends it.
const START_CHECK = `
const [stdio, decksFile, dir, name, spec, ms] = process.argv.slice(1);
const { StdioClient } = require(stdio);
const { cmd, args } = JSON.parse(spec);
const decks = require(decksFile);
const bye = (code, msg) => { if (msg) process.stderr.write(msg + '\\n'); process.exit(code); };
setTimeout(() => bye(1, 'no reply to hello within ' + ms + ' ms'), Number(ms));
const client = new StdioClient(name, { cmd: /[\\\\/]/.test(cmd) ? require('path').join(dir, cmd) : cmd, args, cwd: dir });
client.hello({ t: 'hello', protocol: 'swu-bot-stdio', v: 1, versions: [1, 2], bot: name, you: 'p1', seed: 1,
    players: [{ id: 'p1', name: 'p1', bot: name }, { id: 'p2', name: 'p2', bot: 'heuristic' }], deck: decks[0], opponent: decks[1], ms: Number(ms) })
    .then((r) => r?.t === 'ready' && [1, 2].includes(r.v ?? 1) ? bye(0) : bye(1, 'expected {"t":"ready","v":2}, got ' + JSON.stringify(r).slice(0, 200)),
          (e) => bye(1, e.message));
`;

/** Throws bad_bot unless the bot program in dir starts and answers hello with ready (same environment as a game). */
function startCheck(dir, version, bot, shownAs) {
    const r = spawnSync(process.execPath, ['-e', START_CHECK, path.join(__dirname, '..', 'stdio.js'), path.join(__dirname, '..', 'decks', 'ash-meta-2026-09.json'),
        dir, version, JSON.stringify({ cmd: bot.cmd, args: bot.args ?? [] }), String(START_CHECK_MS)], {
        env: { ...checkEnv(), SWU_CARD_JSON: cardJson() },
        stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: START_CHECK_MS + 5000, killSignal: 'SIGKILL'
    });
    if (r.status === 0) {
        return;
    }
    const why = r.error?.code === 'ETIMEDOUT' ? `took more than ${START_CHECK_MS / 1000} s` : r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit code ${r.status}`;
    const lines = String(r.stderr ?? '').split(dir).join(shownAs).split('\n').filter((l) => l.trim()).slice(-8);
    // a file in the arena folder may have lost its exec bit (a synced folder keeps none): run it through its interpreter
    const hint = lines.some((l) => /EACCES/.test(l)) ? `\n${bot.cmd} is not executable in the arena folder (it keeps no exec bits): start it through its interpreter, e.g. {"cmd": "sh", "args": ["${bot.cmd}"]} for a shell script` : '';
    throw new ArenaError('bad_bot', `${version} failed the start check (start ${bot.cmd}, send hello, expect ready): ${why}${lines.length ? `\n${lines.join('\n')}` : ''}${hint}`);
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
    // a benched competitor's frozen versions stay fair opponents
    if (v && [...r.agents, ...(r.bench ?? [])].some((a) => a.name === v[1])) {
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
            // benched competitors too (api.withdraw): still registered, with their versions and ratings, and may rejoin
            competitors: [...r.agents.map((a) => [a, false]), ...(r.bench ?? []).map((a) => [a, true])].map(([a, benched]) => ({
                name: a.name, title: a.title, harness: a.harness ?? null, owner: a.owner ?? null, philosophy: a.philosophy ?? '',
                ...(benched ? { benched: true, benchedAt: a.benchedAt ?? null } : {}),
                ...(a.withdrawn?.length ? { withdrawn: a.withdrawn.map((v) => `${a.name}-v${v}`) } : {}),
                latest: (() => { const v = home.versionsOf(a.name).pop(); return v === undefined ? null : `${a.name}-v${v}`; })(),
                elo: (() => { const v = home.versionsOf(a.name).pop(); return v === undefined ? null : st.global?.[`${a.name}-v${v}`] ?? null; })()
            }))
        };
    },

    register({ name, title, philosophy, start = 'heuristic', harness = null, owner = null, token: adminToken } = {}) {
        need(NAME.test(name ?? ''), 'bad_request', 'name: 1-32 chars, lowercase letters, digits, _; starts with a letter');
        need(harness === null || (typeof harness === 'object' && !Array.isArray(harness)), 'bad_request', 'harness: an object such as {"kind": "codex"}');
        // On a hosted arena only the admin registers a competitor the runner starts (runner.js runs its harness: a
        // command line, or a Claude Code agent on the arena's account). Anyone else's harness only says how they run
        // themselves: its kind and model are kept, any command is dropped, and selfRun keeps the runner away from it.
        if (harness && AUTH && !(process.env.ARENA_ADMIN_TOKEN && adminToken === process.env.ARENA_ADMIN_TOKEN)) {
            harness = { kind: String(harness.kind ?? 'other').slice(0, 32), ...(harness.model ? { model: String(harness.model).slice(0, 64) } : {}), selfRun: true };
        }
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
                               submittedAt: new Date().toISOString(), round, checked: true });
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
            } else {
                startCheck(staging, `${name}-v${n}`, bot, upload ? `(uploaded) ${name}` : live);
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
                } else {
                    startCheck(staging, `${name}-v${n}`, bot, upload ? `(uploaded) ${name}` : live); // hello names the version
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

    withdraw({ name, version, token } = {}) {
        // a competitor leaves every ladder that starts from now on (this round's too, if its ladder has not started:
        // lineup() reads the roster when the ladder starts) and the runner from the next round, or one broken version
        // stops being rated the same way; a ladder already running keeps its lineup. Versions, games and ratings stay,
        // and rejoin undoes either
        owned(name, token, { benched: true });
        version = int(version);
        const at = new Date().toISOString();
        if (version === undefined || version === null) {
            home.updateRoster((r) => {
                const a = r.agents.find((x) => x.name === name);
                return a ? { ...r, agents: r.agents.filter((x) => x !== a), bench: [...(r.bench ?? []).filter((x) => x.name !== name), { ...a, benchedAt: at }] } : r;
            });
            return { name, benched: true, note: `${name} plays no ladder that starts from now on (this round's too, if it has not started) and gets no work window from the next round, until rejoin` };
        }
        need(Number.isInteger(version) && home.versionsOf(name).includes(version), 'not_found', `${name} has no version ${version} (see versions)`);
        // benched or not: the list applies whenever the competitor plays
        const off = (a) => (a.name === name ? { ...a, withdrawn: [...new Set([...(a.withdrawn ?? []), version])].sort((x, y) => x - y) } : a);
        const r = home.updateRoster((ro) => ({ ...ro, agents: ro.agents.map(off), ...(ro.bench ? { bench: ro.bench.map(off) } : {}) }));
        const out = [...r.agents, ...(r.bench ?? [])].find((a) => a.name === name)?.withdrawn ?? [];
        const left = home.versionsOf(name).filter((v) => !out.includes(v));
        return { name, withdrawn: `${name}-v${version}`, rated: left.length ? `${name}-v${left[left.length - 1]}` : null };
    },

    rejoin({ name, version, token } = {}) {
        owned(name, token, { benched: true });
        version = int(version);
        if (version === undefined || version === null) {
            home.updateRoster((r) => {
                const a = (r.bench ?? []).find((x) => x.name === name);
                if (!a) {
                    return r;
                }
                const { benchedAt, ...back } = a;
                return { ...r, bench: r.bench.filter((x) => x !== a), agents: [...r.agents.filter((x) => x.name !== name), back] };
            });
            return { name, benched: false, note: `${name} is rated in the next ladder to start (this round's, if it has not started) and gets a work window from the next round` };
        }
        need(Number.isInteger(version) && home.versionsOf(name).includes(version), 'not_found', `${name} has no version ${version} (see versions)`);
        // a benched competitor keeps its list too: it applies once it rejoins
        const back = (a) => (a.name === name ? { ...a, withdrawn: (a.withdrawn ?? []).filter((v) => v !== version) } : a);
        const r = home.updateRoster((ro) => ({ ...ro, agents: ro.agents.map(back), ...(ro.bench ? { bench: ro.bench.map(back) } : {}) }));
        const benched = !r.agents.some((a) => a.name === name);
        return { name, rated: `${name}-v${version}`, ...(benched ? { benched: true, note: `${name} is benched: rejoin {name} to play again` } : {}) };
    },

    versions({ name } = {}) {
        competitor(name, { benched: true }); // a benched competitor's versions stay, and stay eval opponents
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
        return { id, state: 'queued', note: `the referee plays queued evals between ladders; poll eval_result${bot === name ? '. It plays your live folder as it is then, so keep it unchanged until the eval is done, or pass version to test a frozen copy' : ''}` };
    },

    eval_result({ id } = {}) {
        const safe = String(id ?? '').replace(/[^a-z0-9_-]/g, '');
        need(safe, 'bad_request', 'id: the id eval returned');
        const j = home.readJson(path.join(home.HOME, 'queue', `${safe}.json`), null);
        need(j, 'not_found', `no eval "${safe}"`);
        // each lost game's replay also as the path the HTTP server serves it under (GET /<replayUrl>), for clients on
        // another machine: `replay` is a path on the referee's disk
        const url = (p) => /(arena-evals\/[\w-]+\/[\w.#@-]+\.jsonl)$/.exec(String(p ?? ''))?.[1];
        if (Array.isArray(j.summary?.losses)) {
            j.summary.losses = j.summary.losses.map((l) => (url(l.replay) ? { ...l, replayUrl: `replays/${url(l.replay)}` } : l));
        }
        return j;
    },

    panel({ name } = {}) {
        competitor(name, { benched: true });
        // composed from the halves kept in ARENA_HOME, so it works without the research dashboard folder
        return dash.composePanel(name);
    },

    panels() {
        // every panel the research dashboard shows for the arena, from ARENA_HOME (the dashboard's files are copies)
        return { ...dash.boards(), panels: [...home.roster().agents, ...(home.roster().bench ?? [])].map((a) => dash.composePanel(a.name)) };
    },

    games({ round } = {}) {
        const { k, id } = roundLadder(round);
        const idx = home.readJson(path.join(home.RESULTS, id, 'index.json'), null);
        need(idx, 'not_found', `no games for round ${k}`);
        return { round: k, ladderId: id, replayBase: `replays/${id}/games/`, games: idx.games };
    },

    ladder({ round } = {}) {
        const { k, id } = roundLadder(round);
        const doc = home.readJson(path.join(home.RESULTS, id, 'ladder.json'), null);
        need(doc, 'not_found', `no ladder for round ${k}`);
        return { round: k, ladderId: id, ladder: doc };
    },

    archive({ id } = {}) {
        const dir = path.join(home.HOME, 'archive');
        if (id === undefined || id === null || id === '') {
            const ids = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && ARCHIVE_ID.test(d.name)).map((d) => d.name).sort() : [];
            return { tournaments: ids.map((x) => ({ id: x, note: home.readJson(path.join(dir, x, 'README.json'), null)?.note ?? null,
                                                    rounds: home.readJson(path.join(dir, x, 'standings.json'), null)?.rounds?.length ?? 0 })) };
        }
        need(typeof id === 'string' && ARCHIVE_ID.test(id), 'bad_request', 'id: an archived tournament id (archive {} lists them)');
        const base = path.join(dir, id);
        need(fs.existsSync(base), 'not_found', `no archived tournament ${id}`);
        // archives are copies of the dashboard files: panels/ or dash/ hold arena-<agent>.json and arena-leaderboard.json
        const panels = [];
        let leaderboard = null;
        for (const sub of ['panels', 'dash']) {
            const d = path.join(base, sub);
            for (const f of fs.existsSync(d) ? fs.readdirSync(d).filter((x) => /^arena-[\w-]+\.json$/.test(x)).sort() : []) {
                const p = home.readJson(path.join(d, f), null);
                if (f === 'arena-leaderboard.json') {
                    leaderboard ??= p;
                } else if (p && !panels.some((q) => q.id === p.id)) {
                    panels.push(p);
                }
            }
        }
        const experiment = home.readJson(path.join(base, 'dash', 'arena.json'), null) ?? home.readJson(path.join(base, 'experiment-arena.json'), null);
        return { id, note: home.readJson(path.join(base, 'README.json'), null)?.note ?? null, standings: home.readJson(path.join(base, 'standings.json'), null),
                 leaderboard, experiment, panels };
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

/** A round number (default: the latest rated round) and its ladder id. Standings name the ladder once the round is
 *  published, tournament.json as soon as it opens (tournament rounds are <tournament id>-r<K>, referee.js ladderIdOf);
 *  anything else falls back to arena-r<K>. */
function roundLadder(round) {
    const st = api.standings();
    const k = int(round ?? st.rounds[st.rounds.length - 1]?.round);
    need(k !== undefined, 'not_found', 'no rounds yet');
    need(Number.isInteger(k) && k >= 0, 'bad_request', 'round: an integer');
    const t = home.readJson(TOURNAMENT(), null);
    const named = st.rounds.find((x) => x.round === k)?.ladderId ?? (Array.isArray(t?.rounds) ? t.rounds.find((r) => r?.n === k)?.ladder : undefined);
    return { k, id: typeof named === 'string' && /^arena-[\w-]+$/.test(named) ? named : `arena-r${k}` };
}

/** Calls a method by name with an args object; resolves {result} or {error: {code, message}}. */
// what only the arena does to a competitor that runner.js runs: it runs it for the whole tournament
const BENCH = ['withdraw', 'rejoin'];

/**
 * A call made for one competitor (runner.js sets ARENA_COMPETITOR for the harnesses it starts and their MCP server):
 * that name is the default and the only one allowed, it registers and benches nobody, and it sends as itself, to one
 * competitor. Returns {args} to go on with, or {error}. call() applies it, so the CLI, scripts and mcp.js get the same
 * rules; mcp.js applies it too before it forwards to a remote arena. On a local arena, whose competitors share the arena
 * folder, this keeps honest agents on their own name; a hosted arena's tokens (ARENA_AUTH) are the boundary.
 */
function asCompetitor(me, method, args) {
    const no = (message) => ({ error: { code: 'unauthorized', message } });
    if (method === 'register') {
        return no('a competitor cannot register other competitors');
    }
    if (BENCH.includes(method)) {
        return no('the arena runs you for the whole tournament; it alone benches competitors');
    }
    let a = args ?? {};
    if (METHODS[method]?.required?.includes('name')) {
        if (a.name !== undefined && a.name !== me) {
            return no(`you are "${me}": this call acts for you only`);
        }
        a = { ...a, name: me };
    }
    if (method === 'send') {
        if (a.to === 'all') {
            return no('a competitor sends to one competitor at a time');
        }
        a = { ...a, from: me };
    }
    return { args: a };
}

async function call(method, args = {}) {
    if (!Object.prototype.hasOwnProperty.call(METHODS, method) || typeof api[method] !== 'function') {
        return { error: { code: 'not_found', message: `unknown method "${method}" (known: ${Object.keys(METHODS).join(', ')})` } };
    }
    if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
        return { error: { code: 'bad_request', message: 'arguments must be a JSON object' } };
    }
    if (process.env.ARENA_COMPETITOR) {
        const s = asCompetitor(process.env.ARENA_COMPETITOR, method, args);
        if (s.error) {
            return s;
        }
        args = s.args;
    }
    try {
        return { result: await api[method](args ?? {}) };
    } catch (e) {
        return { error: { code: CODES.has(e.code) ? e.code : 'internal', message: e.message } };
    }
}

// readOnly: changes nothing (MCP readOnlyHint); destructive: may overwrite existing data (the live folder, on upload)
const METHODS = {
    status: { readOnly: true, desc: 'Tournament clock (round, roundIndex of plannedRounds, phase work/ladder/done, deadline, minutes left), time cap, and every competitor with its latest version and Elo (benched ones marked benched, withdrawn versions listed).', props: {} },
    register: { desc: 'Register a new competitor with a starting bot; submits it as v0. harness says how the competitor works ({kind: codex|claude-code|human|script|other, model}); on a hosted arena it is a description only unless token is the admin token.', props: { name: 'string', title: 'string', philosophy: 'string', start: 'string', harness: 'object', owner: 'string', token: 'string' }, required: ['name'] },
    submit: { token: true, destructive: true, desc: 'Freeze your bot as your next version; the referee rates your newest version at the end of each round. With no bot, freezes your live folder (agents/<name>/ in the arena folder). From another machine pass bot = {kind:"js", files:{"bot.js": source, ...}} (self-contained CommonJS, exports createBot(name); the files are laid over your live folder), or {kind:"stdio", cmd, args} for a bot program (spec/protocol.md: JSON lines on stdin and stdout). The bot must load (require bot.js, createBot), and a bot program must start and answer hello with ready, or the submit fails with code bad_bot and the error lines.', props: { name: 'string', note: 'string', bot: 'object' }, required: ['name', 'note'] },
    withdraw: { token: true, destructive: true, desc: "Take yourself out of the tournament (benched): you play no ladder that starts from now on, this round's included if its ladder has not started, and get no work window from the next round. With version, stop rating one broken version the same way (the referee then rates your newest version that is not withdrawn). A ladder already running keeps its lineup. Your versions, games and ratings stay; rejoin undoes either.", props: { name: 'string', version: 'integer' }, required: ['name'] },
    rejoin: { token: true, desc: "Undo withdraw: rated again from the next ladder to start (this round's, if it has not started), with a work window from the next round; or with version, rate that version again.", props: { name: 'string', version: 'integer' }, required: ['name'] },
    versions: { readOnly: true, desc: 'Your submitted versions and their notes.', props: { name: 'string' }, required: ['name'] },
    standings: { readOnly: true, desc: 'Every rated round so far with per-bot results and the all-round Elo.', props: {} },
    report: { readOnly: true, desc: 'A round report in markdown: standings, results per opponent, lost games with replay paths. Default: latest round.', props: { round: 'integer' } },
    say: { token: true, desc: 'Post your current thinking to your live dashboard panel. text = one thought, now = what you are doing, idea = current idea, plan = list of steps, diagram = a strategy diagram (schema swu-strategy/1: {title, caption, nodes:[{id,label,kind:input|memory|feature|decision|action,value,note}], edges:[{from,to,weight,label}], highlight:[ids], steps:[{caption,highlight}]}) that the arena animates to show the essence of your current strategy.', props: { name: 'string', text: 'string', now: 'string', idea: 'string', plan: 'array', diagram: 'object' }, required: ['name'] },
    send: { token: true, desc: 'Leave a message in a competitor inbox (to = name or "all").', props: { to: 'string', text: 'string', from: 'string' }, required: ['to', 'text'] },
    eval: { token: true, desc: 'Queue test games on the arena server: your live bot (or your submitted version N) vs each name in `vs` (1-6 of: built-in bots rush, heuristic, aggro, tempo, control, random; baselines; your own or another competitor\'s existing <agent>-v<N>), `seeds` seeds (1-10) from both seats. Returns an id for eval_result. A live-bot eval plays your folder as it is when the referee runs the queued eval, so keep it unchanged until eval_result says done, or pass `version` to test a frozen copy. Use this when you cannot run the engine yourself.', props: { name: 'string', vs: 'array', seeds: 'integer', version: 'integer' }, required: ['name'] },
    eval_result: { readOnly: true, desc: 'State and results of a queued eval: queued, running, done (W-L per opponent, ms per decision, lost games with replay paths).', props: { id: 'string' }, required: ['id'] },
    wait: { readOnly: true, desc: 'Wait for a work window. Call it in a loop: it returns at once if a work window is already open (unless round is given: then it waits for the window of a round after that one), else when one opens or after timeoutSec (default 45, max 200). Result: status started / waiting / done, started, and the status (round, phase, deadline).', props: { timeoutSec: 'integer', round: 'integer' } },
    panel: { readOnly: true, desc: "A competitor's live dashboard panel: now, idea, plan, thoughts, Elo and speed widgets.", props: { name: 'string' }, required: ['name'] },
    panels: { readOnly: true, desc: 'Every competitor panel, plus the leaderboard and the experiment (Elo over rounds) the research dashboard shows.', props: {} },
    games: { readOnly: true, desc: 'Games of a round (default latest) with outcome, winner and timing; replays at replayBase + id + .jsonl.', props: { round: 'integer' } },
    ladder: { readOnly: true, desc: "A round's full ladder results (default latest), schema swu-ladder/1: config, bots with Elo and win rates, pairs, every game.", props: { round: 'integer' } },
    archive: { readOnly: true, desc: 'Archived tournaments. Without id: the list. With id: its standings, leaderboard, experiment and competitor panels.', props: { id: 'string' } },
    inbox: { token: true, readOnly: true, desc: 'Messages for you (from Eric, the referee or others), oldest first. Read it at the start of every round.', props: { name: 'string', since: 'string' }, required: ['name'] }
};

module.exports = { api, call, asCompetitor, BENCH, clock, notify, METHODS, ArenaError, TOURNAMENT };
