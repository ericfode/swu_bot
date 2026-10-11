'use strict';
// Determinism gate: node bot/gate.js  -> seeds 1-3 must give 594/342/486 steps, p2 winning, with and without recording.
const { Env } = require('./env');
const { playGame } = require('./match');
const { snapshot } = require('./recorder');
const { createRandomBot } = require('./players/random');

const EXPECTED = { 1: 594, 2: 342, 3: 486 };

(async () => {
    const env = new Env();
    const broken = [];
    const bots = [createRandomBot('random-a'), createRandomBot('random-b')];
    for (const seed of [1, 2, 3]) {
        const plain = await playGame(env, { seed, bots });
        const rec = await playGame(env, { seed, bots, record: true, snapshot });
        const bytes = rec.events.map((e) => JSON.stringify(e)).join('\n').length;
        console.log(JSON.stringify({ seed, plain: [plain.steps, plain.winner, plain.round], rec: [rec.steps, rec.winner, rec.round], kb: Math.round(bytes / 1024), err: rec.error }));
        for (const [mode, game] of [['plain', plain], ['rec', rec]]) {
            if (game.steps !== EXPECTED[seed] || game.winner !== 'p2' || game.error) broken.push(`seed ${seed} ${mode}: ${game.steps} steps, winner ${game.winner}${game.error ? `, error ${game.error}` : ''} (want ${EXPECTED[seed]}, p2)`);
        }
    }
    if (broken.length) {
        console.error(`gate failed:\n  ${broken.join('\n  ')}`);
        process.exit(1);
    }
    console.log('gate passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
