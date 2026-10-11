'use strict';

/**
 * Export labelled positions from solve-horizon runs, for position-function research.
 *
 *   node bot/omni/export-positions.js <solve dir> <out.jsonl> [--legacy] [--reprove]
 *
 * solve-games.js stores results per action window but not the boards, so this replays each game (deterministic:
 * same seed, same bots, same loop) and snapshots every action window, then checks the replay matches (same window
 * count, same moves played). One JSON line per action window:
 *   { game, seed, bots, i, windows, fromEnd, round, toMove, winner, proven, proofDepth, solveTried,
 *     omniScore, state, deckOrder }
 * - winner: who won the game (a noisy label: the players were imperfect bots).
 * - proven: 'p1' | 'p2' when the prover found a forced win for that side within proofDepth action windows
 *   (an exact label under the search's move model), null when it found none in budget or was not run there.
 * - state: recorder snapshot (both hands visible); deckOrder: both draw decks, top first (omniscient view).
 * - omniScore: bot/omni/evaluate.js for p1 (positive = good for p1).
 *
 * --legacy: the heuristic bots score bases the old way (games solved before the 2026-10-11 base-score fix).
 * --reprove: run the current prover again at every window the solve run tried (same budget and depth) and
 *   label with that result. Use it after a prover fix; the old label is kept as `provenBefore`.
 */

const fs = require('fs');
const path = require('path');
const { Env, seededRng } = require('../env');
const { snapshot } = require('../recorder');
const { evaluate } = require('./evaluate');
const { HeuristicBot } = require('../players/heuristic');
const { makeBot: registryBot } = require('../players');
const { OmniSearch } = require('./search');

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));

function makeBot(name) {
    const profile = flags.has('--legacy') ? { side: { legacyDanger: true } } : null;
    return profile && /^heuristic/.test(name) ? new HeuristicBot(name, { profile }) : registryBot(name);
}

/** Prover result at the current window of `pid`; the engine is left where it was. */
function reprove(eg, pid, config) {
    const m = eg.mark(pid);
    const s = new OmniSearch(eg, { budget: config.budget, followUps: config.followUps });
    const r = s.solve(config.depth);
    eg.restore(pid, m);
    return { result: r.result, depth: r.depth };
}

async function replay(env, g) {
    const rng = seededRng('bot' + g.seed);
    const deck1 = env.randomDeck(rng);
    const deck2 = env.randomDeck(rng);
    const eg = env.newGame({ seed: g.seed, deck1, deck2, undo: true });
    await eg.start();
    const bots = g.bots.map(makeBot);
    const out = [];
    const tried = new Set(flags.has('--reprove') ? g.solves.map((s) => s.i) : []);
    let steps = 0;
    while (!eg.over && steps < 6000) {
        const order = rng() < 0.5 ? eg.ids : [...eg.ids].reverse();
        const pid = order.find((id) => eg.legalActions(id).length);
        if (!pid) {
            break;
        }
        const actions = eg.legalActions(pid);
        let w = null;
        if (eg.isActionWindow(pid)) {
            w = {
                toMove: eg.ids.indexOf(pid) === 0 ? 'p1' : 'p2', round: eg.round, state: snapshot(eg),
                deckOrder: { p1: eg.player(eg.ids[0]).drawDeck.map((c) => c.internalName), p2: eg.player(eg.ids[1]).drawDeck.map((c) => c.internalName) },
                omniScore: Math.round(evaluate(eg, eg.ids[0]) * 100) / 100
            };
            if (tried.has(out.length)) {
                w.reproved = reprove(eg, pid, g.config);
            }
            out.push(w);
        }
        const action = bots[eg.ids.indexOf(pid)].choose({ game: eg, pid, actions, rng });
        if (w) {
            w.played = action.label;
        }
        eg.apply(pid, action, rng);
        steps++;
    }
    return out;
}

async function main() {
    const [dir, outFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    const env = new Env();
    const lines = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!g.winner || !g.windowsList) {
            continue;
        }
        const ws = await replay(env, g);
        const ok = ws.length === g.windowsList.length && ws.every((w, i) => w.played === g.windowsList[i].played);
        if (!ok) {
            console.log(`${f}: replay diverged (${ws.length} vs ${g.windowsList.length} windows), skipped`);
            continue;
        }
        const solves = new Map(g.solves.map((s) => [s.i, s]));
        let proven = 0;
        let changed = 0;
        ws.forEach((w, i) => {
            const s = w.reproved ?? solves.get(i);
            const before = solves.get(i)?.result ?? null;
            proven += s?.result ? 1 : 0;
            changed += w.reproved && w.reproved.result !== before ? 1 : 0;
            lines.push(JSON.stringify({
                game: path.basename(f, '.json'), seed: g.seed, bots: g.bots, i, windows: ws.length, fromEnd: ws.length - i,
                round: w.round, toMove: w.toMove, winner: g.winner, proven: s?.result ?? null, proofDepth: s?.result ? s.depth : null,
                ...(w.reproved ? { provenBefore: before } : {}),
                solveTried: solves.has(i), omniScore: w.omniScore, played: w.played, state: w.state, deckOrder: w.deckOrder
            }));
        });
        console.log(`${f}: ${ws.length} windows, ${proven} proven${flags.has('--reprove') ? `, ${changed} changed by reprove` : ''}`);
    }
    fs.writeFileSync(`${outFile}.tmp`, lines.join('\n') + '\n');
    fs.renameSync(`${outFile}.tmp`, outFile);
    console.log(`wrote ${lines.length} positions to ${outFile}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
