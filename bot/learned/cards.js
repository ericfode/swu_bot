'use strict';

/**
 * Printed card data by set code ("SOR_232"), read from forceteki/test/json/Card once per process.
 * Features use it to know the cost, stats and types of cards that the snapshot only names.
 */
const fs = require('fs');
const path = require('path');

let db = null;

const code = (s) => `${s.set}_${String(s.number).padStart(3, '0')}`;

function cardDb(dir = path.join(__dirname, '..', '..', 'forceteki', 'test', 'json', 'Card')) {
    if (db) {
        return db;
    }
    db = new Map();
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) {
            continue;
        }
        const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const entry = {
            cost: c.cost ?? 0, power: c.power ?? 0, hp: c.hp ?? 0, types: c.types ?? [], keywords: c.keywords ?? [],
            arena: c.arena ?? null, unique: !!c.unique, upgradePower: c.upgradePower ?? 0, upgradeHp: c.upgradeHp ?? 0
        };
        for (const s of c.setCodes ?? (c.setId ? [c.setId] : [])) {
            db.set(code(s), entry);
        }
    }
    return db;
}

module.exports = { cardDb };
