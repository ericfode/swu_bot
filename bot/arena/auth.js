'use strict';
/**
 * Who is asking, on the hosted arena (the window now, the whole arena on Fly later). Every request carries one of:
 *   a session cookie   a person who signed in with GitHub: 'admin' when their login is in ARENA_ADMINS, 'friend' when
 *                      invited (ARENA_INVITES, or the admin/invites document {logins: [...]}), else no role; or a
 *                      guest who opened a view link (/v/<key>, from the admin/links document): 'friend' while that
 *                      link exists (Eric, 2026-10-12 04:30: "yes: add view links to the arena window")
 *   a bearer token     a program: ARENA_PUSH_TOKEN is 'project' (the project's threads push and read; the cloud proxy
 *                      adds it to their requests, so no thread holds it), ARENA_GAMES_TOKEN is 'project' too (the games
 *                      machine's own, games.js, so it can be replaced alone), ARENA_ADMIN_TOKEN is 'admin' (the same admin
 *                      token api.js accepts); ARENA_FEED_TOKEN_<NAME> is 'feed' for one outside machine (a Sprite
 *                      that streams games, e.g. ARENA_FEED_TOKEN_KARABAST; NAME is letters and digits): it reads like
 *                      a friend and writes only what carries its name (window.js); any other bearer token is refused
 *                      An MCP client's access token (oauth.js) reads as its person: 'friend' while invited, never
 *                      more, with via 'oauth' (so it never writes); an agent's token (the device grant) also carries `agent`,
 *                      the one competitor name it may submit as (window.js arena_submit)
 *   nothing            'anon': the sign-in page and /healthz only
 * The role is worked out on every request, so removing an invite takes effect at once. Cookies grant reading, and
 * nothing else but one write: an admin changing the invite list from this site's own Share page (window.js share(),
 * which checks Origin and JSON). Every other write needs a bearer token, so a page elsewhere cannot make a signed-in
 * browser push anything.
 * GitHub sign-in needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET from an OAuth App whose callback URL is
 * <ARENA_PUBLIC_URL>/auth/github/callback (default https://swu-arena.fly.dev). Sessions are signed with
 * SESSION_SECRET, else with a key made on first start and kept in `dir` (the volume), so deploys keep people signed in.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROLES = ['anon', 'friend', 'feed', 'project', 'admin'];
const atLeast = (role, min) => ROLES.indexOf(role) >= ROLES.indexOf(min);
const SESSION = 'swu_session';
const OAUTH = 'swu_oauth';
const SESSION_DAYS = 14;
const VIEW_DAYS = 30; // a guest's session; opening the link again starts a new one
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
/** Equal strings, compared in constant time. */
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(digest(a), digest(b));
const logins = (s) => String(s ?? '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => LOGIN.test(x));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function parseCookies(header) {
    const out = {};
    for (const part of String(header ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) {
            out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
        }
    }
    return out;
}

/**
 * opts: dir (where the session key lives), invites() (extra invited logins, e.g. from the admin/invites document),
 * links() (view links [{id, key}], from the admin/links document), bearer(token) (an MCP client's access token ->
 * {login, grant, app} or null; oauth.js lookup), env (default process.env), fetch (for GitHub; tests pass a fake),
 * now() (for tests).
 */
function createAuth({ dir, invites = () => [], links = () => [], bearer = () => null, env = process.env, fetch: fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    const publicUrl = String(env.ARENA_PUBLIC_URL ?? 'https://swu-arena.fly.dev').replace(/\/+$/, '');
    const origin = new URL(publicUrl).origin; // what a browser sends as Origin from this site's own pages
    let lookup = bearer; // the window sets it once its oauth.js exists (useBearer)
    const secure = publicUrl.startsWith('https:');
    let key = null;

    function sessionKey() {
        if (key) {
            return key;
        }
        if (env.SESSION_SECRET) {
            key = digest(env.SESSION_SECRET);
            return key;
        }
        const file = path.join(dir, 'session.key');
        try {
            key = fs.readFileSync(file);
        } catch {
            fs.mkdirSync(dir, { recursive: true });
            const fresh = crypto.randomBytes(32);
            try {
                fs.writeFileSync(file, fresh, { mode: 0o600, flag: 'wx' });
                key = fresh;
            } catch {
                key = fs.readFileSync(file); // another process made it first
            }
        }
        return key;
    }

    const mac = (s) => b64(crypto.createHmac('sha256', sessionKey()).update(s).digest());
    const sign = (obj) => {
        const body = b64(JSON.stringify(obj));
        return `${body}.${mac(body)}`;
    };
    function verify(token) {
        const [body, sig] = String(token ?? '').split('.');
        if (!body || !sig || !same(sig, mac(body))) {
            return null;
        }
        try {
            const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            return obj && typeof obj.exp === 'number' && obj.exp > now() ? obj : null;
        } catch {
            return null;
        }
    }

    function cookie(name, value, maxAgeSec) {
        return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
    }

    /** The role of a GitHub login right now. */
    function roleOf(login) {
        const l = String(login ?? '').toLowerCase();
        if (!l) {
            return 'anon';
        }
        if (logins(env.ARENA_ADMINS ?? 'ericfode').includes(l)) {
            return 'admin';
        }
        let extra = [];
        try {
            extra = (invites() || []).map((x) => String(x).toLowerCase());
        } catch {}
        return logins(env.ARENA_INVITES).includes(l) || extra.includes(l) ? 'friend' : 'anon';
    }

    const viewLinks = () => {
        try {
            return (links() || []).filter((l) => l && typeof l.id === 'string' && typeof l.key === 'string');
        } catch {
            return [];
        }
    };

    /**
     * {role, via, login?, guest?}: `via` is 'bearer' or 'cookie' (writes need 'bearer'); role 'bad' means a bearer
     * token was sent and is wrong; `guest` is the id of the view link a guest came in by.
     */
    function who(req) {
        const h = String(req.headers.authorization ?? '');
        if (h.startsWith('Bearer ')) {
            const t = h.slice(7).trim();
            if (env.ARENA_ADMIN_TOKEN && same(t, env.ARENA_ADMIN_TOKEN)) {
                return { role: 'admin', via: 'bearer' };
            }
            if (env.ARENA_PUSH_TOKEN && same(t, env.ARENA_PUSH_TOKEN)) {
                return { role: 'project', via: 'bearer' };
            }
            if (env.ARENA_GAMES_TOKEN && same(t, env.ARENA_GAMES_TOKEN)) {
                return { role: 'project', games: true, via: 'bearer' };
            }
            for (const [k, v] of Object.entries(env)) {
                // letters and digits only, so no feed's name starts another's `<name>-` (FOO_BAR is no feed token)
                const m = /^ARENA_FEED_TOKEN_([A-Z0-9]+)$/.exec(k);
                if (m && v && same(t, v)) {
                    return { role: 'feed', feed: m[1].toLowerCase(), via: 'bearer' };
                }
            }
            const g = lookup(t);
            if (g) {
                return { role: roleOf(g.login) === 'anon' ? 'anon' : 'friend', login: g.login, grant: g.grant, app: g.app, ...(g.agent ? { agent: g.agent } : {}), via: 'oauth' };
            }
            return { role: 'bad', via: 'bearer' };
        }
        // anything else this key signs (a consent ticket, oauth.js) names its purpose in `p`, and is never a session
        const v = verify(parseCookies(req.headers.cookie)[SESSION]);
        const s = v && v.p === undefined ? v : null;
        if (s && typeof s.v === 'string') {
            // a guest is let in only while the link they came by exists, so removing it locks them out at once
            return viewLinks().some((l) => l.id === s.v) ? { role: 'friend', guest: s.v, via: 'cookie' } : { role: 'anon', via: 'cookie' };
        }
        return s ? { role: roleOf(s.l), login: s.l, via: 'cookie' } : { role: 'anon', via: 'cookie' };
    }

    // a local path to return to after signing in; anything else goes home
    const safeNext = (n) => (typeof n === 'string' && /^\/(?![/\\])[^\s]*$/.test(n) ? n : '/');

    function redirect(res, to, cookies = []) {
        res.writeHead(302, { location: to, 'set-cookie': cookies, 'cache-control': 'no-store' });
        res.end();
    }

    function page(res, code, html) {
        res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
    }

    /** Handles /auth/* and view links (/v/<key>); true when it answered. */
    async function routes(req, res, url) {
        const view = /^\/v\/([A-Za-z0-9_-]{16,64})\/?$/.exec(url.pathname);
        if (view) {
            const link = viewLinks().find((l) => same(view[1], l.key));
            if (!link) {
                page(res, 404, signInPage('/', null, 'That view link was removed, or it never existed. Ask Eric for a new one.'));
                return true;
            }
            // someone signed in and let in (Eric trying his own link) keeps their own session; a guest gets this link's,
            // so their access follows the link they opened last; the browser keeps the #/page
            const cur = who(req);
            const keep = atLeast(cur.role, 'friend') && cur.via === 'cookie' && cur.login;
            redirect(res, '/', keep ? [] : [cookie(SESSION, sign({ v: link.id, exp: now() + VIEW_DAYS * 864e5 }), VIEW_DAYS * 86400)]);
            return true;
        }
        if (!url.pathname.startsWith('/auth/')) {
            return false;
        }
        const configured = !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
        if (url.pathname === '/auth/logout') {
            redirect(res, '/', [cookie(SESSION, '', 0)]);
            return true;
        }
        if (url.pathname === '/auth/github') {
            if (!configured) {
                page(res, 503, signInPage('/', null, 'GitHub sign-in is not set up on this server yet.'));
                return true;
            }
            const state = b64(crypto.randomBytes(16));
            const q = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${publicUrl}/auth/github/callback`, state, allow_signup: 'false' });
            redirect(res, `https://github.com/login/oauth/authorize?${q}`, [cookie(OAUTH, sign({ s: state, n: safeNext(url.searchParams.get('next')), exp: now() + 10 * 60000 }), 600)]);
            return true;
        }
        if (url.pathname === '/auth/github/callback') {
            const st = verify(parseCookies(req.headers.cookie)[OAUTH]);
            const code = url.searchParams.get('code');
            if (!configured || !st || !code || !same(url.searchParams.get('state') ?? '', st.s)) {
                page(res, 400, signInPage('/', null, 'That sign-in link expired or did not come from here. Please try again.'));
                return true;
            }
            let login = null;
            let id = null;
            try {
                const tok = await fetchImpl('https://github.com/login/oauth/access_token', {
                    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
                    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${publicUrl}/auth/github/callback` })
                }).then((r) => r.json());
                if (tok?.access_token) {
                    const u = await fetchImpl('https://api.github.com/user', { headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'swu-arena' } }).then((r) => r.json());
                    login = typeof u?.login === 'string' && LOGIN.test(u.login) ? u.login : null;
                    id = Number.isInteger(u?.id) ? u.id : null;
                }
            } catch (e) {
                console.error('github sign-in failed:', e.message);
            }
            if (!login) {
                page(res, 502, signInPage('/', null, 'GitHub did not confirm who you are. Please try again.'));
                return true;
            }
            const session = cookie(SESSION, sign({ l: login.toLowerCase(), i: id, exp: now() + SESSION_DAYS * 864e5 }), SESSION_DAYS * 86400);
            redirect(res, roleOf(login) === 'anon' ? '/' : st.n, [session, cookie(OAUTH, '', 0)]);
            return true;
        }
        return false;
    }

    /** The logins fixed by the environment: admins, and invites that only a deploy changes. */
    const fixed = () => ({ admins: logins(env.ARENA_ADMINS ?? 'ericfode'), fromEnv: logins(env.ARENA_INVITES) });

    const useBearer = (fn) => {
        lookup = fn;
    };

    return { who, routes, roleOf, sign, verify, signInPage, origin, publicUrl, fixed, shell, useBearer };
}

/** The page a visitor without a role sees: sign in, or (signed in, not invited) who to ask. */
function signInPage(next, login, note) {
    const href = `/auth/github?next=${encodeURIComponent(next || '/')}`;
    const body = login
        ? `<p>You are signed in to GitHub as <b>@${esc(login)}</b>. The arena is open to invited friends, and <b>@${esc(login)}</b> is not on the list yet.</p><p>Send Eric your GitHub username, <b>${esc(login)}</b>. Once he has added it, reload this page. Or ask him for a view link: it opens the arena with no sign-in.</p><p><a href="/auth/logout">Sign out</a></p>`
        : `<p>The arena and its research are open to invited friends. Sign in with your GitHub account: GitHub asks once whether SWU Arena may see your username, and nothing else is shared.</p><p><a class="btn" href="${esc(href)}">Sign in with GitHub</a></p><p class="small">Got a view link from Eric? Open it instead; it needs no sign-in.</p>`;
    // the browser keeps the #/page part of a shared link to itself, so the button adds it to where sign-in returns
    const keepHash = login ? '' : `<script>(()=>{const a=document.querySelector('a.btn');if(a&&location.hash){const u=new URL(a.href,location.href);u.searchParams.set('next',(u.searchParams.get('next')||'/')+location.hash);a.href=u.pathname+u.search}})()</script>`;
    return shell(`<h1>SWU Arena</h1>${note ? `<p class="note">${esc(note)}</p>` : ''}${body}`, keepHash);
}

/** The plain page the sign-in and app-connect screens share. */
function shell(inner, after = '') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SWU Arena</title>
<style>:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#1c1b19;--mut:#5f5c55;--acc:#2f5bd3}@media (prefers-color-scheme:dark){:root{--bg:#141412;--fg:#ecebe6;--mut:#a3a097;--acc:#7f9cf5}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{max-width:420px}h1{font-size:22px;margin:0 0 8px}p{color:var(--mut)}b{color:var(--fg)}.btn{display:inline-block;background:var(--acc);color:#fff;padding:10px 16px;border-radius:8px;border:0;font:inherit;text-decoration:none;font-weight:600;cursor:pointer}.btn.ghost{background:transparent;color:var(--fg);box-shadow:inset 0 0 0 1.5px var(--mut)}.note{color:var(--fg)}.small{font-size:14px}</style></head>
<body><main>${inner}</main>${after}</body></html>`;
}

module.exports = { createAuth, atLeast, parseCookies, ROLES, LOGIN };
