'use strict';
/**
 * Arena bot registry (hooked into players/index.js). A competitor's bot is a self-contained folder whose bot.js
 * exports createBot(name). Names resolve as:
 *   <agent>        the live, editable version in <ARENA_HOME>/agents/<agent>/
 *   <agent>-v<N>   submitted version N in <ARENA_HOME>/versions/<agent>-v<N>/ (what the referee rates); a version whose
 *                  SUBMISSION.json has bot.kind 'stdio' runs that program through the spec's stdio adapter
 * Anything after '#' is ignored (same as players/index.js).
 *
 * Every arena bot is wrapped with the time cap: once its choose() calls in one game add up to more than
 * roster.thinkCapMs, it throws TIME_FORFEIT, which ends the game; the referee scores that as a loss for that bot.
 */
const fs = require('fs');
const path = require('path');
const { AGENTS, VERSIONS, roster, readJson } = require('./home');

const NAME = /^[a-z][a-z0-9_]*$/;

function resolveArena(name) {
    const base = String(name).split('#')[0];
    const v = /^([a-z][a-z0-9_]*)-v(\d+)$/.exec(base);
    if (v && fs.existsSync(path.join(VERSIONS, base))) {
        const sub = readJson(path.join(VERSIONS, base, 'SUBMISSION.json'), {});
        if (sub.bot?.kind === 'stdio') {
            return { stdio: sub.bot, agent: v[1], version: Number(v[2]) };
        }
        if (fs.existsSync(path.join(VERSIONS, base, 'bot.js'))) {
            return { file: path.join(VERSIONS, base, 'bot.js'), agent: v[1], version: Number(v[2]) };
        }
    }
    if (NAME.test(base) && fs.existsSync(path.join(AGENTS, base, 'bot.js'))) {
        return { file: path.join(AGENTS, base, 'bot.js'), agent: base, version: null };
    }
    return null;
}

function describeArenaBot(name) {
    const r = resolveArena(name);
    return r ? { name, kind: 'arena', profile: r.agent, depth: null, lang: 'js', version: r.version } : null;
}

function makeArenaBot(name) {
    const r = resolveArena(name);
    if (!r) {
        return null;
    }
    let bot;
    if (r.stdio) {
        // a program speaking spec/stdio-protocol.md, through the spec's adapter (bot/players/external.js)
        let ExternalBot;
        try {
            ({ ExternalBot } = require('../players/external'));
        } catch {
            throw new Error(`${name} is a stdio bot, but bot/players/external.js (the spec's adapter) is not in this checkout`);
        }
        bot = new ExternalBot(name, { cmd: r.stdio.cmd, args: r.stdio.args ?? [], cwd: r.stdio.cwd });
    } else {
        bot = require(r.file).createBot(name);
    }
    bot.name = name;
    const cap = roster().thinkCapMs ?? Infinity;
    const inner = bot.choose.bind(bot);
    let used = 0;
    bot.choose = (ctx) => {
        const t = process.hrtime.bigint();
        try {
            return inner(ctx);
        } finally {
            used += Number(process.hrtime.bigint() - t) / 1e6;
            if (used > cap) {
                // eslint-disable-next-line no-unsafe-finally
                throw new Error(`TIME_FORFEIT ${name} thought ${Math.round(used)} ms (cap ${cap})`);
            }
        }
    };
    return bot;
}

module.exports = { resolveArena, describeArenaBot, makeArenaBot };
