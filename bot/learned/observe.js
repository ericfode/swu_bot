'use strict';

/**
 * Observation of an EnvGame from one seat, in the shape the stdio protocol sends as `state`:
 * the replay snapshot (bot/recorder.js) plus card uuids (`id`) and `handCount`, with the opponent's hand removed.
 * The learned bot builds its features from this, so the same features work in-process, over stdio and on replays.
 */
const { snapshot } = require('../recorder');

const ZONES = { hand: 'hand', ground: 'groundArena', space: 'spaceArena', discard: 'discard' };

function observe(eg, pid) {
    const s = snapshot(eg);
    const you = `p${eg.ids.indexOf(pid) + 1}`;
    eg.ids.forEach((id, i) => {
        const seat = `p${i + 1}`;
        const pl = eg.player(id);
        const ps = s.players[seat];
        ps.base.id = pl.base.uuid;
        const leader = pl.getAllDeckLeaders()[0];
        if (ps.leader && leader) {
            ps.leader.id = leader.uuid;
        }
        // same zone order as recorder.playerSnapshot, so the lists line up one to one
        for (const [key, zone] of Object.entries(ZONES)) {
            let cards = pl.getCardsInZone(zone) ?? [];
            if (key === 'ground' || key === 'space') {
                cards = cards.filter((c) => c.isUnit());
            }
            cards.forEach((c, k) => {
                if (ps[key][k]) {
                    ps[key][k].id = c.uuid;
                }
            });
        }
        ps.handCount = ps.hand.length;
        if (seat !== you) {
            delete ps.hand;
        }
    });
    return { ...s, you };
}

/** An action in the stdio shape ({kind, label, arg, card: {id, n, s, zone, ctl}}), without engine objects. */
function plainAction(eg, a) {
    const out = { kind: a.kind, label: a.label };
    if (a.arg !== undefined) {
        out.arg = a.arg;
    }
    if (a.kind === 'card' && a.card) {
        const c = a.card;
        let s = null;
        try {
            s = c.setId && c.setId.number != null ? `${c.setId.set}_${String(c.setId.number).padStart(3, '0')}` : null;
        } catch {
            s = null;
        }
        out.card = { id: c.uuid, n: c.title, s, zone: c.zoneName, ctl: `p${eg.ids.indexOf(c.controller?.id) + 1}` };
    }
    if (a.kind === 'distribute') {
        out.distribute = { amount: a.spec?.amount ?? 0, type: a.spec?.type ?? null, targets: a.targets.length };
    }
    return out;
}

module.exports = { observe, plainAction };
