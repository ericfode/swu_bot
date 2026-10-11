'use strict';
// Determinism gate: node bot/gate.js  -> seeds 1-3 must give 594/342/486 steps, p2 winning, with and without recording.
const { Env } = require('./env');
const { playGame } = require('./match');
const { snapshot } = require('./recorder');
const { createRandomBot } = require('./players/random');

(async () => {
    const env = new Env();
    const bots = [createRandomBot('random-a'), createRandomBot('random-b')];
    for (const seed of [1, 2, 3]) {
        const plain = await playGame(env, { seed, bots });
        const rec = await playGame(env, { seed, bots, record: true, snapshot });
        const bytes = rec.events.map((e) => JSON.stringify(e)).join('\n').length;
        console.log(JSON.stringify({ seed, plain: [plain.steps, plain.winner, plain.round], rec: [rec.steps, rec.winner, rec.round], kb: Math.round(bytes / 1024), err: rec.error }));
    }
})();
