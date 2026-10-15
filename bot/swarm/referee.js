'use strict';
/**
 * The swarm's referee (bot/swarm/README.md): plays one game of a seed inside the swarm runtime (runtime.js) in a
 * browser worker, as bot/ladder-worker.js plays one for a helper or the games machine: both bots built and guarded
 * with the lease's cap (players/guard.js), the game played by match.js, the replay recorded line by line, and the result
 * shaped as ladder-worker posts it (winner as a bot name, winnerSeat, faultKind, think). It runs no worker threads
 * and no async hooks: bot programs run in their own workers (processes.js), and the page's watchdog stops a game that
 * runs past the lease's gameMs.
 *
 *   const ref = createReferee({ maxSteps, capMs });
 *   const { result, replay } = await ref.play({ id, seed, p1, p2, key, decks });   // replay: the JSON Lines text
 * decks: the two deck lists ({p1, p2}, play-seed.js gameDecks), or null for random decks.
 */
const { Env } = require('../env');
const { playGame, timingSummary } = require('../match');
const { snapshot } = require('../recorder');
const { makeBot, closeBots, describeBot } = require('../players');
const { guard } = require('../players/guard');

const firstLine = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);
const r3 = (x) => Math.round(x * 1000) / 1000;
const CLOSE_MS = 3000;
const forfeit = (job, i, kind) => ({ outcome: 'ERROR', by: `p${i + 1}`, faultKind: kind, winner: [job.p1, job.p2][1 - i], winnerSeat: `p${2 - i}` });

function createReferee({ maxSteps, capMs = Infinity, onStep = null }) {
    const env = new Env();
    env.engineRev = null;
    const cap = capMs ?? Infinity;
    // as ladder-worker.js: with a cap, the guard's per-game budget decides a slow program; protocol.js's limits back it up
    const limits = Number.isFinite(cap) ? { hello: cap + 5000, decide: cap + 5000, over: 10000 } : {};
    const perfNow = () => performance.now();

    function load(name, i, taken) {
        try {
            const w0 = perfNow();
            const raw = makeBot(name, taken);
            const loadMs = () => Math.max(0, perfNow() - w0);
            if (!raw || (typeof raw.choose !== 'function' && typeof raw.decide !== 'function')) {
                throw new Error('createBot() did not return a bot with a choose() or decide() method');
            }
            return { bot: guard(raw, { capMs: cap, loadMs, loadWallMs: loadMs }), raw };
        } catch (e) {
            return { error: firstLine(e) };
        }
    }

    async function play(job) {
        const t0 = Date.now();
        const names = [job.p1, job.p2];
        const loaded = [];
        for (const [i, n] of names.entries()) {
            loaded.push(load(n, i, loaded.map((x) => x.raw).filter(Boolean)));
        }
        const lines = [];
        let r;
        if (loaded.some((x) => x.error)) {
            const bad = [0, 1].filter((i) => loaded[i].error);
            r = {
                seed: job.seed, steps: 0, outcome: 'ERROR', winner: null, winnerSeat: null, round: 0, ms: Date.now() - t0,
                error: bad.map((i) => `LOAD ${names[i]}: ${loaded[i].error}`).join('; ').slice(0, 300), by: null, faultKind: null,
                botStats: loaded.map((x) => x.bot?.stats ?? null), timing: { p1: timingSummary([]), p2: timingSummary([]) }, think: { p1: 0, p2: 0 }
            };
            if (bad.length === 1) {
                Object.assign(r, forfeit(job, bad[0], 'load'));
            }
            return { result: r, replay: null };
        }
        const bots = loaded.map((x) => x.bot);
        const onEvent = (e) => {
            if (e.t !== 'end') {
                lines.push(JSON.stringify(e));
                if (e.t === 'step') {
                    onStep?.(e);
                }
            }
        };
        r = await playGame(env, { seed: job.seed, bots, decks: job.decks ?? null, pool: null, key: job.key ?? null, limits, maxSteps, record: true, snapshot, onEvent });
        await new Promise((resolve) => setTimeout(resolve, 1));
        delete r.events;
        r.winnerSeat = r.winner;
        r.winner = r.winner === 'p1' ? job.p1 : r.winner === 'p2' ? job.p2 : r.winner;
        r.by ??= null;
        const culprit = r.by === 'p1' ? 0 : r.by === 'p2' ? 1 : -1;
        r.faultKind = culprit < 0 ? null : bots[culprit].fault?.kind ?? 'error';
        r.think = { p1: r3(bots[0].thinkMs), p2: r3(bots[1].thinkMs) };
        lines.push(JSON.stringify({ t: 'end', winner: r.winnerSeat, round: r.round, steps: r.steps, outcome: r.outcome, error: r.error ?? null, by: r.by, faultKind: r.faultKind }));
        const closing = Promise.all(loaded.map((x, i) => (x.bot && describeBot(names[i])?.kind !== 'external' ? x.bot.close() : null)));
        await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, CLOSE_MS))]);
        return { result: r, replay: `${lines.join('\n')}\n` };
    }

    return { play, close: () => closeBots(), env };
}

module.exports = { createReferee };
