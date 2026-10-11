'use strict';
// node bot/jepa/branches.js --games 400 --seed 700000 --workers 4 --out data/branch/rush-random [--bots rush,random] [--p 0.35]
//
// Training data for the JEPA predictor with MANY moves per position. Recorded games show one move per position, so
// the predictor never sees two moves from the same place and learns roughly the average future (the oracle test in
// README.md). Here native bots play a game, and at a sampled action window (the only place the engine rolls back
// exactly) every legal move is played on the same game, then both seats play on with fresh copies of their bots until
// the mover's next decision and its 4th next decision (with more than one legal action, as collect.js records them),
// and the game is rolled back. The main line then goes on with the bot's own move.
//
// Output: <out>/shard-<first>.jsonl.gz, one gzip member per game:
//   {"t":"game","seed","bots":[p1,p2]}
//   {"t":"b","seed","you","prompt","state","actions","main":i,"br":[{"i","h1":decide|null,"h4":decide|null,"over":winner|null,"err"?}]}
//   {"t":"end","seed","winner","outcome","round","steps"}
// A `decide` body is what a stdio bot would get ({you, prompt, state, actions}), so bot/jepa/features.py encodes it.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { fork } = require('child_process');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const { view, promptView, actionView } = require('../view');

function decideBody(eg, pid, actions) {
    return { you: eg.seatOf(pid), prompt: promptView(eg, pid), state: view(eg, eg.seatOf(pid)), actions: actions.map((a, i) => actionView(eg, a, i, pid)) };
}

/** The seat to act and its legal actions, or null when nobody can act. */
function toAct(eg) {
    for (const pid of eg.ids) {
        const actions = eg.legalActions(pid);
        if (actions.length) {
            return { pid, actions };
        }
    }
    return null;
}

/**
 * After the root move: play on with fresh bots until `pid`'s next and 4th next decision with a choice.
 * Returns {h1, h4, over}; a game that ends first leaves the later targets null and sets `over` to the winner.
 */
function playOn(eg, pid, makeBots, rng, maxSteps) {
    const bots = makeBots();
    const out = { h1: null, h4: null, over: null };
    let mine = 0;
    for (let s = 0; s < maxSteps; s++) {
        if (eg.over) {
            out.over = eg.winner;
            return out;
        }
        const who = toAct(eg);
        if (!who) {
            throw new Error('nobody can act');
        }
        if (who.pid === pid && who.actions.length > 1) {
            mine++;
            if (mine === 1) {
                out.h1 = decideBody(eg, pid, who.actions);
            } else if (mine === 4) {
                out.h4 = decideBody(eg, pid, who.actions);
                return out;
            }
        }
        const bot = bots[eg.ids.indexOf(who.pid)];
        const a = who.actions.length === 1 ? who.actions[0] : bot.choose({ game: eg, pid: who.pid, actions: who.actions, rng });
        eg.apply(who.pid, a, rng);
    }
    return out;
}

async function worker(first, count, file, botNames, p, maxBranch) {
    const { Env, seededRng } = require('../env');
    const { makeBot } = require('../players');
    const env = new Env();
    fs.writeFileSync(file, '');
    let lines = [];
    const write = (o) => lines.push(JSON.stringify(o));
    for (let seed = first; seed < first + count; seed++) {
        const rng = seededRng(`branch:${seed}`);
        const names = seed % 2 === 0 ? botNames : [...botNames].reverse();
        const decks = { p1: env.randomDeck(rng), p2: env.randomDeck(rng) };
        const eg = env.newGame({ seed: String(seed), deck1: decks.p1, deck2: decks.p2, undo: true });
        const bots = names.map((n) => makeBot(n, []));
        const makeBots = () => names.map((n) => makeBot(n, []));
        write({ t: 'game', seed, bots: names });
        let steps = 0;
        let outcome = 'won';
        let points = 0;
        try {
            await eg.start();
            while (!eg.over && steps < 6000) {
                const who = toAct(eg);
                if (!who) {
                    outcome = 'STUCK';
                    break;
                }
                const { pid, actions } = who;
                const bot = bots[eg.ids.indexOf(pid)];
                let a = actions.length === 1 ? actions[0] : bot.choose({ game: eg, pid, actions, rng });
                if (actions.length > 1 && eg.isActionWindow(pid) && rng() < p) {
                    const root = decideBody(eg, pid, actions);
                    const main = actions.indexOf(a);
                    const mark = eg.mark(pid);
                    // up to maxBranch moves, always including the main-line move
                    let idx = actions.map((_, i) => i);
                    if (idx.length > maxBranch) {
                        idx = idx.filter((i) => i !== main).sort(() => rng() - 0.5).slice(0, maxBranch - 1).concat([main]).sort((x, y) => x - y);
                    }
                    const br = [];
                    for (const i of idx) {
                        const rec = { i };
                        try {
                            eg.game.setRandomSeed(`${seed}:${steps}:${i}`);
                            const live = eg.refetch(pid, actions[i]);
                            if (!live) {
                                throw new Error('move vanished after rollback');
                            }
                            eg.apply(pid, live, rng);
                            Object.assign(rec, playOn(eg, pid, makeBots, rng, 400));
                        } catch (e) {
                            rec.err = String(e?.message ?? e).split('\n')[0].slice(0, 120);
                        }
                        eg.restore(pid, mark);
                        br.push(rec);
                    }
                    write({ t: 'b', seed, ...root, main, br });
                    points++;
                    a = eg.refetch(pid, actions[main]);
                    if (!a) {
                        throw new Error('main-line move vanished after rollback');
                    }
                }
                eg.apply(pid, a, rng);
                steps++;
            }
            if (!eg.over && outcome === 'won') {
                outcome = 'STEP_CAP';
            }
        } catch (e) {
            outcome = 'ERROR';
            write({ t: 'error', seed, error: String(e?.message ?? e).split('\n')[0].slice(0, 200) });
        }
        write({ t: 'end', seed, winner: outcome === 'won' ? eg.winner : null, outcome, round: eg.round, steps, points });
        fs.appendFileSync(file, zlib.gzipSync(`${lines.join('\n')}\n`));
        lines = [];
        process.send?.({ done: 1, points, outcome });
    }
}

async function main() {
    const games = Number(arg('games', 100));
    const seed = Number(arg('seed', 700000));
    const workers = Number(arg('workers', 1));
    const out = path.resolve(arg('out', 'data/branch/rush-random'));
    const botNames = arg('bots', 'rush,random').split(',');
    const p = Number(arg('p', 0.35));
    const maxBranch = Number(arg('max-branch', 12));
    fs.mkdirSync(out, { recursive: true });
    if (process.argv.includes('--worker')) {
        await worker(Number(arg('first')), Number(arg('count')), arg('file'), botNames, p, maxBranch);
        process.exit(0);
    }
    const per = Math.ceil(games / workers);
    const t0 = Date.now();
    let done = 0;
    let points = 0;
    const outcomes = {};
    const procs = [];
    for (let k = 0; k < workers; k++) {
        const first = seed + k * per;
        const count = Math.min(per, seed + games - first);
        if (count <= 0) {
            break;
        }
        const file = path.join(out, `shard-${first}.jsonl.gz`);
        const args = ['--worker', '--first', String(first), '--count', String(count), '--file', file, '--bots', botNames.join(','), '--p', String(p), '--max-branch', String(maxBranch)];
        const proc = fork(__filename, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        proc.on('message', (m) => {
            done += m.done;
            points += m.points;
            outcomes[m.outcome] = (outcomes[m.outcome] ?? 0) + 1;
            const s = (Date.now() - t0) / 1000;
            console.log(`${done}/${games} games, ${points} branch points, ${(s / done).toFixed(1)} s/game, ${JSON.stringify(outcomes)}`);
        });
        procs.push(new Promise((res, rej) => proc.on('exit', (code) => (code === 0 ? res() : rej(new Error(`worker for seeds ${first}.. exited with code ${code}`))))));
    }
    await Promise.all(procs);
    console.log(`wrote ${out} in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${points} branch points ${JSON.stringify(outcomes)}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
