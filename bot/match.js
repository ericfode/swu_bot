'use strict';

const { gameStreams } = require('./rng');
const { snapshot: boardSnapshot, placedRef } = require('./view');
const { seatFor, BotError } = require('./protocol');

const same = (a, b) => a.kind === b.kind && a.label === b.label && a.cardUuid === b.cardUuid && a.arg === b.arg;

/**
 * Play one game between two bots and optionally record every decision (spec/replay-format.md).
 *
 * A bot is a protocol client (spec/protocol.md: any object with decide(), including bot/stdio.js StdioClient for
 * programs in other languages) or a native JS bot with engine access ({ name, choose }, spec/bot-interface.md).
 * The match rng is used in a fixed order (two decks, then per decision: actor order, a native bot's choice, a random
 * split), so a seed plays out identically with and without recording. Protocol clients never draw from it.
 * `key` (a secret string) makes every random stream unpredictable from the seed (rng.js gameStreams); without it a
 * bot that knows the seed could rebuild the hidden cards. `limits` overrides the reply budgets of protocol.js LIMITS.
 *
 * @returns {{seed, steps, outcome, winner, round, ms, error?, by?, events, botStats, timing}}
 */
async function playGame(env, { seed, bots, record = false, maxSteps = 6000, snapshot = boardSnapshot, onEvent = null, key = null, limits = {} }) {
    const streams = gameStreams(seed, key);
    const rng = streams.match;
    const t0 = Date.now();
    const decks = { p1: env.randomDeck(rng), p2: env.randomDeck(rng) };
    const players = bots.map((b, i) => ({ id: `p${i + 1}`, name: `p${i + 1}`, bot: b.name }));
    const seats = bots.map((b, i) => {
        const seat = `p${i + 1}`;
        return seatFor(b, seat, { players, decks, botSeed: streams.botSeed(seat), deals: (deal) => streams.sim(seat, deal), limits });
    });
    const res = { seed, steps: 0, outcome: '?', winner: null, round: 0, ms: 0, events: [] };
    // every recorded event is also handed to onEvent as it happens, so a viewer can follow the game live
    const emit = (e) => {
        if (record) {
            res.events.push(e);
            onEvent?.(e);
        }
    };
    let eg = null;
    try {
        for (const s of seats) {
            await s.hello();
        }
        eg = env.newGame({ seed: streams.engine, deck1: decks.p1, deck2: decks.p2, undo: seats.some((s) => s.needsUndo) });
        // cards revealed in the real game (not in a bot's lookahead) are shown to both seats at their next decision
        let live = false;
        eg.game.on('onCardRevealed', (e) => live && seats.forEach((s) => s.reveal((e.cards ?? []).map((c) => placedRef(eg, c)))));
        await eg.start();
        emit({
            t: 'header', v: 1, seed, engine: env.engineRev ?? null,
            players: bots.map((b, i) => ({ id: `p${i + 1}`, bot: b.name, deck: decks[`p${i + 1}`].metadata.name, ...(b.lang ? { lang: b.lang } : {}) })),
            decks
        });
        emit({ t: 'step', n: 0, label: 'Game start', state: snapshot(eg) });
        while (!eg.over && res.steps < maxSteps) {
            const order = rng() < 0.5 ? eg.ids : [...eg.ids].reverse();
            let acted = false;
            for (const pid of order) {
                const actions = eg.legalActions(pid);
                if (!actions.length) {
                    continue;
                }
                const prompt = eg.promptSignature(pid);
                const title = eg.player(pid).currentPrompt().menuTitle ?? null;
                const seat = eg.seatOf(pid);
                const action = await seats[eg.ids.indexOf(pid)].decide(eg, pid, actions, rng);
                live = true;
                const split = eg.apply(pid, action, rng);
                live = false;
                res.steps++;
                acted = true;
                if (record) {
                    const i = actions.findIndex((a) => a === action || same(a, action));
                    const id = action.cardUuid ?? (action.kind === 'displayCard' ? action.arg : undefined);
                    emit({
                        t: 'step', n: res.steps, pid: seat, prompt, title,
                        action: { kind: action.kind, label: action.label, i, ...(id !== undefined ? { id } : {}), ...(split ? { split } : {}) },
                        legal: actions.length, state: snapshot(eg)
                    });
                }
                break;
            }
            if (!acted) {
                res.outcome = 'STUCK';
                break;
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
        res.by = e instanceof BotError ? e.seat : null;
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
    emit({ t: 'end', winner: res.winner, round: res.round, steps: res.steps, outcome: res.outcome, error: res.error ?? null, by: res.by ?? null });
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
