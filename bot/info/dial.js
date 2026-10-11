'use strict';

/**
 * Knowledge dial: a position's score as a distribution, at several levels of knowledge about hidden cards.
 *
 * At a checkpoint (an action window of the side to move, "me") the game is snapshotted. For each knowledge level we
 * sample worlds that fit what that level knows, play each one out to the end with fixed policy bots, and record the
 * result. The spread of results at a level is "what the outcome can be, given this much knowledge, for these players".
 *
 *   L0 all-seeing   the real future: how the game itself went on from here (its bots, their memory, its RNG)
 *   L1 engine luck  engine RNG reseeded (mid-game shuffles and random picks). In practice equal to L0: after setup the
 *                   engine RNG is almost never used, and draw luck lives in deck order (L2). Run with a small --l1n.
 *   L2 both hands   both hands known; both deck orders shuffled
 *   L3 my view      my hand known; opponent's hand redealt uniformly from (their hand + their deck); decks shuffled
 *   L4 public       both hands redealt uniformly; decks shuffled
 *
 * Approximations (see /mnt/project-files/research/optimal-play/README.md):
 *   - the L3/L4 redeal is a uniform prior over hands, not the posterior given what the opponent has done (real hands
 *     are filtered by the policy: cheaper, castable), and it knows the opponent's remaining decklist;
 *   - face-down resources, cards revealed by search or hand-peek effects, and known deck-bottom cards are not tracked.
 *   - L1-L4 samples start fresh bots and a fresh harness RNG at the checkpoint, so bot memory from before it (rush's
 *     loop map, a search bot's beliefs) is not carried. Every sampled level shares this, so their gaps compare alike.
 * The playout bots act only on their own cards and public state, so there is no strategy fusion here; bots that read
 * hidden cards (omni, ismcts-...-peek) would see each sampled world, so they are refused. The level means
 * are the expected outcome of these bots under each sampler. A gap between levels says how much the outcome depends
 * on that hidden information (predictive value), not what knowing it is worth to a player who could act on it.
 *
 *   node bot/info/dial.js <seed> [--bots rush,rush] [--n 48] [--at 0.25,0.5,0.75,0.9] [--out file.json]
 */

const path = require('path');
const fs = require('fs');
const { Env, seededRng } = require('../env');
const { makeBot, describeBot } = require('../players');

const LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'];
const SAMPLED = LEVELS.slice(1);

function parseArgs(argv) {
    const o = { seed: Number(argv[0] ?? 1), bots: ['rush', 'rush'], n: 48, l1n: 8, at: [0.25, 0.5, 0.75, 0.9], out: null, maxSteps: 4000 };
    for (let i = 1; i < argv.length; i++) {
        const k = argv[i], v = argv[i + 1];
        if (k === '--bots') { o.bots = v.split(','); i++; }
        else if (k === '--n') { o.n = Number(v); i++; }
        else if (k === '--l1n') { o.l1n = Number(v); i++; }
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

/** Winner names at the end, or null if not over. Both bases at 0 is a draw, whatever the engine reports. */
function finalWinners(eg) {
    if (!eg.over) {
        return null;
    }
    return eg.ids.every((id) => hpLeft(eg, id) === 0) ? [...eg.names] : eg.winners;
}

/** 'me' | 'opp' | 'draw' | null (not over), seen from me. */
function outcome(eg, me) {
    const w = finalWinners(eg);
    return !w ? null : w.length !== 1 ? 'draw' : (w[0] === eg.names[eg.ids.indexOf(me)] ? 'me' : 'opp');
}

const closeBots = (bots) => bots.forEach((b) => b.close?.());

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
    // the action window's offer list was built from the old hand when the snapshot was restored: rebuild it
    eg.game.resolveGameState();
    eg.game.continue();
}

/** Play from the current state to the end. Returns {winner: 'me'|'opp'|'draw'|null, margin, rounds}. */
function playout(eg, me, botNames, rng, maxSteps) {
    const bots = botNames.map((b) => makeBot(b));
    const opp = eg.ids.find((id) => id !== me);
    let n = 0;
    try {
        while (!eg.over && n < maxSteps) {
            if (!step(eg, bots, rng)) {
                break;
            }
            n++;
        }
    } finally {
        closeBots(bots);
    }
    return { winner: outcome(eg, me), margin: hpLeft(eg, me) - hpLeft(eg, opp), rounds: eg.round, steps: n };
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    try {
        await run(o);
    } catch (e) {
        const msg = String((e && e.message) || e).split('\n')[0].slice(0, 300);
        console.error(`seed ${o.seed} FAILED: ${msg}`);
        if (o.out) {
            fs.writeFileSync(o.out, JSON.stringify({ seed: o.seed, error: msg, checkpoints: [] }));
        }
    }
}

async function run(o) {
    for (const b of o.bots) {
        const info = describeBot(b);
        if (info && (info.kind === 'omniscient' || info.profile === 'ismcts-peek')) {
            throw new Error(`--bots ${b}: this bot reads hidden cards, so in a sampled world it would see the sample`);
        }
    }
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
    closeBots(bots1);
    const realWinner = finalWinners(g1.eg);
    if (!windows.length) {
        throw new Error('the real game had no action windows');
    }
    const targets = new Set(o.at.map((f) => windows[Math.min(windows.length - 1, Math.floor(f * windows.length))].step));

    // pass 2: replay, sampling at the checkpoints
    const g = newGame();
    await g.eg.start();
    const bots = o.bots.map((b) => makeBot(b));
    const out = { seed: o.seed, bots: o.bots, decks: g.decks, n: o.n, windows: windows.length, realWinner, realRounds: g1.eg.round, checkpoints: [] };
    steps = 0;
    while (!g.eg.over && steps < o.maxSteps) {
        // me is null if the replay drifted from pass 1; out.replayMatches records that
        const me = targets.has(steps) ? g.eg.ids.find((id) => g.eg.legalActions(id).length && g.eg.isActionWindow(id)) : null;
        if (me) {
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
            // L0 is filled in from the real continuation once the game ends
            for (const L of SAMPLED) {
                const res = [];
                const reps = L === 'L1' ? o.l1n : o.n;
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
            const summ = SAMPLED.map((L) => {
                const ok = cp.levels[L].filter((x) => x.winner === 'me' || x.winner === 'opp');
                const bad = cp.levels[L].length - ok.length;
                return `${L} ${ok.length ? (ok.filter((x) => x.winner === 'me').length / ok.length).toFixed(2) : '-'}${bad ? ` (${bad} err/draw)` : ''}`;
            }).join(' | ');
            cp.pid = me;
            console.error(`seed ${o.seed} step ${steps} r${cp.round} ${meName}: ${summ}  (${cp.ms} ms, real ${cp.meWonReal == null ? 'n/a' : cp.meWonReal ? 'win' : 'loss'})`);
        }
        if (!step(g.eg, bots, g.rng)) {
            break;
        }
        steps++;
    }
    closeBots(bots);
    for (const cp of out.checkpoints) {
        const opp = g.eg.ids.find((id) => id !== cp.pid);
        cp.levels.L0 = [{ winner: outcome(g.eg, cp.pid), margin: hpLeft(g.eg, cp.pid) - hpLeft(g.eg, opp), rounds: g.eg.round, steps: steps - cp.step }];
        delete cp.pid;
    }
    out.replayMatches = g.eg.over && JSON.stringify(finalWinners(g.eg)) === JSON.stringify(realWinner);
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
