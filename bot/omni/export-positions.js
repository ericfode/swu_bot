'use strict';

/**
 * Export labelled positions from solve-horizon runs, for position-function research.
 *
 *   node bot/omni/export-positions.js <solve dir> <out.jsonl>
 *
 * solve-games.js stores results per action window but not the boards, so this replays each game (deterministic:
 * same seed, same bots, same loop) and snapshots every action window, then checks the replay matches (same window
 * count, same moves played). One JSON line per action window:
 *   { game, seed, bots, i, windows, fromEnd, round, toMove, winner, proven, proofDepth, solveTried,
 *     omniScore, state, deckOrder }
 * - winner: who won the game (a noisy label: the players were heuristic bots, not perfect).
 * - proven: 'p1' | 'p2' when the prover found a forced win for that side within proofDepth action windows
 *   (an exact label under the search's move model), null when it found none in budget or was not run there.
 * - state: recorder snapshot (both hands visible); deckOrder: both draw decks, top first (omniscient view).
 * - omniScore: bot/omni/evaluate.js for p1 (positive = good for p1).
 */

const fs = require('fs');
const path = require('path');
const { Env, seededRng } = require('../env');
const { snapshot } = require('../recorder');
const { evaluate } = require('./evaluate');
const { createRandomBot } = require('../players/random');
const { HeuristicBot } = require('../players/heuristic');

function makeBot(name) {
    return /^heuristic/.test(name) ? new HeuristicBot(name) : createRandomBot(name);
}

async function replay(env, g) {
    const rng = seededRng('bot' + g.seed);
    const deck1 = env.randomDeck(rng);
    const deck2 = env.randomDeck(rng);
    const eg = env.newGame({ seed: g.seed, deck1, deck2, undo: true });
    await eg.start();
    const bots = g.bots.map(makeBot);
    const out = [];
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
    const [dir, outFile] = process.argv.slice(2);
    const env = new Env();
    const lines = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!g.winner || !g.windowsList) {
            continue;
        }
        if (g.bots.some((b) => !/^(heuristic|random)/.test(b))) {
            console.log(`${f}: skipped (bots ${g.bots}) - replay only supports heuristic/random`);
            continue;
        }
        const ws = await replay(env, g);
        const ok = ws.length === g.windowsList.length && ws.every((w, i) => w.played === g.windowsList[i].played);
        if (!ok) {
            console.log(`${f}: replay diverged (${ws.length} vs ${g.windowsList.length} windows), skipped`);
            continue;
        }
        const solves = new Map(g.solves.map((s) => [s.i, s]));
        ws.forEach((w, i) => {
            const s = solves.get(i);
            lines.push(JSON.stringify({
                game: path.basename(f, '.json'), seed: g.seed, bots: g.bots, i, windows: ws.length, fromEnd: ws.length - i,
                round: w.round, toMove: w.toMove, winner: g.winner, proven: s?.result ?? null, proofDepth: s?.result ? s.depth : null,
                solveTried: !!s, omniScore: w.omniScore, played: w.played, state: w.state, deckOrder: w.deckOrder
            }));
        });
        console.log(`${f}: ${ws.length} windows, ${g.solves.filter((s) => s.result).length} proven`);
    }
    fs.writeFileSync(`${outFile}.tmp`, lines.join('\n') + '\n');
    fs.renameSync(`${outFile}.tmp`, outFile);
    console.log(`wrote ${lines.length} positions to ${outFile}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
