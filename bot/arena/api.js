'use strict';
/**
 * Arena API: the tournament layer every competitor uses, whatever its harness. One implementation, exposed three
 * ways with the same method names and JSON shapes:
 *   server.js  HTTP:  POST /api/<method> with a JSON body  (scripts, optimizers, a hosted arena later)
 *   mcp.js     MCP:   tool arena_<method>                  (Claude Code, Codex and other LLM harnesses)
 *   cli.js     CLI:   node bot/arena/cli.js <method> '{json}'
 * Storage is ARENA_HOME (see home.js): the project's shared folder, so every thread's container sees the same arena.
 * How a bot plays a game (observations, actions, timing) is not defined here: a submitted bot is a JS folder
 * (createBot, spec/bot-interface.md) or a program speaking spec/stdio-protocol.md.
 *
 * Methods (args -> result):
 *   status {}                                   tournament, current round + phase + deadline, competitors
 *   register {name, title?, philosophy?, start?, harness?, owner?}   create a competitor (starter bot, v0 submitted)
 *   submit {name, note, bot?}                   freeze the live bot as the next version; bot = {kind:'js'} (default:
 *                                               agents/<name>/) or {kind:'stdio', cmd, args?, cwd?}
 *   versions {name}                             submitted versions with notes
 *   standings {}                                every rated round so far, all-round Elo
 *   report {round?}                             a round's markdown report (default: latest)
 *   say {name, text?, now?, idea?, plan?, diagram?}  post thoughts (and a strategy diagram, strategy.js) to the live panel
 *   send {to, text, from?}                      leave a message in a competitor's inbox ("all" = everyone)
 *   inbox {name, since?}                        messages for a competitor, oldest first
 *   eval {name, vs?, seeds?, version?}          queue test games on the server (for clients without the engine)
 *   eval_result {id}                            queued / running / done with results
 *   wait {timeoutSec?, round?}                  long-poll until the next round's work phase starts
 * A remote client submits its code with submit {bot: {kind:'js', files: {"bot.js": "...", ...}}}.
 */
const fs = require('fs');
const path = require('path');
const home = require('./home');
const dash = require('./dash');
const { botSource, STARTS } = require('./starters');
const { validateDiagram } = require('./strategy');

const crypto = require('crypto');

const NAME = /^[a-z][a-z0-9_]{0,31}$/;
// Hosted arenas set ARENA_AUTH=1: then changing a competitor (submit, say, eval, inbox) needs the token register
// returned, and messaging everyone needs ARENA_ADMIN_TOKEN. In the project's shared folder it is off.
const AUTH = process.env.ARENA_AUTH === '1';
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const TOURNAMENT = () => path.join(home.HOME, 'tournament.json');
const INBOX = (n) => path.join(home.HOME, 'inbox', `${n}.jsonl`);

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

/** Where the tournament clock stands: phase is 'work', 'ladder', 'done' or 'idle' (no tournament running). */
function clock(now = Date.now()) {
    const t = home.readJson(TOURNAMENT(), null);
    if (!t) {
        return { tournament: null, round: null, phase: 'idle', deadline: null };
    }
    const cur = t.rounds?.[t.rounds.length - 1] ?? null;
    let phase = t.state === 'done' ? 'done' : cur?.ladderStart && !cur?.ladderEnd ? 'ladder' : 'work';
    const deadline = phase === 'work' && cur ? cur.workEnd : null;
    return { tournament: { id: t.id, title: t.title, rounds: t.plannedRounds, roundMinutes: t.roundMinutes, task: t.task ?? null }, round: cur?.n ?? null, phase, deadline,
             minutesLeft: deadline ? Math.max(0, Math.round((Date.parse(deadline) - now) / 60000)) : null };
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
        const dir = path.join(home.AGENTS, name);
        need(!fs.existsSync(dir), 'conflict', `competitor "${name}" already exists`);
        fs.mkdirSync(dir, { recursive: true });
        for (const f of ['heuristic.js', 'rush.js']) {
            fs.copyFileSync(path.join(__dirname, 'starters', f), path.join(dir, f));
        }
        fs.writeFileSync(path.join(dir, 'bot.js'), botSource(start));
        fs.writeFileSync(path.join(dir, 'NOTES.md'), `# ${name} notes\n\nWhat you tried, what you measured, what you plan next. Read this first when you come back.\n`);
        const r = home.roster();
        const token = crypto.randomBytes(18).toString('base64url');
        r.agents = [...r.agents, { name, title: title ?? name, start, philosophy: philosophy ?? '', harness, owner, tokenHash: hash(token), registeredAt: new Date().toISOString() }];
        home.writeJson(home.ROSTER, r);
        const v = api.submit({ name, note: `starting strategy: ${start}`, token });
        dash.updatePanel(name, { now: 'Registered', status: 'running' });
        return { name, dir, version: v.version, token, tokenNote: 'Keep this token; it is shown once. Pass it as `token` to submit, say, eval and inbox on a hosted arena.' };
    },

    submit({ name, note, bot = { kind: 'js' }, token } = {}) {
        owned(name, token);
        need(typeof note === 'string' && note.trim(), 'bad_request', 'note: one line saying what changed and why');
        need(['js', 'stdio'].includes(bot?.kind), 'bad_request', "bot.kind: 'js' or 'stdio'");
        const n = (home.versionsOf(name).pop() ?? -1) + 1;
        const version = `${name}-v${n}`;
        const dst = path.join(home.VERSIONS, version);
        fs.mkdirSync(home.VERSIONS, { recursive: true });
        if (bot.kind === 'js') {
            const src = path.join(home.AGENTS, name);
            if (bot.files) {
                // remote clients upload their bot: {"bot.js": "...", "lib/x.js": "..."} replaces the live folder's files
                need(typeof bot.files === 'object' && typeof bot.files['bot.js'] === 'string', 'bad_request', 'bot.files must include "bot.js"');
                const writes = Object.entries(bot.files).map(([rel, text]) => {
                    const f = path.resolve(src, rel);
                    need(f.startsWith(src + path.sep) && typeof text === 'string', 'bad_request', `bad file path ${rel}`);
                    return [f, text];
                });
                for (const [f, text] of writes) {
                    fs.mkdirSync(path.dirname(f), { recursive: true });
                    fs.writeFileSync(f, text);
                }
            }
            need(fs.existsSync(path.join(src, 'bot.js')), 'bad_request', `no bot.js in ${src}`);
            fs.cpSync(src, dst, { recursive: true, filter: (f) => !path.relative(src, f).split(path.sep).some((p) => p.startsWith('.')) });
        } else {
            need(typeof bot.cmd === 'string' && bot.cmd, 'bad_request', 'bot.cmd: the program to run (spec/stdio-protocol.md)');
            fs.mkdirSync(dst, { recursive: true });
        }
        const { files, ...botMeta } = bot;
        home.writeJson(path.join(dst, 'SUBMISSION.json'), { name: version, agent: name, version: n, note: note.trim(), bot: botMeta, files: files ? Object.keys(files) : undefined, submittedAt: new Date().toISOString(), round: clock().round });
        return { version, round: clock().round };
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
        const k = round ?? all[all.length - 1];
        need(k !== undefined && all.includes(Number(k)), 'not_found', 'no round report yet');
        return { round: Number(k), markdown: fs.readFileSync(path.join(dir, `r${k}.md`), 'utf8') };
    },

    say({ name, text, now, idea, plan, diagram, token } = {}) {
        owned(name, token);
        const p = Array.isArray(plan) ? plan.map((x) => (typeof x === 'string' ? { text: x, state: 'todo' } : x)) : undefined;
        dash.updatePanel(name, { thought: text, now, idea, plan: p, diagram: diagram ? validateDiagram(diagram) : undefined });
        return { ok: true };
    },

    send({ to, text, from = 'eric', token } = {}) {
        need(typeof text === 'string' && text.trim(), 'bad_request', 'text is required');
        if (AUTH) {
            const admin = process.env.ARENA_ADMIN_TOKEN && token === process.env.ARENA_ADMIN_TOKEN;
            need(admin || (to !== 'all' && from !== 'eric' && (owned(from, token), true)), 'unauthorized', 'messages need the admin token, or your own token with from = your name');
        }
        const targets = to === 'all' ? home.roster().agents.map((a) => a.name) : [competitor(to).name];
        const msg = { t: new Date().toISOString(), from, text: text.trim() };
        fs.mkdirSync(path.join(home.HOME, 'inbox'), { recursive: true });
        for (const n of targets) {
            fs.appendFileSync(INBOX(n), `${JSON.stringify(msg)}\n`);
        }
        return { delivered: targets };
    },

    eval({ name, vs = ['rush', 'heuristic'], seeds = 2, version, token } = {}) {
        owned(name, token);
        need(Array.isArray(vs) && vs.length && vs.length <= 6, 'bad_request', 'vs: 1-6 opponent names');
        need(Number.isInteger(seeds) && seeds >= 1 && seeds <= 5, 'bad_request', 'seeds: 1-5 (each played from both seats)');
        const bot = version ?? name;
        const id = `${bot}-${Date.now().toString(36)}`;
        home.writeJson(path.join(home.HOME, 'queue', `${id}.json`), { id, bot, vs, seeds, state: 'queued', queuedAt: new Date().toISOString() });
        return { id, state: 'queued', note: 'the referee plays queued evals between ladders; poll eval_result' };
    },

    eval_result({ id } = {}) {
        const j = home.readJson(path.join(home.HOME, 'queue', `${String(id).replace(/[^\w.-]/g, '')}.json`), null);
        need(j, 'not_found', `no eval "${id}"`);
        return j;
    },

    panel({ name } = {}) {
        competitor(name);
        return home.readJson(path.join(dash.DASH, 'panels', `arena-${name}.json`), null);
    },

    games({ round } = {}) {
        const st = api.standings();
        const k = round ?? st.rounds[st.rounds.length - 1]?.round;
        need(k !== undefined, 'not_found', 'no rounds yet');
        const idx = home.readJson(path.join(home.RESULTS, `arena-r${k}`, 'index.json'), null);
        need(idx, 'not_found', `no games for round ${k}`);
        return { round: k, replayBase: `replays/arena-r${k}/games/`, games: idx.games };
    },

    async wait({ timeoutSec = 300, round } = {}) {
        // Long-poll for the next round: returns as soon as the work phase of a round after `round` (default: the
        // current one) has started, or after timeoutSec (max 900) with the status as it is.
        const start = clock();
        const after = round ?? (start.phase === 'work' ? start.round - 1 : start.round ?? -1);
        const until = Date.now() + Math.min(900, Math.max(1, timeoutSec)) * 1000;
        for (;;) {
            const c = clock();
            if (c.phase === 'work' && c.round > after) {
                return { started: true, ...api.status() };
            }
            if (c.phase === 'done' || Date.now() > until) {
                return { started: false, ...api.status() };
            }
            await new Promise((r) => setTimeout(r, 3000));
        }
    },

    inbox({ name, since, token } = {}) {
        owned(name, token);
        const f = INBOX(name);
        const all = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
        return { messages: since ? all.filter((m) => m.t > since) : all };
    }
};

/** Calls a method by name with an args object; resolves {result} or {error: {code, message}}. */
async function call(method, args = {}) {
    if (!Object.prototype.hasOwnProperty.call(api, method)) {
        return { error: { code: 'not_found', message: `unknown method "${method}" (known: ${Object.keys(api).join(', ')})` } };
    }
    try {
        return { result: await api[method](args ?? {}) };
    } catch (e) {
        return { error: { code: e.code ?? 'internal', message: e.message } };
    }
}

const METHODS = {
    status: { desc: 'Tournament clock (round, phase work/ladder/done, deadline, minutes left), time cap, and every competitor with its latest version and Elo.', props: {} },
    register: { desc: 'Register a new competitor with a starting bot; submits it as v0.', props: { name: 'string', title: 'string', philosophy: 'string', start: 'string', harness: 'object', owner: 'string' }, required: ['name'] },
    submit: { token: true, desc: 'Freeze your bot as your next version; the referee rates your newest version at the end of each round. With no bot, freezes your live folder (agents/<name>/ in the arena folder). From another machine pass bot = {kind:"js", files:{"bot.js": source, ...}} (self-contained CommonJS, exports createBot(name)), or {kind:"stdio", cmd, args} for a program speaking the stdio protocol.', props: { name: 'string', note: 'string', bot: 'object' }, required: ['name', 'note'] },
    versions: { desc: 'Your submitted versions and their notes.', props: { name: 'string' }, required: ['name'] },
    standings: { desc: 'Every rated round so far with per-bot results and the all-round Elo.', props: {} },
    report: { desc: 'A round report in markdown: standings, results per opponent, lost games with replay paths. Default: latest round.', props: { round: 'integer' } },
    say: { token: true, desc: 'Post your current thinking to your live dashboard panel. text = one thought, now = what you are doing, idea = current idea, plan = list of steps, diagram = a strategy diagram (schema swu-strategy/1: {title, caption, nodes:[{id,label,kind:input|memory|feature|decision|action,value,note}], edges:[{from,to,weight,label}], highlight:[ids], steps:[{caption,highlight}]}) that the arena animates to show the essence of your current strategy.', props: { name: 'string', text: 'string', now: 'string', idea: 'string', plan: 'array', diagram: 'object' }, required: ['name'] },
    send: { token: true, desc: 'Leave a message in a competitor inbox (to = name or "all").', props: { to: 'string', text: 'string', from: 'string' }, required: ['to', 'text'] },
    eval: { token: true, desc: 'Queue test games on the arena server: your live bot (or `version`) vs each name in `vs`, `seeds` seeds from both seats. Returns an id for eval_result. Use this when you cannot run the engine yourself.', props: { name: 'string', vs: 'array', seeds: 'integer', version: 'string' }, required: ['name'] },
    eval_result: { desc: 'State and results of a queued eval: queued, running, done (W-L per opponent, ms per decision, lost games with replay paths).', props: { id: 'string' }, required: ['id'] },
    wait: { desc: 'Block until the next round starts (or timeoutSec, max 900, passes). Call it in a loop when you are waiting for a round; it returns the status.', props: { timeoutSec: 'integer', round: 'integer' } },
    panel: { desc: "A competitor's live dashboard panel: now, idea, plan, thoughts, Elo and speed widgets.", props: { name: 'string' }, required: ['name'] },
    games: { desc: 'Games of a round (default latest) with outcome, winner and timing; replays at replayBase + id + .jsonl.', props: { round: 'integer' } },
    inbox: { token: true, desc: 'Messages for you (from Eric, the referee or others), oldest first. Read it at the start of every round.', props: { name: 'string', since: 'string' }, required: ['name'] }
};

module.exports = { api, call, clock, METHODS, ArenaError, TOURNAMENT };
