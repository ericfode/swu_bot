'use strict';

const { seededRng } = require('./env');

/**
 * Play one game between two bots and optionally record every decision.
 * rng consumption order matches bot/random-run.js (decks, then per decision: actor order, bot choice),
 * so a seed plays out identically with and without recording.
 *
 * @returns {{seed, steps, outcome, winner, round, ms, error?, events}}
 */
async function playGame(env, { seed, bots, record = false, maxSteps = 6000, snapshot = null, onEvent = null }) {
    const rng = seededRng('bot' + seed);
    const t0 = Date.now();
    const deck1 = env.randomDeck(rng);
    const deck2 = env.randomDeck(rng);
    const eg = env.newGame({ seed, deck1, deck2, undo: bots.some((b) => b.needsUndo) });
    const res = { seed, steps: 0, outcome: '?', winner: null, round: 0, ms: 0, events: [] };
    const botFor = { p1: bots[0], p2: bots[1] };
    // every recorded event is also handed to onEvent as it happens, so a viewer can follow the game live
    const emit = (e) => {
        res.events.push(e);
        onEvent?.(e);
    };
    const pidName = (pid) => `p${eg.ids.indexOf(pid) + 1}`;
    try {
        await eg.start();
        if (record) {
            emit({
                t: 'header', v: 1, seed, engine: env.engineRev ?? null,
                players: [bots[0].name, bots[1].name].map((bot, i) => ({
                    id: `p${i + 1}`, bot, deck: [deck1, deck2][i].metadata.name
                }))
            });
            emit({ t: 'step', n: 0, label: 'Game start', state: snapshot(eg) });
        }
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
                const action = botFor[pidName(pid)].choose({ game: eg, pid, actions, rng });
                eg.apply(pid, action, rng);
                res.steps++;
                acted = true;
                if (record) {
                    emit({
                        t: 'step', n: res.steps, pid: pidName(pid), prompt, title,
                        action: { kind: action.kind, label: action.label }, legal: actions.length, state: snapshot(eg)
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
        if (eg.over) {
            const w = eg.winners[0];
            res.winner = eg.winners.length === 1 ? pidName(eg.ids[eg.names.indexOf(w)]) : 'draw';
        }
        res.round = eg.round;
    } catch (e) {
        res.outcome = 'ERROR';
        res.error = String((e && e.message) || e).split('\n')[0].slice(0, 200);
    }
    res.ms = Date.now() - t0;
    res.botStats = bots.map((b) => b.stats ?? null);
    if (record) {
        emit({ t: 'end', winner: res.winner, round: res.round, steps: res.steps, outcome: res.outcome, error: res.error ?? null });
    }
    return res;
}

module.exports = { playGame };
