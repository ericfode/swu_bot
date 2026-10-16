'use strict';

/**
 * Referee side of the bot protocol (spec/protocol.md). match.js gives each player a seat:
 *
 *   ClientSeat  any protocol client: an in-process object or a bot program (bot/stdio.js). The general case.
 *   NativeSeat  a JS bot with engine access, { name, choose({ game, pid, actions, rng }), needsUndo? }.
 *
 * Both have hello(), decide(eg, pid, actions, rng) -> action, reveal(cards), over(result) and `times` (ms per decision).
 * Every lookahead (simulations, a native bot's rollback search) runs on a Shadow, a second engine that follows the
 * real game, so the real game is never rolled back.
 */

const path = require('path');
const { splitError, randomSplit } = require('./env');
const { view, promptView, actionView, actionKey } = require('./view');
const { answer } = require('./stdio');
const { DeckZoneDestination } = require(path.join(__dirname, '..', 'forceteki', 'build/server', 'game/core/Constants.js'));

const PROTOCOL = 'swu-bot-stdio';
const VERSIONS = [1, 2];
const LIMITS = { hello: 30000, decide: 10000, over: 10000 };
const MAX_MS = 2 ** 31 - 1; // a longer timer would fire at once
const OPS = new Set(['begin', 'act', 'end']);
const LATE = Symbol('late');
const NEVER = new Promise(() => undefined);

/** A failure the named bot caused: the game ends with outcome ERROR, `by` that seat, and the other seat wins. */
class BotError extends Error {
    constructor(seat, name, why) {
        super(`${seat} ${name}: ${why}`);
        this.seat = seat;
    }
}

/** A seat that may take back moves (match.js `undo`: a person at a table) answered {t: 'undo'}. */
class TakeBack extends Error {
    constructor(seat) {
        super(`${seat} takes back a move`);
        this.seat = seat;
    }
}

const short = (x) => JSON.stringify(x)?.slice(0, 160);
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];
const now = () => process.hrtime.bigint();
const msSince = (t) => Number(now() - t) / 1e6;
/** A split as bots send it (card ids) in engine terms (uuids); anything malformed is left for splitError. */
const toEngine = (eg, split) => (Array.isArray(split) ? split.map((e) => ({ id: eg.uuidOf(e?.id), amount: e?.amount })) : split);

/** Distribute action `a` with an engine split, checked; any other action, or no split, as it is. */
function withSplit(a, split) {
    if (a.kind !== 'distribute' || split === undefined) {
        return a;
    }
    const why = splitError(a, split);
    if (why) {
        throw new Error(`bad split (${why})`);
    }
    return { ...a, split };
}

/** A time limit in ms, or null for none (also for limits too long for a timer). */
function budget(ms) {
    if (ms === null || ms >= MAX_MS) {
        return null;
    }
    if (!(ms > 0)) {
        throw new Error(`bad time limit ${ms}`);
    }
    return Math.ceil(ms);
}

class NativeSeat {
    constructor(bot, seat) {
        this.bot = bot;
        this.seat = seat;
        this.needsUndo = !!bot.needsUndo;
        this.shadow = null;
        this.times = [];
    }

    async hello() {}

    /**
     * A bot that searches by rollback gets the copy, never the real game. choose may return a promise. A throw, an
     * action that is not legal or a bad split is the bot's failure.
     */
    async decide(eg, pid, actions, rng) {
        const game = this.needsUndo ? await this.shadow.sync(eg, pid) : eg;
        if (!game) {
            throw new Error(`${this.seat} ${this.bot.name}: the lookahead copy cannot follow the game`);
        }
        const legal = game === eg ? actions : game.legalActions(pid);
        const t = now();
        let action;
        try {
            action = await this.bot.choose({ game, pid, actions: legal, rng });
        } catch (e) {
            throw new BotError(this.seat, this.bot.name, firstLine(e));
        }
        this.times.push(msSince(t));
        try {
            // matched by key: after the bot's own rollbacks its answer may hold stale prompt uuids
            const key = action ? actionKey(game, action) : null;
            const i = legal.findIndex((a) => actionKey(game, a) === key);
            if (i < 0) {
                throw new Error(`chose an action that is not legal: ${short(action?.label)}`);
            }
            const split = Array.isArray(action.split) ? action.split.map((e) => ({ id: eg.uuidOf(game.cardId(e?.id)), amount: e?.amount })) : action.split;
            return withSplit(actions[i], split);
        } catch (e) {
            throw new BotError(this.seat, this.bot.name, e.message);
        }
    }

    reveal() {}

    async over() {}
}

class ClientSeat {
    /**
     * setup: { players, decks: { p1, p2 }, cards, botSeed, deals(label) -> rng, limits }, cards being the game's card data
     * (game-cards.js), set before hello; match.js sets `shadow` after hello.
     * Time limits: the referee's LIMITS, then the bot's own timeoutMs/startTimeoutMs, then the game's `limits`.
     */
    constructor(client, seat, setup) {
        this.client = client;
        this.seat = seat;
        this.setup = setup;
        const limits = {
            ...LIMITS,
            ...(client.startTimeoutMs ? { hello: client.startTimeoutMs } : {}),
            ...(client.timeoutMs ? { decide: client.timeoutMs, over: client.timeoutMs } : {}),
            ...setup.limits
        };
        this.limits = Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, budget(v)]));
        this.splits = setup.deals('split'); // random splits for a client that sends none
        this.shadow = null;
        this.v = 1;
        this.wantsSims = false;
        this.wantsNoEffect = false;
        this.simEngine = null;
        this.seq = 0;
        this.times = [];
        this.revealed = [];
        // match.js sets it before each decision of a seat that may take back moves and has one to take back
        this.mayUndo = false;
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
        const late = msg.ms === null ? NEVER : new Promise((resolve) => {
            timer = setTimeout(() => resolve(LATE), msg.ms);
        });
        let reply;
        try {
            reply = await Promise.race([answer(this.client, msg, sim), late]);
        } catch (e) {
            this.fail(firstLine(e));
        } finally {
            clearTimeout(timer);
        }
        // the clock also catches an in-process client that blocked the event loop past its budget
        if (reply === LATE || (msg.ms !== null && Date.now() - start > msg.ms)) {
            this.fail(`no reply to '${msg.t}' within ${msg.ms} ms`);
        }
        if (reply?.t === 'error') {
            this.fail(`error: ${reply.error ?? '(no reason given)'}`);
        }
        return reply;
    }

    async hello() {
        const { players, decks, cards, botSeed } = this.setup;
        // the same in every version (v: 1), so any bot can read it; the bot picks the version in ready. A copy, so an
        // in-process client cannot change the deck lists the game is built from, nor the card data the engine plays.
        const r = await this.call(JSON.parse(JSON.stringify({
            t: 'hello', protocol: PROTOCOL, v: 1, versions: VERSIONS, bot: this.client.name, you: this.seat, seed: botSeed,
            players, deck: decks[this.seat], opponent: decks[this.seat === 'p1' ? 'p2' : 'p1'], ms: this.limits.hello, cards
        })));
        if (r?.t !== 'ready') {
            this.fail(`expected ready, got ${short(r)}`);
        }
        const v = r.v ?? 1;
        if (!VERSIONS.includes(v)) {
            this.fail(`speaks protocol v${short(v)}; the referee speaks ${VERSIONS.join(' and ')}`);
        }
        this.v = v;
        this.wantsSims = v === 2 && r.sim === true;
        // simulations on the Rust engine when it knows every card (bot/sims/rust-sims.js); forceteki otherwise
        this.simEngine = this.wantsSims && r.simEngine === 'rust' ? 'rust' : null;
        // card actions that would change nothing marked noEffect (a person's screen greys them)
        this.wantsNoEffect = v === 2 && r.noEffect === true;
        // the build that plays this game, recorded with the result (informational, any version)
        this.version = typeof r.version === 'string' && r.version ? r.version.slice(0, 200) : null;
    }

    reveal(cards) {
        this.revealed.push(...cards);
    }

    async decide(eg, pid, actions) {
        const ms = this.limits.decide;
        const seq = ++this.seq;
        let sim = null;
        if (this.wantsSims && eg.isActionWindow(pid)) {
            const deals = (deal) => this.setup.deals(`${seq}:${deal}`);
            sim = this.simEngine ? await require('./sims/rust-sims').rustSimulator(eg, pid, deals, ms) : null;
            // the copy catches up with the real game before the clock starts
            const copy = sim ? null : await this.shadow.sync(eg, pid);
            sim ??= copy ? simulator(this.shadow, pid, deals, ms === null ? null : Date.now() + ms) : null;
        }
        const marks = this.wantsNoEffect && eg.isActionWindow(pid);
        const msg = {
            t: 'decide', seq, you: this.seat, sim: !!sim, ...(sim?.engine ? { simEngine: sim.engine } : {}), ...(this.mayUndo ? { undo: true } : {}),
            ms, prompt: promptView(eg, pid), state: view(eg, this.seat),
            actions: actions.map((a, i) => {
                const out = actionView(eg, a, i, pid);
                if (marks && a.kind === 'card' && out.card?.id !== 'hidden' && eg.wouldDoNothing(pid, a.card)) {
                    out.noEffect = true;
                }
                return out;
            }), revealed: this.revealed.splice(0)
        };
        const t = now();
        let r;
        try {
            r = await this.call(msg, sim ? sim.handle : noSim);
        } finally {
            sim?.finish();
        }
        this.times.push(msSince(t));
        if (r?.t === 'undo' && msg.undo) {
            throw new TakeBack(this.seat);
        }
        if (r?.t !== 'act' || !Number.isInteger(r.i) || r.i < 0 || r.i >= actions.length) {
            this.fail(`expected {"t":"act","i":0..${actions.length - 1}}, got ${short(r)}`);
        }
        const action = actions[r.i];
        const given = r.split ?? r.distribution; // `distribution` is the v1 name
        if (action.kind === 'distribute' && given === undefined) {
            return { ...action, split: randomSplit(action, this.splits) };
        }
        try {
            return withSplit(action, toEngine(eg, given));
        } catch (e) {
            this.fail(`${e.message}: ${short(given)}`);
        }
    }

    async over({ winner, outcome, round, steps, error, by }) {
        // v1 bots, and bots that never got hello (v stays 1), get no over
        if (this.v < 2) {
            return;
        }
        const r = await this.call({ t: 'over', you: this.seat, winner, outcome, round, steps, error: error ?? null, by: by ?? null, ms: this.limits.over });
        if (r?.t !== 'ok') {
            this.fail(`expected ok, got ${short(r)}`);
        }
    }
}

const noSim = async (req) => (req?.op === 'end' ? { t: 'simulated', op: 'end' }
    : { t: 'simulated', op: OPS.has(req?.op) ? req.op : null, error: 'simulations are off for this decision' });

const legalKeys = (eg, pid) => eg.legalActions(pid).map((a) => actionKey(eg, a)).join('\n');

/** Everything that tells two engines apart: the whole board, both deck orders, resources and prompts. */
const fingerprint = (eg) => JSON.stringify([view(eg), eg.ids.map((id) => {
    const p = eg.player(id);
    return [p.drawDeck.map((c) => eg.cardId(c.uuid)), p.resources.map((c) => eg.cardId(c.uuid) + (c.exhausted ? 'x' : '')), eg.promptSignature(id)];
})]);

/**
 * A second engine that plays the real game's moves and runs every lookahead: simulations and the rollback searches of
 * native bots. A rollback does not restore every engine detail (the order of simultaneous triggers, some prompt
 * texts, the names of new cards, whether an ability "will have no effect"), so the real game is never rolled back.
 * When the copy no longer matches the real game it is built again from the moves, in the same object (native bots
 * tell games apart by it); when even that fails, the copy is lost for the rest of the game.
 */
class Shadow {
    /** setup: the real game's newGame options (seed, deck1, deck2). */
    constructor(env, setup) {
        this.env = env;
        this.setup = setup;
        this.moves = [];
        this.eg = null;
        this.stale = true;
        this.at = 0;
        this.lost = false;
    }

    /** A real move { pid, i, legal, key, split }: action i of `legal` (actionKey `key`), split in card ids. */
    record(move) {
        this.moves.push(move);
    }

    /** The copy at the real game's position, with the same legal actions for `pid`; null once the copy is lost. */
    async sync(real, pid) {
        for (let attempt = 0; attempt < 2 && !this.lost; attempt++) {
            if (this.stale) {
                const fresh = this.env.newGame({ ...this.setup, undo: true });
                await fresh.start();
                this.eg = this.eg ? Object.assign(this.eg, fresh) : fresh;
                this.stale = false;
                this.at = 0;
            }
            if (this.follow() && fingerprint(this.eg) === fingerprint(real) && legalKeys(this.eg, pid) === legalKeys(real, pid)) {
                return this.eg;
            }
            this.stale = true;
        }
        if (!this.lost) {
            this.lost = true;
            console.error(`seed ${this.setup.seed}: the lookahead copy cannot follow the game`);
        }
        return null;
    }

    follow() {
        try {
            for (; this.at < this.moves.length; this.at++) {
                const m = this.moves[this.at];
                const acts = this.eg.legalActions(m.pid);
                const a = acts[m.i];
                if (acts.length !== m.legal || !a || actionKey(this.eg, a) !== m.key) {
                    return false;
                }
                this.eg.apply(m.pid, withSplit(a, toEngine(this.eg, m.split)));
            }
            return true;
        } catch {
            return false;
        }
    }

    /** Throw the copy's state away (after a failed rollback); the next sync builds it again. */
    drop() {
        this.stale = true;
    }
}

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
 * The `sim` requests of one decision (spec/protocol.md#sim), on the shadow's engine. Two states: idle and open. The
 * first `begin` bookmarks the position; `end`, every error and the decision's end return to it. Only `begin` and `act`
 * can fail, and an error reply always leaves the simulation idle. Past the deadline, and after the decision, requests
 * get no reply, so a client looping on them cannot hold up the referee. `deals(label)` is the random stream of one deal.
 */
function simulator(shadow, pid, deals, deadline) {
    const eg = shadow.eg;
    const you = eg.seatOf(pid);
    const opp = eg.player(pid).opponent.id;
    let mark = null,
        open = false,
        done = false,
        broken = false,
        actor = null,
        acts = null,
        rng = null,
        fresh = 0,
        mirror = null, // a checker following this simulation (shadow.watch), if any
        moves = 0;
    const left = () => (deadline === null ? null : Math.max(0, deadline - Date.now()));

    const close = () => {
        mirror?.end(eg);
        mirror = null;
        if (open) {
            open = false;
            try {
                eg.restore(pid, mark);
            } catch {
                broken = true;
                shadow.drop();
            }
        }
    };

    const position = (op) => {
        if (eg.over) {
            acts = null;
            return { t: 'simulated', op, ms: left(), over: { winner: eg.winner } };
        }
        // when both seats have a prompt (setup and regroup resources), yours comes first
        actor = pid;
        acts = eg.legalActions(pid);
        if (!acts.length) {
            actor = opp;
            acts = eg.legalActions(opp);
        }
        if (!acts.length) {
            throw new Error('neither player can act');
        }
        mirror?.pre(eg, actor, acts, moves);
        return {
            t: 'simulated', op, ms: left(), actor: eg.seatOf(actor), prompt: promptView(eg, actor), state: view(eg, you),
            actions: acts.map((a, i) => actionView(eg, a, i, actor))
        };
    };

    const step = (req) => {
        if (req.op === 'end') {
            close();
            return { t: 'simulated', op: 'end', ms: left() };
        }
        if (broken) {
            throw new Error('simulations failed for this decision');
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
            mirror = shadow.watch?.(eg, pid) ?? null;
            moves = 0;
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
        const applied = eg.apply(actor, withSplit(a, toEngine(eg, req.split)), rng);
        mirror?.post(eg, actor, a, applied);
        moves++;
        return position('act');
    };

    return {
        handle(req) {
            if (done || (deadline !== null && Date.now() > deadline)) {
                return NEVER;
            }
            try {
                return Promise.resolve(step(req ?? {}));
            } catch (e) {
                close();
                return Promise.resolve({ t: 'simulated', op: OPS.has(req?.op) ? req.op : null, ms: left(), error: firstLine(e) });
            }
        },
        finish() {
            done = true;
            close();
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

module.exports = { seatFor, ClientSeat, NativeSeat, Shadow, BotError, TakeBack, determinize, withSplit, toEngine, PROTOCOL, VERSIONS, LIMITS };
