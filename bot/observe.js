'use strict';

const path = require('path');
const { setCodeToString } = require(path.join(__dirname, '..', 'forceteki', 'build/server', 'Util.js'));

/**
 * Plain-JSON view of an EnvGame from one seat, for bots that cannot hold engine objects (see spec/stdio-protocol.md).
 * Same fields as the replay snapshot in recorder.js, plus an `id` (the engine card uuid, which is what `card` actions
 * and distribute targets refer to) on every card, your own hand and resources listed, and the opponent's hand reduced to a count.
 * Only reads engine state.
 */

const ZONE = { hand: 'hand', discard: 'discard', resource: 'resource', ground: 'groundArena', space: 'spaceArena' };

function setCode(card) {
    try {
        return card.setId && card.setId.number != null ? setCodeToString(card.setId) : null;
    } catch {
        return null;
    }
}

const cardRef = (card) => ({ id: card.uuid, n: card.title, s: setCode(card) });

function unitRef(card, player) {
    const sum = card.getSummary(player, true);
    const out = { ...cardRef(card), p: sum.power ?? card.cardData.power, h: sum.hp ?? card.cardData.hp, d: sum.damage ?? 0 };
    if (sum.exhausted) {
        out.x = 1;
    }
    if (sum.sentinel) {
        out.sn = 1;
    }
    const ups = card.upgrades ?? [];
    if (ups.length) {
        out.u = ups.map((u) => ({ ...cardRef(u), t: u.isToken?.() ? 1 : 0 }));
    }
    return out;
}

function playerView(player, isMe) {
    const cards = (zone) => player.getCardsInZone(zone) ?? [];
    const base = player.base;
    const baseSum = base.getSummary(player, true);
    const leader = player.getAllDeckLeaders()[0];
    const leaderSum = leader?.getSummary(player, true);
    const hand = cards(ZONE.hand);
    const out = {
        name: player.name,
        base: { ...cardRef(base), hp: base.cardData.hp, d: baseSum.damage ?? 0 },
        leader: leader ? { ...cardRef(leader), dep: leaderSum.onStartingSide === false || leader.deployed ? 1 : 0, x: leaderSum.exhausted ? 1 : 0 } : null,
        res: { ready: player.readyResourceCount, total: cards(ZONE.resource).length },
        handCount: hand.length,
        deck: player.drawDeck?.length ?? 0,
        discard: cards(ZONE.discard).map(cardRef),
        ground: cards(ZONE.ground).filter((c) => c.isUnit()).map((c) => unitRef(c, player)),
        space: cards(ZONE.space).filter((c) => c.isUnit()).map((c) => unitRef(c, player))
    };
    if (isMe) {
        out.hand = hand.map(cardRef);
        // own resources are known to their owner and can be played from (Smuggle); the opponent's are face down
        out.resources = cards(ZONE.resource).map((c) => (c.exhausted ? { ...cardRef(c), x: 1 } : cardRef(c)));
    }
    return out;
}

const seatOf = (eg, player) => {
    const i = player ? eg.ids.indexOf(player.id) : -1;
    return i < 0 ? null : `p${i + 1}`;
};

/** Board from `pid`'s side: own hand visible, opponent hand as a count, deck order never shown. */
function observe(eg, pid) {
    const players = {};
    eg.ids.forEach((id, i) => {
        players[`p${i + 1}`] = playerView(eg.player(id), id === pid);
    });
    const init = eg.ids.findIndex((id) => eg.player(id).hasInitiative());
    return { round: eg.round, phase: eg.phase, initiative: init < 0 ? null : `p${init + 1}`, players };
}

/** The prompt `pid` is answering, minus engine objects. */
function promptView(eg, pid) {
    const pl = eg.player(pid);
    const p = pl.currentPrompt();
    return {
        type: p.promptType || null,
        signature: eg.promptSignature(pid),
        title: p.menuTitle ?? null,
        promptTitle: p.promptTitle ?? null,
        selectCardMode: p.selectCardMode ?? null,
        selected: (pl.promptState.selectedCards ?? []).map((c) => c.uuid),
        actionWindow: eg.isActionWindow(pid)
    };
}

/** One legal action as plain JSON. `i` is its index in legalActions(pid), which is what a bot answers with. */
function actionView(eg, a, i) {
    const out = { i, kind: a.kind, label: a.label };
    if (a.arg !== undefined) {
        out.arg = a.arg;
    }
    if (a.cardUuid !== undefined) {
        out.cardUuid = a.cardUuid;
    }
    if (a.kind === 'card' && a.card) {
        out.card = { id: a.card.uuid, n: a.card.title, s: setCode(a.card), zone: a.card.zoneName ?? null, ctl: seatOf(eg, a.card.controller) };
    }
    if (a.kind === 'distribute') {
        const s = a.spec;
        out.distribute = {
            type: s.type, amount: s.amount, canDistributeLess: !!s.canDistributeLess, canChooseNoTargets: !!s.canChooseNoTargets,
            maxTargets: s.maxTargets ?? null, tokenType: s.tokenType ?? null,
            // JSON has no Infinity: an uncapped target has cap null
            targets: a.targets.map((id, k) => ({ id, cap: Number.isFinite(a.caps[k]) ? a.caps[k] : null }))
        };
    }
    return out;
}

module.exports = { observe, promptView, actionView, seatOf };
