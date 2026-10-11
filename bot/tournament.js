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

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

// bot registry: every name resolves to a factory so heuristic/search bots can be added here later
function makeBot(name) {
    return createRandomBot(name);
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
                const r = await playGame(env, { seed, bots: seats.map(makeBot), record: true, snapshot });
                const id = `${seats[0]}-vs-${seats[1]}-${seed}`;
                fs.writeFileSync(path.join(out, 'games', `${id}.jsonl`), r.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
                const winnerBot = r.winner === 'p1' ? seats[0] : r.winner === 'p2' ? seats[1] : r.winner;
                index.games.push({ id, seed, p1: seats[0], p2: seats[1], winner: winnerBot, winnerSeat: r.winner, rounds: r.round, steps: r.steps, outcome: r.outcome, error: r.error ?? null, ms: r.ms });
                write();
                console.log(`${id}: ${r.outcome} ${winnerBot ?? ''} R${r.round} ${r.steps} steps ${r.ms}ms${r.error ? ' ' + r.error : ''}`);
            }
        }
    }
    console.log(`wrote ${index.games.length} games to ${out}`);
}
main().catch((e) => {
    console.error(e); process.exit(1);
});
