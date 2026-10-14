'use strict';
// Runs the Rust simulator in step with a forceteki game and records every place the two disagree. One mirror follows
// one line of play: a real game (bot/match.js `watch`) or one simulation of a bot's lookahead (bot/protocol.js).
// forceteki stays the referee; the mirror only reads it. After a disagreement the mirror waits for the next action
// window and loads forceteki's state again, so one game can show several findings.
const { isDeepStrictEqual } = require('util');
const { fullState, canonicalAction, expandActions } = require('./state');

const norm = (key) => JSON.stringify(JSON.parse(key));
const ids = (value, out = new Set()) => {
    if (typeof value === 'string' && /^c\d+$/.test(value)) out.add(value);
    else if (Array.isArray(value)) value.forEach((v) => ids(v, out));
    return out;
};

/** Paths where two plain JSON values differ, at most `limit`. */
function diffPaths(a, b, path = '', out = [], limit = 12) {
    if (out.length >= limit) return out;
    if (a === b) return out;
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
        if (Array.isArray(a) && a.length !== b.length) {
            out.push({ path: `${path}.length`, forceteki: b.length, rust: a.length });
        }
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${path}.${k}`, out, limit);
        return out;
    }
    out.push({ path, forceteki: b, rust: a });
    return out;
}

/** Every card the state shows, by stable id: { c17: 'SOR_010', ... }. */
function cardIndex(state) {
    const index = {};
    const add = (c) => {
        if (!c?.id) return;
        index[c.id] = c.setCode;
        (c.upgrades ?? []).forEach(add);
    };
    for (const p of Object.values(state?.players ?? {})) {
        [p.base, p.leader, ...p.hand, ...p.deck, ...p.resources, ...p.discard, ...p.ground, ...p.space].forEach(add);
    }
    return index;
}

class RustMirror {
    /**
     * simulator: a WasmSimulator (bot/omni/wasm/node.js). meta: the trace header for repro files (seed, bots, decks,
     * pool provenance). report(finding): called once per disagreement. source: 'game' or 'sim'.
     */
    constructor(simulator, { meta, report, source = 'game', views = null }) {
        this.simulator = simulator;
        this.meta = meta;
        this.report = report;
        this.source = source;
        this.views = views; // a RustViews: also compare the protocol views a bot would get from Rust (first difference per line)
        this.game = null; // the Rust game, null until the next action window loads one
        this.rows = []; // trace rows since the last load, for the repro file
        this.pending = null; // the forceteki decision waiting for its action
        this.deferred = null; // an action-set disagreement waiting for the bot's choice
        this.lastAction = null;
        this.index = {};
        this.stats = { decisions: 0, windows: 0, loads: 0, findings: 0, skipped: null };
    }

    /** Before `pid` chooses from forceteki's `actions` (step = moves made so far in this line). */
    pre(eg, pid, actions, step) {
        if (this.stats.skipped) return;
        const window = eg.isActionWindow(pid);
        if (window) {
            const state = fullState(eg, pid);
            if (this.game) {
                const rust = this.game.snapshot();
                if (isDeepStrictEqual(rust, state)) {
                    this.stats.windows++;
                } else {
                    this.rows.push({ type: 'state', step, state });
                    this.fail('state', eg, step, { diff: diffPaths(rust, state), cards: this.stateCards(rust, state) });
                }
            }
            if (!this.game && !this.load(state)) {
                return;
            }
            this.index = cardIndex(state);
            this.rows = [{ type: 'state', step, state }];
        }
        if (!this.game) return;
        let fk;
        try {
            fk = expandActions(eg, actions).map((a) => canonicalAction(eg, a));
        } catch (e) {
            return this.drop(`forceteki actions not comparable: ${e.message}`);
        }
        const seat = eg.seatOf(pid);
        const p = eg.player(pid).currentPrompt();
        this.pending = {
            type: 'decision', step, actor: seat,
            prompt: { type: p.promptType ?? null, title: p.menuTitle ?? null, selected: (eg.player(pid).promptState.selectedCards ?? []).map((c) => eg.cardId(c.uuid)), actionWindow: window },
            actions: fk, chosen: null, events: []
        };
        let rust;
        try {
            rust = this.game.legalActions(seat);
        } catch (e) {
            // like an action-set disagreement: reported with the bot's choice, so `omni-rs check` replays it
            this.deferred = { kind: 'rust-error', error: e.message };
            return;
        }
        const have = new Set(rust.map((a) => norm(a.key)));
        const want = new Set(fk.map((a) => norm(a.key)));
        const onlyRust = [...have].filter((k) => !want.has(k));
        const onlyForceteki = [...want].filter((k) => !have.has(k));
        if (onlyRust.length || onlyForceteki.length || this.game.isActionWindow(seat) !== window) {
            // reported once the bot has chosen, so the repro file holds a complete decision for `omni-rs check`
            const cards = [...ids([...onlyRust, ...onlyForceteki].map((k) => JSON.parse(k)[1]))];
            this.deferred = { onlyRust, onlyForceteki, windowFlag: { rust: this.game.isActionWindow(seat), forceteki: window }, cards: this.named(cards) };
        } else if (this.views && !this.viewDone) {
            this.compareViews(eg, pid, actions, rust, window, step);
        }
    }

    /** The protocol views of this position from Rust (bot/omni/rs/rust-view.js) against bot/view.js on forceteki. */
    compareViews(eg, pid, actions, rust, window, step) {
        const { view, actionView } = require('../../view');
        const seat = eg.seatOf(pid);
        const snap = this.game.snapshot();
        const plain = (list) => list.filter((a) => a.kind !== 'distribute').map(({ i, ...a }) => JSON.stringify(Object.fromEntries(Object.entries(a).sort()))).sort();
        const fk = plain(actions.map((a, i) => actionView(eg, a, i, pid)));
        const rs = plain(this.views.actions(snap, rust));
        const diff = [];
        this.stats.viewChecks = (this.stats.viewChecks ?? 0) + 1;
        if (JSON.stringify(fk) !== JSON.stringify(rs)) {
            diff.push(...diffPaths(rs, fk, '.actions'));
        }
        if (window) {
            diff.push(...diffPaths(this.views.view(snap, seat), view(eg, seat), '.view'));
        }
        if (diff.length) {
            this.viewDone = true;
            this.stats.findings++;
            this.report({ kind: 'view', source: this.source, step, round: eg.round, phase: eg.phase, diff, cards: [], repro: [] });
        }
    }

    /** After forceteki applied `action` for `pid`; `split` is what eg.apply returned (engine uuids). */
    post(eg, pid, action, split) {
        if (!this.game || !this.pending) return;
        const key = canonicalAction(eg, split ? { ...action, split } : action).key;
        this.pending.chosen = key;
        this.rows.push(this.pending);
        const step = this.pending.step;
        this.pending = null;
        if (this.deferred) {
            const { kind = 'actions', ...detail } = this.deferred;
            this.deferred = null;
            return this.fail(kind, eg, step, { ...detail, chosen: key });
        }
        this.lastAction = key;
        try {
            this.game.apply(eg.seatOf(pid), key);
            this.stats.decisions++;
        } catch (e) {
            this.fail('apply', eg, this.rows.at(-1).step, { error: e.message, chosen: key });
        }
    }

    /** At the end of the line: compare the final state and winner when the game is over. */
    end(eg) {
        if (this.deferred) {
            // the line stopped before the bot chose (a game error or the end of a simulation)
            this.rows.push(this.pending);
            const { kind = 'actions', ...detail } = this.deferred;
            this.deferred = null;
            this.fail(kind, eg, this.rows.at(-1).step, detail);
        }
        if (this.game && eg.over) {
            const state = fullState(eg);
            const rust = this.game.snapshot();
            if (!isDeepStrictEqual(rust, state) || this.game.winner !== eg.winner) {
                this.fail('terminal', eg, null, { winner: { rust: this.game.winner, forceteki: eg.winner }, diff: diffPaths(rust, state), cards: this.stateCards(rust, state) });
            }
        }
        this.free();
    }

    load(state) {
        try {
            this.game = this.simulator.loadState(state);
            this.stats.loads++;
            return true;
        } catch (e) {
            // a card outside the Rust catalog is not a disagreement: this line cannot be checked
            this.stats.skipped = e.message.split('\n')[0];
            this.game = null;
            return false;
        }
    }

    drop(why) {
        this.stats.skipped ??= why;
        this.free();
    }

    fail(kind, eg, step, detail) {
        this.stats.findings++;
        const last = this.lastAction ? JSON.parse(this.lastAction) : null;
        this.report({
            kind, source: this.source, step, round: eg.round, phase: eg.phase,
            lastAction: this.lastAction, lastCard: last?.[1] ? { id: last[1], setCode: this.index[last[1]] ?? null } : null,
            ...detail,
            repro: [{ type: 'meta', schema: 'omni-rs-trace-v1', ...this.meta }, ...this.rows]
        });
        // wait for the next action window, then follow forceteki again
        this.free();
    }

    named(cardIds) {
        return cardIds.map((id) => ({ id, setCode: this.index[id] ?? null }));
    }

    stateCards(rust, state) {
        const index = { ...cardIndex(rust), ...cardIndex(state) };
        const touched = new Set();
        for (const d of diffPaths(rust, state, '', [], 40)) {
            const m = /^\.players\.(p[12])\.(\w+)\.?(\d+)?/.exec(d.path);
            if (!m) continue;
            for (const side of [rust, state]) {
                const zone = side.players?.[m[1]]?.[m[2]];
                const card = Array.isArray(zone) ? zone[Number(m[3])] : zone;
                if (card?.id) touched.add(card.id);
            }
        }
        return [...touched].map((id) => ({ id, setCode: index[id] ?? null }));
    }

    free() {
        this.game?.free();
        this.game = null;
        this.pending = null;
        this.deferred = null;
    }
}

module.exports = { RustMirror, diffPaths, cardIndex };
