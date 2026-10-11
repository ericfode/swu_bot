'use strict';
/**
 * Arena bot registry (hooked into players/index.js). A competitor's bot is a self-contained folder whose bot.js
 * exports createBot(name). Names resolve as:
 *   <agent>        the live, editable version in <ARENA_HOME>/agents/<agent>/
 *   <agent>-v<N>   submitted version N in <ARENA_HOME>/versions/<agent>-v<N>/ (what the referee rates); a version whose
 *                  SUBMISSION.json has bot.kind 'stdio' runs that program through the spec's stdio adapter
 * Anything after '#' is ignored (same as players/index.js).
 *
 * The time cap is not applied here: the game runner (ladder-worker.js) guards every bot, baselines included, with
 * players/guard.js. A bot whose bot.js throws or does not return a bot makes makeArenaBot throw; the runner scores that
 * as a load forfeit.
 */
const fs = require('fs');
const path = require('path');
const { AGENTS, VERSIONS, readJson, roster } = require('./home');

const NAME = /^[a-z][a-z0-9_]*$/;

function resolveArena(name) {
    const base = String(name).split('#')[0];
    const v = /^([a-z][a-z0-9_]*)-v(\d+)$/.exec(base);
    if (v && fs.existsSync(path.join(VERSIONS, base))) {
        const sub = readJson(path.join(VERSIONS, base, 'SUBMISSION.json'), {});
        if (sub.bot?.kind === 'stdio') {
            return { stdio: sub.bot, dir: path.join(VERSIONS, base), agent: v[1], version: Number(v[2]) };
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
        // it runs in its frozen version folder (cmd ./x is a file there); one decision may take as long as the watchdog
        // allows (the cap + 30 s), so the per-game cap, not the adapter's own 10 s default, decides a slow answer
        const cap = Number(roster().thinkCapMs);
        const cmd = /[\\/]/.test(r.stdio.cmd) ? path.join(r.dir, r.stdio.cmd) : r.stdio.cmd;
        bot = new ExternalBot(name, { cmd, args: r.stdio.args ?? [], cwd: r.dir, ...(cap > 0 ? { timeoutMs: cap + 30000 } : {}) });
        bot.external ??= true; // it thinks in another process: the guard times it by wall clock
    } else {
        bot = require(r.file).createBot(name);
    }
    if (!bot || typeof bot.choose !== 'function') {
        throw new Error(`${name}: createBot() did not return a bot with a choose() method`);
    }
    bot.name = name;
    return bot;
}

module.exports = { resolveArena, describeArenaBot, makeArenaBot };
