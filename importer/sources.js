'use strict';

/**
 * Readers for game captures. Each returns { frames: [{t, state}], meta } where state is a full Karabast gamestate.
 *
 * Supported inputs (detected from content, not the file name):
 *   - KaraBuddy replay file, version 1 (raw gamestate per event) or 2 ({full} / {patch} per event)
 *   - KaraBuddy-style bare event list: { events: [{full} | {patch}] } (as in its karabast-sim fixture)
 *   - a JSON array of gamestate objects, or JSON Lines with one gamestate per line
 *   - socket.io frames as saved from browser devtools: lines like 42["gamestate",{...}]
 *   - SWU Forge Battle Log "PersistedTimeline" v2/v3: { v, base, steps: [{timestamp, patch}], chat? }
 *   - importer/capture.js output: JSON Lines {t:"gamestate", view, state}
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isGamestate = (v) => isObj(v) && isObj(v.players) && ('phase' in v || 'winners' in v || 'newMessages' in v);

/** KaraBuddy's path-keyed patch: { "players/<id>/cardPiles/hand": [...] } replaces that value. */
function applyPatch(state, patch) {
    for (const [p, value] of Object.entries(patch)) {
        const parts = p.split('/');
        let obj = state;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!isObj(obj[parts[i]])) {
                obj[parts[i]] = {};
            }
            obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = value;
    }
}

function fromFullPatch(list, pick = (e) => e) {
    const frames = [];
    let cur = null;
    for (const e of list) {
        const arg = pick(e);
        if (!arg) {
            continue;
        }
        if (arg.full) {
            cur = structuredClone(arg.full);
        } else if (arg.patch) {
            if (!cur) {
                throw new Error('patch before any full snapshot');
            }
            applyPatch(cur, arg.patch);
        } else if (isGamestate(arg)) {
            cur = structuredClone(arg);
        } else {
            continue;
        }
        frames.push({ t: e.t ?? null, state: structuredClone(cur) });
    }
    return frames;
}

/**
 * SWU Forge "PersistedTimeline" (v2: base + objectDiff steps; v3 adds chat[{ts, tokens}]), the format of SWU Forge's
 * Battle Log as documented by KaraBuddy's converter. Steps merge objects and replace arrays/scalars. Cards are
 * normalized ({cardId:"SET_NNN", name, isHidden, parentCardId, ...}); this maps them back to Karabast summaries.
 */
function mergePatch(state, patch) {
    for (const [k, v] of Object.entries(patch)) {
        if (isObj(v) && isObj(state[k])) {
            mergePatch(state[k], v);
        } else {
            state[k] = v;
        }
    }
}

function forgeCard(c) {
    if (!isObj(c)) {
        return c;
    }
    if (c.isHidden || (!c.cardId && !c.name)) {
        return { controllerId: c.controllerId ?? null, zone: c.zone ?? null, ...(c.exhausted ? { exhausted: true } : {}) };
    }
    const m = /^([A-Za-z0-9]+)_(\d+)$/.exec(c.cardId ?? '');
    return {
        ...c,
        setId: c.setId ?? (m ? { set: m[1], number: Number(m[2]) } : undefined),
        id: c.karabastId ?? c.id ?? undefined
    };
}

function forgeState(s) {
    const players = {};
    for (const [pid, p] of Object.entries(s.players ?? {})) {
        const piles = {};
        for (const [z, cards] of Object.entries(p.cardPiles ?? {})) {
            piles[z] = Array.isArray(cards) ? cards.map(forgeCard) : cards;
        }
        players[pid] = {
            ...p, cardPiles: piles,
            ...(p.leader ? { leader: forgeCard(p.leader) } : {}),
            ...(Array.isArray(p.leaders) ? { leaders: p.leaders.map(forgeCard) } : {}),
            ...(p.base ? { base: forgeCard(p.base) } : {})
        };
    }
    return { ...s, id: s.gameId ?? s.id, players };
}

/** v3 chat tokens back to Karabast message fragments; players are matched by name, as the tokens carry no id. */
function forgeMessage(entry, idByName) {
    const toks = entry.tokens ?? [];
    if (toks.length === 1 && toks[0]?.kind === 'alert') {
        return { date: entry.ts, message: { alert: { type: 'notification', message: [toks[0].text] } } };
    }
    return {
        date: entry.ts,
        message: toks.map((t) => {
            if (typeof t === 'string') {
                return t;
            }
            if (t?.kind === 'player') {
                return { type: 'player', name: t.name, id: idByName.get(t.name) ?? null };
            }
            if (t?.kind === 'card') {
                const m = /^([A-Za-z0-9]+)_(\d+)$/.exec(t.cardId ?? '');
                return { type: 'card', name: t.name, setId: t.setId ?? (m ? { set: m[1], number: Number(m[2]) } : undefined), controllerId: t.controllerId };
            }
            if (t?.kind === 'alert') {
                return t.text;
            }
            return '';
        })
    };
}

/** Median of (alert time - stamp of the frame where that phase starts), pairing alerts and phase changes in order. */
function chatClockOffset(chat, states, stamps) {
    const alerts = chat
        .map((e) => ({ ts: e.ts, m: /Round:\s*\d+\s*-\s*(?:Additional )?(\w+) Phase/i.exec(e.tokens?.[0]?.text ?? '') }))
        .filter((a) => a.m && a.ts != null)
        .map((a) => ({ ts: a.ts, phase: a.m[1].toLowerCase() }));
    const changes = [];
    for (let i = 1; i < states.length; i++) {
        if (states[i].phase !== states[i - 1].phase && stamps[i] != null) {
            changes.push({ i, phase: states[i].phase });
        }
    }
    const deltas = [];
    let j = 0;
    for (const a of alerts) {
        while (j < changes.length && changes[j].phase !== a.phase) {
            j++;
        }
        if (j < changes.length) {
            deltas.push(a.ts - stamps[changes[j].i]);
            j++;
        }
    }
    if (!deltas.length) {
        return 0;
    }
    deltas.sort((x, y) => x - y);
    return deltas[Math.floor(deltas.length / 2)];
}

function readPersistedTimeline(tl) {
    const frames = [];
    let cur = structuredClone(tl.base);
    const stamps = [tl.baseTimestamp ?? null, ...(tl.steps ?? []).map((st) => st.timestamp ?? null)];
    const states = [structuredClone(cur)];
    for (const st of tl.steps ?? []) {
        mergePatch(cur, st.patch ?? {});
        states.push(structuredClone(cur));
    }
    const idByName = new Map();
    for (const [pid, p] of Object.entries(tl.base?.players ?? {})) {
        if (p?.name) {
            idByName.set(p.name, pid);
        }
    }
    // Chat is one timeline stamped by the server; frames are stamped by the recording browser. Estimate the clock
    // offset from the 'Round: N - <Phase> Phase' alerts, which land in the frame where the phase changes, then give
    // each entry to the first frame stamped at or after it (Karabast sends a line with the push that follows it).
    const chat = [...(tl.chat ?? [])].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    const offset = chatClockOffset(chat, states, stamps);
    let c = 0;
    states.forEach((s, i) => {
        const msgs = [];
        const last = i === states.length - 1;
        while (c < chat.length && (last || (stamps[i] != null && (chat[c].ts ?? 0) - offset <= stamps[i] + 50))) {
            msgs.push(forgeMessage(chat[c++], idByName));
        }
        frames.push({ t: stamps[i], state: { ...forgeState(s), newMessages: msgs } });
    });
    return { frames, meta: { reader: `swuforge-timeline-v${tl.v}`, startedAt: tl.baseCapturedAt ?? null } };
}

function readKaraBuddy(file) {
    const events = file.events ?? [];
    const gs = events.filter((e) => e && (e.event === undefined || e.event === 'gamestate'));
    const pick = (e) => (e.event === 'gamestate' ? e.args?.[0] : e);
    const frames = fromFullPatch(gs, pick);
    return {
        frames,
        meta: {
            reader: file.version ? `karabuddy-v${file.version}` : 'karabuddy-events',
            url: file.url ?? null, startedAt: file.startedAt ?? null, durationMs: file.durationMs ?? null,
            reason: file.reason ?? null, note: file.note ?? null
        }
    };
}

/** Parse one socket.io text frame: 42["gamestate",{...}] (engine.io message 4 + socket.io event 2, optional ack id). */
function parseSocketIoFrame(line) {
    const m = line.match(/^4[23](\d*)(\[.*\])\s*$/s);
    if (!m) {
        return null;
    }
    try {
        const arr = JSON.parse(m[2]);
        return Array.isArray(arr) && typeof arr[0] === 'string' ? { event: arr[0], args: arr.slice(1) } : null;
    } catch {
        return null;
    }
}

function readText(text) {
    const trimmed = text.trim();
    // whole-file JSON first
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const v = JSON.parse(trimmed);
            if (isObj(v) && Array.isArray(v.events)) {
                return readKaraBuddy(v);
            }
            if (isObj(v) && isObj(v.base) && Array.isArray(v.steps)) {
                return readPersistedTimeline(v);
            }
            if (Array.isArray(v) && v.some(isGamestate)) {
                return { frames: v.filter(isGamestate).map((state) => ({ t: null, state })), meta: { reader: 'gamestate-array' } };
            }
            if (isGamestate(v)) {
                return { frames: [{ t: null, state: v }], meta: { reader: 'gamestate' } };
            }
        } catch {
            // not one JSON document; fall through to line formats
        }
    }
    const frames = [];
    const patches = [];
    let reader = null;
    let meta = null;
    for (const raw of text.split('\n')) {
        const line = raw.trim().replace(/^\x1e/, '');
        if (!line) {
            continue;
        }
        let v = null;
        if (line.startsWith('{')) {
            try {
                v = JSON.parse(line);
            } catch {
                continue;
            }
        }
        if (v && v.t === 'capture') {
            meta = v;
        } else if (v && v.t === 'gamestate' && isObj(v.state)) {
            reader = 'capture';
            frames.push({ t: v.ts ?? null, state: v.state, view: v.view ?? null });
        } else if (v && (v.full || v.patch)) {
            reader = 'full-patch-lines';
            patches.push(v);
        } else if (isGamestate(v)) {
            reader ??= 'gamestate-lines';
            frames.push({ t: null, state: v });
        } else {
            for (const part of line.split('\x1e')) {
                const f = parseSocketIoFrame(part);
                if (f?.event === 'gamestate' && isObj(f.args[0])) {
                    reader ??= 'socket.io';
                    frames.push({ t: null, state: f.args[0] });
                }
            }
        }
    }
    if (patches.length) {
        return { frames: fromFullPatch(patches), meta: { reader: 'full-patch-lines' } };
    }
    if (meta) {
        return { frames, meta: { reader, capture: meta } };
    }
    if (!frames.length) {
        throw new Error('no Karabast gamestate frames found');
    }
    return { frames, meta: { reader } };
}

module.exports = { readText, readKaraBuddy, readPersistedTimeline, applyPatch, mergePatch, parseSocketIoFrame, isGamestate };
