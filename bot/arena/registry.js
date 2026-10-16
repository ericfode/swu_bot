'use strict';
/**
 * Arena bot registry (hooked into players/index.js). A competitor's bot is a self-contained folder whose bot.js
 * exports createBot(name), which returns a native bot ({ choose }) or a protocol client ({ decide }, spec/protocol.md).
 * Names resolve as:
 *   <agent>        the live, editable version in <ARENA_HOME>/agents/<agent>/
 *   <agent>-v<N>   submitted version N in <ARENA_HOME>/versions/<agent>-v<N>/ (what the referee rates); a version whose
 *                  SUBMISSION.json has bot.kind 'stdio' is a bot program (bot/stdio.js StdioClient), started in its
 *                  version folder for each game and closed after it, with $SWU_CARD_JSON naming the card data; one
 *                  of kind 'wasm' is a WebAssembly bundle in its bundle/ folder, run the same way under bot/compiled/run.py
 * Anything after '#' is ignored (same as players/index.js).
 *
 * The time cap is not applied here: the game runner (ladder-worker.js) guards every bot, baselines included, with
 * players/guard.js. A bot whose bot.js throws or does not return a bot makes makeArenaBot throw; the runner scores that
 * as a load failure (a loss).
 */
const fs = require('fs');
const path = require('path');
const { StdioClient } = require('../stdio');
const { AGENTS, VERSIONS, readJson } = require('./home');

const NAME = /^[a-z][a-z0-9_]*$/;
// where bot programs find the card data (the folder that holds Card/): they run in their version folder, which has none.
// The bots' own convention: $SWU_CARD_JSON, else forceteki/test/json under the working directory
const CARD_JSON = process.env.SWU_CARD_JSON || path.join(__dirname, '..', '..', 'forceteki', 'test', 'json');
// a WebAssembly bundle (bot/compiled/README.md) is kept in bundle/ of its version folder and runs in the wasmtime sandbox:
// its own files read-only, the card data, stdin and stdout, nothing else
// (python3 -I: nothing from the HOME or the environment of the bots' user loads into the process that runs the bot)
const WASM_BOT = { cmd: 'python3', args: ['-I', path.join(__dirname, '..', 'compiled', 'run.py'), 'bundle'], label: 'the bundle in the sandbox' };

function resolveArena(name) {
    const base = String(name).split('#')[0];
    const v = /^([a-z][a-z0-9_]*)-v(\d+)$/.exec(base);
    if (v && fs.existsSync(path.join(VERSIONS, base))) {
        const sub = readJson(path.join(VERSIONS, base, 'SUBMISSION.json'), {});
        if (sub.bot?.kind === 'stdio') {
            return { stdio: sub.bot, dir: path.join(VERSIONS, base), agent: v[1], version: Number(v[2]) };
        }
        if (sub.bot?.kind === 'wasm') {
            // a WebAssembly bundle in bundle/, run in the wasmtime sandbox by this checkout's bot/compiled/run.py
            return { stdio: { ...WASM_BOT, lang: 'wasm' }, dir: path.join(VERSIONS, base), agent: v[1], version: Number(v[2]) };
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
    return r ? { name, kind: 'arena', profile: r.agent, depth: null, lang: r.stdio ? String(r.stdio.lang ?? 'external') : 'js', version: r.version } : null;
}

function makeArenaBot(name) {
    const r = resolveArena(name);
    if (!r) {
        return null;
    }
    if (r.stdio) {
        // a bot program in its frozen version folder (cmd ./x is a file there). The guard times it by wall clock, and with
        // a cap the per-game budget, not the referee's per-message limits, decides a slow answer (ladder-worker.js)
        const cmd = /[\\/]/.test(r.stdio.cmd) ? path.join(r.dir, r.stdio.cmd) : r.stdio.cmd;
        return new StdioClient(name, { cmd, args: r.stdio.args ?? [], cwd: r.dir, env: { SWU_CARD_JSON: CARD_JSON } });
    }
    const bot = require(r.file).createBot(name);
    if (!bot || (typeof bot.choose !== 'function' && typeof bot.decide !== 'function')) {
        throw new Error(`${name}: createBot() did not return a bot with a choose() or decide() method`);
    }
    bot.name = name;
    return bot;
}

module.exports = { resolveArena, describeArenaBot, makeArenaBot, CARD_JSON, WASM_BOT };
