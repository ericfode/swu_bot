'use strict';

/**
 * Bot registry: a bot name resolves to a fresh bot instance. Shared by tournament.js and ladder.js.
 *
 *   random, random-a, ...       uniform random
 *   rush                        rule-based, no lookahead
 *   heuristic[-dN]              one-ply rollback search, original ("balanced") evaluation
 *   aggro|tempo|control[-dN]    same search with a different evaluation profile (players/profiles.js)
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

function describeBot(name) {
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
        const known = ['random*', 'rush', 'heuristic', ...Object.keys(PROFILES), ...Object.keys(externalBots)];
        throw new Error(`unknown bot "${name}" (known: ${known.join(', ')}; optional -dN)`);
    }
    if (info.kind === 'external') {
        return new ExternalBot(name, externalBots[name.split('#')[0]]);
    }
    if (info.kind === 'search') {
        return new HeuristicBot(name, { depth: info.depth, profile: PROFILES[info.profile] });
    }
    if (info.kind === 'rules') {
        return createRushBot(name);
    }
    return createRandomBot(name);
}

module.exports = { makeBot, describeBot, parseName };
