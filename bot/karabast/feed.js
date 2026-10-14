#!/usr/bin/env node
'use strict';
/**
 * Streams our bot's games against people from the Karabast Sprite to the arena window (bot/arena/WINDOW.md, "Outside
 * machines"): the game list as the run document `runs/karabast`, each game's replay as it is played, and its lens.
 *
 *   SWU_WINDOW=https://swu-arena.fly.dev node bot/karabast/feed.js --runs ~/karabast/runs --token-file <file>
 *       [--predict mlp-g5] [--every 3] [--once] [--names <file>]
 *
 * The token is the window's feed token for this machine (Fly secret ARENA_FEED_TOKEN_KARABAST): it may write only
 * documents and replays named `karabast` or `karabast-<id>`. Keep it in a mode-600 file on the Sprite.
 *
 * Only bot games (queue.js runs) are sent; games we watched between two people are not. The frames are already
 * scrubbed (frame.js: no names, ids or chat) and live-view.js names the seats "<bot> (ours)" and "opponent". While a
 * game is live, our hand goes face-down (count only) and a card our bot picked out of a hidden zone (a card it
 * resourced, a deck search) is not named, so no hidden card leaves this machine before the game ends; the whole
 * replay replaces the live one when it does.
 *
 * --names <file> (queue.js's private file of opponents' Karabast names; Eric, 2026-10-14: "I'd like it if it said _who_
 * i was having my bot play rather then just "a person"") adds `person`, the opponent's name, to that game's row of the
 * run document, and nowhere else: replays and lenses keep "opponent". The window takes `person` out of the run document
 * and shows it to its admin sign-in only; friends, view links and the MCP keep "a person".
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Games, nameReader } = require('./live-view');

const NAME = 'karabast';
const HIDDEN = { n: 'Hidden card', s: null, hid: 1 };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How many copies of each card name are on the public board: units (and their upgrades), leaders, bases, discards. */
function publicCounts(state) {
    const out = new Map();
    const add = (c) => {
        if (c && typeof c === 'object') {
            if (typeof c.n === 'string' && !c.hid) {
                out.set(c.n, (out.get(c.n) ?? 0) + 1);
            }
            (Array.isArray(c.u) ? c.u : []).forEach(add);
        }
    };
    for (const p of Object.values(state?.players ?? {})) {
        [p.base, p.leader, ...(p.ground ?? []), ...(p.space ?? []), ...(p.discard ?? [])].forEach(add);
    }
    return out;
}

/**
 * A live game as the window may show it: our seat's hand face-down, and our card choices named only when the card is
 * public. A step's board is the one its decision was made on, or the one right after when the action ended at once, so
 * each choice is judged from the step before to the step after: when a copy of the card left or came into our hand (it
 * was played, resourced, drawn or searched for), or the card was shown from a hidden zone, the name shows only if one
 * more copy is on the public board than before; otherwise the choice clicked a card already on the board (an attacker,
 * a target), which shows when that card was public. Copies already in play or in a discard pile never make a hidden
 * copy public. A last step whose choice needs the next one waits for it, so a line once sent never changes.
 */
function faceDown(events, ours) {
    const steps = events.map((e, i) => (e.t === 'step' && e.state?.players?.[ours] ? i : -1)).filter((i) => i >= 0);
    const at = new Map(steps.map((i, k) => [i, k]));
    const inHand = (state, name) => (state.players[ours].hand ?? []).filter((c) => !c.hid && c.n === name).length;
    const onBoard = (state, name) => publicCounts(state).get(name) ?? 0;
    const out = [];
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.t === 'header') {
            const seats = new Set([...(e.source?.hiddenHands ?? []), ours]);
            out.push({ ...e, source: { ...e.source, hiddenHands: [...seats] } });
            continue;
        }
        if (!at.has(i)) {
            out.push(e);
            continue;
        }
        const k = at.get(i);
        let action = e.action;
        const label = action?.label;
        if (typeof label === 'string' && (action.kind === 'card' || action.kind === 'displayCard') && (e.pid ?? ours) === ours) {
            if (k + 1 >= steps.length) {
                break; // where this card went shows on the next step
            }
            const prev = k > 0 ? events[steps[k - 1]].state : e.state;
            const next = events[steps[k + 1]].state;
            const hand = [prev, e.state, next].map((st) => inHand(st, label));
            const handMoved = hand.some((n) => n !== hand[0]);
            const before = onBoard(prev, label);
            const shown = handMoved || action.kind === 'displayCard'
                ? Math.max(onBoard(e.state, label), onBoard(next, label)) > before
                : before > 0 || onBoard(e.state, label) > 0;
            if (!shown) {
                action = { ...action, label: 'a hidden card' };
            }
        }
        const mine = e.state.players[ours];
        const players = { ...e.state.players, [ours]: { ...mine, hand: (mine.hand ?? []).map(() => HIDDEN) } };
        out.push({ ...e, action, state: { ...e.state, players } });
    }
    return out;
}

/** The window's id for a game: karabast-<frame file hash>. */
const windowId = (id) => `${NAME}-${id.split('/').pop()}`;

/** A name the window takes as `person`: 1-64 characters, none of them control characters. */
const PERSON = /^[^\u0000-\u001f\u007f]{1,64}$/;

/**
 * One row of the run document (TournamentIndex.games, viewer/src/core/types.ts) for a game from Games.get, where
 * `g.live` and `g.winnerSeat` are the feed's own call (Feed.ended): a game is over only when it says so. `person` is the
 * opponent's Karabast name when known (--names), for the window's admin view.
 */
function indexRow(id, g, person = null) {
    const h = g.events[0];
    const end = g.events[g.events.length - 1];
    const name = (p) => (p.id === h.ours?.seat ? h.ours.bot : 'opponent');
    const [p1, p2] = h.players.map(name);
    const winnerSeat = g.live ? null : g.winnerSeat ?? null;
    const winner = winnerSeat === 'draw' ? 'draw' : winnerSeat === 'p1' ? p1 : winnerSeat === 'p2' ? p2 : null;
    const outcome = g.live ? 'running' : winnerSeat === 'draw' ? 'draw' : winnerSeat ? 'won' : 'abandoned';
    return {
        id: windowId(id), seed: h.seed ?? 0, p1, p2, winner, winnerSeat, rounds: end.round ?? 0, steps: end.steps ?? g.events.length - 1,
        outcome, error: outcome === 'abandoned' ? 'no result' : null, ms: 0, ...(typeof person === 'string' && PERSON.test(person) ? { person } : {})
    };
}

class Feed {
    /**
     * api: { putDoc(ns, id, doc), request(method, path, opts) } (bot/arena/push.js); games: a live-view Games without
     * names; names: a nameReader (live-view.js) for the rows' `person`, or null.
     */
    constructor({ games, api, names = null, log = () => undefined }) {
        this.games = games;
        this.names = names;
        this.api = api;
        this.log = log;
        this.docs = new Map(); // ns/id -> hash of what the window has
        this.replays = new Map(); // window id -> { version, sent (bytes), prefix (hash of those bytes), whole }
        this.done = new Map(); // game id -> { v, row }: finished games already sent whole, not converted again
        this.known = null; // window id -> size of the replay the window had when this feed started
        this.created = null;
    }

    async putChanged(ns, id, doc) {
        const text = JSON.stringify(doc);
        const k = `${ns}/${id}`;
        if (this.docs.get(k) === sha(text)) {
            return false;
        }
        await this.api.putDoc(ns, id, text);
        this.docs.set(k, sha(text));
        return true;
    }

    /**
     * Whether a game is over: a winner in its frames, or queue.js's row for it in the run's games.jsonl (the seat ended:
     * won, lost, conceded or gave up). A game that only went quiet stays live, and hidden, since it may still resume.
     * Returns { winnerSeat } or null.
     */
    ended(id, g) {
        const end = g.events[g.events.length - 1];
        if (end?.t === 'end' && end.winner) {
            return { winnerSeat: end.winner };
        }
        const m = /^([^/]+)\/frames\/([0-9a-f]{12})$/.exec(id);
        if (!m || !this.games.runs) {
            return null;
        }
        let text = '';
        try {
            text = fs.readFileSync(path.join(this.games.runs, m[1], 'games.jsonl'), 'utf8');
        } catch {
            return null;
        }
        const row = text.split('\n').map((l) => {
            try {
                return JSON.parse(l);
            } catch {
                return null; // a blank or half-written line
            }
        }).find((r) => r?.file === `${m[2]}.jsonl`);
        if (!row) {
            return null;
        }
        const ours = g.events[0].ours.seat;
        const other = g.events[0].players.find((p) => p.id !== ours)?.id ?? null;
        return { winnerSeat: row.result === 'win' ? ours : row.result === 'loss' ? other : null };
    }

    /** Sends what the window lacks of one game's replay: new lines while live, the whole file once it ends. */
    async syncReplay(wid, g) {
        const st = this.replays.get(wid) ?? { version: null, sent: 0, prefix: sha(''), whole: false };
        this.replays.set(wid, st);
        if (st.version === g.version && (st.whole || g.live)) {
            return false;
        }
        // live: no end line (the kit keeps following), and faceDown may hold back the newest step
        const events = g.live ? faceDown(g.events.filter((e) => e.t !== 'end'), g.events[0].ours.seat) : g.events;
        const buf = Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
        const url = `/api/replays/${NAME}/${encodeURIComponent(wid)}`;
        const put = async () => {
            await this.api.request('PUT', url, { body: buf, type: 'application/x-ndjson' });
            Object.assign(st, { sent: buf.length, prefix: sha(buf), whole: !g.live });
        };
        if (!g.live && this.known?.get(wid) === buf.length) {
            Object.assign(st, { sent: buf.length, prefix: sha(buf), whole: true }); // sent before this feed restarted
        } else if (!g.live || st.sent === 0 || buf.length < st.sent || sha(buf.subarray(0, st.sent)) !== st.prefix) {
            await put(); // a finished game, the first send, or earlier lines that changed
        } else if (buf.length > st.sent) {
            try {
                await this.api.request('POST', url, { body: buf.subarray(st.sent), query: { at: st.sent }, type: 'application/x-ndjson' });
                Object.assign(st, { sent: buf.length, prefix: sha(buf) });
            } catch (e) {
                if (e.code !== 'conflict') {
                    throw e;
                }
                await put(); // the window has a different length (a restart of this feed): send it all again
            }
        }
        st.version = g.version;
        return true;
    }

    /** One pass: every bot game's replay and lens, then the run document. */
    async once() {
        const rows = [];
        const entries = this.games.list().filter((e) => e.kind === 'bot game').reverse(); // oldest first
        if (!this.known && entries.length) {
            const have = await this.api.request('GET', `/api/replays/${NAME}`, { query: { sizes: 1 } }).catch(() => []);
            this.known = new Map((Array.isArray(have) ? have : []).map((x) => [x.id, x.size]));
        }
        for (const e of entries) {
            const v = `${e.size}-${Math.round(e.mtime)}`;
            const d = this.done.get(e.id);
            if (d?.v === v) {
                rows.push(d.row);
                continue;
            }
            const got = this.games.get(e.id);
            if (!got?.events[0]?.ours) {
                continue; // no board yet, or not a seat we can name
            }
            // live-view calls a quiet game done after LIVE_MS; here only its end does, so its hand stays hidden till then
            const over = this.ended(e.id, got);
            const g = { ...got, live: !over, winnerSeat: over?.winnerSeat ?? null, version: `${got.version}|${over ? 'over' : 'live'}` };
            const wid = windowId(e.id);
            this.created ??= new Date(e.mtime).toISOString();
            const row = indexRow(e.id, g, this.names?.()?.get(e.id) ?? null);
            rows.push(row);
            try {
                await this.syncReplay(wid, g);
                if (this.games.ev) {
                    const lens = this.games.lens(e.id, g);
                    await this.putChanged('lens', wid, { ...lens, gameId: wid, source: 'bot/karabast/feed.js' });
                }
                if (!g.live) {
                    this.done.set(e.id, { v, row });
                }
            } catch (err) {
                this.log(`feed: ${wid}: ${err.message}`);
            }
        }
        if (rows.length) {
            const bots = [...new Set(rows.flatMap((r) => [r.p1, r.p2]).filter((n) => n !== 'opponent'))];
            await this.putChanged('runs', NAME, { id: NAME, createdAt: this.created, engine: null, bots, gamesPerPairing: 1, games: rows });
        }
        return rows;
    }
}

async function main() {
    const argv = process.argv.slice(2);
    const arg = (name, dflt) => {
        const i = argv.indexOf(`--${name}`);
        return i >= 0 ? argv[i + 1] : dflt;
    };
    const runs = arg('runs');
    const tokenFile = arg('token-file');
    const every = Number(arg('every', 3));
    if (!runs || !tokenFile) {
        throw new Error('usage: feed.js --runs <runs dir> --token-file <file> [--predict mlp-g5] [--every 3] [--once] [--names <file>]');
    }
    if (!(every >= 1 && every <= 600)) {
        throw new Error('--every must be 1-600 seconds');
    }
    // push.js reads the token when it loads; the file keeps it out of the process list and the shell history
    process.env.SWU_WINDOW_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
    const api = require('../arena/push');
    const log = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    // the names go to the rows' `person` only: the Games that build replays and lenses never get the file
    const names = arg('names', null);
    const feed = new Feed({ games: new Games(path.resolve(runs), { predict: arg('predict', null) }), api, names: names ? nameReader(names) : null, log });
    log(`feed to ${process.env.SWU_WINDOW || 'https://swu-arena.fly.dev'} from ${runs}, every ${every} s${names ? ', with opponents\' names for the admin view' : ''}`);
    for (;;) {
        try {
            const rows = await feed.once();
            if (argv.includes('--once')) {
                log(`sent ${rows.length} games`);
                return;
            }
        } catch (e) {
            log(`feed: ${e.message}`);
        }
        await sleep(every * 1000);
    }
}

module.exports = { Feed, faceDown, publicCounts, indexRow, windowId };

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
}
