'use strict';

/**
 * Fixed deck lists for ladders: `node bot/ladder.js --decks <file>` plays real decks instead of random ones.
 *
 * A deck file is a JSON array (or { decks: [...] }) of SWUDB-format lists, the shape env.newGame takes:
 *   { metadata: { name }, leader: { id: 'LAW_008', count: 1 }, base: { id: 'ASH_019', count: 1 }, deck: [{ id, count }] }
 * Names must be unique: results are reported per deck name. Sideboards are dropped (a game uses the main deck).
 *
 * Deal: every unordered deck pair in file order gets one seed in turn, so each pair plays equally often. The two games
 * of a seed (ratings.js roundRobin / gauntlet list them next to each other, seats swapped) give each bot the same deck
 * in both, so each deck plays each seat once per seed: in a mirror (c-clock#a vs c-clock#b) that is the same deal
 * with the decks' seats swapped, not a repeat. Every second pass over the pairs swaps which bot gets which deck.
 * The deal depends only on the seed and the file order, not on the run key: deck lists are not secret (bots are told
 * both lists at hello), only the shuffles are.
 */

const crypto = require('crypto');
const fs = require('fs');

/** 'LAW_3' -> 'LAW_003' (as forceteki's DeckValidator pads; Deck itself does not). */
function padId(id) {
    const m = /^([A-Z0-9]+)_(\d{1,2})$/.exec(String(id));
    return m ? `${m[1]}_${m[2].padStart(3, '0')}` : String(id);
}

/** A clean copy: padded ids, one entry per card (Deck keeps only the last of repeated ids), no sideboard. */
function normalizeDeck(d, i = 0) {
    if (!d || typeof d !== 'object' || !d.leader?.id || !d.base?.id || !Array.isArray(d.deck)) {
        throw new Error(`deck ${i}: needs leader.id, base.id and a deck array`);
    }
    const counts = new Map();
    for (const c of d.deck) {
        const n = Number(c?.count);
        if (!c?.id || !Number.isInteger(n) || n < 1) {
            throw new Error(`deck ${i} (${d.metadata?.name ?? '?'}): bad entry ${JSON.stringify(c)}`);
        }
        const id = padId(c.id);
        counts.set(id, (counts.get(id) ?? 0) + n);
    }
    const name = d.metadata?.name ? String(d.metadata.name) : `${padId(d.leader.id)} / ${padId(d.base.id)}`;
    return {
        metadata: { ...(d.metadata ?? {}), name },
        leader: { id: padId(d.leader.id), count: 1 },
        base: { id: padId(d.base.id), count: 1 },
        deck: [...counts].map(([id, count]) => ({ id, count }))
    };
}

/**
 * Problems that would make games with these decks fail or mislead: repeated names, ids the card data does not know
 * (forceteki throws for those), cards without an implementation (they would play as blank cards), short decks.
 * `known(id)` and `implemented(id)` come from the engine (see loadDecks).
 */
function checkDecks(decks, { known, implemented = () => true }) {
    const problems = [];
    const seen = new Set();
    for (const d of decks) {
        const name = d.metadata.name;
        if (seen.has(name)) {
            problems.push(`${name}: name used twice`);
        }
        seen.add(name);
        for (const id of [d.leader.id, d.base.id, ...d.deck.map((c) => c.id)]) {
            if (!known(id)) {
                problems.push(`${name}: ${id} is not in the card data`);
            } else if (!implemented(id)) {
                problems.push(`${name}: ${id} has no implementation`);
            }
        }
        const size = d.deck.reduce((a, c) => a + c.count, 0);
        if (size < 50) {
            problems.push(`${name}: main deck has ${size} cards (premier needs 50)`);
        }
    }
    return problems;
}

/** Read, normalize and check a deck file against the engine's card data. Throws listing every problem. */
function loadDecks(file, env) {
    const bytes = fs.readFileSync(file);
    const raw = JSON.parse(bytes.toString('utf8'));
    const list = Array.isArray(raw) ? raw : raw?.decks;
    if (!Array.isArray(list) || list.length < 2) {
        throw new Error(`${file}: expected a JSON array of at least 2 deck lists`);
    }
    const decks = list.map(normalizeDeck);
    const g = env.cardDataGetter;
    const implemented = (id) => {
        const card = g.getCardSync(g.setCodeMap.get(id));
        return card ? env.isImplemented(card) : true;
    };
    const problems = checkDecks(decks, { known: (id) => g.setCodeMap.has(id), implemented });
    if (problems.length) {
        throw new Error(`${file}:\n  ${problems.join('\n  ')}`);
    }
    return { decks, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/** Every unordered pair [i, j], i < j, in file order. */
function deckPairs(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            out.push([i, j]);
        }
    }
    return out;
}

/**
 * Give each scheduled game its decks: `decks: [deck index at p1, deck index at p2]`. Seed s (counted from firstSeed)
 * plays pair s mod P; within a seed each bot keeps its deck when seats swap; odd passes over the pairs swap the bots'
 * decks. Returns new schedule entries.
 */
function dealDecks(schedule, nDecks, firstSeed = 1) {
    const pairs = deckPairs(nDecks);
    const owner = new Map();
    return schedule.map((g) => {
        const k = `${g.seed}|${[g.p1, g.p2].sort().join('|')}`;
        if (!owner.has(k)) {
            const s = g.seed - firstSeed;
            const [i, j] = pairs[((s % pairs.length) + pairs.length) % pairs.length];
            const swap = Math.floor(s / pairs.length) % 2 === 1;
            owner.set(k, { [g.p1]: swap ? j : i, [g.p2]: swap ? i : j });
        }
        const own = owner.get(k);
        return { ...g, decks: [own[g.p1], own[g.p2]] };
    });
}

/**
 * One deck from a SWUSim / TCGEngine fixture file: '#' lines are comments, then sections 'Leader', 'Base', 'Deck' and
 * 'Sideboard' with one '<count> <SET_NNN>' line per card. Comments are dropped (they can name events and players),
 * except a '# Style: <word>' line, kept as metadata.style. The sideboard is left out.
 */
function parseDeckText(text, name) {
    const sections = { leader: [], base: [], deck: [], sideboard: [] };
    let cur = null;
    let style = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) {
            continue;
        }
        if (line.startsWith('#')) {
            const m = /^#\s*Style:\s*([a-z-]+)\s*$/i.exec(line);
            if (m) {
                style = m[1].toLowerCase();
            }
            continue;
        }
        const head = line.toLowerCase();
        if (head in sections) {
            cur = head;
            continue;
        }
        const m = /^(\d+)\s+([A-Z0-9]+_\d+)$/.exec(line);
        if (!m || !cur) {
            throw new Error(`${name}: cannot read line "${line}"`);
        }
        sections[cur].push({ id: padId(m[2]), count: Number(m[1]) });
    }
    if (sections.leader.length !== 1 || sections.base.length !== 1 || !sections.deck.length) {
        throw new Error(`${name}: needs one leader, one base and a deck section`);
    }
    return normalizeDeck({
        metadata: { name, ...(style ? { style } : {}) },
        leader: sections.leader[0], base: sections.base[0], deck: sections.deck
    });
}

module.exports = { padId, normalizeDeck, checkDecks, loadDecks, deckPairs, dealDecks, parseDeckText };
