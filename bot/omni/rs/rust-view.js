'use strict';
// Protocol views (the shapes of bot/view.js) of a Rust simulator position, for bots that ask to simulate on the Rust
// engine (spec/protocol.md, `simEngine`). The Rust state names cards by stable id and set code; titles and keywords
// come from the pool file. What the Rust state does not hold is left out: prompt titles and types, the Force, credits.
const ZONES = { hand: 'hand', resources: 'resource', ground: 'groundArena', space: 'spaceArena', discard: 'discard', deck: 'deck' };

/** setCode -> { title, sentinel } from a loaded pool (bot/omni/rs/pool.js). */
function poolCards(pool) {
    return new Map(pool.cards.map((c) => [c.setCode, { title: c.title, sentinel: (c.keywords ?? []).includes('sentinel'), token: (c.types ?? []).includes('token') }]));
}

class RustViews {
    constructor(pool) {
        this.cards = poolCards(pool);
    }

    ref(c) {
        const info = this.cards.get(c.setCode);
        // forceteki gives tokens no set code
        return { id: c.id, n: info?.title ?? c.name, s: info?.token ? null : c.setCode };
    }

    unit(c) {
        const out = { ...this.ref(c), p: c.power, h: c.hp, d: c.damage ?? 0 };
        if (c.exhausted) out.x = 1;
        if (this.cards.get(c.setCode)?.sentinel) out.sn = 1;
        if (c.upgrades?.length) out.u = c.upgrades.map((u) => ({ ...this.ref(u), t: u.token ? 1 : 0 }));
        return out;
    }

    /** bot/view.js view(eg, you): the board as seat `you` sees it. */
    view(state, you) {
        const players = {};
        for (const [seat, p] of Object.entries(state.players)) {
            const seen = seat === you;
            const out = {
                name: seat,
                base: { ...this.ref(p.base), hp: p.base.hp, d: p.base.damage, ...(p.base.epicUsed ? { epic: 1 } : {}) },
                leader: { ...this.ref(p.leader), dep: p.leader.deployed ? 1 : 0, x: p.leader.exhausted ? 1 : 0, ...(p.leader.epicUsed ? { epic: 1 } : {}) },
                res: { ready: p.resources.filter((r) => !r.exhausted).length, total: p.resources.length },
                handCount: p.hand.length,
                deck: p.deck.length,
                discard: p.discard.map((c) => this.ref(c)),
                ground: p.ground.map((c) => this.unit(c)),
                space: p.space.map((c) => this.unit(c))
            };
            if (state.phase === 'action') {
                if (p.out) out.out = 1;
                else if (state.prevPassed && state.activePlayer !== seat) out.passed = 1;
            }
            if (seen) {
                out.hand = p.hand.map((c) => this.ref(c));
                out.resources = p.resources.map((c) => (c.exhausted ? { ...this.ref(c), x: 1 } : this.ref(c)));
            }
            players[seat] = out;
        }
        return { round: state.round, phase: state.phase, initiative: state.initiative, players };
    }

    /** Where a card is in the Rust state: { zone, ctl } as bot/view.js placedRef has them. */
    place(state, id) {
        for (const [seat, p] of Object.entries(state.players)) {
            for (const [key, zone] of Object.entries(ZONES)) {
                if (p[key].some((c) => c.id === id)) return { zone, ctl: seat };
            }
            for (const arena of ['ground', 'space']) {
                if (p[arena].some((u) => (u.upgrades ?? []).some((x) => x.id === id))) return { zone: ZONES[arena], ctl: seat };
            }
            if (p.base.id === id || (p.leader.id === id && !p.leader.deployed)) return { zone: 'base', ctl: seat };
        }
        return { zone: null, ctl: null };
    }

    find(state, id) {
        for (const p of Object.values(state.players)) {
            for (const c of [p.base, p.leader, ...p.hand, ...p.deck, ...p.resources, ...p.discard, ...p.ground, ...p.space]) {
                if (c.id === id) return c;
                for (const u of c.upgrades ?? []) if (u.id === id) return u;
            }
        }
        return null;
    }

    /** bot/view.js actionView for each Rust legal action, as seat `seat` sees it. Hidden cards are never offered. */
    actions(state, actions) {
        return actions.map((a, i) => {
            const out = { i, kind: a.kind, label: a.label };
            if (a.kind === 'distribute') {
                // Rust lists each allocation as its own action; a split the bot sends is ignored
                out.split = (a.arg ?? []).map(([id, amount]) => ({ id, amount }));
                return out;
            }
            if (a.arg !== null && a.arg !== undefined) out.arg = a.arg;
            if (a.card && a.kind !== 'displayCard') {
                out.cardUuid = a.card;
                if (a.kind === 'card') {
                    const c = this.find(state, a.card);
                    out.card = { ...(c ? this.ref(c) : { id: a.card, n: a.label, s: null }), ...this.place(state, a.card) };
                }
            }
            return out;
        });
    }

    /**
     * What bot/view.js promptView gives, as far as the Rust state knows it. The signature is forceteki's at an action
     * window; elsewhere it is `rust|` and the kinds of the legal actions, since Rust has no prompt types.
     */
    prompt(game, seat, actions = []) {
        const actionWindow = game.isActionWindow(seat);
        const signature = actionWindow ? 'actionWindow|-' : ['rust', ...new Set(actions.map((a) => a.kind).sort())].join('|');
        return { type: null, signature, title: null, promptTitle: null, selectCardMode: null, selected: [], actionWindow };
    }
}

module.exports = { RustViews, poolCards };
