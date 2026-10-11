'use strict';
/**
 * Freeze an arena competitor's live bot as its next version; the referee rates the newest version of every agent.
 *
 *   node bot/arena/submit.js <agent> "<one line: what changed and why>" [--no-check]
 *
 * Plays one smoke game against random first (unless --no-check), then submits through the API, the same as the
 * `submit` tool: the live folder is copied to a staging folder, load-checked (require bot.js, call createBot) and renamed
 * to versions/<agent>-v<N>/ in one step. ARENA_COMPETITOR_TOKEN is sent as the token on an arena with ARENA_AUTH=1.
 */
const { api } = require('./api');

/** Submits through the API (atomic: staged, load-checked, then renamed into versions/); returns the version name. */
function submit(agent, note) {
    return api.submit({ name: agent, note, token: process.env.ARENA_COMPETITOR_TOKEN }).version;
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
        if (!process.argv.includes('--no-check')) {
            const r = await smokeTest(agent);
            console.log(`smoke game vs random: ${r.outcome} ${r.winner ?? ''}, ${r.steps} steps, my think ${Math.round(r.timing.p1.ms)} ms`);
        }
        console.log(`submitted ${submit(agent, note)}`);
        process.exit(0);
    })().catch((e) => {
        console.error(e.message || e);
        process.exit(1);
    });
}

module.exports = { submit };
