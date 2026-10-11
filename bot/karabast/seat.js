'use strict';
/**
 * One protocol bot (spec/protocol.md) playing one seat of a Karabast game over a KarabastSocket.
 *
 * Each new decision in a frame becomes a `decide` message (observe.js); the bot's `act` becomes the socket message the
 * web client would send (frame.js gameMessage). The seat keeps these rules, whatever the bot does:
 *
 * - It sends only prompt answers (cardClicked, menuButton, perCardMenuButton, statefulPromptResults), plus concede and
 *   one chat line when asked. Never rollbackToSnapshot (undo), timer resets or settings: `send` refuses them.
 * - Undo prompts never reach the bot. A request from the opponent ("Your opponent would like to undo ...") is
 *   allowed `allowUndos` times per game and denied after that, never with "Deny and Block Requests". When a cost can
 *   no longer be paid, the seat picks Abandon, then a free Undo, and asks for an undo only when nothing else is offered.
 *   Any other button with "undo" in its label is hidden from the bot.
 * - A bot that fails (an error, a bad answer or split, no answer in time) is restarted at its next decision and a
 *   random legal action is played for it. At `maxFailures` failures in one game the seat concedes instead of letting
 *   the clock run out on the other player.
 * - The server ignores an answer it cannot take (no new decision follows). After `retryMs` the seat asks the bot
 *   again without that action; when every action was tried, it plays a random one. Each ignored answer is an error in
 *   the server's log, so after `maxIgnored` ignored answers in a row at one decision (a game the server can no longer
 *   move, say) the seat concedes rather than keep sending them.
 *
 * play() resolves when the game has a winner, the socket closes or the seat concedes: { result: 'win'|'loss'|'none',
 * reason, stats }.
 */
const fs = require('fs');
const path = require('path');
const { answer, StdioClient } = require('../stdio');
const { seededRng } = require('../rng');
const { gameMessage, decisionKey, legalActions, randomSplit } = require('./frame');
const { Observer, lineText } = require('./observe');

/** Everything a seat may send as a `game` command. */
const ALLOWED = new Set(['cardClicked', 'menuButton', 'perCardMenuButton', 'statefulPromptResults', 'concede', 'chat']);
const UNDO_REQUEST = /^Your opponent would like to undo/i;
const PAY_RECOVERY = /^You can no longer pay the cost/i;
const UNDO_LABEL = /\bundo\b/i;
const ROLLED_BACK = /\bhas rolled back to\b/;

const short = (x) => JSON.stringify(x)?.slice(0, 160);
const minutes = (ms) => `${+(ms / 60000).toFixed(1)} minute${ms === 60000 ? '' : 's'}`;
const noSim = async (req) => (req?.op === 'end' ? { t: 'simulated', op: 'end' } : { t: 'simulated', op: req?.op ?? null, error: 'simulations are off on Karabast' });
const actionKey = (a) => `${a.kind}|${a.label}|${a.arg ?? ''}|${a.cardUuid ?? ''}`;

/** `p` with a time limit: resolves to its value, or rejects after `ms`. */
function within(p, ms, what) {
    let timer;
    const late = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no reply to ${what} within ${ms} ms`)), ms);
    });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

class KarabastSeat {
    /**
     * sock: a connected KarabastSocket in the lobby; me: this seat's user id; client: a protocol client
     * ({ name, hello?, decide, over?, close? }, e.g. a StdioClient). opts: deck (our deck list, for hello), seed,
     * decideMs (10000), allowUndos (2), retryMs (1000), maxFailures (2), maxIgnored (4), chat (a line to send once, or
     * null), log, startMs (180000: end with no result when no game frame comes this long after the match) and idleMs
     * (600000: concede when a started game sends no frame this long).
     */
    constructor(sock, me, client, opts = {}) {
        this.sock = sock;
        this.me = me;
        this.client = client;
        this.opts = {
            decideMs: 10000, allowUndos: 2, retryMs: 1000, maxFailures: 2, maxIgnored: 4, chat: null, log: () => undefined, seed: 1,
            startMs: 180000, idleMs: 600000, ...opts
        };
        this.rng = seededRng(`karabast-seat-${this.opts.seed}`);
        this.obs = new Observer(me);
        this.latest = null;
        this.v = 1;
        this.greeted = false;
        this.helloDone = false;
        this.busy = false;
        this.sent = null; // { key, action, at } of the last answer, until the decision changes
        this.tried = new Map(); // decision key -> Set of action keys the server ignored
        this.ignored = null; // { key, n }: answers ignored in a row at decision `key`
        this.seq = 0;
        this.stats = { decisions: 0, botMs: [], rejected: 0, failures: [], fallbacks: 0, undoAllowed: 0, undoDenied: 0, payRecovery: [], waitMs: [], conceded: false };
    }

    /** Sends a `game` command, refusing anything but prompt answers, concede and chat. */
    send(command, ...args) {
        if (!ALLOWED.has(command)) {
            throw new Error(`refusing to send game command '${command}'`);
        }
        this.sock.send('game', command, ...args);
    }

    play() {
        return new Promise((resolve) => {
            this.done = (result, reason) => {
                if (this.finished) {
                    return;
                }
                this.finished = true;
                clearInterval(this.watchdog);
                this.sock.off('gamestate', onFrame);
                this.sock.off('disconnect', onClose);
                this.over(result, reason).finally(() => resolve({ result, reason, stats: this.stats }));
            };
            const onFrame = (gs) => this.onFrame(gs);
            const onClose = (why) => this.done('none', `socket closed: ${why}`);
            this.sock.on('gamestate', onFrame);
            this.sock.on('disconnect', onClose);
            this.startedAt = Date.now();
            this.lastFrameAt = null;
            this.watchdog = setInterval(() => {
                this.checkIgnored();
                this.checkIdle();
            }, 250);
        });
    }

    /** A game that never starts, or stops sending frames, would hold the seat (and a lobby loop) forever. */
    checkIdle(now = Date.now()) {
        if (this.finished) {
            return;
        }
        if (this.lastFrameAt === null) {
            if (now - this.startedAt >= this.opts.startMs) {
                this.done('none', `the game did not start within ${minutes(this.opts.startMs)}`);
            }
            return;
        }
        if (now - this.lastFrameAt >= this.opts.idleMs) {
            this.stats.conceded = true;
            try {
                this.send('concede');
            } catch {
                // the socket is gone: nothing more to send
            }
            this.done('loss', `conceded after ${minutes(this.opts.idleMs)} with no game frame`);
        }
    }

    onFrame(gs) {
        if (!gs?.players?.[this.me]) {
            return;
        }
        this.lastFrameAt = Date.now();
        this.obs.absorb(gs);
        if ((gs.newMessages ?? []).some((m) => ROLLED_BACK.test(lineText(m)))) {
            // a rollback can bring back the decision we just answered: it is a new decision, not an ignored answer
            this.sent = null;
            this.ignored = null;
        }
        this.latest = gs;
        if (gs.winners?.length) {
            const mine = gs.players[this.me]?.name;
            this.done(gs.winners.includes(mine) ? 'win' : 'loss', 'game over');
            return;
        }
        this.step();
    }

    /** Answers the current decision unless one is being answered or the last answer is still pending. */
    step() {
        const gs = this.latest;
        if (this.busy || this.finished || !gs || !legalActions(gs, this.me).length) {
            return;
        }
        const key = decisionKey(gs, this.me);
        if (this.sent?.key === key) {
            return; // checkIgnored decides when the server ignored it
        }
        this.sent = null;
        if (this.ignored && this.ignored.key !== key) {
            this.ignored = null; // the game moved on
        }
        this.busy = true;
        const seen = Date.now();
        this.answer(gs, key)
            .catch((e) => this.opts.log(`seat error: ${e.message}`))
            .finally(() => {
                this.busy = false;
                this.stats.waitMs.push(Date.now() - seen);
                if (!this.finished) {
                    setImmediate(() => this.step());
                }
            });
    }

    /** The server sends a frame for every command; a decision that has not changed after retryMs was ignored. */
    checkIgnored() {
        const s = this.sent;
        if (!s || this.busy || this.finished || !this.latest || Date.now() - s.at < this.opts.retryMs) {
            return;
        }
        if (decisionKey(this.latest, this.me) !== s.key) {
            return;
        }
        this.stats.rejected++;
        this.ignored = this.ignored?.key === s.key ? { key: s.key, n: this.ignored.n + 1 } : { key: s.key, n: 1 };
        const p = this.latest.players[this.me].promptState ?? {};
        this.opts.log(`server ignored ${s.action.kind} ${short(s.action.label)}${s.action.card ? ` in ${s.action.card.zone}` : ''} at "${p.menuTitle ?? p.promptTitle ?? ''}"`);
        if (this.ignored.n >= this.opts.maxIgnored) {
            this.stats.conceded = true;
            try {
                this.send('concede');
            } catch {
                // the socket is gone: nothing more to send
            }
            this.done('loss', `conceded after the server ignored ${this.ignored.n} answers in a row`);
            return;
        }
        if (!this.tried.has(s.key)) {
            this.tried.set(s.key, new Set());
        }
        this.tried.get(s.key).add(actionKey(s.action));
        this.sent = null;
        this.step();
    }

    async answer(gs, key) {
        const tried = this.tried.get(key) ?? new Set();
        const ruled = this.rule(gs);
        // a ruled answer the server ignored is not sent again: the prompt then goes to the bot like any other
        if (ruled && !tried.has(actionKey(ruled))) {
            return this.take(ruled, key);
        }
        const hide = (a) => (a.kind === 'button' && UNDO_LABEL.test(a.label)) || tried.has(actionKey(a));
        const d = this.obs.decision(gs, hide);
        if (!d) {
            // every action was tried (or is an undo button): start over with a random non-undo action
            this.tried.delete(key);
            const open = legalActions(gs, this.me).filter((a) => !(a.kind === 'button' && UNDO_LABEL.test(a.label)));
            this.stats.fallbacks++;
            return open.length ? this.take(open[Math.floor(this.rng() * open.length)], key) : undefined;
        }
        let chosen;
        try {
            chosen = await this.ask(gs, d);
        } catch (e) {
            await this.fail(e.message);
            if (this.finished) {
                return undefined;
            }
            this.stats.fallbacks++;
            chosen = { action: d.raw[Math.floor(this.rng() * d.raw.length)] };
        }
        // the board may have moved on while the bot thought (an undo, the other seat's timer): answer the new decision
        if (this.finished || decisionKey(this.latest, this.me) !== key) {
            return undefined;
        }
        return this.take(chosen.action, key, chosen.split);
    }

    /** The bot's choice for decision `d`: { action, split }. Throws when the bot fails. */
    async ask(gs, d) {
        if (!this.helloDone) {
            await this.hello(gs);
        }
        const me = gs.players[this.me];
        // stay inside the prompt timer (public games: 20 s per prompt plus the main time bank)
        const left = (me.turnTimeRemainingSeconds ?? Infinity) + (me.mainTimeRemainingSeconds ?? 0);
        const ms = Math.max(1000, Math.min(this.opts.decideMs, Number.isFinite(left) ? (left - 3) * 1000 : Infinity));
        const msg = { t: 'decide', seq: ++this.seq, you: 'p1', sim: false, ms, prompt: d.prompt, state: d.state, actions: d.actions, revealed: [] };
        const t0 = Date.now();
        const r = await within(Promise.resolve(answer(this.client, msg, noSim)), ms, 'decide');
        this.stats.botMs.push(Date.now() - t0);
        this.stats.decisions++;
        if (r?.t === 'error') {
            throw new Error(`error: ${r.error ?? '(no reason given)'}`);
        }
        if (r?.t !== 'act' || !Number.isInteger(r.i) || r.i < 0 || r.i >= d.raw.length) {
            throw new Error(`expected {"t":"act","i":0..${d.raw.length - 1}}, got ${short(r)}`);
        }
        const action = d.raw[r.i];
        if (action.kind !== 'distribute') {
            return { action };
        }
        // like the referee: no split gets a random one, a bad split is the bot's failure
        const given = r.split ?? r.distribution;
        if (given === undefined) {
            return { action, split: randomSplit(action, this.rng) };
        }
        const split = this.obs.split(action, given);
        if (!split) {
            throw new Error(`bad split ${short(given)}`);
        }
        return { action, split };
    }

    async hello(gs) {
        const { deck, opponent } = this.obs.decks(gs, this.opts.deck ?? null);
        const msg = {
            t: 'hello', protocol: 'swu-bot-stdio', v: 1, versions: [1, 2], bot: this.client.name, you: 'p1',
            seed: Math.floor(this.rng() * 2 ** 32), ms: 30000,
            players: [{ id: 'p1', name: 'p1', bot: this.client.name }, { id: 'p2', name: 'p2', bot: 'karabast-player' }],
            deck, opponent
        };
        const r = await within(Promise.resolve(answer(this.client, msg, noSim)), 30000, 'hello');
        if (r?.t !== 'ready') {
            throw new Error(`expected ready, got ${short(r)}`);
        }
        this.v = r.v ?? 1;
        this.helloDone = true;
        if (this.opts.chat && !this.greeted) {
            this.greeted = true;
            this.send('chat', this.opts.chat);
        }
    }

    async fail(why) {
        this.stats.failures.push(why);
        this.opts.log(`bot failure ${this.stats.failures.length}: ${why}`);
        this.helloDone = false;
        await Promise.resolve(this.client.close?.()).catch(() => undefined);
        if (this.stats.failures.length >= this.opts.maxFailures) {
            this.stats.conceded = true;
            this.send('concede');
            this.done('loss', `conceded after ${this.stats.failures.length} bot failures`);
        }
    }

    /** Prompts the seat answers itself (undo requests and cost recovery), or null. */
    rule(gs) {
        const p = gs.players[this.me].promptState ?? {};
        const title = `${p.menuTitle ?? ''} ${p.promptTitle ?? ''}`.trim();
        const buttons = legalActions(gs, this.me).filter((a) => a.kind === 'button');
        const by = (label) => buttons.find((b) => b.label === label);
        if (UNDO_REQUEST.test(p.menuTitle ?? '')) {
            const allow = this.stats.undoAllowed < this.opts.allowUndos && by('Allow');
            if (allow) {
                this.stats.undoAllowed++;
                return allow;
            }
            this.stats.undoDenied++;
            return by('Deny') ?? buttons.find((b) => !/block/i.test(b.label)) ?? null;
        }
        if (PAY_RECOVERY.test(title)) {
            const pick = by('Abandon') ?? by('Undo') ?? by('Request undo') ?? null;
            if (pick) {
                this.stats.payRecovery.push(pick.label);
            }
            return pick;
        }
        return null;
    }

    take(action, key, split = null) {
        const msg = gameMessage(action, action.kind === 'distribute' ? split ?? randomSplit(action, this.rng) : []);
        this.send(...msg);
        this.sent = { key, action, at: Date.now() };
    }

    async over(result, reason) {
        if (this.helloDone && this.v >= 2) {
            const winner = result === 'win' ? 'p1' : result === 'loss' ? 'p2' : null;
            const msg = { t: 'over', you: 'p1', winner, outcome: reason, round: this.obs.round, steps: this.seq, error: null, by: null, ms: 10000 };
            await within(Promise.resolve(answer(this.client, msg, noSim)), 10000, 'over').catch(() => undefined);
        }
    }
}

/**
 * A protocol client by name, without the engine: a program from $SWU_EXTERNAL_BOTS or bot/external-bots.json (c-clock,
 * rust-greedy2, ...) or the in-process js-random. Bots that need simulations cannot search here: Karabast keeps the
 * deck order and the other hand, so they get `sim: false` at every decision.
 */
function loadClient(name) {
    const file = process.env.SWU_EXTERNAL_BOTS ?? path.join(__dirname, '..', 'external-bots.json');
    const programs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const base = name.split('#')[0];
    if (Object.hasOwn(programs, base)) {
        const spec = programs[base];
        const Client = spec.adapter ? require(path.join(__dirname, '..', '..', spec.adapter)) : StdioClient;
        return new Client(name, spec);
    }
    if (base === 'js-random') {
        return require('../examples/random-bot').create(name);
    }
    throw new Error(`unknown bot "${name}" (programs in ${file}, or js-random)`);
}

module.exports = { KarabastSeat, ALLOWED, loadClient };
