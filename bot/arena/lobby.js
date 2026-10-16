'use strict';
/**
 * The open tables' lobby (tables.js): it puts two browsers in touch and carries their messages until they talk
 * directly, or for the whole game when they cannot. It never sees a game's rules: the host's tab plays the game
 * (bot/table/open.js) and the guest's tab only draws it.
 *
 * A room has two sides, host and guest, each with its own key k (a side's messages and stream need its key, so the
 * same person may sit on both sides, in two tabs). Each side reads one stream (server-sent events) and sends with
 * POST; a message sent to a side waits in its queue until that side reads it, and a stream that reconnects gets what
 * it missed after its Last-Event-ID. Room events come as {room: 'joined', peer} and {room: 'left'}; a side's
 * messages as {msg}. What the two tabs send is theirs: the WebRTC handshake (offer, answer), then, when the direct
 * link does not open, the game itself (bot/arena/web/tables.html).
 *
 *   const lobby = createLobby();
 *   lobby.invite({ login, pid })                  -> {room, code, k}: a room with its host; the guest joins by code
 *   lobby.join(code, { login, pid })              -> {room, k, peer} or throws (no such invite, taken)
 *   lobby.queue({ login, pid })                   -> {ticket, k}: waits for another person (stream: {t: 'waiting'},
 *                                                    then {t: 'paired', room, side, k, peer}; the one who waited
 *                                                    longer hosts)
 *   lobby.stream(req, res, { room | ticket, side, k })   // the side's server-sent events
 *   lobby.send(room, side, k, msg)                -> null, or why not
 *   lobby.leave(room, side, k)
 *
 * Rooms live in this process: a window restart ends them (a game whose tabs talk directly goes on). A room is dropped
 * after IDLE_MS with no message and no stream, or MAX_MS after it opened; a queue ticket when its stream closes.
 */
const crypto = require('crypto');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const IDLE_MS = 30 * 60000;
const MAX_MS = 12 * 3600000;
const QUEUE_BYTES = 8 << 20; // what may wait for one side
const MAX_MSG = 256 << 10;
const PING_MS = 15000;
const TICKET_MS = 60000; // a ticket whose stream never came

class LobbyError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const randomKey = () => crypto.randomBytes(16).toString('hex');
const randomCode = () => Array.from(crypto.randomBytes(CODE_LEN), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function createLobby({ now = Date.now, setTimer = setInterval, clearTimer = clearInterval } = {}) {
    const rooms = new Map(); // room id -> room
    const codes = new Map(); // invite code -> room id
    const tickets = new Map(); // ticket -> {login, pid, k, at, out}

    const newSide = (who) => ({ login: who.login, pid: who.pid, k: randomKey(), q: [], bytes: 0, seq: 0, out: null, left: false });

    function newRoom(kind, host) {
        const room = { id: randomKey(), kind, code: null, createdAt: now(), lastAt: now(), host: newSide(host), guest: null };
        rooms.set(room.id, room);
        return room;
    }

    function drop(room) {
        rooms.delete(room.id);
        if (room.code) {
            codes.delete(room.code);
        }
        for (const s of [room.host, room.guest]) {
            s?.out?.end();
        }
    }

    /** Puts a message in `side`'s queue and on its stream; false when the queue is full. */
    function deliver(room, side, data) {
        const s = room[side];
        if (!s) {
            return false;
        }
        const text = JSON.stringify(data);
        if (s.bytes + text.length > QUEUE_BYTES) {
            return false;
        }
        const e = { id: ++s.seq, text };
        s.q.push(e);
        s.bytes += text.length;
        room.lastAt = now();
        s.out?.write(e);
        return true;
    }

    function invite(who) {
        const room = newRoom('invite', who);
        let code = randomCode();
        while (codes.has(code)) {
            code = randomCode();
        }
        room.code = code;
        codes.set(code, room.id);
        return { room: room.id, code, k: room.host.k };
    }

    function join(code, who) {
        const id = codes.get(String(code ?? '').trim().toUpperCase());
        const room = id && rooms.get(id);
        if (!room) {
            throw new LobbyError(404, 'not_found', 'no open invite with that code: ask your friend for a new one');
        }
        if (room.guest) {
            throw new LobbyError(409, 'conflict', 'someone already took that invite: ask your friend for a new one');
        }
        room.guest = newSide(who);
        codes.delete(room.code);
        deliver(room, 'host', { room: 'joined', peer: who.pid });
        return { room: room.id, k: room.guest.k, peer: room.host.pid };
    }

    /** Pairs the two connected tickets that waited longest, if there are two. */
    function pairUp() {
        const live = [...tickets.entries()].filter(([, t]) => t.out).sort((a, b) => a[1].at - b[1].at);
        while (live.length >= 2) {
            const [[ha, h], [ga, g]] = live.splice(0, 2);
            const room = newRoom('lobby', h);
            room.guest = newSide(g);
            for (const [ticket, t, side, peer] of [[ha, h, 'host', g.pid], [ga, g, 'guest', h.pid]]) {
                tickets.delete(ticket);
                t.out.write({ id: 1, text: JSON.stringify({ t: 'paired', room: room.id, side, k: room[side].k, peer }) });
                t.out.end();
            }
        }
        for (const [, t] of tickets) {
            t.out?.write({ id: 0, text: JSON.stringify({ t: 'waiting', people: tickets.size }) });
        }
    }

    function queue(who) {
        const ticket = randomKey();
        const k = randomKey();
        tickets.set(ticket, { login: who.login, pid: who.pid, k, at: now(), out: null });
        return { ticket, k };
    }

    /** Opens a server-sent event stream on res; returns a writer {write({id, text}), end()}. */
    function openStream(res, onClose) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        res.write(': open\n\n');
        let open = true;
        const ping = setTimer(() => open && res.write(': ping\n\n'), PING_MS);
        ping.unref?.();
        const out = {
            write: (e) => open && res.write(`${e.id ? `id: ${e.id}\n` : ''}data: ${e.text}\n\n`),
            end: () => {
                if (open) {
                    open = false;
                    clearTimer(ping);
                    res.end();
                }
            }
        };
        const closed = () => {
            if (open) {
                open = false;
                clearTimer(ping);
            }
            onClose(out);
        };
        // the response's close: a request's own close comes as soon as its (empty) body is read
        res.on('close', closed);
        return out;
    }

    function stream(req, res, { room: roomId, ticket, side, k }) {
        if (ticket) {
            const t = tickets.get(ticket);
            if (!t || !same(t.k, k)) {
                throw new LobbyError(404, 'not_found', 'that place in the queue is gone: look for a game again');
            }
            t.out?.end();
            t.out = openStream(res, (out) => {
                if (tickets.get(ticket)?.out === out) {
                    tickets.delete(ticket);
                }
            });
            pairUp();
            return;
        }
        const room = rooms.get(roomId);
        const s = room && (side === 'host' || side === 'guest') ? room[side] : null;
        if (!s || !same(s.k, k)) {
            throw new LobbyError(404, 'not_found', 'that table is gone');
        }
        s.out?.end();
        const out = openStream(res, (o) => {
            if (s.out === o) {
                s.out = null;
                room.lastAt = now();
            }
        });
        s.out = out;
        const after = Number(req.headers['last-event-id'] ?? 0) || 0;
        // what this side has read is what it read before a reconnect: drop it, send the rest
        while (s.q.length && s.q[0].id <= after) {
            s.bytes -= s.q.shift().text.length;
        }
        for (const e of s.q) {
            out.write(e);
        }
    }

    function sideOf(roomId, side, k) {
        const room = rooms.get(roomId);
        const s = room && (side === 'host' || side === 'guest') ? room[side] : null;
        if (!s || !same(s.k, k)) {
            throw new LobbyError(404, 'not_found', 'that table is gone');
        }
        return room;
    }

    function send(roomId, side, k, msg) {
        const room = sideOf(roomId, side, k);
        const other = side === 'host' ? 'guest' : 'host';
        if (!room[other]) {
            return 'nobody has joined yet';
        }
        if (room[other].left) {
            return 'the other player left';
        }
        return deliver(room, other, { msg }) ? null : 'the other player is not reading: the link is lost';
    }

    function leave(roomId, side, k) {
        const room = sideOf(roomId, side, k);
        room[side].left = true;
        const other = side === 'host' ? 'guest' : 'host';
        if (room[other] && !room[other].left) {
            deliver(room, other, { room: 'left' });
        }
        if (!room[other] || room[other].left) {
            drop(room);
        }
    }

    function sweep() {
        const t = now();
        for (const room of rooms.values()) {
            const reading = room.host.out || room.guest?.out;
            if (t - room.createdAt > MAX_MS || (!reading && t - room.lastAt > IDLE_MS)) {
                drop(room);
            }
        }
        for (const [id, tk] of tickets) {
            if (!tk.out && t - tk.at > TICKET_MS) {
                tickets.delete(id);
            }
        }
    }
    const sweeper = setTimer(sweep, 60000);
    sweeper.unref?.();

    return {
        invite, join, queue, stream, send, leave, sweep,
        stats: () => ({ rooms: rooms.size, waiting: tickets.size }),
        close: () => {
            clearTimer(sweeper);
            for (const room of [...rooms.values()]) {
                drop(room);
            }
            for (const t of tickets.values()) {
                t.out?.end();
            }
            tickets.clear();
        }
    };
}

module.exports = { createLobby, LobbyError, MAX_MSG };
