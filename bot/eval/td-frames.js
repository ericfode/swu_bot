'use strict';
// node bot/eval/td-frames.js <firstSeed> <count> <out.jsonl> [--key K]
//
// TD training data in the position-eval bench's feature space (features.js). Plays heuristic-bot games and, at every
// action window, records the acting player's subjective frame and the frame of every child its one-ply search
// looked at, seen by that same player (exactly what an h@<evaluator> bot scores). With this, a linear evaluator can
// be fitted to its own one-step backup (theory/SwuTheory/Value.lean), anchored by game results and proven endgames
// (theory/measure/anchored_fit.py).
//
// Each frame is stored as the 30 side-feature differences me - opp (SIDE_KEYS order), then toAct and round; a child
// that ends the game is stored as {t: 1|0} (1 = the actor won). Seats play heuristic profiles chosen by the seed
// (mostly the sign-fixed default), so the data covers more than mirror matches. Recording reads getters only and
// uses no randomness, so each seed plays exactly like the same game without recording.
const fs = require('fs');
const { Env } = require('../env');
const { playGame } = require('../match');
const { HeuristicBot, fingerprint } = require('../players/heuristic');
const { PROFILES } = require('../players/profiles');
const { snapshot } = require('../recorder');
const { frameFeatures, terminal, SIDE_KEYS } = require('./features');
const { cardDb } = require('./cards');

const MIX = ['balanced', 'balanced', 'balanced', 'aggro', 'tempo', 'control'];

function frameRow(eg, pid, db) {
    const state = snapshot(eg);
    const judge = `p${eg.ids.indexOf(pid) + 1}`;
    const t = terminal(state, judge);
    if (t !== null) {
        return { t };
    }
    const actor = eg.ids.findIndex((id) => eg.isActionWindow(id));
    const toAct = actor < 0 ? null : `p${actor + 1}`;
    const fr = frameFeatures(state, judge, { view: 'subjective', toAct, db });
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return { x: [...SIDE_KEYS.map((k) => r3(fr.me[k] - fr.opp[k])), fr.g.toAct, fr.g.round] };
}

class FrameBot extends HeuristicBot {
    constructor(name, log, profile, db) {
        super(name, { profile: PROFILES[profile] });
        this.profileName = profile;
        this.log = log;
        this.db = db;
        this.kids = null;
    }

    choose(ctx) {
        const { game: eg, pid } = ctx;
        if (!eg.isActionWindow(pid)) {
            return super.choose(ctx);
        }
        this.kids = [];
        this.baseFp = fingerprint(eg);
        const s = frameRow(eg, pid, this.db);
        const pick = super.choose(ctx);
        this.log.windows.push({ a: `p${eg.ids.indexOf(pid) + 1}`, s: s.x, kids: this.kids });
        this.kids = null;
        return pick;
    }

    playout(eg, pid, markId, seq, extra = 0) {
        if (!this.kids) {
            return super.playout(eg, pid, markId, seq, extra);
        }
        const orig = eg.restore;
        const db = this.db;
        let child = null;
        eg.restore = function (...args) {
            if (!child) {
                child = frameRow(eg, pid, db);
            }
            return orig.apply(this, args);
        };
        let r;
        try {
            r = super.playout(eg, pid, markId, seq, extra);
        } finally {
            eg.restore = orig;
        }
        // keep only real moves, as the bot does: the playout worked and changed the game
        if (child && r.score > -Infinity && r.fp !== this.baseFp) {
            this.kids.push(child.t !== undefined ? { t: child.t } : child.x);
        }
        return r;
    }
}

async function main() {
    const [first, count, out] = [Number(process.argv[2] ?? 5001), Number(process.argv[3] ?? 1), process.argv[4] ?? 'frames.jsonl'];
    const ki = process.argv.indexOf('--key');
    const key = ki > 0 ? process.argv[ki + 1] : null;
    const env = new Env();
    const db = cardDb();
    for (let seed = first; seed < first + count; seed++) {
        const profiles = [MIX[seed % MIX.length], MIX[Math.floor(seed / MIX.length) % MIX.length]];
        const log = { windows: [] };
        const t0 = Date.now();
        const r = await playGame(env, { seed, key, bots: profiles.map((p) => new FrameBot(p, log, p, db)) });
        const winner = r.winner;
        fs.appendFileSync(out, `${JSON.stringify({ seed, profiles, winner, outcome: r.outcome, steps: r.steps, rounds: r.round, ms: Date.now() - t0, windows: log.windows })}\n`);
        console.log(`seed ${seed} ${profiles.join(' v ')}: ${r.outcome} ${winner} ${r.steps} steps, ${log.windows.length} windows, ${Date.now() - t0} ms`);
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}

module.exports = { frameRow };
