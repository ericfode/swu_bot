'use strict';

/**
 * Headless environment over the forceteki engine.
 *
 * Usage (from the repo root, after `npm run get-cards` and `npm run build`):
 *   const { Env } = require('./bot/env');
 *   const env = new Env();                       // loads card data once (slow-ish)
 *   const game = env.newGame({ seed: 'abc', deck1, deck2 });
 *   game.legalActions(pid) -> [{kind, label, ...}]
 *   game.apply(pid, action)
 */
const path = require('path');
const { seededRng } = require('./rng');

// Quiet the engine's rollback logging and Discord reporting (same switch the test harness uses). Must be set before the engine loads.
process.env.NODE_ENV ??= 'test';

const root = path.resolve(__dirname, '..', 'forceteki');
const b = (p) => require(path.join(root, 'build/server', p));

const { Game } = b('game/core/Game.js');
const { Deck } = b('utils/deck/Deck.js');
const { UnitTestCardDataGetter } = b('utils/cardData/UnitTestCardDataGetter.js');
const { getUserWithDefaultsSet } = b('Settings.js');
const { setCodeToString } = b('Util.js');
const { UndoMode } = b('game/core/snapshot/SnapshotManager.js');
const { cards: implementedCards, overrideNotImplementedCards } = b('game/cards/Index.js');
const { Card } = b('game/core/card/Card.js');

const scheduler = {
    setTimeout: () => ({ cancel: () => undefined }),
    setInterval: () => ({ cancel: () => undefined }),
    now: () => Date.now(),
    currentDate: () => new Date()
};

class EngineError extends Error {}

function makeRouter(sink) {
    const noop = () => undefined;
    const handlers = {
        handleError: (game, error) => {
            sink.error = error; throw error;
        },
        handleSerializationFailure: (game, error) => {
            sink.error = error; throw error;
        }
    };
    return new Proxy({}, { get: (_t, name) => handlers[name] ?? noop });
}

class Env {
    constructor(cardJsonDir = path.join(root, 'test/json')) {
        this.cardDataGetter = new UnitTestCardDataGetter(cardJsonDir);
        this.mockNames = new Set(require(path.join(cardJsonDir, '_mockCardNames.json')));
        this._index = null;
    }

    /**
     * forceteki's rule (Card.isImplemented, DeckValidator): the class does not mark the card as not implemented, and the
     * card has a class or no ability text beyond keywords.
     */
    isImplemented(c) {
        return !overrideNotImplementedCards.has(c.id) &&
            (implementedCards.has(c.id) || implementedCards.has(c.internalName) || !Card.checkHasNonKeywordAbilityText(c));
    }

    /** Index of usable cards, built lazily by reading every card json once. */
    index() {
        if (this._index) {
            return this._index;
        }
        const g = this.cardDataGetter;
        const leaders = [],
            bases = [],
            pool = [];
        for (const id of g.cardIds) {
            const c = g.getCardSync(id);
            if (this.mockNames.has(c.internalName)) {
                continue;
            }
            if (!implementedCards.has(c.id) && !implementedCards.has(c.internalName)) {
                continue;
            }
            const setCode = setCodeToString(c.setId);
            if (!g.setCodeMap.has(setCode)) {
                continue;
            }
            const entry = { id: c.id, internalName: c.internalName, setCode, aspects: c.aspects ?? [], types: c.types, cost: c.cost, unique: !!c.unique };
            if (c.types.includes('leader')) {
                leaders.push(entry);
            } else if (c.types.includes('base')) {
                bases.push(entry);
            } else if (c.types.some((t) => ['unit', 'event', 'upgrade'].includes(t))) {
                pool.push(entry);
            }
        }
        this._index = { leaders, bases, pool };
        return this._index;
    }

    /** Random legal-ish 50-card deck. `rng` is a function returning [0,1). */
    randomDeck(rng, { size = 50, maxCopies = 3, pool: subset = null } = {}) {
        let { leaders, bases, pool } = this.index();
        if (subset) {
            // Resolve through the authoritative card getter: keyword-only cards may have no explicit engine class.
            if (!Array.isArray(subset.cards)) throw new Error('Pool must have a cards array');
            const seen = new Set();
            const entries = subset.cards.filter((c) => !c.types.includes('token')).map((entry) => {
                if (seen.has(entry.setCode)) throw new Error(`Duplicate pool card ${entry.setCode}`);
                seen.add(entry.setCode);
                const data = this.cardDataGetter.getCardSync(entry.id);
                if (!data || !this.isImplemented(data) || setCodeToString(data.setId) !== entry.setCode) {
                    throw new Error(`Unsupported pool card ${entry.setCode} (${entry.internalName})`);
                }
                return { ...data, setCode: entry.setCode };
            });
            leaders = entries.filter((c) => c.types.includes('leader'));
            bases = entries.filter((c) => c.types.includes('base'));
            pool = entries.filter((c) => c.types.some((t) => ['unit', 'event', 'upgrade'].includes(t)) && !c.types.includes('leader'));
            if (!leaders.length || !bases.length) throw new Error('Pool must contain leaders and bases');
            for (const l of leaders) for (const b of bases) {
                const icons = new Set([...l.aspects, ...b.aspects]);
                const capacity = pool.filter((c) => c.aspects.every((a) => icons.has(a))).reduce((n, c) => n + (c.unique ? 1 : maxCopies), 0);
                if (capacity < size) throw new Error(`Pool cannot fill ${size}-card deck for ${l.setCode}/${b.setCode} (capacity ${capacity})`);
            }
        }
        const pick = (a) => a[Math.floor(rng() * a.length)];
        const leader = pick(leaders),
            base = pick(bases);
        const allowed = new Set([...leader.aspects, ...base.aspects]);
        const legal = pool.filter((c) => c.aspects.every((a) => allowed.has(a)));
        const counts = new Map();
        const deck = [];
        let guard = 0;
        while (deck.length < size && guard++ < 10000) {
            const c = pick(legal);
            const n = counts.get(c.setCode) ?? 0;
            if (n >= (c.unique ? 1 : maxCopies)) {
                continue;
            }
            counts.set(c.setCode, n + 1);
            deck.push(c.setCode);
        }
        if (subset && deck.length !== size) throw new Error(`Pool deal produced ${deck.length}, expected ${size} cards`);
        const tally = {};
        deck.forEach((s) => {
            tally[s] = (tally[s] ?? 0) + 1;
        });
        return {
            metadata: { name: `${leader.internalName} / ${base.internalName}`, author: 'bot' },
            leader: { id: leader.setCode, count: 1 },
            base: { id: base.setCode, count: 1 },
            deck: Object.entries(tally).map(([id, count]) => ({ id, count })),
            isPresentInDb: false
        };
    }

    /**
     * selectionToggles (default off): in a SelectCardPrompt, list selected cards as unselect toggles and drop
     * unselected cards once the limit is reached, as the prompt's click handler does. The Rust/Wasm reference
     * traces (bot/omni/rs, bot/cards/reference) turn it on; everything else keeps the original action list, so
     * the gate and old replays are unchanged.
     */
    newGame({ seed = 'seed', deck1, deck2, undo = false, names = ['p1', 'p2'], selectionToggles = false } = {}) {
        return new EnvGame(this, { seed, deck1, deck2, undo, names, selectionToggles });
    }
}

class EnvGame {
    constructor(env, { seed, deck1, deck2, undo, names, selectionToggles = false }) {
        this.sink = { error: null };
        this.selectionToggles = selectionToggles;
        this.ids = ['111', '222'];
        this.names = names;
        const players = this.ids.map((id, i) => getUserWithDefaultsSet({
            id, username: names[i], settings: { optionSettings: { autoSingleTarget: false } }
        }));
        this.game = new Game({
            id: `bot-${seed}`, owner: names[0], allowSpectators: false, players,
            cardDataGetter: env.cardDataGetter, pushUpdate: () => undefined, scheduler,
            userTimeoutDisconnect: () => undefined,
            undoMode: undo ? UndoMode.Free : UndoMode.Disabled
        }, { router: makeRouter(this.sink) });
        if (undo) {
            // with undo on, an unpayable cost would offer an 'Undo' that rolls the game back; keep the rules of undo off
            this.game.costPaymentRecoveryPolicy = { allowRollback: () => false, rollbackRequiresApproval: () => false, allowAbandon: () => true };
        }
        this.idx = new Map();
        this.game.setRandomSeed(String(seed));
        this.game.selectDeck(this.ids[0], new Deck(deck1, env.cardDataGetter));
        this.game.selectDeck(this.ids[1], new Deck(deck2, env.cardDataGetter));
        this.started = false;
    }

    async start() {
        await this.game.initialiseAsync();
        this.started = true;
    }

    get over() {
        return this.game.winnerNames.length > 0;
    }

    get winners() {
        return [...this.game.winnerNames];
    }

    /** Seat ('p1' | 'p2') of an engine player id, and back. */
    seatOf(pid) {
        return `p${this.ids.indexOf(pid) + 1}`;
    }

    pidOf(seat) {
        return this.ids[Number(seat.slice(1)) - 1];
    }

    /**
     * Stable id of a card for bots and replays: 'c' + its index in the engine's list of all cards (deck-list order,
     * then tokens in creation order). Engine uuids drift across rollbacks, since the counter that names new objects is
     * not rolled back; the list is game state, so a rollback restores it.
     */
    cardId(uuid) {
        const all = this.game.state.allCards;
        let i = this.idx.get(uuid);
        if (all[i] !== uuid) {
            i = all.indexOf(uuid);
            this.idx.set(uuid, i);
        }
        return i < 0 ? uuid : `c${i}`;
    }

    /** Engine uuid of a card id (an unknown id comes back unchanged). */
    uuidOf(id) {
        return (typeof id === 'string' && /^c\d+$/.test(id) && this.game.state.allCards[Number(id.slice(1))]) || id;
    }

    /** Winning seat, 'draw', or null while the game is on. */
    get winner() {
        const w = this.winners;
        return w.length === 0 ? null : w.length > 1 ? 'draw' : this.seatOf(this.ids[this.names.indexOf(w[0])]);
    }

    get phase() {
        return this.game.currentPhase;
    }

    get round() {
        return this.game.roundNumber;
    }

    player(pid) {
        return this.game.getPlayerById(pid);
    }

    /** Signature of the prompt for diagnostics: what shape of prompt is this? */
    promptSignature(pid) {
        const p = this.player(pid).currentPrompt();
        return [p.promptType || '-', p.selectCardMode || '-', p.distributeAmongTargets ? 'dist' : '', p.selectNumber ? 'num' : '',
            p.dropdownListOptions?.length ? 'dd' : '', p.displayCards?.length ? 'disp' : '', p.perCardButtons?.length ? 'pcb' : '',
            p.batchTriggerResolution ? 'batch' : ''].filter(Boolean).join('|');
    }

    /** Every action pid can legally take right now (may be empty if pid is just waiting). */
    legalActions(pid) {
        const pl = this.player(pid);
        const p = pl.currentPrompt();
        const ps = pl.promptState;
        const out = [];

        for (const btn of p.buttons ?? []) {
            if (btn.disabled) {
                continue;
            }
            // the distribute prompt's Done button is submitted via statefulPromptResults (see 'distribute' below), not as a menu click
            if (btn.command === 'statefulPromptResults') {
                continue;
            }
            out.push({ kind: 'button', label: String(btn.text), arg: btn.arg, uuid: btn.uuid, method: btn.method });
        }

        if (p.distributeAmongTargets) {
            const legal = ps.selectableCards;
            // indirect damage dealt to a unit may not exceed its remaining HP (bases are uncapped)
            const capped = p.distributeAmongTargets.type === 'distributeIndirectDamage';
            const caps = legal.map((c) => (capped && c.isUnit() ? Math.max(0, c.remainingHp) : Infinity));
            out.push({ kind: 'distribute', label: `distribute ${p.distributeAmongTargets.amount}`, spec: p.distributeAmongTargets, targets: legal.map((c) => c.uuid), caps, uuid: p.promptUuid });
        } else {
            // SelectCardPrompt highlights candidates more broadly than its click
            // handler at the selection limit. With selectionToggles, inspect the
            // active nested prompt; selected cards are valid toggles, except
            // protected must-selects.
            let selectionPrompt = null;
            let step = this.selectionToggles ? this.game.pipeline?.currentStep : null;
            const visited = new Set();
            while (step && !visited.has(step)) {
                visited.add(step);
                if (step.constructor?.name === 'SelectCardPrompt' && step.choosingPlayer === pl) {
                    selectionPrompt = step;
                    break;
                }
                step = step.pipeline?.currentStep;
            }
            const selected = new Set((ps.selectedCards ?? []).map((c) => c.uuid));
            for (const c of ps.selectableCards ?? []) {
                if (selectionPrompt) {
                    const isSelected = selectionPrompt.selectedCards.includes(c);
                    if (isSelected && selectionPrompt.cannotUnselectMustSelect && selectionPrompt.properties.mustSelect.includes(c)) continue;
                    if (!isSelected && selectionPrompt.selector.hasReachedLimit(selectionPrompt.selectedCards, selectionPrompt.context)) continue;
                } else if (selected.has(c.uuid)) {
                    continue;
                }
                out.push({ kind: 'card', label: c.internalName ?? c.name, cardUuid: c.uuid, card: c });
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

        const hasPerCardButtons = (p.perCardButtons ?? []).length > 0;
        for (const dc of p.displayCards ?? []) {
            // in a "cards with buttons" prompt the cards themselves are not clickable; only the per-card buttons are
            if (!hasPerCardButtons && dc.selectionState === 'selectable') {
                out.push({ kind: 'displayCard', label: dc.internalName, arg: dc.cardUuid, uuid: p.promptUuid });
            }
            for (const pcb of p.perCardButtons ?? []) {
                if (pcb.disabled) {
                    continue;
                }
                out.push({ kind: 'perCardButton', label: `${pcb.text}:${dc.internalName}`, arg: pcb.arg, cardUuid: dc.cardUuid, uuid: p.promptUuid });
            }
        }
        return out;
    }

    /** True when pid is at the top-level "choose an action" prompt of the action phase (the only place rollback is exact). */
    isActionWindow(pid) {
        return this.phase === 'action' && this.promptSignature(pid).startsWith('actionWindow');
    }

    /** Take a manual snapshot to roll back to (needs newGame({undo: true})). Returns an id, or -1 when undo is off. */
    mark(pid) {
        return this.game.takeManualSnapshot(this.player(pid));
    }

    /** Roll back to a mark taken at an action window. Clears any engine error left over from a failed playout. */
    restore(pid, id) {
        this.sink.error = null;
        const ok = this.game.rollbackToSnapshotInternal({ type: 'manual', playerId: this.player(pid).id, snapshotId: id });
        if (!ok) {
            throw new EngineError('rollback failed');
        }
    }

    /** Prompt uuids change across a rollback, so a stale action object is rejected. Find the live equivalent of `a`. */
    refetch(pid, a) {
        return this.legalActions(pid).find((x) => sameAction(x, a)) ?? null;
    }

    /**
     * Apply one action, then let the engine run until it needs input again. A distribute action uses `a.split`
     * ([{id, amount}], see splitError) when set, otherwise a random legal split drawn from `rng`. Returns the split sent.
     */
    apply(pid, a, rng = Math.random) {
        const g = this.game;
        let split;
        switch (a.kind) {
            case 'button': g.menuButton(pid, a.arg, a.uuid, a.method); break;
            case 'card': g.cardClicked(pid, a.cardUuid); break;
            case 'option': g.menuButton(pid, a.arg, a.uuid); break;
            case 'displayCard': g.menuButton(pid, a.arg, a.uuid, 'menuButton'); break;
            case 'perCardButton': g.perCardMenuButton(pid, a.arg, a.cardUuid, a.uuid); break;
            case 'distribute':
                split = (a.split ?? randomSplit(a, rng)).filter((e) => e.amount > 0);
                g.statefulPromptResults(pid, { type: a.spec.type, valueDistribution: split.map((e) => ({ uuid: e.id, amount: e.amount })) }, a.uuid);
                break;
            default: throw new EngineError(`unknown action kind ${a.kind}`);
        }
        g.continue();
        return split;
    }
}

/** The same action, maybe from another prompt (prompt uuids change across a rollback). */
const sameAction = (a, b) => a.kind === b.kind && a.label === b.label && a.cardUuid === b.cardUuid && a.arg === b.arg;

/**
 * Why `split` is not a legal answer to distribute action `a`, or null if it is: listed targets only, each once,
 * integer amounts 0..cap, at most maxTargets non-zero entries, total = amount (<= amount with canDistributeLess,
 * 0 only with canChooseNoTargets).
 */
function splitError(a, split) {
    const { spec, targets, caps } = a;
    if (!Array.isArray(split)) {
        return 'split is not an array';
    }
    const seen = new Set();
    let sum = 0,
        used = 0;
    for (const e of split) {
        const k = targets.indexOf(e?.id);
        if (k < 0 || seen.has(e.id)) {
            return `unknown or repeated target ${e?.id}`;
        }
        if (!Number.isInteger(e.amount) || e.amount < 0 || e.amount > caps[k]) {
            return `amount ${e.amount} for ${e.id} is outside 0..${caps[k]}`;
        }
        seen.add(e.id);
        sum += e.amount;
        used += e.amount > 0 ? 1 : 0;
    }
    if (spec.maxTargets != null && used > spec.maxTargets) {
        return `more than ${spec.maxTargets} targets`;
    }
    if (sum === 0 ? !spec.canChooseNoTargets : spec.canDistributeLess ? sum > spec.amount : sum !== spec.amount) {
        return `total ${sum} is not allowed for amount ${spec.amount}`;
    }
    return null;
}

/** A random legal split. Draws from rng exactly as upstream's randomDistribution, so seeded games match upstream. */
function randomSplit(a, rng) {
    const { spec, targets, caps } = a;
    const max = Math.min(spec.maxTargets ?? targets.length, targets.length);
    const order = targets.map((_, i) => i).sort(() => rng() - 0.5);

    // take targets until their combined capacity can absorb the full amount (or we hit maxTargets)
    const chosen = [];
    let capacity = 0;
    for (const idx of order) {
        if (chosen.length >= max) {
            break;
        }
        if (caps[idx] <= 0) {
            continue;
        }
        chosen.push(idx);
        capacity += caps[idx];
        if (capacity >= spec.amount && chosen.length >= Math.max(1, Math.ceil(rng() * max))) {
            break;
        }
    }

    const given = new Map(chosen.map((idx) => [idx, 0]));
    for (let n = 0; n < spec.amount; n++) {
        const open = chosen.filter((idx) => given.get(idx) < caps[idx]);
        if (!open.length) {
            break;
        }
        const idx = open[Math.floor(rng() * open.length)];
        given.set(idx, given.get(idx) + 1);
    }
    return chosen.map((idx) => ({ id: targets[idx], amount: given.get(idx) }));
}

module.exports = { Env, EnvGame, EngineError, seededRng, sameAction, splitError, randomSplit };
