'use strict';
// Random bot speaking the bot protocol (spec/protocol.md). The same object plays in process or as a program:
//   in process:  playGame(env, { seed, bots: [require('./bot/examples/random-bot').create(), other] })
//   as a program: register {"cmd": "node", "args": ["bot/examples/random-bot.js"]} in bot/external-bots.json
const { seededRng } = require('../rng');
const { serve } = require('../stdio');

function create(name = 'js-random') {
    let rng = seededRng(name);
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
