'use strict';

/**
 * Reference decks for each leader and base of the field: the stat deck (decks.js statDeck) and one random deck,
 * as SWUDB lists. They are build.py starting points and the baselines in field-eval.js runs.
 *   node bot/deckbuild/make-starts.js OUT_DIR [--field bot/decks/ash-meta-2026-09.json] [--seed s]
 * Writes OUT_DIR/stat.json, OUT_DIR/random.json and OUT_DIR/real.json (the field decks renamed real:<name>).
 */
const fs = require('fs');
const path = require('path');
const { Env } = require('../env');
const { CardPool } = require('./cards');
const { fromList, toList, randomDeck, statDeck } = require('./decks');
const { seededRng } = require('../rng');

const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : d;
};
const out = process.argv[2];
const pool = new CardPool(new Env());
const field = JSON.parse(fs.readFileSync(arg('field', path.join(__dirname, '../decks/ash-meta-2026-09.json')), 'utf8')).map((l) => fromList(l, pool));
const rng = seededRng(arg('seed', 'starts'));
fs.mkdirSync(out, { recursive: true });
const write = (name, decks) => fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(decks.map(toList)));
write('stat', field.map((d) => statDeck(pool, d.leader, d.base, { name: `stat:${d.name}` })));
write('random', field.map((d) => randomDeck(pool, d.leader, d.base, rng, { name: `random:${d.name}` })));
write('real', field.map((d) => ({ ...d, name: `real:${d.name}` })));
console.log(`${field.length} targets -> ${out}/{stat,random,real}.json`);
