'use strict';
// Random bot speaking the bot protocol (spec/protocol.md), kept as a test fixture for the compiled-bot sandbox: the
// tests bundle it (bot/test/compiled.test.js) and bot/compiled/build.py builds it as node-random. The example clients
// themselves live in ericfode/holocron (bots/examples). The same object plays in process or as a program:
//   in process:  playGame(env, { seed, bots: [require('./bot/test/fixtures/random-bot').create(), other] })
//   as a program: node bot/test/fixtures/random-bot.js <name>
const { seededRng } = require('../../rng');
const { serve } = require('../../stdio');

function create(name = 'js-random') {
    let rng = null; // seeded at hello
    return {
        name,
        hello(msg) {
            rng = seededRng(msg.seed);
            return { t: 'ready', v: 2, name };
        },
        decide(msg) {
            return { t: 'act', i: Math.floor(rng() * msg.actions.length) };
        }
    };
}

module.exports = { create };
if (require.main === module) {
    serve(create(process.argv[2]));
}
