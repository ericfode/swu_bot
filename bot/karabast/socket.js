'use strict';
/**
 * A minimal Socket.IO v4 client for a Karabast game server, over Node's built-in WebSocket, plus the few HTTP calls
 * the web client makes. No dependencies.
 *
 * Karabast's server (forceteki `server/gamenode/GameServer.ts`) serves Socket.IO on path `/ws`. The handshake query
 * carries `user` ({id, username} as JSON), `lobby` ({lobbyId} as JSON, required) and `spectator` ('true'/'false');
 * a logged-in user also sends `{token}` as the namespace auth. After that the client sends `game` and `lobby`
 * events, and the server sends `gamestate`, `lobbystate` and a few others.
 *
 * Only Engine.IO text packets are handled: open (0), ping (2) answered with pong (3), close (1) and message (4).
 * Inside a message, Socket.IO connect (0), disconnect (1), event (2) and connect error (4). Karabast sends no binary
 * events.
 *
 * Hosts: only localhost addresses are allowed unless the caller passes the host in `allowHosts`. This keeps test runs
 * off the live site by default.
 */
const { EventEmitter } = require('events');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Throws unless `base` is a localhost URL or its host is listed in `allowHosts`. Returns the parsed URL. */
function checkHost(base, allowHosts = []) {
    const url = new URL(base);
    if (!LOCAL_HOSTS.has(url.hostname) && !allowHosts.includes(url.hostname)) {
        throw new Error(`refusing to connect to ${url.hostname}: only localhost is allowed unless the host is passed explicitly (--allow-host ${url.hostname})`);
    }
    return url;
}

/** POST a JSON body to `base + route` and return { status, body }. */
async function post(base, route, body, { allowHosts, token } = {}) {
    checkHost(base, allowHosts);
    const headers = { 'content-type': 'application/json' };
    if (token) {
        headers.cookie = `next-auth.session-token=${token}`;
    }
    const r = await fetch(new URL(route, base), { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
}

/** GET `base + route` as JSON and return { status, body }. */
async function get(base, route, { allowHosts } = {}) {
    checkHost(base, allowHosts);
    const r = await fetch(new URL(route, base));
    return { status: r.status, body: await r.json().catch(() => null) };
}

/**
 * One Socket.IO connection. Incoming events are re-emitted on this object (`sock.on('gamestate', fn)`); send with
 * `sock.send(event, ...args)`. Emits 'disconnect' (reason) once when the connection ends.
 */
class KarabastSocket extends EventEmitter {
    /**
     * @param {string} base server URL, e.g. http://127.0.0.1:9500
     * @param {object} opts
     * @param {{id: string, username: string}} opts.user
     * @param {string|null} [opts.lobbyId] lobby to join by link (null: the server routes by the user's state)
     * @param {boolean} [opts.spectator]
     * @param {string} [opts.token] login JWT, for logged-in users only
     * @param {string[]} [opts.allowHosts] non-local hosts allowed
     */
    constructor(base, { user, lobbyId = null, spectator = false, token = null, allowHosts = [] }) {
        super();
        const url = checkHost(base, allowHosts);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.pathname = '/ws/';
        url.search = new URLSearchParams({
            EIO: '4',
            transport: 'websocket',
            user: JSON.stringify(user),
            lobby: JSON.stringify({ lobbyId }),
            spectator: spectator ? 'true' : 'false',
        }).toString();
        this.url = url.toString();
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.closed = false;
    }

    /** Open the connection; resolves once the server accepts the namespace connect, rejects on a connect error. */
    connect(timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => fail(new Error('socket connect timed out')), timeoutMs);
            const fail = (err) => {
                clearTimeout(timer);
                this.close('connect failed');
                reject(err);
            };
            const ws = new WebSocket(this.url);
            this.ws = ws;
            ws.addEventListener('message', (ev) => {
                const data = typeof ev.data === 'string' ? ev.data : '';
                if (data[0] === '0') {
                    ws.send('40' + (this.token ? JSON.stringify({ token: this.token }) : ''));
                } else if (data[0] === '2') {
                    ws.send('3');
                } else if (data[0] === '1') {
                    this.close('server closed');
                } else if (data[0] === '4') {
                    const kind = data[1];
                    const payload = data.slice(2);
                    if (kind === '0') {
                        this.connected = true;
                        clearTimeout(timer);
                        resolve(this);
                    } else if (kind === '4') {
                        fail(new Error(`connect error: ${payload}`));
                    } else if (kind === '1') {
                        this.close('server disconnect');
                    } else if (kind === '2') {
                        // an event, maybe with an ack id before the array
                        const start = payload.indexOf('[');
                        let msg;
                        try {
                            msg = JSON.parse(payload.slice(start));
                        } catch {
                            return;
                        }
                        if (Array.isArray(msg) && typeof msg[0] === 'string') {
                            super.emit(msg[0], ...msg.slice(1));
                        }
                    }
                }
            });
            ws.addEventListener('error', () => {
                if (!this.connected) {
                    fail(new Error(`websocket error connecting to ${new URL(this.url).host}`));
                }
            });
            ws.addEventListener('close', () => this.close('websocket closed'));
        });
    }

    /** Send a Socket.IO event, e.g. send('game', 'cardClicked', uuid). */
    send(event, ...args) {
        if (!this.connected || this.closed) {
            throw new Error('socket is not connected');
        }
        this.ws.send('42' + JSON.stringify([event, ...args]));
    }

    /** Wait for the next `event` (optionally one matching `test`), or reject after `timeoutMs`. */
    next(event, timeoutMs = 10000, test = () => true) {
        return new Promise((resolve, reject) => {
            const onEvent = (value) => {
                if (test(value)) {
                    done();
                    resolve(value);
                }
            };
            const onEnd = (reason) => {
                done();
                reject(new Error(`socket closed while waiting for ${event}: ${reason}`));
            };
            const timer = setTimeout(() => {
                done();
                reject(new Error(`timed out waiting for ${event}`));
            }, timeoutMs);
            const done = () => {
                clearTimeout(timer);
                this.off(event, onEvent);
                this.off('disconnect', onEnd);
            };
            this.on(event, onEvent);
            this.on('disconnect', onEnd);
        });
    }

    close(reason = 'client closed') {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.connected = false;
        try {
            this.ws?.close();
        } catch {
            // already closed
        }
        super.emit('disconnect', reason);
    }
}

module.exports = { KarabastSocket, checkHost, post, get, LOCAL_HOSTS };
