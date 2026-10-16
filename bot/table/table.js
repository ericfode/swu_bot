'use strict';
/**
 * One game at a table: a person (person.js) against a bot, or two people (open.js), played by match.js like any arena
 * game. Besides the protocol messages a person's seat gets (hello, decide, over), each person's screen gets a `move`
 * after every real move, from either seat, with the board as that person sees it then, so the other side's moves can
 * be shown one by one:
 *
 *   { t: 'move', n, seat, kind, label, card?, split?, state }
 *
 * `card` ({id, n, s}) is left out when that person cannot see it after the move (a card the other side resourced, or
 * picked from its own deck or hand), and `label` then says only "a hidden card". At the end each screen gets
 *
 *   { t: 'end', winner, outcome, round, steps, error, by, conceded, concededBy, replay }
 *
 * with `replay` the game's replay (spec/replay-format.md, both hands, written after the game) as JSON Lines text,
 * `conceded` whether this screen's person conceded and `concededBy` the seat that did, or null.
 *
 * A person against a bot may take back moves (`undo`, match.js): their decide then says undo: true, and the answer
 * {t: 'undo'} plays the game again up to their last real choice. Each screen then gets
 *
 *   { t: 'rewind', n, state }        the moves after move n are gone; the board is `state` again
 *   { t: 'rewind', error }           the move could not be taken back; the game goes on where it was
 *
 * and the replay keeps only the moves that stand.
 *
 *   const { result, replay } = await playTable({ env, person, personSeat: 'p1', bot, decks: {p1, p2}, seed, key, send });
 *   const { result, replay } = await playSeats({ env, seats: { p1, p2 }, screens: { p1: send1, p2: send2 }, decks, seed, key, undo });
 *
 * playSeats takes any two protocol clients; `screens` names the seats that are people (PersonSeat), each with the
 * function that gets that person's moves and end. `stop` is match.js's: a promise of {seat, why} that ends the game as
 * that seat's loss at once (a person who concedes while the other one has the decision).
 */
const { playGame } = require('../match');
const { view, snapshot, placedRef } = require('../view');

const HIDDEN = 'a hidden card';

/** A card `pid` cannot see: in a deck, or in the other player's hand or resources (view.js hiddenFrom). */
const hiddenFrom = (card, pid) => !card || card.zoneName === 'deck' || ((card.zoneName === 'hand' || card.zoneName === 'resource') && card.controller?.id !== pid);

/** The card a move acted on, as an engine card, or null. */
function movedCard(eg, action) {
    if (action.kind === 'card') {
        return action.card ?? null;
    }
    const uuid = action.kind === 'displayCard' ? action.arg : action.kind === 'perCardButton' ? action.cardUuid : null;
    return uuid ? eg.game.findAnyCardInAnyList(uuid) ?? null : null;
}

/** A move as the person may see it: everything for their own, only what is open for the bot's. */
function describe(eg, pid, action, applied, personPid) {
    const own = pid === personPid;
    const out = { seat: eg.seatOf(pid), kind: action.kind, label: String(action.label ?? '') };
    const card = movedCard(eg, action);
    if (card) {
        if (own || !hiddenFrom(card, personPid)) {
            const { id, n, s } = placedRef(eg, card);
            out.card = { id, n, s };
            out.label = action.kind === 'perCardButton' ? `${String(action.label).split(':')[0]}: ${card.title}` : card.title;
        } else {
            out.label = action.kind === 'perCardButton' ? `${String(action.label).split(':')[0]}: ${HIDDEN}` : HIDDEN;
        }
    } else if (action.kind === 'displayCard' || action.kind === 'perCardButton') {
        out.label = own ? out.label : HIDDEN;
    }
    if (applied?.length) {
        out.split = applied.map((e) => ({ id: eg.cardId(e.id), amount: e.amount }));
    }
    return out;
}

async function playSeats({ env, seats, screens, decks, seed, key = null, maxSteps = 6000, stop = null, undo = [] }) {
    const bots = [seats.p1, seats.p2];
    const people = Object.entries(screens).filter(([, send]) => typeof send === 'function');
    const lines = [];
    let n = 0;
    const watch = {
        pre() {},
        post(eg, pid, action, applied) {
            n++;
            for (const [seat, send] of people) {
                try {
                    const personPid = eg.ids[seat === 'p1' ? 0 : 1];
                    send({ t: 'move', n, ...describe(eg, pid, action, applied, personPid), state: view(eg, seat) });
                } catch (e) {
                    // a view must never stop the game
                    console.error(`table: could not describe move ${n} for ${seat}: ${e.message}`);
                }
            }
        },
        rewind(eg, steps, why) {
            if (steps !== null) {
                n = steps;
            }
            for (const s of bots) {
                s.rewound?.(steps !== null);
            }
            for (const [seat, send] of people) {
                try {
                    send(steps === null ? { t: 'rewind', error: why } : { t: 'rewind', n, state: view(eg, seat) });
                } catch (e) {
                    console.error(`table: could not show the rewind to ${seat}: ${e.message}`);
                }
            }
        },
        end() {}
    };
    const result = await playGame(env, {
        seed, bots, decks, key, record: true, maxSteps, snapshot, watch, stop, undo,
        // a rewind keeps the header, the start and the moves that stand
        onEvent: (e) => (e.t === 'rewind' ? (lines.length = e.steps + 2) : lines.push(JSON.stringify(e)))
    });
    delete result.events;
    const replay = lines.join('\n') + '\n';
    const concededBy = ['p1', 'p2'].find((s) => seats[s].conceded) ?? null;
    for (const [seat, send] of people) {
        send({
            t: 'end', winner: result.winner, outcome: result.outcome, round: result.round, steps: result.steps,
            error: result.error ?? null, by: result.by ?? null, conceded: concededBy === seat, concededBy, replay
        });
    }
    return { result, replay };
}

/** A person against a bot. Nobody rates these games, so the person may take back moves (`undo`, on by default). */
function playTable({ env, person, personSeat = 'p1', bot, decks, seed, key = null, send, maxSteps = 6000, undo = true }) {
    const seats = personSeat === 'p1' ? { p1: person, p2: bot } : { p1: bot, p2: person };
    return playSeats({ env, seats, screens: { [personSeat]: send }, decks, seed, key, maxSteps, undo: undo ? [personSeat] : [] });
}

module.exports = { playTable, playSeats, describe, hiddenFrom };
