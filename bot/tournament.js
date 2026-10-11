'use strict';
// node bot/tournament.js [--bots random-a,random-b] [--games 4] [--out replays/demo] [--seed 1]
// Round-robin; first seat alternates each game. Writes <out>/index.json and <out>/games/<id>.jsonl.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Env } = require('./env');
const { playGame } = require('./match');
const { snapshot } = require('./recorder');
const { createRandomBot } = require('./players/random');
const { HeuristicBot } = require('./players/heuristic');
const { LearnedPolicyBot, LearnedSearchBot } = require('./learned/bots');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

// bot registry: every name resolves to a factory so heuristic/search bots can be added here later
function makeBot(name) {
    if (/^heuristic/.test(name)) {
        const d = /-d(\d)/.exec(name);
        return new HeuristicBot(name, { depth: d ? Number(d[1]) : 1 });
    }
    // learned bots (bot/learned): model file from $SWU_LEARNED_MODEL, default models/learned/current.json
    if (/^learned-v/.test(name)) {
        return new LearnedSearchBot(name);
    }
    if (/^learned/.test(name)) {
        return new LearnedPolicyBot(name);
    }
    return createRandomBot(name);
}

function statLine(r) {
    const s = (r.botStats ?? []).filter(Boolean);
    return s.map((x) => ` [${x.windows} windows, ${x.noops ?? 0} noops, ${x.loopPasses ?? 0} loop-passes, ${(x.ms / Math.max(1, x.windows)).toFixed(0)}ms/window, ${x.playouts} playouts, ${x.failedPlayouts} failed]`).join('');
}

function engineRev() {
    try {
        return execFileSync('git', ['-C', path.join(__dirname, '..', 'forceteki'), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}

async function main() {
    const names = arg('bots', 'random-a,random-b').split(',');
    const perPair = Number(arg('games', 4));
    const out = path.resolve(arg('out', 'replays/demo'));
    let seed = Number(arg('seed', 1));
    fs.mkdirSync(path.join(out, 'games'), { recursive: true });

    const env = new Env();
    env.engineRev = engineRev();
    const index = { id: path.basename(out), createdAt: new Date().toISOString(), engine: env.engineRev, bots: names, gamesPerPairing: perPair, games: [] };
    const write = () => fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index));
    write();

    for (let a = 0; a < names.length; a++) {
        for (let b = a + 1; b < names.length; b++) {
            for (let k = 0; k < perPair; k++, seed++) {
                const swap = k % 2 === 1;
                const seats = swap ? [names[b], names[a]] : [names[a], names[b]];
                const id = `${seats[0]}-vs-${seats[1]}-${seed}`;
                const file = path.join(out, 'games', `${id}.jsonl`);
                fs.writeFileSync(file, '');
                // listed as running from the first move, and every event is appended as it happens so the viewer can follow live
                const entry = { id, seed, p1: seats[0], p2: seats[1], winner: null, winnerSeat: null, rounds: 0, steps: 0, outcome: 'running', error: null, ms: 0 };
                index.games.push(entry);
                write();
                const r = await playGame(env, { seed, bots: seats.map(makeBot), record: true, snapshot, onEvent: (e) => fs.appendFileSync(file, `${JSON.stringify(e)}\n`) });
                const winnerBot = r.winner === 'p1' ? seats[0] : r.winner === 'p2' ? seats[1] : r.winner;
                Object.assign(entry, { winner: winnerBot, winnerSeat: r.winner, rounds: r.round, steps: r.steps, outcome: r.outcome, error: r.error ?? null, ms: r.ms });
                write();
                console.log(`${id}: ${r.outcome} ${winnerBot ?? ''} R${r.round} ${r.steps} steps ${r.ms}ms${r.error ? ' ' + r.error : ''}${statLine(r)}`);
            }
        }
    }
    console.log(`wrote ${index.games.length} games to ${out}`);
}
main().catch((e) => {
    console.error(e); process.exit(1);
});
