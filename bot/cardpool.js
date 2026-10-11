'use strict';
/**
 * Card pools for arena tournaments with custom rules (Eric, 2026-10-11: "holding out a set of cards, and then letting
 * them compete with a new set"). A holdout tournament splits the cards in two:
 *
 *   train.json    the cards of every work round: rated ladders and evals deal decks only from these
 *   holdout.json  the cards held out: after the last round, one extra ladder of the same bot versions deals only these
 *
 * Every base is in both pools. Leaders and main-deck cards (units, events, upgrades) are split per stratum (type plus
 * aspect set), holding out round(fraction x size) of each stratum, so both pools keep every colour combination and can
 * fill a 50-card deck for every leader and base (checked: env.randomDeck refuses a pool that cannot).
 * The split is a seeded shuffle: the same seed gives the same pools.
 *
 *   node bot/cardpool.js --holdout 0.3 --seed <text> --out <dir>      writes train.json and holdout.json
 *
 * A pool file ({schema: 'swu-arena-pool/1', kind, fraction, counts, cards: [{id, setCode, internalName, types,
 * aspects}]}) is what ladder.js --pool and env.randomDeck({pool}) read.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { seededRng } = require('./rng');

const SCHEMA = 'swu-arena-pool/1';

/** The fields a pool keeps of an index entry (env.randomDeck resolves the rest through the card data). */
const slim = (c) => ({ id: c.id, setCode: c.setCode, internalName: c.internalName, types: c.types, aspects: c.aspects ?? [] });

/** Fisher-Yates with a seeded rng: the same seed gives the same order. */
function shuffle(list, rng) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * Splits an Env index ({leaders, bases, pool}) into {train, holdout} card lists. `fraction` (0 < f < 1) is the share held
 * out of each stratum of leaders and main-deck cards; bases go to both. Pure: no engine needed.
 */
function splitPool(index, { fraction = 0.3, seed }) {
    if (!(fraction > 0 && fraction < 1)) {
        throw new Error(`holdout fraction ${fraction}: a number between 0 and 1`);
    }
    if (typeof seed !== 'string' || !seed) {
        throw new Error('a holdout split needs a seed (text)');
    }
    const rng = seededRng(`holdout:${seed}`);
    const train = [];
    const holdout = [];
    const strata = new Map();
    const kind = (c) => (c.types.includes('leader') ? 'leader' : 'main');
    for (const c of [...index.leaders, ...index.pool]) {
        // the stratum: leader or main card, its type, its aspects (sorted, duplicates kept: double-aspect cards differ)
        const key = `${kind(c)}:${c.types.filter((t) => t !== 'token').sort().join('+')}:${[...(c.aspects ?? [])].sort().join('+')}`;
        if (!strata.has(key)) {
            strata.set(key, []);
        }
        strata.get(key).push(c);
    }
    // strata in a fixed order, cards in each by set code, so the split depends only on the seed and the card list
    for (const key of [...strata.keys()].sort()) {
        const cards = shuffle(strata.get(key).sort((a, b) => a.setCode.localeCompare(b.setCode)), rng);
        const k = Math.round(fraction * cards.length);
        holdout.push(...cards.slice(0, k));
        train.push(...cards.slice(k));
    }
    for (const b of index.bases) {
        train.push(b);
        holdout.push(b);
    }
    const bySet = (a, b) => a.setCode.localeCompare(b.setCode);
    return { train: train.sort(bySet).map(slim), holdout: holdout.sort(bySet).map(slim) };
}

const counts = (cards) => ({
    leaders: cards.filter((c) => c.types.includes('leader')).length,
    bases: cards.filter((c) => c.types.includes('base')).length,
    main: cards.filter((c) => !c.types.includes('leader') && !c.types.includes('base')).length
});

/** Writes train.json and holdout.json into dir; returns {train, holdout} as {path, sha256, counts}. */
function writePools(dir, split, { fraction, seedId = null } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const out = {};
    for (const kind of ['train', 'holdout']) {
        const doc = { schema: SCHEMA, kind, fraction, ...(seedId ? { seedId } : {}), counts: counts(split[kind]), cards: split[kind] };
        const file = path.join(dir, `${kind}.json`);
        const text = `${JSON.stringify(doc, null, 1)}\n`;
        fs.writeFileSync(`${file}.tmp`, text);
        fs.renameSync(`${file}.tmp`, file);
        out[kind] = { path: file, sha256: crypto.createHash('sha256').update(text).digest('hex'), counts: doc.counts };
    }
    return out;
}

/** Reads a pool file: {kind, cards, provenance: {path, sha256, kind}}. Throws on a wrong schema or a repeated card. */
function loadPool(file) {
    const resolved = path.resolve(file);
    const bytes = fs.readFileSync(resolved);
    const doc = JSON.parse(bytes);
    if (doc?.schema !== SCHEMA || !Array.isArray(doc.cards) || !['train', 'holdout'].includes(doc.kind)) {
        throw new Error(`${file} is not an arena card pool (${SCHEMA})`);
    }
    const seen = new Set();
    for (const c of doc.cards) {
        if (!c?.setCode || !c.id || !Array.isArray(c.types) || seen.has(c.setCode)) {
            throw new Error(`${file}: missing or repeated card ${c?.setCode}`);
        }
        seen.add(c.setCode);
    }
    return { kind: doc.kind, cards: doc.cards, provenance: { path: resolved, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), kind: doc.kind } };
}

/**
 * Checks with the engine's card data that a pool can deal a legal-size deck for every leader and base it has
 * (env.randomDeck does this check and throws when it cannot); returns the number of cards.
 */
function checkPool(env, pool) {
    env.randomDeck(seededRng('pool-check'), { pool });
    return pool.cards.length;
}

module.exports = { splitPool, writePools, loadPool, checkPool, SCHEMA };

if (require.main === module) {
    const arg = (name, dflt) => {
        const i = process.argv.indexOf(`--${name}`);
        return i > 0 ? process.argv[i + 1] : dflt;
    };
    const fraction = Number(arg('holdout', 0.3));
    const seed = arg('seed');
    const out = arg('out');
    if (!seed || !out) {
        console.error('usage: node bot/cardpool.js --holdout 0.3 --seed <text> --out <dir>');
        process.exit(2);
    }
    const { Env } = require('./env');
    const env = new Env();
    const files = writePools(out, splitPool(env.index(), { fraction, seed }), { fraction });
    for (const [kind, f] of Object.entries(files)) {
        checkPool(env, loadPool(f.path));
        console.log(`${kind}: ${f.counts.leaders} leaders, ${f.counts.bases} bases, ${f.counts.main} main-deck cards -> ${f.path}`);
    }
}
