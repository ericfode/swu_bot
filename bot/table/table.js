'use strict';
/**
 * One game at a table: a person (person.js) against a bot, played by match.js like any arena game. Besides the
 * protocol messages the person's seat gets (hello, decide, over), the screen gets a `move` after every real move, from
 * either seat, with the board as the person sees it then, so the bot's moves can be shown one by one:
 *
 *   { t: 'move', n, seat, kind, label, card?, split?, state }
 *
 * `card` ({id, n, s}) is left out when the person cannot see it after the move (a card the bot resourced, or picked
 * from its own deck or hand), and `label` then says only "a hidden card". At the end the screen gets
 *
 *   { t: 'end', winner, outcome, round, steps, error, by, conceded, replay }
 *
 * with `replay` the game's replay (spec/replay-format.md, both hands, written after the game) as JSON Lines text.
 *
 *   const { result, replay } = await playTable({ env, person, personSeat: 'p1', bot, decks: {p1, p2}, seed, key, send });
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

async function playTable({ env, person, personSeat = 'p1', bot, decks, seed, key = null, send, maxSteps = 6000 }) {
    const bots = personSeat === 'p1' ? [person, bot] : [bot, person];
    const lines = [];
    let n = 0;
    const watch = {
        pre() {},
        post(eg, pid, action, applied) {
            try {
                const personPid = eg.ids[personSeat === 'p1' ? 0 : 1];
                send({ t: 'move', n: ++n, ...describe(eg, pid, action, applied, personPid), state: view(eg, personSeat) });
            } catch (e) {
                // a view must never stop the game
                console.error(`table: could not describe move ${n}: ${e.message}`);
            }
        },
        end() {}
    };
    const result = await playGame(env, {
        seed, bots, decks, key, record: true, maxSteps, snapshot, watch,
        onEvent: (e) => lines.push(JSON.stringify(e))
    });
    delete result.events;
    const replay = lines.join('\n') + '\n';
    send({
        t: 'end', winner: result.winner, outcome: result.outcome, round: result.round, steps: result.steps,
        error: result.error ?? null, by: result.by ?? null, conceded: !!person.conceded, replay
    });
    return { result, replay };
}

module.exports = { playTable, describe, hiddenFrom };
