'use strict';

/**
 * Karabast-style captures of engine games, for testing the importer against a known truth.
 *
 *   node importer/capture.js --bots rush,heuristic --seeds 1-3 --out /tmp/cap
 *
 * Plays each seed with bot/match.js exactly like bot/tournament.js and, after every decision, also asks the engine for
 * the `gamestate` object Karabast's server would push over the socket (Game.getState(viewerId)) to each viewer:
 *   <out>/<game>.p1.jsonl         what player 1's browser receives (own hand visible, opponent hand hidden)
 *   <out>/<game>.p2.jsonl         what player 2's browser receives
 *   <out>/<game>.spectator.jsonl  what a spectator receives
 *   <out>/<game>.truth.jsonl      the normal recorder replay (omniscient snapshots), the ground truth
 *
 * Capture lines: {t:"capture", v:1, view, game, seats:{p1,p2}} then {t:"gamestate", n, view, state} per decision.
 * getState only reads engine state; the run checks that steps and winner match a run without capturing.
 */

const fs = require('fs');
const path = require('path');
const { Env } = require('../bot/env');
const { playGame } = require('../bot/match');
const { snapshot } = require('../bot/recorder');
const { makeBot } = require('../bot/players');

const VIEWS = ['p1', 'p2', 'spectator'];

function parseArgs(argv) {
    const a = { bots: 'rush,heuristic', seeds: '1-3', out: path.join('replays', 'captures'), maxSteps: 6000 };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i].replace(/^--/, '');
        if (['bots', 'seeds', 'out', 'maxSteps'].includes(k)) {
            a[k] = argv[++i];
        }
    }
    const [lo, hi] = String(a.seeds).split('-').map(Number);
    a.seedList = Array.from({ length: (hi ?? lo) - lo + 1 }, (_, k) => lo + k);
    a.botNames = a.bots.split(',');
    a.maxSteps = Number(a.maxSteps);
    return a;
}

async function captureGame(env, { seed, botNames, maxSteps }) {
    const frames = { p1: [], p2: [], spectator: [] };
    let seats = null;
    const viewerId = (eg, view) => (view === 'spectator' ? 'spectator-1' : eg.ids[view === 'p1' ? 0 : 1]);
    let n = 0;
    const snap = (eg) => {
        seats ??= { p1: eg.ids[0], p2: eg.ids[1] };
        for (const view of VIEWS) {
            // Lobby.sendGameState sends exactly this object as the 'gamestate' socket event
            frames[view].push({ t: 'gamestate', n, view, state: JSON.parse(JSON.stringify(eg.game.getState(viewerId(eg, view)))) });
        }
        n++;
        return snapshot(eg);
    };
    const bots = botNames.map((b) => makeBot(b));
    const res = await playGame(env, { seed, bots, record: true, maxSteps, snapshot: snap });
    return { res, frames, seats };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    fs.mkdirSync(args.out, { recursive: true });
    const env = new Env();
    for (const seed of args.seedList) {
        const id = `${args.botNames.join('-vs-')}-${seed}`;
        const { res, frames, seats } = await captureGame(env, { seed, botNames: args.botNames, maxSteps: args.maxSteps });
        // determinism: the same seed without capturing must play out identically
        const plain = await playGame(env, { seed, bots: args.botNames.map((b) => makeBot(b)), maxSteps: args.maxSteps });
        const same = plain.steps === res.steps && plain.winner === res.winner && plain.outcome === res.outcome;
        const game = { id, seed, bots: args.botNames, steps: res.steps, winner: res.winner, outcome: res.outcome };
        for (const view of VIEWS) {
            const lines = [{ t: 'capture', v: 1, view, game, seats }, ...frames[view]];
            fs.writeFileSync(path.join(args.out, `${id}.${view}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
        }
        fs.writeFileSync(path.join(args.out, `${id}.truth.jsonl`), res.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
        console.log(`${id}: ${res.steps} steps, ${res.outcome}, winner ${res.winner}, frames ${frames.p1.length}${same ? '' : '  DETERMINISM MISMATCH'}`);
        if (!same) {
            process.exitCode = 1;
        }
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}

module.exports = { captureGame };
