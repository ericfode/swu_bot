'use strict';
/**
 * The JEPA bot at a table: jepa-tx-gate (holocron's bots/jepa, its JavaScript port vendored in vendor/jepa) as an
 * in-process protocol client, the bot the hosted table offers (Eric, 2026-10-15: "Just the jepa bot"). It runs where
 * the referee runs: in the person's browser tab on the play page (host.js), or in Node for serve.js and the tests. Its
 * planner asks the referee for simulations, which re-deal the person's hidden cards, as for any opponent. Its card
 * tables (printed stats by set code) come from each game's hello.cards, so it reads no card files.
 *
 *   const make = jepaMaker();   // reads the two models once
 *   const bot = make();         // a fresh bot for one game
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const VENDOR = path.join(ROOT, 'vendor', 'jepa');
const JEPA_NAME = 'jepa-tx-gate';
// jepa-tx-gate's settings (holocron bots/external-bots.json), with tx-t10 as the planner's judge
const SETTINGS = { score: 'plan', mix: 0, windowHorizon: 's', followHorizon: 's', resource: 'c-clock', plan: { gate: 0.04 } };

/** An in-process protocol client that makes a JepaBot at each hello, from the models and that hello's card data. */
class TableJepa {
    constructor(J, settings) {
        this.name = JEPA_NAME;
        this.J = J;
        this.settings = settings;
        this.bot = null;
    }

    /** The current game's counts (playGame's botStats). */
    get stats() {
        return this.bot?.stats ?? null;
    }

    hello(msg) {
        this.bot = new this.J.JepaBot({ ...this.settings, cards: this.J.cardTables(msg.cards) });
        return this.bot.hello(msg);
    }

    decide(msg, sim) {
        return this.bot.decide(msg, sim);
    }

    over(msg) {
        return this.bot.over(msg);
    }
}

function jepaMaker() {
    const J = require('../../vendor/jepa/jepa.js');
    const read = (f) => J.loadModel(fs.readFileSync(path.join(VENDOR, f)));
    const model = read('tx-t10.safetensors');
    const windowModel = read('tx-t10-e.safetensors');
    return () => new TableJepa(J, { name: JEPA_NAME, model, windowModel, planModel: model, ...SETTINGS });
}

module.exports = { jepaMaker, JEPA_NAME };
