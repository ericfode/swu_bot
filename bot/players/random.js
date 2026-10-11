'use strict';

/** Uniform random bot: picks any legal action. Consumes exactly one rng() per decision. */
function createRandomBot(name = 'random') {
    return {
        name,
        choose({ actions, rng }) {
            return actions[Math.floor(rng() * actions.length)];
        }
    };
}

module.exports = { createRandomBot };
