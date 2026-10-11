'use strict';
/**
 * Starting strategies for new arena agents. Each one is the shared heuristic.js / rush.js (self-contained copies of
 * bot/players/*.js) plus a bot.js that picks the strategy. new-agent.js copies them into the agent's folder.
 */
const PROFILES = {
    heuristic: null,
    tempo: { weights: { power: 1.5, cost: 0.5, resource: 2.2, initiative: 4.0, exhaustedMult: 0.95 } },
    control: {
        weights: { hp: 1.2, sentinel: 2.5, shield: 3.0, hand: 2.6, exhaustedMult: 0.75 },
        side: { myBase: 2.2, oppBase: 1.0, myUnits: 1.0, oppUnits: 1.4, baseDangerHp: 16 }
    },
    aggro: {
        weights: { power: 1.8, hp: 0.6, hand: 1.0, initiative: 1.0, exhaustedMult: 1.0 },
        side: { myBase: 1.0, oppBase: 3.0, myUnits: 0.8, oppUnits: 0.8, baseDangerHp: 15 }
    }
};

function botSource(start) {
    if (start === 'rush') {
        return `'use strict';
// Starting strategy: rush (rule-based, no lookahead): plays its most expensive card, attacks face, then passes.
const { createRushBot } = require('./rush');

function createBot(name) {
    return createRushBot(name);
}

module.exports = { createBot };
`;
    }
    if (!(start in PROFILES)) {
        throw new Error(`unknown starting strategy "${start}" (known: rush, ${Object.keys(PROFILES).join(', ')})`);
    }
    return `'use strict';
// Starting strategy: ${start} (one-ply rollback search${PROFILES[start] ? `, ${start} evaluation profile` : ', original evaluation'}).
const { HeuristicBot } = require('./heuristic');

const PROFILE = ${JSON.stringify(PROFILES[start], null, 4)};

function createBot(name) {
    return new HeuristicBot(name, { depth: 1, profile: PROFILE });
}

module.exports = { createBot };
`;
}

module.exports = { botSource, STARTS: ['rush', ...Object.keys(PROFILES)] };
