'use strict';
/**
 * A table in a browser tab (the window's /play page with Holotable's play screen): the person against a bot, one game
 * at a time, with the referee and the bot in the same worker (bot/swarm/build.js play-worker.js) and the engine from
 * the swarm's pack. serve.js plays the same games on one computer over HTTP.
 *
 *   const host = createTableHost({ send });          // send(msg): every message for the page (table.js), in order
 *   createTableHost({ send, makeBot, bots })         // makeBot(name): a fresh bot for one game (default: the JEPA bot
 *                                                    // only, its models read when its first game starts)
 *   host.options()                                   // {bots, decks, botDeck}, as serve.js's GET /table/api/options
 *   await host.start({ bot, deck, botDeck, seed, key })   // {id, seat}; the game's last message is table.js's end, with
 *                                                    // the replay; host.done resolves to {result, replay} then
 *   host.act({ t: 'act', seq, i, split? })           // null when taken, else why not (the decision stays open)
 *   host.concede()
 *   host.cardText()                                  // swu-card-text/1 for the lists' cards and the tokens, so the page
 *                                                    // names and draws cards with no art (Holotable's loadCardText)
 *
 * botDeck 'random' (the default) deals the bot one of the lists, picked by the game's seed.
 */
const { Env } = require('../env');
const { loadDecks } = require('../decklists');
const { PersonSeat } = require('./person');
const { playTable } = require('./table');
const { jepaMaker, JEPA_NAME } = require('./jepa');

const DECKS = require('path').join(__dirname, '..', 'decks', 'ash-meta-2026-09.json');
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

/** The JEPA bot and no other; its two models are read when its first game starts, so the play page sends them then. */
function jepaOnly() {
    let make = null;
    return (name) => {
        if (name !== JEPA_NAME) {
            throw new Error(`no bot ${name}`);
        }
        make ??= jepaMaker();
        return make();
    };
}

function createTableHost({ send, env = new Env(), decksFile = DECKS, makeBot = jepaOnly(), bots = [JEPA_NAME] }) {
    const { decks } = loadDecks(decksFile, env);
    let game = null;
    let text = null;

    const host = {
        done: null,
        options: () => ({ bots: [...bots], decks: deckOptions(decks), botDeck: RANDOM }),
        start({ bot = JEPA_NAME, deck, botDeck = RANDOM, seed, key = null } = {}) {
            if (game && !game.over) {
                throw new Error('a game is being played at this table');
            }
            if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) {
                throw new Error('seed: a whole number from 0 to 2^32 - 1');
            }
            const { mine, theirs } = pickDecks(decks, deck, botDeck, seed);
            const opponent = makeBot(bot);
            const id = `play-${seed.toString(16).padStart(8, '0')}`;
            const person = new PersonSeat({ name: 'person', send });
            game = { id, person, over: false };
            const g = game;
            host.done = playTable({ env, person, personSeat: 'p1', bot: opponent, decks: { p1: mine, p2: theirs }, seed, key, send })
                .catch((e) => {
                    send({ t: 'end', winner: null, outcome: 'ERROR', round: 0, steps: 0, error: String(e?.message ?? e).slice(0, 200), by: null, conceded: false, replay: null });
                    return { result: null, replay: null };
                })
                .finally(() => {
                    g.over = true;
                });
            return { id, seat: 'p1' };
        },
        act: (reply) => (game && !game.over ? game.person.answer(reply) : 'no game is being played'),
        concede: () => game?.person.concede(),
        cardText: () => (text ??= cardTextOf(env, decks))
    };
    return host;
}

module.exports = { createTableHost, jepaOnly, deckOptions, pickDecks, RANDOM };
