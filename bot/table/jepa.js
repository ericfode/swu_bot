'use strict';
/**
 * The JEPA bot at a table: jepa-tx-gate (holocron's bots/jepa, its JavaScript port vendored in vendor/jepa) as an
 * in-process protocol client, the bot the hosted table offers (Eric, 2026-10-15: "Just the jepa bot"). It runs where
 * the referee runs: in the person's browser tab on the play page (host.js), or in Node for serve.js and the tests. Its
 * planner asks the referee for simulations, which re-deal the person's hidden cards, as for any opponent.
 *
 *   const make = jepaMaker();   // reads the two models and the card data once
 *   const bot = make();         // a fresh bot for one game
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const VENDOR = path.join(ROOT, 'vendor', 'jepa');
const JEPA_NAME = 'jepa-tx-gate';
// jepa-tx-gate's settings (holocron bots/external-bots.json), with tx-t10 as the planner's judge
const SETTINGS = { score: 'plan', mix: 0, windowHorizon: 's', followHorizon: 's', resource: 'c-clock', plan: { gate: 0.04 } };

/** Every card file of the engine's card data, parsed (the bot reads printed stats from them). */
function readCards(dir) {
    const out = [];
    for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.json')) {
            try {
                out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
            } catch {
                // a file that is not JSON is skipped, as the Python bot skips it
            }
        }
    }
    return out;
}

function jepaMaker({ cardDir = path.join(ROOT, 'forceteki', 'test', 'json', 'Card') } = {}) {
    const J = require('../../vendor/jepa/jepa.js');
    const read = (f) => J.loadModel(fs.readFileSync(path.join(VENDOR, f)));
    const model = read('tx-t10.safetensors');
    const windowModel = read('tx-t10-e.safetensors');
    const cards = J.cardTables(readCards(cardDir));
    return () => new J.JepaBot({ name: JEPA_NAME, model, windowModel, planModel: model, cards, ...SETTINGS });
}

module.exports = { jepaMaker, JEPA_NAME };
