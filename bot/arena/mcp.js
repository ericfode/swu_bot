'use strict';
/**
 * Arena API as an MCP server (stdio, JSON-RPC 2.0), so any MCP-capable harness can join the arena.
 * Each API method (api.js) is one tool, arena_<method>, with the same arguments and a JSON text result.
 *
 *   node bot/arena/mcp.js                         talk to the arena folder directly (ARENA_HOME, default the project's)
 *   node bot/arena/mcp.js --remote http://host:7070 [--token T]   proxy to an HTTP arena (server.js) instead
 *   node bot/arena/mcp.js --remote https://swu-arena.fly.dev [--token T]   the arena window (window.js): its arena read
 *                                                 tools, plus window_* tools that read its collections and upload local
 *                                                 files to it (a results run, one document, a folder of documents)
 *
 * Remote reads go as GET with query parameters (the window answers reads only on GET); changes go as POST with JSON.
 * Which kind of server --remote is comes from its GET /api. Window uploads use push.js with the same address and token
 * (no token: the cloud proxy adds the project's for swu-arena.fly.dev). A competitor's server (ARENA_COMPETITOR) never
 * gets the window_* tools.
 *
 * Claude Code:  claude mcp add arena -- node /path/to/swu_bot/bot/arena/mcp.js
 * Codex:        [mcp_servers.arena] command = "node", args = ["/path/to/swu_bot/bot/arena/mcp.js"]  (~/.codex/config.toml)
 * No SDK dependency: the protocol subset used here is initialize, tools/list, tools/call and ping. Notifications
 * (messages without an id) and responses are never answered. Tools carry MCP annotations (readOnlyHint etc.) from METHODS.
 */
const readline = require('readline');
const { call, asCompetitor, BENCH, METHODS } = require('./api');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const fs = require('fs');
const path = require('path');

const REMOTE = (arg('remote', process.env.ARENA_URL ?? null) || '').replace(/\/+$/, '') || null;
const TOKEN = arg('token', process.env.ARENA_TOKEN ?? null);
const TYPES = { string: { type: 'string' }, integer: { type: 'integer' }, object: { type: 'object' }, array: { type: 'array', items: {} } };

/** MCP tool annotations: read-only tools are idempotent too; the others only add data, except submit (see METHODS). */
const annotations = (d) => (d.readOnly
    ? { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    : { readOnlyHint: false, destructiveHint: !!d.destructive, idempotentHint: false, openWorldHint: false });

const arenaTool = ([m, d]) => ({
    name: `arena_${m}`,
    description: d.desc,
    annotations: annotations(d),
    inputSchema: { type: 'object', properties: { ...Object.fromEntries(Object.entries(d.props).map(([k, t]) => [k, TYPES[t]])), ...(d.token ? { token: { type: 'string', description: 'your competitor token (hosted arenas only; ARENA_COMPETITOR_TOKEN is sent automatically if set)' } } : {}) }, required: d.required ?? [] }
});

// the arena window's own tools: reading its collections, and uploading local files the way push.js does
const WINDOW_TOOLS = {
    docs: { readOnly: true, desc: 'List a window collection (arena, runs, ladders, league, experiments, evals, panels, bots, threads, lens, meta, research), or read one document with id.', props: { collection: 'string', id: 'string' }, required: ['collection'] },
    replays: { readOnly: true, desc: "A run's replays on the window, with their sizes in bytes.", props: { run: 'string' }, required: ['run'] },
    put_doc: { desc: 'Upload one JSON document to a window collection, from a local .json file (path) or inline (doc). Replaces the document with that id.', props: { collection: 'string', id: 'string', path: 'string', doc: 'object' }, required: ['collection', 'id'] },
    put_dir: { desc: 'Upload every <id>.json in a local folder to a window collection (only the ones that changed since the last upload from this machine).', props: { collection: 'string', path: 'string' }, required: ['collection', 'path'] },
    put_run: { desc: 'Upload a local results run folder (index.json, ladder.json, games/*.jsonl replays) to the window; only what the window lacks is sent. The run id is the folder name. Returns how many of its replays the window now has.', props: { path: 'string' }, required: ['path'] }
};
const windowTool = ([m, d]) => ({ ...arenaTool([m, d]), name: `window_${m}` });

// the window's arena reads when its GET /api cannot say (no valid token yet)
const WINDOW_READS = ['status', 'standings', 'report', 'versions', 'panel', 'games'];

// a remote that accepts the connection and then never answers must not hold up tools/list
const PROBE_MS = Number(process.env.ARENA_PROBE_MS) || 5000;

/** What --remote is: {kind: 'window', reads: [...]} for the arena window, else {kind: 'arena'}. Asked once. */
let target = null;
async function remoteKind() {
    target ??= (async () => {
        // one deadline for both requests, so a silent remote costs PROBE_MS in all
        const signal = AbortSignal.timeout(PROBE_MS);
        const j = await fetch(`${REMOTE}/api`, { headers: auth(), signal }).then((r) => r.json()).catch(() => null);
        if (Array.isArray(j?.result?.collections)) {
            return { kind: 'window', reads: (j.result.arena ?? []).filter((m) => METHODS[m]) };
        }
        if (j?.result && typeof j.result === 'object') {
            return { kind: 'arena' };
        }
        // refused or unreachable: only the window answers /healthz without a token
        const health = signal.aborted ? false : await fetch(`${REMOTE}/healthz`, { signal }).then(async (r) => r.ok && (await r.text()).trim() === 'ok').catch(() => false);
        if (!health) {
            target = null; // ask again next time
        }
        return health ? { kind: 'window', reads: WINDOW_READS } : { kind: 'arena' };
    })();
    return target;
}

async function toolList() {
    const kind = REMOTE ? await remoteKind() : { kind: 'arena' };
    if (kind.kind !== 'window') {
        return Object.entries(METHODS).filter(([m]) => !(process.env.ARENA_COMPETITOR && BENCH.includes(m))).map(arenaTool);
    }
    const arena = Object.entries(METHODS).filter(([m]) => kind.reads.includes(m)).map(arenaTool);
    return process.env.ARENA_COMPETITOR ? arena : [...arena, ...Object.entries(WINDOW_TOOLS).map(windowTool)];
}

const auth = () => (TOKEN ? { authorization: `Bearer ${TOKEN}` } : {});

/**
 * A remote call: reads as GET with query parameters (scalars only), the rest as POST with a JSON body. A read that
 * carries a token goes as POST too, so the token never lands in a URL or an access log.
 */
async function remote(method, args) {
    if (METHODS[method]?.readOnly && args?.token === undefined) {
        const q = new URLSearchParams(Object.entries(args ?? {}).filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object').map(([k, v]) => [k, String(v)]));
        const res = await fetch(`${REMOTE}/api/${method}${q.size ? `?${q}` : ''}`, { headers: auth() });
        return res.json();
    }
    const res = await fetch(`${REMOTE}/api/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify(args ?? {})
    });
    return res.json();
}

/** push.js, aimed at --remote with --token (no token: the cloud proxy adds the project's). */
function pusher() {
    if (TOKEN) {
        process.env.SWU_WINDOW_TOKEN = TOKEN;
    }
    process.env.SWU_WINDOW = REMOTE;
    return require('./push');
}

const fail = (code, message) => ({ error: { code, message } });
const ok = (result) => ({ result });

async function windowCall(method, a = {}) {
    if (!REMOTE || (await remoteKind()).kind !== 'window') {
        return fail('unsupported', 'window_* tools need --remote pointing at the arena window');
    }
    if (process.env.ARENA_COMPETITOR) {
        return fail('unauthorized', 'a competitor cannot change the window');
    }
    const seg = encodeURIComponent;
    const get = async (p) => {
        const r = await fetch(`${REMOTE}${p}`, { headers: auth() });
        return r.json();
    };
    try {
        if (method === 'docs') {
            return await get(`/api/docs/${seg(a.collection ?? '')}${a.id ? `/${seg(a.id)}` : ''}`);
        }
        if (method === 'replays') {
            return await get(`/api/replays/${seg(a.run ?? '')}?sizes=1`);
        }
        const push = pusher();
        if (method === 'put_doc') {
            if (a.doc !== undefined && a.path !== undefined) {
                return fail('bad_request', 'give path or doc, not both');
            }
            let text;
            if (a.doc !== undefined) {
                text = JSON.stringify(a.doc);
            } else {
                if (typeof a.path !== 'string' || !a.path.endsWith('.json')) {
                    return fail('bad_request', 'path: a local .json file (or pass doc)');
                }
                text = fs.readFileSync(a.path, 'utf8');
                JSON.parse(text); // only JSON leaves this machine
            }
            await push.putDoc(a.collection, a.id, text);
            return ok({ uploaded: `${a.collection}/${a.id}`, bytes: Buffer.byteLength(text) });
        }
        if (method === 'put_dir') {
            if (typeof a.path !== 'string' || !fs.statSync(a.path).isDirectory()) {
                return fail('bad_request', 'path: a local folder of <id>.json files');
            }
            return ok({ collection: a.collection, uploaded: await push.pushDir(a.collection, a.path) });
        }
        if (method === 'put_run') {
            const dir = typeof a.path === 'string' ? path.resolve(a.path) : '';
            if (!dir || !['index.json', 'ladder.json'].some((f) => fs.existsSync(path.join(dir, f)))) {
                return fail('bad_request', 'path: a results run folder (with index.json or ladder.json)');
            }
            const r = await push.pushRunOnce(dir, { docs: new Map(), replays: new Map() });
            const run = path.basename(dir);
            const local = fs.existsSync(path.join(dir, 'games')) ? fs.readdirSync(path.join(dir, 'games')).filter((f) => f.endsWith('.jsonl')) : [];
            const there = new Map(((await get(`/api/replays/${seg(run)}?sizes=1`)).result ?? []).map((x) => [x.id, x.size]));
            const missing = local.filter((f) => there.get(f.slice(0, -6)) !== fs.statSync(path.join(dir, 'games', f)).size).map((f) => f.slice(0, -6));
            return ok({ run, replays: local.length, onWindow: local.length - missing.length, missing: missing.slice(0, 20), stillPlaying: r.going });
        }
        return fail('not_found', `unknown window tool "${method}"`);
    } catch (e) {
        return fail(e.code === 'ENOENT' ? 'not_found' : e.code ?? 'bad_request', e.message);
    }
}

async function invoke(method, args) {
    // only the calls that take a token get it
    if (process.env.ARENA_COMPETITOR_TOKEN && METHODS[method]?.token && args && args.token === undefined) {
        args = { ...args, token: process.env.ARENA_COMPETITOR_TOKEN };
    }
    // a server started for one competitor (ARENA_COMPETITOR set) acts as that competitor only (api.js
    // asCompetitor); call() applies the same rules, and a remote arena gets the call already scoped
    if (process.env.ARENA_COMPETITOR) {
        const s = asCompetitor(process.env.ARENA_COMPETITOR, method, args);
        if (s.error) {
            return s;
        }
        args = s.args;
    }
    if (!REMOTE) {
        return call(method, args);
    }
    return remote(method, args);
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
            instructions: 'SWU bot arena. Start with arena_status, read rules in bot/arena/README.md of the swu_bot repo, post progress with arena_say, and submit with arena_submit.'
        } });
    }
    if (method === 'ping') {
        return write({ jsonrpc: '2.0', id, result: {} });
    }
    if (method === 'tools/list') {
        return write({ jsonrpc: '2.0', id, result: { tools: await toolList() } });
    }
    if (method === 'tools/call') {
        const full = String(params?.name ?? '');
        const run = full.startsWith('window_') ? windowCall(full.slice(7), params?.arguments ?? {}) : invoke(full.replace(/^arena_/, ''), params?.arguments ?? {});
        const out = await run.catch((e) => ({ error: { code: 'unreachable', message: e.message } }));
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
