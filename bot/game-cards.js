'use strict';

/**
 * The card data of one game, as every bot gets it in hello.cards (spec/protocol.md): the engine's card objects for
 * every card the game can show a bot. Finding card data is the referee's job, so a bot reads no card files.
 *
 *   gameCards(getter, [deck1, deck2])   // getter: the engine's card-data getter (env.cardDataGetter)
 *   cardGetter(dir?)                    // that getter on a card folder (default the referee's), without the engine
 *
 * For both lists: the leader, a second leader, the base, every deck entry and every sideboard entry, each resolved the
 * engine's way (setCodeMap, then getCardSync), so a reprint code ('JTL_020') gives the card the engine plays (setId
 * HMW_022). Then the 13 tokens. During play the engine reads card data only for these, plus card titles for "name a
 * card" dropdowns, whose labels are titles only. The objects are the getter's own, unchanged; ClientSeat.hello sends a
 * copy. One object per internalName, sorted by internalName, so both seats get the same array: a lookup by title that
 * takes the first match finds the same card for both.
 */
const path = require('path');

const CARD_DIR = path.join(__dirname, '..', 'forceteki', 'test', 'json');

/** The set codes a deck list names, in list order. */
const codesOf = (d) => [d.leader?.id, d.secondleader?.id, d.base?.id, ...(d.deck ?? []).map((c) => c.id), ...(d.sideboard ?? []).map((c) => c.id)].filter((id) => id !== undefined);

/** decks: the game's two deck lists, an array or { p1, p2 }. Throws on a set code the card data does not know. */
function gameCards(getter, decks) {
    const byName = new Map();
    const add = (c) => byName.has(c.internalName) || byName.set(c.internalName, c);
    for (const d of Array.isArray(decks) ? decks : Object.values(decks)) {
        for (const code of codesOf(d)) {
            const id = getter.setCodeMap.get(code);
            if (id === undefined) {
                throw new Error(`deck list ${d.metadata?.name ?? '?'}: no card ${code} in the card data`);
            }
            add(getter.getCardSync(id));
        }
    }
    Object.values(getter.tokenData).forEach(add);
    return [...byName.values()].sort((a, b) => (a.internalName < b.internalName ? -1 : a.internalName > b.internalName ? 1 : 0));
}

/** The card-data getter env.js uses (forceteki's UnitTestCardDataGetter), on `dir`; it loads none of the engine's cards. */
function cardGetter(dir = CARD_DIR) {
    const { UnitTestCardDataGetter } = require(path.join(__dirname, '..', 'forceteki', 'build', 'server', 'utils', 'cardData', 'UnitTestCardDataGetter.js'));
    return new UnitTestCardDataGetter(dir);
}

module.exports = { gameCards, cardGetter, CARD_DIR };
