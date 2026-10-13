'use strict';
/**
 * Arena API: the arena's competitors, versions and results. The games machine calls it in-process: the intake
 * registers and submits builders' bots (intake.js), and the window's uplink reads status, versions and panels (push.js
 * arenaPusher). The window (window.js) answers the read methods with the same shapes and uses METHODS for the
 * descriptions of its /mcp read tools. mcp.js serves every method as an MCP tool, arena_<method>, on a local arena.
 * Storage is ARENA_HOME (see home.js).
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
 *                                               with ready, or the submit fails with code bad_bot. {kind:'wasm', files} is
 *                                               a WebAssembly bundle (bot/compiled/README.md), played in the sandbox.
 *   withdraw {name, version?} / rejoin {...}    bench a competitor or stop rating one version, from the next ladder to start; undo
 *   versions {name}                             submitted versions with notes
 *   standings {}                                every rated round so far, all-round Elo
 *   report {round?}                             a round's markdown report (default: latest)
 *   panel {name} / panels {}                    one competitor's live panel / all of them + leaderboard + experiment
 *   games {round?} / ladder {round?}            a round's game list (replays at /replays/...) / its full ladder results
 * Readers (the app, the dashboard, ratings) use these calls instead of reading the arena's files.
 * Code may also come as files: submit {bot: {kind:'js', files: {"bot.js": "...", ...}}}. The intake sends each builder's
 * bundle that way, as {kind:'wasm', files}.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const home = require('./home');
const dash = require('./dash');
const { botSource, STARTS } = require('./starters');

const NAME = /^[a-z][a-z0-9_]{0,31}$/;
// Hosted arenas set ARENA_AUTH=1: then changing a competitor (submit, withdraw, rejoin) needs the token register
// returned, or ARENA_ADMIN_TOKEN. In the project's shared folder it is off.
const AUTH = process.env.ARENA_AUTH === '1';
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
// written by the old clocked tournaments; clock() reads it, and follows the hosted arena's rounds without it
const TOURNAMENT = () => path.join(home.HOME, 'tournament.json');
// the referee touches its ladder's lock every 30 s (referee.js runRound); older than this, no referee holds it
const ROUND_LOCK_FRESH_MS = 75000;
// error codes a client may see; anything else is reported as 'internal'
const CODES = new Set(['bad_request', 'unauthorized', 'not_found', 'conflict', 'bad_bot', 'unsupported']);
const LOAD_CHECK_MS = 30000;
// a bot program's hello: the referee's own budget for it (30 s, it includes starting the program)
const START_CHECK_MS = 30000;
// a WebAssembly bundle's files, in all (a JS bot compiled by Javy is about 1.3 MB)
const WASM_MAX_BYTES = 16e6;

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
 * Without tournament.json (the hosted arena) see hostedClock.
 */
function clock(now = Date.now()) {
    const t = home.readJson(TOURNAMENT(), null);
    if (!t) {
        return hostedClock(now);
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
 * The hosted arena's clock: the games machine plays a round whenever it plans one (gamesctl.js planRound), with no work
 * windows. phase is 'ladder' while a round's ladder holds a live referee lock, else 'idle'; round is that round, else
 * the newest round in standings (null before the first). A round cut off by a stop stays in standings unfinished and
 * shows as idle until the next boot resumes it.
 */
function hostedClock(now) {
    const last = home.readJson(path.join(home.HOME, 'standings.json'), { rounds: [] }).rounds?.at(-1) ?? null;
    // the round that may be playing: the newest one while it is unfinished, else the one the referee plays next
    const open = last && last.status !== 'done' ? { round: last.round, id: last.ladderId ?? `arena-r${last.round}` } : { round: (last?.round ?? -1) + 1, id: `arena-r${(last?.round ?? -1) + 1}` };
    let playing = false;
    try {
        playing = now - fs.statSync(path.join(home.RESULTS, open.id, 'referee.lock')).mtimeMs < ROUND_LOCK_FRESH_MS;
    } catch {
        // no lock: nothing is playing
    }
    return { tournament: null, round: playing ? open.round : last?.round ?? null, roundIndex: null, plannedRounds: null, phase: playing ? 'ladder' : 'idle', deadline: null, minutesLeft: null };
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
    throw new ArenaError('bad_bot', `${version} failed the start check (start ${bot.label ?? bot.cmd}, send hello, expect ready): ${why}${lines.length ? `\n${lines.join('\n')}` : ''}${hint}`);
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
        // On a hosted arena only the admin registers a competitor with a full harness (a command line, or a Claude Code
        // agent on the arena's account). Anyone else's harness only says how they run themselves: its kind and model
        // are kept, any command is dropped, and selfRun marks it as run by its builder.
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
        return { name, dir, version: v.version, token, tokenNote: 'Keep this token; it is shown once. Pass it as `token` to submit, withdraw and rejoin on a hosted arena.' };
    },

    submit({ name, note, bot = { kind: 'js' }, token, ref } = {}) {
        // Atomic: the version is assembled and load-checked in versions/.staging-*, then renamed into place in one step,
        // so the referee never sees a half-copied or unloadable version. A benched competitor may submit too: its newest
        // version is rated once it rejoins.
        owned(name, token, { benched: true });
        need(typeof note === 'string' && note.trim(), 'bad_request', 'note: one line saying what changed and why');
        need(bot && typeof bot === 'object' && ['js', 'stdio', 'wasm'].includes(bot.kind), 'bad_request', "bot.kind: 'js', 'stdio' or 'wasm'");
        need(bot.kind !== 'wasm' || (bot.cmd === undefined && bot.args === undefined), 'bad_request', 'a wasm bundle says how it runs in its arena.json');
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
        need(bot.kind !== 'wasm' || (bot.files && typeof bot.files === 'object' && typeof bot.files['arena.json'] === 'string'), 'bad_request',
            'a wasm bundle is bot.files with its arena.json and the files it names (binary ones as {"base64": "..."})');
        if (bot.files !== undefined) {
            // remote clients upload their bot as text files: {"bot.js": "...", "lib/x.js": "..."} on top of the live folder's
            // files. A wasm bundle is its own folder (bundle/), and its binary files come as {base64}
            need(bot.files && typeof bot.files === 'object' && !Array.isArray(bot.files) && (bot.kind !== 'js' || typeof bot.files['bot.js'] === 'string'), 'bad_request', 'bot.files must include "bot.js"');
            const root = bot.kind === 'wasm' ? path.join(live, 'bundle') : live;
            let bytes = 0;
            upload = Object.entries(bot.files).map(([rel, body]) => {
                const f = path.resolve(root, rel);
                const binary = bot.kind === 'wasm' && body && typeof body === 'object' && typeof body.base64 === 'string';
                const ok = f.startsWith(root + path.sep) && (typeof body === 'string' || binary) && !path.relative(root, f).split(path.sep).some((p) => p === '.git' || p === 'node_modules');
                need(ok, 'bad_request', `bad file path ${rel}`);
                const data = binary ? Buffer.from(body.base64, 'base64') : body;
                bytes += Buffer.byteLength(data);
                need(bytes <= WASM_MAX_BYTES, 'bad_request', `bot.files: at most ${WASM_MAX_BYTES / 1e6} MB in all`);
                return [path.relative(live, f), data];
            });
        }
        const { files, ...botMeta } = bot;
        const round = clock().round;
        // stamped just before the version is renamed into place, after its load check: a submit that finishes after the
        // round's deadline is late (lineup() rates it next round), however early it started
        // ref: what this version came from, e.g. a window submission (intake.js; not part of the API's own arguments)
        const meta = (n) => ({ name: `${name}-v${n}`, agent: name, version: n, note: note.trim(), bot: botMeta, files: files ? Object.keys(files) : undefined,
                               ...(typeof ref === 'string' ? { ref } : {}), submittedAt: new Date().toISOString(), round, checked: true });
        const staging = home.stagingDir(name);
        try {
            if (home.exists(live) && bot.kind !== 'wasm') {
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
            } else if (bot.kind === 'stdio' && /[\\/]/.test(bot.cmd)) {
                need(home.exists(path.join(staging, bot.cmd)), 'bad_request', `bot.cmd ${bot.cmd} is not in your folder`);
            }
            let n = (home.versionsOf(name).pop() ?? -1) + 1;
            const check = () => {
                if (bot.kind === 'js') {
                    loadCheck(staging, `${name}-v${n}`, upload ? `(uploaded) ${name}` : live);
                } else {
                    startCheck(staging, `${name}-v${n}`, bot.kind === 'wasm' ? require('./registry').WASM_BOT : bot, upload ? `(uploaded) ${name}` : live); // hello names the version
                }
            };
            check();
            // a concurrent submit may take the number first: then take the next free one (and load-check under that
            // name, since createBot gets the version name)
            for (let retry = 0; ; retry++) {
                home.writeJson(path.join(staging, 'SUBMISSION.json'), meta(n));
                if (home.promote(staging, path.join(home.VERSIONS, `${name}-v${n}`))) {
                    break;
                }
                need(retry < 5, 'conflict', 'too many concurrent submits; submit again');
                n = Math.max(n + 1, (home.versionsOf(name).pop() ?? -1) + 1);
                check();
            }
            if (upload && bot.kind !== 'wasm') {
                // the live folder follows what was uploaded, so a later submit without files starts from it; only the
                // newest version may write it, so a slower concurrent submit cannot overwrite a newer one. It becomes a
                // copy of that version, not the live folder plus this upload: a concurrent submit may have written the
                // live folder after this one copied it.
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
        // lineup() reads the roster when the ladder starts), or one broken version stops being rated the same way; a
        // ladder already running keeps its lineup. Versions, games and ratings stay, and rejoin undoes either
        owned(name, token, { benched: true });
        version = int(version);
        const at = new Date().toISOString();
        if (version === undefined || version === null) {
            home.updateRoster((r) => {
                const a = r.agents.find((x) => x.name === name);
                return a ? { ...r, agents: r.agents.filter((x) => x !== a), bench: [...(r.bench ?? []).filter((x) => x.name !== name), { ...a, benchedAt: at }] } : r;
            });
            return { name, benched: true, note: `${name} plays no ladder that starts from now on (this round's too, if it has not started), until rejoin` };
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
            return { name, benched: false, note: `${name} is rated in the next ladder to start (this round's, if it has not started)` };
        }
        need(Number.isInteger(version) && home.versionsOf(name).includes(version), 'not_found', `${name} has no version ${version} (see versions)`);
        // a benched competitor keeps its list too: it applies once it rejoins
        const back = (a) => (a.name === name ? { ...a, withdrawn: (a.withdrawn ?? []).filter((v) => v !== version) } : a);
        const r = home.updateRoster((ro) => ({ ...ro, agents: ro.agents.map(back), ...(ro.bench ? { bench: ro.bench.map(back) } : {}) }));
        const benched = !r.agents.some((a) => a.name === name);
        return { name, rated: `${name}-v${version}`, ...(benched ? { benched: true, note: `${name} is benched: rejoin {name} to play again` } : {}) };
    },

    versions({ name } = {}) {
        competitor(name, { benched: true }); // a benched competitor's versions stay readable
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
    }
};

/** A round number (default: the latest rated round) and its ladder id. Standings name the ladder once the round is
 *  published (the old clocked tournaments' rounds are <tournament id>-r<K>); anything else is arena-r<K>
 *  (referee.js ladderIdOf). */
function roundLadder(round) {
    const st = api.standings();
    const k = int(round ?? st.rounds[st.rounds.length - 1]?.round);
    need(k !== undefined, 'not_found', 'no rounds yet');
    need(Number.isInteger(k) && k >= 0, 'bad_request', 'round: an integer');
    const named = st.rounds.find((x) => x.round === k)?.ladderId;
    return { k, id: typeof named === 'string' && /^arena-[\w-]+$/.test(named) ? named : `arena-r${k}` };
}

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
    status: { readOnly: true, desc: 'Tournament clock (round, roundIndex of plannedRounds, phase work/ladder/done, deadline, minutes left; on the hosted arena the round playing now with phase ladder, else the newest round with phase idle), time cap, and every competitor with its latest version and Elo (benched ones marked benched, withdrawn versions listed).', props: {} },
    register: { desc: 'Register a new competitor with a starting bot; submits it as v0. harness says how the competitor works ({kind: codex|claude-code|human|script|other, model}); on a hosted arena it is a description only unless token is the admin token.', props: { name: 'string', title: 'string', philosophy: 'string', start: 'string', harness: 'object', owner: 'string', token: 'string' }, required: ['name'] },
    submit: { token: true, destructive: true, desc: 'Freeze your bot as your next version; the referee rates your newest version at the end of each round. With no bot, freezes your live folder (agents/<name>/ in the arena folder). From another machine pass bot = {kind:"js", files:{"bot.js": source, ...}} (self-contained CommonJS, exports createBot(name); the files are laid over your live folder), or {kind:"stdio", cmd, args} for a bot program (spec/protocol.md: JSON lines on stdin and stdout), or {kind:"wasm", files} for a WebAssembly bundle (arena.json and the files it names, binary ones as {"base64": "..."}; bot/compiled/README.md), which plays in a sandbox. The bot must load (require bot.js, createBot), and a bot program must start and answer hello with ready, or the submit fails with code bad_bot and the error lines.', props: { name: 'string', note: 'string', bot: 'object' }, required: ['name', 'note'] },
    withdraw: { token: true, destructive: true, desc: "Take yourself out of the tournament (benched): you play no ladder that starts from now on, this round's included if its ladder has not started. With version, stop rating one broken version the same way (the referee then rates your newest version that is not withdrawn). A ladder already running keeps its lineup. Your versions, games and ratings stay; rejoin undoes either.", props: { name: 'string', version: 'integer' }, required: ['name'] },
    rejoin: { token: true, desc: "Undo withdraw: rated again from the next ladder to start (this round's, if it has not started); or with version, rate that version again.", props: { name: 'string', version: 'integer' }, required: ['name'] },
    versions: { readOnly: true, desc: 'Your submitted versions and their notes.', props: { name: 'string' }, required: ['name'] },
    standings: { readOnly: true, desc: 'Every rated round so far with per-bot results and the all-round Elo.', props: {} },
    report: { readOnly: true, desc: 'A round report in markdown: standings, results per opponent, lost games with replay paths. Default: latest round.', props: { round: 'integer' } },
    panel: { readOnly: true, desc: "A competitor's live dashboard panel: now, idea, plan, thoughts, Elo and speed widgets.", props: { name: 'string' }, required: ['name'] },
    panels: { readOnly: true, desc: 'Every competitor panel, plus the leaderboard and the experiment (Elo over rounds) the research dashboard shows.', props: {} },
    games: { readOnly: true, desc: 'Games of a round (default latest) with outcome, winner and timing; replays at replayBase + id + .jsonl.', props: { round: 'integer' } },
    ladder: { readOnly: true, desc: "A round's full ladder results (default latest), schema swu-ladder/1: config, bots with Elo and win rates, pairs, every game.", props: { round: 'integer' } }
};

/** A person's builder name: their GitHub login as an arena name (lowercase, _ for -, a letter first). */
function builderName(login) {
    const n = String(login ?? '').toLowerCase().replace(/-/g, '_');
    return (/^[a-z]/.test(n) ? n : `gh_${n}`).slice(0, 32);
}
/** The competitor names a person may make: their builder name, and that name with _ and a suffix (ana, ana_fast). */
function ownsName(login, name) {
    const b = builderName(login);
    return name === b || String(name).startsWith(`${b}_`);
}

module.exports = { api, call, startCheck, builderName, ownsName, clock, METHODS, ArenaError, TOURNAMENT };
