'use strict';

/**
 * Belief over hidden cards for the known-decklist setting, and determinization (sampling one concrete world).
 *
 * Setting: both decklists are known before the game (open decklists, as in many tournaments). What is hidden:
 *   - the opponent's hand, resources and deck order: which of their unseen cards is where;
 *   - my own deck order (my future draws).
 * The unseen pool for the opponent is "their decklist minus every card I have seen in public" (arena, discard,
 * base, leader, captured). Because the decklist is known, that pool is exactly the opponent's hand + resources +
 * deck as a multiset; only the split between those zones (and the deck order) is unknown.
 *
 * Belief model (one tunable parameter, beta = how much to trust it):
 *   Each time the opponent spends an action window without paying for anything (passes, or attacks instead of
 *   playing a card), every card they could have afforded becomes less likely to be in their hand: a player with
 *   that card would usually have played it. For a card name c, `evidence[c]` sums those observations (a pass
 *   counts 1, a free action counts 0.5), and its sampling weight is
 *       w(c) = copiesInPool(c) * exp(-beta * evidence[c]).
 *   beta = 0 is the uniform prior over the decklist (plain determinized search); larger beta trusts the
 *   "they would have played it" read more and samples expensive / unplayable hands. Resources are sampled
 *   uniformly from what is left, the deck gets the rest in random order.
 *
 * Only public information feeds the belief: zone counts, ready resource counts, the opponent's pass flag and
 * cards that are face up. The real engine state is changed by `determinize` but always inside a snapshot that the
 * search rolls back.
 */

const PUBLIC_PASS = 1.0;
const PUBLIC_FREE_ACTION = 0.5;

/** Name of a card for belief purposes (copies of the same card are interchangeable). */
const cardKey = (c) => c.internalName;

/** Cost to play `card` from hand for player `pl`, including the aspect penalty (2 per missing aspect icon). */
function effectiveCost(card, pl) {
    let penalty = 0;
    try {
        penalty = (pl.getPenaltyAspects?.(card.aspects) ?? []).length * 2;
    } catch {
        penalty = 0;
    }
    return (card.cost ?? 0) + penalty;
}

/** The opponent's unseen cards as card objects (hand, resources, deck). Used only to know the pool's multiset. */
function unseenPool(opp) {
    return [...opp.hand, ...opp.resources, ...opp.drawDeck];
}

class BeliefModel {
    constructor(beta = 1) {
        this.beta = beta;
        this.evidence = new Map();
        this.last = null;
        this.observations = 0;
    }

    /**
     * Called at each of my decisions. Compares the opponent's public state with the previous call to see whether
     * the opponent used an action window without paying for anything. Public inputs only.
     */
    observe(eg, pid) {
        const me = eg.player(pid);
        const opp = me.opponent;
        const now = {
            round: eg.round,
            phase: eg.phase,
            oppReady: opp.readyResourceCount,
            oppHand: opp.hand.length,
            oppPassed: !!opp.passedActionPhase,
            window: eg.isActionWindow(pid)
        };
        const prev = this.last;
        this.last = now;
        if (!prev || !now.window || !prev.window || prev.round !== now.round || now.phase !== 'action') {
            return;
        }
        // between two of my action windows in the same round the opponent took at most one action window
        let strength = 0;
        if (now.oppPassed && !prev.oppPassed) {
            strength = PUBLIC_PASS;
        } else if (!now.oppPassed && now.oppReady === prev.oppReady && now.oppHand >= prev.oppHand) {
            strength = PUBLIC_FREE_ACTION;
        }
        if (!strength) {
            return;
        }
        const budget = prev.oppReady;
        // names are read from the pool only to list which card names exist; every copy gets the same evidence
        const names = new Map();
        for (const c of unseenPool(opp)) {
            names.set(cardKey(c), c);
        }
        for (const [name, c] of names) {
            if (effectiveCost(c, opp) <= budget) {
                this.evidence.set(name, (this.evidence.get(name) ?? 0) + strength);
            }
        }
        this.observations++;
    }

    weight(name) {
        return Math.exp(-this.beta * (this.evidence.get(name) ?? 0));
    }

    /**
     * P(at least one copy of each card name is in the opponent's hand) under the belief, estimated by sampling.
     * For the dashboard only.
     */
    handMarginals(opp, rng, samples = 200) {
        const pool = unseenPool(opp);
        const counts = new Map();
        for (let s = 0; s < samples; s++) {
            const { hand } = this.sampleSplit(pool, opp.hand.length, opp.resources.length, rng);
            for (const name of new Set(hand)) {
                counts.set(name, (counts.get(name) ?? 0) + 1);
            }
        }
        return [...counts].map(([name, n]) => ({ name, p: n / samples })).sort((a, b) => b.p - a.p);
    }

    /** Sample names for hand / resources / deck from the pool's multiset. */
    sampleSplit(pool, handSize, resSize, rng) {
        const left = new Map();
        for (const c of pool) {
            left.set(cardKey(c), (left.get(cardKey(c)) ?? 0) + 1);
        }
        const draw = (weighted) => {
            let total = 0;
            for (const [name, n] of left) {
                total += n * (weighted ? this.weight(name) : 1);
            }
            let r = rng() * total;
            let pick = null;
            for (const [name, n] of left) {
                pick = name;
                r -= n * (weighted ? this.weight(name) : 1);
                if (r <= 0) {
                    break;
                }
            }
            const n = left.get(pick) - 1;
            if (n) {
                left.set(pick, n);
            } else {
                left.delete(pick);
            }
            return pick;
        };
        const hand = [];
        for (let i = 0; i < handSize; i++) {
            hand.push(draw(true));
        }
        const res = [];
        for (let i = 0; i < resSize; i++) {
            res.push(draw(false));
        }
        const deck = [];
        for (const [name, n] of left) {
            for (let i = 0; i < n; i++) {
                deck.push(name);
            }
        }
        return { hand, res, deck };
    }
}

function shuffleInPlace(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/**
 * Turn the real game into one sampled world consistent with what `pid` knows: my deck is shuffled, the
 * opponent's unseen cards are re-split between hand / resources / deck according to the belief, and their deck is
 * shuffled. Zone sizes and the number of ready resources stay the same. Must run inside a snapshot (mark/restore).
 * Returns the number of cards moved.
 */
function determinize(eg, pid, belief, rng) {
    const me = eg.player(pid);
    const opp = me.opponent;

    const hand = [...opp.hand];
    const res = [...opp.resources];
    const deck = [...opp.drawDeck];
    const readyBefore = opp.readyResourceCount;
    const target = belief.sampleSplit([...hand, ...res, ...deck], hand.length, res.length, rng);

    // per zone: how many of each name it should end with
    const want = { hand: countNames(target.hand), resource: countNames(target.res), deck: countNames(target.deck) };
    const have = { hand: hand, resource: res, deck: deck };
    // cards that are in a zone with too many of their name have to move
    const movers = [];
    for (const zone of ['hand', 'resource', 'deck']) {
        const budget = new Map(want[zone]);
        for (const c of have[zone]) {
            const k = cardKey(c);
            const n = budget.get(k) ?? 0;
            if (n > 0) {
                budget.set(k, n - 1);
            } else {
                movers.push(c);
            }
        }
        want[zone] = budget; // what is still missing in this zone
    }
    let moved = 0;
    for (const c of movers) {
        const k = cardKey(c);
        const dest = ['hand', 'resource', 'deck'].find((z) => (want[z].get(k) ?? 0) > 0);
        if (!dest) {
            continue; // cannot happen when the pool is consistent; leave the card where it is
        }
        want[dest].set(k, want[dest].get(k) - 1);
        c.moveTo(dest === 'deck' ? 'deckBottom' : dest);
        moved++;
    }
    // keep the number of ready resources exactly as it was (which particular resource is ready does not matter)
    const resources = [...opp.resources];
    resources.forEach((c, i) => {
        c.exhausted = i >= readyBefore;
    });
    shuffleDeck(opp.deckZone, rng);
    shuffleDeck(me.deckZone, rng);
    return moved;
}

function shuffleDeck(zone, rng) {
    zone._deck = shuffleInPlace([...zone.deck], rng);
}

function countNames(names) {
    const m = new Map();
    for (const n of names) {
        m.set(n, (m.get(n) ?? 0) + 1);
    }
    return m;
}

module.exports = { BeliefModel, determinize, effectiveCost, unseenPool, cardKey };
