'use strict';

/**
 * Omniscient search over the real forceteki engine.
 *
 * "Omniscient" means the search sees everything: both hands, both deck orders and the engine RNG. It does not
 * reseed the RNG, so every draw, shuffle and random pick in a line it searches is the one the real game will make.
 * Given the opponent's choices, the game is then a deterministic two-player game of perfect information.
 *
 * Search nodes are action windows (the only place the engine can roll back exactly). A move ("macro") is what the
 * acting player does from one action window to the next one of anybody:
 *   - the first action (play a card, attack with a unit, use an ability, pass, take the initiative),
 *   - every option of the first follow-up prompt (usually the attack target or the card's target),
 *   - deeper follow-ups and every prompt of the other player in between (triggers, regroup resourcing, mulligans of
 *     a new round, ...) are answered by the heuristic bot's rule-based `defaultChoose`.
 * So the tree is exact about the order and targets of actions and approximate about deep sub-choices.
 *
 * Two searches are provided:
 *   - `alphaBeta`: depth-limited minimax with `bot/omni/evaluate.js` at the leaves (the playing bot).
 *   - `prove`: AND/OR proof search to the end of the game. Answers "can player X force a win within N windows,
 *     whatever the other player does?" with a transposition table. This is the exact solver; it is only feasible
 *     close to the end of a game.
 *
 * Values are from the maximizing side's point of view: seat p1 (engine id '111') unless `side` is given.
 */

const crypto = require('crypto');
const { seededRng } = require('../env');
const { defaultChoose } = require('../players/heuristic');
const { evaluate } = require('./evaluate');
const { snapshot } = require('../recorder');

const WIN = 10000;

class BudgetExceeded extends Error {
    constructor() {
        super('search budget exceeded');
    }
}

class Cutoff extends Error {}

const strip = ({ kind, label, cardUuid, arg }) => ({ kind, label, cardUuid, arg });
const same = (a, b) => a.kind === b.kind && a.label === b.label && a.cardUuid === b.cardUuid && a.arg === b.arg;
const isPass = (a) => a.kind === 'button' && /^pass$/i.test(a.label);

/**
 * Deterministic split for a distribute prompt, returned as a "forced" copy of the action (see spec: a copy whose
 * targets/caps/maxTargets allow exactly one result), so the real game and the search make the same split.
 * Damage goes to enemy units that it can defeat (most valuable first), then the enemy base, then anything;
 * healing and tokens go to own units/base first.
 */
function forcedSplit(eg, pid, a) {
    const { spec, targets, caps } = a;
    const me = eg.player(pid);
    const harm = spec.type === 'distributeDamage' || spec.type === 'distributeIndirectDamage';
    const cards = targets.map((uuid, i) => ({ uuid, cap: caps[i], card: eg.game.findAnyCardInAnyList?.(uuid) ?? findCard(eg, uuid) }));
    const score = ({ card }) => {
        if (!card) {
            return 0;
        }
        const mine = card.controller === me;
        const unit = card.isUnit?.() ? card.getPower() + card.remainingHp : 0;
        if (harm) {
            return mine ? -100 - unit : card.isBase?.() ? 5 : 10 + unit;
        }
        return mine ? 10 + unit : -100;
    };
    const order = cards.slice().sort((x, y) => score(y) - score(x));
    const max = Math.min(spec.maxTargets ?? order.length, order.length);
    let left = spec.amount;
    const out = [];
    for (const t of order) {
        if (left <= 0 || out.length >= max) {
            break;
        }
        // damage: put exactly enough on a unit to defeat it, the rest on the next target
        const need = harm && t.card?.isUnit?.() ? Math.max(1, t.card.remainingHp) : left;
        const give = Math.min(left, need, t.cap);
        if (give > 0) {
            out.push({ uuid: t.uuid, amount: give });
            left -= give;
        }
    }
    // could not place everything on the preferred targets: top up any target with room left
    for (let i = 0; left > 0 && i < out.length; i++) {
        const cap = cards.find((c) => c.uuid === out[i].uuid).cap;
        const add = Math.min(left, cap - out[i].amount);
        out[i].amount += add;
        left -= add;
    }
    if (!out.length || (left > 0 && !spec.canDistributeLess)) {
        return a;
    }
    return { ...a, targets: out.map((o) => o.uuid), caps: out.map((o) => o.amount), spec: { ...spec, maxTargets: out.length } };
}

function findCard(eg, uuid) {
    for (const id of eg.ids) {
        const p = eg.player(id);
        for (const c of [...p.getArenaUnits(), p.base, ...p.getAllDeckLeaders()]) {
            if (c?.uuid === uuid) {
                return c;
            }
        }
    }
    return null;
}

/** The rule-based choice used for every prompt the tree does not branch on, with deterministic distribute splits. */
function ruleChoice(eg, pid, acts) {
    const c = defaultChoose(eg, pid, acts);
    return c.kind === 'distribute' ? forcedSplit(eg, pid, c) : c;
}

/**
 * Everything the rest of the game depends on: public board, both hands, both deck orders, resources, pass state,
 * whose window it is, and the engine RNG. Two positions with the same key play out the same.
 * (Per-card "used this round" flags are not read, so very rarely two different positions share a key.)
 * withRng = false leaves the RNG and the deck orders out (each deck counts as a sorted list of cards): for blind
 * searches, which reseed the RNG and shuffle both decks before every move, so neither carries information there.
 */
function stateKey(eg, withRng = true) {
    const parts = [JSON.stringify(snapshot(eg))];
    for (const id of eg.ids) {
        const p = eg.player(id);
        const deck = p.drawDeck.map((c) => c.internalName);
        // blind: the order is hidden but which cards are left still matters
        parts.push((withRng ? deck : deck.sort()).join(','));
        parts.push(p.resources.map((c) => `${c.internalName}${c.exhausted ? '*' : ''}`).join(','));
        parts.push(p.passedActionPhase ? 'P' : '-', eg.isActionWindow(id) ? 'W' : '-');
    }
    parts.push(eg.game.prevActionPhasePlayerPassed ? 'pp' : '--');
    const rs = withRng ? eg.game.randomGenerator.rngState : null;
    parts.push(rs ? `${rs.i},${rs.j},${rs.S?.join?.('.') ?? ''}` : '');
    return crypto.createHash('sha1').update(parts.join('#')).digest('base64');
}

class OmniSearch {
    /**
     * @param eg EnvGame created with undo: true.
     * @param opts.followUps how many options of the first follow-up prompt become separate moves. A number, or
     *   (pid, ply) => number so the search can branch wide for one side and narrow for the other.
     * @param opts.maxMoves cap on first actions per window (buttons always kept).
     * @param opts.budget node budget (one node = one move applied on the engine); `BudgetExceeded` is thrown past it.
     * @param opts.deadline wall-clock deadline (ms since epoch), same effect.
     */
    constructor(eg, { followUps = 8, maxMoves = 40, budget = Infinity, deadline = Infinity, reseed = null, side = null, snapshots = false } = {}) {
        this.eg = eg;
        // keep a recorder snapshot of every child position (for drawing the search tree)
        this.snapshots = snapshots;
        // the maximizing side; values are from its point of view (p1 unless `side` says otherwise)
        this.p1 = side ?? eg.ids[0];
        // optional () => string: reseed the engine RNG and shuffle both decks before every move, so the search
        // cannot see the real deck order (future draws) or the real random results
        this.reseed = reseed;
        this.followUps = followUps;
        this.maxMoves = maxMoves;
        this.budget = budget;
        this.deadline = deadline;
        this.nodes = 0;
        this.failed = 0;
        this.tt = new Map();
        this.maxDepthSeen = 0;
    }

    key() {
        return stateKey(this.eg, !this.reseed);
    }

    windowActor() {
        return this.eg.ids.find((id) => this.eg.isActionWindow(id)) ?? null;
    }

    tick() {
        this.nodes++;
        if (this.nodes > this.budget || (this.deadline !== Infinity && Date.now() > this.deadline)) {
            throw new BudgetExceeded();
        }
    }

    /** P1-relative static value of the current position, with game results scored by distance (faster wins first). */
    value(ply = 0) {
        const eg = this.eg;
        if (eg.over) {
            const w = eg.winners;
            if (w.length !== 1) {
                return 0;
            }
            return w[0] === eg.names[eg.ids.indexOf(this.p1)] ? WIN - ply : -WIN + ply;
        }
        return evaluate(eg, this.p1);
    }

    /**
     * Apply a move from the current action window of `pid` and run the game to the next action window (or the end).
     * Returns the options of the first follow-up prompt when the move was a single action, for branching.
     */
    playMove(pid, seq) {
        const eg = this.eg;
        const rng = seededRng('omni-move');
        if (this.reseed) {
            eg.game.setRandomSeed(this.reseed());
            for (const id of eg.ids) {
                eg.player(id).shuffleDeck();
            }
        }
        const first = eg.refetch(pid, seq[0]);
        if (!first) {
            throw new Error('move vanished');
        }
        eg.apply(pid, first.kind === 'distribute' ? forcedSplit(eg, pid, first) : first, rng);
        const forced = seq.slice(1);
        const opp = eg.ids.find((id) => id !== pid);
        let branch = null;
        for (let i = 0; i < 400 && !eg.over; i++) {
            const actor = [pid, opp].find((id) => eg.legalActions(id).length);
            if (!actor || eg.isActionWindow(actor)) {
                return { branch, stuck: !actor };
            }
            const acts = eg.legalActions(actor);
            let choice;
            if (actor === pid && forced.length) {
                choice = acts.find((a) => same(a, forced[0]));
                forced.shift();
                if (!choice) {
                    throw new Error('forced option vanished');
                }
                if (choice.kind === 'distribute') {
                    choice = forcedSplit(eg, pid, choice);
                }
            } else {
                // branch on the first follow-up only inside the action phase (targets of the action), not on the
                // regroup prompts a pass leads to: those are left to the rule-based choice
                if (i === 0 && actor === pid && seq.length === 1 && acts.length > 1 && eg.phase === 'action') {
                    branch = acts.map(strip);
                }
                choice = ruleChoice(eg, actor, acts);
            }
            eg.apply(actor, choice, rng);
        }
        if (!eg.over) {
            throw new Error('move did not reach an action window');
        }
        return { branch, stuck: false };
    }

    /**
     * First actions in a useful order: units and leaders on the board (attacks, abilities) first, then cards from
     * hand, then buttons (pass, take the initiative). Capped at `cap` (default `maxMoves`), buttons always kept.
     */
    orderedActions(pid, cap = this.maxMoves) {
        const rank = (a) => {
            if (a.kind === 'button') {
                return 3;
            }
            const zone = a.card?.zoneName ?? '';
            return /arena/i.test(zone) ? 0 : /base|leader/i.test(zone) ? 1 : 2;
        };
        const acts = this.eg.legalActions(pid).map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a);
        if (acts.length <= cap) {
            return acts;
        }
        const buttons = acts.filter((a) => a.kind === 'button');
        return [...acts.filter((a) => a.kind !== 'button').slice(0, cap - buttons.length), ...buttons];
    }

    /**
     * Visit every distinct move at the current window of `pid` (taken from mark `m`). `visit(kid)` is called with
     * the engine sitting in the position after the move, so it can search deeper from there without replaying it;
     * returning true stops the enumeration. kid = {seq, key, value, over, stuck, winners}. No-ops (same position)
     * and transpositions (two moves, same position) are skipped. The engine is left at `m`.
     * `all`: ignore the maxMoves and followUps caps (the prover needs every reply of the defending side).
     * Returns the number of moves that threw in the engine and were skipped.
     */
    forEachMove(pid, m, ply, visit, all = false) {
        const followUps = all ? Infinity : typeof this.followUps === 'function' ? this.followUps(pid, ply) : this.followUps;
        const eg = this.eg;
        const seen = new Set([this.key()]);
        const bases = new Set(eg.ids.map((id) => eg.player(id).base.internalName));
        let dirty = false;
        let failed = 0;
        const tryMove = (seq) => {
            if (dirty) {
                eg.restore(pid, m);
            }
            dirty = true;
            this.tick();
            let r;
            try {
                r = this.playMove(pid, seq);
            } catch (e) {
                if (e instanceof BudgetExceeded) {
                    throw e;
                }
                this.failed++;
                failed++;
                return null;
            }
            const key = this.key();
            if (!seen.has(key)) {
                seen.add(key);
                const kid = { seq: seq.map(strip), key, value: this.value(ply + 1), over: eg.over, stuck: r.stuck, winners: eg.winners };
                if (this.snapshots) {
                    kid.state = snapshot(eg);
                }
                if (visit(kid)) {
                    throw new Cutoff();
                }
            }
            return r;
        };
        try {
            for (const a of this.orderedActions(pid, all ? Infinity : this.maxMoves)) {
                const r = tryMove([a]);
                if (r?.branch) {
                    // bases first among targets: that is where lethal damage goes
                    const opts = r.branch.slice().sort((x, y) => (bases.has(y.label) ? 1 : 0) - (bases.has(x.label) ? 1 : 0));
                    for (const o of opts.slice(0, followUps)) {
                        tryMove([a, o]);
                    }
                }
            }
        } catch (e) {
            if (!(e instanceof Cutoff)) {
                throw e;
            }
        } finally {
            if (dirty) {
                eg.restore(pid, m);
            }
        }
        return failed;
    }

    /** All distinct moves (see forEachMove), each tried once; `stop(kid)` may end the list early. */
    children(pid, m, ply, stop = null) {
        const kids = [];
        this.forEachMove(pid, m, ply, (kid) => {
            kids.push(kid);
            return stop?.(kid) ?? false;
        });
        return kids;
    }

    /** Go from the window at mark `m` (of `pid`) down one move. */
    descend(pid, m, kid, restoreFirst) {
        if (restoreFirst) {
            this.eg.restore(pid, m);
        }
        this.tick();
        this.playMove(pid, kid.seq);
    }

    /**
     * Depth-limited alpha-beta (depth in windows). Returns {value, pv} where pv is the list of moves.
     * `beam` limits how many moves get a deeper look at inner nodes (the rest keep their one-ply value).
     */
    alphaBeta(depth, alpha = -Infinity, beta = Infinity, ply = 0, beam = Infinity) {
        const eg = this.eg;
        this.maxDepthSeen = Math.max(this.maxDepthSeen, ply);
        if (eg.over || depth === 0) {
            return { value: this.value(ply), pv: [] };
        }
        const pid = this.windowActor();
        if (!pid) {
            return { value: this.value(ply), pv: [] };
        }
        const maxing = pid === this.p1;
        const m = eg.mark(pid);
        // at the last level a single reply past the window is enough to cut (alpha-beta without the extra applies)
        const stop = depth === 1 && ply > 0 ? (k) => (maxing ? k.value >= beta : k.value <= alpha) : null;
        const kids = this.children(pid, m, ply, stop);
        if (!kids.length) {
            return { value: this.value(ply), pv: [] };
        }
        kids.sort((x, y) => (maxing ? y.value - x.value : x.value - y.value));
        if (depth === 1) {
            return { value: kids[0].value, pv: [kids[0].seq], kids };
        }
        let best = null;
        let moved = false;
        try {
            for (let i = 0; i < kids.length; i++) {
                const kid = kids[i];
                let r;
                if (kid.over || kid.stuck || i >= beam) {
                    r = { value: kid.value, pv: [] };
                } else {
                    this.descend(pid, m, kid, moved);
                    moved = true;
                    r = this.alphaBeta(depth - 1, alpha, beta, ply + 1, beam);
                }
                kid.searched = r.value;
                kid.sub = r.kids;
                if (best === null || (maxing ? r.value > best.value : r.value < best.value)) {
                    best = { value: r.value, pv: [kid.seq, ...r.pv] };
                }
                if (maxing) {
                    alpha = Math.max(alpha, r.value);
                } else {
                    beta = Math.min(beta, r.value);
                }
                if (alpha >= beta) {
                    break;
                }
            }
        } finally {
            if (moved) {
                eg.restore(pid, m);
            }
        }
        return { ...best, kids };
    }

    /**
     * Can `target` (engine player id) force a win within `depth` windows, whatever the other player does?
     * Exact for the move model above: the defending side's replies are never capped. Throws BudgetExceeded when out of budget.
     * Moves are searched as they are generated (no second apply), with a transposition table.
     */
    prove(target, depth, ply = 0) {
        const eg = this.eg;
        this.maxDepthSeen = Math.max(this.maxDepthSeen, ply);
        const targetName = eg.names[eg.ids.indexOf(target)];
        if (eg.over) {
            return eg.winners.length === 1 && eg.winners[0] === targetName;
        }
        if (depth === 0) {
            return false;
        }
        const pid = this.windowActor();
        if (!pid) {
            return false;
        }
        const key = `${target}:${this.key()}`;
        const hit = this.tt.get(key);
        if (hit?.proved !== undefined && hit.proved <= depth) {
            return true;
        }
        if (hit?.disproved !== undefined && hit.disproved >= depth) {
            return false;
        }
        const orNode = pid === target;
        const wins = (k) => k.over && k.winners.length === 1 && k.winners[0] === targetName;
        const m = eg.mark(pid);
        let any = false;
        let found = false;
        // AND node: every reply of the defender must be checked, so no move caps there. At an OR node the caps only
        // make the search incomplete (a missed win), never wrong.
        const failed = this.forEachMove(pid, m, ply, (kid) => {
            any = true;
            let good;
            if (kid.over) {
                good = wins(kid);
            } else if (kid.stuck || depth === 1) {
                good = false;
            } else {
                good = this.prove(target, depth - 1, ply + 1);
            }
            // OR node: one good move is enough. AND node: one bad reply refutes.
            found = orNode ? good : !good;
            return found;
        }, !orNode);
        // a defender move that threw in the engine was not checked, so it cannot count as refuted
        const result = orNode ? found : any && !found && failed === 0;
        this.tt.set(key, result ? { ...hit, proved: depth } : { ...hit, disproved: Math.max(depth, hit?.disproved ?? 0) });
        return result;
    }

    /**
     * Iterative-deepening proof for both players. Returns {result: 'p1'|'p2'|null, depth, nodes, ms, complete}.
     * `complete` is false when the budget ran out before the max depth was reached.
     */
    solve(maxDepth = 12) {
        const t0 = Date.now();
        const [p1, p2] = this.eg.ids;
        let depthDone = 0;
        try {
            for (let d = 1; d <= maxDepth; d++) {
                // the player to move first: its forced wins are found by the cheaper OR search
                const order = this.windowActor() === p2 ? [[p2, 'p2'], [p1, 'p1']] : [[p1, 'p1'], [p2, 'p2']];
                for (const [who, tag] of order) {
                    if (this.prove(who, d)) {
                        return { result: tag, depth: d, nodes: this.nodes, ms: Date.now() - t0, complete: true };
                    }
                }
                depthDone = d;
            }
            return { result: null, depth: depthDone, nodes: this.nodes, ms: Date.now() - t0, complete: true };
        } catch (e) {
            if (!(e instanceof BudgetExceeded)) {
                throw e;
            }
            return { result: null, depth: depthDone, nodes: this.nodes, ms: Date.now() - t0, complete: false };
        }
    }
}

module.exports = { OmniSearch, BudgetExceeded, stateKey, forcedSplit, ruleChoice, WIN, isPass, same };
