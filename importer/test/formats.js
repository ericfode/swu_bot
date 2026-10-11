'use strict';

/**
 * Test-only writers for the capture formats importer/sources.js reads, built from plain Karabast gamestate frames.
 * They follow the formats as documented (KaraBuddy .karareplay v2, SWU Forge PersistedTimeline v3, socket.io text
 * frames); none of their code is copied. Used to check that every reader gives the same replay as the raw frames.
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** KaraBuddy-style patch: '/'-joined paths, objects recursed, arrays and scalars replaced. */
function slashPatch(a, b, prefix = '', out = {}) {
    for (const k of Object.keys(b)) {
        const p = prefix ? `${prefix}/${k}` : k;
        if (JSON.stringify(a?.[k]) === JSON.stringify(b[k])) {
            continue;
        }
        if (isObj(a?.[k]) && isObj(b[k])) {
            slashPatch(a[k], b[k], p, out);
        } else {
            out[p] = b[k];
        }
    }
    return out;
}

function toKaraBuddy(states) {
    return {
        version: 2, url: 'https://karabast.net/GameBoard', startedAt: '2026-10-01T12:00:00.000Z', durationMs: states.length * 1000,
        events: states.map((s, i) => ({ t: i * 1000, dir: 'in', event: 'gamestate', args: [i === 0 ? { full: s } : { patch: slashPatch(states[i - 1], s) }] }))
    };
}

/** SWU Forge objectDiff: nested objects of changed keys. */
function objectDiff(a, b) {
    const out = {};
    for (const k of Object.keys(b)) {
        if (!(k in a)) {
            out[k] = b[k];
        } else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
            if (isObj(a[k]) && isObj(b[k])) {
                const sub = objectDiff(a[k], b[k]);
                if (Object.keys(sub).length) {
                    out[k] = sub;
                }
            } else {
                out[k] = b[k];
            }
        }
    }
    return out;
}

const cardId = (setId) => (setId?.set && setId.number != null ? `${setId.set}_${String(setId.number).padStart(3, '0')}` : null);

function normCard(c) {
    const hidden = !c?.setId && !c?.id && !c?.name;
    return {
        uuid: c?.uuid ?? null, cardId: hidden ? null : cardId(c.setId), karabastId: hidden ? null : c.id ?? null, name: hidden ? null : c.name ?? null,
        type: c?.type ?? null, printedType: c?.printedType ?? null, power: c?.power ?? null, hp: c?.hp ?? null, damage: c?.damage ?? 0,
        exhausted: !!c?.exhausted, isHidden: hidden, sentinel: !!c?.sentinel, parentCardId: c?.parentCardId ?? null
    };
}

function normState(s) {
    const players = {};
    for (const [pid, p] of Object.entries(s.players)) {
        const piles = {};
        for (const z of ['hand', 'resources', 'groundArena', 'spaceArena', 'discard', 'outsideTheGame', 'capturedZone']) {
            piles[z] = (p.cardPiles?.[z] ?? []).map(normCard);
        }
        const leader = p.leaders?.[0] ?? p.leader;
        players[pid] = {
            id: pid, name: p.name, hasInitiative: !!p.hasInitiative, availableResources: p.availableResources ?? 0, numCardsInDeck: p.numCardsInDeck ?? 0,
            isActionPhaseActivePlayer: !!p.isActionPhaseActivePlayer, leader: leader ? normCard(leader) : null, base: p.base ? normCard(p.base) : null, cardPiles: piles
        };
    }
    return { gameId: s.id ?? null, phase: s.phase ?? null, winners: s.winners ?? [], players };
}

function chatEntry(m) {
    const msg = m.message;
    const ts = Date.parse(m.date);
    if (isObj(msg) && msg.alert) {
        return { ts, tokens: [{ kind: 'alert', text: (msg.alert.message ?? []).map((x) => (typeof x === 'string' ? x : x.name ?? '')).join('') }] };
    }
    return {
        ts,
        tokens: msg.map((x) => (typeof x === 'string' ? x : x.type === 'player'
            ? { kind: 'player', name: x.name, uuid: x.uuid ?? null }
            : { kind: 'card', name: x.name, cardId: cardId(x.setId), setId: x.setId ?? null, controllerId: x.controllerId ?? null }))
    };
}

/** stamps[i]: the recording browser's time for frame i (ms); message dates keep the server clock. */
function toTimeline(states, stamps) {
    const normed = states.map(normState);
    return {
        v: 3, base: normed[0], baseCapturedAt: new Date(stamps[0]).toISOString(), baseTimestamp: stamps[0],
        steps: normed.slice(1).map((s, i) => ({ capturedAt: null, timestamp: stamps[i + 1], patch: objectDiff(normed[i], s) })),
        chat: states.flatMap((s) => (s.newMessages ?? []).map(chatEntry))
    };
}

/** What a devtools WebSocket frame export looks like: one engine.io/socket.io text frame per line. */
const toSocketIo = (states) => states.map((s) => `42${JSON.stringify(['gamestate', s])}`).join('\n') + '\n';

module.exports = { toKaraBuddy, toTimeline, toSocketIo, slashPatch, objectDiff };
