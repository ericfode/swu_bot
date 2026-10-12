'use strict';
/**
 * Each person's own sign-in for MCP clients (Claude on claude.ai, Claude Code, Cursor, ...): the window is the OAuth 2.1
 * authorization server for its own MCP endpoint (/mcp), as the MCP authorization spec (2025-06-18) asks:
 *   GET  /.well-known/oauth-protected-resource[/mcp]  which server issues tokens for /mcp (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server       the endpoints below (RFC 8414)
 *   POST /oauth/register   an MCP client registers itself (RFC 7591): public clients only, no secret
 *   GET  /oauth/authorize  the person signs in with GitHub (auth.js), then allows or denies that client
 *   POST /oauth/authorize  their answer, from that page only (its Origin, and a signed ticket in the form)
 *   POST /oauth/token      a code and its PKCE verifier (S256) -> an access token (1 hour) and a refresh token
 *                          (30 days from its last use, a new one each time; an old one used again ends the grant)
 *   POST /oauth/revoke     ends the grant a token belongs to (RFC 7009)
 * One grant = one person allowing one client. Tokens are random and kept only as SHA-256 hashes, in <dir>/oauth.json.
 * A grant reads as its person, as 'friend' while their login is invited (checked on every request, so removing an
 * invite cuts their apps off too) and never more: an app reads the arena and changes nothing. A person sees and ends
 * their own grants on the app's Build a bot page (window.js /api/apps). Eric's ask, 2026-10-12 04:12: "the user should be able to
 * log in and have the mcp server get oauth"; his OK, 04:31: "add GitHub sign-in for the arena MCP".
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ACCESS_SEC = 3600;
const REFRESH_DAYS = 30;
const CODE_SEC = 300;
const MAX_CLIENTS = 1000;
const MAX_GRANTS_EACH = 20;
const MAX_CODES = 1000;
const SCOPE = 'arena';
const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const token = (prefix) => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A redirect URI a public client may register: https anywhere, http only to this machine, or an app's own scheme. */
function goodRedirect(u) {
    let url;
    try {
        url = new URL(u);
    } catch {
        return false;
    }
    if (url.hash || u.length > 500) {
        return false;
    }
    if (url.protocol === 'https:') {
        return true;
    }
    if (url.protocol === 'http:') {
        return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    }
    // a native app's own scheme (cursor://, vscode://); never one a browser runs or reads
    return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ws:', 'wss:', 'ftp:'].includes(url.protocol);
}

/**
 * opts: dir (where oauth.json lives), auth (auth.js: who, roleOf, sign, verify, origin, publicUrl, shell),
 * now() (for tests). Returns { routes, lookup, grantsOf, end, resourceMetadata }.
 */
function createOAuth({ dir, auth, now = Date.now }) {
    const file = path.join(dir, 'oauth.json');
    const base = auth.publicUrl;
    const resource = `${base}/mcp`;
    const metaUrl = `${base}/.well-known/oauth-protected-resource`;
    let state = { clients: {}, grants: {} };
    try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (d && typeof d.clients === 'object' && typeof d.grants === 'object') {
            state = d;
        }
    } catch {}
    const byToken = new Map(); // access or refresh hash -> grant id
    const index = () => {
        byToken.clear();
        for (const [id, g] of Object.entries(state.grants)) {
            for (const h of [g.access, g.refresh, g.prev]) {
                if (h) {
                    byToken.set(h, id);
                }
            }
        }
    };
    index();
    const codes = new Map(); // code hash -> {client, redirect, challenge, login, exp}

    function save() {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
        fs.renameSync(tmp, file);
    }

    /** Drops expired grants, and registrations that never got a grant within a day (anyone may register). */
    function prune() {
        const t = now();
        for (const [h, c] of codes) {
            if (c.exp <= t) {
                codes.delete(h);
            }
        }
        for (const [id, g] of Object.entries(state.grants)) {
            if (g.refreshExp <= t) {
                delete state.grants[id];
            }
        }
        const used = new Set(Object.values(state.grants).map((g) => g.client));
        const ids = Object.keys(state.clients).sort((a, b) => state.clients[a].createdAt - state.clients[b].createdAt);
        let n = ids.length;
        for (const id of ids) {
            if (!used.has(id) && (t - state.clients[id].createdAt > 864e5 || n > MAX_CLIENTS)) {
                delete state.clients[id];
                n--;
            }
        }
        index();
    }

    /** The grant an access token belongs to, while both are good: {login, grant, app}; else null. */
    function lookup(t) {
        const id = byToken.get(hash(t));
        const g = id && state.grants[id];
        if (!g || g.access !== hash(t) || g.accessExp <= now()) {
            return null;
        }
        g.usedAt = now(); // kept in memory; saved with the next change
        return { login: g.login, grant: id, app: state.clients[g.client]?.name ?? 'an app' };
    }

    /** A new access and refresh token for grant g (rotation: the refresh token it replaces is kept as `prev`). */
    function issue(id, g) {
        const access = token('swua');
        const refresh = token('swur');
        Object.assign(g, { access: hash(access), accessExp: now() + ACCESS_SEC * 1000, prev: g.refresh ?? null, refresh: hash(refresh), refreshExp: now() + REFRESH_DAYS * 864e5, usedAt: now() });
        state.grants[id] = g;
        index();
        save();
        return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SEC, refresh_token: refresh, scope: SCOPE };
    }

    /** One person's grants, newest first, for the Build a bot page. */
    function grantsOf(login) {
        return Object.entries(state.grants).filter(([, g]) => g.login === login && g.refreshExp > now())
            .map(([id, g]) => ({ id, app: state.clients[g.client]?.name ?? 'an app', site: state.clients[g.client]?.site ?? null, createdAt: new Date(g.createdAt).toISOString(), usedAt: new Date(g.usedAt).toISOString() }))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    /** Ends one grant, only its own person's; true when there was one. */
    function end(login, id) {
        if (!state.grants[id] || state.grants[id].login !== login) {
            return false;
        }
        delete state.grants[id];
        index();
        save();
        return true;
    }

    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version' };
    function json(res, code, body, headers = {}) {
        res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors, ...headers });
        res.end(JSON.stringify(body));
    }
    const oauthError = (res, code, error, description) => json(res, code, { error, error_description: description });
    function html(res, code, inner) {
        res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
        res.end(auth.shell(inner));
    }
    function redirect(res, to) {
        res.writeHead(302, { location: to, 'cache-control': 'no-store' });
        res.end();
    }
    const withQuery = (u, q) => {
        const url = new URL(u);
        for (const [k, v] of Object.entries(q)) {
            if (v != null) {
                url.searchParams.set(k, v);
            }
        }
        return url.toString();
    };

    /** A small body: JSON or a form, as an object of strings; null when it is neither or too big. */
    function readForm(req, max = 8192) {
        return new Promise((resolve) => {
            const chunks = [];
            let size = 0;
            req.on('data', (d) => {
                size += d.length;
                if (size <= max) {
                    chunks.push(d);
                }
            });
            req.on('end', () => {
                if (size > max) {
                    return resolve(null);
                }
                const text = Buffer.concat(chunks).toString('utf8');
                const type = String(req.headers['content-type'] ?? '');
                try {
                    if (/^application\/json/i.test(type)) {
                        const o = JSON.parse(text);
                        return resolve(o && typeof o === 'object' && !Array.isArray(o) ? o : null);
                    }
                    return resolve(Object.fromEntries(new URLSearchParams(text)));
                } catch {
                    return resolve(null);
                }
            });
            req.on('error', () => resolve(null));
        });
    }

    // the resource indicator (RFC 8707) a client may send: this server's MCP endpoint, or the server itself
    const ourResource = (r) => r == null || r === '' || [resource, base, `${base}/`, `${resource}/`].includes(String(r));

    const authMeta = () => ({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        revocation_endpoint: `${base}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
        scopes_supported: [SCOPE]
    });
    const resourceMetadata = () => ({ resource, authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: [SCOPE], resource_name: 'SWU Arena' });

    /** The authorization request, checked; {error} says what is wrong, `back` whether to tell the client by redirect. */
    function request(q) {
        const client = state.clients[q.client_id ?? ''];
        if (!client) {
            return { error: 'This app is not registered here, or its registration expired. Connect it again from the app.' };
        }
        if (!client.redirects.includes(q.redirect_uri ?? '')) {
            return { error: 'This app asked to come back to an address it did not register.' };
        }
        const back = (error, description) => ({ error: description, back: withQuery(q.redirect_uri, { error, error_description: description, state: q.state, iss: base }) });
        if (q.response_type !== 'code') {
            return back('unsupported_response_type', 'response_type must be code');
        }
        if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? '')) {
            return back('invalid_request', 'PKCE with code_challenge_method S256 is required');
        }
        if ((q.state ?? '').length > 1000 || !ourResource(q.resource)) {
            return back('invalid_request', q.state?.length > 1000 ? 'state is too long' : `resource must be ${resource}`);
        }
        return { client, q: { client_id: q.client_id, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, state: q.state ?? null } };
    }

    const siteOf = (u) => {
        try {
            const url = new URL(u);
            return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : url.protocol.slice(0, -1);
        } catch {
            return '?';
        }
    };

    async function routes(req, res, url) {
        const p = url.pathname;
        // every /.well-known/ path is answered here, so a client probing one we lack (openid-configuration) gets a 404
        const ours = p.startsWith('/oauth/') || p.startsWith('/.well-known/');
        if (!ours) {
            return false;
        }
        if (req.method === 'OPTIONS') {
            res.writeHead(204, { ...cors, 'access-control-max-age': '600' });
            res.end();
            return true;
        }
        if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp') {
            json(res, 200, resourceMetadata());
            return true;
        }
        if (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/oauth-authorization-server/mcp') {
            json(res, 200, authMeta());
            return true;
        }
        if (p === '/oauth/register') {
            if (req.method !== 'POST') {
                return oauthError(res, 405, 'invalid_request', 'POST client metadata as JSON'), true;
            }
            const m = await readForm(req);
            const uris = m?.redirect_uris;
            if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === 'string' && goodRedirect(u))) {
                return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris: 1 to 10 URLs, https, http://localhost or an app scheme, no #fragment'), true;
            }
            if (m.grant_types !== undefined && !(Array.isArray(m.grant_types) && m.grant_types.every((g) => ['authorization_code', 'refresh_token'].includes(g)))) {
                return oauthError(res, 400, 'invalid_client_metadata', 'grant_types: authorization_code and refresh_token only'), true;
            }
            const name = String(m.client_name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || siteOf(uris[0]);
            const id = `swuc_${crypto.randomBytes(12).toString('base64url')}`;
            state.clients[id] = { name, site: siteOf(uris[0]), redirects: uris, createdAt: now() };
            prune();
            save();
            json(res, 201, {
                client_id: id, client_id_issued_at: Math.floor(now() / 1000), client_name: name, redirect_uris: uris,
                token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE
            });
            return true;
        }
        if (p === '/oauth/authorize' && req.method === 'GET') {
            const r = request(Object.fromEntries(url.searchParams));
            if (r.error) {
                return r.back ? redirect(res, r.back) : html(res, 400, `<h1>Connect an app</h1><p class="note">${esc(r.error)}</p>`), true;
            }
            const me = auth.who(req);
            if (me.via !== 'cookie' || !me.login) {
                // a guest (view link) or nobody: sign in with GitHub first, then come back to this same request
                const next = `/auth/github?next=${encodeURIComponent(url.pathname + url.search)}`;
                return html(res, 200, `<h1>Connect ${esc(r.client.name)}</h1><p><b>${esc(r.client.name)}</b> (${esc(r.client.site)}) wants to use SWU Arena as you. Sign in with GitHub first.</p><p><a class="btn" href="${esc(next)}">Sign in with GitHub</a></p>`), true;
            }
            if (me.role === 'anon') {
                return html(res, 403, `<h1>Connect ${esc(r.client.name)}</h1><p>You are signed in as <b>@${esc(me.login)}</b>, who is not on the invite list yet. Ask Eric to add you, then connect again.</p><p><a href="/auth/logout">Sign out</a></p>`), true;
            }
            const tx = auth.sign({ p: 'consent', u: me.login, ...r.q, exp: now() + 10 * 60000 });
            return html(res, 200, `<h1>Connect ${esc(r.client.name)}</h1>
<p><b>${esc(r.client.name)}</b> (${esc(r.client.site)}) wants to use SWU Arena as <b>@${esc(me.login)}</b>.</p>
<p>It can read what you can see here: games, replays, standings and research. It cannot change anything.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="tx" value="${esc(tx)}">
<p><button class="btn" name="decision" value="allow">Allow</button> <button class="btn ghost" name="decision" value="deny">Deny</button></p></form>
<p class="small">You can disconnect it any time in the arena: Arena, then Build a bot.</p>`), true;
        }
        if (p === '/oauth/authorize' && req.method === 'POST') {
            // only this site's own consent page answers: a browser always sends Origin with a form post
            if (req.headers.origin !== auth.origin) {
                return html(res, 403, '<h1>Connect an app</h1><p class="note">That answer did not come from this site.</p>'), true;
            }
            const f = await readForm(req);
            const tx = auth.verify(f?.tx);
            const me = auth.who(req);
            if (!tx || tx.p !== 'consent' || me.via !== 'cookie' || me.login !== tx.u || me.role === 'anon') {
                return html(res, 400, '<h1>Connect an app</h1><p class="note">That page expired, or you signed in as someone else. Connect again from the app.</p>'), true;
            }
            const r = request({ ...tx, response_type: 'code', code_challenge_method: 'S256' });
            if (r.error) {
                return r.back ? redirect(res, r.back) : html(res, 400, `<h1>Connect an app</h1><p class="note">${esc(r.error)}</p>`), true;
            }
            if (f.decision !== 'allow') {
                return redirect(res, withQuery(r.q.redirect_uri, { error: 'access_denied', error_description: 'the person said no', state: r.q.state, iss: base })), true;
            }
            const code = crypto.randomBytes(32).toString('base64url');
            if (codes.size >= MAX_CODES) {
                codes.delete(codes.keys().next().value);
            }
            codes.set(hash(code), { client: r.q.client_id, redirect: r.q.redirect_uri, challenge: r.q.code_challenge, login: me.login, exp: now() + CODE_SEC * 1000 });
            return redirect(res, withQuery(r.q.redirect_uri, { code, state: r.q.state, iss: base })), true;
        }
        if (p === '/oauth/token') {
            if (req.method !== 'POST') {
                return oauthError(res, 405, 'invalid_request', 'POST a form'), true;
            }
            const f = await readForm(req);
            if (!f) {
                return oauthError(res, 400, 'invalid_request', 'send application/x-www-form-urlencoded'), true;
            }
            if (!ourResource(f.resource)) {
                return oauthError(res, 400, 'invalid_target', `resource must be ${resource}`), true;
            }
            if (f.grant_type === 'authorization_code') {
                const key = hash(f.code ?? '');
                const c = codes.get(key);
                codes.delete(key); // one use, right or wrong
                const verifierOk = c && PKCE.test(f.code_verifier ?? '') && crypto.createHash('sha256').update(f.code_verifier).digest('base64url') === c.challenge;
                if (!c || c.exp <= now() || c.client !== f.client_id || c.redirect !== f.redirect_uri || !verifierOk) {
                    return oauthError(res, 400, 'invalid_grant', 'the code is wrong, used, expired, or not for this client, address or verifier'), true;
                }
                if (auth.roleOf(c.login) === 'anon' || !state.clients[c.client]) {
                    return oauthError(res, 400, 'invalid_grant', 'this person or app can no longer connect'), true;
                }
                // a person keeps at most MAX_GRANTS_EACH apps: connecting one more ends their oldest
                const mine = Object.entries(state.grants).filter(([, g]) => g.login === c.login).sort((a, b) => a[1].createdAt - b[1].createdAt);
                for (const [id] of mine.slice(0, Math.max(0, mine.length - MAX_GRANTS_EACH + 1))) {
                    delete state.grants[id];
                }
                prune();
                const id = crypto.randomBytes(9).toString('base64url');
                return json(res, 200, issue(id, { login: c.login, client: c.client, createdAt: now() })), true;
            }
            if (f.grant_type === 'refresh_token') {
                const h = hash(f.refresh_token ?? '');
                const id = byToken.get(h);
                const g = id && state.grants[id];
                if (g && g.prev === h) {
                    // a refresh token used twice: someone else may hold it, so the grant ends for both
                    delete state.grants[id];
                    index();
                    save();
                    return oauthError(res, 400, 'invalid_grant', 'this refresh token was already used; connect again'), true;
                }
                if (!g || g.refresh !== h || g.refreshExp <= now() || g.client !== f.client_id) {
                    return oauthError(res, 400, 'invalid_grant', 'the refresh token is wrong, expired, or not for this client'), true;
                }
                if (auth.roleOf(g.login) === 'anon') {
                    end(g.login, id);
                    return oauthError(res, 400, 'invalid_grant', 'this person is no longer invited'), true;
                }
                return json(res, 200, issue(id, g)), true;
            }
            return oauthError(res, 400, 'unsupported_grant_type', 'authorization_code or refresh_token'), true;
        }
        if (p === '/oauth/revoke' && req.method === 'POST') {
            const f = await readForm(req);
            const id = byToken.get(hash(f?.token ?? ''));
            if (id && state.grants[id] && (!f.client_id || state.grants[id].client === f.client_id)) {
                delete state.grants[id];
                index();
                save();
            }
            json(res, 200, {}); // the same answer either way (RFC 7009)
            return true;
        }
        json(res, 404, { error: 'not_found', error_description: `nothing at ${p}` });
        return true;
    }

    /** The WWW-Authenticate header for a request to /mcp without a good token. */
    const challenge = (bad) => `Bearer resource_metadata="${metaUrl}"${bad ? ', error="invalid_token"' : ''}, scope="${SCOPE}"`;

    return { routes, lookup, grantsOf, end, challenge, resourceMetadata, cors };
}

module.exports = { createOAuth, goodRedirect };
