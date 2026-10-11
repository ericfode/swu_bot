'use strict';
/**
 * Read Karabast `gamestate` frames: legal actions for a seat, the socket message for an action, and a scrub that
 * removes everything that names a person before a frame is written to disk.
 *
 * A frame is forceteki's `Game.getState(viewerId)` (server/game/core/Game.ts), keyed by user id: `players[id]` holds
 * `cardPiles`, `leaders`, `base`, `forceToken`, `credits` and, for the viewer only, `promptState`. Selectable cards
 * carry `selectable: true` on their summary, so legal actions are rebuilt from those flags plus the prompt fields
 * that `bot/env.js` legalActions reads from the engine (same order and kinds).
 */

const isObj = (x) => x != null && typeof x === 'object';

/** Every card summary under `players` with a uuid (cards, leaders, bases, tokens, upgrades), each uuid once. */
function cardSummaries(frame) {
    const out = new Map();
    const walk = (x, key) => {
        if (!isObj(x) || key === 'promptState' || key === 'user') {
            return;
        }
        if (Array.isArray(x)) {
            x.forEach((v) => walk(v));
            return;
        }
        if (typeof x.uuid === 'string' && !out.has(x.uuid)) {
            out.set(x.uuid, x);
        }
        for (const [k, v] of Object.entries(x)) {
            walk(v, k);
        }
    };
    walk(frame?.players);
    return [...out.values()];
}

/** Remaining HP of a unit summary (null when it is no unit, so no cap applies). */
function remainingHp(card) {
    const unit = card.zone === 'groundArena' || card.zone === 'spaceArena';
    return unit && typeof card.hp === 'number' ? Math.max(0, card.hp - (card.damage ?? 0)) : null;
}

/**
 * The legal actions of user `me` in `frame`, in the shape of `bot/env.js` legalActions: kinds button, card,
 * distribute, option, displayCard and perCardButton. Empty while `me` is only waiting.
 */
function legalActions(frame, me) {
    const p = frame?.players?.[me]?.promptState;
    // the server fills promptState for the frame's own viewer only; selectable flags are that viewer's too
    if (!isObj(p) || !Object.keys(p).length) {
        return [];
    }
    const out = [];
    for (const btn of p.buttons ?? []) {
        // the distribute prompt's Done button is answered with statefulPromptResults (the 'distribute' action)
        if (btn.disabled || btn.command === 'statefulPromptResults') {
            continue;
        }
        out.push({ kind: 'button', label: String(btn.text), arg: btn.arg, uuid: btn.uuid, command: btn.command ?? 'menuButton' });
    }

    const cards = cardSummaries(frame);
    const selectable = cards.filter((c) => c.selectable === true && !c.selected);
    if (p.distributeAmongTargets) {
        const legal = cards.filter((c) => c.selectable === true);
        const capped = p.distributeAmongTargets.type === 'distributeIndirectDamage';
        const caps = legal.map((c) => (capped && remainingHp(c) != null ? remainingHp(c) : Infinity));
        out.push({ kind: 'distribute', label: `distribute ${p.distributeAmongTargets.amount}`, spec: p.distributeAmongTargets, targets: legal.map((c) => c.uuid), caps, uuid: p.promptUuid });
    } else {
        for (const c of selectable) {
            out.push({ kind: 'card', label: c.name ?? 'hidden card', cardUuid: c.uuid, card: c });
        }
    }

    for (const opt of p.dropdownListOptions ?? []) {
        out.push({ kind: 'option', label: String(opt), arg: String(opt), uuid: p.promptUuid });
    }
    if (p.selectNumber) {
        for (let n = p.selectNumber.min; n <= p.selectNumber.max; n++) {
            out.push({ kind: 'option', label: `#${n}`, arg: String(n), uuid: p.promptUuid });
        }
    }

    const perCard = (p.perCardButtons ?? []).filter((b) => !b.disabled);
    for (const dc of p.displayCards ?? []) {
        // in a "cards with buttons" prompt the cards themselves are not clickable; only the per-card buttons are
        if (!(p.perCardButtons ?? []).length && dc.selectionState === 'selectable') {
            out.push({ kind: 'displayCard', label: dc.internalName, arg: dc.cardUuid, uuid: p.promptUuid });
        }
        for (const pcb of perCard) {
            out.push({ kind: 'perCardButton', label: `${pcb.text}:${dc.internalName}`, arg: pcb.arg, cardUuid: dc.cardUuid, uuid: p.promptUuid, command: pcb.command ?? 'perCardMenuButton' });
        }
    }
    return out;
}

/**
 * The `game` event arguments that take action `a`, as the web client sends them. For `distribute`, `split` is
 * [{id: uuid, amount}] (zero amounts are dropped).
 */
function gameMessage(a, split = []) {
    switch (a.kind) {
        case 'button': return [a.command, a.arg, a.uuid];
        case 'card': return ['cardClicked', a.cardUuid];
        case 'option': return ['menuButton', a.arg, a.uuid];
        case 'displayCard': return ['menuButton', a.arg, a.uuid, 'menuButton'];
        case 'perCardButton': return [a.command, a.arg, a.cardUuid, a.uuid];
        case 'distribute': return ['statefulPromptResults', { type: a.spec.type, valueDistribution: split.filter((e) => e.amount > 0).map((e) => ({ uuid: e.id, amount: e.amount })) }, a.uuid];
        default: throw new Error(`unknown action kind ${a.kind}`);
    }
}

/** A key for "the same decision": the prompt uuid plus the legal actions. Frames repeat (timer ticks, chat). */
function decisionKey(frame, me, actions = legalActions(frame, me)) {
    const p = frame?.players?.[me]?.promptState ?? {};
    return JSON.stringify([p.promptUuid ?? null, p.menuTitle ?? null, actions.map((a) => [a.kind, a.label, a.cardUuid ?? null, a.arg ?? null])]);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Builds a scrubber for one game's frames. Player ids become `player1` / `player2` (in the order they first appear),
 * usernames become the same labels, and every spectator id or name becomes "a spectator". The scrubber drops `user`
 * objects (ids, names, settings, cosmetics), the spectator list and the text of player chat (a stub with
 * `type: 'playerChat'` keeps the log positions, so the importer still counts and drops it).
 *
 * Call `scrub(frame)` on every frame in order; it learns names as they appear and returns a new object.
 */
function makeScrubber(extraNames = []) {
    const labels = new Map(); // exact string -> replacement
    let words = null; // regex over names, for names inside longer strings
    let seats = 0;
    const learn = (s, label) => {
        if (typeof s === 'string' && s.trim() && !labels.has(s)) {
            labels.set(s, label);
            words = null;
        }
    };
    for (const n of extraNames) {
        learn(n, 'a spectator');
    }
    const replaceText = (s) => {
        if (labels.has(s)) {
            return labels.get(s);
        }
        if (!words) {
            const names = [...labels.keys()].filter((n) => n.length >= 2).sort((a, b) => b.length - a.length).map(escapeRe);
            words = names.length ? new RegExp(`(?<![\\w])(${names.join('|')})(?![\\w])`, 'g') : /$^/;
        }
        return s.replace(words, (m) => labels.get(m));
    };
    const isChat = (msg) => isObj(msg) && Array.isArray(msg.message) && isObj(msg.message[0]) && msg.message[0].type === 'playerChat';
    const clean = (x, key) => {
        if (typeof x === 'string') {
            return replaceText(x);
        }
        if (!isObj(x)) {
            return x;
        }
        if (Array.isArray(x)) {
            return x.map((v) => clean(v));
        }
        const out = {};
        for (const [k, v] of Object.entries(x)) {
            if (k === 'user' || k === 'cosmetics' || k === 'blockList') {
                continue;
            }
            out[labels.get(k) ?? k] = key === 'newMessages' ? v : clean(v, k);
        }
        return out;
    };
    return function scrub(frame) {
        for (const [id, p] of Object.entries(frame?.players ?? {})) {
            if (!labels.has(id)) {
                const label = `player${++seats}`;
                learn(id, label);
                learn(p?.user?.id, label);
                learn(p?.user?.username, label);
                learn(p?.name, label);
            }
        }
        for (const s of frame?.spectators ?? []) {
            learn(s?.id, 'a spectator');
            learn(s?.name, 'a spectator');
        }
        const out = clean({ ...frame, spectators: [] });
        if (Array.isArray(frame?.newMessages)) {
            out.newMessages = frame.newMessages.map((m) => (isChat(m) ? { date: m.date, message: [{ type: 'playerChat' }] } : clean(m)));
        }
        return out;
    };
}

module.exports = { legalActions, gameMessage, decisionKey, cardSummaries, makeScrubber, remainingHp };
