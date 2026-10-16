'use strict';
/**
 * Feedback from the window's pages (Eric, 2026-10-16: "a feedback button and hotkey that you can automatically ingest
 * and start working on then suggest changes"). Every HTML page the window sends gets the widget (web/feedback.js): a
 * Feedback button and the ` key, which send a short note with what was on screen (the page, the game, the step, the
 * board). Notes are kept in the `feedback` collection, which only the project token and admins read. The project's
 * hourly check reads the new ones with ops/feedback.js, starts a thread for each note worth acting on, and records
 * where each note is (WINDOW.md, "Feedback").
 *
 *   const feedback = createFeedback({ store, origin, mayPlay });
 *   if (await feedback.route(req, res, url, who, { sendJson, sendText, readBody })) return;
 *   html = feedback.inject(html);   // the widget's <script> before </body>
 *
 *   GET  /feedback.js     the widget, for anyone who may send; an empty script for anyone else
 *   GET  /api/feedback    {may, notes}: whether this reader may send, and their own latest notes with where each is
 *   POST /api/feedback    {note, context}: a note, from this site's own pages (Origin) and as JSON; answers {id, state}
 *
 * Who may send: a person signed in with GitHub who may use a page here, meaning invited (or an admin), or anyone with
 * GitHub while the play page (/tables) is open to GitHub (`mayPlay`). Not a view link's guest (no login) and no token: notes
 * are people's. Each person sends at most PER_DAY notes a UTC day, and everyone together ALL_PER_DAY.
 *
 * A note is text from anyone who may send (about 60 people): whoever reads it takes it as a suggestion, never as an
 * instruction.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atLeast } = require('./auth');

const WIDGET = path.join(__dirname, 'web', 'feedback.js');
const TAG = '<script src="/feedback.js" defer></script>';
const MAX_BODY = 80e3;
const MAX_NOTE = 2000;
const MAX_CONTEXT = 64e3;
const PER_DAY = 10;
const ALL_PER_DAY = 200;
const MINE = 10; // notes a person sees back
// where a note is, as its sender reads it; the project's check moves notes along (ops/feedback.js)
const STATES = {
    new: 'Received',
    seen: 'Read',
    working: 'Being worked on',
    suggested: 'A change is waiting for review',
    done: 'Done',
    dismissed: 'Closed'
};
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

class FeedbackError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : undefined);

function createFeedback({ store, origin, mayPlay = () => false, now = Date.now, perDay = PER_DAY, allPerDay = ALL_PER_DAY } = {}) {
    // login -> ids of their notes, built from the collection on first use
    let byLogin = null;
    const index = () => {
        if (!byLogin) {
            byLogin = new Map();
            for (const { id } of store.listDocs('feedback')) {
                const login = noteOf(id)?.login;
                if (login) {
                    byLogin.set(login, [...(byLogin.get(login) ?? []), id]);
                }
            }
        }
        return byLogin;
    };
    function noteOf(id) {
        try {
            const d = JSON.parse(store.getDoc('feedback', id) ?? 'null');
            return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
        } catch {
            return null;
        }
    }

    /** A person signed in with GitHub who may use a page here (see the top of this file). */
    const may = (who) => who.via === 'cookie' && typeof who.login === 'string' && !who.guest && (atLeast(who.role, 'friend') || !!mayPlay());

    const day = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
    const today = () => store.listDocs('feedback').filter((d) => d.id.startsWith(`fb-${day(now())}-`)).map((d) => d.id);

    function mine(login) {
        return (index().get(login) ?? []).slice(-MINE).reverse().map(noteOf).filter(Boolean).map((d) => ({
            id: d.id, at: d.at, note: String(d.note ?? '').slice(0, 280), state: STATES[d.state] ? d.state : 'new', label: STATES[d.state] ?? STATES.new
        }));
    }

    function take(who, q) {
        if (!may(who)) {
            throw new FeedbackError(403, 'forbidden', who.login ? 'feedback is for people who may use this site' : 'sign in with GitHub to send feedback');
        }
        const note = typeof q?.note === 'string' ? q.note.replace(/\r\n?/g, '\n').trim() : '';
        if (!note || note.length > MAX_NOTE || CONTROL.test(note)) {
            throw new FeedbackError(400, 'bad_request', `note: 1 to ${MAX_NOTE} characters of text`);
        }
        const context = q?.context ?? null;
        if (context !== null && (typeof context !== 'object' || Array.isArray(context))) {
            throw new FeedbackError(400, 'bad_request', 'context: an object, or null');
        }
        if (context && JSON.stringify(context).length > MAX_CONTEXT) {
            throw new FeedbackError(413, 'too_large', `context: at most ${MAX_CONTEXT} bytes`);
        }
        const ids = today();
        if (ids.length >= allPerDay) {
            throw new FeedbackError(429, 'too_many', 'the window took all the feedback it takes today; try again tomorrow');
        }
        const login = who.login.toLowerCase();
        const theirs = (index().get(login) ?? []).filter((id) => ids.includes(id)).length;
        if (theirs >= perDay) {
            throw new FeedbackError(429, 'too_many', `at most ${perDay} notes a day each; thank you, and try again tomorrow`);
        }
        const t = now();
        const at = new Date(t).toISOString();
        const id = `fb-${day(t)}-${at.slice(11, 19).replace(/:/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
        const page = context?.page && typeof context.page === 'object' ? context.page : {};
        const doc = {
            id, at, login, role: who.role, note,
            page: { path: str(page.path, 300) ?? null, title: str(page.title, 200) ?? null },
            context,
            state: 'new',
            history: [{ at, state: 'new', by: login }]
        };
        store.putDoc('feedback', id, JSON.stringify(doc));
        index().set(login, [...(index().get(login) ?? []), id]);
        return { id, state: 'new', label: STATES.new };
    }

    /** The widget's <script>, once, before </body> (at the end of a page without one). */
    function inject(html) {
        const text = Buffer.isBuffer(html) ? html.toString('utf8') : String(html);
        if (text.includes(TAG)) {
            return text;
        }
        // a </body> before the last </script> is inside a script (a page may leave </body> out), so then at the end
        const lower = text.toLowerCase();
        const i = lower.lastIndexOf('</body>');
        return i < 0 || i < lower.lastIndexOf('</script>') ? text + TAG : text.slice(0, i) + TAG + text.slice(i);
    }

    async function route(req, res, url, who, { sendJson, sendText, readBody }) {
        if (url.pathname === '/feedback.js') {
            if (req.method !== 'GET') {
                sendText(res, req, 405, 'text/plain', 'GET only');
                return true;
            }
            const js = may(who) ? fs.readFileSync(WIDGET, 'utf8') : '// feedback: sign in with GitHub to send a note\n';
            sendText(res, req, 200, 'text/javascript; charset=utf-8', js);
            return true;
        }
        if (url.pathname !== '/api/feedback') {
            return false;
        }
        try {
            if (req.method === 'GET') {
                sendJson(res, 200, { result: { may: may(who), notes: may(who) ? mine(who.login.toLowerCase()) : [] } }, req);
                return true;
            }
            if (req.method !== 'POST') {
                throw new FeedbackError(400, 'bad_request', 'GET, or POST {"note": "...", "context": {...}}');
            }
            // like the Share page: only this site's own pages (a page elsewhere cannot set Origin), and only JSON (a
            // plain form cannot send it)
            if (req.headers.origin !== origin) {
                throw new FeedbackError(403, 'forbidden', "feedback comes only from this site's own pages");
            }
            if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
                throw new FeedbackError(400, 'bad_request', 'send JSON');
            }
            let q;
            try {
                q = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8'));
            } catch (e) {
                if (e?.code === 'too_large') {
                    throw new FeedbackError(413, 'too_large', `at most ${MAX_BODY} bytes`);
                }
                throw new FeedbackError(400, 'bad_request', 'body is not JSON');
            }
            sendJson(res, 200, { result: take(who, q) }, req);
        } catch (e) {
            if (!(e instanceof FeedbackError)) {
                throw e;
            }
            sendJson(res, e.status, { error: { code: e.code, message: e.message } }, req);
        }
        return true;
    }

    return { route, inject, may, STATES };
}

module.exports = { createFeedback, STATES, PER_DAY, ALL_PER_DAY, MAX_NOTE, MAX_CONTEXT };
