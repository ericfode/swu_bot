'use strict';

/**
 * Dump the card pool (cards.js) as JSON for the Python deck models, so they need no engine:
 *   node bot/deckbuild/export-cards.js [out.json]     # default /mnt/project-files/deckbuild/cards.json
 * { leaders: [...], bases: [...], main: [...], alias: { reprintCode: canonicalCode } }, each card as in CardPool.
 */
const fs = require('fs');
const path = require('path');
const { Env } = require('../env');
const { CardPool } = require('./cards');

const out = process.argv[2] ?? '/mnt/project-files/deckbuild/cards.json';
const pool = new CardPool(new Env());
const alias = {};
for (const [code, c] of pool.byCode) {
    if (code !== c.setCode) {
        alias[code] = c.setCode;
    }
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ leaders: pool.leaders, bases: pool.bases, main: pool.main, alias }));
console.log(`${pool.leaders.length} leaders, ${pool.bases.length} bases, ${pool.main.length} main cards -> ${out}`);
