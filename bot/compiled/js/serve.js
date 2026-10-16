'use strict';
// `require('../stdio')` inside a compiled JS bot (bot/compiled/js/bundle.js): the same answer() and serve() as
// bot/stdio.js, over Javy's blocking stdin/stdout (Javy.IO, build flag -J javy-stream-io=y) instead of Node streams.
// A sim request blocks until the referee's reply line arrives, so `await sim(...)` gets a plain object back.
// StdioClient starts other programs, which a sandboxed bot cannot do.

const dec = new TextDecoder();
const enc = new TextEncoder();
const chunk = new Uint8Array(1 << 16);
let buf = new Uint8Array(1 << 20);
let len = 0; // bytes read but not yet returned

/** The next non-blank line on stdin, or null at end of file. TextDecoder here cannot stream, so split on the newline byte first. */
function readLine() {
    for (;;) {
        const nl = buf.subarray(0, len).indexOf(10);
        if (nl >= 0) {
            const line = dec.decode(buf.slice(0, nl));
            buf.copyWithin(0, nl + 1, len);
            len -= nl + 1;
            if (line.trim()) {
                return line;
            }
            continue;
        }
        const n = Javy.IO.readSync(0, chunk);
        if (n === 0) {
            return null;
        }
        if (len + n > buf.length) {
            const bigger = new Uint8Array(Math.max(buf.length * 2, len + n));
            bigger.set(buf.subarray(0, len));
            buf = bigger;
        }
        buf.set(chunk.subarray(0, n), len);
        len += n;
    }
}

const next = () => {
    const line = readLine();
    return line === null ? null : JSON.parse(line);
};
const send = (m) => Javy.IO.writeSync(1, enc.encode(`${JSON.stringify(m)}\n`));

/** As bot/stdio.js answer(). */
async function answer(client, msg, sim) {
    switch (msg.t) {
        case 'hello': return client.hello ? client.hello(msg) : { t: 'ready', v: 2, name: client.name };
        case 'decide': return client.decide(msg, sim);
        case 'over': return client.over ? client.over(msg) : { t: 'ok' };
        case 'bye': return undefined;
        default: return { t: 'error', error: `unknown message '${msg.t}'` };
    }
}

/**
 * An error the bot threw, as its reply says it: the message and the first place in the bot's own files (the bundle's
 * globalThis.__where turns QuickJS's places in the script into file:line). The whole stack goes to stderr.
 */
function errorText(e) {
    const message = String(e?.message ?? e);
    const where = typeof globalThis.__where === 'function' ? globalThis.__where : String;
    const stack = typeof e?.stack === 'string' ? where(e.stack) : '';
    // QuickJS's stack is the frames alone, so the class and message go first, as V8's stack (the tests run this under
    // Node) and Python's traceback give them. A log that cannot be written changes no reply.
    try {
        console.error(!stack ? message : stack.includes(message) ? stack.trimEnd() : `${e?.name ?? 'Error'}: ${message}\n${stack.trimEnd()}`);
    } catch {} // no stderr
    const at = stack.split('\n').map((l) => /([^\s()]+\.js:\d+(?::\d+)?)\)?\s*$/.exec(l)?.[1]).find((p) => p && !/^stdio\.js:/.test(p));
    return at ? `${message} (at ${at})` : message;
}

/** As bot/stdio.js serve(): answer referee messages on stdin until end of file. */
async function serve(client) {
    for (let msg; (msg = next());) {
        // a sim call after the decision ended (a search left running) is answered here, never sent
        let open = true;
        const sim = (request) => {
            if (!open) {
                return { t: 'simulated', op: request?.op ?? null, error: 'this decision is over' };
            }
            send(request);
            const r = next();
            if (r === null) {
                throw new Error('referee closed the stream');
            }
            return r;
        };
        let reply;
        try {
            reply = await answer(client, msg, sim);
        } catch (e) {
            reply = { t: 'error', error: errorText(e) };
        }
        open = false;
        if (reply !== undefined) {
            send(reply);
        }
    }
}

class StdioClient {
    constructor() {
        throw new Error('StdioClient starts programs, which a compiled bot cannot do');
    }
}

module.exports = { answer, StdioClient, serve };
