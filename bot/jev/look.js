'use strict';

/**
 * Lookahead adapter for stdio bots: the bot can ask to "imagine" a situation before it acts.
 *
 * It is an ExternalBot (spec/stdio-protocol.md) with one additive message pair. At an action window the bot may answer
 * `decide` with
 *
 *   {"t":"imagine","situation":{"kind":"after"|"reply"|"round","i":<action index>}}
 *
 * instead of `act`. The adapter marks the engine, plays the situation out, rolls back, and sends
 *
 *   {"t":"imagined","seq":12,"ok":true,"situation":{...},"state":{...},"prompt":{...},"over":false,"winner":null,
 *    "steps":[{"who":"p1","what":"Wampa"},{"who":"p2","what":"Pass"}]}
 *
 * (`ok:false` plus `error` when it cannot). The bot then answers again: `act`, or another `imagine`, up to
 * `maxImagine` per decision. Situations:
 *
 *   after  play action i; follow-up prompts (targets etc.) use the rule-based defaultChoose; stop at the next action window
 *   reply  `after`, then the opponent's most aggressive board reply (attack with its strongest ready unit, else leader,
 *          else pass), with its follow-ups, until the next action window
 *   round  `after`, then both sides keep playing like that until the round ends (or 40 actions)
 *
 * Hidden information: the opponent never plays a card from its hand (or resources/discard) in an imagined line, the
 * engine RNG is reseeded from a bot-private stream so imagined draws and shuffles are not the real ones, and `state`
 * is observe() from the bot's own seat (the opponent's hand stays a count).
 *
 * Registered in external-bots.json with "adapter": "bot/jev/look.js".
 */

const { ExternalBot, forcedDistribution } = require('../players/external');
const { observe, promptView, actionView, seatOf } = require('../observe');
const { defaultChoose } = require('../players/heuristic');
const { attackChoice } = require('../players/rush');
const { seededRng } = require('../env');

const KINDS = new Set(['after', 'reply', 'round']);
const isPass = (a) => a.kind === 'button' && /^pass$/i.test(a.label);
const ARENAS = new Set(['groundArena', 'spaceArena']);

/** The opponent's board-only action at its window: strongest ready unit attacks, else leader, else pass. Never a hand card. */
function boardReply(eg, pid, acts) {
    const pl = eg.player(pid);
    let best = null;
    let bestP = 0;
    for (const a of acts) {
        const c = a.card;
        if (a.kind !== 'card' || !c || c.controller !== pl) {
            continue;
        }
        let p = 0;
        if (ARENAS.has(c.zoneName) && c.isUnit?.()) {
            p = 200 + (c.getPower?.() ?? 0);
        } else if (c.isLeader?.()) {
            p = 100;
        }
        if (p > bestP) {
            best = a;
            bestP = p;
        }
    }
    return best ?? acts.find(isPass) ?? null;
}

/** Follow-up prompts: attacks go to the base when allowed (aggressive), the rest use the rule-based defaults. */
function followUp(eg, pid, acts) {
    const pl = eg.player(pid);
    const prompt = pl.currentPrompt();
    if (/attack/i.test(`${prompt.menuTitle ?? ''} ${prompt.promptTitle ?? ''}`)) {
        const a = attackChoice(acts, pl);
        if (a) {
            return a;
        }
    }
    return defaultChoose(eg, pid, acts);
}

/** `at`: "action" for a move at an action window, "choice" for a follow-up pick (a target, an option). */
function describeStep(eg, actor, a) {
    const who = seatOf(eg, eg.player(actor));
    const at = eg.isActionWindow(actor) ? 'action' : 'choice';
    if (a.kind === 'card' && a.card) {
        return { who, at, what: a.card.title ?? a.label, zone: a.card.zoneName ?? null };
    }
    return { who, at, what: String(a.label) };
}

class LookaheadBot extends ExternalBot {
    constructor(name, opts = {}) {
        super(name, opts);
        this.needsUndo = true;
        this.maxImagine = opts.maxImagine ?? 4;
        this.look = { asked: 0, failed: 0, ms: 0 };
        this.lookRng = null;
    }

    beginGame(eg, pid, rng) {
        super.beginGame(eg, pid, rng);
        // one draw from the shared rng, so the match's later coin flips don't depend on how much the bot imagines
        this.lookRng = seededRng(`look${Math.floor(rng() * 1e9)}`);
    }

    choose({ game: eg, pid, actions, rng }) {
        if (eg !== this.game) {
            this.beginGame(eg, pid, rng);
        }
        const t0 = Date.now();
        const seq = ++this.seq;
        let reply = this.call({
            t: 'decide', seq, you: seatOf(eg, eg.player(pid)), prompt: promptView(eg, pid),
            state: observe(eg, pid), actions: actions.map((a, i) => actionView(eg, a, i)),
            imagine: eg.isActionWindow(pid) ? { kinds: [...KINDS], left: this.maxImagine } : null
        }, this.timeoutMs);
        let imagined = 0;
        for (let n = 0; reply.t === 'imagine'; n++, imagined++) {
            const answer = n < this.maxImagine ? this.imagine(eg, pid, actions, reply.situation) : { ok: false, error: 'no imaginations left' };
            reply = this.call({ t: 'imagined', seq, situation: reply.situation ?? null, left: Math.max(0, this.maxImagine - n - 1), ...answer }, this.timeoutMs);
        }
        this.timing.decisions++;
        this.timing.ms += Date.now() - t0;
        if (reply.t !== 'act' || !Number.isInteger(reply.i) || reply.i < 0 || reply.i >= actions.length) {
            throw new Error(`external bot ${this.name}: expected {t:'act', i: 0..${actions.length - 1}}, got ${JSON.stringify(reply).slice(0, 120)}`);
        }
        let action = actions[reply.i];
        if (imagined) {
            // prompt uuids change across a rollback: a button from before the imagination would be rejected by the engine
            action = eg.refetch(pid, action) ?? action;
        }
        if (action.kind === 'distribute' && reply.distribution) {
            return forcedDistribution(this.name, action, reply.distribution);
        }
        return action;
    }

    /** Play one situation out on the real engine and roll back. Only exact at an action window. */
    imagine(eg, pid, actions, situation) {
        const t0 = Date.now();
        this.look.asked++;
        const kind = situation?.kind;
        const i = situation?.i;
        if (!KINDS.has(kind) || !Number.isInteger(i) || i < 0 || i >= actions.length) {
            this.look.failed++;
            return { ok: false, error: `unknown situation ${JSON.stringify(situation).slice(0, 80)}` };
        }
        if (!eg.isActionWindow(pid)) {
            this.look.failed++;
            return { ok: false, error: 'imagining works only at an action window' };
        }
        const markId = eg.mark(pid);
        if (markId < 0) {
            this.look.failed++;
            return { ok: false, error: 'undo is off' };
        }
        const steps = [];
        const opp = eg.ids.find((id) => id !== pid);
        const startRound = eg.round;
        let out;
        try {
            eg.game.setRandomSeed(String(Math.floor(this.lookRng() * 1e9)));
            const first = eg.refetch(pid, actions[i]);
            if (!first) {
                throw new Error('action vanished');
            }
            steps.push(describeStep(eg, pid, first));
            eg.apply(pid, first, this.lookRng);
            // windows passed after the first action: `after` stops at the first, `reply` after the opponent's one
            let windows = 0;
            for (let k = 0; k < 120 && !eg.over && steps.length < 40; k++) {
                const actor = [pid, opp].find((id) => eg.legalActions(id).length);
                if (!actor) {
                    break;
                }
                const acts = eg.legalActions(actor);
                let a;
                if (eg.isActionWindow(actor)) {
                    windows++;
                    if (kind === 'after' || (kind === 'reply' && (windows > 1 || actor === pid)) || (kind === 'round' && eg.round !== startRound)) {
                        break;
                    }
                    a = boardReply(eg, actor, acts);
                } else {
                    if (kind === 'round' && eg.round !== startRound) {
                        break;
                    }
                    a = followUp(eg, actor, acts);
                }
                if (!a) {
                    break;
                }
                if (eg.isActionWindow(actor) || a.kind === 'card') {
                    steps.push(describeStep(eg, actor, a));
                }
                eg.apply(actor, a, this.lookRng);
            }
            const w = eg.over ? eg.winners : [];
            out = {
                ok: true, over: eg.over, winner: w.length === 1 ? seatOf(eg, eg.player(eg.ids[eg.names.indexOf(w[0])])) : (w.length ? 'draw' : null),
                state: observe(eg, pid), steps
            };
        } catch (e) {
            this.look.failed++;
            out = { ok: false, error: String((e && e.message) || e).split('\n')[0].slice(0, 160), steps };
        } finally {
            eg.restore(pid, markId);
        }
        this.look.ms += Date.now() - t0;
        return out;
    }
}

module.exports = LookaheadBot;
module.exports.LookaheadBot = LookaheadBot;
