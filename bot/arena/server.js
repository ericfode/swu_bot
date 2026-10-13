'use strict';
/**
 * The arena window's HTTP server (window.js): the read-only arena and research for invited friends, fed through its
 * API by the games machine and the project's other parts, behind GitHub sign-in (auth.js). See WINDOW.md.
 *
 *   ARENA_MODE=window node bot/arena/server.js [--port 7070] [--host 127.0.0.1]
 *
 * ARENA_MODE=window is required; server.js serves nothing else. acceptsGzip is the Accept-Encoding rule window.js uses.
 */
const http = require('http');

/** Whether an Accept-Encoding header allows gzip: a gzip (or else *) entry whose q value is above 0. */
function acceptsGzip(header) {
    let gzip = null;
    let star = null;
    for (const part of String(header ?? '').toLowerCase().split(',')) {
        const [token, ...params] = part.split(';').map((x) => x.trim());
        const q = params.find((x) => x.startsWith('q='));
        const ok = !q || Number(q.slice(2)) > 0;
        if (token === 'gzip' || token === 'x-gzip') {
            gzip = ok;
        } else if (token === '*') {
            star = ok;
        }
    }
    return gzip ?? star ?? false;
}

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

if (require.main === module) {
    if (process.env.ARENA_MODE !== 'window') {
        console.error('server.js serves the arena window only: start it with ARENA_MODE=window (bot/arena/WINDOW.md)');
        process.exit(1);
    }
    const port = Number(arg('port', process.env.PORT ?? 7070));
    const host = arg('host', '127.0.0.1');
    const { createWindow } = require('./window');
    const w = createWindow();
    http.createServer((req, res) => w.handle(req, res)).listen(port, host, () => console.log(`arena window on http://${host}:${port}/ (data in ${w.store.dir})`));
    // the games machine stops when idle: woken on every submission, and every 6 hours for its daily replays
    setInterval(() => w.wakeGames(), 6 * 3600000).unref();
}

module.exports = { acceptsGzip };
