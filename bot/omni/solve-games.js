'use strict';

/**
 * Solve-horizon experiment: how far from the end of a real game can the omniscient prover find a forced win?
 *
 *   node bot/omni/solve-games.js --bots heuristic,heuristic --seeds 1-8 --budget 600 --depth 8 --out dir
 *
 * For each seed it plays one game between the two bots (undo on), marking every action window. After the game it
 * walks the windows backwards from the end and, at each one, asks the prover (bot/omni/search.js) whether either
 * player can force a win within `--depth` windows, with `--budget` engine nodes. The walk stops after `--stop`
 * windows in a row come back unknown. Rollback only clears newer snapshots, so walking backwards keeps every
 * earlier mark valid.
 *
 * Every `--sample`-th window also gets its full move list built (all first actions and their target options), to
 * measure the branching factor of the move model.
 *
 * Writes <out>/<bots>-<seed>.json per game: windows (step, round, actor, action played, static eval, branching),
 * and solves (result, proof depth, nodes, ms, complete).
 */

const fs = require('fs');
const path = require('path');
const { Env, seededRng } = require('../env');
const { OmniSearch } = require('./search');
const { evaluate } = require('./evaluate');
// any bot of the shared registry (bot/players/index.js) can play the games that get solved
const { makeBot } = require('../players');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : dflt;
}

function seedList(spec) {
    return spec.split(',').flatMap((part) => {
        const [a, b] = part.split('-').map(Number);
        return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
    });
}

async function solveGame(env, seed, names, opts) {
    const rng = seededRng('bot' + seed);
    const deck1 = env.randomDeck(rng);
    const deck2 = env.randomDeck(rng);
    const eg = env.newGame({ seed, deck1, deck2, undo: true });
    await eg.start();
    const bots = names.map(makeBot);
    const windows = [];
    let steps = 0;
    const t0 = Date.now();
    while (!eg.over && steps < 6000) {
        const order = rng() < 0.5 ? eg.ids : [...eg.ids].reverse();
        const pid = order.find((id) => eg.legalActions(id).length);
        if (!pid) {
            break;
        }
        const actions = eg.legalActions(pid);
        let w = null;
        if (eg.isActionWindow(pid)) {
            w = { i: windows.length, step: steps, round: eg.round, actor: eg.ids.indexOf(pid) === 0 ? 'p1' : 'p2', pid, mark: eg.mark(pid), firstActions: actions.length, eval: +evaluate(eg, eg.ids[0]).toFixed(2) };
            if (opts.sample && windows.length % opts.sample === 0) {
                const s = new OmniSearch(eg, { followUps: opts.followUps });
                w.moves = s.children(pid, w.mark, 0).length;
            }
            windows.push(w);
        }
        const action = bots[eg.ids.indexOf(pid)].choose({ game: eg, pid, actions, rng });
        if (w) {
            w.played = action.label;
        }
        eg.apply(pid, action, rng);
        steps++;
    }
    const winner = eg.over ? (eg.winners.length === 1 ? (eg.winners[0] === eg.names[0] ? 'p1' : 'p2') : 'draw') : null;
    const game = { seed, bots: names, decks: [deck1.metadata.name, deck2.metadata.name], winner, rounds: eg.round, steps, windows: windows.length, playMs: Date.now() - t0 };

    // walk backwards from the last window
    const solves = [];
    let unknownRun = 0;
    for (let k = windows.length - 1; k >= 0 && unknownRun < opts.stop && winner; k--) {
        const w = windows[k];
        eg.restore(w.pid, w.mark);
        const s = new OmniSearch(eg, { budget: opts.budget, followUps: opts.followUps });
        const r = s.solve(opts.depth);
        solves.push({ i: w.i, fromEnd: windows.length - k, roundsFromEnd: game.rounds - w.round, round: w.round, actor: w.actor, ...r, tt: s.tt.size });
        unknownRun = r.result ? 0 : unknownRun + 1;
        console.log(`seed ${seed} window ${w.i}/${windows.length} R${w.round} ${w.actor}: ${r.result ?? '?'} d${r.depth} ${r.nodes}n ${r.ms}ms${r.complete ? '' : ' (budget)'}`);
    }
    for (const w of windows) {
        delete w.pid;
        delete w.mark;
    }
    return { ...game, windowsList: windows, solves, config: opts };
}

async function main() {
    const names = arg('bots', 'heuristic,heuristic').split(',');
    const seeds = seedList(arg('seeds', '1-4'));
    const out = path.resolve(arg('out', 'replays/solve'));
    const opts = { budget: Number(arg('budget', 600)), depth: Number(arg('depth', 8)), stop: Number(arg('stop', 3)), sample: Number(arg('sample', 6)), followUps: Number(arg('followUps', 8)) };
    fs.mkdirSync(out, { recursive: true });
    const env = new Env();
    for (const seed of seeds) {
        let res;
        try {
            res = await solveGame(env, seed, names, opts);
        } catch (e) {
            res = { seed, bots: names, error: String(e?.message ?? e).split('\n')[0] };
            console.log(`seed ${seed}: ERROR ${res.error}`);
        }
        const file = path.join(out, `${names.join('-vs-')}-${seed}.json`);
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(res));
        fs.renameSync(`${file}.tmp`, file);
        console.log(`seed ${seed}: winner ${res.winner} rounds ${res.rounds} windows ${res.windows} solved ${res.solves?.filter((s) => s.result).length ?? 0}`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
