'use strict';

/**
 * Knowledge dial: a position's score as a distribution, at several levels of knowledge about hidden cards.
 *
 * At a checkpoint (an action window of the side to move, "me") the game is snapshotted. For each knowledge level we
 * sample N hidden worlds that fit what that level knows, play each one out to the end with fixed policy bots, and
 * record the result. The spread of results at a level is "what the score can be, given this much knowledge".
 *
 *   L0 all-seeing   nothing resampled, real engine RNG: one world, the real future (for these policies)
 *   L1 fresh luck   every card and deck order known; future shuffles and random picks resampled (engine RNG reseeded)
 *   L2 both hands   both hands known; both deck orders shuffled
 *   L3 my view      my hand known; opponent's hand redealt from (their hand + their deck); both decks shuffled
 *   L4 public       both hands redealt from (hand + deck); both decks shuffled
 *
 * Face-down resources are never resampled (their identity rarely matters; Smuggle is the exception).
 * The averages are consistent across levels by construction (each level averages over the level above), so the
 * gap between two levels is the value of the knowledge one has and the other lacks, for these policies.
 *
 *   node bot/info/dial.js <seed> [--bots rush,rush] [--n 48] [--at 0.25,0.5,0.75,0.9] [--out file.json]
 */

const path = require('path');
const fs = require('fs');
const { Env, seededRng } = require('../env');
const { makeBot } = require('../players');

const LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'];

function parseArgs(argv) {
    const o = { seed: Number(argv[0] ?? 1), bots: ['rush', 'rush'], n: 48, at: [0.25, 0.5, 0.75, 0.9], out: null, maxSteps: 4000 };
    for (let i = 1; i < argv.length; i++) {
        const k = argv[i], v = argv[i + 1];
        if (k === '--bots') { o.bots = v.split(','); i++; }
        else if (k === '--n') { o.n = Number(v); i++; }
        else if (k === '--at') { o.at = v.split(',').map(Number); i++; }
        else if (k === '--out') { o.out = v; i++; }
    }
    return o;
}

/** One decision of the main loop, same order of rng use as bot/match.js. Returns false when nobody can act. */
function step(eg, bots, rng) {
    const order = rng() < 0.5 ? eg.ids : [...eg.ids].reverse();
    for (const pid of order) {
        const actions = eg.legalActions(pid);
        if (!actions.length) {
            continue;
        }
        const action = bots[eg.ids.indexOf(pid)].choose({ game: eg, pid, actions, rng });
        eg.apply(pid, action, rng);
        return pid;
    }
    return false;
}

const hpLeft = (eg, pid) => {
    const b = eg.player(pid).base;
    return Math.max(0, b.getHp() - b.damage);
};

/** Shuffle a player's deck with our own rng (does not touch the engine RNG). */
function shuffleDeck(pl, rng) {
    pl.deckZone.shuffle({ next: rng });
}

/** Redeal a player's hand: a uniform random hand of the same size from (hand + deck), the rest back in the deck. */
function redealHand(pl, rng) {
    const hand = [...pl.hand];
    const pool = [...hand, ...pl.drawDeck];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const newHand = new Set(pool.slice(0, hand.length));
    const leaving = hand.filter((c) => !newHand.has(c));
    const entering = [...newHand].filter((c) => !hand.includes(c));
    for (const c of leaving) {
        c.moveTo('deckBottom');
    }
    for (const c of entering) {
        c.moveTo('hand');
    }
}

function resample(eg, me, level, rng) {
    const opp = eg.ids.find((id) => id !== me);
    const P = (id) => eg.player(id);
    if (level === 'L0') {
        return;
    }
    if (level === 'L4') {
        redealHand(P(me), rng);
    }
    if (level === 'L3' || level === 'L4') {
        redealHand(P(opp), rng);
    }
    if (level !== 'L1') {
        shuffleDeck(P(me), rng);
        shuffleDeck(P(opp), rng);
    }
    eg.game.setRandomSeed(`dial-${Math.floor(rng() * 1e9)}`);
}

/** Play from the current state to the end. Returns {winner: 'me'|'opp'|'draw'|null, margin, rounds}. */
function playout(eg, me, botNames, rng, maxSteps) {
    const bots = botNames.map((b) => makeBot(b));
    let n = 0;
    while (!eg.over && n < maxSteps) {
        if (!step(eg, bots, rng)) {
            break;
        }
        n++;
    }
    const opp = eg.ids.find((id) => id !== me);
    let winner = null;
    if (eg.over) {
        const w = eg.winners;
        winner = w.length !== 1 ? 'draw' : (w[0] === eg.names[eg.ids.indexOf(me)] ? 'me' : 'opp');
    }
    return { winner, margin: hpLeft(eg, me) - hpLeft(eg, opp), rounds: eg.round, steps: n };
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    const env = new Env();
    env.index();

    const newGame = () => {
        const rng = seededRng('bot' + o.seed);
        const deck1 = env.randomDeck(rng);
        const deck2 = env.randomDeck(rng);
        const eg = env.newGame({ seed: o.seed, deck1, deck2, undo: true });
        return { eg, rng, decks: [deck1.metadata.name, deck2.metadata.name] };
    };

    // pass 1: the real game, to count action windows and get the real result
    const g1 = newGame();
    await g1.eg.start();
    const bots1 = o.bots.map((b) => makeBot(b));
    const windows = [];
    let steps = 0;
    while (!g1.eg.over && steps < o.maxSteps) {
        const who = g1.eg.ids.find((id) => g1.eg.legalActions(id).length && g1.eg.isActionWindow(id));
        if (who) {
            windows.push({ step: steps, pid: who, round: g1.eg.round });
        }
        if (!step(g1.eg, bots1, g1.rng)) {
            break;
        }
        steps++;
    }
    const realWinner = g1.eg.over ? g1.eg.winners : null;
    const targets = new Set(o.at.map((f) => windows[Math.min(windows.length - 1, Math.floor(f * windows.length))].step));

    // pass 2: replay, sampling at the checkpoints
    const g = newGame();
    await g.eg.start();
    const bots = o.bots.map((b) => makeBot(b));
    const out = { seed: o.seed, bots: o.bots, decks: g.decks, n: o.n, windows: windows.length, realWinner, realRounds: g1.eg.round, checkpoints: [] };
    steps = 0;
    while (!g.eg.over && steps < o.maxSteps) {
        if (targets.has(steps)) {
            const me = g.eg.ids.find((id) => g.eg.legalActions(id).length && g.eg.isActionWindow(id));
            const opp = g.eg.ids.find((id) => id !== me);
            const meName = g.eg.names[g.eg.ids.indexOf(me)];
            const cp = {
                step: steps, round: g.eg.round, me: meName, frac: windows.findIndex((w) => w.step === steps) / windows.length,
                board: { myBase: hpLeft(g.eg, me), oppBase: hpLeft(g.eg, opp), myHand: g.eg.player(me).hand.length, oppHand: g.eg.player(opp).hand.length,
                    myDeck: g.eg.player(me).drawDeck.length, oppDeck: g.eg.player(opp).drawDeck.length,
                    myUnits: g.eg.player(me).getArenaUnits().length, oppUnits: g.eg.player(opp).getArenaUnits().length },
                meWonReal: realWinner && realWinner.length === 1 ? realWinner[0] === meName : null,
                levels: {}
            };
            const mark = g.eg.mark(me);
            const t0 = Date.now();
            for (const L of LEVELS) {
                const res = [];
                const reps = L === 'L0' ? 1 : o.n;
                for (let i = 0; i < reps; i++) {
                    g.eg.restore(me, mark);
                    const r = seededRng(`dial-${o.seed}-${steps}-${L}-${i}`);
                    try {
                        resample(g.eg, me, L, r);
                        res.push(playout(g.eg, me, o.bots, r, o.maxSteps));
                    } catch (e) {
                        res.push({ winner: null, error: String(e && e.message || e).slice(0, 120) });
                    }
                }
                cp.levels[L] = res;
            }
            g.eg.restore(me, mark);
            cp.ms = Date.now() - t0;
            out.checkpoints.push(cp);
            const summ = LEVELS.map((L) => {
                const ok = cp.levels[L].filter((x) => x.winner === 'me' || x.winner === 'opp');
                return `${L} ${ok.length ? (ok.filter((x) => x.winner === 'me').length / ok.length).toFixed(2) : '-'}`;
            }).join(' | ');
            console.error(`seed ${o.seed} step ${steps} r${cp.round} ${meName}: ${summ}  (${cp.ms} ms, real ${cp.meWonReal ? 'win' : 'loss'})`);
        }
        if (!step(g.eg, bots, g.rng)) {
            break;
        }
        steps++;
    }
    out.replayMatches = g.eg.over && JSON.stringify(g.eg.winners) === JSON.stringify(realWinner);
    const json = JSON.stringify(out);
    if (o.out) {
        fs.writeFileSync(o.out, json);
    } else {
        process.stdout.write(json + '\n');
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error('FATAL', e);
        process.exit(1);
    });
}

module.exports = { resample, redealHand, shuffleDeck, playout, LEVELS };
