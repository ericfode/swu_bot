'use strict';
// node bot/eval/proven-frames.js <positions.jsonl>[,<positions.jsonl>...] <out.jsonl>
//
// The omni solver's proven positions (bot/omni/export-positions.js rows with `proven` set) as frames in the same
// format as td-frames.js: the side to move's subjective view, side-feature differences me - opp, then toAct and round.
// y = 1 when the side to move has the forced win.
const fs = require('fs');
const path = require('path');
const { frameFeatures, SIDE_KEYS } = require('./features');
const { cardDb } = require('./cards');

function main() {
    const [inputs, out] = [process.argv[2], process.argv[3]];
    const db = cardDb();
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const lines = [];
    for (const file of inputs.split(',')) {
        const set = path.basename(file).replace(/^positions-|\.jsonl$/g, '');
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line.trim()) {
                continue;
            }
            const r = JSON.parse(line);
            if (r.proven !== 'p1' && r.proven !== 'p2') {
                continue;
            }
            const fr = frameFeatures(r.state, r.toMove, { view: 'subjective', toAct: r.toMove, db });
            const x = [...SIDE_KEYS.map((k) => r3(fr.me[k] - fr.opp[k])), fr.g.toAct, fr.g.round];
            lines.push(JSON.stringify({ set, game: r.game, seed: r.seed, i: r.i, fromEnd: r.fromEnd, toMove: r.toMove, y: r.proven === r.toMove ? 1 : 0, x }));
        }
    }
    fs.writeFileSync(out, `${lines.join('\n')}\n`);
    console.log(`${lines.length} proven positions -> ${out}`);
}

main();
