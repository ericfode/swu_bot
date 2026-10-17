'use strict';

const { gameStreams } = require('./rng');
const { snapshot: boardSnapshot, placedRef, actionKey } = require('./view');
const { seatFor, Shadow, BotError, TakeBack, withSplit, toEngine, VERSIONS } = require('./protocol');
const { gameCards } = require('./game-cards');

/**
 * Play one game between two bots and optionally record every decision (spec/replay-format.md).
 *
 * A bot is a protocol client (spec/protocol.md: any object with decide(), including bot/stdio.js StdioClient for
 * programs in other languages) or a native JS bot with engine access ({ name, choose }, spec/bot-interface.md).
 * The match rng is used in a fixed order (two decks, then per step: actor order, a native bot's choice, a native
 * bot's random split), so a seed plays out identically with and without recording. Protocol clients never draw from it.
 * `decks` ({p1, p2} deck lists) replaces the two random decks; the rng then starts at the first step.
 * `pool` ({cards}, an arena card pool: cardpool.js) deals the two random decks from those cards only.
 * `key` (a secret string) makes every random stream unpredictable from the seed (rng.js gameStreams); without it a
 * bot that knows the seed could rebuild the hidden cards. `limits` overrides the reply budgets of protocol.js LIMITS.
 * `requiredProtocol` requires an explicit ready.v of that version and refuses native bots. The hosted arena sets 2;
 * absent, local callers may still play v1 clients and native bots. `protocols` records only accepted negotiations.
 * `watch` ({ pre(eg, pid, actions, step), post(eg, pid, action, split), end(eg, res), sim?(eg, pid) }) observes every
 * real move, and with `sim` every simulation (sim returns the same three hooks for one, or null): holocron's
 * bots/omni/rs/stress.js.
 * It only reads the engine and must not throw.
 * `engine` adds options to env.newGame for the real game and its lookahead copy, such as { selectionToggles: true }.
 * `stop` (a promise of { seat, why }) ends the game as that seat's loss as soon as it resolves, even while the other
 * seat is deciding: a person who concedes at a table of two people (bot/table/open.js) while the other one thinks.
 * `undo` (seats, such as ['p1']) lets those seats take back moves: a person against a bot at a table (bot/table/), in a
 * game nobody rates. Such a seat's decide says undo: true when it has a move to take back, and its answer {t: 'undo'}
 * plays the game again from the start, without that seat's last move with more than one answer and without anything
 * played after it, so the seat decides that move again (spec/protocol.md#undo). The real game is never rolled back
 * (protocol.js Shadow says why): the same object is filled with a fresh game that played the kept moves. The recording
 * drops the steps taken back, onEvent gets { t: 'rewind', steps } (the steps kept; never recorded) and
 * watch.rewind?.(eg, steps) follows; a game that does not play out the same again keeps its place, and
 * watch.rewind?.(eg, null, why) says so.
 * playGame closes no bot: whoever started a bot program closes it.
 *
 * @returns {{seed, steps, outcome, winner, round, ms, error?, by?, key?, requiredProtocol?, protocols, events, botStats, timing}}
 */
async function playGame(env, { seed, bots, decks: given = null, pool = null, record = false, maxSteps = 6000, snapshot = boardSnapshot, onEvent = null, key = null, limits = {}, requiredProtocol = null, watch = null, engine = {}, stop = null, undo = [] }) {
    if (requiredProtocol != null && !VERSIONS.includes(requiredProtocol)) {
        throw new Error(`unsupported required protocol v${requiredProtocol}`);
    }
    if (bots[0] === bots[1] && typeof bots[0]?.decide === 'function') {
        throw new Error(`${bots[0].name}: one protocol client cannot play both seats`);
    }
    const streams = gameStreams(seed, key);
    const rng = streams.match;
    const t0 = Date.now();
    const deal = pool ? { pool } : {};
    const decks = given ?? { p1: env.randomDeck(rng, deal), p2: env.randomDeck(rng, deal) };
    const players = bots.map((b, i) => ({ id: `p${i + 1}`, name: `p${i + 1}`, bot: b.name }));
    // each seat's setup; `cards` is filled in at the start of the game, below
    const setups = bots.map((b, i) => {
        const seat = `p${i + 1}`;
        return { players, decks, cards: null, botSeed: streams.botSeed(seat), deals: (deal) => streams.sim(seat, deal), limits, requiredProtocol };
    });
    const seats = bots.map((b, i) => seatFor(b, `p${i + 1}`, setups[i]));
    const policy = requiredProtocol == null ? {} : { requiredProtocol };
    const res = { seed, steps: 0, outcome: '?', winner: null, round: 0, ms: 0, ...(key ? { key } : {}), ...policy, protocols: {}, events: [] };
    const stopped = stop && Promise.resolve(stop).then((s) => {
        throw new BotError(s.seat, bots[s.seat === 'p2' ? 1 : 0].name, s.why ?? 'left the game');
    });
    stopped?.catch(() => undefined); // read by the race below; never unhandled
    // every recorded event is also handed to onEvent as it happens, so a viewer can follow the game live
    const emit = (e) => {
        if (record) {
            res.events.push(e);
            onEvent?.(e);
        }
    };
    // the header first, so a game that fails at hello still has one
    emit({
        t: 'header', v: 1, seed, engine: env.engineRev ?? null, ...policy,
        players: bots.map((b, i) => ({ id: `p${i + 1}`, bot: b.name, deck: decks[`p${i + 1}`].metadata.name, ...(b.lang ? { lang: b.lang } : {}) })),
        decks
    });
    let eg = null;
    try {
        // the card data both seats get in hello: every card this game can show them (game-cards.js), one array for both.
        // A list that names a card the card data does not know fails the game here.
        const cards = gameCards(env.cardDataGetter, [decks.p1, decks.p2]);
        setups.forEach((s) => (s.cards = cards));
        for (const s of seats) {
            await s.hello();
            if (s.v !== undefined) {
                res.protocols[s.seat] = s.v;
            }
            if (s.version) {
                (res.versions ??= {})[s.seat] = s.version;
            }
        }
        const setup = { ...engine, seed: streams.engine, deck1: decks.p1, deck2: decks.p2 };
        eg = env.newGame(setup);
        // every lookahead runs on a copy of the game (protocol.js Shadow) that follows every real move
        const shadow = seats.some((s) => s.wantsSims || s.needsUndo) ? new Shadow(env, setup) : null;
        seats.forEach((s) => (s.shadow = shadow));
        // a checker (holocron's bots/omni/rs/mirror.js) may follow the real moves and every simulation; it never changes them
        if (shadow && watch?.sim) {
            shadow.watch = watch.sim;
        }
        // cards revealed by a real move are shown to both seats at their next decision
        let live = false;
        const revealed = (e) => live && seats.forEach((s) => s.reveal((e.cards ?? []).map((c) => placedRef(eg, c))));
        eg.game.on('onCardRevealed', revealed);
        await eg.start();
        emit({ t: 'step', n: 0, label: 'Game start', state: snapshot(eg) });
        // every real move, to play the game again when a seat takes one back
        const moves = [];
        const undoing = new Set(undo);
        /** The game again without `pid`'s last move that had more than one answer, and without every move after it. */
        const takeBack = async (pid) => {
            const keep = moves.findLastIndex((m) => m.pid === pid && m.legal > 1);
            try {
                const fresh = env.newGame(setup);
                fresh.game.on('onCardRevealed', revealed);
                await fresh.start();
                for (const m of moves.slice(0, keep)) {
                    const acts = fresh.legalActions(m.pid);
                    const a = acts[m.i];
                    if (acts.length !== m.legal || !a || actionKey(fresh, a) !== m.key) {
                        throw new Error(`move ${m.n} is not there again`);
                    }
                    fresh.apply(m.pid, withSplit(a, toEngine(fresh, m.split)));
                }
                const again = fresh.legalActions(pid);
                if (again.length !== moves[keep].legal || actionKey(fresh, again[moves[keep].i]) !== moves[keep].key) {
                    throw new Error('the decision is not the same again');
                }
                if (record && JSON.stringify(snapshot(fresh)) !== JSON.stringify(res.events[keep + 1].state)) {
                    throw new Error('the board is not the same again');
                }
                // the same object, as protocol.js Shadow does: native bots tell games apart by it
                Object.assign(eg, fresh);
            } catch (e) {
                watch?.rewind?.(eg, null, e.message);
                return;
            }
            moves.length = keep;
            res.steps = keep;
            if (record) {
                res.events.length = keep + 2; // the header, the start and the moves kept
                onEvent?.({ t: 'rewind', steps: keep });
            }
            if (shadow) {
                shadow.moves = moves.slice();
                shadow.drop();
            }
            // cards a move taken back revealed are not shown any more
            seats.forEach((s) => s.revealed?.splice(0));
            watch?.rewind?.(eg, keep);
        };
        while (!eg.over && res.steps < maxSteps) {
            const order = rng() < 0.5 ? eg.ids : [...eg.ids].reverse();
            let actions = [];
            const pid = order.find((id) => (actions = eg.legalActions(id)).length);
            if (!pid) {
                res.outcome = 'STUCK';
                break;
            }
            const prompt = eg.promptSignature(pid);
            const title = eg.player(pid).currentPrompt().menuTitle ?? null;
            watch?.pre(eg, pid, actions, res.steps);
            const seat = seats[eg.ids.indexOf(pid)];
            seat.mayUndo = undoing.has(seat.seat) && moves.some((m) => m.pid === pid && m.legal > 1);
            const asked = seat.decide(eg, pid, actions, rng);
            let action;
            try {
                action = await (stopped ? Promise.race([asked, stopped]) : asked);
            } catch (e) {
                if (!(e instanceof TakeBack)) {
                    throw e;
                }
                await takeBack(pid);
                continue;
            }
            // a seat answers with one of `actions`, or a copy of it that carries a split
            const i = actions.findIndex((a) => a === action || actionKey(eg, a) === actionKey(eg, action));
            if (i < 0) {
                throw new Error(`${action.label} is not one of the legal actions`);
            }
            const move = { pid, i, legal: actions.length, key: actionKey(eg, actions[i]) };
            live = true;
            const applied = eg.apply(pid, action, rng);
            const split = applied?.map((e) => ({ id: eg.cardId(e.id), amount: e.amount }));
            live = false;
            watch?.post(eg, pid, action, applied);
            res.steps++;
            const made = { ...move, split, n: res.steps };
            moves.push(made);
            shadow?.record(made);
            if (record) {
                const id = action.cardUuid ?? (action.kind === 'displayCard' ? action.arg : undefined);
                emit({
                    t: 'step', n: res.steps, pid: eg.seatOf(pid), prompt, title,
                    action: { kind: action.kind, label: action.label, i, ...(id !== undefined ? { id: eg.cardId(id) } : {}), ...(split ? { split } : {}) },
                    legal: actions.length, state: snapshot(eg)
                });
            }
        }
        if (res.outcome === '?') {
            res.outcome = eg.over ? 'won' : 'STEP_CAP';
        }
        res.winner = eg.winner;
        res.round = eg.round;
    } catch (e) {
        res.outcome = 'ERROR';
        res.error = String(e?.message ?? e).split('\n')[0].slice(0, 200);
        // a bot that breaks the game loses it
        res.by = e instanceof BotError ? e.seat : null;
        res.winner = res.by ? (res.by === 'p1' ? 'p2' : 'p1') : null;
        res.round = eg?.round ?? 0;
    }
    if (eg) {
        watch?.end(eg, res);
    }
    // every bot that joined hears the result, except one that broke the game; a failure here changes no result
    for (const s of seats) {
        if (s.seat !== res.by) {
            await s.over(res).catch((e) => console.error(`after game ${seed}: ${e.message}`));
        }
    }
    res.ms = Date.now() - t0;
    res.botStats = bots.map((b) => b.stats ?? null);
    res.timing = { p1: timingSummary(seats[0].times), p2: timingSummary(seats[1].times) };
    emit({ t: 'end', winner: res.winner, round: res.round, steps: res.steps, outcome: res.outcome, error: res.error ?? null, by: res.by ?? null, ...policy, protocols: res.protocols, ...(key ? { key } : {}) });
    return res;
}

/** {n, ms (total), p50, p95, max} of per-decision milliseconds. */
function timingSummary(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const q = (f) => (s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : 0);
    const r = (x) => Math.round(x * 1000) / 1000;
    return { n: s.length, ms: r(s.reduce((a, b) => a + b, 0)), p50: r(q(0.5)), p95: r(q(0.95)), max: r(s.length ? s[s.length - 1] : 0) };
}

module.exports = { playGame, timingSummary };
