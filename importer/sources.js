'use strict';

/**
 * Readers for game captures. Each returns { frames: [{t, state}], meta } where state is a full Karabast gamestate.
 *
 * Supported inputs (detected from content, not the file name):
 *   - KaraBuddy replay file, version 1 (raw gamestate per event) or 2 ({full} / {patch} per event)
 *   - KaraBuddy-style bare event list: { events: [{full} | {patch}] } (as in its karabast-sim fixture)
 *   - a JSON array of gamestate objects, or JSON Lines with one gamestate per line
 *   - socket.io frames as saved from browser devtools: lines like 42["gamestate",{...}], or a devtools HAR export
 *   - SWU Forge Battle Log "PersistedTimeline" v2/v3: { v, base, steps: [{timestamp, patch}], chat? }
 *   - importer/capture.js output: JSON Lines {t:"gamestate", view, state}
 *
 * SWU-PGN game files (.swupgn) are not frame captures: importer/import.js sends them to importer/swupgn.js, and
 * readText() refuses them with a pointer there.
 */

const { isSwuPgn } = require('./swupgn');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isGamestate = (v) => isObj(v) && isObj(v.players) && ('phase' in v || 'winners' in v || 'newMessages' in v);

// Patches come from files other people published; a key like __proto__ would write into Object.prototype.
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const checkKey = (k) => {
    if (UNSAFE_KEYS.has(k)) {
        throw new Error(`unsafe key in patch: ${k}`);
    }
};

/** KaraBuddy's path-keyed patch: { "players/<id>/cardPiles/hand": [...] } replaces that value. */
function applyPatch(state, patch) {
    for (const [p, value] of Object.entries(patch)) {
        const parts = p.split('/');
        parts.forEach(checkKey);
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
        const state = structuredClone(cur);
        // KaraBuddy strips totalMessages/messageOffset from the state but keeps totalMessages as the event's `key`.
        // Restoring them lets readFrames tell a repeated log line from an unchanged (patched-over) newMessages.
        if (Number.isFinite(e.key) && typeof state.totalMessages !== 'number') {
            state.totalMessages = e.key;
            state.messageOffset = e.key - (Array.isArray(state.newMessages) ? state.newMessages.length : 0);
        }
        frames.push({ t: e.t ?? null, state });
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
        checkKey(k);
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

/**
 * Forge cards keep neither zone nor onStartingSide. A leader's type changes when it deploys ('leader' ->
 * 'nonTokenLeaderUnit', or 'leaderUpgrade' for a pilot), and a double-sided leader shows its other title once flipped
 * (Chancellor Palpatine -> Darth Sidious), so rebuild both from those: the arena once deployed, else the base.
 */
function forgeLeader(c, piles, startTitle) {
    const out = forgeCard(c);
    if (isObj(out) && out.zone == null && out.onStartingSide == null && out.type) {
        const arena = ['groundArena', 'spaceArena'].find((z) => out.uuid != null && (piles[z] ?? []).some((x) => x?.uuid === out.uuid));
        out.zone = out.type === 'leader' ? 'base' : arena ?? 'groundArena';
        if (startTitle.has(out.uuid) && startTitle.get(out.uuid) !== out.name) {
            out.onStartingSide = false;
        }
    }
    return out;
}

/** Leader uuid -> title in a state (the timeline's base: the side every leader starts on). */
function leaderTitles(s) {
    const out = new Map();
    for (const p of Object.values(s?.players ?? {})) {
        for (const l of [p?.leader, ...(Array.isArray(p?.leaders) ? p.leaders : [])]) {
            if (l?.uuid != null && l.name) {
                out.set(l.uuid, l.name);
            }
        }
    }
    return out;
}

function forgeState(s, startTitle) {
    const players = {};
    for (const [pid, p] of Object.entries(s.players ?? {})) {
        const piles = {};
        for (const [z, cards] of Object.entries(p.cardPiles ?? {})) {
            piles[z] = Array.isArray(cards) ? cards.map(forgeCard) : cards;
        }
        players[pid] = {
            ...p, cardPiles: piles,
            ...(p.leader ? { leader: forgeLeader(p.leader, piles, startTitle) } : {}),
            ...(Array.isArray(p.leaders) ? { leaders: p.leaders.map((l) => forgeLeader(l, piles, startTitle)) } : {}),
            ...(p.base ? { base: forgeCard(p.base) } : {})
        };
    }
    return { ...s, id: s.gameId ?? s.id, players };
}

/**
 * Karabast player chat is [{type:'playerChat', name, id}, ' text']. Forge tokens have no chat kind, so writers turn the
 * speaker into a card token with no card id (KaraBuddy's converter), or could make it a player token without the uuid
 * every real player token has (only trusted when the timeline's other player tokens carry uuids).
 */
const isChatSpeaker = (t, playerUuids) => (t?.kind === 'card' && !t.cardId && !t.setId) || (t?.kind === 'player' && t.uuid == null && playerUuids);

/**
 * v3 chat tokens back to Karabast message fragments; players are matched by name, as the tokens carry no id. A chat
 * line becomes a bare playerChat marker, so the converter counts and drops it without ever seeing its text or speaker.
 */
function forgeMessage(entry, idByName, playerUuids) {
    const toks = entry.tokens ?? [];
    if (toks.length === 1 && toks[0]?.kind === 'alert') {
        return { date: entry.ts, message: { alert: { type: 'notification', message: [toks[0].text] } } };
    }
    if (isChatSpeaker(toks[0], playerUuids)) {
        return { date: entry.ts, message: [{ type: 'playerChat' }] };
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

// ms of push-latency variation allowed when matching server-stamped chat to browser-stamped frames
const LATENCY_SLACK = 1000;
// alerts the engine itself raises that the converter reads (Phase.ts round alerts, Game.ts timeout)
const GAME_ALERT = /^Round:\s*\d+\s*-|^Game ended due to .* timing out/;

/**
 * Offset between the chat clock and the frame stamps, from (alert time - stamp of a frame where that phase starts).
 * Every alert is paired with every change to its phase, so an alert with no phase change of its own (an undo across a
 * phase boundary, a rollback to the start of a phase) only adds scattered values instead of shifting every later pair.
 * The densest 2 * LATENCY_SLACK window gives a rough offset; each alert's value nearest to it then gives the offset
 * (median) and `early`, how much sooner than that the fastest of those pushes arrived: the slack an alert needs to stay
 * in its frame.
 */
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
    const pairs = alerts.map((a) => changes.filter((ch) => ch.phase === a.phase).map((ch) => a.ts - stamps[ch.i]));
    const deltas = pairs.flat().sort((x, y) => x - y);
    if (!deltas.length) {
        return { offset: 0, early: 0 };
    }
    let best = { from: 0, to: 0 };
    for (let from = 0, to = 0; to < deltas.length; to++) {
        while (deltas[to] - deltas[from] > 2 * LATENCY_SLACK) {
            from++;
        }
        if (to + 1 - from > best.to - best.from) {
            best = { from, to: to + 1 };
        }
    }
    const rough = deltas[(best.from + best.to) >> 1];
    const near = pairs
        .map((ds) => ds.reduce((m, d) => (Math.abs(d - rough) < Math.abs(m - rough) ? d : m), Infinity))
        .filter((d) => Math.abs(d - rough) <= LATENCY_SLACK)
        .sort((x, y) => x - y);
    const offset = near[near.length >> 1];
    return { offset, early: near[near.length - 1] - offset };
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
    // each entry to the first frame stamped at or after it (Karabast sends a line with the push that follows it). The
    // slack for latency is half the gap to the next frame, but at least what the alerts showed: an alert goes out in
    // its own push (GameChat.addAlert), and the push that ends the input follows within milliseconds.
    const chat = [...(tl.chat ?? [])].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    const { offset, early } = chatClockOffset(chat, states, stamps);
    const startTitle = leaderTitles(tl.base);
    const playerUuids = chat.some((e) => e.tokens?.some((t) => t?.kind === 'player' && t.uuid != null));
    let c = 0;
    states.forEach((s, i) => {
        const msgs = [];
        if (stamps[i] != null) {
            const slack = Math.min(LATENCY_SLACK, Math.max(early, stamps[i + 1] != null ? (stamps[i + 1] - stamps[i]) / 2 : Infinity));
            while (c < chat.length && (chat[c].ts ?? 0) - offset <= stamps[i] + slack) {
                msgs.push(forgeMessage(chat[c++], idByName, playerUuids));
            }
        }
        if (i === states.length - 1) {
            // later entries came with pushes the capture does not have (chat, a rematch request, a player leaving the
            // lobby); keep only the game's own alerts that say how it ended or where a round starts
            for (; c < chat.length; c++) {
                const t = chat[c].tokens;
                if (t?.length === 1 && t[0]?.kind === 'alert' && GAME_ALERT.test(t[0].text ?? '')) {
                    msgs.push(forgeMessage(chat[c], idByName, playerUuids));
                }
            }
        }
        frames.push({ t: stamps[i], state: { ...forgeState(s, startTitle), newMessages: msgs } });
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
            reason: file.reason ?? null, note: file.note ?? null,
            decks: isObj(file.decks) ? file.decks : null
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

/** The gamestate objects in one socket.io text message (engine.io may pack several, separated by \x1e). */
const socketIoStates = (text) => text.split('\x1e').map(parseSocketIoFrame).filter((f) => f?.event === 'gamestate' && isObj(f.args[0])).map((f) => f.args[0]);

/** A browser devtools HAR export keeps WebSocket frames as entries[]._webSocketMessages[{type, time (s), data}]. */
function readHar(har) {
    const frames = [];
    for (const e of har.log.entries) {
        for (const m of Array.isArray(e?._webSocketMessages) ? e._webSocketMessages : []) {
            for (const state of typeof m?.data === 'string' ? socketIoStates(m.data) : []) {
                frames.push({ t: Number.isFinite(m.time) ? Math.round(m.time * 1000) : null, state });
            }
        }
    }
    return frames.length ? { frames, meta: { reader: 'har' } } : null;
}

function readText(text) {
    if (isSwuPgn(text)) {
        throw new Error('SWU-PGN game file, not a Karabast capture: import it on its own (importer/swupgn.js); it already holds both hands');
    }
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
            if (isObj(v?.log) && Array.isArray(v.log.entries)) {
                const har = readHar(v);
                if (har) {
                    return har;
                }
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
            for (const state of socketIoStates(line)) {
                reader ??= 'socket.io';
                frames.push({ t: null, state });
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
