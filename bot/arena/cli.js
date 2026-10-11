'use strict';
/**
 * Arena API from the shell (see api.js for the methods):
 *   node bot/arena/cli.js status
 *   node bot/arena/cli.js inbox '{"name":"tuner"}'
 *   node bot/arena/cli.js send '{"to":"all","text":"round 2 starts now"}'
 * Prints the result as JSON; exits 1 with the error on failure. ARENA_URL=http://host:7070 uses an HTTP arena instead.
 */
const { call } = require('./api');

(async () => {
    const [method, json] = process.argv.slice(2);
    if (!method) {
        console.error("usage: node bot/arena/cli.js <method> ['{json args}']");
        process.exit(1);
    }
    const args = json ? JSON.parse(json) : {};
    const out = process.env.ARENA_URL
        ? await (await fetch(`${process.env.ARENA_URL.replace(/\/$/, '')}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })).json()
        : await call(method, args);
    if (out.error) {
        console.error(JSON.stringify(out.error));
        process.exit(1);
    }
    console.log(typeof out.result?.markdown === 'string' ? out.result.markdown : JSON.stringify(out.result, null, 1));
})();
