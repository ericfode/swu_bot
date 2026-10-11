'use strict';
// node bot/learned/check-model.js [model.json]: the JS forward pass must reproduce train.py's outputs on the saved check cases.
const fs = require('fs');
const path = require('path');
const { Model } = require('./model');

const file = process.argv[2] ?? path.join(__dirname, '..', '..', 'models', 'learned', 'current.json');
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
const m = new Model(json);
let worst = 0;
for (const c of json.check ?? []) {
    const z = m.encode(c.s);
    worst = Math.max(worst, Math.abs(m.value(z) - c.value));
    m.logits(z, c.p, c.A).forEach((l, i) => {
        worst = Math.max(worst, Math.abs(l - c.logits[i]));
    });
}
console.log(`${(json.check ?? []).length} cases, max abs difference ${worst.toExponential(2)}`);
process.exit((json.check ?? []).length && worst < 1e-3 ? 0 : 1);
