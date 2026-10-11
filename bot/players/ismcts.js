'use strict';

/**
 * ISMCTS bot for the known-decklist setting (Information Set Monte Carlo Tree Search, single observer:
 * Cowling, Powley & Whitehouse 2012), with a belief-weighted determinization step.
 *
 * At each of my action windows:
 *   repeat N iterations:
 *     1. roll back to the real position and sample one world from my information set (belief.js): my deck order,
 *        and which of the opponent's unseen cards are in their hand / resources / deck, weighted by the belief.
 *     2. walk down ONE shared tree of my decisions this turn (the action, then its targets and follow-up prompts),
 *        picking children with UCB1 among the actions that exist in this world ("availability" counts, as in ISMCTS);
 *        expand one new node per iteration, then follow the rule-based policy.
 *     3. the opponent answers with a fast rule-based policy that plays from its SAMPLED hand, until it is my action
 *        window again (horizon 1) or after one more exchange (horizon 2).
 *     4. score that position with the heuristic evaluation (players/heuristic.js), squash it to 0..1 and back it up.
 *   play the most visited action; later prompts of the same turn (targets etc.) follow the most visited path.
 *
 * Because the opponent's reply is simulated from sampled hands, the value of an action already prices in what the
 * opponent probably holds (a removal spell, a big unit they can afford). The belief parameter `beta` (belief.js)
 * sets how hard the sampler leans on "they passed with 4 resources, so they probably do not hold a 4-drop".
 * beta = 0 is plain determinized ISMCTS over the decklist.
 *
 * `peek: true` skips the sampling and searches the real hidden cards: an unfair control for measuring how much the
 * hidden information is worth (the gap between peek and the fair variants).
 *
 * Fairness: the real hidden cards are never read. The search only sees worlds re-sampled from public information
 * plus the two known decklists, and reseeds the engine RNG in every iteration.
 */

const { seededRng } = require('../env');
const { evaluate, defaultChoose, fingerprint } = require('./heuristic');
const { windowPriority, attackChoice } = require('./rush');
const { BeliefModel, determinize } = require('./belief');

const isPass = (a) => a.kind === 'button' && /^pass$/i.test(a.label);
const akey = (a) => `${a.kind}|${a.label}|${a.cardUuid ?? ''}|${a.arg ?? ''}`;

class Node {
    constructor(key = null, action = null) {
        this.key = key;
        this.action = action; // {kind,label,cardUuid,arg}, enough for refetch
        this.children = new Map();
        this.n = 0;
        this.w = 0;
        this.avail = 0;
        this.noop = false;
    }

    mean() {
        return this.n ? this.w / this.n : 0;
    }
}

/** Opponent policy inside the search: rush-style, plays the most expensive card it can from its (sampled) hand. */
function opponentChoice(eg, pid, acts, seen) {
    const pl = eg.player(pid);
    if (eg.isActionWindow(pid)) {
        const pass = acts.find(isPass);
        const k = fingerprint(eg);
        const n = (seen.get(k) ?? 0) + 1;
        seen.set(k, n);
        if (n > 1 && pass) {
            return pass;
        }
        let best = null;
        let bestP = 0;
        for (const a of acts) {
            const p = windowPriority(a, pl);
            if (p > bestP) {
                best = a;
                bestP = p;
            }
        }
        return best ?? pass ?? acts[0];
    }
    const prompt = pl.currentPrompt();
    if (/attack/i.test(`${prompt.menuTitle ?? ''} ${prompt.promptTitle ?? ''}`)) {
        const a = attackChoice(acts, pl);
        if (a) {
            return a;
        }
    }
    return defaultChoose(eg, pid, acts);
}

class IsmctsBot {
    /**
     * beta: belief sharpness (0 = uniform over the decklist). iterations: per action, clamped to [minIter, maxIter].
     * horizon: exchanges simulated before scoring (1 = my turn + the opponent's reply). c: UCB exploration.
     * scale: evaluation points per logistic unit when squashing scores to 0..1. thoughts: optional callback for the
     * dashboard, called after every search with a summary.
     */
    constructor(name = 'ismcts', { beta = 1, iterPerAction = 8, minIter = 48, maxIter = 240, horizon = 1, c = 0.7, scale = 8, maxTreeDecisions = 3, peek = false, profile = null, thoughts = null } = {}) {
        this.name = name;
        this.needsUndo = true;
        this.beta = beta;
        this.iterPerAction = iterPerAction;
        this.minIter = minIter;
        this.maxIter = maxIter;
        this.horizon = horizon;
        this.c = c;
        this.scale = scale;
        this.maxTreeDecisions = maxTreeDecisions;
        this.peek = peek;
        this.profile = profile;
        this.thoughts = thoughts;
        this.belief = new BeliefModel(beta);
        this.rng = null;
        this.cursor = null;
        this.seen = new Map();
        this.game = null;
        this.stats = { windows: 0, playouts: 0, failedPlayouts: 0, noops: 0, loopPasses: 0, ms: 0 };
    }

    choose({ game: eg, pid, actions, rng }) {
        if (this.game !== eg) {
            // a new game: reset per-game state (gate.js reuses bot objects)
            this.game = eg;
            this.belief = new BeliefModel(this.beta);
            this.seen = new Map();
            this.cursor = null;
            this.rng = seededRng(`i${Math.floor(rng() * 1e9)}`);
        }
        this.belief.observe(eg, pid);
        if (!eg.isActionWindow(pid)) {
            return this.followTree(actions) ?? defaultChoose(eg, pid, actions);
        }
        this.cursor = null;
        const t0 = Date.now();
        const pick = this.search(eg, pid, actions);
        this.stats.windows++;
        this.stats.ms += Date.now() - t0;
        return pick;
    }

    /** Later prompts of the turn I searched: take the most visited child that is legal now. */
    followTree(actions) {
        if (!this.cursor) {
            return null;
        }
        const byKey = new Map(actions.map((a) => [akey(a), a]));
        let best = null;
        for (const ch of this.cursor.children.values()) {
            if (!ch.noop && byKey.has(ch.key) && ch.n > 0 && (best === null || ch.n > best.n)) {
                best = ch;
            }
        }
        this.cursor = best;
        return best ? byKey.get(best.key) : null;
    }

    search(eg, pid, actions) {
        const pass = actions.find(isPass);
        const rootFp = fingerprint(eg);
        const seen = (this.seen.get(rootFp) ?? 0) + 1;
        this.seen.set(rootFp, seen);
        if (seen > 2 && pass) {
            this.stats.loopPasses++;
            return pass;
        }
        if (actions.length === 1) {
            return actions[0];
        }
        const root = new Node();
        const markId = eg.mark(pid);
        const rootScore = evaluate(eg, pid, this.profile);
        const iters = Math.max(this.minIter, Math.min(this.maxIter, this.iterPerAction * actions.length));
        for (let i = 0; i < iters; i++) {
            this.iterate(eg, pid, markId, root, rootFp, rootScore);
        }
        let best = null;
        for (const ch of root.children.values()) {
            if (!ch.noop && ch.n > 0 && (best === null || ch.n > best.n || (ch.n === best.n && ch.mean() > best.mean()))) {
                best = ch;
            }
        }
        const live = best ? eg.refetch(pid, best.action) : null;
        this.report(eg, pid, root, best, iters);
        if (!live) {
            return pass ?? eg.legalActions(pid)[0];
        }
        this.cursor = best;
        return live;
    }

    /** UCB1 over the children available in this world; unvisited available actions are tried first (random order). */
    select(node, acts) {
        const fresh = [];
        let best = null;
        let bestU = -Infinity;
        for (const a of acts) {
            const k = akey(a);
            let ch = node.children.get(k);
            if (!ch) {
                ch = new Node(k, { kind: a.kind, label: a.label, cardUuid: a.cardUuid, arg: a.arg });
                node.children.set(k, ch);
            }
            if (ch.noop) {
                continue;
            }
            ch.avail++;
            if (ch.n === 0) {
                fresh.push([ch, a]);
                continue;
            }
            const u = ch.mean() + this.c * Math.sqrt(Math.log(Math.max(1, ch.avail)) / ch.n);
            if (u > bestU) {
                bestU = u;
                best = [ch, a];
            }
        }
        if (fresh.length) {
            return fresh[Math.floor(this.rng() * fresh.length)];
        }
        return best;
    }

    iterate(eg, pid, markId, root, rootFp, rootScore) {
        this.stats.playouts++;
        const opp = eg.ids.find((id) => id !== pid);
        const path = [root];
        let node = root;
        let inTree = true;
        let decisions = 0;
        let exchanges = 0;
        let oppActed = false;
        let myTurnDone = false;
        const oppSeen = new Map();
        let value = null;
        try {
            eg.game.setRandomSeed(String(Math.floor(this.rng() * 1e9)));
            if (!this.peek) {
                determinize(eg, pid, this.belief, this.rng);
            }
            for (let step = 0; step < 120 && !eg.over; step++) {
                const actor = [pid, opp].find((id) => eg.legalActions(id).length);
                if (!actor) {
                    break;
                }
                const acts = eg.legalActions(actor);
                if (actor === pid) {
                    if (step > 0 && eg.isActionWindow(pid)) {
                        if (!myTurnDone) {
                            myTurnDone = true;
                            // my turn changed nothing and it is my window again: this path is not a move
                            if (!oppActed && fingerprint(eg) === rootFp) {
                                path[path.length - 1].noop = path.length > 1;
                                this.stats.noops++;
                                return;
                            }
                        }
                        exchanges++;
                        if (exchanges >= this.horizon) {
                            break;
                        }
                    }
                    let choice;
                    if (inTree && !myTurnDone && decisions < this.maxTreeDecisions) {
                        const sel = this.select(node, acts);
                        if (!sel) {
                            choice = defaultChoose(eg, pid, acts);
                            inTree = false;
                        } else {
                            const [ch, a] = sel;
                            if (ch.n === 0) {
                                inTree = false; // expanded one node: from here on, the rollout policy
                            }
                            node = ch;
                            path.push(ch);
                            decisions++;
                            choice = a;
                        }
                    } else {
                        choice = defaultChoose(eg, pid, acts);
                    }
                    eg.apply(pid, choice, this.rng);
                } else {
                    if (!myTurnDone) {
                        myTurnDone = true;
                    }
                    oppActed = true;
                    eg.apply(opp, opponentChoice(eg, opp, acts, oppSeen), this.rng);
                }
            }
            value = this.leafValue(eg, pid, rootScore);
        } catch {
            this.stats.failedPlayouts++;
            value = null;
        } finally {
            eg.restore(pid, markId);
        }
        if (value === null) {
            // an engine error inside the playout: count the visit as a loss so the bot steers away from it
            value = 0;
        }
        for (const nd of path) {
            nd.n++;
            nd.w += value;
        }
    }

    leafValue(eg, pid, rootScore) {
        if (eg.over) {
            const me = eg.names[eg.ids.indexOf(pid)];
            const w = eg.winners;
            return w.length === 1 ? (w[0] === me ? 1 : 0) : 0.5;
        }
        const s = evaluate(eg, pid, this.profile) - rootScore;
        return 1 / (1 + Math.exp(-s / this.scale));
    }

    /** Summary of the last search for the dashboard ("inner thoughts"). */
    report(eg, pid, root, best, iters) {
        const kids = [...root.children.values()].filter((ch) => ch.n > 0 && !ch.noop).sort((a, b) => b.n - a.n);
        this.last = {
            round: eg.round,
            iterations: iters,
            chosen: best ? best.action.label : 'pass',
            value: best ? best.mean() : null,
            top: kids.slice(0, 8).map((ch) => ({ label: ch.action.label, visits: ch.n, value: ch.mean() })),
            beliefObservations: this.belief.observations
        };
        if (this.thoughts) {
            const opp = eg.player(pid).opponent;
            // a separate stream, so turning the dashboard on does not change how the bot plays
            this.last.oppHand = this.belief.handMarginals(opp, seededRng(`m${eg.round}|${this.stats.windows}`), 120).slice(0, 10);
            this.last.oppHandSize = opp.hand.length;
            this.thoughts(this);
        }
    }
}

module.exports = { IsmctsBot, opponentChoice };
