'use strict';
// node bot/tournament.js [--bots random-a,random-b] [--games 4] [--out replays/demo] [--seed 1] [--key K|none]
// Round-robin; first seat alternates each game. Writes <out>/index.json and <out>/games/<id>.jsonl.
// Games are seeded from a secret key (random unless given) so bots cannot rebuild hidden cards from the seed;
// index.json gets the key when the run ends, which makes every game reproducible. --key none: seed alone.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Env } = require('./env');
const { playGame } = require('./match');
const { snapshot } = require('./recorder');
const { createRandomBot } = require('./players/random');
const { HeuristicBot } = require('./players/heuristic');
const { StdioClient } = require('./stdio');
const examples = { 'js-random': require('./examples/random-bot').create, 'js-search': require('./examples/search-bot').create };

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

// bot programs (spec/protocol.md): name -> {cmd, args, ...}, from $SWU_EXTERNAL_BOTS or bot/external-bots.json
function loadExternalBots() {
    const file = process.env.SWU_EXTERNAL_BOTS ?? path.join(__dirname, 'external-bots.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}
const externalBots = loadExternalBots();

// a program serves game after game (restarted after a game it broke); a second copy only when one game needs two
const running = new Map();
function program(name, taken) {
    const pool = running.get(name) ?? [];
    running.set(name, pool);
    const idle = pool.find((c) => !taken.includes(c));
    if (idle) {
        return idle;
    }
    const c = new StdioClient(name, externalBots[name]);
    pool.push(c);
    return c;
}

// bot registry: every name resolves to a factory so heuristic/search bots can be added here later
function makeBot(name, taken = []) {
    if (externalBots[name]) {
        return program(name, taken);
    }
    if (examples[name]) {
        return examples[name](name);
    }
    if (/^heuristic/.test(name)) {
        const d = /-d(\d)/.exec(name);
        return new HeuristicBot(name, { depth: d ? Number(d[1]) : 1 });
    }
    return createRandomBot(name);
}

function statLine(r) {
    const s = (r.botStats ?? []).filter((x) => x?.windows !== undefined);
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
    const keyArg = arg('key', null);
    const key = keyArg === 'none' ? null : keyArg ?? crypto.randomBytes(16).toString('hex');
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
                const bots = [];
                seats.forEach((n) => bots.push(makeBot(n, bots)));
                const r = await playGame(env, { seed, bots, key, record: true, snapshot, onEvent: (e) => fs.appendFileSync(file, `${JSON.stringify(e)}\n`) });
                const winnerBot = r.winner === 'p1' ? seats[0] : r.winner === 'p2' ? seats[1] : r.winner;
                Object.assign(entry, { winner: winnerBot, winnerSeat: r.winner, rounds: r.round, steps: r.steps, outcome: r.outcome, error: r.error ?? null, by: r.by ?? null, ms: r.ms, timing: r.timing });
                write();
                console.log(`${id}: ${r.outcome} ${winnerBot ?? ''} R${r.round} ${r.steps} steps ${r.ms}ms${r.error ? ' ' + r.error : ''}${statLine(r)}`);
            }
        }
    }
    index.key = key;
    write();
    console.log(`wrote ${index.games.length} games to ${out}`);
    [...running.values()].flat().forEach((c) => c.close());
}
main().catch((e) => {
    console.error(e); process.exit(1);
});
