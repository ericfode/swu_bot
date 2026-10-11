'use strict';

/**
 * Bot registry: a bot name resolves to a fresh bot instance. Shared by tournament.js and ladder.js.
 *
 *   random, random-a, ...       uniform random
 *   rush                        rule-based, no lookahead
 *   heuristic[-dN]              one-ply rollback search, "balanced" evaluation (original weights, danger sign fixed)
 *   legacy[-dN]                 same search with the original evaluation exactly, inverted danger term included
 *   aggro|tempo|control[-dN]    same search with a different evaluation profile (players/profiles.js)
 *   <agent>, <agent>-v<N>       arena competitor bots (bot/arena/registry.js)
 *   ismcts[-bB][-hH][-nN][-eP][-vV] known-decklist ISMCTS (players/ismcts.js): belief sharpness B (default 1, 0 = uniform),
 *                               horizon H exchanges (default 1), N iterations per legal action (default 6).
 *                               `-v<evaluator>` scores leaves with a calibrated P(win) from bot/eval (`-vlinear-deck`).
 *                               `-e<profile>` scores leaves with an evaluation profile (`-etempo`, `-eaggro`, ...).
 *                               `-peek` is an UNFAIR control that searches the real hidden cards (no sampling), to
 *                               measure what hidden information is worth; keep it out of competitive ladders.
 *
 *   h@<evaluator>, hN@<evaluator>  the heuristic search scoring positions with a fitted or hand-made evaluator
 *                               from bot/eval (h@linear, h@mlp-deck, h@race, ...); N = depth
 *   omni[-dN][-nN][-blind]      UNFAIR reference bot (players/omniscient.js): full-information alpha-beta, depth N windows
 *                               (default 2), -n node budget per window, -blind hides future draws from its search.
 *                               Keep it out of competitive ladders.
 *
 * `-dN` sets search depth (my next N actions). Anything after `#` is ignored, so the same bot can be entered twice
 * (`aggro#1,aggro#2`) as a sanity check: the two copies should rate about equal.
 *
 * Bot programs (spec/protocol.md) are listed by name in $SWU_EXTERNAL_BOTS or bot/external-bots.json and take
 * precedence over the built-in names. A program serves game after game until closeBots(); a second copy is started
 * only when one game needs two. `js-random` and `js-search` are the in-process example clients (bot/examples).
 */
const fs = require('fs');
const path = require('path');
const { createRandomBot } = require('./random');
const { createRushBot } = require('./rush');
const { HeuristicBot } = require('./heuristic');
const { StdioClient } = require('../stdio');
const examples = { 'js-random': require('../examples/random-bot').create, 'js-search': require('../examples/search-bot').create };
const { PROFILES } = require('./profiles');
const { describeArenaBot, makeArenaBot } = require('../arena/registry');
const { IsmctsBot } = require('./ismcts');
const { OmniscientBot } = require('./omniscient');

/** omni-d1-n300-blind -> {depth: 1, budget: 300, blind: true}; null when the name is not an omni name. Plain letter
 * tags (omni-a, omni-b) only tell copies apart. */
function parseOmni(kindAndOpts) {
    const [head, ...parts] = kindAndOpts.split('-');
    if (head !== 'omni') {
        return null;
    }
    const opts = { depth: 2, blind: false };
    for (const p of parts) {
        const m = /^([dn])(\d+)$/.exec(p);
        if (m) {
            opts[m[1] === 'd' ? 'depth' : 'budget'] = Number(m[2]);
        } else if (p === 'blind') {
            opts.blind = true;
        } else if (!/^[a-z]+$/.test(p)) {
            return null;
        }
    }
    return opts;
}

/**
 * `-v<name>`: score ISMCTS leaves with an evaluator from the position-evaluation bench (bot/eval/evaluators.js:
 * base, material-fixed, race, linear, linear-deck, mlp, mlp-deck, ...). Returns (eg, pid) -> P(pid wins).
 */
function benchValue(name) {
    let ev, snapshotEvaluate;
    try {
        ({ snapshotEvaluate } = require('../eval/bot'));
        ev = require('../eval/evaluators').loadEvaluator(name);
    } catch (e) {
        throw new Error(`ismcts -v${name}: cannot load evaluator "${name}" from bot/eval (${String(e.message).split('\n')[0]})`);
    }
    const logit = snapshotEvaluate(ev); // decided games are handled by the bot itself
    return (eg, pid) => 1 / (1 + Math.exp(-logit(eg, pid)));
}

/** ismcts-b2-h1-n8 -> {beta: 2, horizon: 1, iterPerAction: 8}; null when the name is not an ismcts name. */
function parseIsmcts(kindAndOpts) {
    const m = /^ismcts((?:-[bhn][0-9.]+)*)(-e[a-z]+)?(-v[a-z0-9-]+?)?(-peek)?$/.exec(kindAndOpts);
    if (!m) {
        return null;
    }
    const opts = { beta: 1, horizon: 1, iterPerAction: 6, peek: !!m[4] };
    if (m[3]) {
        opts.evaluator = m[3].slice(2);
    }
    if (m[2]) {
        const prof = m[2].slice(2);
        if (!PROFILES[prof]) {
            return null;
        }
        opts.evalProfile = prof;
    }
    for (const [, k, v] of m[1].matchAll(/-([bhn])([0-9.]+)/g)) {
        opts[{ b: 'beta', h: 'horizon', n: 'iterPerAction' }[k]] = Number(v);
    }
    return opts;
}

// name -> {cmd, args, ...}
function loadExternalBots() {
    const file = process.env.SWU_EXTERNAL_BOTS ?? path.join(__dirname, '..', 'external-bots.json');
    try {
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    } catch (e) {
        throw new Error(`${file}: ${e.message}`);
    }
}
const externalBots = loadExternalBots();
const programOf = (name) => (Object.hasOwn(externalBots, name.split('#')[0]) ? externalBots[name.split('#')[0]] : null);
/** A copy of the bot program entry for `name` ({cmd, args, cwd, adapter, ...}), or null when it is not a bot program. */
const programSpec = (name) => (programOf(name) ? structuredClone(programOf(name)) : null);

const running = new Map();
/** The program client for `name` that is not one of `taken` (the bots already seated in this game). */
function program(name, taken) {
    const pool = running.get(name) ?? [];
    running.set(name, pool);
    let c = pool.find((x) => !taken.includes(x));
    if (!c) {
        const spec = programOf(name);
        // an entry may name its own bot class, built as new Class(name, entry) (bot/jev/look.js)
        const Client = spec.adapter ? require(path.join(__dirname, '..', '..', spec.adapter)) : StdioClient;
        c = new Client(name, spec);
        pool.push(c);
    }
    return c;
}

/** Ends every bot program started by makeBot. Resolves once they have exited; await it before process.exit(). */
function closeBots() {
    const all = [...running.values()].flat();
    running.clear();
    return Promise.all(all.map((c) => c.close()));
}

function parseName(name) {
    const base = name.split('#')[0];
    const d = /-d(\d+)$/.exec(base);
    const kind = d ? base.slice(0, d.index) : base;
    return { kind, depth: d ? Number(d[1]) : 1 };
}

/**
 * With ISMCTS_THOUGHTS=<dir> set, ISMCTS bots write their latest search summary to <dir>/<name>.json (at most once
 * a second, atomically) for the dashboard panel (bot/ismcts-panel.js). Off by default; it never changes play.
 */
function thoughtsWriter(name) {
    const dir = process.env.ISMCTS_THOUGHTS;
    if (!dir) {
        return null;
    }
    const fs = require('fs');
    const path = require('path');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name.replace(/[^\w.#-]/g, '_')}.json`);
    let lastWrite = 0;
    return (bot) => {
        const now = Date.now();
        if (now - lastWrite < 1000) {
            return;
        }
        lastWrite = now;
        const tmp = `${file}.${process.pid}.${require('worker_threads').threadId}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ bot: name, beta: bot.beta, peek: bot.peek, t: new Date(now).toISOString(), stats: bot.stats, ...bot.last }));
        fs.renameSync(tmp, file);
    };
}

function describeBot(name) {
    const ev = /^h(\d)?@(.+)$/.exec(name.split('#')[0]);
    if (ev) {
        return { name, kind: 'search', profile: `eval:${ev[2]}`, depth: ev[1] ? Number(ev[1]) : 1, lang: 'js' };
    }
    const omni = parseOmni(name.split('#')[0]);
    if (omni) {
        return { name, kind: 'omniscient', profile: omni.blind ? 'omni-blind' : 'omni', depth: omni.depth, lang: 'js' };
    }
    const ism = parseIsmcts(name.split('#')[0]);
    if (ism) {
        return { name, kind: 'search', profile: (ism.peek ? 'ismcts-peek' : `ismcts-b${ism.beta}`) + (ism.evalProfile ? `-${ism.evalProfile}` : '') + (ism.evaluator ? `-v${ism.evaluator}` : ''), depth: ism.horizon, lang: 'js', beta: ism.beta };
    }
    const { kind, depth } = parseName(name);
    const ext = programOf(name);
    if (ext) {
        return { name, kind: 'external', profile: null, depth: 0, lang: ext.lang ?? 'external' };
    }
    if (Object.hasOwn(examples, kind)) {
        return { name, kind: 'client', profile: null, depth: 0, lang: 'js' };
    }
    if (kind === 'heuristic' || PROFILES[kind]) {
        return { name, kind: 'search', profile: kind === 'heuristic' ? 'balanced' : kind, depth, lang: 'js' };
    }
    if (kind === 'rush') {
        return { name, kind: 'rules', profile: 'rush', depth: 0, lang: 'js' };
    }
    if (kind === 'learned-pi' || kind === 'learned-v') {
        // bot/learned: tinygrad-trained network, model file from $SWU_LEARNED_MODEL (default models/learned/current.json)
        return { name, kind: 'learned', profile: kind, depth: kind === 'learned-v' ? depth : 0, lang: 'js' };
    }
    if (/^random/.test(kind)) {
        return { name, kind: 'random', profile: null, depth: 0, lang: 'js' };
    }
    // competitor bots from the arena (<ARENA_HOME>/agents/<agent>/, or a frozen <agent>-v<N>)
    return describeArenaBot(name);
}

/**
 * A bot for `name`. `taken`: the bots already seated in this game, so a program is not handed out twice (anything
 * else, such as the index from `names.map(makeBot)`, counts as none).
 */
function makeBot(name, taken) {
    const info = describeBot(name);
    if (!info) {
        const known = ['random*', 'rush', 'heuristic', 'omni', 'h@<evaluator>', 'learned-pi', 'learned-v', ...Object.keys(PROFILES), ...Object.keys(examples), ...Object.keys(externalBots)];
        throw new Error(`unknown bot "${name}" (known: ${known.join(', ')}; optional -dN)`);
    }
    if (info.kind === 'external') {
        return program(name, Array.isArray(taken) ? taken : []);
    }
    if (info.kind === 'client') {
        return examples[parseName(name).kind](name);
    }
    if (info.profile?.startsWith('eval:')) {
        return require('../eval/bot').makeEvalBot(name.split('#')[0], name);
    }
    if (info.kind === 'omniscient') {
        return new OmniscientBot(name, parseOmni(name.split('#')[0]));
    }
    const ism = parseIsmcts(name.split('#')[0]);
    if (ism) {
        const { evalProfile, evaluator, ...rest } = ism;
        return new IsmctsBot(name, { ...rest, profile: evalProfile ? PROFILES[evalProfile] : null, value: evaluator ? benchValue(evaluator) : null, thoughts: thoughtsWriter(name) });
    }
    if (info.kind === 'search') {
        return new HeuristicBot(name, { depth: info.depth, profile: PROFILES[info.profile] });
    }
    if (info.kind === 'arena') {
        return makeArenaBot(name);
    }
    if (info.kind === 'learned') {
        const { LearnedPolicyBot, LearnedSearchBot } = require('../learned/bots');
        return info.profile === 'learned-v' ? new LearnedSearchBot(name, { depth: info.depth }) : new LearnedPolicyBot(name);
    }
    if (info.kind === 'rules') {
        return createRushBot(name);
    }
    return createRandomBot(name);
}

module.exports = { makeBot, closeBots, describeBot, programSpec, parseName, parseIsmcts, parseOmni };
