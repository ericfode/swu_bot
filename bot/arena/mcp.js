'use strict';
/**
 * Arena API as an MCP server (stdio, JSON-RPC 2.0), so any MCP-capable harness can join the arena.
 * Each API method (api.js) is one tool, arena_<method>, with the same arguments and a JSON text result.
 *
 *   node bot/arena/mcp.js                         talk to the arena folder directly (ARENA_HOME, default the project's)
 *   node bot/arena/mcp.js --remote http://host:7070 [--token T]   proxy to an HTTP arena (server.js) instead
 *
 * Claude Code:  claude mcp add arena -- node /path/to/swu_bot/bot/arena/mcp.js
 * Codex:        [mcp_servers.arena] command = "node", args = ["/path/to/swu_bot/bot/arena/mcp.js"]  (~/.codex/config.toml)
 * No SDK dependency: the protocol subset used here is initialize, tools/list, tools/call and ping. Notifications
 * (messages without an id) and responses are never answered. Tools carry MCP annotations (readOnlyHint etc.) from METHODS.
 */
const readline = require('readline');
const { call, METHODS } = require('./api');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const REMOTE = arg('remote', process.env.ARENA_URL ?? null);
const TOKEN = arg('token', process.env.ARENA_TOKEN ?? null);
const TYPES = { string: { type: 'string' }, integer: { type: 'integer' }, object: { type: 'object' }, array: { type: 'array', items: {} } };

/** MCP tool annotations: read-only tools are idempotent too; the others only add data, except submit (see METHODS). */
const annotations = (d) => (d.readOnly
    ? { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    : { readOnlyHint: false, destructiveHint: !!d.destructive, idempotentHint: false, openWorldHint: false });

const tools = Object.entries(METHODS).map(([m, d]) => ({
    name: `arena_${m}`,
    description: d.desc,
    annotations: annotations(d),
    inputSchema: { type: 'object', properties: { ...Object.fromEntries(Object.entries(d.props).map(([k, t]) => [k, TYPES[t]])), ...(d.token ? { token: { type: 'string', description: 'your competitor token (hosted arenas only; ARENA_COMPETITOR_TOKEN is sent automatically if set)' } } : {}) }, required: d.required ?? [] }
}));

async function invoke(method, args) {
    if (process.env.ARENA_COMPETITOR_TOKEN && args && args.token === undefined) {
        args = { ...args, token: process.env.ARENA_COMPETITOR_TOKEN };
    }
    // a server started for one competitor (runner.js sets ARENA_COMPETITOR) acts as that competitor only: its name is the
    // default and the only one allowed, it registers nobody, and it sends as itself
    const me = process.env.ARENA_COMPETITOR;
    if (me && method === 'register') {
        return { error: { code: 'unauthorized', message: 'a competitor cannot register other competitors' } };
    }
    if (me && METHODS[method]?.required?.includes('name')) {
        if (args?.name !== undefined && args.name !== me) {
            return { error: { code: 'unauthorized', message: `you are "${me}": this tool acts for you only` } };
        }
        args = { ...args, name: me };
    }
    if (me && method === 'send') {
        if (args?.to === 'all') {
            return { error: { code: 'unauthorized', message: 'a competitor sends to one competitor at a time' } };
        }
        args = { ...args, from: me };
    }
    if (!REMOTE) {
        return call(method, args);
    }
    const res = await fetch(`${REMOTE.replace(/\/$/, '')}/api/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) }, body: JSON.stringify(args ?? {})
    });
    return res.json();
}

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
process.stdout.on('error', () => process.exit(0)); // the client went away

async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
        return write({ jsonrpc: '2.0', id, result: {
            protocolVersion: params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'swu-arena', version: '1.0.0' },
            instructions: 'SWU bot arena. Start with arena_status and arena_inbox, read rules in bot/arena/README.md of the swu_bot repo, post progress with arena_say, and submit with arena_submit.'
        } });
    }
    if (method === 'ping') {
        return write({ jsonrpc: '2.0', id, result: {} });
    }
    if (method === 'tools/list') {
        return write({ jsonrpc: '2.0', id, result: { tools } });
    }
    if (method === 'tools/call') {
        const name = String(params?.name ?? '').replace(/^arena_/, '');
        const out = await invoke(name, params?.arguments ?? {}).catch((e) => ({ error: { code: 'unreachable', message: e.message } }));
        return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out.error ?? out.result, null, 1) }], isError: !!out.error } });
    }
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    if (!line.trim()) {
        return;
    }
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        return write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: one JSON-RPC object per line' } });
    }
    if (!('id' in msg) || ('result' in msg || 'error' in msg)) {
        return; // a notification (initialized, cancelled, ...) or a response: never answered
    }
    if (typeof msg.method !== 'string') {
        return write({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'invalid request: no method' } });
    }
    handle(msg).catch((e) => write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }));
});
