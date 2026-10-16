// The window's feedback widget (bot/arena/feedback.js adds it to every page the window sends): a Feedback button and the
// ` key (Backquote). A note goes to POST /api/feedback with what was on screen when the person opened the box: the page,
// the window's size, recent script errors, and what Holotable's viewer kit reports (SWUViewer.feedbackContext(): the
// game, the step, the prompt, the board). The person can see exactly what goes, and leave it out.
//
// A page places the button with an element marked data-feedback-slot (its value: the class names the button takes, so
// it looks like the page's own buttons); without one, the button floats in the bottom right corner. While an element
// marked data-feedback-hide is on the page, the floating button hides (the key still works). A page can add its own
// details with window.swuFeedbackContext = () => ({...}).
(() => {
  'use strict';
  if (window.__swuFeedback || !document.body) return;
  window.__swuFeedback = true;

  const MAX_NOTE = 2000;
  const MAX_CONTEXT = 60000;
  const ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M2.5 3.5h11v7.2H8.2L5 13.2v-2.5H2.5z"/><path d="M5.2 6.2h5.6M5.2 8.3h3.6"/></svg>';

  // the last few script errors on this page, sent with a note: often the cause of what the person saw
  const errors = [];
  const keepError = (msg, src, line) => {
    errors.push({ at: new Date().toISOString(), msg: String(msg).slice(0, 300), ...(src ? { src: String(src).slice(0, 200) } : {}), ...(line ? { line } : {}) });
    if (errors.length > 10) errors.shift();
  };
  addEventListener('error', (e) => {
    if (e.target && e.target !== window) {
      keepError('failed to load', e.target.src || e.target.href || e.target.tagName);
    } else {
      keepError(e.message || (e.error && e.error.message) || 'error', e.filename, e.lineno);
    }
  }, true);
  addEventListener('unhandledrejection', (e) => keepError(`unhandled rejection: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));

  // a query string without anything that looks like a secret
  const query = () => {
    const q = new URLSearchParams(location.search);
    for (const k of [...q.keys()]) if (/token|key|code|secret|state|session|pass/i.test(k)) q.set(k, '(hidden)');
    const s = q.toString();
    return s ? `?${s}` : '';
  };
  const size = (x) => JSON.stringify(x).length;
  // under MAX_CONTEXT: boards go first, then the page's own details, then the viewer's
  function fit(ctx) {
    if (size(ctx) <= MAX_CONTEXT) return ctx;
    if (Array.isArray(ctx.viewer)) ctx.viewer = ctx.viewer.map((v) => (v && typeof v === 'object' && 'board' in v ? { ...v, board: '(left out: too big)' } : v));
    if (size(ctx) <= MAX_CONTEXT) return ctx;
    if (ctx.pageState) ctx.pageState = '(left out: too big)';
    if (size(ctx) <= MAX_CONTEXT) return ctx;
    ctx.viewer = '(left out: too big)';
    return ctx;
  }
  function onScreen() {
    const ctx = {
      page: { path: location.pathname, query: query(), hash: location.hash.slice(0, 300), title: document.title.slice(0, 200) },
      screen: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, touch: matchMedia('(pointer: coarse)').matches },
      browser: navigator.userAgent.slice(0, 300),
      at: new Date().toISOString()
    };
    if (errors.length) ctx.errors = errors.slice();
    try {
      const v = window.SWUViewer && typeof window.SWUViewer.feedbackContext === 'function' ? window.SWUViewer.feedbackContext() : null;
      if (Array.isArray(v) && v.length) ctx.viewer = JSON.parse(JSON.stringify(v));
    } catch (e) {
      ctx.viewerError = String((e && e.message) || e).slice(0, 200);
    }
    try {
      const p = typeof window.swuFeedbackContext === 'function' ? window.swuFeedbackContext() : null;
      if (p && typeof p === 'object') ctx.pageState = JSON.parse(JSON.stringify(p));
    } catch (e) {
      ctx.pageStateError = String((e && e.message) || e).slice(0, 200);
    }
    return fit(ctx);
  }

  const CSS = `
:host { all: initial; }
.fb { --bg: #0f1829; --raised: #16223a; --line: #2a3a5c; --ink: #e6ecf8; --dim: #93a2c4; --accent: #56c8ff; --good: #4fe0a8; --bad: #ff7b72; --scrim: rgb(2 6 14 / .6);
  --sans: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif; --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
  font: 15px/1.45 var(--sans); color: var(--ink); }
.fb.light { --bg: #ffffff; --raised: #f3f5f9; --line: #cdd5e3; --ink: #172033; --dim: #56627a; --accent: #1f6fd1; --good: #127a52; --bad: #c2332a; --scrim: rgb(20 28 44 / .35); }
.fab { position: fixed; z-index: 2147483000; right: calc(12px + env(safe-area-inset-right, 0px)); bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  display: inline-flex; align-items: center; gap: 6px; height: 36px; min-width: 36px; padding: 0 10px; justify-content: center;
  font: 600 13px/1 var(--sans); color: var(--ink); background: color-mix(in oklab, var(--bg) 90%, transparent); border: 1px solid var(--line); border-radius: 18px;
  box-shadow: 0 4px 14px rgb(0 0 0 / .3); cursor: pointer; opacity: .82; backdrop-filter: blur(6px); }
.fab:hover, .fab:focus-visible { opacity: 1; border-color: var(--accent); }
.fab:focus-visible, button:focus-visible, textarea:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.fab[hidden] { display: none; }
.fab .t, .fab kbd { display: none; }
@media (min-width: 900px) and (pointer: fine) { .fab { padding: 0 12px; } .fab .t { display: inline; } .fab kbd { display: inline; } }
kbd { font: 500 11px/1 var(--mono); color: var(--dim); border: 1px solid var(--line); border-radius: 4px; padding: 2px 5px; }
dialog { padding: 0; border: 1px solid var(--line); border-radius: 14px; background: var(--bg); color: var(--ink); width: min(520px, calc(100vw - 32px)); max-height: calc(100dvh - 32px);
  box-shadow: 0 18px 60px rgb(0 0 0 / .45); }
dialog::backdrop { background: var(--scrim); }
form { display: grid; gap: 12px; padding: 18px 18px 16px; }
h2 { margin: 0; font: 650 18px/1.2 "Oxanium", "Chakra Petch", "Segoe UI", system-ui, sans-serif; }
p { margin: 0; }
.sub { color: var(--dim); font-size: 14px; }
textarea { box-sizing: border-box; width: 100%; min-height: 120px; resize: vertical; padding: 10px 12px; font: 15px/1.45 var(--sans); color: var(--ink); background: var(--raised);
  border: 1px solid var(--line); border-radius: 10px; }
.row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; font-size: 14px; }
label { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); margin: 0; }
.count { color: var(--dim); font: 12px/1 var(--mono); }
details { font-size: 13px; color: var(--dim); }
summary { cursor: pointer; }
pre { margin: 8px 0 0; max-height: 180px; overflow: auto; padding: 8px 10px; background: var(--raised); border: 1px solid var(--line); border-radius: 8px;
  font: 11px/1.4 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink); }
.msg { min-height: 1.45em; font-size: 14px; color: var(--dim); }
.msg.good { color: var(--good); }
.msg.bad { color: var(--bad); }
.actions { display: flex; justify-content: flex-end; gap: 10px; }
.actions button { font: 600 14px/1 var(--sans); padding: 10px 14px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--ink); cursor: pointer; }
.actions .go { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.actions .go:disabled { opacity: .6; cursor: default; }
.mine { border-top: 1px solid var(--line); padding-top: 10px; }
.mine h3 { margin: 0 0 6px; font: 600 12px/1.2 var(--sans); color: var(--dim); text-transform: uppercase; letter-spacing: .06em; }
.mine ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 13px; }
.mine li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; }
.mine .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mine .s { color: var(--dim); white-space: nowrap; }
`;

  const host = document.createElement('div');
  host.setAttribute('data-swu-feedback', '');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${CSS}</style><div class="fb">
<button class="fab" type="button" aria-label="Send feedback" title="Send feedback (\`)">${ICON}<span class="t">Feedback</span><kbd>\`</kbd></button>
<dialog aria-labelledby="fb-h"><form novalidate>
  <h2 id="fb-h">Send feedback</h2>
  <p class="sub">What went wrong, or what would make this better? Eric and Claude read every note.</p>
  <textarea id="note" maxlength="${MAX_NOTE}" aria-label="Your note" placeholder="I clicked … and expected … but saw …"></textarea>
  <div class="row"><label><input type="checkbox" id="ctx" checked> Include what's on screen (page, game, step, board)</label><span class="count" id="count">0 / ${MAX_NOTE}</span></div>
  <details><summary>What gets sent</summary><pre id="pre"></pre></details>
  <p class="msg" id="msg" role="status" aria-live="polite"></p>
  <div class="actions"><button type="button" id="cancel">Cancel</button><button type="submit" class="go" id="send">Send</button></div>
  <div class="mine" id="mine" hidden><h3>Your notes</h3><ul id="list"></ul></div>
</form></dialog></div>`;
  document.body.appendChild(host);

  const $ = (id) => shadow.getElementById(id);
  const root = shadow.querySelector('.fb');
  const fab = shadow.querySelector('.fab');
  const dlg = shadow.querySelector('dialog');
  const form = shadow.querySelector('form');
  const note = $('note');
  const ctxBox = $('ctx');
  const msg = (text, tone = '') => {
    $('msg').textContent = text;
    $('msg').className = `msg ${tone}`;
  };
  let ctx = null;
  let opener = null;

  // the page's own button, where the page asks for one
  const slot = document.querySelector('[data-feedback-slot]');
  if (slot) {
    const b = document.createElement('button');
    b.type = 'button';
    const cls = slot.getAttribute('data-feedback-slot') || '';
    b.className = cls;
    // no classes named: the page's own button look, made compact for an icon
    if (!cls) b.style.cssText = 'padding: 6px 8px; line-height: 0;';
    b.setAttribute('aria-label', 'Send feedback');
    b.title = 'Send feedback (`)';
    b.innerHTML = ICON;
    b.addEventListener('click', () => open(b));
    slot.appendChild(b);
    fab.hidden = true;
  } else {
    fab.addEventListener('click', () => open(fab));
    const hide = () => { fab.hidden = !!document.querySelector('[data-feedback-hide]'); };
    hide();
    setInterval(hide, 1500);
  }

  function theme() {
    const cs = getComputedStyle(document.documentElement).colorScheme || '';
    const light = /^light/.test(cs) || (!/dark/.test(cs) && !matchMedia('(prefers-color-scheme: dark)').matches);
    root.classList.toggle('light', light);
  }
  const count = () => { $('count').textContent = `${note.value.length} / ${MAX_NOTE}`; };
  const showWhat = () => { $('pre').textContent = ctxBox.checked && ctx ? JSON.stringify(ctx, null, 2) : 'Only your note and your GitHub name.'; };

  async function loadMine() {
    try {
      const r = await fetch('/api/feedback', { credentials: 'same-origin' });
      const j = await r.json();
      const notes = (j && j.result && j.result.notes) || [];
      $('mine').hidden = !notes.length;
      $('list').replaceChildren(...notes.slice(0, 5).map((n) => {
        const li = document.createElement('li');
        const a = document.createElement('span');
        a.className = 'n';
        a.textContent = n.note;
        a.title = `${new Date(n.at).toLocaleString()}: ${n.note}`;
        const s = document.createElement('span');
        s.className = 's';
        s.textContent = n.label;
        li.append(a, s);
        return li;
      }));
    } catch {
      $('mine').hidden = true;
    }
  }

  function open(from) {
    if (dlg.open) return;
    opener = from || document.activeElement;
    ctx = onScreen(); // what was on screen when the person asked, before the box covers it
    theme();
    showWhat();
    count();
    msg('');
    dlg.showModal();
    note.focus();
    loadMine();
  }
  function close() {
    if (dlg.open) dlg.close();
  }
  dlg.addEventListener('close', () => {
    if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus({ preventScroll: true });
  });
  // a click on the backdrop closes the box
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  $('cancel').addEventListener('click', close);
  note.addEventListener('input', count);
  ctxBox.addEventListener('change', showWhat);

  let sending = false;
  async function send() {
    const text = note.value.trim();
    if (!text) {
      msg('Write a few words first.', 'bad');
      note.focus();
      return;
    }
    if (sending) return;
    sending = true;
    $('send').disabled = true;
    msg('Sending…');
    try {
      const r = await fetch('/api/feedback', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: text, context: ctxBox.checked ? ctx : null })
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error((j && j.error && j.error.message) || `the site answered ${r.status}`);
      note.value = '';
      count();
      msg('Sent. Thank you!', 'good');
      loadMine();
      setTimeout(close, 1500);
    } catch (e) {
      msg(`Not sent: ${e.message}`, 'bad');
    } finally {
      sending = false;
      $('send').disabled = false;
    }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); send(); });

  const typing = (t) => !!t && (t.isContentEditable || (t.closest && !!t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')));
  // Keys: first on the whole page (capture), so the page's own keys (Holotable's play keys answer letters and digits) never
  // see a key meant for the box, and the ` key is the box's alone
  const keys = (e) => {
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(host)) {
      if (e.type === 'keydown' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send();
      }
      e.stopImmediatePropagation();
      return;
    }
    if (e.type !== 'keydown' || e.code !== 'Backquote' || e.ctrlKey || e.metaKey || e.altKey || e.repeat || dlg.open) return;
    if (typing(path[0] || e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    open(null);
  };
  for (const t of ['keydown', 'keyup', 'keypress']) addEventListener(t, keys, true);
})();
