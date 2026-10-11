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
 * Without the log length (SWU Forge, KaraBuddy without keys) a mulligan does not change the key, so a run of equal
 * keys that lost or repeated a frame stays hidden unless B shows the same cards all through it (dropUnsureRuns).
 */

const { leadersOf, isHidden: isHiddenCard } = require('./karabast');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// how far ahead in B a frame may pair with the next copy of its board; further ahead the board must appear only once
// (one run), so an undo that returns to an old board does not pair with it
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

/** Index ranges [start, end] of the runs of equal keys in xs. */
function runs(xs) {
    const out = [];
    xs.forEach((k, i) => {
        if (i > 0 && xs[i - 1] === k) {
            out[out.length - 1][1] = i;
        } else {
            out.push([i, i]);
        }
    });
    return out;
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
            const later = (pos.get(k) ?? []).filter((j) => j > last);
            // past the window (a late start, a long gap) re-anchor only on a key that sits in one run of b,
            // so a board that comes back later cannot pull the pairing ahead
            if (later.length && (later[0] <= last + WINDOW || later[later.length - 1] - later[0] === later.length - 1)) {
                m = later[0];
            }
        }
        out.push(m);
        if (m >= 0) {
            last = m;
        }
    }
    return out;
}

/**
 * Without the log a run of equal keys can hide a private change of B's: a mulligan swaps hand cards with the deck and
 * changes nothing public. A run of A's frames keeps its partners (match, by index into b) only when it pairs one to one
 * with B's run, or when B's run shows one hand throughout and no card of B's leaves sight (into the deck) at its edges.
 */
function dropUnsureRuns(match, keysA, keysB, b, seat) {
    const own = (j) => {
        const piles = b[j].state.players[seat]?.cardPiles ?? {};
        return [...(piles.hand ?? []), ...(piles.resources ?? [])].map((c) => c?.uuid ?? null);
    };
    const stays = (from, to) => {
        if (from < 0 || to >= b.length) {
            return true;
        }
        const seen = new Set(Object.values(b[to].state.players).flatMap((p) => Object.values(p?.cardPiles ?? {}).flat().map((c) => c?.uuid)));
        return own(from).every((u) => u == null || seen.has(u));
    };
    const runEnd = new Map(runs(keysB));
    for (const [s, e] of runs(keysA)) {
        const j = match[s];
        const end = runEnd.get(j);
        const oneHand = () => b.slice(j, end + 1).every((_, k) => String(own(j + k)) === String(own(j)));
        if (end === undefined || !(end - j === e - s || (oneHand() && stays(j - 1, j) && stays(end, end + 1)))) {
            match.fill(-1, s, e + 1);
        }
    }
}

/**
 * a, b: [{t, state}] from importer/sources.js readText, one per seat. Returns { frames, seats: {a, b}, matched, unmatched }.
 */
function mergeCaptures(a, b) {
    // as in readFrames: a serialization-failure push has players {} and must not pair
    const twoPlayers = (f) => isObj(f?.state?.players) && Object.keys(f.state.players).length >= 2;
    a = a.filter(twoPlayers);
    b = b.filter(twoPlayers);
    const seatA = ownSeat(a);
    const seatB = ownSeat(b);
    if (!seatA || !seatB) {
        throw new Error('both captures must be a player\'s view (a spectator capture has no hand to add)');
    }
    if (seatA === seatB) {
        throw new Error('both captures show the same hand; need one capture from each player');
    }
    const withLog = [...a, ...b].every((f) => typeof f.state.totalMessages === 'number');
    const keysA = a.map((f) => publicKey(f.state, withLog));
    const keysB = b.map((f) => publicKey(f.state, withLog));
    const match = align(keysA, keysB);
    if (!withLog) {
        dropUnsureRuns(match, keysA, keysB, b, seatB);
    }
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
