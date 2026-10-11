'use strict';
/**
 * Freeze an arena competitor's live bot as its next version; the referee rates the newest version of every agent.
 *
 *   node bot/arena/submit.js <agent> "<one line: what changed and why>" [--no-check]
 *
 * Checks first (unless --no-check) that bot.js loads and that the bot finishes one game against random
 * without throwing, then copies <ARENA_HOME>/agents/<agent>/ to versions/<agent>-v<N>/ with SUBMISSION.json.
 */
const fs = require('fs');
const path = require('path');
const { AGENTS, VERSIONS, versionsOf, writeJson } = require('./home');

function submit(agent, note, { check = true } = {}) {
    const src = path.join(AGENTS, agent);
    if (!fs.existsSync(path.join(src, 'bot.js'))) {
        throw new Error(`no bot at ${src}/bot.js`);
    }
    const n = (versionsOf(agent).pop() ?? -1) + 1;
    const name = `${agent}-v${n}`;
    const dst = path.join(VERSIONS, name);
    fs.mkdirSync(VERSIONS, { recursive: true });
    fs.cpSync(src, dst, { recursive: true, filter: (f) => !f.split(path.sep).some((p) => p.startsWith('.')) });
    writeJson(path.join(dst, 'SUBMISSION.json'), { agent, version: n, name, note: note ?? '', submittedAt: new Date().toISOString(), checked: check });
    return name;
}

async function smokeTest(agent) {
    const { Env } = require('../env');
    const { playGame } = require('../match');
    const { makeBot } = require('../players');
    const env = new Env();
    const res = await playGame(env, { seed: 777, bots: [makeBot(agent), makeBot('random')], maxSteps: 3000 });
    if (res.outcome === 'ERROR') {
        throw new Error(`smoke game vs random failed: ${res.error}`);
    }
    return res;
}

if (require.main === module) {
    (async () => {
        const [agent, note] = process.argv.slice(2);
        if (!agent || !note) {
            throw new Error('usage: node bot/arena/submit.js <agent> "<what changed and why>" [--no-check]');
        }
        const check = !process.argv.includes('--no-check');
        if (check) {
            const r = await smokeTest(agent);
            console.log(`smoke game vs random: ${r.outcome} ${r.winner ?? ''}, ${r.steps} steps, my think ${Math.round(r.timing.p1.ms)} ms`);
        }
        console.log(`submitted ${submit(agent, note, { check })}`);
        process.exit(0);
    })().catch((e) => {
        console.error(e.message || e);
        process.exit(1);
    });
}

module.exports = { submit };
