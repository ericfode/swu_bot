'use strict';
/**
 * Karabast frames -> what a protocol bot reads (spec/protocol.md): the `decide` message's prompt, state and actions,
 * and the `hello` message's deck lists. One Observer per game and seat.
 *
 * The bot is always seat p1 and its opponent p2. Cards are named `c<n>` in the order they are first seen (Karabast's
 * uuids never reach the bot). A frame shows only what that player may see: the other hand and face-down resources
 * have no uuid, so they are hidden cards, and deck order is never sent. Fields Karabast does not send are left out:
 * `passed` (the other player passed its last action) is not in a frame; `out` comes from `initiativeClaimed`.
 */
const fs = require('fs');
const path = require('path');
const { legalActions, cardSummaries } = require('./frame');

const isObj = (x) => x != null && typeof x === 'object';
const HIDDEN = { id: 'hidden', n: 'hidden card', s: null };
const setCode = (setId) => (setId?.set && setId.number != null ? `${setId.set}_${String(setId.number).padStart(3, '0')}` : null);
const isUpgrade = (t) => /upgrade/i.test(t ?? '');
const isUnit = (t) => /unit$/i.test(t ?? '') && !isUpgrade(t);
const isToken = (t) => /^token/i.test(t ?? '');

/** Text of a chat line (string, fragments or alert), enough to find "Round: N - ..." alerts. */
function lineText(m) {
    const body = isObj(m) && 'message' in m ? m.message : m;
    const parts = [];
    const walk = (x) => {
        if (typeof x === 'string' || typeof x === 'number') {
            parts.push(String(x));
        } else if (Array.isArray(x)) {
            x.forEach(walk);
        } else if (isObj(x)) {
            walk(x.alert?.message ?? x.message ?? x.name ?? x.format ?? '');
        }
    };
    walk(body);
    return parts.join('');
}

/** The env.js prompt signature, from a Karabast promptState. */
function signature(p) {
    return [p.promptType || '-', p.selectCardMode || '-', p.distributeAmongTargets ? 'dist' : '', p.selectNumber ? 'num' : '',
        p.dropdownListOptions?.length ? 'dd' : '', p.displayCards?.length ? 'disp' : '', p.perCardButtons?.length ? 'pcb' : '',
        p.batchTriggerResolution ? 'batch' : ''].filter(Boolean).join('|');
}

let cardsCache = null;

/**
 * From the card json that `npm run get-cards` writes (SWU_CARD_JSON or forceteki/test/json): `internal`, card id
 * (forceteki cardData.id, the `id` of a card summary) -> internal name, which labels card actions as bot/env.js does;
 * `title`, set code -> title, for shown cards the frame has no summary of (cards in a deck). Empty maps when there is
 * no card json: labels are then card titles, and such shown cards keep their internal names.
 */
function cardIndex(dir = process.env.SWU_CARD_JSON ?? path.join(__dirname, '..', '..', 'forceteki', 'test', 'json')) {
    if (!cardsCache) {
        cardsCache = { internal: new Map(), title: new Map() };
        const cards = path.join(dir, 'Card');
        if (fs.existsSync(cards)) {
            for (const f of fs.readdirSync(cards)) {
                try {
                    const c = JSON.parse(fs.readFileSync(path.join(cards, f), 'utf8'));
                    if (c.id != null && c.internalName) {
                        cardsCache.internal.set(String(c.id), c.internalName);
                    }
                    if (setCode(c.setId) && c.title) {
                        cardsCache.title.set(setCode(c.setId), c.title);
                    }
                } catch {
                    // not a card file
                }
            }
        }
    }
    return cardsCache;
}

class Observer {
    /** `me`: the bot's user id in the frames. */
    constructor(me, { cards = cardIndex() } = {}) {
        this.me = me;
        this.cards = cards;
        this.ids = new Map(); // uuid -> c<n>
        this.uuids = new Map(); // c<n> -> uuid
        this.round = 0;
    }

    id(uuid) {
        if (!this.ids.has(uuid)) {
            const id = `c${this.ids.size + 1}`;
            this.ids.set(uuid, id);
            this.uuids.set(id, uuid);
        }
        return this.ids.get(uuid);
    }

    /** Call once per frame, in order: reads the round from the new chat lines. */
    absorb(frame) {
        for (const m of frame?.newMessages ?? []) {
            const r = lineText(m).match(/^Round:\s*(\d+)\s*-/i);
            if (r) {
                this.round = Number(r[1]);
            }
        }
    }

    /** User ids by seat: { p1: me, p2: opponent } (p2 is null until the opponent is in the frame). */
    seats(frame) {
        const other = Object.keys(frame?.players ?? {}).find((id) => id !== this.me) ?? null;
        return { p1: this.me, p2: other };
    }

    ref(c) {
        return !c?.uuid || (c.name == null && c.setId == null) ? { ...HIDDEN } : { id: this.id(c.uuid), n: c.name, s: setCode(c.setId) };
    }

    placed(c, seatOf) {
        return { ...this.ref(c), zone: c?.zone ?? null, ctl: seatOf.get(c?.controllerId) ?? null };
    }

    side(frame, uid, seat, own) {
        const p = frame.players[uid] ?? {};
        const piles = p.cardPiles ?? {};
        const all = Object.values(frame.players).flatMap((q) => ['groundArena', 'spaceArena', 'capturedZone'].flatMap((z) => q?.cardPiles?.[z] ?? []));
        const under = (host, test) => all.filter((c) => c?.parentCardId === host && test(c));
        const unit = (c) => {
            const out = { ...this.ref(c), p: c.power ?? 0, h: c.hp ?? 0, d: c.damage ?? 0 };
            if (c.exhausted) {
                out.x = 1;
            }
            if (c.sentinel) {
                out.sn = 1;
            }
            const ups = under(c.uuid, (u) => u.zone !== 'capture' && (isUpgrade(u.type) || !isUnit(u.type)));
            if (ups.length) {
                out.u = ups.map((u) => ({ ...this.ref(u), t: isToken(u.type) ? 1 : 0 }));
            }
            const cap = under(c.uuid, (u) => u.zone === 'capture');
            if (cap.length) {
                out.cap = cap.map((u) => this.ref(u));
            }
            return out;
        };
        const units = (zone) => (piles[zone] ?? []).filter((c) => c && isUnit(c.type) && c.parentCardId == null).map(unit);
        const base = p.base ?? {};
        const leader = (p.leaders ?? []).filter(Boolean)[0] ?? p.leader ?? null;
        const out = {
            name: seat,
            base: { ...this.ref(base), hp: base.hp ?? 0, d: base.damage ?? 0, ...(base.epicActionSpent ? { epic: 1 } : {}) },
            leader: leader ? {
                ...this.ref(leader), dep: leader.onStartingSide === false || (leader.zone && leader.zone !== 'base') ? 1 : 0, x: leader.exhausted ? 1 : 0,
                ...(leader.epicDeployActionSpent ? { epic: 1 } : {})
            } : null,
            res: { ready: p.availableResources ?? 0, total: (piles.resources ?? []).length },
            handCount: (piles.hand ?? []).length,
            deck: p.numCardsInDeck ?? 0,
            discard: (piles.discard ?? []).map((c) => this.ref(c)),
            ground: units('groundArena'),
            space: units('spaceArena')
        };
        if (frame.phase === 'action' && frame.initiativeClaimed && p.hasInitiative) {
            out.out = 1;
        }
        if (p.forceToken?.active) {
            out.force = 1;
        }
        const credits = (p.credits ?? piles.credits ?? []).length;
        if (credits > 0) {
            out.credits = credits;
        }
        if (own) {
            out.hand = (piles.hand ?? []).map((c) => this.ref(c));
            out.resources = (piles.resources ?? []).map((c) => (c.exhausted ? { ...this.ref(c), x: 1 } : this.ref(c)));
        }
        return out;
    }

    /** The board as the bot sees it (protocol `state`). */
    state(frame) {
        const seats = this.seats(frame);
        const players = {};
        for (const [seat, uid] of Object.entries(seats)) {
            players[seat] = this.side(frame, uid, seat, seat === 'p1');
        }
        const init = Object.entries(seats).find(([, uid]) => frame.players[uid]?.hasInitiative)?.[0] ?? null;
        return { round: this.round, phase: frame.phase ?? null, initiative: init, players };
    }

    /**
     * The decision in `frame`, or null when the bot only waits: { prompt, state, actions, raw } where `actions` is the
     * protocol list and `raw[i]` the frame.js action it stands for. `drop(rawAction)` hides actions from the bot.
     */
    decision(frame, drop = () => false) {
        const raw = legalActions(frame, this.me).filter((a) => !drop(a));
        if (!raw.length) {
            return null;
        }
        const seatOf = new Map(Object.entries(this.seats(frame)).map(([seat, uid]) => [uid, seat]));
        const p = frame.players[this.me].promptState;
        const sig = signature(p);
        const cards = new Map(cardSummaries(frame).map((c) => [c.uuid, c]));
        const prompt = {
            type: p.promptType || null,
            signature: sig,
            title: p.menuTitle ?? null,
            promptTitle: p.promptTitle ?? null,
            selectCardMode: p.selectCardMode ?? null,
            // in selection order when the prompt numbers the picks
            selected: [...cards.values()].filter((c) => c.selected === true).sort((x, y) => (x.order ?? 0) - (y.order ?? 0)).map((c) => this.id(c.uuid)),
            actionWindow: frame.phase === 'action' && sig.startsWith('actionWindow')
        };
        if (p.displayCards?.length) {
            prompt.cards = p.displayCards.map((dc) => {
                const c = cards.get(dc.cardUuid);
                // a card the frame has no summary of is in a deck or a hidden zone: its place is not in the frame
                const s = setCode(dc.setId);
                const base = c ? this.placed(c, seatOf) : { id: this.id(dc.cardUuid), n: this.cards.title.get(s) ?? dc.internalName ?? null, s, zone: null, ctl: null };
                return { ...base, st: dc.selectionState };
            });
        }
        const actions = raw.map((a, i) => this.actionView(a, i, cards, seatOf));
        return { prompt, state: this.state(frame), actions, raw };
    }

    actionView(a, i, cards, seatOf) {
        const out = { i, kind: a.kind, label: a.label };
        switch (a.kind) {
            case 'button':
            case 'option':
                out.arg = a.arg;
                break;
            case 'displayCard':
                out.arg = this.id(a.arg);
                break;
            case 'perCardButton':
                out.arg = a.arg;
                out.cardUuid = this.id(a.cardUuid);
                break;
            case 'card':
                out.label = this.cards.internal.get(String(a.card.id)) ?? a.label;
                out.cardUuid = this.id(a.cardUuid);
                out.card = this.placed(a.card, seatOf);
                break;
            case 'distribute': {
                const s = a.spec;
                out.distribute = {
                    type: s.type, amount: s.amount, canDistributeLess: !!s.canDistributeLess, canChooseNoTargets: !!s.canChooseNoTargets,
                    maxTargets: s.maxTargets ?? null, tokenType: s.tokenType ?? null,
                    targets: a.targets.map((uuid, k) => ({ id: this.id(uuid), cap: Number.isFinite(a.caps[k]) ? a.caps[k] : null }))
                };
                break;
            }
            default:
                break;
        }
        return out;
    }

    /**
     * A bot's split for distribute action `a` ([{id: c<n>, amount}]) -> [{id: uuid, amount}], or null when it is not
     * legal (spec/protocol.md: listed targets once each, 0..cap, at most maxTargets non-zero, total = amount unless
     * canDistributeLess, 0 only with canChooseNoTargets).
     */
    split(a, given) {
        if (!Array.isArray(given)) {
            return null;
        }
        const s = a.spec;
        const seen = new Set();
        let total = 0;
        let used = 0;
        const out = [];
        for (const e of given) {
            const uuid = this.uuids.get(e?.id);
            const k = a.targets.indexOf(uuid);
            if (k < 0 || seen.has(uuid) || !Number.isInteger(e.amount) || e.amount < 0 || e.amount > a.caps[k]) {
                return null;
            }
            seen.add(uuid);
            total += e.amount;
            used += e.amount > 0 ? 1 : 0;
            out.push({ id: uuid, amount: e.amount });
        }
        const maxTargets = s.maxTargets ?? Infinity;
        const ok = used <= maxTargets && (total === s.amount || (s.canDistributeLess && total <= s.amount)) && (total > 0 || s.canChooseNoTargets);
        return ok ? out : null;
    }

    /** hello's deck lists: our own list, and for the opponent only what the table shows (leader and base). */
    decks(frame, ownDeck) {
        const opp = frame.players[this.seats(frame).p2] ?? {};
        const leader = (opp.leaders ?? []).filter(Boolean)[0] ?? opp.leader;
        return {
            deck: ownDeck,
            opponent: {
                metadata: { name: 'unknown (Karabast opponent)', author: 'unknown' },
                leader: { id: setCode(leader?.setId), count: 1 },
                base: { id: setCode(opp.base?.setId), count: 1 },
                deck: []
            }
        };
    }
}

module.exports = { Observer, signature, lineText, cardIndex };
