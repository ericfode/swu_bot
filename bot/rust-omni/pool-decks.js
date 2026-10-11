'use strict';

/**
 * Random 50-card decks from the simulator's card pool (bot/omni/rs/pool.json), as a deck file for the ladder, so
 * rust-omni can search every game in its native simulator:
 *
 *   node bot/rust-omni/pool-decks.js --n 6 --seed 1 --out replays/pool-decks.json
 *   node bot/ladder.js --bots rust-omni,rust-search --decks replays/pool-decks.json --games 30
 */

const fs = require('fs');
const path = require('path');
const { Env, seededRng } = require('../env');
const { loadPool } = require('../omni/rs/pool');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : dflt;
}

const n = Number(arg('n', 6));
const rng = seededRng(`pool-decks-${arg('seed', 1)}`);
const pool = loadPool(arg('pool', path.join(__dirname, '..', 'omni', 'rs', 'pool.json')));
const env = new Env();
// deck names must be unique in a deck file: the ladder reports results per deck
const decks = Array.from({ length: n }, (_, k) => {
    const d = env.randomDeck(rng, { pool });
    return { ...d, metadata: { name: `${d.metadata.name} #${k + 1}` } };
});
const out = arg('out', 'replays/pool-decks.json');
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify(decks, null, 1) + '\n');
console.log(`${n} decks -> ${out}: ${decks.map((d) => d.metadata.name).join(', ')}`);
