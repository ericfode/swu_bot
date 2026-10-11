'use strict';

const path = require('path');
const { setCodeToString } = require(path.join(__dirname, '..', 'forceteki', 'build/server', 'Util.js'));

/**
 * Plain-JSON views of an EnvGame: the board a bot sees (view(eg, seat)), the board a replay records (snapshot(eg)),
 * and the prompt and legal actions of a decision. Shapes are specified in spec/protocol.md and spec/replay-format.md.
 * Cards are named by eg.cardId (stable for the game), never by engine uuid. Everything here only reads engine state.
 */

const ZONE = { hand: 'hand', discard: 'discard', resource: 'resource', ground: 'groundArena', space: 'spaceArena' };

function setCode(card) {
    try {
        return card.setId && card.setId.number != null ? setCodeToString(card.setId) : null;
    } catch {
        return null;
    }
}

const cardRef = (eg, card) => ({ id: eg.cardId(card.uuid), n: card.title, s: setCode(card) });

/** A card `pid` cannot see: in a deck, or in the other player's hand or resources. Shown as HIDDEN, a card ref. */
const hiddenFrom = (card, pid) => card.zoneName === 'deck' || ((card.zoneName === 'hand' || card.zoneName === 'resource') && card.controller?.id !== pid);
const HIDDEN = { id: 'hidden', n: 'hidden card', s: null };

function unitRef(eg, card, player) {
    const sum = card.getSummary(player, true);
    const out = { ...cardRef(eg, card), p: sum.power ?? card.cardData.power, h: sum.hp ?? card.cardData.hp, d: sum.damage ?? 0 };
    if (sum.exhausted) {
        out.x = 1;
    }
    if (sum.sentinel) {
        out.sn = 1;
    }
    const ups = card.upgrades ?? [];
    if (ups.length) {
        out.u = ups.map((u) => ({ ...cardRef(eg, u), t: u.isToken?.() ? 1 : 0 }));
    }
    // captured cards are open information
    const cap = card.capturedUnits ?? [];
    if (cap.length) {
        out.cap = cap.map((c) => cardRef(eg, c));
    }
    return out;
}

/** One player's side. The hand is listed when `seen`; resource cards (face down to the opponent) when `own`. */
function playerView(eg, player, seen, own) {
    const cards = (zone) => player.getCardsInZone(zone) ?? [];
    const ref = (c) => cardRef(eg, c);
    const base = player.base;
    const leader = player.getAllDeckLeaders()[0];
    const leaderSum = leader?.getSummary(player, true);
    const baseSum = base.getSummary(player, true);
    const hand = cards(ZONE.hand);
    const out = {
        name: player.name,
        base: { ...ref(base), hp: base.cardData.hp, d: baseSum.damage ?? 0, ...(baseSum.epicActionSpent ? { epic: 1 } : {}) },
        leader: leader ? {
            ...ref(leader), dep: leaderSum.onStartingSide === false || leader.deployed ? 1 : 0, x: leaderSum.exhausted ? 1 : 0,
            ...(leaderSum.epicDeployActionSpent ? { epic: 1 } : {})
        } : null,
        res: { ready: player.readyResourceCount, total: cards(ZONE.resource).length },
        handCount: hand.length,
        deck: player.drawDeck?.length ?? 0,
        discard: cards(ZONE.discard).map(ref),
        // attached upgrades live in the arena zone too; they are reported under their host unit instead
        ground: cards(ZONE.ground).filter((c) => c.isUnit()).map((c) => unitRef(eg, c, player)),
        space: cards(ZONE.space).filter((c) => c.isUnit()).map((c) => unitRef(eg, c, player))
    };
    if (eg.phase === 'action') {
        // out: done for this action phase (claimed the initiative, or both passed); passed: passed its last action
        if (player.passedActionPhase) {
            out.out = 1;
        } else if (eg.game.prevActionPhasePlayerPassed && eg.game.actionPhaseActivePlayer !== player) {
            out.passed = 1;
        }
    }
    if (player.hasTheForce) {
        out.force = 1;
    }
    if (player.creditTokenCount > 0) {
        out.credits = player.creditTokenCount;
    }
    if (seen) {
        out.hand = hand.map(ref);
    }
    if (own) {
        out.resources = cards(ZONE.resource).map((c) => (c.exhausted ? { ...ref(c), x: 1 } : ref(c)));
    }
    return out;
}

/**
 * The board as seat `you` sees it, or with both hands when `you` is null (replays). Deck order is never shown;
 * resource cards only to their owner, so replays stay small (they add about half again to a replay file).
 */
function view(eg, you = null) {
    const players = {};
    for (const id of eg.ids) {
        const seat = eg.seatOf(id);
        players[seat] = playerView(eg, eg.player(id), you === null || seat === you, seat === you);
    }
    const init = eg.ids.find((id) => eg.player(id).hasInitiative());
    return { round: eg.round, phase: eg.phase, initiative: init ? eg.seatOf(init) : null, players };
}

/** Replay snapshot: the whole board. */
const snapshot = (eg) => view(eg);

/** A card with where it is: `zone` and controlling seat `ctl`. */
const placedRef = (eg, c) => ({ ...cardRef(eg, c), zone: c.zoneName ?? null, ctl: c.controller ? eg.seatOf(c.controller.id) : null });

/**
 * The prompt `pid` is answering, minus engine objects. `cards` are the cards the prompt shows, with their selection
 * state `st` (selectable, selected, unselectable, invalid or viewOnly): what a player looking at the screen sees.
 * A selected card hidden from `pid` has id 'hidden'.
 */
function promptView(eg, pid) {
    const pl = eg.player(pid);
    const p = pl.currentPrompt();
    const out = {
        type: p.promptType || null,
        signature: eg.promptSignature(pid),
        title: p.menuTitle ?? null,
        promptTitle: p.promptTitle ?? null,
        selectCardMode: p.selectCardMode ?? null,
        selected: (pl.promptState.selectedCards ?? []).map((c) => (hiddenFrom(c, pid) ? HIDDEN.id : eg.cardId(c.uuid))),
        actionWindow: eg.isActionWindow(pid)
    };
    if (p.displayCards?.length) {
        out.cards = p.displayCards.map((dc) => {
            const c = eg.game.findAnyCardInAnyList(dc.cardUuid);
            return { ...(c ? placedRef(eg, c) : { id: eg.cardId(dc.cardUuid), n: dc.internalName, s: null, zone: null, ctl: null }), st: dc.selectionState };
        });
    }
    return out;
}

/**
 * Legal action `a` of player `pid` as plain JSON; `i` is its index in legalActions(pid), which is what a bot answers
 * with. A card hidden from `pid` that the engine lets it pick (an engine bug) is a 'hidden card' with only its place.
 */
function actionView(eg, a, i, pid) {
    if (a.kind === 'card' && pid !== undefined && hiddenFrom(a.card, pid)) {
        return { i, kind: a.kind, label: HIDDEN.n, card: { ...HIDDEN, zone: a.card.zoneName ?? null, ctl: eg.seatOf(a.card.controller.id) } };
    }
    const out = { i, kind: a.kind, label: a.label };
    if (a.arg !== undefined) {
        // a display card is picked by its card id
        out.arg = a.kind === 'displayCard' ? eg.cardId(a.arg) : a.arg;
    }
    if (a.cardUuid !== undefined) {
        out.cardUuid = eg.cardId(a.cardUuid);
    }
    if (a.kind === 'card') {
        out.card = placedRef(eg, a.card);
    }
    if (a.kind === 'distribute') {
        const s = a.spec;
        out.distribute = {
            type: s.type, amount: s.amount, canDistributeLess: !!s.canDistributeLess, canChooseNoTargets: !!s.canChooseNoTargets,
            maxTargets: s.maxTargets ?? null, tokenType: s.tokenType ?? null,
            // JSON has no Infinity: an uncapped target has cap null
            targets: a.targets.map((id, k) => ({ id: eg.cardId(id), cap: Number.isFinite(a.caps[k]) ? a.caps[k] : null }))
        };
    }
    return out;
}

/** What identifies an action across engines and rollbacks (prompt uuids change; card ids do not). */
const actionKey = (eg, a) => `${a.kind}|${a.label}|${a.kind === 'displayCard' ? eg.cardId(a.arg) : a.arg}|${a.cardUuid ? eg.cardId(a.cardUuid) : ''}`;

module.exports = { view, snapshot, promptView, actionView, actionKey, placedRef };
