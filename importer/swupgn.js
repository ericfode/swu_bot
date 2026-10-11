'use strict';

/**
 * SWU-PGN/1.0 game files (.swupgn) -> swu_bot replay events (spec/replay-format.md v1, the shape importer/karabast.js
 * writes: header, one step per player decision with a compact board snapshot, end).
 *
 * SWU-PGN is Karabast's draft game notation (SWU-Karabast/forceteki PR #2350, branch `swu-game-notation`, spec
 * docs/SWU-PGN-1.0-SPEC.md at 82dc657b). A file is omniscient and event-sourced: both deck lists, both shuffled deck
 * orders, the RNG seed and every board change as one NDJSON record, plus a full board ("keyframe") at round edges.
 * Folding the records in order rebuilds the board with no engine and no card data.
 *
 * parse() and fold() are written from the spec (sections 4, 11-13). The MOVE rule, the keyframe check and
 * linkActionSteps() follow the MIT-licensed reference reader in that branch (swupgn/src/fold.ts, integrity.ts,
 * actionLinks.ts; Copyright (c) 2016 Stuart Walsh, (c) 2024 Addison Mayberry) closely, so a fold here gives the
 * same board as the reference on its test vectors (checked by importer/test/swupgn.test.js).
 *
 * Privacy: P1Id/P2Id (salted username hashes) are never copied; seats are p1/p2 and names default to them.
 */

const { HIDDEN } = require('./karabast');

const REQUIRED_TAGS = ['Game', 'GameId', 'Date', 'CardPool', 'Engine', 'Seed', 'P1Id', 'P2Id', 'P1', 'P2',
    'P1Leader', 'P1Base', 'P2Leader', 'P2Base', 'Result', 'Reason', 'Rounds'];
const JSON_SECTIONS = new Set(['DECKS', 'CARDS', 'SETUP', 'EVENTS', 'ANNOTATIONS']);
const ZONES = new Set(['deck', 'hand', 'resource', 'ground', 'space', 'discard', 'base', 'outsideTheGame', 'capture']);
const ARENAS = new Set(['ground', 'space']);
const isArena = (z) => ARENAS.has(z);
const isSeat = (p) => p === 1 || p === 2;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (x) => (Array.isArray(x) ? x : []);
const isToken = (id) => typeof id === 'string' && id.startsWith('TOKEN:');
const baseId = (ref) => String(ref).replace(/:\d+$/, '');
const copyOf = (ref) => /:(\d+)$/.exec(String(ref))?.[1] ?? null;
const baseSeat = (ref) => {
    const m = /^base@([12])$/.exec(String(ref));
    return m ? Number(m[1]) : null;
};
const MAX_LIST = 1000; // a real game never comes close; a crafted file must not make the fold quadratic

// ── parse (spec section 4) ──────────────────────────────────────────────────────────────────────────────────────

/** True when the text looks like a .swupgn file: a [Game "SWU-PGN/..."] tag before the first section banner. */
function isSwuPgn(text) {
    const head = String(text).replace(/^﻿/, '').slice(0, 4096);
    return /^\s*\[Game\s+"SWU-PGN\//m.test(head);
}

/**
 * Split a .swupgn text into { tags, story, decks, cards, setup, events, annotations }. Throws the spec's errors for a
 * missing required tag, invalid JSON and a record before any section; a later major version is refused.
 */
function parseSwuPgn(text) {
    const tags = {};
    const doc = { tags, story: [], decks: [], cards: [], setup: [], events: [], annotations: [] };
    let section = null;
    const lines = String(text).replace(/^﻿/, '').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.trim();
        if (section === 'STORY' && !line.startsWith('%%%')) {
            doc.story.push(raw.replace(/\r$/, '')); // prose, kept verbatim
            continue;
        }
        if (!line) {
            continue;
        }
        if (section === null && line.startsWith('[')) {
            const re = /\[([A-Za-z0-9]+)\s+"((?:[^"\\]|\\.)*)"\]/g;
            let m;
            while ((m = re.exec(line)) !== null) {
                tags[m[1]] = m[2].replace(/\\(.)/g, '$1'); // the last copy of a tag wins
            }
            continue;
        }
        if (line.startsWith('%%%')) {
            const name = line.slice(3).trim().toUpperCase();
            section = name === 'STORY' || JSON_SECTIONS.has(name) ? name : 'UNKNOWN';
            continue;
        }
        if (section === null) {
            throw new Error(`SWU-PGN: record before any %%% section on line ${i + 1}`);
        }
        let rec;
        try {
            rec = JSON.parse(line);
        } catch {
            throw new Error(`SWU-PGN: invalid JSON on line ${i + 1}`);
        }
        if (section === 'UNKNOWN') {
            continue; // a later minor version's section: ignore (spec section 18)
        }
        if (!isObj(rec)) {
            throw new Error(`SWU-PGN: record on line ${i + 1} is not a JSON object`);
        }
        doc[{ DECKS: 'decks', CARDS: 'cards', SETUP: 'setup', EVENTS: 'events', ANNOTATIONS: 'annotations' }[section]].push(rec);
    }
    for (const t of REQUIRED_TAGS) {
        if (!(t in tags)) {
            throw new Error(`SWU-PGN: missing required header tag [${t}]`);
        }
    }
    if (!/^SWU-PGN\/1\.\d+$/.test(tags.Game)) {
        throw new Error(`SWU-PGN: unsupported version "${tags.Game}" (this reader reads SWU-PGN/1.x)`);
    }
    while (doc.story.length && !doc.story[0].trim()) {
        doc.story.shift();
    }
    while (doc.story.length && !doc.story[doc.story.length - 1].trim()) {
        doc.story.pop();
    }
    return doc;
}

// ── fold (spec sections 11-13) ──────────────────────────────────────────────────────────────────────────────────

function emptyPlayer(seat) {
    return { seat, baseHp: 30, baseMaxHp: 30, handSize: 0, hand: [], resourcesReady: 0, resourcesExhausted: 0, credits: 0, hasForce: false, discard: [], cards: [] };
}

function emptyState() {
    return { round: 0, phase: 'setup', initiative: null, initiativeTaken: false, players: { 1: emptyPlayer(1), 2: emptyPlayer(2) } };
}

const newCard = (id, zone) => ({ id, zone, damage: 0, exhausted: false, upgrades: [], shields: 0, experience: 0, statusTokens: {}, captured: [] });

function findCard(s, id) {
    for (const seat of [1, 2]) {
        const c = s.players[seat]?.cards.find((x) => x.id === id);
        if (c) {
            return c;
        }
    }
    return undefined;
}

function leaderOwner(s, id) {
    return [1, 2].map((seat) => s.players[seat]).find((ps) => ps?.leader?.id === id);
}

function addOnce(list, id) {
    if (list.length < MAX_LIST && !list.includes(id)) {
        list.push(id);
    }
}

function removeOne(list, id) {
    const i = list.indexOf(id);
    if (i >= 0) {
        list.splice(i, 1);
    }
}

function removeFromArenas(s, id) {
    for (const seat of [1, 2]) {
        const cards = s.players[seat]?.cards ?? [];
        const i = cards.findIndex((c) => c.id === id);
        if (i >= 0) {
            cards.splice(i, 1);
            return;
        }
    }
}

function placeCard(s, seat, id, zone) {
    const existing = findCard(s, id);
    if (existing) {
        existing.zone = zone;
    } else if (isSeat(seat) && s.players[seat].cards.length < MAX_LIST) {
        s.players[seat].cards.push(newCard(id, zone));
    }
}

/** A printed card (upgrade, pilot) goes onto its host's upgrades once; token upgrades are counters, not list entries. */
function attach(s, hostId, id) {
    const host = findCard(s, hostId);
    if (!isToken(id) && host && !host.upgrades.includes(id)) {
        host.upgrades.push(id);
    }
}

/** A card that left an arena or the capture zone is nobody's attachment and nobody's captive. */
function detach(s, id) {
    for (const seat of [1, 2]) {
        for (const c of s.players[seat]?.cards ?? []) {
            removeOne(c.upgrades, id);
            c.captured = arr(c.captured);
            removeOne(c.captured, id);
        }
    }
}

function countResource(ps, delta, exhausted) {
    const k = exhausted ? 'resourcesExhausted' : 'resourcesReady';
    ps[k] = Math.max(0, ps[k] + delta);
}

/** The two reserved token names (spec 6.1): Credit tokens feed `credits`, the Force token feeds `hasForce`. */
function countBaseToken(ps, id, delta) {
    if (String(id).startsWith('TOKEN:credit#')) {
        ps.credits = Math.max(0, ps.credits + delta);
    } else if (String(id).startsWith('TOKEN:the-force#')) {
        ps.hasForce = delta > 0;
    }
}

const resourceList = (ps) => (Array.isArray(ps.resources) ? ps.resources : (ps.resources = []));

/** True for a well-formed MOVE (spec 10.1: both zones from the vocabulary, and different). */
const isGoodMove = (e) => typeof e.card === 'string' && ZONES.has(e.from) && ZONES.has(e.to) && e.from !== e.to;

/** Spec 12.1, the MOVE rule: the single source of truth for hand, discard, deck count, resources and arenas. */
function applyMove(s, e) {
    if ((isArena(e.from) && !isArena(e.to)) || e.from === 'capture') {
        detach(s, e.card);
    }
    if (!isSeat(e.p)) {
        const c = findCard(s, e.card);
        if (c) {
            c.zone = e.to;
        }
        return;
    }
    const ps = s.players[e.p];
    if (e.to === 'hand') {
        ps.handSize += 1;
        addOnce(ps.hand, e.card);
    } else if (e.from === 'hand') {
        ps.handSize = Math.max(0, ps.handSize - 1);
        removeOne(ps.hand, e.card);
    }
    if (e.to === 'discard') {
        addOnce(ps.discard, e.card);
    } else if (e.from === 'discard') {
        removeOne(ps.discard, e.card);
    }
    if (typeof ps.deckSize === 'number') {
        if (e.to === 'deck') {
            ps.deckSize += 1;
        } else if (e.from === 'deck') {
            ps.deckSize = Math.max(0, ps.deckSize - 1);
        }
    }
    if (e.to === 'base' && isArena(e.from)) {
        const owner = leaderOwner(s, e.card);
        if (owner) {
            owner.leader.deployed = false;
        }
    }
    if (e.to === 'resource') {
        countResource(ps, 1, false);
        addOnce(resourceList(ps), e.card);
    } else if (e.from === 'resource') {
        countResource(ps, -1, e.exhausted === true);
        removeOne(resourceList(ps), e.card);
    }
    if (e.to === 'base') {
        countBaseToken(ps, e.card, 1);
    } else if (e.from === 'base') {
        countBaseToken(ps, e.card, -1);
    }
    const existing = findCard(s, e.card);
    if (e.kind === 'upgrade') {
        if (isArena(e.to) && e.attachedTo) {
            attach(s, e.attachedTo, e.card);
        }
        if (existing) {
            existing.zone = e.to;
        }
        return;
    }
    if (isArena(e.to)) {
        if (existing) {
            existing.zone = e.to;
        } else if (ps.cards.length < MAX_LIST) {
            ps.cards.push(newCard(e.card, e.to));
        }
    } else if (existing && isArena(existing.zone)) {
        removeFromArenas(s, e.card);
    } else if (existing) {
        existing.zone = e.to;
    }
}

const setExhausted = (s, id, value) => {
    const c = findCard(s, id);
    if (c) {
        c.exhausted = value;
    }
    const owner = leaderOwner(s, id);
    if (owner) {
        owner.leader.exhausted = value;
    }
};

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Records that never change the board (spec 10.2). */
const NOTES = new Set(['ATTACK', 'PASS', 'CHOICE', 'MODAL_CHOICE', 'MULLIGAN', 'KEEP_HAND', 'SHUFFLE', 'SEARCH', 'REVEAL', 'TRIGGER',
    'PHASE_END', 'ROUND_END', 'GAME_END', 'UNDO', 'RESOURCE']);

/**
 * Apply one record (spec 12.2). Mutates and returns `s`. A record it ignores (an unknown type, a malformed MOVE) is
 * passed to `warn`, never thrown. Keyframes are handled by the caller.
 */
function reduce(s, e, warn = () => {}) {
    const ps = isSeat(e.p) ? s.players[e.p] : null;
    switch (e.t) {
        case 'ROUND_START':
            s.round = e.round;
            s.initiativeTaken = false;
            if (isSeat(e.active)) {
                s.active = e.active;
            }
            break;
        case 'PHASE_START':
            s.phase = e.phase;
            if (isSeat(e.active)) {
                s.active = e.active;
            }
            break;
        case 'CLAIM_INITIATIVE':
            if (isSeat(e.p)) {
                s.initiative = e.p;
                s.initiativeTaken = true;
            }
            break;
        case 'PLAY': case 'PLAY_SMUGGLE':
            placeCard(s, e.p, e.card, e.zone ?? 'ground');
            break;
        case 'PLAY_EVENT':
            if (ps) {
                addOnce(ps.discard, e.card);
            }
            break;
        case 'PLAY_UPGRADE':
            if (e.target) {
                attach(s, e.target, e.card);
            }
            break;
        case 'DEPLOY_LEADER':
            if (ps) {
                const prev = ps.leader;
                ps.leader = { id: e.card, deployed: true, exhausted: false, epicActionUsed: (prev?.id === e.card && prev.epicActionUsed) || e.epic === true };
            }
            if (e.kind === 'upgrade') {
                if (e.target) {
                    attach(s, e.target, e.card);
                }
            } else {
                placeCard(s, e.p, e.card, e.zone ?? 'ground');
            }
            break;
        case 'ABILITY_ACTIVATE':
            if (e.epic === true) {
                const bs = baseSeat(e.card);
                if (bs) {
                    s.players[bs].baseEpicActionUsed = true;
                } else {
                    const owner = leaderOwner(s, e.card);
                    if (owner) {
                        owner.leader.epicActionUsed = true;
                    }
                }
            }
            break;
        case 'LEADER_FLIP': {
            const owner = leaderOwner(s, e.card) ?? ps;
            if (owner) {
                owner.leader ??= { id: e.card, deployed: false, exhausted: false, epicActionUsed: false };
                owner.leader.onStartingSide = e.onStartingSide;
            }
            break;
        }
        case 'STATS': {
            const c = findCard(s, e.card);
            if (c) {
                c.power = e.power;
                c.hp = e.hp;
                if (Array.isArray(e.keywords)) {
                    c.keywords = e.keywords.map(String).sort();
                }
            }
            break;
        }
        case 'TAKE_CONTROL': {
            if (!ps) {
                break;
            }
            if (e.zone === 'resource' || e.zone === 'base') {
                if (!isSeat(e.from)) {
                    break;
                }
                const from = s.players[e.from];
                if (e.zone === 'resource') {
                    countResource(from, -1, e.exhausted === true);
                    countResource(ps, 1, e.exhausted === true);
                    removeOne(resourceList(from), e.card);
                    addOnce(resourceList(ps), e.card);
                } else {
                    countBaseToken(from, e.card, -1);
                    countBaseToken(ps, e.card, 1);
                }
            } else if (isArena(e.zone)) {
                for (const seat of [1, 2]) {
                    const i = seat === e.p ? -1 : s.players[seat].cards.findIndex((c) => c.id === e.card);
                    if (i >= 0) {
                        ps.cards.push(s.players[seat].cards.splice(i, 1)[0]);
                        break;
                    }
                }
            }
            break;
        }
        case 'CAPTURE': {
            removeFromArenas(s, e.card);
            const captor = e.by ? findCard(s, e.by) : undefined;
            if (captor) {
                captor.captured = arr(captor.captured);
                addOnce(captor.captured, e.card);
            }
            break;
        }
        case 'RESCUE':
            detach(s, e.card);
            break;
        case 'CREATE_TOKEN':
            if (e.kind !== 'upgrade' && isArena(e.zone)) {
                placeCard(s, e.p, e.token, e.zone);
            }
            break;
        case 'EXHAUST_RESOURCES': case 'READY_RESOURCES':
            if (ps) {
                const n = Math.max(0, e.amount | 0);
                const [from, to] = e.t === 'EXHAUST_RESOURCES' ? ['resourcesReady', 'resourcesExhausted'] : ['resourcesExhausted', 'resourcesReady'];
                const moved = Math.min(n, ps[from]);
                ps[from] -= moved;
                ps[to] += moved;
            }
            break;
        case 'DAMAGE': case 'OVERWHELM': case 'HEAL': {
            const bs = baseSeat(e.tgt);
            if (bs) {
                if (typeof e.hp === 'number') {
                    s.players[bs].baseHp = e.hp; // the file's number wins
                }
            } else if (e.t !== 'OVERWHELM') {
                const c = findCard(s, e.tgt);
                if (c) {
                    c.damage = Math.max(0, c.damage + (e.t === 'DAMAGE' ? 1 : -1) * (e.amt | 0));
                }
            }
            break;
        }
        case 'DEFEAT':
            detach(s, e.card);
            for (const seat of [1, 2]) {
                const cards = s.players[seat].cards;
                const i = cards.findIndex((c) => c.id === e.card);
                if (i >= 0) {
                    addOnce(s.players[seat].discard, e.card);
                    cards.splice(i, 1);
                }
            }
            break;
        case 'EXHAUST': case 'READY':
            setExhausted(s, e.card, e.t === 'EXHAUST');
            break;
        case 'MOVE':
            if (isGoodMove(e)) {
                applyMove(s, e);
            } else {
                warn('bad MOVE', e);
            }
            break;
        case 'DRAW': case 'DISCARD':
            if (ps) {
                for (const id of arr(e.cards)) {
                    addOnce(e.t === 'DRAW' ? ps.hand : ps.discard, id);
                }
            }
            break;
        case 'SHIELD_GAIN': case 'SHIELD_USE': {
            const c = findCard(s, e.card);
            if (c) {
                c.shields = Math.max(0, c.shields + (e.t === 'SHIELD_GAIN' ? 1 : -1) * ((e.count ?? 1) | 0));
            }
            break;
        }
        case 'EXPERIENCE_GAIN': {
            const c = findCard(s, e.card);
            if (c) {
                c.experience = Math.max(0, c.experience + (e.count | 0));
            }
            break;
        }
        case 'STATUS_TOKEN': {
            const c = findCard(s, e.card);
            if (c && typeof e.token === 'string' && !BAD_KEYS.has(e.token)) {
                const n = Math.max(0, (c.statusTokens[e.token] ?? 0) + (e.count | 0));
                // a token count that reaches 0 is deleted, not kept as { advantage: 0 } (spec 10.1)
                c.statusTokens = Object.fromEntries(Object.entries({ ...c.statusTokens, [e.token]: n }).filter(([, v]) => v > 0));
            }
            break;
        }
        default:
            if (!NOTES.has(e.t)) {
                warn('unknown type', e);
            }
    }
    return s;
}

/** A keyframe a reader may snap to: both seats, with array cards/hand/discard and array upgrades on every card. */
function isCompleteKeyframe(k) {
    if (!isObj(k) || !isObj(k.players)) {
        return false;
    }
    return [1, 2].every((seat) => {
        const p = k.players[seat];
        return isObj(p) && Array.isArray(p.cards) && Array.isArray(p.hand) && Array.isArray(p.discard) &&
            p.cards.every((c) => isObj(c) && Array.isArray(c.upgrades));
    });
}

const hasKeyframe = (e) => (e.t === 'ROUND_START' || e.t === 'ROUND_END') && e.keyframe !== undefined;

/** Fold a whole event list from the empty board, snapping to every complete keyframe (spec 12). */
function fold(events) {
    let s = emptyState();
    for (const e of events) {
        if (hasKeyframe(e) && isCompleteKeyframe(e.keyframe)) {
            s = structuredClone(e.keyframe);
            continue;
        }
        s = reduce(s, e);
    }
    return s;
}

const sameSet = (a, b) => JSON.stringify(arr(a).map(String).sort()) === JSON.stringify(arr(b).map(String).sort());

/**
 * Differences between the folded board and a keyframe (spec 14). `first` skips baseHp (no record carries a base's
 * starting HP). deckSize is compared whenever the fold knows it: this reader seeds it from INIT, so the first
 * keyframe is checked too. `initiative` is compared when the fold set it (this reader's setup-choice rule).
 */
function diffKeyframe(seq, k, g, first) {
    const out = [];
    const add = (path, expected, got) => out.push({ seq, path, expected, got });
    if (typeof k.initiativeTaken === 'boolean' && k.initiativeTaken !== (g.initiativeTaken ?? false)) {
        add('initiativeTaken', k.initiativeTaken, g.initiativeTaken ?? false);
    }
    if (g.initiative != null && k.initiative != null && g.initiative !== k.initiative) {
        add('initiative', k.initiative, g.initiative);
    }
    for (const seat of [1, 2]) {
        const e = k.players[seat];
        const p = g.players[seat];
        const at = `players.${seat}`;
        if (!first && e.baseHp !== p.baseHp) {
            add(`${at}.baseHp`, e.baseHp, p.baseHp);
        }
        for (const f of ['handSize', 'resourcesReady', 'resourcesExhausted', 'credits', 'hasForce']) {
            if (e[f] !== p[f]) {
                add(`${at}.${f}`, e[f], p[f]);
            }
        }
        if (typeof e.deckSize === 'number' && typeof p.deckSize === 'number' && e.deckSize !== p.deckSize) {
            add(`${at}.deckSize`, e.deckSize, p.deckSize);
        }
        if (!sameSet(e.hand, p.hand)) {
            add(`${at}.hand`, e.hand, p.hand);
        }
        if (JSON.stringify(e.discard) !== JSON.stringify(p.discard)) {
            add(`${at}.discard`, e.discard, p.discard);
        }
        if (Array.isArray(e.resources) && !sameSet(e.resources, p.resources)) {
            add(`${at}.resources`, e.resources, p.resources);
        }
        if (typeof e.baseEpicActionUsed === 'boolean' && e.baseEpicActionUsed !== (p.baseEpicActionUsed ?? false)) {
            add(`${at}.baseEpicActionUsed`, e.baseEpicActionUsed, p.baseEpicActionUsed ?? false);
        }
        if (e.leader && p.leader) {
            for (const f of ['id', 'deployed', 'exhausted', 'epicActionUsed']) {
                if (e.leader[f] !== p.leader[f]) {
                    add(`${at}.leader.${f}`, e.leader[f], p.leader[f]);
                }
            }
            if (typeof e.leader.onStartingSide === 'boolean' && e.leader.onStartingSide !== p.leader.onStartingSide) {
                add(`${at}.leader.onStartingSide`, e.leader.onStartingSide, p.leader.onStartingSide);
            }
        }
        const got = new Map(p.cards.map((c) => [c.id, c]));
        for (const ec of e.cards) {
            const gc = got.get(ec.id);
            const cat = `${at}.cards[${ec.id}]`;
            if (!gc) {
                add(cat, 'present', 'absent');
                continue;
            }
            for (const f of ['zone', 'damage', 'exhausted', 'shields', 'experience']) {
                if (ec[f] !== gc[f]) {
                    add(`${cat}.${f}`, ec[f], gc[f]);
                }
            }
            for (const f of ['power', 'hp']) {
                if (typeof ec[f] === 'number' && ec[f] !== gc[f]) {
                    add(`${cat}.${f}`, ec[f], gc[f]);
                }
            }
            if (JSON.stringify(ec.statusTokens ?? {}) !== JSON.stringify(gc.statusTokens ?? {})) {
                add(`${cat}.statusTokens`, ec.statusTokens, gc.statusTokens);
            }
            for (const f of ['upgrades', 'captured']) {
                if (!sameSet(ec[f], gc[f])) {
                    add(`${cat}.${f}`, ec[f], gc[f]);
                }
            }
            if (Array.isArray(ec.keywords) && !sameSet(ec.keywords, gc.keywords)) {
                add(`${cat}.keywords`, ec.keywords, gc.keywords);
            }
        }
        const expected = new Set(e.cards.map((c) => c.id));
        for (const gc of p.cards) {
            if (!expected.has(gc.id)) {
                add(`${at}.cards[${gc.id}]`, 'absent', 'present');
            }
        }
    }
    return out;
}

// ── action links (spec 9.1) ─────────────────────────────────────────────────────────────────────────────────────

const TOP_TYPES = new Set(['PLAY', 'PLAY_EVENT', 'PLAY_UPGRADE', 'PLAY_SMUGGLE', 'DEPLOY_LEADER', 'ATTACK', 'PASS', 'CLAIM_INITIATIVE', 'ABILITY_ACTIVATE']);

/** A numbered action: a player's own move in the action window (spec 9, 16). Older files leave `kind` off abilities. */
function isTopAction(e) {
    if (!TOP_TYPES.has(e.t)) {
        return false;
    }
    if (e.t !== 'ABILITY_ACTIVATE') {
        return true;
    }
    return e.kind === 'action' || e.kind === 'epic' || e.epic === true || (e.kind == null && /_action_\d+$/.test(String(e.ability ?? '')));
}

const isTopStep = (seq) => /^R\d+\.[SAG]\.\d+$/.test(String(seq));
const PRECURSORS = {
    ATTACK: new Set(['CHOICE', 'MODAL_CHOICE', 'EXHAUST']),
    ABILITY_ACTIVATE: new Set(['CHOICE', 'MODAL_CHOICE']),
    other: new Set(['MOVE', 'CHOICE', 'MODAL_CHOICE', 'EXHAUST', 'STATS', 'EXHAUST_RESOURCES'])
};

/**
 * Fill in `for` where a writer left it off (older 1.0 files), by the reference writer's own rule: a run of precursor
 * records right before an action belongs to it only when something in the run names the action's card (or chose the
 * ability's title). A RESOURCE owns the hand->resource MOVE right before it. Never overwrites an existing `for`.
 */
function linkActionSteps(events) {
    const out = events.map((e) => ({ ...e }));
    for (let i = 0; i < out.length; i++) {
        const a = out[i];
        if (a.t === 'RESOURCE' && i > 0) {
            const prev = out[i - 1];
            if (prev.t === 'MOVE' && prev.to === 'resource' && prev.card === a.card && prev.for == null) {
                prev.for = a.seq;
            }
            continue;
        }
        if (!isTopAction(a) || !isTopStep(a.seq)) {
            continue;
        }
        const card = typeof a.card === 'string' ? a.card : typeof a.atk === 'string' ? a.atk : null;
        if (card == null) {
            continue;
        }
        const kinds = PRECURSORS[a.t] ?? PRECURSORS.other;
        let start = i;
        while (start > 0 && !isTopStep(out[start - 1].seq) && kinds.has(out[start - 1].t) && out[start - 1].for == null) {
            start--;
        }
        const run = out.slice(start, i);
        const title = a.t === 'ABILITY_ACTIVATE' ? a.title : undefined;
        const anchored = run.some((e) => e.card === card || e.atk === card ||
            (title && (e.t === 'CHOICE' || e.t === 'MODAL_CHOICE') && arr(e.offered)[e.chose] === title));
        if (anchored) {
            run.forEach((e) => {
                e.for = a.seq;
            });
        }
    }
    return out;
}

// ── names and refs ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Card naming from the file's own %%% CARDS index. Our snapshot's `n` is the title without subtitle; the index joins
 * them as "Title, Subtitle". Only leaders, units and upgrades carry subtitles, while some event and base titles
 * contain a comma ("No Glory, Only Results", "Nevarro City, Restored"), so the subtitle is cut only for ids known to
 * be leaders, units or upgrades (from the header, the index's `kind`, or a record's `kind`).
 */
function makeNamer(doc, events) {
    const names = new Map();
    const subtitled = new Set([doc.tags.P1Leader, doc.tags.P2Leader].filter(Boolean).map(baseId));
    for (const c of doc.cards) {
        if (typeof c.id === 'string' && typeof c.name === 'string') {
            names.set(c.id, c.name);
            if (c.kind === 'unit' || c.kind === 'upgrade') {
                subtitled.add(c.id);
            }
        }
    }
    for (const e of events) {
        if ((e.kind === 'unit' || e.kind === 'upgrade') && typeof (e.card ?? e.token) === 'string') {
            subtitled.add(baseId(e.card ?? e.token));
        }
        if (e.t === 'DEPLOY_LEADER' && typeof e.card === 'string') {
            subtitled.add(baseId(e.card));
        }
    }
    const baseOf = { 1: doc.tags.P1Base, 2: doc.tags.P2Base };
    const title = (id) => {
        const b = baseId(id);
        const full = names.get(b) ?? b;
        const cut = full.indexOf(', ');
        return subtitled.has(b) && cut > 0 ? full.slice(0, cut) : full;
    };
    const setCode = (id) => {
        const m = /^([A-Za-z0-9]+)#(\d+)$/.exec(baseId(id));
        return m ? `${m[1]}_${m[2].padStart(3, '0')}` : null;
    };
    /** Card ref { n, s } for an id or a base@N ref. */
    const ref = (id) => {
        const bs = baseSeat(id);
        const target = bs ? baseOf[bs] : id;
        return { n: title(target), s: setCode(target) };
    };
    /** Display name with the copy suffix, for log lines: "Wampa #2", "p2's base". */
    const label = (id) => {
        const bs = baseSeat(id);
        if (bs) {
            return `p${bs}'s base`;
        }
        const k = copyOf(id);
        return `${title(id)}${k ? ` #${k}` : ''}`;
    };
    /** A token upgrade counter (shield, experience, advantage, ...) as an upgrade ref, named from the index. */
    const tokenNames = new Map();
    const tokenRef = (name) => {
        if (!tokenNames.has(name)) {
            const hit = [...names.keys()].find((id) => id === `TOKEN:${name}` || id.startsWith(`TOKEN:${name}#`));
            tokenNames.set(name, hit ? names.get(hit) : name.charAt(0).toUpperCase() + name.slice(1));
        }
        return { n: tokenNames.get(name), s: null, t: 1 };
    };
    return { title, setCode, ref, label, tokenRef, baseOf, names };
}

// ── snapshot (the compact shape of importer/karabast.js and bot/recorder.js) ───────────────────────────────────

function unitRef(c, nm) {
    const out = { ...nm.ref(c.id), p: c.power ?? 0, h: c.hp ?? 0, d: c.damage ?? 0 };
    if (c.exhausted) {
        out.x = 1;
    }
    if (arr(c.keywords).includes('sentinel')) {
        out.sn = 1;
    }
    const times = (n, r) => Array.from({ length: Math.max(0, n | 0) }, () => ({ ...r }));
    const u = [
        ...arr(c.upgrades).map((id) => ({ ...nm.ref(id), t: isToken(id) ? 1 : 0 })),
        ...times(c.shields, nm.tokenRef('shield')),
        ...times(c.experience, nm.tokenRef('experience')),
        ...Object.entries(c.statusTokens ?? {}).flatMap(([name, n]) => times(n, nm.tokenRef(name)))
    ];
    if (u.length) {
        out.u = u;
    }
    if (arr(c.captured).length) {
        out.cap = c.captured.map(nm.ref); // captives held by this unit (optional field; not in bot replays)
    }
    return out;
}

function compactSnapshot(s, nm) {
    const players = {};
    for (const seat of [1, 2]) {
        const ps = s.players[seat] ?? emptyPlayer(seat);
        const hand = arr(ps.hand).map(nm.ref);
        for (let k = hand.length; k < ps.handSize; k++) {
            hand.push({ ...HIDDEN }); // a perspective-scoped file may blank the other hand
        }
        const units = (zone) => ps.cards.filter((c) => c.zone === zone).map((c) => unitRef(c, nm));
        players[`p${seat}`] = {
            name: `p${seat}`,
            base: { ...nm.ref(nm.baseOf[seat]), hp: ps.baseMaxHp, d: Math.max(0, ps.baseMaxHp - ps.baseHp) },
            leader: ps.leader ? { ...nm.ref(ps.leader.id), dep: ps.leader.deployed ? 1 : 0, x: ps.leader.exhausted ? 1 : 0 } : null,
            res: { ready: ps.resourcesReady, total: ps.resourcesReady + ps.resourcesExhausted },
            hand,
            deck: ps.deckSize ?? 0,
            discard: arr(ps.discard).map(nm.ref),
            ground: units('ground'),
            space: units('space')
        };
    }
    return { round: s.round, phase: s.phase, initiative: isSeat(s.initiative) ? `p${s.initiative}` : null, players };
}

// ── story lines (spec 16), used as each step's `log` ───────────────────────────────────────────────────────────

function storyLine(e, nm) {
    const who = (p) => (isSeat(p) ? `p${p}` : 'a player');
    const other = (p) => (p === 1 ? 2 : 1);
    const n = (id) => nm.label(id);
    const list = (ids) => arr(ids).map(n).join(', ');
    const cost = e.cost != null ? ` (cost ${e.cost})` : '';
    switch (e.t) {
        case 'PHASE_START': return `Round ${e.round ?? '?'}: ${e.phase} phase`;
        case 'PLAY': case 'PLAY_SMUGGLE': return `${who(e.p)} plays ${n(e.card)}${e.zone ? ` to ${e.zone}` : ''}${cost}`;
        case 'PLAY_UPGRADE': return `${who(e.p)} plays ${n(e.card)}${e.target ? ` on ${n(e.target)}` : e.zone ? ` to ${e.zone}` : ''}${cost}`;
        case 'PLAY_EVENT': return `${who(e.p)} plays ${n(e.card)}${cost}`;
        case 'DEPLOY_LEADER': return `${who(e.p)} deploys ${n(e.card)}${e.target ? ` as a pilot on ${n(e.target)}` : ''}`;
        case 'LEADER_FLIP': return `${who(e.p)} flips ${n(e.card)}`;
        case 'ATTACK': return `${who(e.p)} attacks ${e.defenderType === 'base' ? `${who(other(e.p))}'s base` : n(e.def)} with ${n(e.atk)}`;
        case 'PASS': return `${who(e.p)} passes`;
        case 'CLAIM_INITIATIVE': return `${who(e.p)} claims initiative`;
        case 'DAMAGE': return `${e.amt} damage to ${n(e.tgt)} - ${e.hp} HP left`;
        case 'OVERWHELM': return `${e.amt} Overwhelm damage to ${who(other(e.p))}'s base - ${e.hp} HP left`;
        case 'HEAL': return `${e.amt} healed on ${n(e.tgt)} - ${e.hp} HP left`;
        case 'DEFEAT': return `${n(e.card)} is defeated${e.defeatedBy ? ` by ${n(e.defeatedBy)}` : ''}`;
        case 'ABILITY_ACTIVATE': return isTopAction(e) ? `${who(e.p)} uses ${n(e.card)}${e.kind === 'epic' || e.epic ? '\'s Epic Action' : ''}` : `${n(e.card)} uses an ability`;
        case 'TRIGGER': return `${n(e.card)} triggers`;
        case 'STATUS_TOKEN': return `${n(e.card)} ${e.count < 0 ? 'loses' : 'gains'} ${Math.abs(e.count)} ${e.token}`;
        case 'SHIELD_GAIN': return `${n(e.card)} gains ${e.count ?? 1} shield`;
        case 'SHIELD_USE': return `${n(e.card)} loses ${e.count ?? 1} shield`;
        case 'EXPERIENCE_GAIN': return `${n(e.card)} ${e.count < 0 ? 'loses' : 'gains'} ${Math.abs(e.count)} experience`;
        case 'DRAW': return `${who(e.p)} draws ${e.count}${arr(e.cards).length ? `: ${list(e.cards)}` : ''}`;
        case 'DISCARD': return `${who(e.p)} discards ${list(e.cards)}`;
        case 'RESOURCE': return `${who(e.p)} resources ${n(e.card)}`;
        case 'REVEAL': return `${who(e.p)} reveals ${list(e.cards)}`;
        case 'SEARCH': return e.found ? `${who(e.p)} searches, finds ${list(e.found)}` : `${who(e.p)} searches their deck`;
        case 'CREATE_TOKEN': return `${who(e.p)} creates ${n(e.token)} in ${e.zone}`;
        case 'CAPTURE': return `${who(e.p)} captures ${n(e.card)}${e.by ? ` with ${n(e.by)}` : ''}`;
        case 'RESCUE': return `${who(e.p)} rescues ${n(e.card)}`;
        case 'TAKE_CONTROL': return `${who(e.p)} takes control of ${n(e.card)}`;
        case 'MULLIGAN': return `${who(e.p)} mulligans`;
        case 'KEEP_HAND': return `${who(e.p)} keeps their hand`;
        case 'UNDO': return `${isSeat(e.by) ? who(e.by) : 'a player'} undid back to ${e.at}`;
        case 'GAME_END': return e.winner === 'Draw' ? `Game ends in a draw - ${e.reason}` : `${who(e.winner)} wins - ${e.reason}`;
        default: return null; // MOVE, EXHAUST, READY, the resource counters, STATS, CHOICE, ...: mechanism, not story
    }
}

// ── decisions ───────────────────────────────────────────────────────────────────────────────────────────────────

const TOP = { prompt: 'actionWindow|-', title: 'Choose an action' };
const seqPhase = (seq) => /^R\d+\.([SAG])\./.exec(String(seq))?.[1] ?? null;

/** The beat a record belongs to: its `for`, else (action phase) its action number, else (setup/regroup) itself. */
function beatKey(e) {
    if (isTopAction(e)) {
        return e.seq;
    }
    if (e.for) {
        return e.for;
    }
    const m = /^(R\d+\.A\.\d+)[a-z]*$/.exec(String(e.seq));
    if (m) {
        return m[1];
    }
    return isTopStep(e.seq) ? e.seq : null;
}

const isChoice = (e) => e.t === 'CHOICE' || e.t === 'MODAL_CHOICE';
/** Setup and regroup decisions that are not numbered actions. RESOURCE in the action phase is an ability's doing. */
const isPhaseDecision = (e) => e.t === 'MULLIGAN' || e.t === 'KEEP_HAND' || (e.t === 'RESOURCE' && /^[SG]$/.test(seqPhase(e.seq) ?? ''));
const isInitiativeChoice = (e) => e.t === 'MODAL_CHOICE' && seqPhase(e.seq) === 'S' && JSON.stringify(arr(e.offered)) === '["Yourself","Opponent"]';

/**
 * Turn the records into decision steps. Each step is { seg, ord, i, pid, prompt, title, action, legal, seq }: `seg`
 * is the record index where the decision's own records start (a numbered action's beat starts with its precursors,
 * the CHOICE and EXHAUST the engine writes before announcing an attack), so the board after step k is the fold of
 * every record before step k+1's `seg`. A two-click decision (attacker, then target) thus shows the old board after
 * the first click, as bot replays do.
 */
function decisionSteps(events, nm) {
    const start = new Map();
    const byKey = new Map();
    const indexOf = new Map(events.map((e, i) => [e, i]));
    events.forEach((e, i) => {
        const k = beatKey(e);
        if (k == null) {
            return;
        }
        if (!start.has(k)) {
            start.set(k, i);
            byKey.set(k, []);
        }
        byKey.get(k).push(e);
    });
    const name = (id) => nm.ref(id).n;
    const steps = [];
    let lastPid = null;
    events.forEach((e, i) => {
        const top = isTopAction(e);
        if (!top && !isChoice(e) && !isPhaseDecision(e)) {
            return;
        }
        const key = beatKey(e);
        const beat = byKey.get(key) ?? [];
        const owner = beat.find((x) => isTopAction(x) && x.seq === key);
        const pidOf = (p) => (isSeat(p) ? `p${p}` : null);
        const pid = pidOf(e.p) ?? pidOf(owner?.p) ?? lastPid ?? 'p1';
        lastPid = pid;
        const step = (o) => steps.push({ seg: i, ord: 2, i, pid, seq: e.seq, legal: 1, ...o });
        if (top) {
            const seg = start.get(e.seq) ?? i;
            const card = e.t === 'ATTACK' ? e.atk : e.card;
            const action = e.t === 'PASS' ? { kind: 'button', label: 'Pass' }
                : e.t === 'CLAIM_INITIATIVE' ? { kind: 'button', label: 'Claim Initiative' }
                    : { kind: 'card', label: card != null ? name(card) : e.t };
            step({ ...TOP, seg, ord: 0, action });
            const has = (t) => beat.some((x) => x.t === t);
            const extra = (o) => step({ seg: i, ord: 1, synthetic: 1, ...o });
            // decisions the engine asked for but the file does not record as a CHOICE (karabast.js shapes)
            if (e.t === 'ATTACK' && !has('CHOICE') && e.def) {
                extra({ prompt: '-|single', title: 'Choose a target for attack', action: { kind: 'card', label: name(e.def) } });
            }
            if (e.t === 'DEPLOY_LEADER' && !has('MODAL_CHOICE')) {
                extra({ prompt: '-|-', title: 'Choose an ability', action: { kind: 'button', label: `Deploy ${name(e.card)}${e.kind === 'upgrade' ? ' as a Pilot' : ''}` } });
            }
            if ((e.t === 'PLAY_UPGRADE' || (e.t === 'DEPLOY_LEADER' && e.kind === 'upgrade')) && e.target && !has('CHOICE')) {
                extra({ prompt: '-|single', title: `Attach ${name(e.card)} to a unit`, action: { kind: 'card', label: name(e.target) } });
            }
        } else if (isChoice(e)) {
            const picks = (Array.isArray(e.chose) ? e.chose : [e.chose]).map((k) => arr(e.offered)[k]).filter((x) => x != null);
            const isRef = (x) => baseSeat(x) != null || /^[A-Za-z0-9]+#\d+(:\d+)?$/.test(x) || isToken(x);
            const asCard = e.t === 'CHOICE' && picks.length > 0 && picks.every(isRef);
            const label = picks.length ? picks.map((x) => (asCard ? name(x) : String(x))).join(', ') : '?';
            const legal = Math.max(1, arr(e.offered).length);
            if (isInitiativeChoice(e)) {
                step({ prompt: 'initiative|-', title: 'Choose the player to start with initiative', action: { kind: 'button', label }, legal });
            } else if (e.t === 'MODAL_CHOICE') {
                step({ prompt: '-|-', title: e.prompt ?? null, action: { kind: 'button', label }, legal });
            } else {
                const attackTarget = owner?.t === 'ATTACK' && i < indexOf.get(owner) && picks.length === 1 && picks[0] === owner.def;
                step({ prompt: '-|single', title: attackTarget ? 'Choose a target for attack' : e.prompt ?? null, action: { kind: asCard ? 'card' : 'button', label }, legal });
            }
        } else if (e.t === 'RESOURCE') {
            step({ seg: start.get(key) ?? i, prompt: 'resource|multiple', title: 'Select cards to resource', action: { kind: 'card', label: name(e.card) } });
        } else {
            step({ prompt: 'mulligan|-', title: 'Mulligan', action: { kind: 'button', label: e.t === 'MULLIGAN' ? 'Mulligan' : 'Keep' } });
        }
    });
    steps.sort((a, b) => a.seg - b.seg || a.ord - b.ord || a.i - b.i);
    return steps;
}

// ── convert ─────────────────────────────────────────────────────────────────────────────────────────────────────

const RESULT_SEAT = { P1: 'p1', P2: 'p2', Draw: 'draw' };

function howEnded(reason) {
    const r = String(reason ?? '');
    if (/concession|concede/i.test(r)) {
        return 'concede';
    }
    if (/base destroyed/i.test(r)) {
        return 'base destroyed';
    }
    if (/time/i.test(r)) {
        return 'timeout';
    }
    if (/left|disconnect/i.test(r)) {
        return 'left';
    }
    return r || null;
}

/** The deck lists and deck orders, by seat, with the file's own ids. */
function deckInfo(doc) {
    const decks = {};
    for (const d of doc.decks) {
        if (isSeat(d.p)) {
            decks[`p${d.p}`] = { leader: d.leader, base: d.base, deck: arr(d.deck), ...(d.sideboard ? { sideboard: arr(d.sideboard) } : {}) };
        }
    }
    const init = doc.setup.find((r) => r.t === 'INIT');
    const deckOrder = init ? { p1: arr(init.p1DeckOrder), p2: arr(init.p2DeckOrder) } : null;
    return { decks, deckOrder };
}

/** The board a reader can know before the first keyframe: deck sizes (INIT or DECKS), leaders (header), base HP. */
function seededState(doc, events, deckOrder, decks) {
    const s = emptyState();
    const firstKf = events.find((e) => hasKeyframe(e) && isCompleteKeyframe(e.keyframe))?.keyframe;
    for (const seat of [1, 2]) {
        const ps = s.players[seat];
        const order = deckOrder?.[`p${seat}`];
        const listed = decks[`p${seat}`]?.deck;
        if (order?.length) {
            ps.deckSize = order.length;
        } else if (listed?.length) {
            ps.deckSize = listed.reduce((a, x) => a + (Number(arr(x)[1]) || 0), 0);
        }
        const leader = doc.tags[`P${seat}Leader`];
        if (leader) {
            ps.leader = { id: leader, deployed: false, exhausted: false, epicActionUsed: false };
        }
        // nothing in the stream carries a base's starting HP; the first keyframe does, and no damage precedes it
        const kp = firstKf?.players?.[seat];
        if (typeof kp?.baseMaxHp === 'number') {
            ps.baseMaxHp = kp.baseMaxHp;
            ps.baseHp = kp.baseMaxHp;
        }
    }
    return s;
}

/**
 * Convert a .swupgn text to replay events.
 *
 * @param {string} text the file
 * @param {object} [opts]
 * @param {string[]} [opts.names] display names for p1, p2 (default 'p1', 'p2')
 * @param {object} [opts.source] provenance merged into header.source (kind, file, ...)
 * @returns {{events: object[], report: object}} report.keyframeMismatches lists fold-vs-keyframe differences (a
 *   conformant file has none); report.trace has, per step, the decision's seq and the record index its board is cut at.
 */
function convertSwuPgn(text, opts = {}) {
    const doc = parseSwuPgn(text);
    const events = linkActionSteps(doc.events);
    const nm = makeNamer(doc, events);
    const { decks, deckOrder } = deckInfo(doc);
    const report = { records: events.length, steps: 0, pov: 'both', keyframes: 0, keyframeMismatches: [], damagedKeyframes: [], ignored: [], unknownTypes: {}, messages: 0, trace: [] };
    const warn = (why, e) => {
        if (why === 'unknown type') {
            report.unknownTypes[e.t] = (report.unknownTypes[e.t] ?? 0) + 1;
        } else {
            report.ignored.push({ seq: e.seq, why });
        }
    };
    const perspective = doc.tags.Perspective === 'P1' ? 'p1' : doc.tags.Perspective === 'P2' ? 'p2' : null;
    report.pov = perspective ?? 'both';

    let s = seededState(doc, events, deckOrder, decks);
    let ptr = 0;
    let firstKf = true;
    /** Fold records [ptr, end) onto s; returns their story lines. */
    const advance = (end) => {
        const lines = [];
        for (; ptr < end; ptr++) {
            const e = events[ptr];
            if (hasKeyframe(e)) {
                if (isCompleteKeyframe(e.keyframe)) {
                    if (e.t === 'ROUND_START') {
                        s.initiativeTaken = false;
                    }
                    report.keyframes++;
                    report.keyframeMismatches.push(...diffKeyframe(e.seq, e.keyframe, s, firstKf));
                    firstKf = false;
                    const prev = s;
                    s = structuredClone(e.keyframe);
                    // a keyframe replaces the board; keep what an older keyframe may leave out
                    for (const seat of [1, 2]) {
                        s.players[seat].deckSize ??= prev.players[seat].deckSize;
                        s.players[seat].leader ??= prev.players[seat].leader;
                    }
                    continue;
                }
                report.damagedKeyframes.push(e.seq); // ignored, keep folding (spec 13)
            }
            reduce(s, e, warn);
            if (isInitiativeChoice(e) && isSeat(e.p) && (e.chose === 0 || e.chose === 1)) {
                s.initiative = e.chose === 0 ? e.p : 3 - e.p; // 'Yourself' / 'Opponent': who starts with the initiative
            }
            const line = storyLine(e.t === 'PHASE_START' ? { ...e, round: s.round } : e, nm);
            if (line) {
                lines.push(line);
            }
        }
        return lines;
    };

    const decisions = decisionSteps(events, nm);
    const out = [];
    const startCut = decisions[0]?.seg ?? events.length;
    const startLines = advance(startCut);
    out.push({ t: 'step', n: 0, label: 'Game start', state: compactSnapshot(s, nm), ...(startLines.length ? { log: startLines } : {}) });
    report.messages += startLines.length;
    report.trace.push({ n: 0, seq: null, cut: startCut });
    decisions.forEach((d, k) => {
        const cut = k + 1 < decisions.length ? decisions[k + 1].seg : events.length;
        const lines = advance(cut);
        report.messages += lines.length;
        report.trace.push({ n: k + 1, seq: d.seq, cut });
        out.push({
            t: 'step', n: k + 1, pid: d.pid, prompt: d.prompt, title: d.title ?? null, action: d.action, legal: d.legal,
            seq: d.seq, ...(d.synthetic ? { synthetic: 1 } : {}), ...(lines.length ? { log: lines } : {}), state: compactSnapshot(s, nm)
        });
    });
    report.steps = decisions.length;
    report.undos = Number(doc.tags.Undos ?? 0) || events.filter((e) => e.t === 'UNDO').length;

    // the end: GAME_END says who won; the header's Result says the same for a finished game
    const gameEnd = [...events].reverse().find((e) => e.t === 'GAME_END');
    const fromRecord = gameEnd ? (gameEnd.winner === 'Draw' ? 'draw' : isSeat(gameEnd.winner) ? `p${gameEnd.winner}` : null) : null;
    const fromHeader = RESULT_SEAT[doc.tags.Result] ?? null;
    const winner = fromRecord ?? fromHeader;
    if (fromRecord && fromHeader && fromRecord !== fromHeader) {
        report.resultConflict = { gameEnd: fromRecord, header: fromHeader };
    }
    const how = winner ? howEnded(gameEnd?.reason ?? doc.tags.Reason) : null;

    const names = opts.names ?? ['p1', 'p2'];
    const deckName = (seat) => [nm.title(doc.tags[`P${seat}Leader`]), nm.title(doc.tags[`P${seat}Base`])].filter(Boolean).join(' / ');
    const engine = /@(.+)$/.exec(doc.tags.Engine)?.[1];
    const t = doc.tags;
    out.unshift({
        t: 'header', v: 1, seed: 0, engine: engine && engine !== 'unknown' ? engine : null,
        players: [1, 2].map((seat) => ({ id: `p${seat}`, bot: names[seat - 1] ?? `p${seat}`, deck: deckName(seat), human: true })),
        source: {
            ...(opts.source ?? {}),
            format: 'swu-pgn',
            version: t.Game,
            pov: report.pov,
            hiddenHands: perspective ? [perspective === 'p1' ? 'p2' : 'p1'] : [],
            synthetic: ['seed', 'prompt', 'title', 'action', 'legal'],
            gameId: t.GameId, date: t.Date, ...(t.EndDate ? { endDate: t.EndDate } : {}),
            ...(t.Format ? { gameFormat: t.Format } : {}), cardPool: t.CardPool, engineBuild: t.Engine, pgnSeed: t.Seed,
            ...(t.Match ? { match: t.Match } : {}), ...(t.GameNumber ? { gameNumber: Number(t.GameNumber) } : {}),
            result: t.Result, reason: t.Reason, rounds: Number(t.Rounds),
            ...(t.Undos ? { undos: Number(t.Undos) } : {}), ...(t.RecorderErrors ? { recorderErrors: Number(t.RecorderErrors) } : {}),
            ...(Object.keys(decks).length ? { decks } : {}),
            ...(deckOrder ? { deckOrder } : {}),
            cards: Object.fromEntries(nm.names),
            check: { keyframes: report.keyframes, mismatches: report.keyframeMismatches.length, damagedKeyframes: report.damagedKeyframes.length, ignoredRecords: report.ignored.length },
            ...(doc.annotations.length ? { annotations: doc.annotations.length } : {})
        }
    });
    const last = out[out.length - 1].state;
    out.push({
        t: 'end', winner, round: last.round, steps: decisions.length,
        outcome: winner ? 'won' : 'STUCK',
        error: winner ? null : `game file ends before the game did (Result "${t.Result}", Reason "${t.Reason}")`,
        ...(how ? { how } : {})
    });
    report.winner = winner;
    report.how = how;
    return { events: out, report, doc };
}

module.exports = { isSwuPgn, parseSwuPgn, fold, reduce, emptyState, isCompleteKeyframe, diffKeyframe, linkActionSteps, isTopAction, decisionSteps, convertSwuPgn, storyLine };
