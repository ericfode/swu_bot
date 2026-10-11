'use strict';
// node bot/td-measure.js <firstSeed> <count> <outFile.jsonl>
//
// Plays heuristic-vs-heuristic games and, at every action window, records the position's features and the
// features of every child the acting bot looked at (its one-ply playouts). This is the data needed to measure
// an evaluator's TD residual h(s) - backup_h(s), where backup = max over children at player 1's windows and
// min at player 2's (theory/SwuTheory/Value.lean). Features are from player 1's side, so any linear evaluator
// (the heuristic, its sign-fixed version, or a fitted one) can be scored offline.
//
// Recording reads only getters and uses no randomness, so each seed plays out exactly as a plain
// heuristic-vs-heuristic game on the same code (the omni thread's solve-hh labels line up by step).
const fs = require('fs');
const { Env } = require('./env');
const { playGame } = require('./match');
const { HeuristicBot, evaluate, fingerprint } = require('./players/heuristic');

const UNIT_KEYS = ['units', 'power', 'hp', 'cost', 'shields', 'upgrades', 'sentinels', 'exhausted', 'unitValue'];

/** Raw counts for one side. unitValue reproduces the heuristic's W-weighted unit sum exactly. */
function sideFeatures(p) {
    const hp = Math.max(0, p.base.getHp() - p.base.damage);
    const f = { baseHp: hp, danger: hp <= 12 ? (12 - hp) ** 2 : 0, hand: p.hand.length, resources: p.resources.length, initiative: p.hasInitiative() ? 1 : 0 };
    for (const k of UNIT_KEYS) {
        f[k] = 0;
    }
    for (const u of p.getArenaUnits()) {
        const power = u.getPower();
        const left = Math.max(0, u.remainingHp);
        let shields = 0;
        let ups = 0;
        for (const up of u.upgrades ?? []) {
            if (up.internalName === 'shield') {
                shields++;
            } else {
                ups++;
            }
        }
        const sentinel = u.hasSomeKeyword?.('sentinel') ? 1 : 0;
        let v = power * 1.3 + left * 0.9 + (u.cost ?? 0) * 0.25 + shields * 2.2 + ups * 0.6 + sentinel;
        if (u.exhausted) {
            v *= 0.85;
        }
        f.units++;
        f.power += power;
        f.hp += left;
        f.cost += u.cost ?? 0;
        f.shields += shields;
        f.upgrades += ups;
        f.sentinels += sentinel;
        f.exhausted += u.exhausted ? 1 : 0;
        f.unitValue += v;
    }
    return f;
}

/** Position features from player 1's side: {over, win (1/0/0.5 when over), p1: {...}, p2: {...}, round}. */
function features(eg) {
    if (eg.over) {
        const w = eg.winners;
        const p1name = eg.names[0];
        return { over: 1, win: w.length === 1 ? (w[0] === p1name ? 1 : 0) : 0.5 };
    }
    return { over: 0, round: eg.round, p1: sideFeatures(eg.player(eg.ids[0])), p2: sideFeatures(eg.player(eg.ids[1])) };
}

class RecordingBot extends HeuristicBot {
    constructor(name, log) {
        super(name);
        this.log = log;
        this.children = null;
    }

    choose(ctx) {
        const { game: eg, pid } = ctx;
        this.log.step++;
        if (!eg.isActionWindow(pid)) {
            return super.choose(ctx);
        }
        this.children = [];
        this.baseFp = fingerprint(eg);
        const before = features(eg);
        before.check = evaluate(eg, eg.ids[0]);
        const pick = super.choose(ctx);
        this.log.windows.push({
            step: this.log.step, round: eg.round, actor: pid === eg.ids[0] ? 'p1' : 'p2',
            s: before, kids: this.children
        });
        this.children = null;
        return pick;
    }

    playout(eg, pid, markId, seq, extra = 0) {
        // capture the child position just before the base class rolls back
        if (!this.children) {
            return super.playout(eg, pid, markId, seq, extra);
        }
        const orig = eg.restore;
        let child = null;
        eg.restore = function (...args) {
            if (!child) {
                child = features(eg);
            }
            return orig.apply(this, args);
        };
        let r;
        try {
            r = super.playout(eg, pid, markId, seq, extra);
        } finally {
            eg.restore = orig;
        }
        // keep only real moves: the playout succeeded and changed the game (the bot skips the rest too)
        if (child && r.score > -Infinity && r.fp !== this.baseFp) {
            this.children.push(child);
        }
        return r;
    }
}

async function main() {
    const first = Number(process.argv[2] ?? 1001);
    const count = Number(process.argv[3] ?? 1);
    const out = process.argv[4] ?? 'td.jsonl';
    const env = new Env();
    for (let seed = first; seed < first + count; seed++) {
        const log = { step: 0, windows: [] };
        const t0 = Date.now();
        const r = await playGame(env, { seed, bots: [new RecordingBot('heuristic', log), new RecordingBot('heuristic', log)] });
        fs.appendFileSync(out, `${JSON.stringify({ seed, outcome: r.outcome, winner: r.winner, steps: r.steps, rounds: r.round, ms: Date.now() - t0, windows: log.windows })}\n`);
        console.log(`seed ${seed}: ${r.outcome} ${r.winner} ${r.steps} steps, ${log.windows.length} windows, ${Date.now() - t0} ms`);
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}

module.exports = { features, sideFeatures };
