'use strict';

/**
 * Bot registry: a bot name resolves to a fresh bot instance. Shared by ladder.js (the arena's round runner, through
 * ladder-worker.js), tournament.js and the arena (bot/arena: api.js checks new names against it, play-seed.js checks
 * what a helper plays).
 *
 *   random, random-a, ...       uniform random
 *   rush                        rule-based, no lookahead
 *   heuristic[-dN]              one-ply rollback search, "balanced" evaluation (original weights, danger sign fixed)
 *   legacy[-dN]                 same search with the original evaluation exactly, inverted danger term included
 *   aggro|tempo|control[-dN]    same search with a different evaluation profile (players/profiles.js)
 *   <agent>, <agent>-v<N>       arena competitor bots (bot/arena/registry.js)
 *
 * `-dN` sets search depth (my next N actions). Anything after `#` is ignored, so the same bot can be entered twice
 * (`aggro#1,aggro#2`) as a sanity check: the two copies should rate about equal.
 *
 * Bot programs (spec/protocol.md) are listed by name in $SWU_EXTERNAL_BOTS or bot/external-bots.json and take
 * precedence over the built-in names. A program serves game after game until closeBots(); a second copy is started
 * only when one game needs two. The research bots (ISMCTS, omni, evaluator and learned bots, the example clients and
 * the bots in other languages) live in ericfode/holocron with its own registry.
 */
const fs = require('fs');
const path = require('path');
const { StdioClient } = require('../stdio');
const { PROFILES } = require('./profiles');
const { describeArenaBot, makeArenaBot } = require('../arena/registry');

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
        // an entry may name its own bot class, built as new Class(name, entry), by its path from the repo root
        // (spec/bot-interface.md)
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

function describeBot(name) {
    const { kind, depth } = parseName(name);
    const ext = programOf(name);
    if (ext) {
        return { name, kind: 'external', profile: null, depth: 0, lang: ext.lang ?? 'external' };
    }
    if (kind === 'heuristic' || PROFILES[kind]) {
        return { name, kind: 'search', profile: kind === 'heuristic' ? 'balanced' : kind, depth, lang: 'js' };
    }
    if (kind === 'rush') {
        return { name, kind: 'rules', profile: 'rush', depth: 0, lang: 'js' };
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
        const known = ['random*', 'rush', 'heuristic', ...Object.keys(PROFILES), ...Object.keys(externalBots)];
        throw new Error(`unknown bot "${name}" (known: ${known.join(', ')}; optional -dN; or an arena entry)`);
    }
    if (info.kind === 'external') {
        return program(name, Array.isArray(taken) ? taken : []);
    }
    // the built-in bots load the engine (env.js), so only a makeBot that needs one loads them: describeBot stays cheap
    // for callers that only read names (gamesctl plan runs every 20 s on the games machine; its tests have no engine)
    if (info.kind === 'search') {
        const { HeuristicBot } = require('./heuristic');
        return new HeuristicBot(name, { depth: info.depth, profile: PROFILES[info.profile] });
    }
    if (info.kind === 'arena') {
        return makeArenaBot(name);
    }
    if (info.kind === 'rules') {
        return require('./rush').createRushBot(name);
    }
    return require('./random').createRandomBot(name);
}

module.exports = { makeBot, closeBots, describeBot, programSpec, parseName };
