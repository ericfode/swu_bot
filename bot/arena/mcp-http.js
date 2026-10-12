'use strict';
/**
 * MCP over HTTP (the Streamable HTTP transport, MCP 2025-06-18), the remote twin of mcp.js: one JSON-RPC message per
 * POST, answered with one JSON body; no event stream (GET and DELETE answer 405) and no session, so any request may go
 * to any machine. The caller checks who is asking before calling handle() (window.js: an OAuth access token only).
 *
 *   const mcp = createMcpHttp({ name, version, instructions, tools });
 *   mcp.handle(req, res, ctx)   // ctx (who is asking, etc.) reaches every tool's call(ctx, args)
 *
 * A tool is {name, description, inputSchema, annotations?, call(ctx, args)}: call returns a JSON value, or throws an
 * error with a `code` and a message, which the client sees as a tool error (isError). `tools` is a list, or a function
 * of ctx that returns one, so what a person may use can follow who they are.
 */
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 1 << 20;
const MAX_TEXT = 400000; // characters of one tool result; past it the result asks for a narrower call

function createMcpHttp({ name, version = '1.0.0', instructions = '', tools, headers = {} }) {
    const list = (ctx) => (typeof tools === 'function' ? tools(ctx) : tools);

    function send(res, code, body, extra = {}) {
        const text = body === undefined ? '' : JSON.stringify(body);
        res.writeHead(code, { ...(text ? { 'content-type': 'application/json' } : {}), 'cache-control': 'no-store', ...headers, ...extra });
        res.end(text);
    }

    function readBody(req) {
        return new Promise((resolve) => {
            const chunks = [];
            let size = 0;
            req.on('data', (d) => {
                size += d.length;
                if (size <= MAX_BODY) {
                    chunks.push(d);
                }
            });
            req.on('end', () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks).toString('utf8')));
            req.on('error', () => resolve(null));
        });
    }

    const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
    const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

    async function answer(msg, ctx) {
        const { id, method, params } = msg;
        if (method === 'initialize') {
            const asked = params?.protocolVersion;
            return reply(id, {
                protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name, version },
                ...(instructions ? { instructions } : {})
            });
        }
        if (method === 'ping') {
            return reply(id, {});
        }
        if (method === 'tools/list') {
            return reply(id, { tools: list(ctx).map(({ name: n, description, inputSchema, annotations }) => ({ name: n, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
        }
        if (method === 'tools/call') {
            const tool = list(ctx).find((t) => t.name === params?.name);
            if (!tool) {
                return fail(id, -32602, `unknown tool "${params?.name}"`);
            }
            const args = params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
            try {
                const out = await tool.call(ctx, args);
                let text = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
                if (text.length > MAX_TEXT) {
                    text = JSON.stringify({ error: { code: 'too_large', message: `the answer is ${text.length} characters; ask for less (an id, a round, or a from/length slice)` } });
                    return reply(id, { content: [{ type: 'text', text }], isError: true });
                }
                return reply(id, { content: [{ type: 'text', text }], isError: false });
            } catch (e) {
                const text = JSON.stringify({ error: { code: e.code ?? 'error', message: e.message } });
                return reply(id, { content: [{ type: 'text', text }], isError: true });
            }
        }
        return fail(id, -32601, `method not found: ${method}`);
    }

    async function handle(req, res, ctx) {
        if (req.method === 'GET' || req.method === 'DELETE') {
            return send(res, 405, undefined, { allow: 'POST' }); // no event stream, no sessions
        }
        if (req.method !== 'POST') {
            return send(res, 405, undefined, { allow: 'POST' });
        }
        const text = await readBody(req);
        if (text === null) {
            return send(res, 413, fail(null, -32600, `request body over ${MAX_BODY} bytes`));
        }
        let msg;
        try {
            msg = JSON.parse(text);
        } catch {
            return send(res, 400, fail(null, -32700, 'parse error'));
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
            return send(res, 400, fail(null, -32600, 'one JSON-RPC message per request'));
        }
        // a notification or a response from the client: accepted, never answered
        if (!('id' in msg) || 'result' in msg || 'error' in msg) {
            return send(res, 202);
        }
        if (typeof msg.method !== 'string') {
            return send(res, 400, fail(msg.id, -32600, 'invalid request: no method'));
        }
        const out = await answer(msg, ctx).catch((e) => fail(msg.id, -32603, e.message));
        return send(res, 200, out);
    }

    return { handle, answer };
}

module.exports = { createMcpHttp, VERSIONS };
