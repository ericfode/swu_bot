'use strict';
// Bug hunt: node bot/sweep.js --from 1 --count 200 --out replays/bugs-a
// Plays recorded random-vs-random games and keeps only the ones that end in ERROR / STUCK / STEP_CAP,
// as a viewer-readable tournament folder. Also writes sweep-summary.json (outcome + error text per seed).
const fs = require('fs');
const path = require('path');
const { Env } = require('./env');
const { playGame } = require('./match');
const { snapshot } = require('./recorder');
const { createRandomBot } = require('./players/random');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

async function main() {
    const from = Number(arg('from', 1));
    const count = Number(arg('count', 100));
    const out = path.resolve(arg('out', 'replays/bugs'));
    fs.mkdirSync(path.join(out, 'games'), { recursive: true });
    const env = new Env();
    const names = ['random-a', 'random-b'];
    const index = { id: path.basename(out), createdAt: new Date().toISOString(), engine: null, bots: names, gamesPerPairing: count, games: [] };
    const summary = { from, count, outcomes: {}, errors: {}, seeds: {} };
    const save = () => {
        fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index));
        fs.writeFileSync(path.join(out, 'sweep-summary.json'), JSON.stringify(summary, null, 1));
    };
    save();
    for (let seed = from; seed < from + count; seed++) {
        const r = await playGame(env, { seed, bots: names.map((n) => createRandomBot(n)), record: true, snapshot });
        summary.outcomes[r.outcome] = (summary.outcomes[r.outcome] ?? 0) + 1;
        summary.seeds[seed] = r.outcome === 'won' ? 'won' : `${r.outcome}: ${r.error ?? ''}`;
        if (r.outcome !== 'won') {
            const key = r.error ?? r.outcome;
            (summary.errors[key] ??= []).push(seed);
            const id = `${names[0]}-vs-${names[1]}-${seed}`;
            fs.writeFileSync(path.join(out, 'games', `${id}.jsonl`), r.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
            index.games.push({ id, seed, p1: names[0], p2: names[1], winner: null, winnerSeat: null, rounds: r.round, steps: r.steps, outcome: r.outcome, error: r.error ?? null, ms: r.ms });
            console.log(`seed ${seed}: ${r.outcome} after ${r.steps} steps: ${r.error ?? ''}`);
        }
        save();
    }
    console.log('done', JSON.stringify(summary.outcomes), `${Object.keys(summary.errors).length} distinct errors`);
}
main().catch((e) => {
    console.error(e); process.exit(1);
});
