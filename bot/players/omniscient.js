'use strict';

/**
 * Omniscient bot: a reference opponent that cheats on purpose.
 *
 * It searches with full information (both hands, both deck orders, the real engine RNG, so it knows every future
 * draw and shuffle in the lines it reads) using the alpha-beta search in `bot/omni/search.js`. It is not a fair
 * bot; it exists to measure how much information and lookahead are worth, as an upper reference for fair bots and
 * position functions.
 *
 * At each of its action windows it:
 *   1. tries every move once (depth 1); a move that wins the game on the spot is played at once,
 *   2. runs alpha-beta to `depth` windows (its move, the opponent's best reply, ...) within a node/time budget,
 *      keeping the deepest fully searched answer.
 * Prompts outside the action window follow the plan of the chosen move, then the rule-based choice the search
 * assumes, so the real game follows the line that was searched.
 *
 * Options: depth (default 2), budget (nodes per window, default 600), ms (time per window, default 6000), beam
 * (moves that get a deeper look, default 8), followUps (target options tried for our own move, default 8),
 * blind (true: inside the search, reseed the engine RNG and shuffle both decks before every move, so it cannot see
 * the deck order or random results; it still sees both hands).
 *
 * With OMNI_LOG_DIR set, every action-window decision is appended to <dir>/<seed>-<bot>-<seat>.jsonl (value, depth,
 * principal variation, the top moves and their values). bot/omni/lens.js joins these with the replay: the k-th line
 * is the bot's k-th actionWindow step. Give each tournament run its own OMNI_LOG_DIR: two runs with the same bot
 * name and seeds would append to the same files.
 */

const fs = require('fs');
const path = require('path');
const { seededRng } = require('../env');
const { OmniSearch, BudgetExceeded, ruleChoice, stateKey, same, isPass } = require('../omni/search');
const { snapshot } = require('../recorder');

/** Search value (deciding side's points) as an uncalibrated P(p1 wins): logistic with a 15-point scale. */
function toP1(v, seat) {
    const x = seat === 'p1' ? v : -v;
    if (Math.abs(x) >= 9000) {
        return x > 0 ? 1 : 0;
    }
    return Math.round(1000 / (1 + Math.exp(-x / 15))) / 1000;
}

class OmniscientBot {
    constructor(name = 'omni', { depth = 2, budget = 600, ms = 6000, blind = false, beam = 8, followUps = 8 } = {}) {
        this.name = name;
        this.needsUndo = true;
        this.depth = depth;
        this.budget = budget;
        this.ms = ms;
        this.blind = blind;
        this.beam = beam;
        this.followUps = followUps;
        this.plan = [];
        this.seen = new Map();
        this.rng = null;
        this.last = null;
        this.stats = { windows: 0, playouts: 0, failedPlayouts: 0, noops: 0, loopPasses: 0, ms: 0, depthReached: {}, forcedWins: 0 };
    }

    choose({ game: eg, pid, actions, rng }) {
        this.rng ??= seededRng(`omni${Math.floor(rng() * 1e9)}`);
        if (!eg.isActionWindow(pid)) {
            if (this.plan.length) {
                const live = actions.find((a) => same(a, this.plan[0]));
                this.plan.shift();
                if (live) {
                    return live.kind === 'distribute' ? ruleChoice(eg, pid, [live]) : live;
                }
                this.plan = [];
            }
            return ruleChoice(eg, pid, actions);
        }
        const t0 = Date.now();
        const pick = this.decide(eg, pid, actions);
        this.stats.windows++;
        this.stats.ms += Date.now() - t0;
        return pick;
    }

    decide(eg, pid, actions) {
        this.plan = [];
        const pass = actions.find(isPass);
        const key = stateKey(eg, !this.blind);
        const seen = (this.seen.get(key) ?? 0) + 1;
        this.seen.set(key, seen);
        if (seen > 2 && pass) {
            this.stats.loopPasses++;
            return pass;
        }
        const t0 = Date.now();
        const rootMark = eg.mark(pid);
        const reseed = this.blind ? () => String(Math.floor(this.rng() * 1e9)) : null;
        // branch on targets for our own first move only; deeper moves and the opponent's use the rule-based targets
        const followUps = (who, ply) => (who === pid && ply === 0 ? this.followUps : 0);
        const logging = !!process.env.OMNI_LOG_DIR;
        const rootState = logging ? snapshot(eg) : null;
        const search = new OmniSearch(eg, { budget: this.budget, deadline: t0 + this.ms, followUps, reseed, side: pid, snapshots: logging });
        let best = null;
        let reached = 0;
        try {
            for (let d = 1; d <= this.depth; d++) {
                const r = search.alphaBeta(d, -Infinity, Infinity, 0, this.beam);
                if (r.pv?.length) {
                    best = r;
                    reached = d;
                }
                if (Math.abs(r.value) >= 9000) {
                    break;
                }
            }
        } catch (e) {
            if (!(e instanceof BudgetExceeded)) {
                throw e;
            }
        } finally {
            // alpha-beta leaves the engine at the root already; restoring again also puts back the real RNG state
            eg.restore(pid, rootMark);
        }
        this.stats.playouts += search.nodes;
        this.stats.failedPlayouts += search.failed;
        this.stats.depthReached[reached] = (this.stats.depthReached[reached] ?? 0) + 1;
        if (!best) {
            this.last = { round: eg.round, depth: 0, nodes: search.nodes, ms: Date.now() - t0, value: null, pv: [], moves: [] };
            this.log(eg, pid);
            return pass ?? actions[0];
        }
        if (best.value >= 9000) {
            this.stats.forcedWins++;
        }
        const seq = best.pv[0];
        this.last = {
            round: eg.round, depth: reached, nodes: search.nodes, ms: Date.now() - t0, value: best.value,
            pv: best.pv.map((m) => m.map((a) => a.label).join(' > ')),
            moves: (best.kids ?? []).slice(0, 40).map((k) => ({ move: k.seq.map((a) => a.label).join(' > '), value: +(k.searched ?? k.value).toFixed(2) }))
        };
        this.log(eg, pid);
        if (logging) {
            this.writeTree(eg, pid, best, rootState);
        }
        this.plan = seq.slice(1);
        return eg.refetch(pid, seq[0]) ?? pass ?? actions[0];
    }
}

OmniscientBot.prototype.log = function log(eg, pid) {
    const dir = process.env.OMNI_LOG_DIR;
    if (!dir) {
        return;
    }
    const seat = `p${eg.ids.indexOf(pid) + 1}`;
    const seed = String(eg.game.id).replace(/^bot-/, '');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${seed}-${this.name}-${seat}.jsonl`), `${JSON.stringify({ seat, ...this.last })}\n`);
};

/** Latest search tree in the dashboard's `tree` widget shape: root, our best moves, and the replies we expect. */
OmniscientBot.prototype.writeTree = function writeTree(eg, pid, best, rootState) {
    const seat = `p${eg.ids.indexOf(pid) + 1}`;
    const label = (k) => k.seq.map((a) => a.label).join(' > ');
    const val = (k) => k.searched ?? k.value;
    const mine = (best.kids ?? []).slice().sort((a, b) => val(b) - val(a)).slice(0, 8);
    const tree = {
        bot: this.name, seat, round: eg.round, updatedAt: new Date().toISOString(),
        root: {
            label: `Round ${eg.round}: ${this.name} (${seat}) to act, ${this.last.nodes} nodes, depth ${this.last.depth}`,
            state: rootState, value: toP1(best.value, seat),
            children: mine.map((k) => ({
                label: label(k), state: k.state, value: toP1(val(k), seat), chosen: label(k) === label({ seq: best.pv[0] }),
                // the opponent's replies, best for the opponent first (lowest value for us)
                children: (k.sub ?? []).slice().sort((a, b) => val(a) - val(b)).slice(0, 4).map((o) => ({ label: `reply: ${label(o)}`, state: o.state, value: toP1(val(o), seat) }))
            }))
        }
    };
    const file = path.join(process.env.OMNI_LOG_DIR, `latest-tree-${this.name}.json`);
    fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(tree));
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
};

module.exports = { OmniscientBot };
