'use strict';
// Bot names -> fresh bot objects, matching bot/tournament.js makeBot (kept separate so arena workers can load it).
const { createRandomBot } = require('../players/random');
const { HeuristicBot } = require('../players/heuristic');
const { LearnedPolicyBot, LearnedSearchBot } = require('./bots');

function makeBot(name) {
    if (/^heuristic/.test(name)) {
        const d = /-d(\d)/.exec(name);
        return new HeuristicBot(name, { depth: d ? Number(d[1]) : 1 });
    }
    if (/^learned-v/.test(name)) {
        return new LearnedSearchBot(name);
    }
    if (/^learned/.test(name)) {
        return new LearnedPolicyBot(name);
    }
    return createRandomBot(name);
}

module.exports = { makeBot };
