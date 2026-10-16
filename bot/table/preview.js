'use strict';
/**
 * What a person's move would do, worked out before they make it: the result preview of Holotable's play screen.
 *
 * Simulations (spec/protocol.md#sim) only start at an action window, so the preview is worked out when the person
 * answers one: right after their move `i` there, and before it goes to the referee, the seat plays `i` on the
 * referee's copy of the game, then each answer to the questions that follow (which unit to attack, which card to
 * target), and keeps what each answer changed on the board. The screen gets that result on each action of those
 * questions as they come (`decide.actions[k].preview`):
 *
 *   { cards: [{ id, d?, gone?, lost? }], more?: true, winner?: 'p1' | 'p2' }
 *
 * `d` is damage added to a unit or base (less than 0: healed), `gone` how the unit leaves play ('defeated', 'captured',
 * 'returned' to its owner's hand, or 'left' when the person cannot see where it went), `lost` the ids of its upgrades
 * that go (a Shield token that breaks). `more` says the move asks more questions after this one, of the person or of
 * the bot, so the result shown stops there. `winner` ends the game.
 *
 * A simulation re-deals every card the person cannot see, so a preview never shows those. The bot's choices are not
 * guessed: when the bot has more than one, the preview stops (`more`). Every simulation runs on the copy, never on the
 * real game, and a failed one only means no preview.
 */

/** At most this many answers are played out after one move, within this many milliseconds. */
const RUNS = 40;
const MS = 800;
/** A question with more answers than this gets no preview (each answer is one more playout). */
const MAX_ANSWERS = 16;
/** How many questions deep after the move (the person's own answers) a preview goes. */
const DEPTH = 3;
/** Forced moves of the bot played through, at most, before a preview stops. */
const SETTLE = 24;

/** An action's identity on the screen, the same on the copy as in the real game: its kind, card and words. */
const keyOf = (a) => `${a.kind}|${a.card?.id ?? ''}|${a.label}`;

/** Units and bases on the board by id: their damage, their upgrades' ids, and whether they are tokens (no set). */
function inPlay(state) {
    const m = new Map();
    for (const p of Object.values(state?.players ?? {})) {
        if (p.base) {
            m.set(p.base.id, { d: p.base.d ?? 0, u: [], token: false });
        }
        for (const u of [...(p.ground ?? []), ...(p.space ?? [])]) {
            m.set(u.id, { d: u.d ?? 0, u: (u.u ?? []).map((x) => x.id), token: u.s == null });
        }
    }
    return m;
}

/** Where a unit that left play went, as far as the seat sees: its discard, under a unit, a hand, or not known. */
function goneTo(state, id, token) {
    const players = Object.values(state?.players ?? {});
    if (players.some((p) => (p.discard ?? []).some((c) => c.id === id))) {
        return 'defeated';
    }
    if (players.some((p) => [...(p.ground ?? []), ...(p.space ?? [])].some((u) => (u.cap ?? []).some((c) => c.id === id)))) {
        return 'captured';
    }
    if (players.some((p) => (p.hand ?? []).some((c) => c.id === id))) {
        return 'returned';
    }
    // a defeated token leaves the game instead of going to a discard pile
    return token ? 'defeated' : 'left';
}

/** What changed on the board from `before` to `after` (seat states): damage, units that left, upgrades that went. */
function changes(before, after) {
    const now = inPlay(after);
    const out = [];
    for (const [id, a] of inPlay(before)) {
        const b = now.get(id);
        if (!b) {
            out.push({ id, gone: goneTo(after, id, a.token) });
            continue;
        }
        const c = { id };
        if (b.d !== a.d) {
            c.d = b.d - a.d;
        }
        const lost = a.u.filter((x) => !b.u.includes(x));
        if (lost.length) {
            c.lost = lost;
        }
        if (c.d !== undefined || c.lost) {
            out.push(c);
        }
    }
    return out;
}

/**
 * The previews that follow move `i` of the action window that `sim` belongs to (the `sim` function a protocol client
 * gets with decide): a Map from the person's answers after `i` (their indexes joined by spaces, '' for the first
 * question) to { keys, previews }, keys being the question's actions (keyOf) and previews[k] the result of answer k
 * (null when it has none). Never throws; the map is empty when `i` asks nothing more or the copy cannot play it.
 */
async function lookAhead(sim, i, { runs = RUNS, ms = MS, now = Date.now } = {}) {
    const tree = new Map();
    const until = now() + ms;
    let left = runs;
    let you = null;
    const ask = async (req) => {
        const r = await sim({ t: 'sim', ...req });
        if (!r || r.error) {
            throw new Error(r?.error ?? 'no reply');
        }
        return r;
    };
    /** Play the bot's forced moves (one legal action) until someone has a real choice, the turn passes or the game ends. */
    const settle = async (r) => {
        for (let n = 0; n < SETTLE && !r.over && !r.prompt.actionWindow && r.actor !== you && r.actions.length === 1; n++) {
            r = await ask({ op: 'act', i: 0 });
        }
        return r;
    };
    /** From the real position: move i, then the person's answers `path`. */
    const play = async (path) => {
        const start = await ask({ op: 'begin', deal: 0 });
        you ??= start.actor;
        let r = await settle(await ask({ op: 'act', i }));
        for (const k of path) {
            r = await settle(await ask({ op: 'act', i: k }));
        }
        return r;
    };
    /** A question the person answers (not an action window); the previews go on its actions. */
    const isQuestion = (r) => !r.over && !r.prompt.actionWindow && r.actor === you;

    const queue = [[]];
    try {
        while (queue.length && left > 0 && now() < until) {
            const path = queue.shift();
            const q = await play(path);
            if (!isQuestion(q) || q.actions.length > MAX_ANSWERS) {
                continue;
            }
            const node = { keys: q.actions.map(keyOf), previews: q.actions.map(() => null) };
            tree.set(path.join(' '), node);
            for (let k = 0; k < q.actions.length && left > 0 && now() < until; k++) {
                if (q.actions[k].kind === 'distribute') {
                    continue; // a split is the person's to choose; no single result to show
                }
                left--;
                const r = await play([...path, k]);
                const p = { cards: changes(q.state, r.state ?? q.state) };
                if (r.over) {
                    p.winner = r.over.winner;
                } else if (!r.prompt.actionWindow) {
                    p.more = true;
                    if (r.actor === you && path.length + 1 < DEPTH) {
                        queue.push([...path, k]);
                    }
                }
                node.previews[k] = p;
            }
        }
    } catch {
        // the copy could not play it (an engine error, the simulation closed): keep what was found
    } finally {
        await sim({ t: 'sim', op: 'end' });
    }
    return tree;
}

/**
 * The decision `msg` (a real decide) with node's previews on its actions, when the question matches the one the copy
 * saw; else `msg` unchanged. A copy: the referee's messages are shared objects.
 */
function withPreviews(msg, node) {
    if (!node || node.keys.length !== msg.actions.length || msg.actions.some((a, k) => keyOf(a) !== node.keys[k])) {
        return msg;
    }
    if (!node.previews.some(Boolean)) {
        return msg;
    }
    return { ...msg, actions: msg.actions.map((a, k) => (node.previews[k] ? { ...a, preview: node.previews[k] } : a)) };
}

module.exports = { lookAhead, withPreviews, changes, keyOf };
