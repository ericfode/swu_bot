'use strict';

/**
 * Fixed deck lists for ladders: `node bot/ladder.js --decks <file>` plays real decks instead of random ones.
 *
 * A deck file is a JSON array (or { decks: [...] }) of SWUDB-format lists, the shape env.newGame takes:
 *   { metadata: { name }, leader: { id: 'LAW_008', count: 1 }, base: { id: 'ASH_019', count: 1 }, deck: [{ id, count }] }
 * Names must be unique: results are reported per deck name. Sideboards are dropped (a game uses the main deck), and so
 * is all metadata but name and style (a SWUDB export names its author, which would go into every replay header).
 *
 * Deal: with s = seed - --seed (the ladder's first seed), seed s plays deck pair s mod P, P = n(n-1)/2 pairs. The pairs
 * come in round-robin rounds (deckPairs), so a run cut after whole rounds has given every deck the same number of games
 * (when n is odd, a deck that already sat out a round has one seed less: 2 games less per bot pair). The two games of
 * a seed (ratings.js roundRobin / gauntlet list them next to each other, seats swapped) give each bot the same deck in
 * both, so each deck plays each seat once per seed: in a mirror (c-clock#a vs c-clock#b) the decks trade seats. Both
 * games use the same engine seed, but the seats get the same shuffles only when both decks have the same size.
 * Who gets which deck of a pair: in one pass over the pairs each bot holds each deck in about half of that deck's
 * games, and the next pass gives each bot the other deck of every pair. The deal depends only on s and the file order,
 * not on the run key: deck lists are not secret (bots are told both lists at hello), only the shuffles are.
 *
 * The arena's rated rounds deal by seat instead (dealDecks by: 'seat', ladder.js --deal seat): seed s itself (not
 * counted from --seed) plays pair s mod P, and each deck stays with its seat, so in the two games of a seed each bot
 * plays both decks from the same seat on the same shuffles, as random decks follow the seat. A round's first seed
 * comes from the arena's secret (referee.js roundSeed), so each round starts somewhere else in the pairs.
 */

const crypto = require('crypto');
const fs = require('fs');

/** 'LAW_3' -> 'LAW_003' (as forceteki's DeckValidator pads; Deck itself does not). */
function padId(id) {
    const m = /^([A-Z0-9]+)_(\d{1,2})$/.exec(String(id));
    return m ? `${m[1]}_${m[2].padStart(3, '0')}` : String(id);
}

/**
 * A clean copy: padded ids, one entry per card (Deck keeps only the last of repeated ids), no sideboard, and only the
 * name and style of the metadata (the deck goes into replay headers and to the bots).
 */
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
    const style = d.metadata?.style;
    return {
        metadata: { name, ...(style ? { style: String(style) } : {}) },
        leader: { id: padId(d.leader.id), count: 1 },
        base: { id: padId(d.base.id), count: 1 },
        deck: [...counts].map(([id, count]) => ({ id, count }))
    };
}

/** Premier minimum main deck size, and the bases that change it, by internal card id (forceteki DeckValidator.ts). */
const MIN_DECK_SIZE = 50;
const MIN_DECK_SIZE_MODIFIER = new Map([
    ['4301437393', -5], // Thermal Oscillator
    ['4028826022', 10] // Data Vault
]);
/** Premier copy limit per card, and the cards with their own limit, by internal card id (forceteki DeckValidator.ts). */
const MAX_COPIES = 3;
const MAX_COPIES_OVERRIDE = new Map([
    ['2177194044', 15] // Swarming Vulture Droid
]);

/**
 * Problems that would make games with these decks fail or mislead: repeated names, ids the card data does not know
 * (forceteki throws for those), cards without an implementation (they would play as blank cards), a leader or base
 * slot holding another card type, leaders, bases or tokens in the main deck, decks below their minimum size, and more
 * copies of a card than premier allows (reprints of one card count together).
 * The lookups come from the engine (see loadDecks): `known(id)`, `implemented(id)`, `types(id)` (the card's types, or
 * null to skip the type checks), `minDeckSize(baseId)`, `cardKey(id)` (one key for every printing of a card) and
 * `maxCopies(key)`.
 */
function checkDecks(decks, { known, implemented = () => true, types = () => null, minDeckSize = () => MIN_DECK_SIZE, cardKey = (id) => id, maxCopies = () => MAX_COPIES }) {
    const problems = [];
    const seen = new Set();
    const typesOf = (id) => (known(id) ? types(id) : null);
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
        for (const [slot, id] of [['leader', d.leader.id], ['base', d.base.id]]) {
            const t = typesOf(id);
            if (t && !t.includes(slot)) {
                problems.push(`${name}: ${slot} ${id} is not a ${slot} (${t.join(', ')})`);
            }
        }
        for (const c of d.deck) {
            const wrong = typesOf(c.id)?.find((t) => ['leader', 'base', 'token'].includes(t));
            if (wrong) {
                problems.push(`${name}: ${c.id} is a ${wrong}, not a main deck card`);
            }
        }
        const copies = new Map();
        for (const c of d.deck) {
            const key = known(c.id) ? cardKey(c.id) : c.id;
            const e = copies.get(key) ?? { ids: [], count: 0 };
            e.ids.push(c.id);
            e.count += c.count;
            copies.set(key, e);
        }
        for (const [key, e] of copies) {
            if (e.count > maxCopies(key)) {
                problems.push(`${name}: ${e.count} copies of ${e.ids.join(' + ')} (premier allows ${maxCopies(key)})`);
            }
        }
        const size = d.deck.reduce((a, c) => a + c.count, 0);
        const min = minDeckSize(d.base.id);
        if (size < min) {
            problems.push(`${name}: main deck has ${size} cards (premier needs ${min}${min !== MIN_DECK_SIZE ? ' with this base' : ''})`);
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
    const card = (id) => (g.setCodeMap.has(id) ? g.getCardSync(g.setCodeMap.get(id)) : null);
    const problems = checkDecks(decks, {
        known: (id) => g.setCodeMap.has(id),
        implemented: (id) => {
            const c = card(id);
            return c ? env.isImplemented(c) : true;
        },
        types: (id) => card(id)?.types ?? null,
        minDeckSize: (id) => MIN_DECK_SIZE + (MIN_DECK_SIZE_MODIFIER.get(card(id)?.id) ?? 0),
        cardKey: (id) => card(id)?.id ?? id,
        maxCopies: (key) => MAX_COPIES_OVERRIDE.get(key) ?? MAX_COPIES
    });
    if (problems.length) {
        throw new Error(`${file}:\n  ${problems.join('\n  ')}`);
    }
    return { decks, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Every unordered pair of n decks once, in round-robin rounds (circle method): with m = n rounded up to even, deck
 * m - 1 stays put and the others move one place per round. Each round pairs every deck once; when n is odd deck m - 1
 * is a bye, so its pair is left out and one deck sits the round out. The order inside a pair says which deck the first
 * bot gets on even passes (dealDecks): each deck comes first in (n - 1) / 2 of its pairs, rounded up or down.
 */
function deckPairs(n) {
    const m = n + (n % 2);
    const out = [];
    for (let r = 0; r < m - 1; r++) {
        // the fixed deck comes first in even rounds; a moving deck is first as r + k and second as r - k, m/2 - 1 times each
        const round = [r % 2 ? [r, m - 1] : [m - 1, r]];
        for (let k = 1; k < m / 2; k++) {
            round.push([(r + k) % (m - 1), (r - k + m - 1) % (m - 1)]);
        }
        out.push(...round.filter(([i, j]) => i < n && j < n));
    }
    return out;
}

/**
 * Give each scheduled game its decks: `decks: [deck index at p1, deck index at p2]`. Seed s (counted from firstSeed)
 * plays pair s mod P. The first bot (p1 of the seed's first game: the earlier --bots entry, or the challenger of a
 * gauntlet) gets the pair's first deck on even passes over the pairs and its second deck on odd passes; the other bot
 * gets the other deck and each bot keeps its deck when seats swap within the seed. Returns new schedule entries.
 * by: 'seat' deals by seat (see the header): seed s plays pair s mod P whatever firstSeed is, p1 gets the pair's first
 * deck on even passes and its second on odd ones, in every game of the seed.
 */
function dealDecks(schedule, nDecks, firstSeed = 1, { by = 'bot' } = {}) {
    if (nDecks < 2) {
        throw new Error('dealDecks needs at least 2 decks');
    }
    if (!['bot', 'seat'].includes(by)) {
        throw new Error(`dealDecks deals by bot or by seat, not ${JSON.stringify(by)}`);
    }
    const pairs = deckPairs(nDecks);
    const P = pairs.length;
    if (by === 'seat') {
        return schedule.map((g) => {
            const [i, j] = pairs[((g.seed % P) + P) % P];
            return { ...g, decks: Math.floor(g.seed / P) % 2 !== 0 ? [j, i] : [i, j] };
        });
    }
    const owner = new Map();
    return schedule.map((g) => {
        const k = `${g.seed}|${[g.p1, g.p2].sort().join('|')}`;
        if (!owner.has(k)) {
            const s = g.seed - firstSeed;
            const [i, j] = pairs[((s % P) + P) % P];
            const swap = Math.floor(s / P) % 2 !== 0;
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
