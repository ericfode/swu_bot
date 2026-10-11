'use strict';

/**
 * Bot registry: a bot name resolves to a fresh bot instance. Shared by tournament.js and ladder.js.
 *
 *   random, random-a, ...       uniform random
 *   rush                        rule-based, no lookahead
 *   heuristic[-dN]              one-ply rollback search, original ("balanced") evaluation
 *   aggro|tempo|control[-dN]    same search with a different evaluation profile (players/profiles.js)
 *   ismcts[-bB][-hH][-nN]       known-decklist ISMCTS (players/ismcts.js): belief sharpness B (default 1, 0 = uniform),
 *                               horizon H exchanges (default 1), N iterations per legal action (default 8).
 *                               `-peek` is an UNFAIR control that searches the real hidden cards (no sampling), to
 *                               measure what hidden information is worth; keep it out of competitive ladders.
 *
 * `-dN` sets search depth (my next N actions). Anything after `#` is ignored, so the same bot can be entered twice
 * (`aggro#1,aggro#2`) as a sanity check: the two copies should rate about equal.
 */
const { createRandomBot } = require('./random');
const { createRushBot } = require('./rush');
const { HeuristicBot } = require('./heuristic');
const { PROFILES } = require('./profiles');
const { IsmctsBot } = require('./ismcts');

/** ismcts-b2-h1-n8 -> {beta: 2, horizon: 1, iterPerAction: 8}; null when the name is not an ismcts name. */
function parseIsmcts(kindAndOpts) {
    const m = /^ismcts((?:-[bhn][0-9.]+)*)(-peek)?$/.exec(kindAndOpts);
    if (!m) {
        return null;
    }
    const opts = { beta: 1, horizon: 1, iterPerAction: 8, peek: !!m[2] };
    for (const [, k, v] of m[1].matchAll(/-([bhn])([0-9.]+)/g)) {
        opts[{ b: 'beta', h: 'horizon', n: 'iterPerAction' }[k]] = Number(v);
    }
    return opts;
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
    const ism = parseIsmcts(name.split('#')[0]);
    if (ism) {
        return { name, kind: 'search', profile: ism.peek ? 'ismcts-peek' : `ismcts-b${ism.beta}`, depth: ism.horizon, lang: 'js', beta: ism.beta };
    }
    const { kind, depth } = parseName(name);
    if (kind === 'heuristic' || PROFILES[kind]) {
        return { name, kind: 'search', profile: kind === 'heuristic' ? 'balanced' : kind, depth, lang: 'js' };
    }
    if (kind === 'rush') {
        return { name, kind: 'rules', profile: 'rush', depth: 0, lang: 'js' };
    }
    if (/^random/.test(kind)) {
        return { name, kind: 'random', profile: null, depth: 0, lang: 'js' };
    }
    return null;
}

function makeBot(name) {
    const info = describeBot(name);
    if (!info) {
        throw new Error(`unknown bot "${name}" (known: random*, rush, heuristic, ${Object.keys(PROFILES).join(', ')}; optional -dN)`);
    }
    const ism = parseIsmcts(name.split('#')[0]);
    if (ism) {
        return new IsmctsBot(name, { ...ism, thoughts: thoughtsWriter(name) });
    }
    if (info.kind === 'search') {
        return new HeuristicBot(name, { depth: info.depth, profile: PROFILES[info.profile] });
    }
    if (info.kind === 'rules') {
        return createRushBot(name);
    }
    return createRandomBot(name);
}

module.exports = { makeBot, describeBot, parseName, parseIsmcts };
