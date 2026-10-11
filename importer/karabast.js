'use strict';

/**
 * Karabast game-state frames -> swu_bot replay events (spec/replay-format.md, format v1 plus optional fields).
 *
 * Karabast (the forceteki server) pushes a `gamestate` object to every player and spectator after each change:
 * Game.getState(viewerId) = { players: { <playerId>: Player.getStateSummary(viewer) }, phase, newMessages, winners, ... }.
 * A viewer sees its own hand and resources; the other hand is a list of stubs { controllerId, ownerId, zone }.
 * Capture tools (KaraBuddy, a saved socket log, importer/capture.js) store a sequence of these objects.
 *
 * Pure: no engine and no card data. Seats: p1 is the player holding the initiative when the game starts (the first
 * player), unless `seats` names them.
 */

const HIDDEN = Object.freeze({ n: 'Hidden card', s: null, hid: 1 });
const ARENAS = ['groundArena', 'spaceArena'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function setCode(setId) {
    return setId && setId.set && setId.number != null ? `${setId.set}_${String(setId.number).padStart(3, '0')}` : null;
}

/**
 * A card summary the viewer could not see (opponent hand, face-down resource): no name, no set, no id. KaraBuddy's
 * player can swap these for a 'REPLAYHIDDEN' placeholder card, which counts as hidden too.
 */
const isHidden = (c) => !c || (c.name == null && c.setId == null && c.id == null) || c.setId?.set === 'REPLAYHIDDEN' || /^REPLAYHIDDEN/.test(c.id ?? '');
const cardRef = (c) => (isHidden(c) ? { ...HIDDEN } : { n: c.name, s: setCode(c.setId) });

// forceteki CardType values; older Karabast builds used other spellings, so match loosely
const isUpgradeType = (t) => /upgrade/i.test(t ?? '');
const isUnitType = (t) => /unit$/i.test(t ?? '') && !isUpgradeType(t);
const isTokenType = (t) => /^token/i.test(t ?? '');

/** players[pid].leaders (since 2026-09-29, twin leaders) or players[pid].leader (before). */
function leadersOf(p) {
    if (Array.isArray(p?.leaders) && p.leaders.some(Boolean)) {
        return p.leaders.filter(Boolean);
    }
    return p?.leader ? [p.leader] : [];
}

function unitRef(c, upgradesByHost) {
    const out = { ...cardRef(c), p: c.power ?? 0, h: c.hp ?? 0, d: c.damage ?? 0 };
    if (c.exhausted) {
        out.x = 1;
    }
    if (c.sentinel) {
        out.sn = 1;
    }
    const ups = upgradesByHost.get(c.uuid) ?? [];
    if (ups.length) {
        out.u = ups.map((u) => ({ ...cardRef(u), t: isTokenType(u.type) ? 1 : 0 }));
    }
    return out;
}

/** Upgrades in play keyed by host uuid. An upgrade sits in its controller's arena list, which may not be the host's. */
function upgradesByHost(gs) {
    const map = new Map();
    for (const p of Object.values(gs.players ?? {})) {
        for (const zone of ARENAS) {
            for (const c of p?.cardPiles?.[zone] ?? []) {
                if (c?.parentCardId != null && (isUpgradeType(c.type) || !isUnitType(c.type))) {
                    if (!map.has(c.parentCardId)) {
                        map.set(c.parentCardId, []);
                    }
                    map.get(c.parentCardId).push(c);
                }
            }
        }
    }
    return map;
}

function playerSnapshot(p, seat, ups) {
    const piles = p.cardPiles ?? {};
    const leader = leadersOf(p)[0] ?? null;
    const units = (zone) => (piles[zone] ?? []).filter((c) => c && isUnitType(c.type) && c.parentCardId == null).map((c) => unitRef(c, ups));
    const base = p.base ?? {};
    return {
        name: seat,
        base: { ...cardRef(base), hp: base.hp ?? 0, d: base.damage ?? 0 },
        leader: leader
            ? { ...cardRef(leader), dep: leader.onStartingSide === false || (leader.zone && leader.zone !== 'base') ? 1 : 0, x: leader.exhausted ? 1 : 0 }
            : null,
        res: { ready: p.availableResources ?? 0, total: (piles.resources ?? []).length },
        hand: (piles.hand ?? []).map(cardRef),
        deck: p.numCardsInDeck ?? 0,
        discard: (piles.discard ?? []).map(cardRef),
        ground: units('groundArena'),
        space: units('spaceArena')
    };
}

/**
 * Flatten a chat message (string, fragment array or { alert }) into parts: strings, {player: seat} and {card: name}.
 * Karabast formats each line on the server as an array of strings and short summaries of players and cards.
 * `scrub` rewrites plain text, where a username can sit inside a string (lobby alerts, flattened SWU Forge alerts,
 * card effects that print a player's name).
 */
function messageParts(msg, seatOf, scrub = (s) => s) {
    const m = isObj(msg) && 'message' in msg && !('alert' in msg) ? msg.message : msg;
    const body = isObj(m) && m.alert ? m.alert.message : m;
    const out = [];
    const walk = (x) => {
        if (x == null) {
            return;
        }
        if (Array.isArray(x)) {
            x.forEach(walk);
        } else if (isObj(x)) {
            if (x.type === 'player' || x.type === 'playerChat' || (x.id != null && seatOf.has(x.id) && !x.setId)) {
                out.push({ player: seatOf.get(x.id) ?? 'a player' });
            } else if ('name' in x) {
                // a real card has a set id; a name without one may be a person (a spectator summary, an odd token)
                out.push({ card: x.setId ? String(x.name) : scrub(String(x.name)), owner: seatOf.get(x.controllerId) ?? null });
            } else if ('message' in x) {
                walk(x.message);
            } else if ('format' in x) {
                out.push(scrub(String(x.format)));
            }
        } else {
            out.push(scrub(String(x)));
        }
    };
    walk(body);
    return out;
}

const partText = (x) => (typeof x === 'string' ? x : x.player ?? x.card ?? '');

/**
 * Every name a capture shows (players, their accounts, spectators, and `extra` from the caller, such as KaraBuddy's
 * lobby usernames) -> a function replacing each whole-word match in a string with the seat, or 'a spectator'.
 */
function nameScrubber(frames, seatOf, extra = []) {
    const as = new Map();
    const add = (name, label) => {
        if (typeof name === 'string' && name.trim() && !as.has(name)) {
            as.set(name, label);
        }
    };
    for (const f of frames) {
        for (const [id, p] of Object.entries(f.state.players)) {
            add(p?.name, seatOf.get(id) ?? 'a player');
            add(p?.user?.username, seatOf.get(id) ?? 'a player');
        }
    }
    for (const f of frames) {
        const sp = f.state.spectators;
        for (const s of Array.isArray(sp) ? sp : isObj(sp) ? Object.values(sp) : []) {
            add(isObj(s) ? s.name ?? s.username : s, 'a spectator');
        }
    }
    for (const x of extra) {
        add(x.name, x.seat ?? 'a player');
    }
    if (!as.size) {
        return (s) => s;
    }
    // one pass, longest first, so 'bob' inside 'bobby' and a seat-like name swapped with another are not rewritten twice
    const alts = [...as.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts.join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
    return (s) => s.replace(re, (n) => as.get(n));
}

/** One chat line: its text (players shown as seats), the seat it starts with, and its parts. */
function parseMessage(msg, seatOf, scrub) {
    const parts = messageParts(msg, seatOf, scrub);
    const text = parts.map(partText).join('').replace(/\s+/g, ' ').trim();
    const seat = parts[0]?.player && parts[0].player !== 'a player' ? parts[0].player : null;
    return { text, seat, parts };
}

/** Kept for callers that only want text. */
const messageText = (msg, seatOf, scrub) => parseMessage(msg, seatOf, scrub).text;

const isPlayerChat = (msg) => {
    const m = isObj(msg) && 'message' in msg ? msg.message : msg;
    return Array.isArray(m) && isObj(m[0]) && m[0].type === 'playerChat';
};

const TOP = { prompt: 'actionWindow|-', title: 'Choose an action' };

/** Lines that start with a player but are no decision: clock warnings, undo requests and replies, connections. */
const META = /^(has \d+ seconds of main time remaining|has requested to undo|has denied the undo request|has rolled back to|could not pay the cost for|has (dis|re)connected|has failed to connect|wants to continue)/;
const isMetaLine = (line) => META.test(line.parts.slice(1).map(partText).join('').trim());

/**
 * Map a log line to recorder-style decisions so tools written for bot replays (the viewer kit's action classes, the
 * LLM log window) read it the same way. A bot replay records each click: an attack is the attacker, then the target
 * ("Choose a target for attack"); a deploy is the leader, then "Deploy <leader>". Returns 1-2 decisions, or null for
 * lines that are not a player's decision (damage, draws, other effects).
 */
function decisionsFromLine(line, baseNameOf) {
    if (!line.seat) {
        return null;
    }
    const after = line.parts.slice(1);
    const verb = (typeof after[0] === 'string' ? after[0] : '').trim();
    const cards = after.filter((x) => x.card);
    const textAfter = (i) => after.slice(i).map(partText).join('');
    let m;
    if (/^passes\b/.test(verb)) {
        return [{ ...TOP, action: { kind: 'button', label: 'Pass' } }];
    }
    if (/^claims (the )?initiative/i.test(verb)) {
        return [{ ...TOP, action: { kind: 'button', label: 'Claim Initiative' } }];
    }
    if ((m = verb.match(/^has resourced (\d+) cards? from hand/))) {
        return [{ prompt: 'resource|-', title: 'Select cards to resource', action: { kind: 'button', label: `Resource ${m[1]}` } }];
    }
    if (/^has not resourced any cards/.test(verb)) {
        return [{ prompt: 'resource|-', title: 'Select cards to resource', action: { kind: 'button', label: 'Done' } }];
    }
    if ((m = verb.match(/^will (mulligan|keep their hand)/))) {
        return [{ prompt: 'mulligan|-', title: 'Mulligan', action: { kind: 'button', label: m[1] === 'mulligan' ? 'Mulligan' : 'Keep' } }];
    }
    if (/^attacks$/.test(verb)) {
        // [player, ' attacks ', <target card | player "'s base">, ' with ', <attacker>]
        const target = after[1];
        const withAt = after.findIndex((x, i) => i > 1 && typeof x === 'string' && /\bwith\s*$/.test(x));
        const attacker = withAt >= 0 ? after[withAt + 1] : null;
        if (!attacker?.card) {
            return null;
        }
        const targetName = target?.player ? baseNameOf(target.player) : target?.card ?? null;
        return [
            { ...TOP, action: { kind: 'card', label: attacker.card } },
            ...(targetName ? [{ prompt: '-|single', title: 'Choose a target for attack', action: { kind: 'card', label: targetName } }] : [])
        ];
    }
    if (/^plays$/.test(verb) && cards[0]) {
        const attachAt = after.findIndex((x) => typeof x === 'string' && /attaching it to\s*$/.test(x));
        const host = attachAt >= 0 ? after[attachAt + 1]?.card : null;
        return [
            { ...TOP, action: { kind: 'card', label: cards[0].card } },
            ...(host ? [{ prompt: '-|single', title: `Attach ${cards[0].card} to a unit`, action: { kind: 'card', label: host } }] : [])
        ];
    }
    if (/^uses$/.test(verb) && cards[0]) {
        if (/\bto deploy\b/.test(textAfter(2))) {
            return [
                { ...TOP, action: { kind: 'card', label: cards[0].card } },
                { prompt: '-|-', title: 'Choose an ability', action: { kind: 'button', label: `Deploy ${cards[0].card}` } }
            ];
        }
        // An action ability logs its cost (', exhausting X', ', paying N resources'). Without one it is a triggered
        // ability (When Played, On Attack, ...): a choice inside an action, not a new one.
        if (/^(?:'s gained ability from [^,]*)?,/.test(textAfter(2))) {
            return [{ ...TOP, action: { kind: 'card', label: cards[0].card } }];
        }
        return [{ prompt: '-|-', title: 'Resolve an ability', action: { kind: 'card', label: cards[0].card } }];
    }
    return null;
}

/** Pick seats: explicit, else the player with the initiative in the first frame where one has it, else key order. */
function assignSeats(frames, seats) {
    const ids = [];
    for (const f of frames) {
        for (const id of Object.keys(f.state?.players ?? {})) {
            if (!ids.includes(id)) {
                ids.push(id);
            }
        }
    }
    if (seats?.p1 && seats?.p2) {
        return { p1: seats.p1, p2: seats.p2 };
    }
    for (const f of frames) {
        const holder = Object.entries(f.state?.players ?? {}).find(([, p]) => p?.hasInitiative)?.[0];
        if (holder) {
            return { p1: holder, p2: ids.find((id) => id !== holder) ?? null };
        }
    }
    return { p1: ids[0] ?? null, p2: ids[1] ?? null };
}

/** Whose view a frame shows: the one seat whose hand has visible cards, 'both', or null (no cards in hand yet). */
function frameView(gs, seatIds) {
    const vis = [];
    for (const [seat, id] of Object.entries(seatIds)) {
        const hand = gs.players?.[id]?.cardPiles?.hand ?? [];
        if (hand.some((c) => !isHidden(c))) {
            vis.push(seat);
        }
    }
    return vis.length === 2 ? 'both' : vis[0] ?? null;
}

function compactSnapshot(gs, seatIds, round) {
    const ups = upgradesByHost(gs);
    const players = {};
    for (const [seat, id] of Object.entries(seatIds)) {
        players[seat] = playerSnapshot(gs.players?.[id] ?? {}, seat, ups);
    }
    const init = Object.entries(seatIds).find(([, id]) => gs.players?.[id]?.hasInitiative)?.[0] ?? null;
    return { round, phase: gs.phase ?? null, initiative: init, players };
}

const isGameFrame = (f) => isObj(f?.state) && isObj(f.state.players) && Object.keys(f.state.players).length >= 2;

/**
 * Split a capture into games. A rematch or the next game of a best-of-three is a new Game on the same socket, so a
 * socket dump or a JSON-lines file can hold several: a new game starts where the game id changes, where the chat log
 * starts over (each Game has its own), or where a finished game is followed by a setup phase.
 */
function splitGames(frames) {
    const games = [[]];
    let prev = null;
    for (const f of frames) {
        if (isGameFrame(f)) {
            const gs = f.state;
            const fresh = prev && (
                (gs.id != null && prev.id != null && gs.id !== prev.id) ||
                (typeof gs.totalMessages === 'number' && typeof prev.totalMessages === 'number' && gs.totalMessages < prev.totalMessages) ||
                (prev.winners?.length > 0 && !gs.winners?.length && gs.phase === 'setup'));
            if (fresh) {
                games.push([]);
            }
            prev = gs;
        }
        games[games.length - 1].push(f);
    }
    return games;
}

/**
 * Walk the frames once: per frame, the compact snapshot, the new log lines and the action-phase player.
 * Shared by convertFrames and importer/verify.js. One game: see splitGames for captures holding several.
 *
 * Usernames are replaced in log text by seats ('a spectator' for spectators); opts.hideNames adds names to replace,
 * as [{name, seat?}], and opts.decks (KaraBuddy's lobby lists, keyed by player id) adds their usernames.
 */
function readFrames(frames, opts = {}) {
    frames = frames.filter(isGameFrame);
    if (!frames.length) {
        throw new Error('no game-state frames with two players');
    }
    const seatIds = assignSeats(frames, opts.seats);
    const seatOf = new Map(Object.entries(seatIds).map(([seat, id]) => [id, seat]));
    const extraNames = [
        ...Object.entries(isObj(opts.decks) ? opts.decks : {}).map(([id, d]) => ({ name: d?.username, seat: seatOf.get(id) })),
        ...(opts.hideNames ?? []).map((x) => (typeof x === 'string' ? { name: x } : x))
    ];
    const scrub = nameScrubber(frames, seatOf, extraNames);
    const items = [];
    const views = new Set();
    // The engine counts setup as round 0 and announces 'Round: N - <Phase> Phase' when a phase starts. Alerts are
    // trusted when the frame's phase changes: undo and rollback search leave stale alerts in the chat log. Within a
    // phase, an alert is taken only when it moves the round back or comes with a rollback (a rollback to the start of
    // a phase announces it again), or when the phase started without one (an undo, or SWU Forge chat landing late).
    let round = 0;
    let prevPhase;
    let unannounced = false;
    const lastAlert = {}; // phase -> round of the latest alert for it
    let lastMsgEnd = -1; // index of the last message consumed (when frames carry messageOffset)
    let prevNewMessages = null;
    let chatDropped = 0;
    for (const f of frames) {
        const gs = f.state;
        // new chat-log lines in this frame, deduplicated whether the capture keeps messageOffset or not
        let msgs = Array.isArray(gs.newMessages) ? gs.newMessages : [];
        if (typeof gs.messageOffset === 'number') {
            msgs = msgs.filter((_, k) => gs.messageOffset + k > lastMsgEnd);
            lastMsgEnd = Math.max(lastMsgEnd, gs.messageOffset + (gs.newMessages?.length ?? 0) - 1);
        } else {
            const json = JSON.stringify(msgs);
            if (json === prevNewMessages) {
                msgs = [];
            } else {
                prevNewMessages = json;
            }
        }
        const lines = [];
        const alerts = [];
        for (const m of msgs) {
            if (isPlayerChat(m)) {
                chatDropped++;
                continue;
            }
            const line = parseMessage(m, seatOf, scrub);
            // read before names are replaced, in case someone is called 'Action'
            const r = messageText(m, seatOf).match(/^Round:\s*(\d+)\s*-\s*(?:Additional )?(\w+) Phase/i);
            if (r) {
                alerts.push({ round: Number(r[1]), phase: r[2].toLowerCase() });
            }
            if (line.text) {
                lines.push(line);
            }
        }
        const here = alerts.filter((a) => a.phase === gs.phase).pop();
        if (gs.phase !== prevPhase) {
            unannounced = !here && gs.phase !== 'setup';
            if (here) {
                round = here.round;
            } else if (gs.phase === 'setup') {
                round = 0;
            } else if (lastAlert[gs.phase] != null) {
                // no alert with the change: an undo back into a phase already announced
                round = lastAlert[gs.phase];
            } else if (gs.phase === 'action' && prevPhase !== undefined) {
                // a capture without the log (KaraBuddy's sample strips it): count action phases
                round += 1;
            } else if (gs.phase === 'action') {
                round = Math.max(round, 1);
            }
            prevPhase = gs.phase;
        } else if (here && (unannounced || here.round < round || lines.some((l) => /\brolled back to\b/.test(l.text)))) {
            round = here.round;
            unannounced = false;
        }
        for (const a of alerts) {
            lastAlert[a.phase] = a.round;
        }
        const view = frameView(gs, seatIds);
        if (view) {
            views.add(view);
        }
        const state = compactSnapshot(gs, seatIds, round);
        const active = Object.entries(seatIds).find(([, id]) => gs.players[id]?.isActionPhaseActivePlayer)?.[0] ?? null;
        // per seat whose prompt the capture shows (the viewer's own, both when merged): 'waiting' for the other, or 'open'
        const prompt = {};
        for (const [seat, id] of Object.entries(seatIds)) {
            const title = gs.players[id]?.promptState?.menuTitle;
            if (title) {
                prompt[seat] = /^Waiting for opponent/.test(title) ? 'waiting' : 'open';
            }
        }
        items.push({ t: f.t ?? null, state, key: JSON.stringify(state), lines, active, prompt, winners: gs.winners ?? [] });
    }
    const nameToSeat = new Map();
    for (const f of frames) {
        for (const [id, p] of Object.entries(f.state.players)) {
            if (p?.name && seatOf.has(id)) {
                nameToSeat.set(p.name, seatOf.get(id));
            }
        }
    }
    const v = [...views];
    const pov = v.includes('both') || v.length === 2 ? 'both' : v.length === 1 ? v[0] : 'spectator';
    return { frames, seatIds, seatOf, nameToSeat, items, pov, chatDropped };
}

/**
 * Convert frames to replay events.
 *
 * @param {Array<{state: object, t?: number}>} frames full gamestate objects in order (patches already applied)
 * @param {object} [opts]
 * @param {{p1: string, p2: string}} [opts.seats] player ids for p1 and p2
 * @param {object} [opts.source] provenance written to header.source (kind, site, id, url, ...)
 * @param {string[]} [opts.names] display names for p1, p2 (default: the seat names; Karabast usernames are dropped)
 * @param {Array<string|{name: string, seat?: string}>} [opts.hideNames] more usernames to replace in log text
 * @param {number} [opts.seed] header.seed (default 0: a human game has no replayable seed)
 * @returns {{events: object[], report: object}}
 */
/**
 * Deck lists from the lobby, keyed by player id (KaraBuddy keeps them: the recorder's full list, the opponent's
 * leader and base only), as { <seat>: { leader, secondLeader?, base, cards, sideboard } } with set codes and counts.
 * Deck names and usernames are dropped.
 */
function decklistsBySeat(decks, seatIds) {
    if (!isObj(decks)) {
        return null;
    }
    const entry = (e) => (isObj(e) && e.id ? e.id : null);
    const list = (l) => (Array.isArray(l) ? l.filter((e) => isObj(e) && e.id).map((e) => ({ id: e.id, count: e.count ?? 1 })) : null);
    const out = {};
    for (const [seat, id] of Object.entries(seatIds)) {
        const d = decks[id];
        if (isObj(d)) {
            out[seat] = {
                leader: entry(d.leader), ...(d.secondLeader ? { secondLeader: entry(d.secondLeader) } : {}), base: entry(d.base),
                cards: list(d.deck), sideboard: list(d.sideboard)
            };
        }
    }
    return Object.keys(out).length ? out : null;
}

function convertFrames(frames, opts = {}) {
    const r = readFrames(frames, opts);
    const { seatIds, items, pov } = r;
    const first = r.frames[0].state;
    const deckName = (seat) => {
        const p = first.players[seatIds[seat]] ?? {};
        const l = leadersOf(p)[0];
        return [l?.name, p.base?.name].filter(Boolean).join(' / ') || 'unknown';
    };
    const report = { frames: items.length, steps: 0, messages: 0, chatDropped: r.chatDropped, unparsed: 0, guessedActor: 0, seats: seatIds, pov };
    const events = [];
    let prevKey = null;
    let prevActive = null;
    let n = 0;
    for (let i = 0; i < items.length; i++) {
        const { state, key, lines, active } = items[i];
        report.messages += lines.length;
        const actionLines = lines.filter((l) => l.seat && !isMetaLine(l));
        if (i === 0) {
            events.push({ t: 'step', n: 0, label: 'Game start', state, ...(lines.length ? { log: lines.map((l) => l.text) } : {}) });
            prevKey = key;
            prevActive = active;
            continue;
        }
        if (key === prevKey && !actionLines.length) {
            prevActive = active ?? prevActive;
            continue;
        }
        // the decision: the first log line a player's choice explains; its seat is the actor. Without one, the actor is
        // the action-phase player before this frame, else the only side whose board changed.
        const before = JSON.parse(prevKey);
        const baseNameOf = (seat) => state.players[seat]?.base?.n ?? `${seat} base`;
        const found = actionLines.map((l) => ({ seat: l.seat, steps: decisionsFromLine(l, baseNameOf) })).filter((x) => x.steps);
        // The resource step logs both players' choices when the last one confirms (the first confirm changes nothing
        // and is skipped): one decision per player. Whoever was already waiting the frame before confirmed first.
        const isResource = (x) => x.steps[0].prompt === 'resource|-';
        const order = (seat) => ({ waiting: 0, open: 2 })[items[i - 1].prompt[seat]] ?? 1;
        const decided = found[0] && isResource(found[0])
            ? found.filter((x, k) => isResource(x) && found.findIndex((y) => y.seat === x.seat) === k).sort((a, b) => order(a.seat) - order(b.seat))
            : found.slice(0, 1);
        if (found.length > decided.length) {
            report.multiDecisionFrames = (report.multiDecisionFrames ?? 0) + 1;
        }
        let pid = actionLines[0]?.seat ?? lines.find((l) => l.seat)?.seat ?? prevActive ?? null;
        if (!pid) {
            const changed = ['p1', 'p2'].filter((x) => JSON.stringify(before.players[x]) !== JSON.stringify(state.players[x]));
            pid = changed.length === 1 ? changed[0] : 'p1';
            report.guessedActor++;
        }
        if (!decided.length && actionLines.length) {
            report.unparsed++;
        }
        const log = lines.length ? { log: lines.map((l) => l.text) } : {};
        const subs = decided.length
            ? decided.flatMap((x) => x.steps.map((d) => ({ ...d, pid: x.seat })))
            : [{ pid, prompt: 'log|-', title: null, action: { kind: 'button', label: lines[0]?.text ?? 'Board update' } }];
        subs.forEach((d, k) => {
            const lastSub = k === subs.length - 1;
            n++;
            // a two-click decision (attacker, then target) shows the old board after the first click, as bot replays do
            events.push({ t: 'step', n, pid: d.pid, prompt: d.prompt, title: d.title ?? null, action: d.action, legal: 1, ...(lastSub ? log : {}), state: lastSub ? state : before });
        });
        prevKey = key;
        prevActive = active ?? prevActive;
    }

    const winners = items[items.length - 1].winners.map((w) => r.nameToSeat.get(w) ?? null);
    const winner = winners.length === 2 ? 'draw' : winners[0] ?? null;
    const lastState = events[events.length - 1].state;
    // How it ended: humans concede, leave and time out; the log says which, else the bases do. Only the frames up to
    // the end count: the loser leaving the lobby, or a concede click, after a won game still adds a line.
    let endAt = items.length - 1;
    while (winner && endAt > 0 && items[endAt - 1].winners.length) {
        endAt--;
    }
    const endLines = items.slice(0, endAt + 1).flatMap((x) => x.lines.map((l) => l.text));
    const loser = winner === 'p1' ? 'p2' : winner === 'p2' ? 'p1' : null;
    const who = loser ?? 'p[12]';
    const said = (re) => endLines.some((l) => re.test(l));
    const loserBase = loser ? items[endAt].state.players[loser].base : null;
    let how = null;
    if (loserBase && loserBase.d >= loserBase.hp) {
        how = 'base destroyed';
    } else if (said(new RegExp(`^${who} concedes the game`))) {
        how = 'concede';
    } else if (said(new RegExp(`due to ${who} timing out`))) {
        how = 'timeout';
    } else if (said(new RegExp(`^${who} has left the game`))) {
        how = 'left';
    } else if (loser) {
        how = 'conceded or left (the loser\'s base was not destroyed; no log to say which)';
    }
    report.steps = n;

    const names = opts.names ?? ['p1', 'p2'];
    const decklists = decklistsBySeat(opts.decks, seatIds);
    events.unshift({
        t: 'header', v: 1, seed: opts.seed ?? 0, engine: opts.engine ?? null,
        players: ['p1', 'p2'].map((seat, k) => ({ id: seat, bot: names[k] ?? seat, deck: deckName(seat), human: true })),
        source: {
            ...(opts.source ?? {}),
            format: 'karabast-gamestate',
            pov,
            hiddenHands: pov === 'both' ? [] : pov === 'p1' ? ['p2'] : pov === 'p2' ? ['p1'] : ['p1', 'p2'],
            synthetic: ['seed', 'prompt', 'title', 'action', 'legal'],
            ...(decklists ? { decklists } : {})
        }
    });
    events.push({
        t: 'end', winner, round: lastState.round, steps: n,
        outcome: winner ? 'won' : 'STUCK',
        error: winner ? null : 'capture ended before the game did',
        ...(how ? { how } : {})
    });
    report.how = how;
    return { events, report };
}

module.exports = { convertFrames, readFrames, splitGames, nameScrubber, compactSnapshot, decklistsBySeat, isHidden, assignSeats, parseMessage, messageText, decisionsFromLine, setCode, leadersOf, HIDDEN };
