'use strict';

/**
 * Lookahead adapter for stdio bots: the bot can ask to "imagine" a situation before it acts.
 *
 * A native bot (spec/bot-interface.md#native-bots) that runs a v1 bot program (spec/stdio-protocol.md) and adds one
 * message pair: it imagines on the real engine and rolls back, so it needs engine access. At an action window the
 * program may answer `decide` with
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
 * Hidden information: the opponent never plays a card from its hand (or resources/discard) at its action windows in
 * an imagined line, the engine RNG is reseeded from a bot-private stream and both decks are shuffled with it (so draws
 * and reveals do not follow the real deck order), `state` is view() from the bot's own seat
 * (the opponent's hand stays a count), and any card that was hidden before (the opponent's hand, resources and deck,
 * and the bot's own deck) is blanked to "hidden card" in `state` and `steps` if the simulation moves it into view.
 *
 * Registered in external-bots.json with "adapter": "bot/jev/look.js".
 */

const { StdioClient } = require('../stdio');
const { view, promptView, actionView } = require('../view');
const { LIMITS, PROTOCOL } = require('../protocol');
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

/**
 * Follow-up prompts: attacks go to the base when allowed (aggressive), the rest use the rule-based defaults.
 * When either side must pick among cards hidden from the bot (the opponent's hand, either deck), it picks at random:
 * defaultChoose would rank them by their real cost and type, which the bot must not learn from.
 */
function followUp(eg, pid, acts, hidden, rng) {
    const isHidden = (a) => hidden.has(eg.cardId(a.card?.uuid ?? a.cardUuid ?? (a.kind === 'displayCard' ? a.arg : null)));
    if (acts.some(isHidden)) {
        return acts[Math.floor(rng() * acts.length)];
    }
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
function describeStep(eg, actor, a, hidden) {
    const who = eg.seatOf(actor);
    const at = eg.isActionWindow(actor) ? 'action' : 'choice';
    const id = eg.cardId(a.card?.uuid ?? a.cardUuid ?? (a.kind === 'displayCard' ? a.arg : null));
    if (hidden.has(id)) {
        return { who, at, what: 'a hidden card', ...(a.kind === 'card' ? { zone: null } : {}) };
    }
    return a.kind === 'card' && a.card ? { who, at, what: a.card.title ?? a.label, zone: a.card.zoneName ?? null } : { who, at, what: String(a.label) };
}

/** Ids of the cards the bot could not see before imagining: the opponent's hand, resources and deck, and its own deck. */
function hiddenCards(eg, pid) {
    const ids = new Set();
    const zone = (pl, z) => pl.getCardsInZone(z) ?? [];
    const me = eg.player(pid);
    const opp = eg.player(eg.ids.find((id) => id !== pid));
    for (const c of [...zone(opp, 'hand'), ...zone(opp, 'resource'), ...(opp.drawDeck ?? []), ...(me.drawDeck ?? [])]) {
        ids.add(eg.cardId(c.uuid));
    }
    return ids;
}

/** Replace every card whose id was hidden before the imagination by a bare 'hidden card' (a simulated draw, discard or
 * play must not leak it, not even through its stats). */
function maskHidden(o, hidden) {
    if (Array.isArray(o)) {
        return o.map((x) => maskHidden(x, hidden));
    }
    if (o && typeof o === 'object') {
        if (typeof o.id === 'string' && hidden.has(o.id)) {
            // keep only where it is: stats, keywords and upgrades would narrow down which card it is
            const r = { id: o.id, n: 'hidden card', s: null, hidden: 1 };
            for (const k of ['zone', 'ctl']) {
                if (k in o) {
                    r[k] = o[k];
                }
            }
            return r;
        }
        const r = {};
        for (const k in o) {
            r[k] = maskHidden(o[k], hidden);
        }
        return r;
    }
    return o;
}

/** A reply within `ms`, or an error. */
async function within(p, ms, what) {
    let timer;
    try {
        return await Promise.race([p, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no reply to '${what}' within ${ms} ms`)), ms);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

class LookaheadBot {
    constructor(name, opts = {}) {
        this.name = name;
        this.lang = opts.lang;
        this.client = new StdioClient(name, opts);
        this.needsUndo = true;
        this.maxImagine = opts.maxImagine ?? 4;
        this.ms = { hello: opts.startTimeoutMs ?? LIMITS.hello, decide: opts.timeoutMs ?? LIMITS.decide };
        this.look = { asked: 0, failed: 0, ms: 0 };
        this.game = null;
        this.seq = 0;
        this.lookRng = null;
    }

    get stats() {
        return { look: this.look };
    }

    /** One message to the program; any failure ends it, and the next game starts it again. */
    async call(msg, what = msg.t) {
        try {
            return await within(what === 'hello' ? this.client.hello(msg) : this.client.request(msg), this.ms[what === 'hello' ? 'hello' : 'decide'], what);
        } catch (e) {
            this.client.close();
            this.game = null;
            throw e;
        }
    }

    async beginGame(eg, pid, rng) {
        // one draw from the match rng, so its later draws do not depend on how much the bot imagines
        const seed = Math.floor(rng() * 4294967296);
        this.lookRng = seededRng(`look${seed}`);
        this.seq = 0;
        const r = await this.call({
            t: 'hello', protocol: PROTOCOL, v: 1, bot: this.name, you: eg.seatOf(pid), seed,
            players: eg.ids.map((id, i) => ({ id: `p${i + 1}`, name: eg.names[i] }))
        });
        if (r?.t !== 'ready') {
            throw new Error(`expected ready, got ${JSON.stringify(r)?.slice(0, 120)}`);
        }
        this.game = eg;
    }

    async choose({ game: eg, pid, actions, rng }) {
        if (eg !== this.game) {
            await this.beginGame(eg, pid, rng);
        }
        const seq = ++this.seq;
        let reply = await this.call({
            t: 'decide', seq, you: eg.seatOf(pid), prompt: promptView(eg, pid), state: view(eg, eg.seatOf(pid)),
            actions: actions.map((a, i) => actionView(eg, a, i, pid)),
            imagine: eg.isActionWindow(pid) ? { kinds: [...KINDS], left: this.maxImagine } : null
        });
        let imagined = 0;
        for (; reply?.t === 'imagine'; imagined++) {
            if (imagined >= this.maxImagine) {
                throw new Error(`asked to imagine more than ${this.maxImagine} times in one decision`);
            }
            const answer = this.imagine(eg, pid, actions, reply.situation);
            reply = await this.call({ t: 'imagined', seq, situation: reply.situation ?? null, left: this.maxImagine - imagined - 1, ...answer });
        }
        if (reply?.t !== 'act' || !Number.isInteger(reply.i) || reply.i < 0 || reply.i >= actions.length) {
            throw new Error(`expected {t:'act', i: 0..${actions.length - 1}}, got ${JSON.stringify(reply)?.slice(0, 120)}`);
        }
        // prompt uuids change across a rollback: a button from before the imagination would be rejected by the engine
        const action = imagined ? (eg.refetch(pid, actions[reply.i]) ?? actions[reply.i]) : actions[reply.i];
        // a split names cards by id; NativeSeat checks it
        const split = reply.split ?? reply.distribution;
        if (action.kind !== 'distribute' || split === undefined) {
            return action;
        }
        return { ...action, split: Array.isArray(split) ? split.map((e) => ({ id: eg.uuidOf(e?.id), amount: e?.amount })) : split };
    }

    close() {
        this.client.close();
        this.game = null;
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
        const hidden = hiddenCards(eg, pid);
        const opp = eg.ids.find((id) => id !== pid);
        const startRound = eg.round;
        let out;
        try {
            eg.game.setRandomSeed(String(Math.floor(this.lookRng() * 1e9)));
            // the real deck order is hidden from the bot: imagine with both decks shuffled (the rollback restores them)
            for (const id of eg.ids) {
                eg.player(id).shuffleDeck();
            }
            const first = eg.refetch(pid, actions[i]);
            if (!first) {
                throw new Error('action vanished');
            }
            steps.push(describeStep(eg, pid, first, hidden));
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
                    a = followUp(eg, actor, acts, hidden, this.lookRng);
                }
                if (!a) {
                    break;
                }
                if (eg.isActionWindow(actor) || a.kind === 'card') {
                    steps.push(describeStep(eg, actor, a, hidden));
                }
                eg.apply(actor, a, this.lookRng);
            }
            out = {
                ok: true, over: eg.over, winner: eg.winner,
                state: maskHidden(view(eg, eg.seatOf(pid)), hidden), steps
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
