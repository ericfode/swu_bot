'use strict';

const path = require('path');
const { setCodeToString } = require(path.join(__dirname, '..', 'forceteki', 'build/server', 'Util.js'));

/**
 * Compact, read-only snapshots of an EnvGame for replay files.
 * Everything here only reads engine state; the determinism check in bot/README.md guards that.
 */

const ZONE = { hand: 'hand', discard: 'discard', resource: 'resource', ground: 'groundArena', space: 'spaceArena' };

function setCode(card) {
    try {
        return card.setId && card.setId.number != null ? setCodeToString(card.setId) : null;
    } catch {
        return null;
    }
}

function cardRef(card) {
    return { n: card.title, s: setCode(card) };
}

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

function playerSnapshot(player) {
    const cards = (zone) => player.getCardsInZone(zone) ?? [];
    const base = player.base;
    const baseSum = base.getSummary(player, true);
    const leader = player.getAllDeckLeaders()[0];
    const leaderSum = leader?.getSummary(player, true);
    return {
        name: player.name,
        base: { ...cardRef(base), hp: base.cardData.hp, d: baseSum.damage ?? 0 },
        leader: leader ? { ...cardRef(leader), dep: leaderSum.onStartingSide === false || leader.deployed ? 1 : 0, x: leaderSum.exhausted ? 1 : 0 } : null,
        res: { ready: player.readyResourceCount, total: cards(ZONE.resource).length },
        hand: cards(ZONE.hand).map(cardRef),
        deck: player.drawDeck?.length ?? 0,
        discard: cards(ZONE.discard).map(cardRef),
        // attached upgrades live in the arena zone too; they are reported under their host unit instead
        ground: cards(ZONE.ground).filter((c) => c.isUnit()).map((c) => unitRef(c, player)),
        space: cards(ZONE.space).filter((c) => c.isUnit()).map((c) => unitRef(c, player))
    };
}

function snapshot(eg) {
    const g = eg.game;
    const players = {};
    eg.ids.forEach((id, i) => {
        players[`p${i + 1}`] = playerSnapshot(eg.player(id));
    });
    const init = eg.ids.findIndex((id) => eg.player(id).hasInitiative());
    return { round: eg.round, phase: eg.phase, initiative: init < 0 ? null : `p${init + 1}`, players };
}

module.exports = { snapshot };
