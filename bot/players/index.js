'use strict';

/**
 * Bot registry: a bot name resolves to a fresh bot instance. Shared by tournament.js and ladder.js.
 *
 *   random, random-a, ...       uniform random
 *   rush                        rule-based, no lookahead
 *   heuristic[-dN]              one-ply rollback search, original ("balanced") evaluation
 *   aggro|tempo|control[-dN]    same search with a different evaluation profile (players/profiles.js)
 *   ismcts[-bB][-hH][-nN][-eP]  known-decklist ISMCTS (players/ismcts.js): belief sharpness B (default 1, 0 = uniform),
 *                               horizon H exchanges (default 1), N iterations per legal action (default 6).
 *                               `-e<profile>` scores leaves with an evaluation profile (`-etempo`, `-eaggro`, ...).
 *                               `-peek` is an UNFAIR control that searches the real hidden cards (no sampling), to
 *                               measure what hidden information is worth; keep it out of competitive ladders.
 *
 *   h@<evaluator>, hN@<evaluator>  the heuristic search scoring positions with a fitted or hand-made evaluator
 *                               from bot/eval (h@linear, h@mlp-deck, h@race, ...); N = depth
 *
 * `-dN` sets search depth (my next N actions). Anything after `#` is ignored, so the same bot can be entered twice
 * (`aggro#1,aggro#2`) as a sanity check: the two copies should rate about equal.
 *
 * Out-of-process bots (spec/stdio-protocol.md) are listed by name in $SWU_EXTERNAL_BOTS or bot/external-bots.json
 * and take precedence over the built-in names.
 */
const fs = require('fs');
const path = require('path');
const { createRandomBot } = require('./random');
const { createRushBot } = require('./rush');
const { HeuristicBot } = require('./heuristic');
const { ExternalBot } = require('./external');
const { PROFILES } = require('./profiles');
const { IsmctsBot } = require('./ismcts');

/** ismcts-b2-h1-n8 -> {beta: 2, horizon: 1, iterPerAction: 8}; null when the name is not an ismcts name. */
function parseIsmcts(kindAndOpts) {
    const m = /^ismcts((?:-[bhn][0-9.]+)*)(-e[a-z]+)?(-peek)?$/.exec(kindAndOpts);
    if (!m) {
        return null;
    }
    const opts = { beta: 1, horizon: 1, iterPerAction: 6, peek: !!m[3] };
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
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}
const externalBots = loadExternalBots();

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
    const ism = parseIsmcts(name.split('#')[0]);
    if (ism) {
        return { name, kind: 'search', profile: (ism.peek ? 'ismcts-peek' : `ismcts-b${ism.beta}`) + (ism.evalProfile ? `-${ism.evalProfile}` : ''), depth: ism.horizon, lang: 'js', beta: ism.beta };
    }
    const { kind, depth } = parseName(name);
    const ext = externalBots[name.split('#')[0]];
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
    return null;
}

function makeBot(name) {
    const info = describeBot(name);
    if (!info) {
        const known = ['random*', 'rush', 'heuristic', 'h@<evaluator>', ...Object.keys(PROFILES), ...Object.keys(externalBots)];
        throw new Error(`unknown bot "${name}" (known: ${known.join(', ')}; optional -dN)`);
    }
    if (info.kind === 'external') {
        const spec = externalBots[name.split('#')[0]];
        // an entry may name its own adapter class (an ExternalBot subclass), e.g. bot/jev/look.js
        const Adapter = spec.adapter ? require(path.join(__dirname, '..', '..', spec.adapter)) : ExternalBot;
        return new Adapter(name, spec);
    }
    if (info.profile?.startsWith('eval:')) {
        return require('../eval/bot').makeEvalBot(name.split('#')[0], name);
    }
    const ism = parseIsmcts(name.split('#')[0]);
    if (ism) {
        const { evalProfile, ...rest } = ism;
        return new IsmctsBot(name, { ...rest, profile: evalProfile ? PROFILES[evalProfile] : null, thoughts: thoughtsWriter(name) });
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
