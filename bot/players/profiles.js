'use strict';

/**
 * Evaluation profiles for HeuristicBot. Each is a set of overrides on the base weights (`weights`, see W in
 * heuristic.js) and the per-side multipliers (`side`, see SIDE). The search is identical across profiles; only
 * what the bot thinks a "good position" is changes, which is what makes the play styles differ.
 */
const PROFILES = {
    // the original evaluation weights (with the base-danger sign fixed)
    balanced: {},

    // the original evaluation exactly as first written, including the inverted base-danger term, for comparison
    legacy: { side: { legacyDanger: true } },

    // race the opponent's base: their base damage counts double, board presence matters less, own base is spent freely
    aggro: {
        weights: { power: 1.8, hp: 0.6, hand: 1.0, initiative: 1.0, exhaustedMult: 1.0 },
        side: { myBase: 1.0, oppBase: 3.0, myUnits: 0.8, oppUnits: 0.8, baseDangerHp: 15 }
    },

    // develop efficiently: resources, initiative and cost-on-board are worth more; exhausting units is cheap
    tempo: {
        weights: { power: 1.5, cost: 0.5, resource: 2.2, initiative: 4.0, exhaustedMult: 0.95 }
    },

    // protect the base and grind: enemy units count more (so removal is valued), durable units, sentinels, cards in hand
    control: {
        weights: { hp: 1.2, sentinel: 2.5, shield: 3.0, hand: 2.6, exhaustedMult: 0.75 },
        side: { myBase: 2.2, oppBase: 1.0, myUnits: 1.0, oppUnits: 1.4, baseDangerHp: 16 }
    }
};

module.exports = { PROFILES };
