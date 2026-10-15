'use strict';
/**
 * A person's seat at a table: a protocol v2 client (spec/protocol.md) whose answers come from a person at a screen
 * (Holotable's play page) instead of a program. The referee (match.js, protocol.js ClientSeat) treats it like any
 * other bot, so a person plays the same game a bot plays and sees only what their seat sees: decide.state is the
 * board from their seat, with the other hand and both decks hidden.
 *
 *   const seat = new PersonSeat({ name: 'you', send: (msg) => ... });   // send: every message for the screen
 *   playGame(env, { bots: [seat, bot], ... });
 *   seat.answer({ t: 'act', seq: 4, i: 2 })      -> null when taken, else why not (the person can try again)
 *   seat.concede()                               // the game ends now; the other seat wins
 *
 * A person has no clock (timeoutMs Infinity: the referee sends ms null). Unlike a bot's, a person's wrong answer
 * (an old decision, an index out of range, a split that does not add up) is refused here and the decision stays open,
 * so a slip never loses the game; only concede() ends it early.
 */

const ACT = new Set(['act']);

/**
 * Why `split` is not a legal split of distribute action `d` (decide.actions[i].distribute), or null when it is:
 * listed targets only, each at most once, whole amounts from 0 to the target's cap, at most maxTargets non-zero
 * entries, a total of `amount` (at most `amount` with canDistributeLess; 0 only with canChooseNoTargets).
 */
function splitProblem(d, split) {
    if (!Array.isArray(split)) {
        return 'the split is not a list';
    }
    const caps = new Map(d.targets.map((t) => [t.id, t.cap]));
    const seen = new Set();
    let total = 0;
    let used = 0;
    for (const e of split) {
        if (!e || !caps.has(e.id)) {
            return `${e?.id ?? 'a target'} cannot take any`;
        }
        if (seen.has(e.id)) {
            return `${e.id} is named twice`;
        }
        seen.add(e.id);
        const cap = caps.get(e.id);
        if (!Number.isInteger(e.amount) || e.amount < 0 || (cap !== null && e.amount > cap)) {
            return `${e.id} can take 0 to ${cap ?? d.amount}, not ${e.amount}`;
        }
        total += e.amount;
        used += e.amount > 0 ? 1 : 0;
    }
    if (d.maxTargets != null && used > d.maxTargets) {
        return `at most ${d.maxTargets} target${d.maxTargets === 1 ? '' : 's'}`;
    }
    if (total > d.amount || (total < d.amount && !d.canDistributeLess)) {
        return `the split adds up to ${total}, it must be ${d.canDistributeLess ? 'at most ' : ''}${d.amount}`;
    }
    if (total === 0 && !d.canChooseNoTargets && d.amount > 0) {
        return 'choose at least one target';
    }
    return null;
}

class PersonSeat {
    constructor({ name = 'person', send }) {
        this.name = name;
        this.lang = 'person';
        this.timeoutMs = Infinity;
        this.startTimeoutMs = Infinity;
        this.send = send;
        this.pending = null; // { msg, resolve }
        this.conceded = false;
    }

    hello(msg) {
        this.send(msg);
        return { t: 'ready', v: 2, name: this.name };
    }

    decide(msg) {
        if (this.conceded) {
            return { t: 'error', error: 'conceded' };
        }
        return new Promise((resolve) => {
            this.pending = { msg, resolve };
            this.send(msg);
        });
    }

    /** The person's answer to the open decision: null when taken, else why it was refused (the decision stays open). */
    answer(reply) {
        const p = this.pending;
        if (!p) {
            return 'nothing to answer now';
        }
        if (!reply || !ACT.has(reply.t) || reply.seq !== p.msg.seq) {
            return 'that answer is for another decision';
        }
        const a = Number.isInteger(reply.i) ? p.msg.actions[reply.i] : undefined;
        if (!a) {
            return `no choice ${reply.i}`;
        }
        const out = { t: 'act', i: reply.i };
        if (a.kind === 'distribute' && reply.split !== undefined) {
            const why = splitProblem(a.distribute, reply.split);
            if (why) {
                return why;
            }
            out.split = reply.split.map((e) => ({ id: e.id, amount: e.amount }));
        }
        this.pending = null;
        p.resolve(out);
        return null;
    }

    /** Give up: the open decision (or the next one) answers with an error, which ends the game as a loss for this seat. */
    concede() {
        this.conceded = true;
        const p = this.pending;
        this.pending = null;
        p?.resolve({ t: 'error', error: 'conceded' });
    }

    over(msg) {
        this.pending = null;
        this.send(msg);
        return { t: 'ok' };
    }

    close() {
        this.concede();
    }
}

module.exports = { PersonSeat, splitProblem };
