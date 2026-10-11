'use strict';
// node bot/determinism-check.js [seed] [botName]  -> plays the same seed twice and compares every recorded step.
const crypto = require('crypto');
const { Env } = require('./env');
const { playGame } = require('./match');
const { snapshot } = require('./recorder');
const { createRandomBot } = require('./players/random');
const { HeuristicBot } = require('./players/heuristic');

(async () => {
    const seed = Number(process.argv[2] ?? 1);
    const name = process.argv[3] ?? 'heuristic-v1';
    const d = /-d(\d)/.exec(name);
    const env = new Env();
    const run = async () => {
        const bots = [new HeuristicBot(name, { depth: d ? Number(d[1]) : 1 }), createRandomBot('random')];
        const r = await playGame(env, { seed, bots, record: true, snapshot });
        const hash = crypto.createHash('sha1').update(r.events.map((e) => JSON.stringify(e)).join('\n')).digest('hex').slice(0, 12);
        return { steps: r.steps, winner: r.winner, round: r.round, outcome: r.outcome, hash, ms: r.ms };
    };
    const a = await run();
    const b = await run();
    console.log(JSON.stringify({ seed, name, a, b, identical: a.hash === b.hash }));
})().catch((e) => {
    console.error(e); process.exit(1);
});
