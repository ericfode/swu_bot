'use strict';
/**
 * The open tables' host (the window's /tables page, bot/arena/tables.js): one game at a time in a player's browser
 * tab, with the referee in a worker (bot/swarm/build.js tables-worker.js) on the swarm's engine pack. Two kinds of game:
 *
 *   - a person against a bot: Eric's JEPA bot (jepa.js) or an arena version whose bundle the worker has unpacked
 *     under ARENA_HOME (players/index.js finds it there), guarded with its round's thinking time per game (setCap);
 *   - two people: this tab's person and a guest whose browser is linked to this one. The guest's seat is a PersonSeat
 *     whose messages go to `sendPeer`, and its answers come back through peerAct. Both players are trusted (Eric,
 *     2026-10-16: "for the first version treat both players as trusted"): this tab holds both hands and the deal.
 *
 *   const host = createOpenHost({ send, sendPeer });   // each: every table message (table.js) for that person, in order
 *   host.options()                                    // {decks, botDeck}: the tournament lists
 *   host.checkDeck(deck)                              // a deck list (SWUDB form) as games take it, or throws why not
 *   host.setCap(bot, capMs) / host.capOf(bot)         // an arena version's thinking time per game (its lineup's capMs)
 *   await host.start({ mode: 'bot', bot, deck, botDeck, seed, key, you })        // {id, seat}
 *   await host.start({ mode: 'people', deck, peerDeck, you, peer, seed, key })   // {id, seat, peerSeat}
 *   host.act(reply) / host.peerAct(reply)             // null when taken, else why not (the decision stays open)
 *   host.concede() / host.peerConcede()
 *   host.cardText(decks)                              // swu-card-text/1 for the lists, these decks and the tokens
 *
 * A deck is a list's name or a deck list ({metadata: {name}, leader, base, deck}), checked against the card data as
 * the arena checks its lists (decklists.js). The seat of this tab's person comes from the seed: either player may go
 * first. Every game ends with table.js's end message to each person, with the replay; host.done resolves then.
 */
const { Env } = require('../env');
const { loadDecks, normalizeDeck, checkDecks, engineLookups } = require('../decklists');
const { makeBot: makeArenaBot } = require('../players');
const { guard } = require('../players/guard');
const { PersonSeat } = require('./person');
const { playSeats } = require('./table');
const { deckOptions, cardTextOf, RANDOM } = require('./host');
const { jepaMaker, JEPA_NAME } = require('./jepa');

const DECKS = require('path').join(__dirname, '..', 'decks', 'ash-meta-2026-09.json');
const CAP_MS = 45000; // the arena's thinking time per bot per game when the lineup gives none (status thinkCapMs)
const NAME = /^[A-Za-z0-9][\w .@#+()'&/,!?-]{0,79}$/; // as the window keeps games (tables.js)

const seatsOf = (seed) => ((seed >>> 0) % 2 === 0 ? ['p1', 'p2'] : ['p2', 'p1']);

function createOpenHost({ send, sendPeer = () => undefined, env = new Env(), decksFile = DECKS, makeBot = null, capMs = CAP_MS }) {
    const { decks } = loadDecks(decksFile, env);
    const byName = new Map(decks.map((d) => [d.metadata.name, d]));
    const lookups = engineLookups(env);
    const caps = new Map(); // arena version -> its round's capMs
    let jepa = null;
    let game = null;

    /** A fresh bot by name: the JEPA bot, or anything players/index.js makes (arena versions), guarded with the cap. */
    const botOf = makeBot ?? ((name) => {
        if (name === JEPA_NAME) {
            jepa ??= jepaMaker();
            return jepa();
        }
        const raw = makeArenaBot(name, []);
        if (!raw || (typeof raw.choose !== 'function' && typeof raw.decide !== 'function')) {
            throw new Error(`${name} is not a bot`);
        }
        return guard(raw, { capMs: host.capOf(name) });
    });

    /** A deck list ready for a game, or throws every problem with it. */
    function checkDeck(raw) {
        const d = normalizeDeck(raw);
        if (!NAME.test(d.metadata.name)) {
            d.metadata.name = `${d.leader.id} / ${d.base.id}`;
        }
        const own = `${d.metadata.name}: `;
        const problems = checkDecks([d], lookups).map((x) => (x.startsWith(own) ? x.slice(own.length) : x));
        if (problems.length) {
            throw new Error(problems.join('; '));
        }
        return d;
    }
    const deckOf = (x, what) => {
        if (typeof x === 'string') {
            const d = byName.get(x);
            if (!d) {
                throw new Error(`${what}: no list named ${x}`);
            }
            return d;
        }
        try {
            return checkDeck(x);
        } catch (e) {
            throw new Error(`${what}: ${e.message}`);
        }
    };

    /** A concession ends the game now, even while the other person has the decision. */
    function concede(who) {
        const g = game;
        if (!g || g.over || !g[who]) {
            return;
        }
        g[who].concede();
        g.leave({ seat: g.seats[who], why: 'conceded' });
    }

    const host = {
        done: null,
        options: () => ({ decks: deckOptions(decks), botDeck: RANDOM }),
        checkDeck,
        start({ mode = 'bot', bot, deck, botDeck = RANDOM, peerDeck, you = 'person', peer = 'guest', seed, key = null } = {}) {
            if (game && !game.over) {
                throw new Error('a game is being played at this table');
            }
            if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) {
                throw new Error('seed: a whole number from 0 to 2^32 - 1');
            }
            if (!['bot', 'people'].includes(mode)) {
                throw new Error(`mode: bot or people, not ${mode}`);
            }
            const mine = deckOf(deck, 'your deck');
            const [seat, other] = seatsOf(seed);
            const id = `open-${seed.toString(16).padStart(8, '0')}`;
            const person = new PersonSeat({ name: you, send });
            let theirs;
            let opponent;
            let guest = null;
            if (mode === 'bot') {
                theirs = !botDeck || botDeck === RANDOM ? decks[seed % decks.length] : deckOf(botDeck, "the bot's deck");
                opponent = botOf(bot);
            } else {
                theirs = deckOf(peerDeck, "the other player's deck");
                guest = new PersonSeat({ name: peer, send: sendPeer });
                opponent = guest;
            }
            let leave = null;
            const stop = new Promise((resolve) => (leave = resolve));
            game = { id, person, guest, over: false, seats: { person: seat, guest: other }, leave };
            const g = game;
            const seats = { [seat]: person, [other]: opponent };
            const screens = { [seat]: send, ...(guest ? { [other]: sendPeer } : {}) };
            const ended = (m) => {
                send(m);
                if (guest) {
                    sendPeer(m);
                }
            };
            // against a bot the person may take back moves (table.js); two people may not
            host.done = playSeats({ env, seats, screens, decks: { [seat]: mine, [other]: theirs }, seed, key, stop, undo: guest ? [] : [seat] })
                .catch((e) => {
                    ended({ t: 'end', winner: null, outcome: 'ERROR', round: 0, steps: 0, error: String(e?.message ?? e).slice(0, 200), by: null, conceded: false, concededBy: null, replay: null });
                    return { result: null, replay: null };
                })
                .finally(() => {
                    g.over = true;
                    if (!guest) {
                        Promise.resolve(opponent.close?.()).catch(() => undefined);
                    }
                });
            return { id, seat, ...(guest ? { peerSeat: other } : {}) };
        },
        act: (reply) => (game && !game.over ? game.person.answer(reply) : 'no game is being played'),
        peerAct: (reply) => (game && !game.over && game.guest ? game.guest.answer(reply) : 'no game is being played'),
        concede: () => concede('person'),
        peerConcede: () => concede('guest'),
        setCap: (name, ms) => {
            if (Number.isSafeInteger(ms) && ms >= 1000) {
                caps.set(name, ms);
            }
        },
        capOf: (name) => caps.get(name) ?? capMs,
        cardText: (extra = []) => cardTextOf(env, [...decks, ...extra.map((d) => deckOf(d, 'deck'))])
    };
    return host;
}

module.exports = { createOpenHost, seatsOf, CAP_MS };
