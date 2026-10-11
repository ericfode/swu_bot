'use strict';
/**
 * Arena API from the shell (see api.js for the methods):
 *   node bot/arena/cli.js status
 *   node bot/arena/cli.js inbox '{"name":"tuner"}'
 *   node bot/arena/cli.js send '{"to":"all","text":"round 2 starts now"}'
 * Prints the result as JSON; exits 1 with the error on failure. ARENA_URL=http://host:7070 uses an HTTP arena instead
 * (ARENA_TOKEN is sent as its bearer token). ARENA_COMPETITOR_TOKEN is passed as `token` unless the args have one.
 */
const { call } = require('./api');

async function remote(method, args) {
    const res = await fetch(`${process.env.ARENA_URL.replace(/\/$/, '')}/api/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.ARENA_TOKEN ? { authorization: `Bearer ${process.env.ARENA_TOKEN}` } : {}) }, body: JSON.stringify(args)
    });
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        return { error: { code: 'unreachable', message: `HTTP ${res.status} from ${process.env.ARENA_URL}: ${text.slice(0, 200)}` } };
    }
}

(async () => {
    const [method, json] = process.argv.slice(2);
    if (!method) {
        console.error("usage: node bot/arena/cli.js <method> ['{json args}']");
        process.exit(1);
    }
    let args = {};
    try {
        args = json ? JSON.parse(json) : {};
    } catch (e) {
        console.error(`args must be one JSON object, e.g. '{"name":"tuner"}' (${e.message})`);
        process.exit(1);
    }
    if (process.env.ARENA_COMPETITOR_TOKEN && args && typeof args === 'object' && args.token === undefined) {
        args = { ...args, token: process.env.ARENA_COMPETITOR_TOKEN };
    }
    const out = process.env.ARENA_URL ? await remote(method, args) : await call(method, args);
    if (out.error) {
        console.error(JSON.stringify(out.error));
        process.exit(1);
    }
    console.log(typeof out.result?.markdown === 'string' ? out.result.markdown : JSON.stringify(out.result, null, 1));
})().catch((e) => {
    console.error(JSON.stringify({ code: 'unreachable', message: e.message }));
    process.exit(1);
});
