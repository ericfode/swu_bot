'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadPool(file) {
    const resolved = path.resolve(file);
    const bytes = fs.readFileSync(resolved);
    const pool = JSON.parse(bytes);
    if (pool.schema !== 'omni-rs-pool-v1' || !Array.isArray(pool.cards)) {
        throw new Error(`Invalid simulator pool: ${file}`);
    }
    const seen = new Set();
    for (const card of pool.cards) {
        if (!card.setCode || seen.has(card.setCode)) {
            throw new Error(`Missing or duplicate pool card: ${card.setCode}`);
        }
        seen.add(card.setCode);
    }
    return { ...pool, provenance: { path: resolved, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
}

function verifyPool(provenance, override) {
    if (!provenance) {
        if (override) throw new Error('Cannot replay an unrestricted deal with a --pool override');
        return null;
    }
    const pool = loadPool(override || provenance.path);
    if (pool.provenance.sha256 !== provenance.sha256) {
        throw new Error(`Pool hash mismatch: expected ${provenance.sha256}, got ${pool.provenance.sha256} (${pool.provenance.path})`);
    }
    return pool;
}
module.exports = { loadPool, verifyPool };
