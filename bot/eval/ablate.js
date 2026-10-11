'use strict';
/**
 * Which parts of a position matter? Refit the linear evaluator with one feature group left out at a time and
 * report how much the held-out Brier gets worse. A large rise = the group carries information nothing else has.
 *
 *   node bot/eval/ablate.js --data <dir>[,<dir>...] [--json out.json] [--decks]
 */
const fs = require('fs');
const { loadPositions } = require('./data');
const { frames, stds, fitLinear, meanLoss } = require('./fit');
const { linearLogit } = require('./evaluators');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const GROUPS = {
    'base HP': ['baseHp', 'baseLow'],
    'board size': ['units', 'power', 'hp', 'readyPower', 'groundPower', 'spacePower', 'boardCost'],
    'unit keywords': ['sentinel', 'raid', 'overwhelm', 'saboteur', 'restore', 'grit'],
    'shields and upgrades': ['shields', 'upgrades'],
    leader: ['leaderDeployed', 'leaderReady'],
    resources: ['resources', 'readyResources'],
    'hand size': ['hand'],
    'hand quality': ['handCost', 'handStats', 'handPlayable'],
    'deck and discard': ['deck', 'deckLow', 'discard'],
    'initiative and turn': ['initiative', 'toAct'],
    'damage pressure': ['pressure']
};

function main() {
    const dirs = arg('data', '').split(',').filter(Boolean);
    const decks = process.argv.includes('--decks');
    const all = loadPositions(dirs);
    const train = frames(all.filter((p) => !p.test), decks);
    const test = frames(all.filter((p) => p.test), decks);
    const std = stds(train);
    // fit once per variant, then score the held-out rows
    const evalDrop = (drop) => {
        const m = fitLinear(train, std, { drop });
        return meanLoss(test, (fr) => linearLogit(m, fr));
    };
    const full = evalDrop([]);
    console.log(`all features: test brier ${full.brier.toFixed(4)} logloss ${full.logloss.toFixed(4)}`);
    const out = { createdAt: new Date().toISOString(), data: dirs, decks, full, groups: [] };
    for (const [name, keys] of Object.entries(GROUPS)) {
        const r = evalDrop(keys);
        const only = evalDrop(Object.values(GROUPS).flat().filter((k) => !keys.includes(k)));
        out.groups.push({ name, keys, without: r.brier, delta: r.brier - full.brier, alone: only.brier });
        console.log(`${name.padEnd(22)} without: ${r.brier.toFixed(4)} (+${(r.brier - full.brier).toFixed(4)})   alone: ${only.brier.toFixed(4)}`);
    }
    if (arg('json', null)) {
        fs.writeFileSync(arg('json'), JSON.stringify(out, null, 1));
    }
}

main();
