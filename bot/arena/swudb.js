'use strict';
/**
 * Deck lists people bring to the open tables (tables.js): a SWUDB link, or a list pasted as JSON. The window fetches
 * a link's deck from SWUDB's own deck API on the server (swudb.com sends no CORS headers, so a page cannot), and both
 * become the deck form games take (decklists.js normalizeDeck: padded ids, no sideboard, only the deck's name):
 *
 *   swudbId('https://swudb.com/deck/CnASlfGsnzRHe')   -> 'CnASlfGsnzRHe' (also www., a bare id), else null
 *   await fetchSwudb(id)                              -> the deck, or throws why not (not found, private, Twin Suns)
 *   deckFromJson(text)                                -> the deck from SWUDB's JSON export, its deck API's answer, or
 *                                                        the arena's own form; throws why not
 *
 * SWUDB's deck API (GET https://www.swudb.com/api/deck/<id>, public and unlisted decks) answers with
 * {deckName, authorName, deckFormat, leader, secondLeader, base, shuffledDeck: [{card, count, sideboardCount}]}, each
 * card with defaultExpansionAbbreviation and defaultCardNumber (its set code: SOR + 10 -> SOR_010). The author's name
 * is dropped, as decklists.js drops it from exports. Whether every card is in the engine's card data is checked where
 * the game runs (bot/table/open.js), not here: the window has no engine.
 */
const { normalizeDeck } = require('../decklists');

const API = 'https://www.swudb.com/api/deck/';
const ID = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_BYTES = 2 << 20;
const TIMEOUT_MS = 12000;

/** The SWUDB deck id in a link (swudb.com/deck/<id>, with or without www. and https://) or a bare id; else null. */
function swudbId(text) {
    const s = String(text ?? '').trim();
    if (ID.test(s)) {
        return s;
    }
    const m = /^(?:https?:\/\/)?(?:www\.)?swudb\.com\/deck\/(?:view\/)?([A-Za-z0-9_-]{4,64})(?:[/?#].*)?$/i.exec(s);
    return m ? m[1] : null;
}

const code = (card) => {
    const set = String(card?.defaultExpansionAbbreviation ?? '').trim().toUpperCase();
    const num = String(card?.defaultCardNumber ?? '').trim();
    if (!/^[A-Z0-9]{2,6}$/.test(set) || !/^\d{1,4}$/.test(num)) {
        throw new Error(`a card with no set code (${card?.cardName ?? 'unnamed'})`);
    }
    return `${set}_${num.padStart(3, '0')}`;
};

/** SWUDB's deck API answer as a deck list; throws for Twin Suns (two leaders) or a deck with no leader or base. */
function fromSwudbApi(raw) {
    if (!raw || typeof raw !== 'object') {
        throw new Error('not a SWUDB deck');
    }
    if (raw.secondLeader || raw.deckFormat === 2) {
        throw new Error('Twin Suns decks (two leaders) are not played here yet');
    }
    if (!raw.leader || !raw.base) {
        throw new Error('the deck needs a leader and a base');
    }
    const deck = [];
    for (const e of Array.isArray(raw.shuffledDeck) ? raw.shuffledDeck : []) {
        const n = Number(e?.count ?? 0);
        if (e?.card && Number.isInteger(n) && n > 0) {
            deck.push({ id: code(e.card), count: n });
        }
    }
    const name = String(raw.deckName ?? '').trim().slice(0, 80);
    return normalizeDeck({ metadata: name ? { name } : {}, leader: { id: code(raw.leader) }, base: { id: code(raw.base) }, deck });
}

/** A deck list from pasted JSON: SWUDB's export ({metadata, leader: {id}, base: {id}, deck: [{id, count}]}), its API's answer, or the arena's form. */
function deckFromJson(text) {
    let raw;
    try {
        raw = typeof text === 'string' ? JSON.parse(text) : text;
    } catch {
        throw new Error('paste a SWUDB link, or a deck list as JSON (SWUDB: Export, then JSON)');
    }
    if (raw && typeof raw === 'object' && ('shuffledDeck' in raw || 'deckName' in raw)) {
        return fromSwudbApi(raw);
    }
    if (raw?.secondLeader) {
        throw new Error('Twin Suns decks (two leaders) are not played here yet');
    }
    const d = normalizeDeck(raw);
    d.metadata.name = d.metadata.name.slice(0, 80);
    return d;
}

/** The deck of SWUDB deck `id`, from SWUDB's deck API. Throws a reason a person can act on. */
async function fetchSwudb(id, { fetchImpl = globalThis.fetch } = {}) {
    if (!ID.test(String(id))) {
        throw new Error('not a SWUDB deck link');
    }
    let r;
    try {
        r = await fetchImpl(`${API}${encodeURIComponent(id)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
        throw new Error('SWUDB did not answer; try again, or paste the deck as JSON (SWUDB: Export, then JSON)');
    }
    if (r.status === 404 || r.status === 403) {
        throw new Error('SWUDB has no public deck with that link (a private deck cannot be read: make it public or unlisted)');
    }
    if (!r.ok) {
        throw new Error(`SWUDB answered HTTP ${r.status}; paste the deck as JSON instead (SWUDB: Export, then JSON)`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) {
        throw new Error('that SWUDB deck is too large');
    }
    let raw;
    try {
        raw = JSON.parse(buf.toString('utf8'));
    } catch {
        throw new Error('SWUDB did not send a deck');
    }
    return fromSwudbApi(raw);
}

module.exports = { swudbId, fromSwudbApi, deckFromJson, fetchSwudb, API };
