'use strict';

const { gameStreams } = require('./rng');
const { snapshot: boardSnapshot, placedRef, actionKey } = require('./view');
const { seatFor, Shadow, BotError } = require('./protocol');

/**
 * Play one game between two bots and optionally record every decision (spec/replay-format.md).
 *
 * A bot is a protocol client (spec/protocol.md: any object with decide(), including bot/stdio.js StdioClient for
 * programs in other languages) or a native JS bot with engine access ({ name, choose }, spec/bot-interface.md).
 * The match rng is used in a fixed order (two decks, then per step: actor order, a native bot's choice, a native
 * bot's random split), so a seed plays out identically with and without recording. Protocol clients never draw from it.
 * `key` (a secret string) makes every random stream unpredictable from the seed (rng.js gameStreams); without it a
 * bot that knows the seed could rebuild the hidden cards. `limits` overrides the reply budgets of protocol.js LIMITS.
 * playGame closes no bot: whoever started a bot program closes it.
 *
 * @returns {{seed, steps, outcome, winner, round, ms, error?, by?, key?, events, botStats, timing}}
 */
async function playGame(env, { seed, bots, record = false, maxSteps = 6000, snapshot = boardSnapshot, onEvent = null, key = null, limits = {} }) {
    if (bots[0] === bots[1] && typeof bots[0]?.decide === 'function') {
        throw new Error(`${bots[0].name}: one protocol client cannot play both seats`);
    }
    const streams = gameStreams(seed, key);
    const rng = streams.match;
    const t0 = Date.now();
    const decks = { p1: env.randomDeck(rng), p2: env.randomDeck(rng) };
    const players = bots.map((b, i) => ({ id: `p${i + 1}`, name: `p${i + 1}`, bot: b.name }));
    const seats = bots.map((b, i) => {
        const seat = `p${i + 1}`;
        return seatFor(b, seat, { players, decks, botSeed: streams.botSeed(seat), deals: (deal) => streams.sim(seat, deal), limits });
    });
    const res = { seed, steps: 0, outcome: '?', winner: null, round: 0, ms: 0, ...(key ? { key } : {}), events: [] };
    // every recorded event is also handed to onEvent as it happens, so a viewer can follow the game live
    const emit = (e) => {
        if (record) {
            res.events.push(e);
            onEvent?.(e);
        }
    };
    // the header first, so a game that fails at hello still has one
    emit({
        t: 'header', v: 1, seed, engine: env.engineRev ?? null,
        players: bots.map((b, i) => ({ id: `p${i + 1}`, bot: b.name, deck: decks[`p${i + 1}`].metadata.name, ...(b.lang ? { lang: b.lang } : {}) })),
        decks
    });
    let eg = null;
    try {
        for (const s of seats) {
            await s.hello();
        }
        const setup = { seed: streams.engine, deck1: decks.p1, deck2: decks.p2 };
        eg = env.newGame({ ...setup, undo: seats.some((s) => s.needsUndo) });
        // simulations run on a copy of the game (protocol.js Shadow) that follows every real move
        const shadow = seats.some((s) => s.wantsSims) ? new Shadow(env, setup) : null;
        seats.forEach((s) => (s.shadow = shadow));
        // cards revealed in the real game (not in a native bot's lookahead) are shown to both seats at their next decision
        let live = false;
        eg.game.on('onCardRevealed', (e) => live && seats.forEach((s) => s.reveal((e.cards ?? []).map((c) => placedRef(eg, c)))));
        await eg.start();
        emit({ t: 'step', n: 0, label: 'Game start', state: snapshot(eg) });
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
            const action = await seats[eg.ids.indexOf(pid)].decide(eg, pid, actions, rng);
            // a native bot hands back the live action, which after its own rollbacks is an equal copy
            const i = actions.findIndex((a) => a === action || actionKey(eg, a) === actionKey(eg, action));
            if (i < 0) {
                throw new Error(`the legal actions changed during a lookahead: ${action.label} is gone`);
            }
            const move = { pid, i, legal: actions.length, key: actionKey(eg, actions[i]) };
            live = true;
            const split = eg.apply(pid, action, rng)?.map((e) => ({ id: eg.cardId(e.id), amount: e.amount }));
            live = false;
            res.steps++;
            shadow?.record({ ...move, split });
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
    // every bot that joined hears the result, except one that broke the game; a failure here changes no result
    for (const s of seats) {
        if (s.seat !== res.by) {
            await s.over(res).catch((e) => console.error(`after game ${seed}: ${e.message}`));
        }
    }
    res.ms = Date.now() - t0;
    res.botStats = bots.map((b) => b.stats ?? null);
    res.timing = { p1: timingSummary(seats[0].times), p2: timingSummary(seats[1].times) };
    emit({ t: 'end', winner: res.winner, round: res.round, steps: res.steps, outcome: res.outcome, error: res.error ?? null, by: res.by ?? null, ...(key ? { key } : {}) });
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
