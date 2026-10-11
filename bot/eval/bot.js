'use strict';

/**
 * The same one-ply lookahead bot (bot/players/heuristic.js) with a swappable position evaluator, so evaluators
 * compete under identical search. Bot names: `h@<evaluator>` (e.g. h@linear, h@race), `h2@<evaluator>` for depth 2.
 *
 * The evaluator sees the position the way the bot would: a recorder snapshot judged from its own seat, opponent
 * hand as a count only. Evaluators fitted with decklists also get both decklists (known decks, as in a tournament).
 */

const path = require('path');
const { HeuristicBot } = require('../players/heuristic');
const { snapshot } = require('../recorder');
const { loadEvaluator } = require('./evaluators');
const { setCodeToString } = require(path.join(__dirname, '..', '..', 'forceteki', 'build/server', 'Util.js'));

const WIN = 10000;

function setCode(card) {
    try {
        return setCodeToString(card.setId);
    } catch {
        return null;
    }
}

/** Both players' 50-card decklists as set codes, read once from the engine. */
function deckLists(eg) {
    const out = {};
    eg.ids.forEach((id, i) => {
        const cards = eg.player(id).allCards.filter((c) => !c.isLeader?.() && !c.isBase?.() && !c.isToken?.());
        out[`p${i + 1}`] = cards.map(setCode).filter(Boolean);
    });
    return out;
}

function snapshotEvaluate(ev) {
    let decks = null;
    return (eg, pid) => {
        if (eg.over) {
            const me = eg.names[eg.ids.indexOf(pid)];
            const w = eg.winners;
            return w.length === 1 ? (w[0] === me ? WIN : -WIN) : 0;
        }
        if (ev.decks && !decks) {
            decks = deckLists(eg);
        }
        const judge = `p${eg.ids.indexOf(pid) + 1}`;
        const actor = eg.ids.findIndex((id) => eg.isActionWindow(id));
        const toAct = actor < 0 ? null : `p${actor + 1}`;
        return ev.logit(ev.frame(snapshot(eg), judge, { view: 'subjective', decks, toAct }));
    };
}

/** `h@linear`, `h2@race`, ... -> a HeuristicBot that scores positions with that evaluator. */
function makeEvalBot(name, displayName = name) {
    const m = /^h(\d)?@(.+)$/.exec(name);
    if (!m) {
        return null;
    }
    const ev = loadEvaluator(m[2]);
    const bot = new HeuristicBot(displayName, { depth: m[1] ? Number(m[1]) : 1, evaluate: snapshotEvaluate(ev) });
    bot.evaluator = ev.name;
    return bot;
}

module.exports = { makeEvalBot, snapshotEvaluate, deckLists };
