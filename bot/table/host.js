'use strict';
/**
 * What the tables share: the deck lists as the play screen lists them, the two lists of one game, and the card text
 * Holotable needs to draw cards with no art. serve.js (a table on one computer) and open.js (the window's play page,
 * /tables) use them.
 *
 *   deckOptions(decks)                          // [{name, leader, base, style}]
 *   pickDecks(decks, deck, botDeck, seed)       // {mine, theirs}; botDeck 'random' (RANDOM) picks by the seed
 *   cardTextOf(env, decks)                      // swu-card-text/1 for the lists' cards and the tokens
 */
const RANDOM = 'random';

/** The deck lists as the play page lists them. */
const deckOptions = (decks) => decks.map((d) => ({ name: d.metadata.name, leader: d.leader.id, base: d.base.id, style: d.metadata.style ?? null }));

/** The two lists of one game: the person's by name, the bot's by name or picked by the seed. Throws on a name not listed. */
function pickDecks(decks, deck, botDeck, seed) {
    const byName = new Map(decks.map((d) => [d.metadata.name, d]));
    const mine = byName.get(deck);
    const theirs = !botDeck || botDeck === RANDOM ? decks[seed % decks.length] : byName.get(botDeck);
    if (!mine || !theirs) {
        throw new Error(`unknown deck ${mine ? botDeck : deck}`);
    }
    return { mine, theirs };
}

/** A card of the engine's card data as swu-card-text/1 has it (viewer-kit/make-card-text.py). */
function textOf(d) {
    const e = { t: d.title };
    if (d.subtitle) {
        e.st = d.subtitle;
    }
    for (const [k, s] of [['cost', 'c'], ['power', 'p'], ['hp', 'h'], ['upgradePower', 'up'], ['upgradeHp', 'uh']]) {
        if (d[k] !== null && d[k] !== undefined) {
            e[s] = d[k];
        }
    }
    for (const [k, s] of [['types', 'ty'], ['arena', 'ar'], ['aspects', 'as'], ['traits', 'tr'], ['keywords', 'kw'], ['text', 'tx'], ['deployBox', 'db'], ['epicAction', 'ea']]) {
        if (d[k] && (!Array.isArray(d[k]) || d[k].length)) {
            e[s] = d[k];
        }
    }
    if (d.unique) {
        e.u = 1;
    }
    return e;
}

/** Card text for every card of the lists and every token, keyed by set code ("SOR_059"). */
function cardTextOf(env, decks) {
    const g = env.cardDataGetter;
    const cards = {};
    const codes = new Set(decks.flatMap((d) => [d.leader.id, d.base.id, ...d.deck.map((c) => c.id), ...(d.sideboard ?? []).map((c) => c.id)]));
    for (const code of codes) {
        if (g.setCodeMap.has(code)) {
            cards[code] = textOf(g.getCardSync(g.setCodeMap.get(code)));
        }
    }
    const tokens = {};
    for (const id of g.cardIds) {
        const d = g.getCardSync(id);
        if (d?.types?.includes('token') && d.title && !tokens[d.title]) {
            // a token has no set number in a replay (s: null), so the viewer finds it by title; any unused key holds it
            tokens[d.title] = textOf(d);
        }
    }
    for (const [title, e] of Object.entries(tokens)) {
        cards[`token:${title}`] = e;
    }
    return { schema: 'swu-card-text/1', source: 'forceteki card data', cards };
}

module.exports = { deckOptions, pickDecks, cardTextOf, RANDOM };
