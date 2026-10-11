'use strict';

/**
 * Heuristic bot: one-ply lookahead with rollback.
 *
 * At every action window it snapshots the game, tries each legal action (and, for the first follow-up prompt
 * such as an attack target, each option for it) on the real engine, scores the resulting board, rolls back,
 * and plays the best sequence. Card text is applied by the engine, so no card is special-cased here.
 * Prompts outside the action window (mulligan, resourcing, later targets) use the rule-based defaultChoose.
 *
 * Hidden information: scores only use public counts for hands and decks (never card identities in the opponent's
 * hand or deck order), and the engine RNG is reseeded from a bot-private stream inside every playout, so
 * lookahead cannot see the real draws or shuffles. The real RNG state comes back with the rollback.
 */

const { seededRng } = require('../env');

const HARM = /defeat|damage|attack|exhaust|capture|return|discard|take control|destroy|deal|disable/i;
const HELP = /heal|shield|give|ready|attach|experience|restore|buff|\+\d/i;

// ---------- evaluation ----------

const W = { power: 1.3, hp: 0.9, cost: 0.25, shield: 2.2, upgrade: 0.6, sentinel: 1.0, exhaustedMult: 0.85, hand: 1.8, resource: 1.4, initiative: 2.5, baseHp: 0.9 };

/**
 * Side multipliers on top of W, so profiles can value the two sides differently (an aggressive bot cares more
 * about the opponent's base than its own). All 1.5/1/1 reproduces the original evaluation exactly.
 * baseDangerHp: base HP below which the quadratic "danger" term kicks in; dangerScale divides that term.
 */
const SIDE = { myBase: 1.5, oppBase: 1.5, myUnits: 1, oppUnits: 1, baseDangerHp: 12, dangerScale: 6 };

function unitValue(u, w = W) {
    let v = u.getPower() * w.power + Math.max(0, u.remainingHp) * w.hp + (u.cost ?? 0) * w.cost;
    for (const up of u.upgrades ?? []) {
        v += up.internalName === 'shield' ? w.shield : w.upgrade;
    }
    if (u.hasSomeKeyword?.('sentinel')) {
        v += w.sentinel;
    }
    return u.exhausted ? v * w.exhaustedMult : v;
}

/** Base HP matters more the lower it gets. */
function baseTerm(base, w = W, s = SIDE) {
    const hp = Math.max(0, base.getHp() - base.damage);
    return hp * w.baseHp + (hp <= s.baseDangerHp ? ((s.baseDangerHp - hp) ** 2) / s.dangerScale : 0);
}

function sideValue(p, w = W, s = SIDE, mine = true) {
    let v = baseTerm(p.base, w, s) * (mine ? s.myBase : s.oppBase);
    const um = mine ? s.myUnits : s.oppUnits;
    for (const u of p.getArenaUnits()) {
        v += unitValue(u, w) * um;
    }
    v += p.hand.length * w.hand + p.resources.length * w.resource;
    if (p.hasInitiative()) {
        v += w.initiative;
    }
    return v;
}

/**
 * Cheap fingerprint of the visible game state. Two playouts that end with the same fingerprint changed nothing.
 * Includes whose action window it is, so passing (which hands the window to the opponent) is never a no-op.
 */
function fingerprint(eg) {
    const parts = [eg.round, eg.phase, eg.game.actionPhaseActivePlayer?.id ?? '-', eg.ids.map((id) => (eg.isActionWindow(id) ? 'W' : '-')).join('')];
    for (const id of eg.ids) {
        const p = eg.player(id);
        parts.push(p.base.damage, p.readyResourceCount, p.resources.length, p.hand.length, p.drawDeck.length, p.discard.length, p.hasInitiative() ? 1 : 0);
        for (const u of p.getArenaUnits()) {
            parts.push(u.uuid, u.damage, u.exhausted ? 1 : 0, u.getPower(), u.getHp(), (u.upgrades ?? []).length);
        }
        const leader = p.getAllDeckLeaders()[0];
        parts.push(leader ? `${leader.exhausted ? 1 : 0}${leader.deployed ? 1 : 0}` : '-');
    }
    return parts.join('|');
}

const isPass = (a) => a.kind === 'button' && /^pass$/i.test(a.label);

/**
 * Score the position for `pid` (higher is better). Only public information is read for hidden zones.
 * `profile` ({weights, side}) overrides W/SIDE; omitted, this is the original heuristic evaluation.
 */
function evaluate(eg, pid, profile = null) {
    if (eg.over) {
        const me = eg.names[eg.ids.indexOf(pid)];
        const w = eg.winners;
        return w.length === 1 ? (w[0] === me ? 10000 : -10000) : 0;
    }
    const w = profile?.weights ? { ...W, ...profile.weights } : W;
    const sd = profile?.side ? { ...SIDE, ...profile.side } : SIDE;
    const me = eg.player(pid);
    return sideValue(me, w, sd, true) - sideValue(me.opponent, w, sd, false);
}

// ---------- rule-based choices (everything outside the action window, and playout continuations) ----------

function keepScore(card, pl) {
    const deckAspects = new Set(pl.getDeckAspects?.() ?? []);
    const off = (card.aspects ?? []).filter((a) => !deckAspects.has(a)).length;
    const cost = card.cost ?? 0;
    return -off * 3 + (card.isUnit?.() ? 1.5 : 0) + (cost <= 3 ? 1 : 0) - cost * 0.3;
}

function targetScore(card, pl, title) {
    const mine = card.controller === pl;
    if (card.zoneName === 'hand' || card.zoneName === 'discard') {
        return /discard/i.test(title) ? -keepScore(card, pl) : keepScore(card, pl);
    }
    const attack = /attack/i.test(title);
    const harm = HARM.test(title);
    const help = HELP.test(title) && !harm;
    const val = card.isUnit?.() ? unitValue(card) : 0;
    if (card.isBase?.()) {
        return mine ? -100 : (attack || harm ? 8 : -5);
    }
    if (attack) {
        return mine ? -100 : val - card.remainingHp * 0.5 + 10;
    }
    if (harm) {
        return mine ? -50 : val;
    }
    if (help) {
        return mine ? val : -50;
    }
    return mine ? val : -1;
}

function parseMax(title, fallback = 1) {
    const between = /between (\d+) and (\d+)/i.exec(title);
    if (between) {
        return Number(between[2]);
    }
    const n = /(?:select|choose)\s+(?:up to\s+)?(\d+)/i.exec(title);
    return n ? Number(n[1]) : fallback;
}

function buttonScore(label) {
    if (/trigger|yes|use|play|keep/i.test(label)) {
        return 5;
    }
    if (/done|confirm|continue|resolve all|^ok/i.test(label)) {
        return 3;
    }
    if (/pass|^no\b|decline|skip|choose nothing|cancel/i.test(label)) {
        return -3;
    }
    return 0;
}

const maxBy = (list, f) => list.reduce((best, x) => (best === null || f(x) > f(best) ? x : best), null);

function defaultChoose(eg, pid, acts) {
    const pl = eg.player(pid);
    const prompt = pl.currentPrompt();
    const title = `${prompt.menuTitle ?? ''} ${prompt.promptTitle ?? ''}`;
    const buttons = acts.filter((a) => a.kind === 'button');
    const cards = acts.filter((a) => a.kind === 'card');

    if (/initiative/i.test(title)) {
        const b = buttons.find((x) => /yourself/i.test(x.label));
        if (b) {
            return b;
        }
    }
    if (/mulligan/i.test(title)) {
        const b = buttons.find((x) => /keep/i.test(x.label));
        if (b) {
            return b;
        }
    }
    if (cards.length) {
        const selected = pl.promptState.selectedCards?.length ?? 0;
        const done = buttons.find((x) => /^(done|confirm|submit|ok)/i.test(x.label));
        if (done && selected >= parseMax(title, 1)) {
            return done;
        }
        return /resource/i.test(title)
            ? maxBy(cards, (a) => -keepScore(a.card, pl))
            : maxBy(cards, (a) => targetScore(a.card, pl, title));
    }
    // multi-select display prompts keep offering unselected cards after the limit is reached (clicking them does nothing),
    // so stop at the limit and press Done instead of clicking forever
    if (acts.some((a) => a.kind === 'displayCard')) {
        const picked = (prompt.displayCards ?? []).filter((dc) => dc.selectionState === 'selected').length;
        const done = buttons.find((x) => /^(done|confirm|submit|ok)/i.test(x.label));
        if (done && picked >= parseMax(title, 1)) {
            return done;
        }
    }
    const options = acts.filter((a) => a.kind === 'option');
    if (options.length) {
        return /^#\d+$/.test(options[0].label) ? maxBy(options, (a) => Number(a.label.slice(1))) : options[0];
    }
    const nonButtons = acts.filter((a) => a.kind !== 'button');
    if (nonButtons.length) {
        return nonButtons[0];
    }
    return maxBy(buttons, (a) => buttonScore(a.label)) ?? acts[0];
}

// ---------- the bot ----------

const same = (a, b) => a.kind === b.kind && a.label === b.label && a.cardUuid === b.cardUuid && a.arg === b.arg;

class HeuristicBot {
    /**
     * depth: how many of my own actions to plan ahead (1 = best single action, 2 = also my next action, ...).
     * Between my actions the opponent is modelled as passing, so a plan is "what I can do with my next few turns";
     * only the first action is played and the rest is re-planned at the next window. beam: how many first actions get the deeper look.
     */
    constructor(name = 'heuristic', { maxCandidates = 40, maxBranch = 8, depth = 1, beam = 3, maxFollowUps = 12, profile = null } = {}) {
        this.name = name;
        this.profile = profile;
        this.depth = depth;
        this.beam = beam;
        this.maxFollowUps = maxFollowUps;
        this.needsUndo = true;
        this.maxCandidates = maxCandidates;
        this.maxBranch = maxBranch;
        this.rng = null;
        this.plan = [];
        this.seen = new Map();
        this.stats = { windows: 0, playouts: 0, failedPlayouts: 0, noops: 0, loopPasses: 0, ms: 0 };
    }

    choose({ game: eg, pid, actions, rng }) {
        this.rng ??= seededRng(`h${Math.floor(rng() * 1e9)}`);
        if (!eg.isActionWindow(pid)) {
            const planned = this.takePlanned(actions);
            return planned ?? defaultChoose(eg, pid, actions);
        }
        this.plan = [];
        const t0 = Date.now();
        const pick = this.searchWindow(eg, pid, actions);
        this.stats.windows++;
        this.stats.ms += Date.now() - t0;
        return pick;
    }

    takePlanned(actions) {
        if (!this.plan.length) {
            return null;
        }
        const live = actions.find((a) => same(a, this.plan[0]));
        if (live) {
            this.plan.shift();
            return live;
        }
        this.plan = [];
        return null;
    }

    searchWindow(eg, pid, actions) {
        const markId = eg.mark(pid);
        const base = fingerprint(eg);
        const pass = actions.find(isPass);
        // loop guard: the same position keeps coming back to this window, so stop trying things and pass
        const seen = (this.seen.get(base) ?? 0) + 1;
        this.seen.set(base, seen);
        if (seen > 2 && pass) {
            this.stats.loopPasses++;
            return pass;
        }
        let cands = actions;
        if (cands.length > this.maxCandidates) {
            const keep = cands.filter((a) => a.kind === 'button');
            const rest = cands.filter((a) => a.kind !== 'button').sort(() => this.rng() - 0.5);
            cands = [...keep, ...rest].slice(0, this.maxCandidates);
        }
        let best = null;
        const scored = [];
        // a sequence that leaves the game exactly as it was (click a unit, then cancel) is not a move
        const consider = (seq, r) => {
            if (r.fp === base) {
                this.stats.noops++;
                return;
            }
            scored.push({ seq, score: r.score });
            if (best === null || r.score > best.score) {
                best = { seq, score: r.score };
            }
        };
        for (const a of cands) {
            const r = this.playout(eg, pid, markId, [a]);
            consider([a], r);
            if (r.branch && r.branch.length > 1) {
                const alts = r.branch.length > this.maxBranch ? r.branch.slice().sort(() => this.rng() - 0.5).slice(0, this.maxBranch) : r.branch;
                for (const o of alts) {
                    consider([a, o], this.playout(eg, pid, markId, [a, o]));
                }
            }
        }
        if (best === null || best.score === -Infinity) {
            // nothing changed the game: pass if we can, otherwise take whatever is offered
            return pass ?? actions[0];
        }
        if (this.depth > 1) {
            // look further ahead for the most promising first actions: what is the best I can do next after each?
            const top = scored.filter((c) => c.score > -Infinity).sort((x, y) => y.score - x.score).slice(0, this.beam);
            best = null;
            for (const c of top) {
                const deep = this.playout(eg, pid, markId, c.seq, this.depth - 1);
                if (best === null || deep.score > best.score) {
                    best = { seq: c.seq, score: deep.score };
                }
            }
        }
        this.plan = best.seq.slice(1);
        return eg.refetch(pid, best.seq[0]) ?? eg.legalActions(pid)[0];
    }

    /** Let the opponent act (pass when it can, otherwise the rule-based choice) until it is my action window again. */
    advanceToMyWindow(eg, pid) {
        const opp = eg.ids.find((id) => id !== pid);
        for (let i = 0; i < 60 && !eg.over; i++) {
            if (eg.isActionWindow(pid)) {
                return true;
            }
            const actor = [opp, pid].find((id) => eg.legalActions(id).length);
            if (!actor) {
                return false;
            }
            const acts = eg.legalActions(actor);
            const choice = actor === opp && eg.isActionWindow(opp) ? (acts.find(isPass) ?? defaultChoose(eg, opp, acts)) : defaultChoose(eg, actor, acts);
            eg.apply(actor, choice, this.rng);
        }
        return eg.isActionWindow(pid);
    }

    /** At one of my windows inside a playout: the best score over my next action (and further ones while `extra` allows). */
    bestFrom(eg, pid, extra) {
        const mark = eg.mark(pid);
        const base = fingerprint(eg);
        const acts = eg.legalActions(pid).slice(0, this.maxFollowUps);
        let best = null;
        for (const a of acts) {
            const r = this.playout(eg, pid, mark, [a], extra - 1);
            if (r.fp !== base && r.score > -Infinity && (best === null || r.score > best)) {
                best = r.score;
            }
        }
        return best;
    }

    /** Apply `seq` (first action, then forced follow-ups), let the engine settle, score, roll back. */
    playout(eg, pid, markId, seq, extra = 0) {
        this.stats.playouts++;
        let score = -Infinity;
        let branch = null;
        let fp = null;
        try {
            eg.game.setRandomSeed(String(Math.floor(this.rng() * 1e9)));
            const first = eg.refetch(pid, seq[0]);
            if (!first) {
                throw new Error('action vanished');
            }
            eg.apply(pid, first, this.rng);
            const forced = seq.slice(1);
            const opp = eg.ids.find((id) => id !== pid);
            for (let i = 0; i < 60 && !eg.over; i++) {
                const actor = [pid, opp].find((id) => eg.legalActions(id).length);
                if (!actor || eg.isActionWindow(actor)) {
                    break;
                }
                const acts = eg.legalActions(actor);
                let choice;
                if (actor === pid && forced.length) {
                    choice = acts.find((a) => same(a, forced[0]));
                    forced.shift();
                    if (!choice) {
                        throw new Error('forced option vanished');
                    }
                } else {
                    if (i === 0 && actor === pid && seq.length === 1) {
                        branch = acts.map(({ kind, label, cardUuid, arg }) => ({ kind, label, cardUuid, arg }));
                    }
                    choice = defaultChoose(eg, actor, acts);
                }
                eg.apply(actor, choice, this.rng);
            }
            score = evaluate(eg, pid, this.profile);
            fp = fingerprint(eg);
            if (extra > 0 && !eg.over && this.advanceToMyWindow(eg, pid)) {
                const next = this.bestFrom(eg, pid, extra);
                if (next !== null) {
                    score = next;
                }
            }
        } catch {
            this.stats.failedPlayouts++;
        } finally {
            eg.restore(pid, markId);
        }
        return { score, branch, fp };
    }
}

module.exports = { HeuristicBot, evaluate, defaultChoose, unitValue, keepScore, targetScore, W, SIDE };
