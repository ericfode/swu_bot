'use strict';

/**
 * Referee side of the bot protocol (spec/protocol.md). match.js gives each player a seat:
 *
 *   ClientSeat  any protocol client: an in-process object or a bot program (bot/stdio.js). The general case.
 *   NativeSeat  a JS bot with engine access, { name, choose({ game, pid, actions, rng }), needsUndo? }.
 *
 * Both have hello(), decide(eg, pid, actions, rng) -> action, reveal(cards), over(result) and `times` (ms per decision).
 */

const path = require('path');
const { splitError } = require('./env');
const { view, promptView, actionView } = require('./view');
const { answer } = require('./stdio');
const { DeckZoneDestination } = require(path.join(__dirname, '..', 'forceteki', 'build/server', 'game/core/Constants.js'));

const PROTOCOL = 'swu-bot-stdio';
const LIMITS = { hello: 30000, decide: 10000, over: 10000 };
const LATE = Symbol('late');

/** A failure the named bot caused: the game ends with outcome ERROR, `by` that seat, and the bot gets no `over`. */
class BotError extends Error {
    constructor(seat, name, why) {
        super(`${seat} ${name}: ${why}`);
        this.seat = seat;
    }
}

const same = (a, b) => a.kind === b.kind && a.label === b.label && a.cardUuid === b.cardUuid && a.arg === b.arg;
const short = (x) => JSON.stringify(x)?.slice(0, 160);
const now = () => process.hrtime.bigint();
const msSince = (t) => Number(now() - t) / 1e6;

class NativeSeat {
    constructor(bot, seat) {
        this.bot = bot;
        this.seat = seat;
        this.needsUndo = !!bot.needsUndo;
        this.times = [];
    }

    async hello() {}

    decide(eg, pid, actions, rng) {
        const t = now();
        const action = this.bot.choose({ game: eg, pid, actions, rng });
        this.times.push(msSince(t));
        return action;
    }

    reveal() {}

    async over() {}
}

class ClientSeat {
    /** game: { players, decks: { p1, p2 }, botSeed, deals(label) -> rng, limits } */
    constructor(client, seat, game) {
        this.client = client;
        this.seat = seat;
        this.game = game;
        this.limits = {
            ...LIMITS, ...game.limits,
            ...(client.startTimeoutMs ? { hello: client.startTimeoutMs } : {}),
            ...(client.timeoutMs ? { decide: client.timeoutMs, over: client.timeoutMs } : {})
        };
        this.v = 1;
        this.needsUndo = false;
        this.joined = false;
        this.seq = 0;
        this.times = [];
        this.revealed = [];
    }

    /** Blame the bot. Its connection is closed: a bot that broke a game starts afresh at its next hello. */
    fail(why) {
        this.client.close?.();
        throw new BotError(this.seat, this.client.name, why);
    }

    /** Send `msg` and wait for the final reply, at most msg.ms (which bounds the whole exchange, sims included). */
    async call(msg, sim) {
        const start = Date.now();
        let timer;
        const late = new Promise((resolve) => {
            timer = setTimeout(() => resolve(LATE), msg.ms);
        });
        let reply;
        try {
            reply = await Promise.race([answer(this.client, msg, sim), late]);
        } catch (e) {
            this.fail(e?.message ?? String(e));
        } finally {
            clearTimeout(timer);
        }
        // the clock also catches an in-process client that blocked the event loop past its budget
        if (reply === LATE || Date.now() - start > msg.ms) {
            this.fail(`no reply to '${msg.t}' within ${msg.ms} ms`);
        }
        if (reply?.t === 'error') {
            this.fail(`error: ${reply.error ?? '(no reason given)'}`);
        }
        return reply;
    }

    async hello() {
        const { players, decks, botSeed } = this.game;
        this.joined = true;
        // hello is the same in every version (v: 1), so any bot can read it; the bot picks the version in ready
        const r = await this.call({
            t: 'hello', protocol: PROTOCOL, v: 1, versions: [1, 2], bot: this.client.name, you: this.seat, seed: botSeed,
            players, deck: decks[this.seat], opponent: decks[this.seat === 'p1' ? 'p2' : 'p1'], ms: this.limits.hello
        });
        if (r?.t !== 'ready') {
            this.fail(`expected ready, got ${short(r)}`);
        }
        if (r.v != null && r.v !== 1 && r.v !== 2) {
            this.fail(`speaks protocol v${r.v}; the referee speaks 1 and 2`);
        }
        this.v = r.v ?? 1;
        this.needsUndo = this.v === 2 && r.sim === true;
    }

    reveal(cards) {
        this.revealed.push(...cards);
    }

    async decide(eg, pid, actions) {
        const ms = this.limits.decide;
        const seq = ++this.seq;
        const sim = this.needsUndo && eg.isActionWindow(pid) ? simulator(eg, pid, (deal) => this.game.deals(`${seq}:${deal}`), Date.now() + ms) : null;
        const msg = {
            t: 'decide', seq, you: this.seat, sim: !!sim, ms, prompt: promptView(eg, pid), state: view(eg, this.seat),
            actions: actions.map((a, i) => actionView(eg, a, i)), revealed: this.revealed.splice(0)
        };
        const t = now();
        let r;
        try {
            r = await this.call(msg, sim ? sim.handle : noSim);
        } finally {
            sim?.finish();
        }
        this.times.push(msSince(t));
        if (r?.t !== 'act' || !Number.isInteger(r.i) || r.i < 0 || r.i >= actions.length) {
            this.fail(`expected {"t":"act","i":0..${actions.length - 1}}, got ${short(r)}`);
        }
        let action = actions[r.i];
        if (sim?.used) {
            // a rollback renews prompt ids, so take the same action from the restored position
            const live = eg.legalActions(pid)[r.i];
            if (!live || !same(live, action)) {
                throw new Error(`legal actions changed across a simulation at decision ${msg.seq}`);
            }
            action = live;
        }
        const split = r.split ?? r.distribution; // `distribution` is the v1 name
        if (split !== undefined && action.kind === 'distribute') {
            const why = splitError(action, split);
            if (why) {
                this.fail(`bad split (${why}): ${short(split)}`);
            }
            action = { ...action, split };
        }
        return action;
    }

    async over({ winner, outcome, round, steps, error, by }) {
        if (this.v < 2 || !this.joined) {
            return;
        }
        const r = await this.call({ t: 'over', you: this.seat, winner, outcome, round, steps, error: error ?? null, by: by ?? null, ms: this.limits.over });
        if (r?.t !== 'ok') {
            this.fail(`expected ok, got ${short(r)}`);
        }
    }
}

const noSim = async (req) => ({ t: 'simulated', op: req?.op ?? null, error: 'simulations are off for this decision' });

/**
 * Deal again every card hidden from `pid`: its own deck order, and the opponent's hand, face-down resources and deck,
 * from a fresh shuffle of all three. Zone sizes and the number of exhausted resources stay. Randomness comes from
 * `rng` (the seat's private stream), with enough entropy that the redeal cannot be predicted and run backwards.
 */
function determinize(eg, pid, rng) {
    eg.game.setRandomSeed([rng(), rng(), rng(), rng()].map((x) => Math.floor(x * 4294967296)).join('.'));
    const me = eg.player(pid);
    const opp = me.opponent;
    me.shuffleDeck();
    // a stolen resource (owned by `pid`) would go back to its owner's deck, so only the opponent's own cards are dealt
    const res = opp.resources.filter((c) => c.owner === opp);
    const exhausted = res.filter((c) => c.exhausted).length;
    const hand = opp.hand.length;
    for (const c of [...opp.hand, ...res]) {
        c.moveTo(DeckZoneDestination.DeckBottom);
    }
    opp.shuffleDeck();
    opp.drawDeck.slice(0, res.length).forEach((c, k) => opp.resourceCard(c, k < exhausted));
    opp.drawCardsToHand(hand);
}

/**
 * The `sim` requests of one decision (spec/protocol.md#sim). Two states: idle and open. The first `begin` bookmarks
 * the real position; `end`, every error and the decision's end return to it. Only `begin` and `act` can fail, and an
 * error reply always leaves the simulation idle. A failed rollback is the referee's fault, so finish() throws it.
 * `deals(label)` is the random stream of one deal: the same `deal` number replays the same cards and random outcomes.
 */
function simulator(eg, pid, deals, deadline) {
    const you = eg.seatOf(pid);
    const opp = eg.player(pid).opponent.id;
    let mark = null,
        open = false,
        done = false,
        actor = null,
        acts = null,
        rng = null,
        fresh = 0,
        broken = null;

    const close = () => {
        if (open) {
            open = false;
            try {
                eg.restore(pid, mark);
            } catch (e) {
                broken ??= e;
            }
        }
    };

    const position = (op) => {
        if (eg.over) {
            acts = null;
            return { t: 'simulated', op, over: { winner: eg.winner } };
        }
        // when both seats have a prompt (regroup resources), yours comes first
        actor = pid;
        acts = eg.legalActions(pid);
        if (!acts.length) {
            actor = opp;
            acts = eg.legalActions(opp);
        }
        if (!acts.length) {
            throw new Error('neither player can act');
        }
        return {
            t: 'simulated', op, actor: eg.seatOf(actor), prompt: promptView(eg, actor), state: view(eg, you),
            actions: acts.map((a, i) => actionView(eg, a, i))
        };
    };

    const step = (req) => {
        if (req.op === 'end') {
            close();
            return { t: 'simulated', op: 'end' };
        }
        if (Date.now() > deadline) {
            throw new Error('out of time for this decision');
        }
        if (req.op === 'begin') {
            if (req.deal !== undefined && !(Number.isSafeInteger(req.deal) && req.deal >= 0)) {
                throw new Error(`bad deal ${short(req.deal)}`);
            }
            close();
            mark ??= eg.mark(pid);
            open = true;
            // a deal without a number is one never used before in this decision
            rng = deals(req.deal ?? `new${fresh++}`);
            determinize(eg, pid, rng);
            return position('begin');
        }
        if (req.op !== 'act') {
            throw new Error(`unknown op ${short(req.op)}`);
        }
        if (!open) {
            throw new Error('no open simulation (send begin first)');
        }
        const a = Number.isInteger(req.i) ? acts?.[req.i] : undefined;
        if (!a) {
            throw new Error(acts ? `no action ${short(req.i)}` : 'the simulated game is over');
        }
        const split = a.kind === 'distribute' ? req.split : undefined;
        const why = split === undefined ? null : splitError(a, split);
        if (why) {
            throw new Error(`bad split (${why})`);
        }
        eg.apply(actor, split === undefined ? a : { ...a, split }, rng);
        return position('act');
    };

    return {
        get used() {
            return mark !== null;
        },
        handle: async (req) => {
            const op = req?.op ?? null;
            // a late call (after act, or from a search still running in the background) must not touch the engine
            if (done) {
                return { t: 'simulated', op, error: 'this decision is over' };
            }
            try {
                return step(req ?? {});
            } catch (e) {
                close();
                return { t: 'simulated', op, error: String(e?.message ?? e).split('\n')[0] };
            }
        },
        finish() {
            done = true;
            close();
            if (broken) {
                throw broken;
            }
        }
    };
}

function seatFor(bot, seat, game) {
    if (typeof bot?.choose === 'function') {
        return new NativeSeat(bot, seat);
    }
    if (typeof bot?.decide === 'function') {
        return new ClientSeat(bot, seat, game);
    }
    throw new Error(`${seat}: a bot needs decide() (protocol client) or choose() (native bot)`);
}

module.exports = { seatFor, ClientSeat, NativeSeat, BotError, determinize, PROTOCOL, LIMITS };
