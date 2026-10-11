'use strict';

/**
 * Turn SWUSim / TCGEngine deck fixtures (one .txt file per deck) into one deck file for `bot/ladder.js --decks`.
 *
 *   node bot/decks/import-swusim.js <fixture dir> <out prefix>
 *
 * Writes <out prefix>.json (the decks, named after their files, sideboards left out) and, when the folder has a
 * real_matchups.json, <out prefix>.human.json: the human results for the same decks with only the numbers kept
 * (per deck: field decks and game win rate; per pair: games, matches, win rates, 95% CI, thin). Comment lines in the
 * fixtures and the event list and notes in real_matchups.json are dropped: they can identify players.
 */

const fs = require('fs');
const path = require('path');
const { parseDeckText } = require('../decklists');

function main() {
    const [dir, prefix] = process.argv.slice(2);
    if (!dir || !prefix) {
        console.error('usage: node bot/decks/import-swusim.js <fixture dir> <out prefix>');
        process.exit(2);
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
    const decks = files.map((f) => parseDeckText(fs.readFileSync(path.join(dir, f), 'utf8'), f.replace(/\.txt$/, '')));
    const lines = (list) => `[\n${list.map((x) => JSON.stringify(x)).join(',\n')}\n]\n`;
    fs.writeFileSync(`${prefix}.json`, lines(decks));
    console.log(`${prefix}.json: ${decks.length} decks, ${new Set(decks.map((d) => d.leader.id)).size} leaders`);
    const mf = path.join(dir, 'real_matchups.json');
    if (fs.existsSync(mf)) {
        const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
        const names = new Set(decks.map((d) => d.metadata.name));
        const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
        const archetypes = Object.fromEntries(Object.entries(m.archetypes ?? {}).filter(([k]) => names.has(k))
            .map(([k, v]) => [k, pick(v, ['fieldDecks', 'gameWinPct', 'key', 'label'])]));
        const cells = Object.fromEntries(Object.entries(m.cells ?? {}).filter(([k]) => names.has(k))
            .map(([a, row]) => [a, Object.fromEntries(Object.entries(row).filter(([b]) => names.has(b))
                .map(([b, c]) => [b, pick(c, ['games', 'matches', 'gameWinPct', 'matchWinPct', 'gameWinCI95', 'thin'])]))]));
        const human = { source: pick(m.source ?? {}, ['decks', 'events']), archetypes, cells };
        const obj = (o) => `{\n${Object.entries(o).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n }`;
        fs.writeFileSync(`${prefix}.human.json`, `{\n "source": ${JSON.stringify(human.source)},\n "archetypes": ${obj(archetypes)},\n "cells": ${obj(cells)}\n}\n`);
        console.log(`${prefix}.human.json: ${Object.keys(archetypes).length} decks, ${Object.values(cells).reduce((a, r) => a + Object.keys(r).length, 0)} pair cells`);
    }
}

main();
