'use strict';

/**
 * Merge two one-seat captures of the same game into one capture that has both hands.
 *
 * When both players record (both run KaraBuddy, Kara Tracker or a socket dump), each file has its own hand and
 * resources and stubs for the other's. Karabast sends both players the same push after every change, so the frames
 * pair up: frame i of capture A is matched with the frame of capture B that shows the same public board (and the same
 * log length, when both files keep it). The merged frame is A's frame with B's seat hand and resources taken from B.
 * Only deck order stays unknown.
 *
 * Frames of A with no partner in B (a dropped frame, a reconnect) keep B's seat hidden; the result counts them.
 */

const { leadersOf } = require('./karabast');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isHiddenCard = (c) => !c || (c.name == null && c.setId == null && c.id == null);
// how far ahead in B to look for a frame's partner; keeps an undo that returns to an old board from pairing with it
const WINDOW = 200;

const pub = (c) => (c ? [c.uuid ?? null, c.damage ?? 0, !!c.exhausted, c.parentCardId ?? null] : null);

/** What both players see at one moment: the board, hand and resource counts, deck sizes, phase and log length. */
function publicKey(gs, withLog) {
    const players = Object.keys(gs.players).sort().map((id) => {
        const p = gs.players[id] ?? {};
        const piles = p.cardPiles ?? {};
        return [
            id, p.base?.damage ?? 0, leadersOf(p).map(pub),
            (piles.groundArena ?? []).map(pub), (piles.spaceArena ?? []).map(pub), (piles.discard ?? []).map((c) => c?.uuid ?? null),
            (piles.hand ?? []).length, (piles.resources ?? []).length, p.numCardsInDeck ?? null, p.availableResources ?? null, !!p.hasInitiative
        ];
    });
    return JSON.stringify([gs.phase ?? null, gs.winners ?? [], withLog ? gs.totalMessages ?? null : null, players]);
}

/** The player id whose hand this capture shows (null for a spectator). */
function ownSeat(frames) {
    const seen = new Map();
    for (const f of frames) {
        for (const [id, p] of Object.entries(f.state.players ?? {})) {
            if ((p?.cardPiles?.hand ?? []).some((c) => !isHiddenCard(c))) {
                seen.set(id, (seen.get(id) ?? 0) + 1);
            }
        }
    }
    const ids = [...seen.keys()];
    if (ids.length > 1) {
        throw new Error('a capture that already shows both hands needs no merge');
    }
    return ids[0] ?? null;
}

/** For every key of a, the index of its partner in b (or -1), in order. */
function align(a, b) {
    const pos = new Map();
    b.forEach((k, j) => (pos.has(k) ? pos.get(k).push(j) : pos.set(k, [j])));
    const out = [];
    let last = -1;
    for (const k of a) {
        let m = -1;
        if (b[last + 1] === k) {
            m = last + 1;
        } else if (last >= 0 && b[last] === k) {
            m = last;
        } else {
            m = (pos.get(k) ?? []).find((j) => j > last && j <= last + WINDOW) ?? -1;
        }
        out.push(m);
        if (m >= 0) {
            last = m;
        }
    }
    return out;
}

/**
 * a, b: [{t, state}] from importer/sources.js readText, one per seat. Returns { frames, seats: {a, b}, matched, unmatched }.
 */
function mergeCaptures(a, b) {
    a = a.filter((f) => isObj(f?.state?.players));
    b = b.filter((f) => isObj(f?.state?.players));
    const seatA = ownSeat(a);
    const seatB = ownSeat(b);
    if (!seatA || !seatB) {
        throw new Error('both captures must be a player\'s view (a spectator capture has no hand to add)');
    }
    if (seatA === seatB) {
        throw new Error('both captures show the same hand; need one capture from each player');
    }
    const withLog = [...a, ...b].every((f) => typeof f.state.totalMessages === 'number');
    const match = align(a.map((f) => publicKey(f.state, withLog)), b.map((f) => publicKey(f.state, withLog)));
    let unmatched = 0;
    const frames = a.map((f, i) => {
        const j = match[i];
        if (j < 0) {
            unmatched++;
            return f;
        }
        const state = structuredClone(f.state);
        const mine = b[j].state.players[seatB]?.cardPiles ?? {};
        const piles = state.players[seatB].cardPiles ?? (state.players[seatB].cardPiles = {});
        piles.hand = structuredClone(mine.hand ?? []);
        piles.resources = structuredClone(mine.resources ?? []);
        return { ...f, state };
    });
    return { frames, seats: { a: seatA, b: seatB }, matched: a.length - unmatched, unmatched };
}

module.exports = { mergeCaptures, publicKey, align };
