'use strict';
// SWU Arena app: one page per object, hash routes, live from the shared folder when the viewer allows it.
// Built into one HTML file by app/build.mjs (see app/README.md); the design notes are in app/DESIGN.md.
let M = DATA.model;
const KIT = window.SWUViewer || null;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pref = {
  get(k, d) { try { const v = localStorage.getItem('swuapp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('swuapp.' + k, JSON.stringify(v)); } catch {} },
};
// audience is fixed at build time: 'project' (Eric and the threads, with Lab) or 'public' (friends: no Lab, no thread names)
const S = { aud: DATA.audience === 'public' ? 'public' : 'project', seen: pref.get('seen', null), live: false, api: false, apiVersion: null, files: null, reader: null, prefix: '', syncedAt: null, botSort: ['rating', -1], botFam: new Set(), botQ: '', botAll: false, botStyle: new Set(), gamesPage: 0, gamesF: { bot: '', run: '', res: 'all', replay: false }, peopleF: 'all', peoplePage: 0, cmp: null, me: null, share: null };
// live mode reads the project's shared folder through the files capability; the public build never does (pick 6)
const CAN_LIVE = S.aud === 'project';
// served by the arena web server (app at /, the arena's own page with its forms at /arena), not as a file or a Claude artifact
const HOSTED = /^https?:$/.test(location.protocol) && !window.claude && !/(^|\.)(claude\.ai|claudeusercontent\.com|claude\.site|anthropic\.com)$/.test(location.hostname);
setTimeout(() => pref.set('seen', new Date().toISOString()), 4000);

// ---------- formatting ----------
const NOW = () => Date.now();
function ago(t) { if (!t) return '-'; const s = (NOW() - Date.parse(t)) / 1000; if (!isFinite(s)) return '-'; if (s < 60) return 'now'; if (s < 3600) return `${Math.round(s / 60)} min`; if (s < 86400) return `${Math.round(s / 3600)} h`; return `${Math.round(s / 86400)} d`; }
const clock = t => t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';
const pct = v => v == null ? '-' : `${Math.round(v * 100)}%`;
const pts = v => v == null ? '-' : `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))}`;
const ms = v => v == null ? '-' : v < 1 ? `${v.toFixed(2)} ms` : v < 1000 ? `${v < 10 ? v.toFixed(1) : Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;
const int = v => v == null ? '-' : Number(v).toLocaleString('en-US');
const href = (...p) => '#/' + p.filter(x => x !== '' && x != null).map(x => encodeURIComponent(x)).join('/');

// ---------- identity: family colours ----------
// From the Atlas kit (AtlasKit.FAMILIES): one hue band per family, each bot its own shade in it, the same on the
// Atlas, the dashboard and here. FAMS below is only the fallback if the kit has no band for a family.
const FAMS = {
  search: { h: [236, 254], name: 'search', desc: 'simulates futures (MCTS, alpha-beta, PIMC)' },
  learned: { h: [290, 306], name: 'learned', desc: 'a trained model picks or scores moves' },
  llm: { h: [188, 200], name: 'LLM', desc: 'a language model picks moves' },
  heuristic: { h: [40, 56], name: 'heuristic', desc: 'scores moves with a hand-written evaluation' },
  rules: { h: [88, 98], name: 'rules', desc: 'fixed priority list, no position score' },
  random: { h: [250, 250], c: .025, name: 'random', desc: 'uniform random choice' },
  other: { h: [70, 80], c: .035, name: 'other', desc: 'not classified yet' },
};
function oklchOf(hex) {
  const n = parseInt(hex.slice(1), 16), lin = c => (c /= 255) <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  const r = lin(n >> 16 & 255), g = lin(n >> 8 & 255), b = lin(n & 255);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b), m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b), q = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  const L = .2104542553 * l + .793617785 * m - .0040720468 * q, A = 1.9779984951 * l - 2.428592205 * m + .4505937099 * q, B = .0259040371 * l + .7827717662 * m - .808675766 * q;
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180 / Math.PI + 360) % 360];
}
const KITBANDS = Object.fromEntries(Object.keys(FAMS).map(f => {
  const K = window.AtlasKit?.FAMILIES?.find(x => x.family === f) || window.AtlasKit?.FAMILIES?.find(x => x.family === 'other');
  if (!K) return [f, FAMS[f]];
  const lt = oklchOf(K.light), dk = oklchOf(K.dark);
  return [f, { h: K.hue || [lt[2] - 7, lt[2] + 7], c: K.chroma != null && K.chroma < .1 ? K.chroma : (K.hue ? FAMS[f].c : lt[1] < .05 ? lt[1] : undefined), exact: { light: lt, dark: dk }, kit: K.label, desc: K.desc }];
}));
const isDark = () => document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
const band = f => KITBANDS[f] || KITBANDS.other;
let COLOR = {};
function buildColors() {
  COLOR = {}; const dark = isDark();
  for (const f of Object.keys(FAMS)) {
    const list = Object.keys(M.bots).filter(id => M.bots[id].fam === f).sort(), F = band(f), n = list.length;
    list.forEach((id, i) => {
      const t = n === 1 ? .5 : i / (n - 1), h = ((F.h[0] + (F.h[1] - F.h[0]) * t) % 360 + 360) % 360, warm = h > 30 && h < 110;
      const L = (dark ? [.76, .68, .84] : warm ? [.63, .55, .69] : [.57, .49, .64])[i % 3], C = F.c ?? (L > .8 ? .13 : warm ? .16 : .17);
      COLOR[id] = `oklch(${L} ${C} ${h.toFixed(1)})`;
    });
  }
}
const famColor = f => {
  const F = band(f);
  if (F.exact) { const [L, C, h] = F.exact[isDark() ? 'dark' : 'light']; return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${(h % 360).toFixed(1)})`; }
  const h = ((F.h[0] + F.h[1]) / 2) % 360; return `oklch(${isDark() ? .76 : h > 30 && h < 110 ? .6 : .55} ${F.c ?? .17} ${h})`;
};
const famOf = id => M.bots[id]?.fam || SWUApp.guessFamily(id);
const botColor = id => COLOR[id] || famColor(famOf(id));
const onColor = c => { const m = /oklch\(([\d.]+)/.exec(c); return m && +m[1] > .68 ? '#141a29' : '#fff'; };
const famChip = f => `<span class="fam" style="--c:${famColor(f)}" title="${esc(KITBANDS[f]?.desc || FAMS[f]?.desc || '')}">${esc(FAMS[f]?.name || f)}</span>`;
const langChip = l => l ? `<span class="lang">${esc(l)}</span>` : '';
const isArenaVersion = id => /-v\d+$/.test(id);
function botLink(id, opts = {}) {
  if (!id) return '<span class="faint">-</span>';
  const c = botColor(id), known = !!M.bots[id];
  const inner = `<i style="--c:${c}"></i><span>${esc(id)}</span>`;
  return known ? `<a class="bot" href="${href('bots', id)}" style="--c:${c}" title="${esc(M.bots[id].line || '')}">${inner}</a>` : `<span class="bot" style="--c:${c}">${inner}</span>`;
}
const ownerText = id => S.aud === 'public' ? '' : (M.bots[id]?.owner || '');

// ---------- small charts ----------
function spark(vals, c, w = 84, h = 22) {
  if (!vals || vals.length < 2) return '<span class="faint">-</span>';
  const lo = Math.min(...vals), hi = Math.max(...vals), sp = hi - lo || 1;
  const pts2 = vals.map((v, i) => `${(i / (vals.length - 1) * (w - 4) + 2).toFixed(1)},${(h - 3 - (v - lo) / sp * (h - 6)).toFixed(1)}`);
  const last = pts2.at(-1).split(',');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts2.join(' ')}" fill="none" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/><circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="${c}"/></svg>`;
}
function hbars(items, { lo = 0, hi = 1, mid = null, fmt = v => v } = {}) {
  const x = v => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
  return `<div class="hb">${items.map(it => {
    const a = mid == null ? 0 : x(mid), b = x(it.v), l = Math.min(a, b), w = Math.abs(b - a);
    return `<span class="t" title="${esc(it.title || it.t)}">${it.html || esc(it.t)}</span><span class="track">${mid != null ? `<i class="mid" style="left:${a}%"></i>` : ''}<i class="bar" style="left:${l}%;width:${Math.max(w, .8)}%;--c:${it.c || 'var(--accent)'}"></i></span><span class="v">${esc(fmt(it.v))}</span>`;
  }).join('')}</div>`;
}
function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0)), err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag, out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
/** Lines over a shared x axis (series coloured by bot where a name is a bot), labels at the line ends. */
function lineChart(series, { w = 640, h = 230, yFmt = v => v, xFmt = v => v, xLabel = '', yLo = null, yHi = null, xCats = null, labels = true, label = '' } = {}) {
  const all = series.flatMap(s => s.points);
  if (!all.length) return '<p class="muted">No points yet.</p>';
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x0 === x1) { x0 -= 1; x1 += 1; }
  let y0 = yLo ?? Math.min(...ys), y1 = yHi ?? Math.max(...ys); if (y0 === y1) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * .06; if (yLo == null) y0 -= pad; if (yHi == null) y1 += pad;
  const L = 44, R = labels ? 118 : 12, T = 10, B = 30, X = v => L + (v - x0) / (x1 - x0) * (w - L - R), Y = v => T + (1 - (v - y0) / (y1 - y0)) * (h - T - B);
  const yt = niceTicks(y0, y1, 4), xt = xCats ? xCats.map((_, i) => i) : niceTicks(x0, x1, 6);
  let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label || `Line chart of ${series.slice(0, 6).map(s => s.name).join(', ')}${xLabel ? ` by ${xLabel}` : ''}`)}">`;
  for (const v of yt) svg += `<line class="grid-line" x1="${L}" x2="${w - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 3}" text-anchor="end">${esc(yFmt(v))}</text>`;
  for (const v of xt) svg += `<text x="${X(v)}" y="${h - B + 14}" text-anchor="middle">${esc(xCats ? xCats[v] : xFmt(v))}</text>`;
  if (xLabel) svg += `<text x="${w - R}" y="${h - 4}" text-anchor="end">${esc(xLabel)}</text>`;
  const ends = [];
  for (const s of series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 1.8}" ${s.dash ? 'stroke-dasharray="4 3"' : ''} stroke-linejoin="round"><title>${esc(s.name)}</title></path>`;
    const p = s.points.at(-1); svg += `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="3" fill="${s.color}"/>`;
    if (!s.nolabel) ends.push({ y: Y(p[1]), x: X(p[0]), name: s.name, c: s.color, v: p[1] });
  }
  if (labels) { ends.sort((a, b) => a.y - b.y); for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12; for (const e of ends) svg += `<text x="${e.x + 7}" y="${e.y + 3}" style="fill:${e.c}">${esc(e.name)} ${esc(yFmt(e.v))}</text>`; }
  return `<div class="chart">${svg}</svg></div>`;
}

// ---------- shared bits ----------
const PILL = { holds: 'holds', partly: 'partly', open: 'open' };
/** Long floats in posted text (1.4975000000000023) shown to two places. */
const numFix = s => String(s ?? '').replace(/-?\d+\.\d{4,}/g, m => String(+(+m).toFixed(2)));
const GLYPHC = { p1: 'var(--fa)', p2: 'var(--fb)', hi: 'var(--pos-4)', lo: 'var(--neg-4)' };
const verdictPill = f => `<span class="pill ${PILL[f.v] || 'open'}">${esc(f.label)}</span>`;
function bottomLine(F) {
  const n = F.length, holds = F.filter(f => f.v === 'holds').length, partly = F.filter(f => f.v === 'partly').length, open = n - holds - partly;
  return `Of ${n} proven claims, ${holds} ${holds === 1 ? 'passes' : 'pass'} a direct test on our games, ${partly} agree with our numbers without testing them directly, and ${open} ${open === 1 ? 'is' : 'are'} not tested yet. In practice: judge an evaluator by how often it calls real endings right, and expect early positions to be the hard ones.`;
}
const runById = id => M.runs.find(r => r.id === id);
const gameRow = g => { const run = M.runs[g[0]], p1 = M.botList[g[2]], p2 = M.botList[g[3]]; return { run, id: g[1], p1, p2, res: g[4], rounds: g[5], steps: g[6], forfeit: g[7], human: humanSeat(run, p1, p2) }; };
// ---------- games against people (karabast.net) ----------
// The person is the seat the feed calls "opponent" (the Karabast feed names every person so), or a seat its run's own
// bots list leaves out (that list names our bots). People are never named in the app.
const isPeople = i => M.runs[M.games[i][0]]?.kind === 'people';
const isPerson = (run, n) => run?.kind === 'people' && (n === 'opponent' || (run.ours?.length > 0 && !run.ours.includes(n)));
function humanSeat(run, p1, p2) {
  const person = n => isPerson(run, n);
  return person(p1) && !person(p2) ? 'p1' : person(p2) && !person(p1) ? 'p2' : null;
}
const PERSON_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5" r="2.6"/><path d="M2.8 14.2c.6-2.8 2.6-4.3 5.2-4.3s4.6 1.5 5.2 4.3"/></svg>';
const personChip = () => `<span class="person" title="a real person on karabast.net (people are never named here)">${PERSON_ICON}<span>a person</span></span>`;
const seatLink = (x, s) => x.human === s ? personChip() : botLink(x[s]);
const winnerName = x => x.res === 0 || x.res === 1 ? (x.human === (x.res === 0 ? 'p1' : 'p2') ? 'the person' : x.res === 0 ? x.p1 : x.p2) : null;
const humanPill = () => '<span class="pill human" title="our bot against a real person on karabast.net; these games never change a rating">vs a person</span>';
const gameIdx = new Map(); function indexGames() { gameIdx.clear(); M.games.forEach((g, i) => gameIdx.set(`${M.runs[g[0]].id}/${g[1]}`, i)); }
const hasReplay = i => M.replay?.[i] === '1' || (S.live && !S.api && !!M.runs[M.games[i][0]]?.dir); // the window's model marks its replays
function resText(g) {
  const x = gameRow(g);
  if (x.res === 3) return '<span class="pill live">playing</span>';
  if (x.res === 4) return '<span class="res faint">not rated</span>';
  if (x.res === 5) return x.run?.kind === 'people' ? '<span class="res faint" title="the game never started or went silent">abandoned</span>' : '<span class="res faint" title="its run stopped sending before this game ended">stopped</span>';
  if (x.res === 2) return '<span class="res">draw</span>';
  return `${seatLink(x, x.res === 0 ? 'p1' : 'p2')}${x.forfeit ? ' <span class="res warn" title="the other bot failed (late, illegal or broken reply)">by forfeit</span>' : ''}`;
}
function gamesTable(rows, { showRun = true, me = null } = {}) {
  if (!rows.length) return '<p class="muted">No games.</p>';
  return `<div class="scroll"><table><thead><tr>${showRun ? '<th>Run</th>' : ''}<th>Player 1</th><th>Player 2</th><th>Winner</th><th class="n">Rounds</th><th class="n hide-sm">Steps</th><th></th></tr></thead><tbody>${rows.map(i => {
    const g = M.games[i], x = gameRow(g), lost = me && x.res < 2 && (x.res === 0 ? x.p2 : x.p1) === me;
    return `<tr class="click${lost ? '' : ''}" data-href="${href('games', x.run.id, x.id)}">${showRun ? `<td><a href="${href('runs', x.run.id)}" class="mono" style="font-size:var(--fs-sm)">${esc(x.run.id)}</a></td>` : ''}<td>${seatLink(x, 'p1')}</td><td>${seatLink(x, 'p2')}</td><td>${resText(g)}${lost ? ' <span class="res bad">lost</span>' : ''}</td><td class="n">${x.rounds ?? '-'}</td><td class="n hide-sm">${x.steps ?? '-'}</td><td class="n">${hasReplay(i) ? `<a href="${href('games', x.run.id, x.id)}" title="Watch">Watch</a>` : '<span class="faint" title="this run kept no replay">-</span>'}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function gameGrid(run, { maxBots = 14 } = {}) {
  const bots = run.bots.slice(0, maxBots), ix = M.games.map((g, i) => i).filter(i => M.games[i][0] === M.runs.indexOf(run));
  const by = {};
  for (const i of ix) { const x = gameRow(M.games[i]); (by[`${x.p1}|${x.p2}`] ||= []).push(i); (by[`${x.p2}|${x.p1}`] ||= []).push(i); }
  const per = run.gamesPerPairing || 2, name = b => isPerson(run, b) ? 'a person' : b;
  let h = `<div class="scroll"><table class="rgrid"><thead><tr><th></th>${bots.map(b => `<th class="rot"><div title="${esc(name(b))}">${esc(name(b))}</div></th>`).join('')}</tr></thead><tbody>`;
  for (const a of bots) {
    h += `<tr><th>${isPerson(run, a) ? personChip() : botLink(a)}</th>`;
    for (const b of bots) {
      if (a === b) { h += '<td><div class="cell self"></div></td>'; continue; }
      const gs = by[`${a}|${b}`] || [];
      const sq = gs.map(i => { const x = gameRow(M.games[i]); const k = x.res === 3 ? 'p' : x.res === 2 ? 'd' : x.res >= 4 ? '' : (x.res === 0 ? x.p1 : x.p2) === a ? 'w' : 'l'; return `<a class="${k}" href="${href('games', run.id, x.id)}" title="${esc(`${name(x.p1)} vs ${name(x.p2)}: ${k === 'w' ? name(a) + ' won' : k === 'l' ? name(b) + ' won' : k === 'p' ? 'playing' : k === 'd' ? 'draw' : x.res === 5 ? 'stopped before it ended' : 'not rated'}`)}"></a>`; });
      for (let k = gs.length; k < per; k++) sq.push('<span title="not played yet"></span>');
      h += `<td><div class="cell">${sq.join('')}</div></td>`;
    }
    h += '</tr>';
  }
  return h + `</tbody></table></div><p class="muted" style="font-size:var(--fs-sm);margin-top:6px">Each square is one game from the row bot's side: <b class="good">won</b>, <b class="bad">lost</b>, outlined = playing now, grey = not played yet. Click a square to watch.</p>`;
}
function md(text) {
  const lines = String(text || '').split('\n'); let out = '', inList = false, tbl = null;
  const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const flush = () => { if (inList) { out += '</ul>'; inList = false; } if (tbl) { out += `<div class="scroll"><table><thead><tr>${tbl[0].map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${tbl.slice(tbl[1]?.every(c => /^:?-+:?$/.test(c)) ? 2 : 1).map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`; tbl = null; } };
  for (const l of lines) {
    if (/^\|/.test(l)) { if (!tbl) { flush(); tbl = []; } tbl.push(l.replace(/^\||\|$/g, '').split('|').map(s => s.trim())); continue; }
    if (/^- /.test(l)) { if (tbl) flush(); if (!inList) { out += '<ul>'; inList = true; } out += `<li>${inline(l.slice(2))}</li>`; continue; }
    flush();
    if (/^# /.test(l)) out += `<h1>${inline(l.slice(2))}</h1>`; else if (/^## /.test(l)) out += `<h2>${inline(l.slice(3))}</h2>`; else if (l.trim()) out += `<p>${inline(l)}</p>`;
  }
  flush(); return `<div class="md">${out}</div>`;
}

// ---------- the Strategy Atlas framework (core rule: every bot is described with these icons and words) ----------
// Spots, "pts of win chance above an average bot", When behind / Close or long / When ahead, ★ best in spot,
// ▲ ▼ its own best and worst spot, ⏱ games lost by a late or broken reply, and the style words (Racer, Bruiser...).
const AT = window.SWUAtlas;
const ATL = () => M.research.atlas;
const atl = id => ATL()?.byId?.[id] || null;
const SITS = () => ATL()?.situations || [];
const sit = sid => SITS().find(s => s.id === sid) || { id: sid, label: sid, short: '', group: '' };
const GROUPS = () => [...new Set(SITS().map(s => s.group))];
const STYLE_DESC = Object.fromEntries(AT?.STYLE_KEY || []);
const spotIcon = (sid, cls = 'pict') => AT ? AT.icon(sid, cls, `${sit(sid).label}: ${sit(sid).short}`) : '';
const spotTag = (sid, cls = 'pict s') => `<span class="spot-tag" title="${esc(sit(sid).short)}">${spotIcon(sid, cls)}<b>${esc(sit(sid).label)}</b></span>`;
const styleTag = st => st ? `<span class="stag ${esc(st)}" title="${esc(STYLE_DESC[st] || '')}">${esc(st)}</span>` : '';
const stars = id => SITS().filter(s => ATL()?.best?.[s.id] === id).map(s => s.id);
const edgeTxt = e => e == null ? '-' : AT.pp(e);
/** The bot's nine spots as one strip of edge colours: its "fingerprint" in Atlas terms. */
function fingerprint(id, size = '') {
  const a = atl(id), A = ATL();
  if (!A) return '';
  const groups = GROUPS();
  if (!a || !(a.games >= AT.MIN_GAMES && a.replayGames >= 5)) {
    const why = !a ? 'not in the Atlas yet' : `not mapped yet: the Atlas needs 8+ games with 5+ replays (${a.replayGames || 0} replays)`;
    return `<span class="fp off ${size}" title="${esc(why)}">${groups.map(g => `<span class="g">${SITS().filter(s => s.group === g).map(() => '<i class="none"></i>').join('')}</span>`).join('')}</span>`;
  }
  const best = a.summary?.best?.id, worst = a.summary?.worst?.id;
  return `<span class="fp ${size}" role="img" aria-label="${esc(id)} in the nine spots">${groups.map(g => `<span class="g">${SITS().filter(s => s.group === g).map(s => {
    const c = a.situations?.[s.id];
    if (!c || !c.n) return `<i class="none" title="${esc(s.label)}: no games"></i>`;
    const col = AT.edgeColor(c.edge), mk = A.best[s.id] === id ? '★' : s.id === best ? '▲' : s.id === worst ? '▼' : '';
    return `<i class="${c.n < 5 ? 'few' : ''}" style="--c:${col.bg};--fc:${col.fg}" title="${esc(`${s.label}: ${edgeTxt(c.edge)} pts vs an average bot, won ${c.wins} of ${c.n}${mk === '★' ? ' · best of all bots here' : mk === '▲' ? ' · its best spot' : mk === '▼' ? ' · its worst spot' : ''}`)}">${size === 'md' ? mk : mk === '★' ? '★' : ''}</i>`;
  }).join('')}</span>`).join('')}</span>`;
}
const fpKey = () => `<span class="fp-key"><span>${GROUPS().map(g => esc(AT.GROUP[g] || g)).join(' · ')}</span><span class="ramp">${[5, 3, 1].map(k => `<i style="background:var(--neg-${k})"></i>`).join('')}<i style="background:var(--mid)"></i>${[1, 3, 5].map(k => `<i style="background:var(--pos-${k})"></i>`).join('')}</span><span>worse ← average → better</span><span>★ best of all bots in that spot · ▲▼ its own best and worst · dashed = no spot map yet (too few replays)</span></span>`;
/** One line in Atlas words: style, ★ spots, ⏱ forfeits. */
function atlasLine(id, { fp = true } = {}) {
  const a = atl(id); if (!a) return '';
  const st = stars(id), f = a.forfeits || 0;
  return `<div class="atlas-line">${fp ? fingerprint(id, 'md') : ''}${styleTag(a.summary?.style)}${st.length ? `<span class="mk star">★ best in</span>${st.map(s => spotTag(s)).join('')}` : ''}${f ? `<span class="mk clock" title="lost games by a late or broken reply">⏱ ${f}</span>` : ''}</div>`;
}
function standoutsLine() {
  const so = ATL()?.standouts || []; if (!so.length) return '';
  return `<div class="standouts">${so.map(s => s.kind === 'clock' ? `<span><b class="mk clock">⏱</b> lost games by a late or broken reply: ${s.bots.map(([b, n]) => `${botLink(b)} ${n}`).join(', ')}</span>` : `<span><b>${s.kind === 'racer' ? 'Most base-focused' : 'Removes the most units'}:</b> ${botLink(s.bot)} ${styleTag(atl(s.bot)?.summary?.style)} <span class="muted">${esc(s.value)}</span></span>`).join('')}</div>`;
}
function verdictLine() {
  const v = ATL()?.verdict; if (!v) return '';
  const nTop = stars(v.top).length;
  return v.same ? `The top-rated bot, ${botLink(v.top)}, is also best in the most spots (${v.n}).` : `The top-rated bot, ${botLink(v.top)}, is best in ${nTop} spot${nTop === 1 ? '' : 's'}; ${botLink(v.most)} is best in the most (${v.n}). Rating and spot skill measure different things.`;
}
/** Who to bet on, one tile per spot (mini = one row of nine for Home). */
function betTiles({ mini = false, n = 4 } = {}) {
  const A = ATL(); if (!A) return '<p class="muted">No Atlas data yet (meta/meta.json).</p>';
  if (mini) return `<div class="mini-bet">${SITS().map(s => { const r = AT.rankIn(A, s.id)[0]; return `<a href="${href('bots')}?spot=${s.id}" title="${esc(`${s.label}: ${s.short}`)}">${spotIcon(s.id)}<span>${esc(s.label)}</span>${r ? `<b>★ ${esc(r.id)}</b><span class="e">${edgeTxt(r.situations[s.id].edge)}</span>` : '<span class="faint">too few games</span>'}</a>`; }).join('')}</div>`;
  return `<div class="bet">${GROUPS().map(g => `<div class="col"><div class="eyebrow">${esc(AT.GROUP[g] || g)}</div>${SITS().filter(s => s.group === g).map(s => {
    const r = AT.rankIn(A, s.id), top = r.slice(0, n), mx = Math.max(0.05, ...top.map(b => b.situations[s.id].edge));
    return `<section class="box tile" id="spot-${s.id}">${spotIcon(s.id)}<div><h4>${esc(s.label)}</h4><div class="sub2">${esc(s.short)} · this side wins ${pct(s.field?.rate)} · ${r.length} bots with 8+ games here</div></div>${top.map((b, i) => { const c = b.situations[s.id], col = AT.edgeColor(c.edge); return `<div class="rk"><span class="mk ${i ? '' : 'star'}">${i ? i + 1 : '★'}</span>${botLink(b.id)}<span class="bb"><i style="width:${Math.max(2, c.edge / mx * 100)}%;--c:${col.bg}"></i></span><em title="won ${c.wins} of ${c.n}">${edgeTxt(c.edge)}</em></div>`; }).join('') || '<p class="muted" style="grid-column:1/-1;font-size:var(--fs-md)">No bot has 8+ games here yet.</p>'}</section>`;
  }).join('')}</div>`).join('')}</div>`;
}
/** Spots right now, under a game viewer: which spot each side is in, and how that bot does there. */
const GUIDE = { i: 0, t0: 0, auto: true, raf: 0, want: null };
function spotBarHtml(key) { return `<div class="spotbar" data-spotbar="${esc(key)}"></div>`; }
function fillSpotBar(v) {
  const el = document.querySelector(`[data-spotbar="${CSS.escape(v.game)}"]`); if (!el || !v.v || !AT) return;
  let g, st; try { g = v.v.getGame(); st = g.steps[Math.min(v.idx ?? g.steps.length - 1, g.steps.length - 1)]?.state; } catch { return; }
  if (!st?.players) return;
  const i = gameIdx.get(v.game), x = i != null ? gameRow(M.games[i]) : { p1: g.header?.p1, p2: g.header?.p2 };
  const sig = `${st.round}|${AT.spotsAt(st, 'p1')}|${AT.spotsAt(st, 'p2')}`; if (el.dataset.sig === sig) return; el.dataset.sig = sig;
  const row = (pid, name) => { const sp = st.round >= 1 ? AT.spotsAt(st, pid) : [], a = atl(name); return `<div class="sb-row">${x.human === pid ? personChip() : botLink(name)}${x.human === pid ? '' : styleTag(a?.summary?.style)}${sp.length ? sp.map(sid => { const c = a?.situations?.[sid], best = ATL()?.best?.[sid]; return `<span class="sb-spot" title="${esc(sit(sid).short)}">${spotIcon(sid, 'pict s')}<b>${esc(sit(sid).label)}</b>${c?.n ? `<em class="${c.edge >= 0 ? 'good' : 'bad'}" title="this bot, ${c.n} games in this spot">${edgeTxt(c.edge)} pts</em>` : '<em class="faint">no data</em>'}${best === name ? '<span class="mk star" title="best of all bots in this spot">★</span>' : ''}</span>`; }).join('') : '<span class="muted">no spot yet: even, early game</span>'}</div>`; };
  el.innerHTML = `<div class="sb-head"><span>Atlas spots on this board · round ${st.round ?? '-'}</span><span>pts = this bot vs an average bot in that spot</span></div>${row('p1', x.p1)}${row('p2', x.p2)}`;
}

// ---------- sections and routing ----------
const SECTIONS = [
  { id: '', label: 'Home', icon: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' },
  { id: 'arena', label: 'Arena', sub: [['', 'Live'], ['standings', 'Standings'], ['builders', 'Builders'], ['rounds', 'Rounds'], ['join', 'Build a bot']], icon: 'M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z' },
  { id: 'bots', label: 'Bots', sub: [['', 'All bots'], ['faceoff', 'Face-off']], icon: 'M5 8h14v11H5zM12 4v4M9 13h.01M15 13h.01M9 16h6' },
  { id: 'games', label: 'Games', sub: [['', 'Now playing'], ['all', 'All games'], ['runs', 'Runs']], icon: 'M4 5h16v14H4zM4 12h16M12 5v14' },
  { id: 'people', label: 'Vs people', icon: 'M12 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM4.5 20.5c.8-4 3.7-6.2 7.5-6.2s6.7 2.2 7.5 6.2' },
  { id: 'research', label: 'Research', sub: [['', 'Overview'], ['evaluators', 'Evaluators'], ['analysis', 'Position analysis'], ['experiments', 'Experiments'], ['lines', 'Research lines'], ['speed', 'Speed']], icon: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3' },
  { id: 'lab', label: 'Lab', lab: true, sub: [['', 'Work threads'], ['waiting', 'Waiting on Eric'], ['health', 'Data health']] },
];
function route() {
  const [p, q] = location.hash.replace(/^#/, '').split('?');
  const parts = p.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
  const qs = new URLSearchParams(q || '');
  let sec = parts[0] || '';
  if (sec === 'runs') sec = 'games';
  // a game or run against people belongs to the Vs people tab
  if ((parts[0] === 'games' || parts[0] === 'runs') && parts[1] && runById(parts[1])?.kind === 'people') sec = 'people';
  return { parts, qs, sec };
}
function renderNav(r) {
  const secs = SECTIONS.filter(s => !(s.lab && S.aud === 'public'));
  $('nav').innerHTML = secs.map(s => `<a href="${s.id ? href(s.id) : '#/'}" class="${s.lab ? 'lab' : ''}" ${s.id === r.sec ? 'aria-current="page"' : ''}>${s.label}</a>`).join('');
  $('tabbar').innerHTML = secs.filter(s => !s.lab).map(s => `<a href="${s.id ? href(s.id) : '#/'}" ${s.id === r.sec ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${s.icon}"/></svg>${s.label}</a>`).join('');
  const sec = secs.find(s => s.id === r.sec), cur = r.parts[0] === 'runs' ? 'runs' : r.parts[1] || '';
  const sub = sec?.sub && !(r.sec === 'games' && r.parts[0] === 'games' && r.parts.length > 2) ? sec.sub : null;
  $('subnav').innerHTML = sub ? sub.map(([k, l]) => `<a href="${href(sec.id, k)}" ${k === cur || (k === 'builders' && cur === 'competitors') ? 'aria-current="page"' : ''}>${l}</a>`).join('') : '';
  $('subnav').hidden = !sub;
}

const PAGES = {
  '': pageHome,
  arena: r => ({ '': pageArenaLive, standings: pageArenaStandings, builders: r.parts[2] ? pageCompetitor : pageCompetitors, competitors: r.parts[2] ? pageCompetitor : pageCompetitors, rounds: pageRounds, join: pageJoin }[r.parts[1] || ''] || pageArenaLive)(r),
  bots: r => r.parts[1] === 'faceoff' ? pageFaceoff(r) : r.parts[1] ? pageBot(r) : pageBots(r),
  games: r => r.parts[1] === 'runs' ? pageRuns(r) : r.parts[2] ? pageGame(r) : r.parts[1] === 'all' ? pageGames(r) : pageLiveGrid(r),
  runs: r => r.parts[1] ? pageRun(r) : pageRuns(r),
  people: pagePeople,
  share: pageShare,
  research: r => ({ '': pageResearch, evaluators: pageEvaluators, atlas: atlasMoved, spots: atlasMoved, analysis: pageAnalysis, experiments: r.parts[2] ? pageExperiment : pageExperiments, lines: r.parts[2] ? pageLine : pageLines, speed: pageSpeed }[r.parts[1] || ''] || pageResearch)(r),
  lab: r => S.aud === 'public' ? `<div class="notice">Lab is only in the project build.</div>` : ({ '': pageLab, waiting: pageWaiting, health: pageHealth }[r.parts[1] || ''] || pageLab)(r),
};
let lastRouteKey = '';
/** Where the reader is: one heading, viewer, spot strip or board (readerAnchor picks it by where it is drawn), and where
 *  it sits on the page. When something above it changes size (a sync redraws the page, a live game's viewer grows), the
 *  page scrolls by as much as it moved, so nothing moves under the reader. */
const ANCHORS = '#main h1, #main h2, #main h3, #main .kithost, #main .spotbar, #main [data-tile]';
const anchorKey = el => { const sec = el.closest('[data-sec]')?.dataset.sec; return `${el.tagName}|${el.dataset.key || el.dataset.spotbar || el.dataset.tile || el.textContent.trim().slice(0, 80)}${sec ? `@${sec}` : ''}`; };
// a section that repeats a heading (each round's "Who beat whom") names itself with data-sec, so each copy has its own key
// whatever comes and goes around it; a key that still repeats is told apart by its count
function anchorList() {
  const seen = new Map();
  return [...document.querySelectorAll(ANCHORS)].map(el => { const k = anchorKey(el), n = seen.get(k) || 0; seen.set(k, n + 1); return { el, key: `${k}#${n}` }; });
}
function readerAnchor() {
  if (scrollY < 1) return null;
  // the reader's place, by where things are drawn (on a two-column page every anchor of the left column comes before the
  // right column's in the page): a viewer cut by the top edge that still fills a third of the screen, since they are
  // reading inside it; else the anchor nearest the top of the screen; else one cut by the top edge, then the nearest
  // above, then the nearest below
  let best = null, rank = [9, 0];
  for (const { el, key } of anchorList()) {
    if (!el.getClientRects().length) continue; // not drawn, like a phone-only part on a wide screen
    const b = el.getBoundingClientRect(), cut = b.top < 0 && b.bottom > 0;
    const r = cut && Math.min(b.bottom, innerHeight) >= innerHeight / 3 ? [0, 0] : b.top >= 0 && b.top < innerHeight ? [1, b.top]
      : cut ? [2, -b.top] : b.bottom <= 0 ? [3, -b.bottom] : [4, b.top];
    if (r[0] < rank[0] || (r[0] === rank[0] && r[1] < rank[1])) { best = { key, y: b.top + scrollY, sy: scrollY }; rank = r; }
  }
  return best;
}
function keepReader(a) {
  if (!a) return;
  const el = anchorList().find(x => x.key === a.key)?.el; if (!el) return;
  // a page that got shorter under a reader near its end has already pulled them up as far as it ends (scroll clamping):
  // that much of the move is made up for
  const maxY = document.documentElement.scrollHeight - innerHeight, clamped = scrollY < a.sy && scrollY >= maxY - 1 ? a.sy - scrollY : 0;
  const d = el.getBoundingClientRect().top + scrollY - a.y + clamped; if (Math.abs(d) >= 1) window.scrollBy(0, d);
}
// The browser's own scroll anchoring is off (style.css): iOS Safari has none, and Chrome's missed a live viewer growing
// above the reader on the two-column pages. The observer watches the page and every viewer and spot strip itself, since
// one that grows in the shorter column leaves the page's height as it was. readAt follows the reader as they scroll, but
// only while nothing watched has changed size since the observer last saw it: measuring then would take a change not
// made up for yet as their place.
const WATCHED = '#main, #main .kithost, #main .spotbar';
const sizesNow = () => [...document.querySelectorAll(WATCHED)].map(e => e.offsetHeight).join();
let readAt = null, readRaf = 0, sizes = '';
addEventListener('scroll', () => { if (!readRaf) readRaf = requestAnimationFrame(() => { readRaf = 0; if (sizesNow() === sizes) readAt = readerAnchor(); }); }, { passive: true });
const sizeWatch = window.ResizeObserver ? new ResizeObserver(() => { keepReader(readAt); readAt = readerAnchor(); sizes = sizesNow(); }) : null;
function watchSizes() { if (!sizeWatch) return; sizeWatch.disconnect(); for (const el of document.querySelectorAll(WATCHED)) sizeWatch.observe(el); }
watchSizes();
function render(keepScroll) {
  const r = route();
  const anchor = keepScroll ? readerAnchor() : null;
  renderNav(r);
  const key = location.hash.split('?')[0];
  const same = key === lastRouteKey; lastRouteKey = key;
  const fn = PAGES[r.parts[0] || ''] || PAGES[''];
  const keep = detachViewers();
  let html;
  try { html = fn(r); } catch (e) { console.error(e); html = `<div class="notice"><b>This page failed to draw.</b> ${esc(e.message)}</div>`; }
  $('main').innerHTML = html;
  attachViewers(keep);
  watchSizes();
  afterRender(r);
  document.title = `SWU Arena · ${pageTitle(r)}`;
  if (!same && !keepScroll) window.scrollTo(0, 0);
  else if (same) keepReader(anchor);
  readAt = readerAnchor(); sizes = sizesNow();
}
function pageTitle(r) { const s = SECTIONS.find(x => x.id === r.sec); return r.parts[1] && r.parts[0] !== 'research' && r.parts[0] !== 'arena' ? r.parts.slice(-1)[0] : s?.label || (r.parts[0] === 'share' ? 'Share' : 'Home'); }
function afterRender() {
  for (const tr of document.querySelectorAll('tr[data-href]')) tr.addEventListener('click', e => { if (e.target.closest('a,button')) return; location.hash = tr.dataset.href; });
  for (const el of document.querySelectorAll('[data-strategy]')) { try { const w = JSON.parse(el.dataset.strategy); window.SWUStrategy?.render(el, w); } catch {} }
  for (const b of document.querySelectorAll('[data-act]')) b.addEventListener('click', () => ACTIONS[b.dataset.act]?.(b));
  for (const i of document.querySelectorAll('[data-input]')) i.addEventListener(i.tagName === 'SELECT' || i.type === 'checkbox' ? 'change' : 'input', () => ACTIONS[i.dataset.input]?.(i));
  if ($('guide-svg')) startGuide();
  $('linkform')?.addEventListener('submit', e => {
    e.preventDefault();
    const v = $('linklabel').value.replace(/\s+/g, ' ').trim();
    if (!v) { S.share = { ...S.share, linkMsg: 'Write who the link is for, so you can tell the links apart.' }; render(true); return; }
    shareChange({ addLink: v.slice(0, 60) });
  });
  $('inviteform')?.addEventListener('submit', e => {
    e.preventDefault();
    const v = $('invitelogin').value.trim().replace(/^@/, '').toLowerCase();
    if (!GH_LOGIN.test(v)) { S.share = { ...S.share, msg: 'That is not a GitHub username: letters, digits and dashes, up to 39.' }; render(true); return; }
    shareChange({ add: v });
  });
}
/** The animated spot guide (the Atlas's): cycles through the spots, or holds the one picked. */
const ACTIONS = {
  botsAll: () => { S.botAll = !S.botAll; render(true); },
  botFam: b => { const f = b.dataset.f; S.botFam.has(f) ? S.botFam.delete(f) : S.botFam.add(f); render(true); },
  botStyle: b => { const k = b.dataset.s; S.botStyle.has(k) ? S.botStyle.delete(k) : S.botStyle.add(k); render(true); },
  botSort: b => { const k = b.dataset.k; S.botSort = S.botSort[0] === k ? [k, -S.botSort[1]] : [k, k === 'id' ? 1 : -1]; if (route().qs.get('spot')) location.hash = href('bots'); else { render(true); document.querySelector(`.sortbtn[data-k="${k}"]`)?.focus(); } },
  botQ: i => { S.botQ = i.value; clearTimeout(ACTIONS._t); ACTIONS._t = setTimeout(() => { render(true); const el = document.querySelector('[data-input="botQ"]'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 200); },
  gamesF: i => { S.gamesF[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value; S.gamesPage = 0; render(true); },
  gamesPage: b => { S.gamesPage = Math.max(0, S.gamesPage + +b.dataset.d); render(true); },
  cmp: i => { S.cmp = i.value || null; render(true); },
  fo: i => { const q = route().qs; q.set(i.dataset.k, i.value); location.hash = `${href('bots', 'faceoff')}?${q}`; },
  foSwap: () => { const q = route().qs, a = q.get('a') || pref.get('foA', ''), b = q.get('b') || pref.get('foB', ''); location.hash = `${href('bots', 'faceoff')}?a=${encodeURIComponent(b)}&b=${encodeURIComponent(a)}`; },
  seek: b => { const v = VIEWERS.get(b.dataset.key); v?.v?.seek(+b.dataset.i); v?.host.scrollIntoView({ behavior: 'smooth', block: 'center' }); },
  toggle: b => { const t = $(b.dataset.t); if (t) { t.hidden = !t.hidden; b.textContent = t.hidden ? b.dataset.show : b.dataset.hide; } },
  golive: () => startLive(true),
  peopleF: b => { S.peopleF = b.dataset.f; S.peoplePage = 0; render(true); },
  peoplePage: b => { S.peoplePage = Math.max(0, S.peoplePage + +b.dataset.d); render(true); },
  shareCopy: async b => { const el = $('sharelink'); try { await navigator.clipboard.writeText(el.value); b.textContent = 'Copied'; } catch { el.select(); b.textContent = 'Selected: copy it'; } },
  shareSend: async () => { try { await navigator.share({ title: 'SWU Arena', text: 'Star Wars Unlimited bots: games, replays and research', url: $('sharelink').value }); } catch {} },
  inviteRemove: b => { if (confirm(`Remove @${b.dataset.login}? They lose access at once.`)) shareChange({ remove: b.dataset.login }); },
  linkCopy: async b => { try { await navigator.clipboard.writeText(b.dataset.url); b.textContent = 'Copied'; } catch { prompt('Copy this link', b.dataset.url); } },
  linkSend: async b => { try { await navigator.share({ title: 'SWU Arena', text: 'Star Wars Unlimited bots: games, replays and research', url: b.dataset.url }); } catch {} },
  mcpCopy: async b => { const el = $('mcpurl'); try { await navigator.clipboard.writeText(el.value); b.textContent = 'Copied'; } catch { el.select(); b.textContent = 'Selected: copy it'; } },
  appDisconnect: b => { if (confirm(`Disconnect ${b.dataset.app}? It has to sign in again to read anything.`)) appDisconnect(b.dataset.id); },
  linkRemove: b => { if (confirm(`Remove the view link "${b.dataset.label}"? Anyone using it is locked out at once.`)) shareChange({ removeLink: b.dataset.id }); },
};

// ---------- viewers (the shared viewer kit), kept alive across re-renders ----------
const VIEWERS = new Map(), REPLAYS = new Map(), ART = { ...(DATA.art || {}) }, artWant = new Set(), artTried = new Set();
function detachViewers() { const keep = new Map(); for (const [k, v] of VIEWERS) if (v.host.isConnected) { v.host.remove(); keep.set(k, v); } return keep; }
function attachViewers(keep) {
  const seen = new Set();
  for (const ph of document.querySelectorAll('[data-game]')) {
    const key = `${ph.dataset.game}|${ph.dataset.layout || 'full'}`; seen.add(key);
    const old = keep.get(key);
    if (old) { ph.replaceWith(old.host); fillSpotBar(old); continue; } // at once: an empty strip for one frame moves the page
    ph.dataset.key = key; ph.innerHTML = '<p class="muted" style="padding:16px">Loading replay…</p>';
    const v = { host: ph, v: null, key, game: ph.dataset.game, offset: 0, live: ph.dataset.live === '1' };
    VIEWERS.set(key, v); mountViewer(v, ph);
  }
  for (const [k, v] of VIEWERS) if (!seen.has(k)) { try { v.v?.destroy(); } catch {} VIEWERS.delete(k); }
}
async function replayText(key) {
  if (DATA.bundle[key]) return DATA.bundle[key];
  if (REPLAYS.has(key)) return REPLAYS.get(key);
  if (!S.reader) return null;
  const [run, id] = key.split('/'), r = runById(run);
  if (!r?.dir) return null;
  const t = await S.reader.text(`${r.dir}/games/${id}.jsonl`);
  if (t) { REPLAYS.set(key, t); if (REPLAYS.size > 6) REPLAYS.delete(REPLAYS.keys().next().value); }
  return t;
}
/** For a game against a person: a function that rewrites one replay line so the person's seat reads "a person" in the
 *  header's player list and in each board's player name (the viewer kit shows both); null for any other game. People
 *  are never named in the app, whatever a feed wrote. */
function personMask(key) {
  const i = gameIdx.get(key), x = i == null ? null : gameRow(M.games[i]);
  if (x?.run?.kind !== 'people') return null;
  const seats = new Map(); // seat -> the name the header gave the person
  return line => {
    if (!line.includes('"header"') && ![...seats.values()].some(n => line.includes(JSON.stringify(n)))) return line;
    try {
      const e = JSON.parse(line);
      if (e?.t === 'header' && Array.isArray(e.players)) e.players = e.players.map(p => p && (p.id === x.human || isPerson(x.run, p.bot)) ? (seats.set(p.id, String(p.bot)), { ...p, bot: 'a person' }) : p);
      for (const [seat, name] of seats) if (e?.state?.players?.[seat]?.name === name) e.state.players[seat].name = 'a person';
      return JSON.stringify(e);
    } catch { return line; }
  };
}
async function sideFile(kind, id) {
  if (kind === 'evals' && DATA.evals[id]) return DATA.evals[id];
  if (kind === 'lens' && DATA.lens[id]) return DATA.lens[id];
  if (!S.reader) return null;
  try { const t = await S.reader.text(`dashboard/${kind}/${id}.json`); return t ? JSON.parse(t) : null; } catch { return null; }
}
async function mountViewer(v, host) {
  const [run, id] = v.game.split('/');
  if (!KIT) { host.innerHTML = '<div class="notice">The viewer kit did not load.</div>'; return; }
  let text = null, failed = null;
  try { text = await replayText(v.game); } catch (e) { failed = e?.message || e?.code || 'error'; }
  if (!text) {
    const i = gameIdx.get(v.game), playing = i != null && M.games[i][4] === 3;
    host.innerHTML = `<div class="notice">${failed ? `<b>The replay did not load</b> (${esc(failed)}). Reload the page to try again.`
      : S.live ? (playing ? '<b>No board for this game.</b> It is playing, but its run does not record replays, so only its result will show here.' : '<b>No replay for this game.</b> Its run did not record one, so only the result shows.')
      : `<b>Replay not in this snapshot.</b> ${CAN_LIVE ? 'Open the app with live data (allow project files) and every recorded game loads on demand.' : 'This build carries a few replays; the rest are not included.'}`} ${failed || S.live || !CAN_LIVE ? '' : '<button type="button" class="searchbtn" data-act="golive" style="margin-left:6px">Go live</button>'}</div>`;
    host.querySelector('[data-act]')?.addEventListener('click', () => startLive(true)); return;
  }
  if (!host.isConnected && !VIEWERS.has(v.key)) return;
  const [evals, lens] = await Promise.all([sideFile('evals', id), sideFile('lens', id)]);
  host.innerHTML = '';
  const step = +(route().qs.get('step') || 0) || undefined;
  try {
    v.mask = personMask(v.game);
    v.v = KIT.mount(host, { jsonl: v.mask ? text.split('\n').map(v.mask).join('\n') : text, evals: evals || undefined, lens: lens || undefined, layout: host.dataset.layout || 'full', ...(step ? { stepN: step } : {}), persist: 'swuapp.viewer', follow: true,
      onStep: (i, n) => { v.step = n; v.idx = i; if (!v.raf) v.raf = requestAnimationFrame(() => { v.raf = 0; fillSpotBar(v); }); } });
    v.offset = new TextEncoder().encode(text).length;
    v.ended = /"t":"end"/.test(text.slice(-4000));
    // a small viewer of a finished game opens on its last move, so the board and its spots show how it ended
    if (!step && host.dataset.layout === 'compact' && !v.live) { try { v.v.seek(Math.max(0, v.v.getGame().steps.length - 1)); } catch {} }
    if (host.dataset.pivotal) renderPivotal(v);
    fillSpotBar(v);
  } catch (e) { host.innerHTML = `<div class="notice"><b>The viewer could not open this game.</b> ${esc(e.message)}</div>`; }
}
function renderPivotal(v) {
  const el = $('pivotal'); if (!el || !KIT?.pivotal) return;
  try {
    const g = v.v.getGame(), [, id] = v.game.split('/'), top = KIT.pivotal(g, DATA.evals[id] || undefined, 8);
    el.innerHTML = top.length ? top.map(a => `<button type="button" class="tcard" data-act="seek" data-key="${esc(v.key)}" data-i="${a.index}" style="text-align:left"><span class="mono faint" style="font-size:var(--fs-xs)">step ${a.index} · ${a.swing != null ? `${a.swing > 0 ? '+' : ''}${Math.round(a.swing)} pts` : ''}</span><span>${esc(KIT.describe(a, a.seat === 'p1' ? g.header?.p1 || 'p1' : g.header?.p2 || 'p2'))}</span></button>`).join('') : '<p class="muted">No big swings found.</p>';
    for (const b of el.querySelectorAll('[data-act]')) b.addEventListener('click', () => ACTIONS.seek(b));
  } catch (e) { el.innerHTML = `<p class="muted">Pivotal plays unavailable: ${esc(e.message)}</p>`; }
}
if (KIT) {
  const artKey = (code, back) => { const m = String(code || '').match(/([A-Z0-9]+)[_/\- ]?(\d+)/); return m ? `${m[1]}_${m[2].padStart(3, '0')}${back ? '-b' : ''}` : null; };
  try { KIT.setArtResolver?.((code, back) => { const k = artKey(code, back); if (!k) return null; if (ART[k]) return ART[k]; if (HOSTED) { const [set, rest] = k.split('_'); return `https://cdn.swu-db.com/images/cards/${set}/${rest}.png`; } if (!artTried.has(k)) artWant.add(k); return null; }); KIT.setCardArt?.(true); } catch {}
}
async function loadArt() {
  if (!S.files || !artWant.size) return;
  const keys = [...artWant].slice(0, 24); keys.forEach(k => { artWant.delete(k); artTried.add(k); });
  let got = 0;
  await Promise.all(keys.map(async k => { const [set, rest] = k.split('_'); try { const r = await S.files.read((S.prefix + `card-art/${set}/${rest}.webp`).replace(/\/+/g, '/')); ART[k] = URL.createObjectURL(new Blob([r.bytes], { type: 'image/webp' })); got++; } catch {} }));
  if (got) try { KIT.setCardArt?.(false); KIT.setCardArt?.(true); } catch {}
}
setInterval(loadArt, 2500);
async function tailViewers() {
  if (!S.files) return;
  for (const v of VIEWERS.values()) {
    if (!v.v || v.ended || !v.live) continue;
    const [run, id] = v.game.split('/'), r = runById(run); if (!r?.dir) continue;
    try {
      const res = await S.files.read((S.prefix + `${r.dir}/games/${id}.jsonl`).replace(/\/+/g, '/'), { offset: v.offset });
      if (!res.bytes.length) continue;
      v.offset += res.bytes.length;
      const txt = (v.partial || '') + new TextDecoder().decode(res.bytes), parts = txt.split('\n'); v.partial = parts.pop();
      const lines = parts.filter(Boolean).map(l => v.mask ? v.mask(l) : l); if (lines.length) { v.v.append(lines); if (lines.some(l => l.includes('"t":"end"'))) v.ended = true; }
    } catch {}
  }
}
setInterval(tailViewers, 1800);

// ---------- the live grid: one small board per game, in the Atlas's picture language ----------
// A board is drawn from a slim replay state (SWUApp.slimState): bases with their HP left, units with their power
// (space units outlined), hand size, round and initiative. Under it, the Atlas spots each side is in.
// Snapshot: boards replay the frames the build cut from each game. Live: running games read the end of their
// replay file every few seconds; finished games read it once.
const TILES = new Map(); // key -> { frames, i, hold, live, ended, off, partial, fetched, busy, at }
function boardSvg(f, x) {
  if (!f) return `<svg class="gt-board" viewBox="0 0 300 150" aria-hidden="true"><text x="150" y="80" text-anchor="middle" class="bd-lab">waiting for the first round</text></svg>`;
  const side = (s, pid, top) => {
    const col = pid === 'p1' ? 'var(--fa)' : 'var(--fb)', y0 = top ? 8 : 86, hp = s.b[0] || 1, left = Math.max(0, hp - s.b[1]), fr = Math.min(1, left / hp), bh = 56;
    let g = `<rect x="8" y="${y0}" width="34" height="${bh}" rx="4" fill="var(--panel)" stroke="var(--line-2)" stroke-width="1.5"/><rect x="10" y="${y0 + 2 + (bh - 4) * (1 - fr)}" width="30" height="${(bh - 4) * fr}" rx="3" fill="${col}"/><text x="25" y="${y0 + bh / 2 + 5}" text-anchor="middle" class="bd-num" style="fill:${fr > .55 ? 'var(--panel)' : 'var(--ink)'}">${left}</text>`;
    const units = [...s.s.map(u => [u, 1]), ...s.g.map(u => [u, 0])], max = units.length > 7 ? 6 : 7, uy = y0 + 17;
    units.slice(0, max).forEach(([u, space], k) => {
      const ux = 52 + k * 26, hurt = u[2] > 0;
      g += space ? `<rect x="${ux}" y="${uy}" width="22" height="22" rx="11" fill="var(--panel)" stroke="${col}" stroke-width="2"/>` : `<rect x="${ux}" y="${uy}" width="22" height="22" rx="3" fill="${col}"/>`;
      g += `<text x="${ux + 11}" y="${uy + 15.5}" text-anchor="middle" class="bd-num" style="font-size:11px;fill:${space ? col : 'var(--panel)'}">${u[0]}</text>`;
      if (hurt) g += `<circle cx="${ux + 20}" cy="${uy + 2}" r="3.2" fill="var(--neg-4)"><title>damaged</title></circle>`;
    });
    if (units.length > max) g += `<text x="${52 + max * 26 + 2}" y="${uy + 15}" class="bd-lab">+${units.length - max}</text>`;
    const hx = 246, hy = y0 + 14;
    for (let k = 0; k < Math.min(3, s.h); k++) g += `<rect x="${hx + k * 5}" y="${hy + k * 1.5}" width="14" height="20" rx="2" fill="var(--panel)" stroke="${col}" stroke-width="1.4"/>`;
    g += `<text x="${hx + 30}" y="${hy + 15}" class="bd-num" style="font-size:12px;fill:${col}">${s.h}</text><text x="${hx}" y="${hy + 36}" class="bd-lab">${s.r[1]} res</text>`;
    if (f.i === pid) g += `<path d="M2 ${y0 + 22} l5 6 l-5 6z" fill="${col}"><title>has the initiative</title></path>`;
    return g;
  };
  const lead = (f.p1.b[0] - f.p1.b[1]) - (f.p2.b[0] - f.p2.b[1]);
  const mid = `<line x1="8" y1="75" x2="292" y2="75" stroke="var(--line-2)" stroke-dasharray="3 4"/><rect x="128" y="65" width="44" height="20" rx="10" fill="var(--panel)" stroke="var(--line-2)"/><text x="150" y="79.5" text-anchor="middle" class="bd-round">R${f.r}</text>${lead ? `<text x="${lead > 0 ? 52 : 52}" y="${lead > 0 ? 80 : 80}" class="bd-lab" style="fill:${lead > 0 ? 'var(--fa)' : 'var(--fb)'}">${lead > 0 ? 'p1' : 'p2'} +${Math.abs(lead)} HP</text>` : ''}`;
  return `<svg class="gt-board" viewBox="0 0 300 150" role="img" aria-label="${esc(`${x.p2} base ${f.p2.b[0] - f.p2.b[1]}, ${f.p2.g.length + f.p2.s.length} units, ${f.p2.h} cards; ${x.p1} base ${f.p1.b[0] - f.p1.b[1]}, ${f.p1.g.length + f.p1.s.length} units, ${f.p1.h} cards; round ${f.r}`)}">${side(f.p2, 'p2', true)}${mid}${side(f.p1, 'p1', false)}</svg>`;
}
function tileSpots(f, x) {
  if (!f || f.r < 1) return '<span class="faint">no spot yet</span>';
  const st = SWUApp.fullState(f);
  const one = (pid, name) => { const sp = AT.spotsAt(st, pid), a = atl(name); return `<span class="gt-side" style="--c:${pid === 'p1' ? 'var(--fa)' : 'var(--fb)'}"><i></i>${sp.length ? sp.slice(0, 3).map(sid => { const c = a?.situations?.[sid]; return `<span class="gt-spot" title="${esc(`${name}: ${sit(sid).label} (${sit(sid).short})${c?.n ? `; this bot ${edgeTxt(c.edge)} pts vs an average bot there` : ''}`)}">${spotIcon(sid, 'pict s')}<span>${esc(sit(sid).label)}</span>${c?.n ? `<em class="${c.edge >= 0 ? 'good' : 'bad'}">${edgeTxt(c.edge)}</em>` : ''}</span>`; }).join('') : '<span class="faint" style="font-size:var(--fs-xs)">even</span>'}</span>`; };
  return one('p1', x.human === 'p1' ? 'the person' : x.p1) + one('p2', x.human === 'p2' ? 'the person' : x.p2);
}
function tileState(key) {
  const t = TILES.get(key); if (!t?.frames?.length) return { f: null, t };
  return { f: t.frames[Math.min(t.i, t.frames.length - 1)], t };
}
function tileStatus(x, t) {
  const seat = x.res === 0 ? 'p1' : x.res === 1 ? 'p2' : null, who = seat && (x.human === seat ? 'the person' : x[seat]), atEnd = !t?.replaying || t.i >= t.frames.length - 1;
  const res = x.res < 3 && atEnd ? `<span class="gt-res">${who ? `${esc(who)} won` : x.res === 2 ? 'draw' : 'not rated'}</span>` : '';
  if (t?.live && !t.ended) return '<span class="pill live">Live</span>';
  if (t?.replaying) return `${res}<span class="pill done" title="the snapshot's frames of this game, played back">${x.res === 3 ? 'Snapshot' : atEnd ? 'Final' : 'Replay'}</span>`;
  return `${res}<span class="pill done">Final</span>`;
}
// a tile's names and its tag: the run's id, or for a game against a person, a "vs a person" pill
const tileSeat = (x, s) => x.human === s ? personChip() : `<span class="bot" style="--c:${botColor(x[s])}"><i></i><span>${esc(x[s])}</span></span>`;
const tileNames = x => `<span class="gt-names">${tileSeat(x, 'p1')}<span class="vs">vs</span>${tileSeat(x, 'p2')}</span>`;
const tileTag = x => x.human ? humanPill() : `<span class="gt-run mono">${esc(x.run.id)}</span>`;
function tileHtml(i, { sm = false } = {}) {
  const x = gameRow(M.games[i]), key = `${x.run.id}/${x.id}`;
  if (!TILES.has(key)) {
    const tr = DATA.traces?.[key];
    TILES.set(key, tr && !S.live ? { frames: tr.f, i: 0, hold: 0, replaying: true, end: tr.end } : { frames: tr ? [tr.f.at(-1)] : [], i: 0, live: S.live && x.res === 3, ended: x.res !== 3 });
  }
  const { f, t } = tileState(key);
  if (!hasBoard(i)) return `<a class="gtile ${sm ? 'sm' : ''} noboard" href="${href('games', x.run.id, x.id)}"><span class="gt-head"><span>${x.res === 3 ? '<span class="pill live">Live</span>' : '<span class="pill done">Final</span>'}</span>${tileTag(x)}</span>${tileNames(x)}<span class="gt-nob">No board: this run does not keep replay files, so only its result will show.</span></a>`;
  return `<a class="gtile ${sm ? 'sm' : ''}" href="${href('games', x.run.id, x.id)}" data-tile="${esc(key)}">
    <span class="gt-head">${tileTag(x)}<span class="gt-st" data-ts>${tileStatus(x, t)}</span></span>
    ${tileNames(x)}
    <span class="gt-b" data-tb>${boardSvg(f, x)}</span>
    ${sm ? '' : `<span class="gt-spots" data-tsp>${tileSpots(f, x)}</span>`}</a>`;
}
function paintTile(el) {
  const key = el.dataset.tile, i = gameIdx.get(key); if (i == null) return;
  const x = gameRow(M.games[i]), { f, t } = tileState(key);
  const sig = `${t?.i}|${t?.frames?.length}|${t?.live}|${t?.ended}`; if (el.dataset.sig === sig) return; el.dataset.sig = sig;
  el.querySelector('[data-tb]').innerHTML = boardSvg(f, x);
  const sp = el.querySelector('[data-tsp]'); if (sp) sp.innerHTML = tileSpots(f, x);
  el.querySelector('[data-ts]').innerHTML = tileStatus(x, t);
}
/** Reads the end of a game's replay file for its newest board; keeps the offset so later reads get only new lines. */
async function tailTile(key, t) {
  const [run, id] = key.split('/'), r = runById(run); if (!r?.dir || !S.files) return;
  const p = (S.prefix + `${r.dir}/games/${id}.jsonl`).replace(/\/+/g, '/');
  if (t.off == null) { const head = await S.files.read(p, { offset: 0, length: 1 }); t.off = Math.max(0, head.size - 65536); t.partial = ''; t.skipFirst = t.off > 0; }
  const res = await S.files.read(p, { offset: t.off }); t.off += res.bytes.length;
  const txt = t.partial + new TextDecoder().decode(res.bytes), lines = txt.split('\n'); t.partial = lines.pop();
  if (t.skipFirst && lines.length) { lines.shift(); t.skipFirst = false; }
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k];
    if (l.startsWith('{"t":"end"')) t.ended = true;
    if (l.startsWith('{"t":"step"')) { try { const s = SWUApp.slimState(JSON.parse(l).state); if (s && s.r >= 1) { t.frames = [s]; t.i = 0; } } catch {} break; }
  }
  t.at = Date.now();
}
let gridBusy = false;
async function gridTick() {
  const els = [...document.querySelectorAll('[data-tile]')];
  if (!els.length) return;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const el of els) {
    const t = TILES.get(el.dataset.tile); if (!t) continue;
    if (t.replaying && t.frames.length > 1) {
      if (still) t.i = t.frames.length - 1;
      else if (t.i >= t.frames.length - 1) { if (++t.hold > 6) { t.i = 0; t.hold = 0; } }
      else t.i++;
    }
    paintTile(el);
  }
  if (!S.live || !S.files || gridBusy) return;
  gridBusy = true;
  try {
    for (const el of els) {
      const key = el.dataset.tile, t = TILES.get(key); if (!t || t.replaying) continue;
      const due = t.live && !t.ended ? Date.now() - (t.at || 0) > 5000 : !t.fetched;
      if (!due) continue;
      t.fetched = true;
      try { await tailTile(key, t); } catch (e) { if (e?.code === 'rate_limited') break; }
      paintTile(el);
    }
  } finally { gridBusy = false; }
}
setInterval(gridTick, 650);
/** Games for the grid: every running game (boards first), then finished games with a board, at most 3 per run; bot
 *  games only, or (people: true) only games against people. */
// live from project files: which games have a replay file, listed once per run per sync (some runs keep none). A sync
// keeps the last list until the new one arrives, and redraws only if it changed: dropping the lists made every board
// vanish until they came back, and the page jumped under the reader.
const GFILES = new Map(); let gfGen = 0;
function gameFilesOf(r) {
  const e = GFILES.get(r.id);
  if (e && (e.gen === gfGen || e.busy)) return e.set;
  const gen = gfGen; // the sync this list is for: a sync while it loads asks again
  GFILES.set(r.id, { set: e?.set ?? null, gen: e?.gen ?? -1, busy: true });
  // landed or failed, a sync that came while this loaded lists again for itself (a no-op if the redraw already did)
  const done = (set, changed) => { GFILES.set(r.id, { set, gen, busy: false }); if (changed) render(true); if (gen !== gfGen) gameFilesOf(r); };
  S.reader?.list(`${r.dir}/games`).then(es => {
    const set = new Set(es.map(x => x.name.replace(/\.jsonl$/, ''))), old = e?.set;
    done(set, !old || old.size !== set.size || [...set].some(id => !old.has(id)));
  }, () => done(e?.set ?? null, false));
  return e?.set ?? null;
}
const hasBoard = i => {
  const r = M.runs[M.games[i][0]], id = M.games[i][1];
  if (!S.live) return !!DATA.traces?.[`${r.id}/${id}`];
  if (S.api) return hasReplay(i); // the window's model already marks every game with a replay file
  if (!r?.dir || !S.reader) return false;
  const set = gameFilesOf(r); return set ? set.has(id) : false;
};
function gridGames({ run = null, max = 24, finished = 8, people = false } = {}) {
  const newest = [...M.games.keys()].reverse().filter(i => run ? M.runs[M.games[i][0]] === run : isPeople(i) === people);
  const playing = newest.filter(i => M.games[i][4] === 3).sort((a, b) => hasBoard(b) - hasBoard(a)).slice(0, max);
  const per = {}, done = newest.filter(i => M.games[i][4] < 3 && hasBoard(i) && (per[M.games[i][0]] = (per[M.games[i][0]] || 0) + 1) <= (run ? 99 : 3)).slice(0, finished);
  return { playing, done };
}
// ---------- live data ----------
// On the arena window (bot/arena/window.js) the page is a shell and everything comes from the window's API: the model
// from /api/app, replays from /api/replays. In the project, live data comes from the shared folder (files capability).
const enc = encodeURIComponent;
const REPLAY_PATH = /^(?:results|games)\/([^/]+)\/games\/([^/]+)\.jsonl$/;
function apiFiles() {
  return {
    async read(p, { offset = 0, length } = {}) {
      const m = REPLAY_PATH.exec(p); if (!m) throw { code: 'not_found' };
      const r = await fetch(`/api/replays/${enc(m[1])}/${enc(m[2])}?from=${offset}${length ? `&length=${length}` : ''}`, { credentials: 'same-origin' });
      if (!r.ok) throw { code: r.status === 404 ? 'not_found' : r.status === 429 ? 'rate_limited' : 'error' };
      return { bytes: new Uint8Array(await r.arrayBuffer()), size: Number(r.headers.get('x-size')) || 0 };
    },
  };
}
function apiReader() {
  const json = async u => { const r = await fetch(u, { credentials: 'same-origin' }); return r.ok ? (await r.json()).result : null; };
  return {
    async list(d) { const m = /^(?:results|games)\/([^/]+)\/games$/.exec(d); return m ? ((await json(`/api/replays/${enc(m[1])}`)) || []).map(id => ({ name: `${id}.jsonl`, path: `${d}/${id}.jsonl`, isDirectory: false })) : []; },
    async text(p) {
      const m = REPLAY_PATH.exec(p);
      // no replay is null; any other failure throws, so a game is never called unrecorded because one request failed
      if (m) { const r = await fetch(`/api/replays/${enc(m[1])}/${enc(m[2])}`, { credentials: 'same-origin' }); if (r.ok) return r.text(); if (r.status === 404) return null; throw new Error(`HTTP ${r.status}`); }
      const d = /^dashboard\/(evals|lens)\/([^/]+)\.json$/.exec(p);
      if (d) { const j = await json(`/api/docs/${d[1]}/${enc(d[2])}`); return j ? JSON.stringify(j) : null; }
      return null;
    },
  };
}
async function syncApi() {
  const r = await fetch('/api/app', { credentials: 'same-origin' });
  if (r.status === 401) { location.href = `/auth/github?next=${enc(location.pathname + location.hash)}`; return false; }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = (await r.json()).result;
  if (S.api && d.version === S.apiVersion) return true;
  if (!S.live) TILES.clear();
  M = d.model; DATA.t0panels = d.t0panels || []; S.api = true; S.apiVersion = d.version; S.live = true; S.syncedAt = new Date().toISOString();
  indexGames(); buildColors(); buildSearch(); setChip();
  if (!document.querySelector('dialog[open]') && !document.activeElement?.matches('input,select')) render(true);
  return true;
}
async function startApi() {
  S.files = apiFiles(); S.reader = apiReader(); S.api = true;
  fetch('/api/me', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).then(j => { if (j?.result) { S.me = j.result; const p = route().parts; if (p[0] === 'share' || (p[0] === 'arena' && p[1] === 'join')) render(true); } }).catch(() => {});
  $('livetext').textContent = 'Connecting to the arena…';
  try { await syncApi(); } catch (e) { S.api = false; S.files = null; S.reader = null; $('livetext').textContent = `Offline (${e?.message || 'error'}) · showing snapshot`; }
}
function liveGame({ people = false } = {}) {
  // the arena's running game first, then any running game, then the newest finished game with a replay; bot games
  // only, or (people: true) only games against people
  const order = [...M.runs].reverse().filter(r => (r.kind === 'people') === people);
  for (const want of ['arena', null]) for (const r of order) { if (want && r.kind !== want) continue; const ri = M.runs.indexOf(r); for (let i = M.games.length - 1; i >= 0; i--) { const g = M.games[i]; if (g[0] === ri && g[4] === 3 && hasReplay(i)) return { i, running: true }; } }
  const pick = DATA.picks.hero && gameIdx.get(DATA.picks.hero);
  if (!S.live && pick != null && isPeople(pick) === people) return { i: pick, running: M.games[pick][4] === 3 };
  for (let i = M.games.length - 1; i >= 0; i--) if (M.games[i][4] < 3 && hasReplay(i) && isPeople(i) === people) return { i, running: false };
  return null;
}
function setChip() {
  const run = M.runs.filter(r => r.kind !== 'people').at(-1), chip = $('livechip');
  const playing = M.games.filter(g => g[4] === 3 && M.runs[g[0]].kind !== 'people').length, ppl = M.games.filter(g => g[4] === 3 && M.runs[g[0]].kind === 'people').length;
  chip.classList.toggle('on', S.live && playing + ppl > 0);
  const ar = M.arena;
  let t;
  if (ar.phase === 'work') t = `Arena round ${ar.current?.n} · work phase · ${Math.max(0, Math.round((Date.parse(ar.deadline) - NOW()) / 60000))} min left`;
  else if (ar.phase === 'ladder') t = `Arena round ${ar.current?.n} · ladder playing`;
  else if (playing) t = `${run?.id} · ${run?.decided}/${run?.planned || run?.n} games · ${playing} playing`;
  else t = run ? `No live bot games · last run ${run.id} ${ago(run.createdAt)} ago` : 'No bot games yet';
  if (ppl) t += ` · ${ppl} vs ${ppl === 1 ? 'a person' : 'people'} now`;
  chip.title = t;
  $('livetext').innerHTML = S.live ? `${esc(t)}` : `${CAN_LIVE ? '<button type="button" id="golive">Go live</button> · ' : ''}Snapshot ${clock(M.builtAt)} · ${esc(t)}`;
  $('golive')?.addEventListener('click', () => startLive(true));
}
async function findPrefix() {
  const r = await S.files.list({});
  const hit = r.entries.find(e => /(^|\/)dashboard\/?$/.test(e.path)) || r.entries.find(e => /(^|\/)results\/?$/.test(e.path));
  if (hit) return hit.path.replace(/(dashboard|results)\/?$/, '');
  for (const e of r.entries.filter(e => e.isDirectory)) { const sub = await S.files.list({ path: e.path }); const h = sub.entries.find(x => /(^|\/)dashboard\/?$/.test(x.path)); if (h) return h.path.replace(/dashboard\/?$/, ''); }
  return '';
}
function filesReader() {
  const norm = p => (S.prefix + p).replace(/\/+/g, '/');
  return {
    async list(d) { const out = []; let cursor; try { do { const r = await S.files.list({ path: norm(d), cursor }); for (const e of r.entries) out.push({ name: e.path.split('/').filter(Boolean).pop(), path: e.path, isDirectory: e.isDirectory }); cursor = r.cursor; } while (cursor); } catch (e) { if (e?.code !== 'not_found') throw e; } return out; },
    async text(p) { try { const r = await S.files.read(norm(p)); return new TextDecoder().decode(r.bytes); } catch (e) { if (e?.code === 'not_found') return null; throw e; } },
  };
}
let syncing = false;
async function sync() {
  if (syncing || !S.reader) return; syncing = true;
  if (S.api) { try { await syncApi(); } catch (e) { $('livetext').textContent = `Offline (${e?.message || 'error'}) · showing the last data`; } finally { syncing = false; } return; }
  try {
    const src = await SWU.loadSources(S.reader), extra = await SWUApp.loadExtra(S.reader);
    const next = SWUApp.buildModel(src, extra, SWU);
    next.replay = ''; if (!S.live) TILES.clear(); gfGen++; M = next; S.live = true; S.syncedAt = new Date().toISOString();
    indexGames(); buildColors(); buildSearch(); setChip();
    if (!document.querySelector('dialog[open]') && !document.activeElement?.matches('input,select')) render(true);
  } catch (e) { $('livetext').textContent = `Offline (${e?.code || e?.message || 'error'}) · showing snapshot`; }
  finally { syncing = false; }
}
async function startLive(fromClick) {
  if (!CAN_LIVE) return;
  try {
    if (!S.files) S.files = await window.claude?.use?.('files');
    if (!S.files) { if (fromClick) $('livetext').textContent = 'Live data is not available in this view · snapshot'; return; }
    S.prefix = await findPrefix(); S.reader = filesReader();
    $('livetext').textContent = 'Connecting to project files…';
    await sync();
  } catch (e) { $('livetext').innerHTML = `${e?.code === 'not_granted' ? 'Live data not allowed' : 'Offline'} · snapshot`; }
}
setInterval(sync, 15000);
setInterval(() => { if (S.live) setChip(); }, 30000);

// ---------- pages: home ----------
function heroBox() {
  // a bot game; a game against a person only when there is no bot game yet, and then labelled as one
  const lg = liveGame() || liveGame({ people: true });
  if (!lg) return `<div class="box"><p class="muted">No game to show yet.</p></div>`;
  const x = gameRow(M.games[lg.i]), key = `${x.run.id}/${x.id}`;
  const where = x.human ? `${humanPill()} on karabast.net · never rated` : `${x.run.kind === 'arena' ? 'arena' : 'ladder'} <a href="${href('runs', x.run.id)}">${esc(x.run.id)}</a>`;
  return `<section class="box hero" aria-label="Now playing"><div class="hero-head">${lg.running ? '<span class="pill live">Live</span>' : '<span class="pill done">Latest game</span>'}${seatLink(x, 'p1')}<span class="vs">vs</span>${seatLink(x, 'p2')}<span class="muted" style="font-size:var(--fs-md)">${where}${x.res < 3 ? ` · ${x.res === 2 ? 'a draw' : `won by ${esc(winnerName(x))}`} in round ${x.rounds}` : ''}</span><a class="more" href="${href('games', x.run.id, x.id)}" style="margin-left:auto">Open game</a></div><div class="kithost compact" data-game="${esc(key)}" data-layout="compact" data-live="${lg.running ? 1 : 0}"></div>${spotBarHtml(key)}</section>`;
}
/** The hosted arena plays a round whenever its lineup changes (bot/arena/games.js planRound), with no tournament or work
 *  windows: it is playing a round, or between rounds. */
function hostedState() {
  const A = M.arena, n = A.current?.n;
  return A.phase === 'ladder' ? { clock: `Round ${n}`, head: `Round ${n} is playing.`, what: 'Every entered bot plays every other, the baselines too. Games appear in the grid as they finish.' }
    : n != null ? { clock: 'Between rounds', head: `Round ${n} is done.`, what: 'The next round starts when a bot is submitted, changed or withdrawn, or a day after the last one.' }
    : { clock: 'No rounds yet', head: 'No round has played yet.', what: 'The first round starts once a bot is entered.' };
}
function arenaCard() {
  const A = M.arena, st = A.standings, last = st?.rounds?.at(-1), leader = last?.leader;
  const ph = A.hosted ? `<b>${esc(hostedState().head)}</b> ${esc(hostedState().what)}` : A.phase === 'idle' ? `<b>Tournament 1 has not started.</b> ${A.competitors.length} builders are registered${A.thinkCapMs ? `, ${A.thinkCapMs / 1000} s think cap per game` : ''}.` :
    A.phase === 'work' ? `<b>Round ${A.current.n}: work phase.</b> Builders are improving their bots until ${clock(A.deadline)}.` : A.phase === 'ladder' ? `<b>Round ${A.current.n}: ladder.</b> Every builder's newest bot plays every other.` : `<b>Tournament finished.</b>`;
  return `<section class="box"><div class="bh"><h3>${A.hosted ? 'Hosted arena' : 'Builder arena'}</h3><a class="more" href="${href('arena')}">Open arena</a></div><p style="font-size:var(--fs-base)">${ph}</p>${last ? `<p class="muted" style="font-size:var(--fs-md);margin-top:8px">${A.archived ? `<span class="archived">archived</span> ${esc(A.archived)}: ` : ''}round ${last.round} leader ${botLink(leader)} · ${last.games} games</p>` : ''}</section>`;
}
function topBots(n = 8) {
  return `<section class="box"><div class="bh"><h3>Top bots</h3><span class="sub">rating, then its nine spots</span><a class="more" href="${href('bots')}">All ${M.order.length}</a></div><div class="toplist">${M.order.slice(0, n).map((id, i) => { const b = M.bots[id]; return `<a class="r" href="${href('bots', id)}"><span class="rank">${i + 1}</span><span class="bot" style="--c:${botColor(id)}"><i></i><span>${esc(id)}</span></span><span class="num">${b.rating}</span>${fingerprint(id)}</a>`; }).join('')}</div><div style="margin-top:8px">${fpKey()}</div></section>`;
}
function learnedBox(compact) {
  const F = M.research.findings;
  return `<section class="box"><div class="bh"><h3>What we learned</h3><a class="more" href="${href('research')}">Research</a></div><p style="font-size:var(--fs-base);color:var(--ink-2)">${esc(bottomLine(F))}</p><div style="margin-top:6px">${F.map(f => `<div class="finding"><div class="row">${verdictPill(f)}<a class="claim" href="${href('research')}">${esc(f.claim)}</a></div>${compact ? '' : `<p class="data">${esc(f.data)}</p>`}</div>`).join('')}</div></section>`;
}
function feedBox(n = 12) {
  const items = M.feed.filter(e => S.aud === 'project' || e.kind !== 'card').slice(0, n);
  const link = e => e.kind === 'run' ? href('runs', e.run) : e.kind === 'experiment' ? href('research', 'experiments', e.id) : e.kind === 'thought' ? href('research', 'lines', e.panel) : e.kind === 'card' ? href('bots', e.bot) : '#/';
  return `<section class="box"><div class="bh"><h3>What's new</h3>${S.seen ? `<span class="sub">marked: since your last visit ${ago(S.seen)} ago</span>` : ''}</div><div class="feed">${items.map(e => `<div class="${S.seen && e.t > S.seen ? 'new' : ''}"><span class="when">${ago(e.t)}</span><span class="what"><span class="kind">${esc(e.kind === 'thought' ? 'thinking' : e.kind)}</span><a href="${link(e)}">${esc(e.kind === 'thought' ? e.title : '')}</a>${e.kind === 'thought' ? ': ' : ''}${esc(numFix(e.text).slice(0, 220))}</span></div>`).join('')}</div></section>`;
}
function glanceBox() {
  const xs = [...M.experiments].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).filter(e => (e.metrics || []).length).slice(0, 2);
  if (!xs.length) return '';
  return `<section class="box"><div class="bh"><h3>Latest results</h3><span class="sub">two bots = a small face-off; scores on the run tables' bar</span><a class="more" href="${href('research', 'experiments')}">All ${M.experiments.length} experiments</a></div><div class="grid">${xs.map(e => `<div class="c6 stack" style="gap:6px"><div class="row" style="justify-content:space-between"><a href="${href('research', 'experiments', e.id)}"><b>${esc(e.title)}</b></a><span class="pill ${esc(e.status)}">${esc(e.status)}</span></div>${evidence(e, { max: 4 })}${e.conclusion ? `<p style="font-size:var(--fs-md);color:var(--ink-2)">${esc(String(e.conclusion).slice(0, 200))}${String(e.conclusion).length > 200 ? '…' : ''}</p>` : ''}</div>`).join('')}</div></section>`;
}
function waitingBox() {
  if (S.aud === 'public') return '';
  const w = M.threads.filter(t => t.status === 'blocked' || t.status === 'review_ready');
  if (!w.length) return '';
  return `<section class="box" style="border-color:var(--warn)"><div class="bh"><h3>Waiting on you</h3><span class="sub">${w.length} threads</span><a class="more" href="${href('lab', 'waiting')}">Open</a></div><div class="stack" style="gap:4px">${w.slice(0, 5).map(t => `<div class="row" style="font-size:var(--fs-md)"><span class="pill ${esc(t.status)}">${esc(t.status.replace('_', ' '))}</span>${esc(t.title)}</div>`).join('')}</div></section>`;
}
function pageHome() {
  const k = M.totals;
  const kpis = `<div class="kpis"><div><div class="v">${int(k.rated)}</div><div class="k">games rated</div></div><div><div class="v">${k.runs}</div><div class="k">ladders and rounds</div></div><div><div class="v">${k.bots}</div><div class="k">rated bots</div></div><div><div class="v">${ATL()?.mapped.length ?? '-'}</div><div class="k">bots with a spot map</div></div><div><div class="v">${M.arena.competitors.length}</div><div class="k">arena competitors</div></div><div><div class="v">${M.research.findings.filter(f => f.v !== 'open').length}/${M.research.findings.length}</div><div class="k">findings with evidence</div></div></div>`;
  return `<div class="grid"><div class="c8">${heroBox()}</div><div class="c4 stack">${waitingBox()}${arenaCard()}${peopleCard()}${topBots(8)}${joinCard()}</div><div class="c12">${moreGamesBox()}</div><div class="c12">${betBox()}</div><div class="c7">${learnedBox(true)}</div><div class="c5">${feedBox(12)}</div><div class="c12">${glanceBox()}</div></div>${kpis}`;
}

// ---------- the builder arena: systems that build bots compete ----------
const HARNESS = { 'claude-code': 'Claude Code', script: 'Script', codex: 'Codex', human: 'Person' };
const capw = s => String(s || '').replace(/^./, c => c.toUpperCase());
// a roster entry with no harness (a bot entered as it is, with no builder in the arena) has harness null
const sysParts = (h) => !h ? { harness: 'none', model: '-', effort: '-', memory: '-' } : ({ harness: HARNESS[h.kind] || h.kind || '?', model: h.kind === 'script' ? 'no model' : capw(h.model) || '?', effort: h.kind === 'script' ? '-' : h.effort || 'default', memory: h.memory || 'none' });
function systemChips(h) { if (!h) return '<span class="harness">no builder</span>'; const p = sysParts(h); return [p.harness, h.kind === 'script' ? 'no LLM' : p.model, h.kind !== 'script' && h.effort ? `${h.effort} effort` : '', h.memory ? `memory: ${h.memory}` : ''].filter(Boolean).map(t => `<span class="harness">${esc(t)}</span>`).join(''); }
const builderOf = name => M.arena.competitors.find(c => c.name === name || c.versions.some(v => v.name === name)) || null;
/** How the builder arena works: the diagram and what the tournament compares. It goes at the bottom of a page, under the
 *  arena itself (Eric, 2026-10-13: how-it-works pages do not belong at the top). */
function builderIntro() {
  const cs = M.arena.competitors;
  const built = cs.filter(c => c.harness), bare = cs.filter(c => !c.harness);
  const vals = f => [...new Set(built.filter(c => c.harness.kind !== 'script').map(c => sysParts(c.harness)[f]))];
  const sig = c => JSON.stringify(c.harness), same = {}; for (const c of built) (same[sig(c)] ||= []).push(c.name);
  const reps = Object.values(same).filter(g => g.length > 1), scripts = built.filter(c => c.harness.kind === 'script');
  const tests = [vals('model').length > 1 && `<li><b>Model:</b> ${vals('model').map(esc).join(', ')}</li>`, vals('effort').length > 1 && `<li><b>Effort:</b> ${vals('effort').map(esc).join(', ')}</li>`, vals('memory').length > 1 && `<li><b>Memory:</b> ${vals('memory').map(esc).join(' vs ')}</li>`,
    ...reps.map(g => `<li><b>Same setup ×${g.length}:</b> ${g.map(esc).join(', ')} <span class="muted">(shows how much of a result is luck)</span></li>`), scripts.length && `<li><b>No LLM:</b> ${scripts.map(c => esc(c.name)).join(', ')} <span class="muted">(a script that tunes the same bot)</span></li>`,
    bare.length && `<li><b>No builder:</b> ${bare.map(c => esc(c.name)).join(', ')} <span class="muted">(bots entered as they are)</span></li>`].filter(Boolean);
  const T = M.arena.tournament, mins = T?.roundMinutes || 60;
  return `<section class="box builder-intro"><div class="bh"><h3>How the builder arena works</h3></div><p style="font-size:var(--fs-md);color:var(--ink-2);margin-bottom:8px">Each builder is a system that builds a bot: a model in its harness, with its effort and memory settings, or a script. Every round opens a ${mins}-minute work window where each builder improves its own bot; then every builder's newest bot plays every other, the baselines too. A builder's rating is its bot's.</p><div class="grid"><div class="c8"><div class="wide-only">${arenaDiagram()}</div><div class="phone-only">${arenaDiagram({ compact: true })}</div></div>${tests.length ? `<div class="c4 tests"><div class="eyebrow">What this tournament compares</div><ul class="plain">${tests.join('')}</ul><p class="muted" style="font-size:var(--fs-sm)">Every builder gets the same task${cs[0]?.philosophy ? `: "${esc(cs[0].philosophy.slice(0, 140))}${cs[0].philosophy.length > 140 ? '…' : ''}"` : ''}, and starts from ${[...new Set(cs.map(c => c.start).filter(Boolean))].map(b => botLink(b)).join(', ') || 'a baseline'}.</p></div>` : ''}</div></section>`;
}
function setupTable() {
  const cs = M.arena.competitors, st = M.arena.standings, F = ['harness', 'model', 'effort', 'memory'];
  const common = Object.fromEntries(F.map(f => { const n = {}; for (const c of cs) { const v = sysParts(c.harness)[f]; n[v] = (n[v] || 0) + 1; } return [f, Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0]]; }));
  return `<div class="scroll"><table class="setup"><thead><tr><th>Builder</th><th>Harness</th><th>Model</th><th>Effort</th><th>Memory</th><th class="n">Bots built</th><th>Newest bot</th><th class="n">Its rating</th></tr></thead><tbody>${cs.map(c => { const p = sysParts(c.harness); return `<tr class="click" data-href="${href('arena', 'builders', c.name)}"><td><a href="${href('arena', 'builders', c.name)}"><b>${esc(c.name)}</b></a><span class="sub2">${esc(c.title)}</span></td>${F.map(f => `<td class="${p[f] !== common[f] ? 'diff' : 'faint'}">${esc(p[f])}</td>`).join('')}<td class="n">${c.versions.length}</td><td>${c.latest ? botLink(c.latest) : '-'}</td><td class="n">${st?.global?.[c.latest] ?? '<span class="faint">unrated</span>'}</td></tr>`; }).join('')}</tbody></table></div><p class="muted" style="font-size:var(--fs-sm);margin-top:6px">Highlighted: where a builder's setup differs from most others.</p>`;
}

// ---------- pages: arena ----------
/** The run of arena round n: tournament rounds record into <tournament id>-r<K> (the round's ladderId in standings, its
 *  ladder in tournament.json); rounds that name no ladder into arena-r<K>. A named ladder not mirrored yet gives null,
 *  never an older arena-r<K> run from before the tournament. */
function roundRun(n) {
  const A = M.arena, id = A.standings?.rounds?.find(r => r.round === n)?.ladderId ?? A.tournament?.rounds?.find(r => r?.n === n)?.ladder;
  return runById(id || `arena-r${n}`);
}
function arenaRun() {
  const ids = M.arena.runs; const cur = M.arena.current?.n != null ? roundRun(M.arena.current.n) : null;
  return cur || (ids.length ? runById(ids.at(-1)) : null);
}
function phaseBanner() {
  const A = M.arena, T = A.tournament, plan = T?.plannedRounds || 3, mins = T?.roundMinutes || 60;
  if (A.hosted) {
    // the newest rounds: struck through once done, lit while one plays, plain if a stop cut one off
    const h = hostedState(), n = A.current?.n, rs = (A.standings?.rounds || []).slice(-8);
    const steps = rs.map(r => `<span class="${A.phase === 'ladder' && r.round === n ? 'on' : r.status && r.status !== 'done' ? '' : 'done'}">R${r.round}</span>`);
    if (A.phase === 'ladder' && !rs.some(r => r.round === n)) steps.push(`<span class="on">R${n}</span>`);
    return `<section class="phase"><div><div class="eyebrow">Hosted arena</div><div class="clock">${esc(h.clock)}</div></div><p style="font-size:var(--fs-base);color:var(--ink-2)">${esc(A.phase === 'ladder' ? h.what : `${h.head} ${h.what}`)}</p><div class="steps">${steps.join('')}</div></section>`;
  }
  const rounds = T?.rounds || [], ho = rounds.find(r => r?.kind === 'holdout');
  const steps = []; for (let n = 1; n <= plan; n++) { const r = rounds[n - 1]; const st = !r ? '' : r.ladderEnd ? 'done' : 'on'; steps.push(`<span class="${st}">R${n} work ${mins} min</span><span class="${!r ? '' : r.ladderEnd ? 'done' : r.ladderStart ? 'on' : ''}">R${n} ladder</span>`); }
  // a card-pool holdout tournament ends with one more ladder, on the held-out cards and with no work window
  if (ho || T?.rules?.holdout) steps.push(`<span class="${!ho ? '' : ho.ladderEnd ? 'done' : 'on'}">Held-out cards ladder</span>`);
  const clockTxt = A.phase === 'work' ? `${Math.max(0, Math.round((Date.parse(A.deadline) - NOW()) / 60000))} min` : A.phase === 'ladder' ? 'Ladder' : A.phase === 'done' ? 'Finished' : 'Not started';
  const what = A.phase === 'idle' ? `${A.competitors.length} builders registered, ${A.baselines.join(' and ')} as baselines. Waiting for the referee to start ${T?.title || 'tournament 1'}.` :
    A.phase === 'work' ? `Builders are improving their bots. Submissions close at ${clock(A.deadline)}.` : A.phase === 'ladder' ? 'The newest versions are playing each other now. Games appear in the grid as they finish.' : 'All rounds are rated.';
  return `<section class="phase"><div><div class="eyebrow">Builder arena · ${esc(T?.title || 'tournament 1')}</div><div class="clock">${clockTxt}</div></div><p style="font-size:var(--fs-base);color:var(--ink-2)">${esc(what)}</p><div class="steps">${steps.join('')}</div></section>`;
}
function roundStandings(st, roundIx, { fp = false } = {}) {
  const r = st?.rounds?.[roundIx]; if (!r) return '<p class="muted">No rated round yet.</p>';
  // the held-out round is left out of the all-round rating: rank it by its own rating, next to the rank on training cards
  const ho = r.pool === 'holdout', train = ho ? st.rounds.slice(0, roundIx).filter(x => x.pool !== 'holdout').at(-1) : null;
  const trainRank = Object.fromEntries((train?.bots || []).map(b => [b.name, b.rank]));
  const rating = b => (ho ? b.btElo : st.global?.[b.name]);
  const rows = [...r.bots].sort((a, b) => (rating(b) ?? 0) - (rating(a) ?? 0));
  const moved = (b, i) => { const t = trainRank[b.name]; if (t == null) return '<span class="faint">-</span>'; const d = t - (i + 1); return `#${t}${d ? ` <span class="mk ${d > 0 ? 'up' : 'down'}" title="${d > 0 ? 'better' : 'worse'} on held-out cards">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>` : ''}`; };
  return `<div class="scroll"><table><thead><tr><th>#</th><th>Builder <span class="faint" style="font-weight:400">· its bot</span></th><th class="hide-sm">Style</th>${fp ? '<th class="hide-sm">Nine spots</th>' : ''}${ho ? '<th class="n" title="rank in the last round on the training cards">Training</th>' : ''}<th class="n">${ho ? 'Held-out rating' : 'Rating'}</th><th class="n">W-L</th><th class="n hide-sm">ms/dec</th><th class="n" title="lost games by a late or broken reply">⏱</th></tr></thead><tbody>${rows.map((b, i) => `<tr><td class="rank">${i + 1}</td><td>${b.agent ? `<a href="${href('arena', 'builders', b.agent)}" class="bot" style="--c:${famColor(builderOf(b.agent)?.harness?.kind === 'script' ? 'search' : 'llm')}"><i></i><span><b>${esc(b.agent)}</b></span></a> <span class="mono faint" style="font-size:var(--fs-sm)">${esc(b.name)}</span>` : `${botLink(b.name)} <span class="tag-base">baseline</span>`}</td><td class="hide-sm">${styleTag(atl(b.name)?.summary?.style)}</td>${fp ? `<td class="hide-sm">${fingerprint(b.name)}</td>` : ''}${ho ? `<td class="n">${moved(b, i)}</td>` : ''}<td class="n">${rating(b) ?? '-'}</td><td class="n">${b.wins}-${b.losses}</td><td class="n hide-sm">${ms(b.thinkMs)}</td><td class="n ${b.forfeits ? 'mk clock' : 'faint'}">${b.forfeits || '-'}</td></tr>`).join('')}</tbody></table></div>`;
}
function thoughtsFeed(panels, n = 14) {
  const all = [];
  for (const p of panels) { for (const t of p.thoughts || []) all.push({ t: t.t, who: p.bots?.[0] || p.id, text: t.text, id: p.id }); if (p.now && !(p.thoughts || []).length) all.push({ t: p.updatedAt, who: p.bots?.[0] || p.id, text: `Now: ${p.now}`, id: p.id }); }
  all.sort((a, b) => String(b.t).localeCompare(String(a.t)));
  return all.length ? all.slice(0, n).map(x => `<div class="thought"><span><span class="bot" style="--c:${famColor('llm')}"><i></i><span>${esc(String(x.who).replace(/-v\d+$/, ''))}</span></span><br><span class="mono faint" style="font-size:var(--fs-xs)">${ago(x.t)} ago</span></span><span>${esc(numFix(x.text))}</span></div>`).join('') : '<p class="muted">No thoughts posted yet.</p>';
}
/** Arena standings: per round, the standings in Atlas terms next to the round's every-pair grid (who beat whom);
 *  once there are several rounds, one rating line per builder on top. */
function pageArenaLive() {
  const A = M.arena, run = arenaRun(), st = A.standings, live = A.phase === 'work' || A.phase === 'ladder';
  const ri = st?.rounds?.length ? st.rounds.length - 1 : -1;
  const ag = run ? (() => { const lg = [...M.games.keys()].reverse().find(i => M.runs[M.games[i][0]] === run && M.games[i][4] === 3); if (lg != null) return lg; const p = DATA.picks.arena && gameIdx.get(DATA.picks.arena); return p ?? [...M.games.keys()].reverse().find(i => M.runs[M.games[i][0]] === run && hasReplay(i)); })() : null;
  const x = ag != null ? gameRow(M.games[ag]) : null, key = x ? `${x.run.id}/${x.id}` : '';
  const preview = !live && A.archived;
  const panels = live || A.hosted ? A.competitors.map(c => c.panel).filter(Boolean) : (DATA.t0panels || []);
  return `${phaseBanner()}
  ${preview ? `<div class="notice"><b>Preview.</b> Tournament 1 has not started, so this page replays the last real round: <span class="archived">archived</span> ${esc(A.archived)}, round ${st.rounds[ri].round}. The same layout fills live when the referee starts.</div>` : ''}
  <div class="grid">
    <div class="c8 stack">${x ? `<section class="box hero"><div class="hero-head">${x.res === 3 ? '<span class="pill live">Live</span>' : '<span class="pill done">Round game</span>'}${botLink(x.p1)}<span class="vs">vs</span>${botLink(x.p2)}<a class="more" href="${href('games', x.run.id, x.id)}" style="margin-left:auto">Open game</a></div><div class="kithost compact" data-game="${esc(key)}" data-layout="compact" data-live="${x.res === 3 ? 1 : 0}"></div>${spotBarHtml(key)}</section>` : ''}
      ${run ? (() => { const { playing, done } = gridGames({ run, max: 12, finished: 6 }), list = [...playing, ...done].filter(i => i !== ag).slice(0, 6); return list.length ? `<section class="box"><div class="bh"><h3>Round games, board by board</h3><span class="sub">${playing.length} playing</span><a class="more" href="${href('games')}?run=${encodeURIComponent(run.id)}">All boards</a></div><div class="gtiles three">${list.map(i => tileHtml(i, { sm: true })).join('')}</div></section>` : ''; })() : ''}
      ${run ? `<section class="box"><div class="bh"><h3>Round games</h3><span class="sub">${run.decided} of ${run.planned || run.n} played · <a href="${href('runs', run.id)}">${esc(run.id)}</a></span></div>${gameGrid(run)}</section>` : ''}</div>
    <div class="c4 stack"><section class="box"><div class="bh"><h3>Round standings</h3><a class="more" href="${href('arena', 'standings')}">All rounds</a></div>${roundStandings(st, ri)}</section>
      ${A.hosted && !panels.length ? '' : `<section class="box"><div class="bh"><h3>Builders are thinking</h3></div>${thoughtsFeed(panels, 10)}</section>`}</div>
  </div>
  <div style="margin-top:var(--gap)">${builderIntro()}</div>`;
}
function pageArenaStandings() {
  const st = M.arena.standings;
  if (!st?.rounds?.length) return `${phaseBanner()}<div class="notice">No rated round yet.</div>`;
  const names = Object.keys(st.global || {});
  const series = names.map(n => ({ name: n, color: /-v\d+$/.test(n) ? famColor('llm') : botColor(n), points: st.rounds.filter(r => r.pool !== 'holdout').map(r => [r.round, st.global[n]]).filter(p => p[1] != null) }));
  const runOf = (r, i) => roundRun(r.round) || (i === st.rounds.length - 1 ? arenaRun() : null);
  return `<div class="phead"><h1>Arena standings</h1><p class="lede">Bradley-Terry ratings with the baselines' mean pinned at 1500. Each round: its standings with every bot's Atlas style and nine spots, and the grid of every game it played. ${M.arena.archived ? `<span class="archived">archived</span> ${esc(M.arena.archived)}` : ''}</p></div>
  ${st.rounds.filter(r => r.pool !== 'holdout').length > 1 ? `<section class="box"><div class="bh"><h3>Rating by round</h3></div>${lineChart(series, { xLabel: 'round', xFmt: v => `R${v}` })}</section>` : ''}
  ${st.rounds.map((r, i) => ({ r, i })).reverse().map(({ r, i }) => { const run = runOf(r, i); return `<div class="grid" data-sec="round-${i}" style="margin-top:12px"><div class="c7 box"><div class="bh"><h3>Round ${r.round}${r.pool === 'holdout' ? ' · held-out cards' : ''}</h3><span class="sub">${r.games} games · leader ${esc(r.leader)}</span></div>${roundStandings(st, i, { fp: true })}</div><div class="c5 box"><div class="bh"><h3>Who beat whom</h3><span class="sub">${run ? `<a class="mono" href="${href('runs', run.id)}">${esc(run.id)}</a>` : `round ${r.round}`}</span></div>${run ? gameGrid(run) : '<p class="muted">No game list kept for this round.</p>'}</div></div>`; }).join('')}`;
}
function compCard(c) {
  const p = c.panel, st = M.arena.standings, h = c.harness || {}, v = compVersion(c);
  return `<a class="box comp" href="${href('arena', 'builders', c.name)}" style="--c:${famColor(h.kind === 'script' ? 'search' : 'llm')};color:inherit;text-decoration:none"><span class="eyebrow">Builder system</span><div class="row" style="justify-content:space-between"><span class="nm">${esc(c.name)}</span><span class="muted" style="font-size:var(--fs-sm)">${esc(c.title)}${c.benched ? ' · benched' : ''}</span></div><span class="row" style="gap:4px">${systemChips(c.harness)}</span><span class="now">${esc(p?.now || 'No status posted yet')}</span><span class="eyebrow" style="margin-top:4px">Bots it built</span><span class="lineage">${c.versions.map(x => `<span title="${esc(x.note || '')}"><b class="mono">${esc(x.name.replace(c.name + '-', ''))}</b>${st?.global?.[x.name] != null ? ` ${st.global[x.name]}` : ''}</span>`).join('<i>→</i>') || '<span class="faint">none yet</span>'}</span>${v && atl(v) ? `<span class="row" style="gap:8px">${fingerprint(v, 'md')}${styleTag(atl(v).summary?.style)}${atl(v).forfeits ? `<span class="mk clock">⏱ ${atl(v).forfeits}</span>` : ''}</span>` : `<span class="row" style="gap:8px;font-size:var(--fs-sm);color:var(--muted)">${fingerprint(v || c.name, 'md')} spot map after its first round${c.start && atl(c.start) ? `; starts from ${esc(c.start)} ${styleTag(atl(c.start).summary?.style)}` : ''}</span>`}</a>`;
}
function pageCompetitors() {
  const A = M.arena;
  return `<div class="phead"><h1>Builders</h1><p class="lede">The systems that build bots, and the bots each one built. Baselines (fixed bots, no builder): ${A.baselines.map(b => botLink(b)).join(' and ')}.</p></div><section class="box" style="margin-bottom:12px"><div class="bh"><h3>The systems</h3></div>${setupTable()}</section><div class="comps">${A.competitors.map(compCard).join('')}</div><div style="margin-top:var(--gap)">${builderIntro()}</div>`;
}
function panelBody(p, { compact = false } = {}) {
  if (!p) return '<p class="muted">No panel posted.</p>';
  const feats = p.mentalModel?.features || [];
  const maxW = Math.max(1e-9, ...feats.map(f => Math.abs(+f.weight || 0)));
  const plan = compact ? (p.plan || []).filter(s => s.state !== 'done').slice(0, 3) : (p.plan || []);
  return `<div class="stack">
    ${p.now ? `<div><div class="eyebrow">Now</div><p style="margin-top:3px">${esc(numFix(p.now))}</p></div>` : ''}
    ${p.goal && !compact ? `<div><div class="eyebrow">Goal</div><p style="margin-top:3px;color:var(--ink-2)">${esc(p.goal)}</p></div>` : ''}
    ${p.mentalModel?.summary && !compact ? `<div><div class="eyebrow">How it thinks</div><p style="margin-top:3px;color:var(--ink-2);font-size:var(--fs-base)">${esc(p.mentalModel.summary)}</p></div>` : ''}
    ${feats.length && !compact ? hbars(feats.map(f => ({ t: f.name, v: +f.weight || 0, c: (+f.weight || 0) >= 0 ? 'var(--pos-4)' : 'var(--neg-4)', title: f.note || f.name })), { lo: -maxW, hi: maxW, mid: 0, fmt: v => +v.toFixed(2) }) : ''}
    ${plan.length ? `<div><div class="eyebrow">${compact ? 'Next' : 'Plan'}</div><div class="plan" style="margin-top:4px">${plan.map(s => `<div class="${esc(s.state)}"><span>${s.state === 'done' ? '✓' : s.state === 'doing' ? '▸' : '○'}</span><span>${esc(s.text)}</span></div>`).join('')}</div></div>` : ''}
    ${(p.thoughts || []).length && !compact ? `<div><div class="eyebrow">Thinking</div>${[...p.thoughts].slice(-12).reverse().map(t => `<div class="thought"><span class="mono faint" style="font-size:var(--fs-sm)">${clock(t.t)} · ${ago(t.t)} ago</span><span>${esc(numFix(t.text))}</span></div>`).join('')}</div>` : ''}
  </div>`;
}
/** Owners' widgets (dashboard contract), drawn with the shared pieces: bot names become bot chips in their family
 *  colour, search trees and game spines use the console's board glyphs, custom views run in a sandboxed frame. */
function widgetHtml(w) {
  const t = w.title ? `<h4 style="margin-bottom:6px">${esc(w.title)}</h4>` : '';
  const cell = c => { const s = String(c ?? ''); return isBot(s) ? botLink(BOTALIAS(s)) : esc(numFix(s)); };
  // result widgets (dashboard contract, README section 5): one row inline or `items`; shares and values are 0..1, and a
  // percentage (58 or "58%") is read as one; a row that is neither is skipped and the widget says how many
  if (w.type === 'faceoff' || w.type === 'score') {
    const rows = Array.isArray(w.items) ? w.items : [w], fx = v => { const n = parseFloat(v); if (!Number.isFinite(n)) return null; const f = /%\s*$/.test(String(v)) || n > 1 ? n / 100 : n; return f >= 0 && f <= 1 ? f : null; };
    const ok = w.type === 'faceoff' ? rows.filter(r => r?.a && r?.b && fx(r.share) != null) : rows.filter(r => (r?.bot || r?.label) && fx(r.value) != null);
    const body = w.type === 'faceoff' ? ok.map(r => vsRow(BOTALIAS(r.a), BOTALIAS(r.b), fx(r.share), { n: r.n ?? null, note: r.note || '' })).join('')
      : ok.map(r => scoreRow(r.bot ? `${botLink(BOTALIAS(r.bot))}${styleTag(atl(BOTALIAS(r.bot))?.summary?.style)}` : esc(r.label), fx(r.value), [r.vs && `against ${r.vs}`, r.n && `${r.n} games`].filter(Boolean).join(' · '))).join('');
    const skipped = rows.length - ok.length;
    return `<div>${t}${body}${skipped ? `<p class="muted" style="font-size:var(--fs-sm)">${skipped} row${skipped > 1 ? 's' : ''} skipped: ${w.type === 'faceoff' ? 'a face-off needs a, b and a share from 0 to 1' : 'a score needs a bot or label and a value from 0 to 1'}.</p>` : ''}</div>`;
  }
  if (w.type === 'spots') {
    const ids = [...new Set([...(w.bots || []), ...(w.bot ? [w.bot] : []), ...(w.items || []).map(i => i?.bot)].filter(Boolean).map(BOTALIAS))];
    const unknown = ids.filter(id => !M.bots[id]);
    return `<div>${t}${botTable(ids) || '<p class="muted">None of these bots has games yet.</p>'}${unknown.length ? `<p class="muted" style="font-size:var(--fs-sm)">No games yet: ${unknown.map(esc).join(', ')}.</p>` : ''}</div>`;
  }
  if (w.type === 'stats') return `<div>${t}<div class="kpis">${(w.items || []).map(i => `<div><div class="v">${esc(typeof i.value === 'number' && i.format === 'pct' ? pct(i.value) : numFix(i.value))}</div><div class="k">${esc(i.label)}</div></div>`).join('')}</div></div>`;
  if (w.type === 'line') { const pal = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s7)']; return `<div>${t}${lineChart((w.series || []).slice(0, 6).map((s, i) => ({ name: s.name, points: s.points || [], color: isBot(s.name) ? botColor(BOTALIAS(s.name)) : pal[i % pal.length] })), { yFmt: w.yFormat === 'pct' ? pct : v => +(+v).toFixed(2), xLabel: w.x || '', h: 200 })}</div>`; }
  if (w.type === 'bars') { const vs = (w.items || []).map(i => +i.value || 0), lo = Math.min(0, ...vs), hi = Math.max(...vs, 1e-9); return `<div>${t}${hbars((w.items || []).slice(0, 16).map(i => ({ t: i.label, html: isBot(i.label) ? botLink(BOTALIAS(i.label)) : null, c: isBot(i.label) ? botColor(BOTALIAS(i.label)) : undefined, v: +i.value || 0 })), { lo, hi, mid: lo < 0 ? 0 : null, fmt: v => w.format === 'pct' ? pct(v) : +v.toFixed(2) })}</div>`; }
  if (w.type === 'table') return `<div>${t}<div class="scroll"><table><thead><tr>${(w.columns || []).map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${(w.rows || []).slice(0, 30).map(r => `<tr>${r.map(c => `<td>${cell(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  if (w.type === 'text') return `<div>${t}<p style="white-space:pre-wrap;font-size:var(--fs-md);color:var(--ink-2)">${esc(numFix(w.body))}</p></div>`;
  if (w.type === 'tree' && w.root && window.SWUGlyph) { try { const tr = SWUGlyph.tree(w.root, { glyph: 34, colors: GLYPHC }); return `<div>${t}<div class="treebox">${tr.svg}</div>${w.caption ? `<p class="muted" style="font-size:var(--fs-sm);margin-top:4px">${esc(w.caption)}</p>` : ''}</div>`; } catch { return `<div>${t}<div class="notice">This search tree could not be drawn.</div></div>`; } }
  if (w.type === 'spine' && w.steps && window.SWUGlyph) return `<div>${t}<div class="spine">${w.steps.map(s => SWUGlyph.glyph(s.state, { size: 26, value: s.value, title: s.label, colors: GLYPHC })).join('')}</div></div>`;
  if (w.type === 'html' && w.html) return `<div>${t}<iframe class="wframe" sandbox="allow-scripts" title="${esc(w.title || 'custom view')}" style="height:${Math.min(600, +w.height || 200)}px" srcdoc="${esc(w.html)}"></iframe></div>`;
  if (w.type === 'strategy') return `<div data-strategy="${esc(JSON.stringify(w))}"></div>`;
  return `<div class="notice">${esc(w.title || w.type)}: no renderer for this widget type (${esc(w.type)}).</div>`;
}
function pageCompetitor(r) {
  const c = M.arena.competitors.find(x => x.name === r.parts[2]);
  if (!c) return `<div class="notice">No builder named ${esc(r.parts[2])}.</div>`;
  const h = c.harness || {}, st = M.arena.standings, p = c.panel, col = famColor(h.kind === 'script' ? 'search' : 'llm'), v = compVersion(c);
  const results = (st?.rounds || []).flatMap(rd => rd.bots.filter(b => b.agent === c.name).map(b => ({ rd, b })));
  return `<p><a href="${href('arena', 'builders')}">← Builders</a></p><section class="bothead" style="--c:${col};--on-c:${onColor(col)}"><div class="icon">${esc(c.name.slice(0, 2).toUpperCase())}</div><div><div class="eyebrow">Builder system</div><div class="row"><h1>${esc(c.name)}</h1>${systemChips(c.harness)}</div><p class="line">${esc(c.title)}. Its task: ${esc(c.philosophy)}</p>${v ? atlasLine(v) : ''}</div><div class="stats"><div><div class="v">${c.versions.length}</div><div class="k">bots built</div></div><div><div class="v">${st?.global?.[c.latest] ?? '-'}</div><div class="k">newest bot's rating</div></div></div></section>
  <div class="grid"><div class="c8 stack"><section class="box"><div class="bh"><h3>What the builder is doing</h3>${p ? `<span class="sub">updated ${ago(p.updatedAt)} ago</span>` : ''}</div>${panelBody(p)}</section>
    ${v ? winsBox(v, `Where ${v} wins`) : ''}
    ${(p?.widgets || []).filter(w => w.type === 'strategy').map(w => `<section class="box">${widgetHtml(w)}</section>`).join('')}</div>
    <div class="c4 stack"><section class="box"><div class="bh"><h3>Bots it built</h3><span class="sub">one per round, newest last</span></div><div class="stack" style="gap:6px">${c.versions.map(x => `<div style="font-size:var(--fs-md)"><b class="mono">${esc(x.name)}</b> ${styleTag(atl(x.name)?.summary?.style)} <span class="muted">${esc(x.submittedAt ? ago(x.submittedAt) + ' ago' : '')}</span><br><span style="color:var(--ink-2)">${esc(x.note || '')}</span></div>`).join('') || '<p class="muted">None yet.</p>'}</div></section>
    <section class="box"><div class="bh"><h3>Results</h3></div>${results.length ? results.map(({ rd, b }) => `<p style="font-size:var(--fs-md)">Round ${rd.round}: ${b.wins}-${b.losses}${b.forfeits ? `, <span class="mk clock">⏱ ${b.forfeits}</span> lost by a late or broken reply` : ''}</p>`).join('') : '<p class="muted" style="font-size:var(--fs-md)">Not rated yet. After each round: wins and losses per opponent, and links to every lost game.</p>'}</section></div></div>`;
}
function pageRounds(r) {
  const reps = M.arena.reports, keys = Object.keys(reps).sort((a, b) => b - a);
  return `<div class="phead"><h1>Rounds</h1><p class="lede">Each round's report from the referee: standings, results per opponent and the lost games.</p></div>${keys.length ? keys.map(k => `<section class="box">${M.arena.archived ? '<span class="archived">archived</span>' : ''}${md(reps[k]).replace(/\/mnt\/project-files\/results\/(arena-[\w-]+)\/games\/([\w.@#+-]+)\.jsonl/g, (m, run, id) => `<a href="${href('games', run, id)}">${esc(id)}</a>`)}</section>`).join('') : '<div class="notice">No round has been rated yet.</div>'}`;
}
/** The mental model of connecting: your own MCP app signs in as you, then reads the arena; submitting comes later. */
function joinDiagram() {
  const box = (x, w, t, sub, stroke = 'var(--line-2)') => `<rect x="${x}" y="22" width="${w}" height="46" rx="6" style="fill:var(--raised);stroke:${stroke}" stroke-width="1.5"/><text x="${x + w / 2}" y="41" text-anchor="middle" class="pd-t">${t}</text><text x="${x + w / 2}" y="57" text-anchor="middle" class="pd-s">${sub}</text>`;
  const arrow = (x1, x2, label, dash = '') => `<line x1="${x1}" y1="45" x2="${x2 - 7}" y2="45" style="stroke:var(--muted)" stroke-width="1.5" ${dash}/><path d="M${x2 - 7} 40.5l7 4.5-7 4.5z" style="fill:var(--muted)"/><text x="${(x1 + x2) / 2}" y="15" text-anchor="middle" class="pd-s">${label}</text>`;
  return `<figure class="pd"><svg viewBox="0 0 420 96" role="img" aria-label="Your Claude app connects to the arena's MCP address, signs in as you with GitHub, reads games, replays, standings and research, and submits your bots, which the arena plays in its sandbox.">${box(4, 132, 'Your Claude app', 'claude.ai, Claude Code')}${arrow(136, 182, 'signs in as you')}${box(182, 92, 'SWU Arena', '/mcp', 'var(--accent)')}${arrow(274, 294, '')}${box(294, 122, 'Reads, submits', 'games, research, your bots')}<text x="228" y="88" text-anchor="middle" class="pd-s">your bots play in the arena's sandbox</text></svg><figcaption>Your app holds its own sign-in, cut off when you disconnect it or leave the invite list. It reads, and submits your own bots; it changes nothing else.</figcaption></figure>`;
}
async function loadApps() {
  S.apps = { busy: true };
  try { const r = await fetch('/api/apps', { credentials: 'same-origin' }), j = await r.json().catch(() => ({})); S.apps = r.ok ? j.result : { err: j.error?.message || `HTTP ${r.status}` }; }
  catch (e) { S.apps = { err: e?.message || 'offline' }; }
  if (route().parts[1] === 'join') render(true);
}
async function appDisconnect(id) {
  const keep = S.apps; S.apps = { ...keep, busy: true }; render(true);
  try {
    const r = await fetch('/api/apps', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disconnect: id }) }), j = await r.json().catch(() => ({}));
    S.apps = r.ok ? { ...j.result, msg: 'Disconnected. That app has to sign in again to read anything.' } : { ...keep, busy: false, msg: j.error?.message || `HTTP ${r.status}` };
  } catch (e) { S.apps = { ...keep, busy: false, msg: e?.message || 'offline' }; }
  render(true);
}
function pageJoin() {
  const builders = `<div class="c4 box"><h3>A round, from a builder's side</h3><ul class="plain" style="margin-top:6px"><li>wait until the work phase opens, read inbox and report</li><li>improve the bot; test with eval</li><li>post thinking and a strategy diagram with say</li><li>submit before the deadline</li></ul></div>`;
  if (!HOSTED) {
    return `<div class="phead"><h1>Join the arena</h1><p class="lede">You enter a builder: a Claude harness with your model, effort and memory settings, Codex, a script, or yourself. It writes its own bot and gets the same task and time as every other builder. Every front end calls the same methods.</p></div>
  <div class="grid"><div class="c8 box"><h3>Claude Code, Codex or any MCP client</h3><p class="muted" style="font-size:var(--fs-md);margin:6px 0">In the project the arena runs from the shared folder; tools are named arena_&lt;method&gt;.</p><pre class="mono" style="white-space:pre-wrap;font-size:var(--fs-sm);background:var(--sunken);padding:8px;border-radius:4px">claude mcp add arena -- node bot/arena/mcp.js</pre></div>${builders}</div>`;
  }
  const mcpUrl = `${location.origin}/mcp`, me = S.me, A = S.apps || {};
  if (me?.login && !S.apps) { S.apps = { busy: true }; setTimeout(loadApps); }
  const head = `<div class="phead"><h1>Build a bot</h1><p class="lede">Connect your own Claude, or any app that speaks MCP, to the arena. It signs in as you with GitHub and reads everything here: games, replays, standings and research, so it can study the bots and help you write one. Then it submits your bot (JavaScript, Python or WebAssembly): the arena checks it in a sandbox and plays every game itself.</p></div>`;
  if (!me?.login) {
    return `${head}<div class="grid"><section class="c7 box"><p>${me?.guest ? 'You came in by a view link. Connecting an app needs a GitHub sign-in on the invite list: ask Eric to add your GitHub username, then sign in.' : 'Sign in with GitHub to connect an app.'}</p></section><section class="c5 box">${joinDiagram()}</section></div>`;
  }
  const appsList = A.err ? `<p class="bad">${esc(A.err)}</p>` : !A.apps ? '<p class="muted">Loading…</p>' : A.apps.length
    ? `<ul class="invites">${A.apps.map(a => `<li><span><b>${esc(a.app)}</b> <span class="muted">${esc(a.site || '')} · connected ${ago(a.createdAt) === 'now' ? 'just now' : `${ago(a.createdAt)} ago`} · last used ${ago(a.usedAt) === 'now' ? 'just now' : `${ago(a.usedAt)} ago`}</span></span><button type="button" data-act="appDisconnect" data-id="${esc(a.id)}" data-app="${esc(a.app)}" ${A.busy ? 'disabled' : ''}>Disconnect</button></li>`).join('')}</ul>`
    : '<p class="muted">None yet. Once you connect one, it shows here.</p>';
  const code = t => `<pre class="mono" style="white-space:pre-wrap;word-break:break-all;font-size:var(--fs-sm);background:var(--sunken);padding:8px;border-radius:4px;margin:6px 0">${esc(t)}</pre>`;
  return `${head}<div class="grid">
    <section class="c7 box"><div class="bh"><h3>Connect in three steps</h3></div>
      <ol class="steps-list">
        <li><b>Copy the address.</b><div class="sharerow" style="margin-top:6px"><input id="mcpurl" readonly value="${esc(mcpUrl)}" aria-label="MCP address"><button type="button" data-act="mcpCopy">Copy</button></div></li>
        <li><b>Add it to your app.</b> On claude.ai: Settings, Connectors, Add custom connector, and paste it. In Claude Code:${code(`claude mcp add --transport http swu-arena ${mcpUrl}`)}then type <span class="mono">/mcp</span> and pick swu-arena. Other apps: add a remote MCP server with this address.</li>
        <li><b>Sign in with GitHub and press Allow</b> on the page your app opens. Then ask it something, like "who leads the arena, and how does that bot play?"</li>
      </ol></section>
    <section class="c5 box">${joinDiagram()}</section>
    <section class="c7 box"><div class="bh"><h3>Your connected apps</h3><span class="sub">as @${esc(me.login)}</span></div>${A.msg ? `<p class="good" style="margin-bottom:6px">${esc(A.msg)}</p>` : ''}${appsList}</section>
    <section class="c5 box"><div class="bh"><h3>What your app can do</h3></div><ul class="plain" style="margin-top:6px"><li><span class="mono">arena_status</span>, <span class="mono">arena_standings</span>, <span class="mono">arena_report</span>: the builder tournament</li><li><span class="mono">window_docs</span>: every run, game list, evaluation and the ratings</li><li><span class="mono">window_replay</span>: a game move by move, with the board</li><li><span class="mono">arena_guide</span>, <span class="mono">arena_submit</span>, <span class="mono">arena_my_submissions</span>: write a bot, send it, see whether it passed and which version plays</li><li><span class="mono">whoami</span>: who it reads as, and your builder name</li></ul></section>
  </div>`;
}
/** Home's pointer to the Join page: the one place a signed-in person learns they can bring their own Claude. */
function joinCard() {
  if (!HOSTED) return '';
  return `<section class="box join-card"><div class="bh"><h3>Build a bot</h3><a class="more" href="${href('arena', 'join')}">How</a></div><p style="font-size:var(--fs-base)">Connect your own Claude to the arena: it signs in as you, reads every game, replay and finding here to help you write a bot, and submits it for you.</p><p style="margin-top:8px"><a class="btn-link" href="${href('arena', 'join')}">Connect your Claude →</a></p></section>`;
}

// ---------- pages: bots ----------
function botRows(spot) {
  const q = S.botQ.toLowerCase();
  let rows = Object.values(M.bots).filter(b => b.games > 0 && (!S.botFam.size || S.botFam.has(b.fam)) && (!S.botStyle.size || S.botStyle.has(atl(b.id)?.summary?.style)) && (!q || b.id.toLowerCase().includes(q) || (b.lang || '').includes(q) || (atl(b.id)?.summary?.style || '').toLowerCase().includes(q)));
  if (spot) {
    // who to bet on: bots with 8+ games in the spot by edge, then thinner evidence, then bots with no map
    const key = b => { const a = atl(b.id), c = a?.situations?.[spot], mapped = a && a.games >= AT.MIN_GAMES && a.replayGames >= 5; return !mapped || !c?.n ? [0, b.rating ?? 0] : [c.n >= AT.MIN_GAMES ? 2 : 1, c.edge]; };
    return rows.sort((a, b) => { const x = key(a), y = key(b); return y[0] - x[0] || y[1] - x[1] || (b.rating ?? 0) - (a.rating ?? 0); });
  }
  const [k, d] = S.botSort, val = b => k === 'id' ? b.id : k === 'speed' ? (b.speed?.mean ?? 1e12) : k === 'form' ? (b.form.at(-1) - (b.form[0] ?? 1500)) : b[k] ?? -1e9;
  rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * d; });
  return rows;
}
/** All bots, described the Atlas's way: the spot guide on top, then one table with every bot's edge in all nine
 *  spots next to its rating. Picking a spot (guide or column) sorts the table by it: that is "who to bet on". */
function pageBots(r) {
  const A = ATL(), spot = AT.SPOTS[r.qs.get('spot')] ? r.qs.get('spot') : null, ids = Object.keys(AT.SPOTS);
  if (spot && GUIDE.want !== spot) { GUIDE.want = spot; GUIDE.i = ids.indexOf(spot); GUIDE.auto = false; GUIDE.t0 = performance.now() - 5000; }
  if (!spot && GUIDE.want) { GUIDE.want = null; GUIDE.auto = true; }
  const counts = {}, scount = {};
  for (const b of Object.values(M.bots)) if (b.games > 0) { counts[b.fam] = (counts[b.fam] || 0) + 1; const st = atl(b.id)?.summary?.style; if (st) scount[st] = (scount[st] || 0) + 1; }
  const rows = botRows(spot), shown = S.botAll || S.botQ || S.botFam.size || S.botStyle.size ? rows : rows.slice(0, 25);
  const th = (k, l, cls = '') => `<th class="sortable ${cls}" ${!spot && S.botSort[0] === k ? `aria-sort="${S.botSort[1] > 0 ? 'ascending' : 'descending'}"` : ''}><button type="button" class="sortbtn" data-act="botSort" data-k="${k}">${l}${!spot && S.botSort[0] === k ? (S.botSort[1] > 0 ? ' ▲' : ' ▼') : ''}</button></th>`;
  const cols = SITS().map((s, i) => ({ ...s, first: i === 0 || SITS()[i - 1].group !== s.group }));
  const groups = GROUPS(), spotLink = id => `${href('bots')}${id && id !== spot ? `?spot=${id}` : ''}`;
  const ranks = spot ? A?.ranks?.[spot] || [] : [];
  const cell = (b, s) => { const c = atl(b.id)?.situations?.[s.id], on = s.id === spot ? 'on' : ''; if (!c?.n) return `<td class="e spotcol hide-sm faint ${s.first ? 'gs' : ''} ${on}">·</td>`; const col = AT.edgeColor(c.edge), mk = A.best[s.id] === b.id ? '★' : ''; return `<td class="e spotcol hide-sm ${c.n < 5 ? 'few' : ''} ${s.first ? 'gs' : ''} ${on}" style="--c:${col.bg};--fc:${col.fg}" title="${esc(`${b.id} in ${s.label}: ${edgeTxt(c.edge)} pts vs an average bot, won ${c.wins} of ${c.n}${mk ? ' · best of all bots here' : ''}`)}">${mk}${edgeTxt(c.edge)}</td>`; };
  const spotCells = b => { const a = atl(b.id); if (!a || !(a.games >= AT.MIN_GAMES && a.replayGames >= 5)) return `<td colspan="${cols.length}" class="spotcol hide-sm gs unm" title="${esc(!a ? 'not in the Atlas yet' : `the Atlas maps a bot from 8+ games with 5+ replays; this one has ${a.replayGames || 0} replays`)}">no spot map yet${a ? ` · ${a.replayGames || 0} replays kept` : ''}</td>`; return cols.map(s => cell(b, s)).join(''); };
  const fam = M.research.famSpots || {};
  const famCell = (v, s) => { if (!v) return `<td class="e spotcol hide-sm faint ${s.first ? 'gs' : ''}">·</td>`; const c = AT.edgeColor(v.mean); return `<td class="e spotcol hide-sm ${s.first ? 'gs' : ''}" style="--c:${c.bg};--fc:${c.fg}" title="${v.bots} bots">${edgeTxt(v.mean)}</td>`; };
  const S0 = spot ? sit(spot) : null;
  return `<div class="phead"><h1>Bots</h1><p class="lede">${rows.length} bots, each described the Strategy Atlas's way: its Atlas rating, then how many points of win chance it gets above an average bot in each of nine game spots. Pick a spot to see who to bet on there.</p></div>
  ${A ? `<section class="box atlas-top"><div class="guide"><svg id="guide-svg" viewBox="0 0 240 150" role="img" aria-label="Spot guide"></svg><div id="guide-cap"><div class="eyebrow" id="guide-grp"></div><div id="guide-title"></div><p id="guide-say"></p><p id="guide-rule"></p><div id="guide-bet" class="stack" style="gap:3px;margin-top:6px"></div><div class="row" style="margin-top:8px"><button type="button" class="searchbtn" id="guide-play">${GUIDE.auto ? 'Pause' : 'Play all'}</button></div></div></div>
    <div class="gpicks">${SITS().map(s => { const top = AT.rankIn(A, s.id)[0]; return `<a class="gpick ${s.id === spot ? 'on' : ''}" href="${spotLink(s.id)}" data-spot="${s.id}" title="${esc(`${s.short}. ${s.id === spot ? 'Click again to clear.' : 'Sort the table by this spot.'}`)}">${spotIcon(s.id)}<span>${esc(s.label)}</span>${top ? `<b>★ ${esc(top.id)}</b>` : ''}</a>`; }).join('')}</div>
    <p class="verdict" style="margin-top:10px">${verdictLine()}</p><div style="margin-top:8px">${standoutsLine()}</div></section>` : ''}
  <div class="filters" style="margin-top:14px"><div class="fchips">${Object.keys(FAMS).filter(f => counts[f]).map(f => `<button type="button" class="fchip" data-act="botFam" data-f="${f}" aria-pressed="${S.botFam.has(f)}" style="--c:${famColor(f)}"><i></i>${FAMS[f].name}<small>${counts[f]}</small></button>`).join('')}</div><div class="fchips">${(AT.STYLE_KEY || []).filter(([k]) => scount[k]).map(([k, d]) => `<button type="button" class="fchip sty" data-act="botStyle" data-s="${k}" aria-pressed="${S.botStyle.has(k)}" title="${esc(d)}"><span class="stag ${k}">${k}</span><small>${scount[k]}</small></button>`).join('')}</div><input type="search" data-input="botQ" placeholder="Filter by name, language or style" value="${esc(S.botQ)}" aria-label="Filter bots"><a href="${href('bots', 'faceoff')}" style="font-size:var(--fs-md)">Face-off: compare two bots</a></div>
  ${S0 ? `<div class="spot-sort">${spotIcon(spot, 'pict m')}<div><b>Sorted by ${esc(S0.label)}</b> <span class="muted">${esc(S0.short)} · this side wins ${pct(S0.field?.rate)} · ★ = who to bet on (8+ games there; faded = fewer)</span></div><a class="searchbtn" href="${href('bots')}">Clear</a></div>` : ''}
  <section class="box" style="margin-top:10px"><div class="scroll"><table class="matrix bots"><thead>
    <tr class="grp-row hide-sm"><th colspan="3"></th>${groups.map(g => `<th colspan="${cols.filter(s => s.group === g).length}" class="gs grp">${esc(AT.GROUP[g] || g)}</th>`).join('')}<th colspan="5"></th></tr>
    <tr>${spot ? `<th title="rank in this spot among bots with 8+ games there">${spotIcon(spot, 'pict s')}</th>` : th('rank', '#')}${th('id', 'Bot')}${th('rating', 'Rating', 'n')}${cols.map(s => `<th class="colh spotcol hide-sm ${s.first ? 'gs' : ''} ${s.id === spot ? 'on' : ''}"><a href="${spotLink(s.id)}" title="${esc(`${s.short}. ${s.id === spot ? 'Click again to clear.' : 'Sort by this spot.'}`)}">${spotIcon(s.id)}${esc(s.label)}</a></th>`).join('')}<th class="show-sm">Spots</th><th class="hide-sm">Style</th>${th('games', 'Games', 'n')}${th('winRate', 'Win %', 'n')}${th('form', 'Form', 'hide-sm hide-md')}${th('speed', 'Speed', 'n hide-sm')}</tr></thead>
  <tbody>${shown.map(b => { const a = atl(b.id), rk = spot ? ranks.indexOf(b.id) : -1; return `<tr class="click" data-href="${href('bots', b.id)}"><td class="rank">${spot ? (rk === 0 ? '<span class="mk star">★</span>' : rk > 0 ? rk + 1 : '<span class="faint">–</span>') : b.rank ?? ''}</td><td class="botc">${botLink(b.id)}${b.active ? ' <span class="pill running" title="played in the newest run" style="font-size:var(--fs-2xs);padding:0 5px">active</span>' : ''}${a?.forfeits ? ` <span class="mk clock" title="lost games by a late or broken reply">⏱${a.forfeits}</span>` : ''}<span class="sub2">${esc([FAMS[b.fam]?.name, b.lang].filter(Boolean).join(' · '))}</span></td><td class="n"><b>${b.rating ?? '-'}</b><span class="faint"> ±${2 * (b.se || 0)}</span></td>${spotCells(b)}<td class="show-sm">${fingerprint(b.id)}</td><td class="hide-sm">${styleTag(a?.summary?.style)}</td><td class="n">${b.games}</td><td class="n">${pct(b.winRate)}</td><td class="hide-sm hide-md">${spark(b.form, botColor(b.id))}</td><td class="n hide-sm">${ms(b.speed?.mean)}</td></tr>`; }).join('')}</tbody>
  ${Object.keys(fam).length ? `<tfoot class="hide-sm"><tr><td colspan="3" class="muted" style="padding-top:12px;font-size:var(--fs-sm)">By family, against bots of their own level:</td>${cols.map(s => `<td class="spotcol ${s.first ? 'gs' : ''}"></td>`).join('')}<td colspan="6"></td></tr>${[['search', 'Search bots'], ['onePly', '1-ply bots (heuristic, rules)'], ['learned', 'Learned bots']].map(([k, l]) => `<tr><td colspan="3"><span class="fam" style="--c:${famColor(k === 'onePly' ? 'heuristic' : k)}">${l}</span></td>${cols.map(s => famCell(fam[s.id]?.[k], s)).join('')}<td colspan="6"></td></tr>`).join('')}</tfoot>` : ''}</table></div>
  ${rows.length > shown.length || S.botAll ? `<div class="row" style="justify-content:center;margin-top:10px"><button type="button" class="searchbtn" data-act="botsAll">${S.botAll ? 'Show top 25' : `Show all ${rows.length}`}</button></div>` : ''}
  <div style="margin-top:10px">${fpKey()}</div></section>
  <section class="box flat" style="margin-top:12px"><div class="bh"><h3>Style words</h3><span class="sub">from how a bot attacks: share of attacks at the base, base damage and units removed per round</span></div><div class="row" style="gap:8px 18px;font-size:var(--fs-md)">${(AT.STYLE_KEY || []).map(([k, d]) => `<span>${styleTag(k)} <span class="muted">${esc(d)}</span></span>`).join('')}</div>${A ? `<p class="muted" style="font-size:var(--fs-sm);margin-top:8px">Spots, edges and styles come from the Strategy meta analyzer (${A.mapped.length} mapped bots, ${int(A.totals?.games)} games, updated ${ago(A.generatedAt)} ago) through its shared Atlas kit. <a href="https://claude.ai/artifact/JncYCS8KTqThEtvobNS4wy" target="_blank" rel="noopener">The Atlas's own page</a></p>` : ''}</section>`;
}
function pageBot(r) {
  const id = r.parts[1], b = M.bots[id];
  if (!b) return `<div class="notice">No bot named ${esc(id)}.</div>`;
  const c = botColor(id), a = b.card || {}, at = atl(id);
  const opp = Object.entries(M.h2h[id] || {}).map(([o, [w, l, d]]) => ({ o, w, l, d, n: w + l + d, s: (w + d / 2) / (w + l + d) })).sort((x, y) => y.n - x.n);
  const myGames = []; for (let i = M.games.length - 1; i >= 0 && myGames.length < 400; i--) { const g = M.games[i]; if ((M.botList[g[2]] === id || M.botList[g[3]] === id) && !isPeople(i)) myGames.push(i); }
  const vsPeople = peopleStats().bots.find(B => B.id === id);
  const lost = myGames.filter(i => { const x = gameRow(M.games[i]); return x.res < 2 && (x.res === 0 ? x.p2 : x.p1) === id && hasReplay(i); }).slice(0, 8);
  const panel = M.panels.find(p => p.id === b.panel);
  const cmp = S.cmp && M.bots[S.cmp] ? M.bots[S.cmp] : null;
  const formSeries = [{ name: id, color: c, points: b.form.map((v, i) => [i, v]) }];
  if (cmp) formSeries.push({ name: cmp.id, color: botColor(cmp.id), points: cmp.form.map((v, i) => [i * (b.form.length - 1) / Math.max(1, cmp.form.length - 1), v]), dash: true });
  const st = at?.summary?.style;
  return `<section class="bothead" style="--c:${c};--on-c:${onColor(c)}"><div class="icon">${esc(id.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase())}</div><div><div class="row"><h1>${esc(id)}</h1>${famChip(b.fam)}${langChip(b.lang)}${b.active ? '<span class="pill running">active</span>' : ''}</div><p class="line">${esc(b.line || FAMS[b.fam]?.desc || '')}</p>${atlasLine(id)}</div>
    <div class="stats"><div><div class="v">${b.rating ?? '-'}</div><div class="k">rating ±${2 * (b.se || 0)}</div></div><div><div class="v">${b.rank ? `#${b.rank}` : '-'}</div><div class="k">of ${M.order.length}</div></div><div><div class="v">${b.w}-${b.l}${b.d ? `-${b.d}` : ''}</div><div class="k">${pct(b.winRate)} of ${b.games}</div></div><div><div class="v">${ms(b.speed?.mean)}</div><div class="k">per decision</div></div></div></section>
  <div class="grid">
    <div class="c8 stack">
      ${winsBox(id)}
      <section class="box"><div class="bh"><h3>How it plays</h3>${a.source ? `<span class="sub">${a.source === 'owner' ? 'written by its builder' : 'drafted from code; builder should check'}</span>` : ''}</div>${st ? `<p style="margin-bottom:8px">${styleTag(st)} <span class="muted" style="font-size:var(--fs-md)">${esc(STYLE_DESC[st] || '')}</span></p>` : ''}${a.how ? `<ul class="plain">${a.how.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">No bot card yet.</p>'}
        ${a.sees || a.lookahead ? `<dl class="kv" style="margin-top:12px">${a.sees ? `<dt>Sees</dt><dd>${esc(a.sees)}</dd>` : ''}${a.lookahead ? `<dt>Lookahead</dt><dd>${esc(a.lookahead)}</dd>` : ''}${a.learnsFrom ? `<dt>Learns from</dt><dd>${esc(a.learnsFrom)}</dd>` : ''}</dl>` : ''}
        ${styleBars(id)}
        ${a.strengths || a.weaknesses ? `<div class="grid" style="margin-top:12px"><div class="c6"><div class="eyebrow good">Strengths</div><ul class="plain" style="margin-top:4px">${(a.strengths || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div><div class="c6"><div class="eyebrow bad">Weaknesses</div><ul class="plain" style="margin-top:4px">${(a.weaknesses || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div></div>` : ''}</section>
      <section class="box"><div class="bh"><h3>Games</h3><span class="sub">newest first</span><a class="more" href="${href('games', 'all')}" data-bot="${esc(id)}" id="allgames">All its games</a></div>${gamesTable(myGames.slice(0, 10), { me: id })}${lost.length ? `<h4 style="margin:14px 0 6px">Recent losses with replays</h4>${gamesTable(lost, { me: id })}` : ''}</section>
    </div>
    <div class="c4 stack">
      ${vsPeople ? `<section class="box people-box"><div class="bh"><h3>Against people</h3><a class="more" href="${href('people')}">Vs people</a></div><p style="font-size:var(--fs-base)">${humanPill()} <b>${vsPeople.w}-${vsPeople.l}${vsPeople.d ? `-${vsPeople.d}` : ''}</b> on karabast.net${vsPeople.n ? `, ${pct(vsPeople.pct)} won` : ''}${vsPeople.live ? ` · ${vsPeople.live} playing now` : ''}.</p><p class="muted" style="font-size:var(--fs-sm);margin-top:4px">Never rated: its rating and the games below are bot-vs-bot only.</p></section>` : ''}
      <section class="box"><div class="bh"><h3>Compare</h3></div><select data-input="cmp" aria-label="Compare with"><option value="">Pick a bot to compare</option>${M.order.filter(x => x !== id).map(x => `<option ${x === S.cmp ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>${cmp ? (() => { const h = M.h2h[id]?.[cmp.id]; return `<p style="margin-top:8px;font-size:var(--fs-base)">Head to head: <b>${h ? `${h[0]}-${h[1]}${h[2] ? `-${h[2]}` : ''}` : 'never met'}</b>. Rating ${b.rating} vs ${cmp.rating}.</p><div class="stack" style="gap:4px;margin-top:8px;font-size:var(--fs-md)"><span class="row">${fingerprint(id)} ${esc(id)}</span><span class="row">${fingerprint(cmp.id)} ${esc(cmp.id)}</span></div><p style="margin-top:8px"><a href="${href('bots', 'faceoff')}?a=${encodeURIComponent(id)}&b=${encodeURIComponent(cmp.id)}">Open the face-off, spot by spot</a></p>`; })() : ''}</section>
      <section class="box"><div class="bh"><h3>Form</h3><span class="sub">Elo after each game</span></div>${lineChart(formSeries, { h: 170, w: 420, labels: false, xLabel: 'games' })}</section>
      <section class="box"><div class="bh"><h3>Opponents</h3><span class="sub">${opp.length}</span></div><div class="scroll"><table><tbody>${opp.slice(0, 12).map(o => `<tr><td>${botLink(o.o)}</td><td class="hide-sm">${styleTag(atl(o.o)?.summary?.style)}</td><td class="n">${o.w}-${o.l}${o.d ? `-${o.d}` : ''}</td><td style="width:70px"><div class="track" style="position:relative;height:8px;background:var(--sunken);border-radius:2px"><i style="position:absolute;left:0;top:0;bottom:0;width:${o.s * 100}%;background:${o.s >= .5 ? 'var(--good)' : 'var(--bad)'};border-radius:2px"></i></div></td></tr>`).join('')}</tbody></table></div></section>
      ${panel ? `<section class="box"><div class="bh"><h3>Research line</h3><a class="more" href="${href('research', 'lines', panel.id)}">Open</a></div><p style="font-weight:600;font-size:var(--fs-base)">${esc(panel.title)}</p>${panelBody(panel, { compact: true })}</section>` : ''}
      <section class="box"><div class="bh"><h3>Facts</h3></div><dl class="kv">${S.aud === 'project' && b.owner ? `<dt>Built by</dt><dd>${esc(b.owner)}</dd>` : ''}<dt>Runs</dt><dd>${b.runs.length}</dd><dt>Last played</dt><dd>${b.lastSeen ? `${ago(b.lastSeen)} ago` : '-'}</dd>${at?.forfeits ? `<dt>⏱ Forfeits</dt><dd class="mk clock">${at.forfeits} lost by a late or broken reply</dd>` : b.faults ? `<dt>⏱ Forfeits</dt><dd class="mk clock">${b.faults}</dd>` : ''}${b.speed ? `<dt>Speed</dt><dd>${ms(b.speed.mean)} mean, ${ms(b.speed.p95)} p95 (${esc(b.speed.src || '')})</dd>` : ''}${at ? `<dt>Spot map</dt><dd>${at.replayGames || 0} games with replays</dd>` : ''}${a.code ? `<dt>Code</dt><dd class="mono" style="font-size:var(--fs-sm)">${esc(a.code)}</dd>` : ''}${(a.variants || []).length ? `<dt>Variants</dt><dd>${a.variants.map(v => `${botLink(v.id)} <span class="muted">${esc(v.diff)}</span>`).join('<br>')}</dd>` : ''}</dl></section>
    </div></div>`;
}

// ---------- pages: games and runs ----------
function gridNote() {
  return S.live ? '' : `<div class="notice"><b>Snapshot from ${clock(M.builtAt)}.</b> These boards replay each game as the snapshot caught it.${CAN_LIVE ? ' <button type="button" class="searchbtn" data-act="golive" style="margin-left:6px">Go live</button> and running games update every few seconds from their replay files.' : ''}</div>`;
}
function tileKey() { return `<p class="gt-key"><span><i class="sq"></i>ground unit, number = power</span><span><i class="ci"></i>space unit</span><span><i class="dmg"></i>damaged</span><span>tall bar = base HP left</span><span>cards = hand size</span><span>▶ = initiative</span><span>under each board: the Atlas spots each side is in, and that bot's edge there</span></p>`; }
function pageLiveGrid(r) {
  const runs = [...new Set(gridGames({ max: 60, finished: 24 }).playing.map(i => M.runs[M.games[i][0]].id))];
  const want = r.qs.get('run'), run = want ? runById(want) : null;
  const { playing, done } = gridGames({ run, max: 36, finished: 12 });
  const chips = runs.length > 1 ? `<div class="fchips">${[['', 'All runs'], ...runs.map(x => [x, x])].map(([k, l]) => `<a class="fchip" href="${href('games')}${k ? `?run=${encodeURIComponent(k)}` : ''}" aria-pressed="${(want || '') === k}"><i style="background:var(--live)"></i>${esc(l)}</a>`).join('')}</div>` : '';
  const nob = playing.filter(i => !hasBoard(i)).length, ppl = gridGames({ people: true, max: 60, finished: 0 }).playing.length;
  return `<div class="phead"><h1>Now playing</h1><p class="lede">Every running bot-vs-bot game in the project, one small board each, in the Strategy Atlas's picture language. Click a board to watch the game.</p></div>
  ${gridNote()}${ppl ? `<div class="notice people-note">${humanPill()} ${ppl} game${ppl === 1 ? '' : 's'} against ${ppl === 1 ? 'a person' : 'people'} on karabast.net ${ppl === 1 ? 'is' : 'are'} playing too. <a href="${href('people')}">Watch on Vs people</a></div>` : ''}${chips}
  <section><div class="bh" style="margin:6px 0 8px"><h2>${playing.length ? `Playing${S.live ? ' now' : ' at snapshot time'}` : 'Nothing is playing'}</h2><span class="sub">${playing.length} game${playing.length === 1 ? '' : 's'}${nob ? ` · ${nob} without a board (no replay file kept)` : ''}</span></div>${playing.length ? `${playing.length > nob ? `<div class="gtiles">${playing.filter(hasBoard).map(i => tileHtml(i)).join('')}</div>` : ''}${nob ? `<div class="nob-list">${playing.filter(i => !hasBoard(i)).map(i => { const x = gameRow(M.games[i]); return `<a href="${href('games', x.run.id, x.id)}"><span class="pill live">Live</span>${tileSeat(x, 'p1')}<span class="vs">vs</span>${tileSeat(x, 'p2')}<span class="mono faint">${esc(x.run.id)}</span></a>`; }).join('')}<p class="muted" style="font-size:var(--fs-sm)">No board for these: their run does not keep replay files, so only the result will show. Runs that keep replays get a board here and a spot map in Bots.</p></div>` : ''}` : `<p class="muted">No run is playing ${S.live ? 'right now' : 'in this snapshot'}. The newest finished games are below.</p>`}</section>
  ${done.length ? `<section style="margin-top:18px"><div class="bh" style="margin-bottom:8px"><h2>Just finished</h2><span class="sub">newest first</span><a class="more" href="${href('games', 'all')}">All games</a></div><div class="gtiles">${done.map(i => tileHtml(i)).join('')}</div></section>` : ''}
  ${tileKey()}`;
}
function moreGamesBox() {
  const lg = liveGame(), hero = lg ? lg.i : -1, { playing, done } = gridGames({ max: 12, finished: 8 });
  const list = [...playing, ...done].filter(i => i !== hero).slice(0, 4);
  if (!list.length) return '';
  return `<section class="box"><div class="bh"><h3>${playing.filter(i => i !== hero).length ? 'Also playing' : 'More games'}</h3><span class="sub">${playing.length} playing${S.live ? '' : ' at snapshot time'}</span><a class="more" href="${href('games')}">All boards</a></div><div class="gtiles four">${list.map(i => tileHtml(i, { sm: true })).join('')}</div></section>`;
}
function pageGames(r) {
  const F = S.gamesF, pick = document.getElementById('allgames');
  const runIx = F.run ? M.runs.findIndex(x => x.id === F.run) : -1, botI = F.bot ? M.botList.indexOf(F.bot) : -1;
  const rows = [];
  for (let i = M.games.length - 1; i >= 0; i--) {
    const g = M.games[i];
    if (isPeople(i)) continue; // games against people are on their own tab
    if (runIx >= 0 && g[0] !== runIx) continue;
    if (botI >= 0 && g[2] !== botI && g[3] !== botI) continue;
    if (F.res === 'decided' && g[4] > 2) continue; if (F.res === 'playing' && g[4] !== 3) continue; if (F.res === 'forfeit' && !g[7]) continue; if (F.res === 'error' && g[4] !== 4) continue;
    if (F.replay && !hasReplay(i)) continue;
    rows.push(i);
  }
  const per = 40, pages = Math.max(1, Math.ceil(rows.length / per)), p = Math.min(S.gamesPage, pages - 1);
  const botGames = [...M.games.keys()].filter(i => !isPeople(i)), botRuns = M.runs.filter(x => x.kind !== 'people');
  return `<div class="phead"><h1>Games</h1><p class="lede">${int(botGames.length)} bot-vs-bot games in ${botRuns.length} runs; ${int(botGames.filter(hasReplay).length)} have a replay you can watch.${botRuns.length < M.runs.length ? ` Games against people are on <a href="${href('people')}">Vs people</a>.` : ''}</p></div>
  <div class="filters"><select data-input="gamesF" data-k="bot" aria-label="Bot"><option value="">Any bot</option>${[...M.order, ...Object.keys(M.bots).filter(x => !M.bots[x].rating)].map(x => `<option ${x === F.bot ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select><select data-input="gamesF" data-k="run" aria-label="Run"><option value="">Any run</option>${[...M.runs].reverse().filter(x => x.kind !== 'people').map(x => `<option ${x.id === F.run ? 'selected' : ''}>${esc(x.id)}</option>`).join('')}</select><select data-input="gamesF" data-k="res" aria-label="Result">${[['all', 'Any result'], ['decided', 'Decided'], ['playing', 'Playing now'], ['forfeit', 'Won by forfeit'], ['error', 'Not rated (engine error)']].map(([k, l]) => `<option value="${k}" ${k === F.res ? 'selected' : ''}>${l}</option>`).join('')}</select><label class="row" style="font-size:var(--fs-md);gap:5px"><input type="checkbox" data-input="gamesF" data-k="replay" ${F.replay ? 'checked' : ''}>Has replay</label><span class="muted" style="font-size:var(--fs-md)">${int(rows.length)} games</span></div>
  <section class="box">${gamesTable(rows.slice(p * per, p * per + per))}<div class="pager" style="margin-top:8px"><button type="button" data-act="gamesPage" data-d="-1" ${p === 0 ? 'disabled' : ''}>Newer</button><span class="mono">${p + 1} / ${pages}</span><button type="button" data-act="gamesPage" data-d="1" ${p >= pages - 1 ? 'disabled' : ''}>Older</button></div></section>`;
}
const KIND = { arena: ['Arena round', 'llm'], ladder: ['Ladder', 'heuristic'], study: ['Study', 'learned'], people: ['Vs people', 'search'], test: ['Test', 'random'] };
function pageRuns() {
  return `<div class="phead"><h1>Runs</h1><p class="lede">Every ladder, study and arena round, newest first.</p></div><section class="box"><div class="scroll"><table><thead><tr><th>Run</th><th>Kind</th><th>Started</th><th class="n">Bots</th><th class="n">Games</th><th>Top of the run</th></tr></thead><tbody>${[...M.runs].filter(r => r.kind !== 'people').reverse().map(r => `<tr class="click" data-href="${href('runs', r.id)}"><td><a href="${href('runs', r.id)}" class="mono">${esc(r.id)}</a>${r.running ? ' <span class="pill live">playing</span>' : ''}</td><td><span class="fam" style="--c:${famColor(KIND[r.kind][1])}">${KIND[r.kind][0]}</span></td><td class="mono" style="font-size:var(--fs-sm)">${ago(r.createdAt)} ago</td><td class="n">${r.bots.filter(b => !isPerson(r, b)).length}</td><td class="n">${r.decided}${r.planned ? ` / ${r.planned}` : ''}</td><td>${r.table[0] ? `${botLink(r.table[0].id)} <span class="muted" style="font-size:var(--fs-sm)">${pct(r.table[0].pct)}</span>` : '-'}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function pageRun(r) {
  const run = runById(r.parts[1]); if (!run) return `<div class="notice">No run named ${esc(r.parts[1])}.</div>`;
  const ri = M.runs.indexOf(run), rows = []; for (let i = M.games.length - 1; i >= 0; i--) if (M.games[i][0] === ri) rows.push(i);
  const exps = M.experiments.filter(e => runsIn(e).includes(run)), people = run.kind === 'people', wide = people || (run.gamesPerPairing || 2) * run.bots.length > 24, half = wide ? 'c12' : 'c6';
  return `<div class="phead"><div><div class="eyebrow">${KIND[run.kind][0]} · ${new Date(run.createdAt).toLocaleString()}</div><h1 class="mono">${esc(run.id)}</h1></div><p class="lede">${run.kind === 'people' ? `Our bots against people: ${run.decided} finished games${run.abandoned ? `, ${run.abandoned} abandoned` : ''}${run.errors ? `, ${run.errors} with no result` : ''}` : `${run.bots.length} bots, ${run.decided} rated games${run.planned ? ` of ${run.planned}` : ''}${run.errors ? `, ${run.errors} not rated (engine errors or caps)` : ''}${run.abandoned ? `, ${run.abandoned} with no result (the run stopped before they ended)` : ''}`}${run.running ? `, ${run.running} playing now` : ''}.</p></div>
  ${exps.map(e => `<div class="notice" style="border-style:solid;margin-bottom:12px"><b>Why this run:</b> <a href="${href('research', 'experiments', e.id)}">${esc(e.title)}</a>. ${esc(e.hypothesis || '')}${e.conclusion ? ` <b>Found:</b> ${esc(e.conclusion)}` : ''}</div>`).join('')}
  <div class="grid"><div class="${half} box"><div class="bh"><h3>Standings in this run</h3><span class="sub">score bar: line = 50%</span></div><div class="scroll"><table><thead><tr><th>#</th><th>Bot</th><th class="hide-sm">Style</th><th class="hide-sm">Nine spots</th><th class="n">W-L</th><th>Score</th></tr></thead><tbody>${run.table.map((t, i) => `<tr><td class="rank">${i + 1}</td><td>${botLink(t.id)}</td><td class="hide-sm">${styleTag(atl(t.id)?.summary?.style)}</td><td class="hide-sm">${fingerprint(t.id)}</td><td class="n">${t.w}-${t.l}${t.d ? `-${t.d}` : ''}</td><td><span class="sc-cell"><span class="sc"><i style="width:${(t.pct || 0) * 100}%;--c:${t.pct >= .5 ? 'var(--pos-4)' : 'var(--neg-4)'}"></i><b></b></span><em>${pct(t.pct)}</em></span></td></tr>`).join('')}</tbody></table></div></div>
  ${people ? `<div class="c12 notice people-note">Every game here is one of our bots against a real person on karabast.net. <a href="${href('people')}">Vs people</a> has the record over time and the games playing now.</div>` : `<div class="${half} box"><div class="bh"><h3>Who beat whom</h3><span class="sub">every game; click a square to watch</span></div>${run.bots.length <= 14 ? gameGrid(run) : `<p class="muted">${run.bots.length} bots: too many for the grid; see the games below.</p>`}</div>`}
  <div class="c12 box"><div class="bh"><h3>Newest games</h3><a class="more" href="${people ? href('people') : href('games', 'all')}">All games</a></div>${gamesTable(rows.slice(0, 12), { showRun: false })}${rows.length > 12 ? `<p class="muted" style="margin-top:6px">${rows.length - 12} more: ${people ? `<a href="${href('people')}">Vs people</a> lists every game.` : 'the grid above has every game.'}</p>` : ''}</div></div>`;
}
function pageGame(r) {
  const run = runById(r.parts[1]), key = `${r.parts[1]}/${r.parts[2]}`, i = gameIdx.get(key);
  if (!run || i == null) return `<div class="notice">No game ${esc(key)}.</div>`;
  const x = gameRow(M.games[i]), ev = DATA.evals[x.id], ri = M.runs.indexOf(run);
  const sib = []; M.games.forEach((g, j) => { if (g[0] === ri) sib.push(j); }); const at = sib.indexOf(i);
  const nav = (j, l) => j != null && sib[j] != null ? `<a href="${href('games', run.id, M.games[sib[j]][1])}">${l}</a>` : `<span class="faint">${l}</span>`;
  const both = atl(x.p1) && atl(x.p2), ours = x.human ? x[x.human === 'p1' ? 'p2' : 'p1'] : null;
  const side = s => `${seatLink(x, s)}${x.human === s ? '' : styleTag(atl(x[s])?.summary?.style)}`;
  const lede = x.human
    ? `${x.res === 3 ? `${esc(ours)} is playing a real person on karabast.net right now.` : x.res === 5 ? `${esc(ours)} against a real person on karabast.net: abandoned, the game never started or went silent.` : x.res === 2 ? `${esc(ours)} drew with a real person on karabast.net.` : x.res === 4 ? `${esc(ours)} against a real person on karabast.net: no result.` : `${esc(ours)} ${winnerName(x) === ours ? 'beat' : 'lost to'} a real person on karabast.net in round ${x.rounds}.`} Never rated: games against people stay out of every bot's rating.`
    : x.res === 3 ? 'Playing now.' : x.res === 4 ? 'Not rated (engine error or step cap).' : x.res === 5 ? 'No result: its run stopped sending before this game ended.' : x.res === 2 ? 'Draw.' : `${esc(winnerName(x))} won${x.forfeit ? ' by forfeit (⏱ a late or broken reply)' : ''} in round ${x.rounds}.`;
  return `<div class="phead"><div><div class="eyebrow">${x.human ? `${humanPill()} <a href="${href('people')}">karabast.net</a>` : `<a href="${href('runs', run.id)}">${esc(run.id)}</a>`} · game ${at + 1} of ${sib.length}</div><h1 class="row" style="gap:10px">${side('p1')}<span class="faint" style="font-size:var(--fs-base)">vs</span>${side('p2')}</h1></div><p class="lede">${lede} ${x.steps ? `${x.steps} decisions.` : ''} ${ev ? 'Analysed: the timeline shows four win-chance curves.' : ''}</p><span class="row" style="font-size:var(--fs-md)">${nav(at - 1, '← Previous')} · ${nav(at + 1, 'Next →')}${both ? ` · <a href="${href('bots', 'faceoff')}?a=${encodeURIComponent(x.p1)}&b=${encodeURIComponent(x.p2)}">Face-off of these two</a>` : ''}</span></div>
  ${spotBarHtml(key)}
  <div class="kithost" data-game="${esc(key)}" data-layout="full" data-live="${x.res === 3 ? 1 : 0}" data-pivotal="1" style="margin-top:8px"></div>
  <section class="box"><div class="bh"><h3>Pivotal plays</h3><span class="sub">the actions that moved the game most; click to jump</span></div><div id="pivotal" class="comps" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px"><p class="muted">Loading…</p></div></section>`;
}

// ---------- pages: bots vs people ----------
/** Our bots' record against people on karabast.net: per bot W-L-D, abandoned and playing games, and its finished
 *  results oldest first (1 won, 0 lost, .5 draw); `games` is every game of a people run, newest first. */
function peopleStats() {
  const by = {}, games = [];
  for (let i = M.games.length - 1; i >= 0; i--) {
    if (!isPeople(i)) continue;
    const x = gameRow(M.games[i]); games.push(i);
    if (!x.human) continue; // a feed's game with no seat we can tell is a person's: listed, kept out of the record
    const seat = x.human === 'p1' ? 'p2' : 'p1', id = x[seat], B = (by[id] ||= { id, w: 0, l: 0, d: 0, n: 0, ab: 0, live: 0, seq: [] });
    if (x.res === 3) B.live++;
    else if (x.res === 5) B.ab++;
    else if (x.res <= 2) { const sc = x.res === 2 ? .5 : (x.res === 0) === (seat === 'p1') ? 1 : 0; sc === 1 ? B.w++ : sc === 0 ? B.l++ : B.d++; B.n++; B.seq.push(sc); }
  }
  for (const B of Object.values(by)) { B.seq.reverse(); B.pct = B.n ? (B.w + B.d / 2) / B.n : null; }
  return { bots: Object.values(by).sort((a, b) => b.n - a.n || b.live - a.live), games };
}
/** The mental model: two kinds of games come in, and only bot-vs-bot games reach the ratings. */
function peopleDiagram() {
  const box = (x, y, t, s, c) => `<rect x="${x}" y="${y}" width="128" height="42" rx="6" style="fill:var(--raised);stroke:${c}" stroke-width="1.5"/><text x="${x + 64}" y="${y + 18}" text-anchor="middle" class="pd-t">${t}</text><text x="${x + 64}" y="${y + 33}" text-anchor="middle" class="pd-s">${s}</text>`;
  const arrow = (y, label, c) => `<line x1="136" y1="${y}" x2="198" y2="${y}" style="stroke:${c}" stroke-width="1.6"/><path d="M198 ${y - 4.5}l7 4.5-7 4.5z" style="fill:${c}"/><text x="170" y="${y - 7}" text-anchor="middle" class="pd-s">${label}</text>`;
  return `<figure class="pd"><svg viewBox="0 0 340 112" role="img" aria-label="Bot-vs-bot games from ladders and arena rounds go into the ratings, the Bots tab and the Games tab. Games between our bots and people on karabast.net go only to the Vs people tab and are never rated.">
    ${box(4, 6, 'Ladders, arena', 'a bot vs a bot', 'var(--accent)')}${arrow(27, 'rated', 'var(--accent)')}${box(208, 6, 'Ratings', 'Bots and Games tabs', 'var(--accent)')}
    ${box(4, 64, 'karabast.net', 'our bot vs a person', 'var(--human)')}${arrow(85, 'never rated', 'var(--human)')}${box(208, 64, 'Vs people', 'this tab', 'var(--human)')}
  </svg><figcaption>Two kinds of games come in. Only bot-vs-bot games change a rating.</figcaption></figure>`;
}
/** Home: our bots' record against people, and the live game against a person when the hero shows a bot game. */
function peopleCard() {
  const P = peopleStats(); if (!P.games.length) return '';
  const lg = liveGame() ? liveGame({ people: true }) : null;
  return `<section class="box people-box"><div class="bh"><h3>Vs people</h3><span class="sub">karabast.net · never rated</span><a class="more" href="${href('people')}">Open</a></div><div class="stack" style="gap:4px">${P.bots.slice(0, 3).map(B => `<div class="row" style="font-size:var(--fs-md)">${botLink(B.id)}<b>${B.w}-${B.l}${B.d ? `-${B.d}` : ''}</b><span class="muted">${B.n ? `${pct(B.pct)} won` : 'no finished game yet'}${B.live ? ` · ${B.live} playing now` : ''}</span></div>`).join('')}</div>${lg ? `<div class="gtiles" style="margin-top:10px">${tileHtml(lg.i, { sm: true })}</div>` : ''}</section>`;
}
const PEOPLE_F = [['all', 'All'], ['playing', 'Playing'], ['won', 'Our bot won'], ['lost', 'Our bot lost'], ['abandoned', 'Abandoned']];
function pagePeople() {
  const P = peopleStats();
  const head = `<div class="phead"><h1>Bots vs people</h1><p class="lede">Our bots play real people on karabast.net, the public Star Wars Unlimited site. These games never change a bot's rating; ratings come from bot-vs-bot games only. People are never named here: each one shows as "a person".${HOSTED ? ` <a href="#/share?from=${encodeURIComponent('#/people')}">Share this tab</a>` : ''}</p></div>`;
  const how = `<section class="box" style="margin-top:18px"><div class="bh"><h3>How these games are kept apart</h3></div>${peopleDiagram()}</section>`;
  if (!P.games.length) return `${head}<div class="box"><p class="muted">No games against people yet.</p></div>${how}`;
  const all = P.bots.reduce((a, B) => ({ w: a.w + B.w, l: a.l + B.l, d: a.d + B.d, n: a.n + B.n, ab: a.ab + B.ab, live: a.live + B.live }), { w: 0, l: 0, d: 0, n: 0, ab: 0, live: 0 });
  const { playing, done } = gridGames({ people: true, max: 12, finished: 6 });
  const won = i => { const x = gameRow(M.games[i]); return x.res < 2 && winnerName(x) !== 'the person'; };
  const keep = { all: () => true, playing: i => M.games[i][4] === 3, won, lost: i => M.games[i][4] < 2 && !won(i), abandoned: i => M.games[i][4] === 5 }[S.peopleF] || (() => true);
  const rows = P.games.filter(keep), per = 30, pages = Math.max(1, Math.ceil(rows.length / per)), p = Math.min(S.peoplePage, pages - 1);
  const W = 20, series = P.bots.filter(B => B.seq.length >= 10).map(B => ({ name: B.id, color: botColor(B.id), points: B.seq.map((_, k) => k).filter(k => k >= 9).map(k => { const w = B.seq.slice(Math.max(0, k - W + 1), k + 1); return [k + 1, w.reduce((a, v) => a + v, 0) / w.length]; }) }));
  if (series.length) { const xs = series.flatMap(x => x.points.map(q => q[0])); series.push({ name: 'even', color: 'var(--line-2)', dash: true, nolabel: true, width: 1, points: [[Math.min(...xs), .5], [Math.max(...xs), .5]] }); }
  const kpis = `<div class="kpis"><div><div class="v">${int(all.n)}</div><div class="k">finished games</div></div><div><div class="v">${all.w}-${all.l}${all.d ? `-${all.d}` : ''}</div><div class="k">our bots' record</div></div><div><div class="v">${pct(all.n ? (all.w + all.d / 2) / all.n : null)}</div><div class="k">won</div></div><div><div class="v">${all.ab}</div><div class="k">abandoned</div></div><div><div class="v">${all.live}</div><div class="k">playing now</div></div></div>`;
  const record = `<div class="scroll"><table><thead><tr><th>Bot</th><th class="n">W-L</th><th>Won</th><th class="n hide-sm">Abandoned</th><th class="n hide-sm">Its rating</th></tr></thead><tbody>${P.bots.map(B => `<tr><td>${botLink(B.id)}${B.live ? ' <span class="pill live">playing</span>' : ''}</td><td class="n">${B.w}-${B.l}${B.d ? `-${B.d}` : ''}</td><td><span class="sc-cell"><span class="sc"><i style="width:${(B.pct || 0) * 100}%;--c:${B.pct >= .5 ? 'var(--pos-4)' : 'var(--neg-4)'}"></i><b></b></span><em>${pct(B.pct)}</em></span></td><td class="n hide-sm">${B.ab}</td><td class="n hide-sm">${M.bots[B.id]?.rating ?? '<span class="faint">-</span>'}${M.bots[B.id]?.rank ? ` <span class="faint">#${M.bots[B.id].rank}</span>` : ''}</td></tr>`).join('')}</tbody></table></div><p class="muted" style="font-size:var(--fs-sm);margin-top:6px">Its rating: from bot-vs-bot games only, for comparison. Score bar: line = 50%.</p>`;
  return `${head}
  <section class="box"><div class="bh"><h3>Our bots against people</h3><span class="sub">finished games</span></div>${record}</section>
  <div style="margin-top:var(--gap)">${kpis}</div>
  <section style="margin-top:18px"><div class="bh" style="margin:6px 0 8px"><h2>${playing.length ? `Playing${S.live ? ' now' : ' at snapshot time'}` : 'Nothing is playing'}</h2><span class="sub">${playing.length} game${playing.length === 1 ? '' : 's'} against people</span></div>${playing.length ? `<div class="gtiles">${playing.map(i => tileHtml(i)).join('')}</div>` : `<p class="muted">No game against a person is playing ${S.live ? 'right now' : 'in this snapshot'}.</p>`}</section>
  ${done.length ? `<section style="margin-top:18px"><div class="bh" style="margin-bottom:8px"><h2>Just finished</h2><span class="sub">newest first</span></div><div class="gtiles">${done.map(i => tileHtml(i)).join('')}</div></section>` : ''}
  ${series.length ? `<section class="box" style="margin-top:18px"><div class="bh"><h3>Win rate over time</h3><span class="sub">share of its last ${W} finished games won, by game number</span></div>${lineChart(series, { yLo: 0, yHi: 1, yFmt: pct, xLabel: 'finished games', h: 220, label: `Each bot's win rate against people over its last ${W} games` })}</section>` : ''}
  <section class="box" style="margin-top:18px"><div class="bh"><h3>Every game against people</h3><span class="sub">newest first</span></div><div class="fchips" style="margin-bottom:8px">${PEOPLE_F.map(([k, l]) => `<button type="button" class="fchip" data-act="peopleF" data-f="${k}" aria-pressed="${S.peopleF === k}">${esc(l)}</button>`).join('')}<span class="muted" style="font-size:var(--fs-md);align-self:center">${int(rows.length)} games</span></div>${gamesTable(rows.slice(p * per, p * per + per), { showRun: false })}<div class="pager" style="margin-top:8px"><button type="button" data-act="peoplePage" data-d="-1" ${p === 0 ? 'disabled' : ''}>Newer</button><span class="mono">${p + 1} / ${pages}</span><button type="button" data-act="peoplePage" data-d="1" ${p >= pages - 1 ? 'disabled' : ''}>Older</button></div></section>
  ${tileKey()}${how}`;
}

// ---------- share: a link to any page, and (an admin) who may sign in ----------
const SHARE_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="3.5" r="2"/><circle cx="4" cy="8" r="2"/><circle cx="12" cy="12.5" r="2"/><path d="M5.8 7l4.4-2.5M5.8 9l4.4 2.5"/></svg>';
const GH_LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const shareLink = from => `${location.origin}${location.pathname}${/^#\/(?!share)/.test(from || '') ? from : '#/'}`;
async function loadShare() {
  S.share = { busy: true };
  try { const r = await fetch('/api/share', { credentials: 'same-origin' }), j = await r.json().catch(() => ({})); S.share = r.ok ? j.result : { err: j.error?.message || `HTTP ${r.status}` }; }
  catch (e) { S.share = { err: e?.message || 'offline' }; }
  if (route().parts[0] === 'share') render(true);
}
async function shareChange(body) {
  const keep = S.share; S.share = { ...keep, busy: true, msg: '', linkMsg: '' }; render(true);
  const done = body.add ? { msg: `@${body.add} can sign in now. Send them the link above.` } : body.remove ? { msg: `@${body.remove} can no longer sign in.` }
    : body.addLink ? { linkMsg: `Made a view link: ${body.addLink}. Copy or send it below.` } : { linkMsg: 'Removed. Anyone using that link is locked out.' };
  try {
    const r = await fetch('/api/share', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), j = await r.json().catch(() => ({}));
    S.share = r.ok ? { ...j.result, ...done } : { ...keep, busy: false, [body.addLink || body.removeLink ? 'linkMsg' : 'msg']: j.error?.message || `HTTP ${r.status}` };
  } catch (e) { S.share = { ...keep, busy: false, msg: e?.message || 'offline' }; }
  render(true);
}
/** The mental model: two ways in (a GitHub sign-in on the invite list, or a view link), one arena, view only. */
function shareDiagram(admin) {
  const box = (y, t, s) => `<rect x="4" y="${y}" width="150" height="42" rx="6" style="fill:var(--raised);stroke:var(--line-2)" stroke-width="1.5"/><text x="79" y="${y + 18}" text-anchor="middle" class="pd-t">${t}</text><text x="79" y="${y + 33}" text-anchor="middle" class="pd-s">${s}</text>`;
  const arrow = (y1, y2) => `<line x1="156" y1="${y1}" x2="214" y2="${y2}" style="stroke:var(--muted)" stroke-width="1.5"/><path d="M214 ${y2 - 4.5}l7 4.5-7 4.5z" style="fill:var(--muted)"/>`;
  return `<figure class="pd"><svg viewBox="0 0 340 112" role="img" aria-label="Two ways in: signing in with GitHub when your name is on the invite list, or opening a view link. Both open the same arena, view only.">${box(6, 'GitHub sign-in', admin ? 'name on your invite list' : 'name on the invite list')}${box(64, 'View link', 'anyone holding it')}${arrow(27, 52)}${arrow(85, 60)}<rect x="222" y="35" width="114" height="42" rx="6" style="fill:var(--raised);stroke:var(--accent)" stroke-width="1.5"/><text x="279" y="53" text-anchor="middle" class="pd-t">The arena</text><text x="279" y="68" text-anchor="middle" class="pd-s">view only</text></svg><figcaption>Two ways in, one arena. Removing a name or a link locks it out on the next click.</figcaption></figure>`;
}
function pageShare(r) {
  const head = `<div class="phead"><h1>Share the arena</h1><p class="lede">Two ways in: sign in with GitHub when your name is on the invite list, or open a view link, which needs no account. Either way you see everything here: games and replays, bots and their histories, the research. Nobody who comes in can change anything.</p></div>`;
  if (!HOSTED) return `${head}<div class="notice">Sharing is part of the hosted arena at swu-arena.fly.dev; this copy is a snapshot.</div>`;
  const admin = S.me?.role === 'admin', sh = S.share || {}, from = r.qs.get('from'), hash = /^#\/(?!share)./.test(from || '') ? from : '';
  if (admin && !S.share) { S.share = { busy: true }; setTimeout(loadShare); }
  const who = (l, how, rm) => `<li><span class="mono">@${esc(l)}</span><span class="muted">${how}</span>${rm ? `<button type="button" data-act="inviteRemove" data-login="${esc(l)}" ${sh.busy ? 'disabled' : ''}>Remove</button>` : ''}</li>`;
  const list = sh.err ? `<p class="bad" style="margin-top:8px">${esc(sh.err)}</p>` : !sh.invites ? '<p class="muted" style="margin-top:8px">Loading…</p>'
    : `<ul class="invites">${[...(sh.admins || []).map(l => who(l, 'admin', false)), ...(sh.fromEnv || []).filter(l => !(sh.admins || []).includes(l)).map(l => who(l, 'set on the server', false)), ...sh.invites.map(l => who(l, 'invited here', true))].join('')}</ul>${sh.invites.length ? '' : '<p class="muted" style="margin-top:6px;font-size:var(--fs-md)">Nobody invited here yet.</p>'}`;
  const linkUrl = l => `${location.origin}/v/${l.key}${hash}`;
  const links = !sh.links ? '' : sh.links.length ? `<ul class="invites">${[...sh.links].reverse().map(l => `<li class="vlink"><span><b>${esc(l.label)}</b> <span class="muted">made ${ago(l.createdAt) === 'now' ? 'just now' : `${ago(l.createdAt)} ago`}</span><span class="mono faint vurl">${esc(linkUrl(l))}</span></span><span class="vbtns"><button type="button" data-act="linkCopy" data-url="${esc(linkUrl(l))}">Copy</button>${navigator.share ? `<button type="button" data-act="linkSend" data-url="${esc(linkUrl(l))}">Send</button>` : ''}<button type="button" data-act="linkRemove" data-id="${esc(l.id)}" data-label="${esc(l.label)}" ${sh.busy ? 'disabled' : ''}>Remove</button></span></li>`).join('')}</ul>` : '<p class="muted" style="margin-top:6px;font-size:var(--fs-md)">No view links yet.</p>';
  const notAdmin = S.me?.guest ? 'You came in by a view link. To share the arena, ask Eric for a link of your own.' : 'Only Eric adds people: send him their GitHub username, or ask him for a view link.';
  return `${head}<div class="grid">
    <section class="c7 box"><div class="bh"><h3>Link to the page you were on</h3></div><div class="sharerow"><input id="sharelink" readonly value="${esc(shareLink(from))}" aria-label="Link"><button type="button" data-act="shareCopy">Copy</button>${navigator.share ? '<button type="button" data-act="shareSend">Send</button>' : ''}</div><p class="muted" style="font-size:var(--fs-md);margin-top:6px">It opens that same page for anyone invited, right after they sign in.${admin ? ' For someone without GitHub, send a view link (below).' : ''}</p></section>
    <section class="c5 box">${shareDiagram(admin)}</section>
    ${admin ? `<section class="c12 box"><div class="bh"><h3>View links</h3><span class="sub">no account needed${hash ? `; each opens ${esc(hash)}` : ''}</span></div><p class="muted" style="font-size:var(--fs-md);margin-bottom:8px">Anyone holding a view link sees the arena with no sign-in, and a forwarded link works too. Make one per person, so you can remove one without the others.</p><form id="linkform" class="sharerow"><input id="linklabel" placeholder="Who is it for? (only you see this)" maxlength="60" autocomplete="off" aria-label="Who the link is for"><button type="submit" ${sh.busy ? 'disabled' : ''}>Make a link</button></form>${sh.linkMsg ? `<p style="margin-top:8px;font-size:var(--fs-md)">${esc(sh.linkMsg)}</p>` : ''}${links}</section>
    <section class="c12 box"><div class="bh"><h3>Who can sign in</h3><span class="sub">changes take effect at once</span></div><form id="inviteform" class="sharerow"><input id="invitelogin" placeholder="GitHub username" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="GitHub username"><button type="submit" ${sh.busy ? 'disabled' : ''}>Invite</button></form>${sh.msg ? `<p style="margin-top:8px;font-size:var(--fs-md)">${esc(sh.msg)}</p>` : ''}${list}</section>`
      : `<section class="c12 box"><p>${notAdmin}</p></section>`}
  </div>${S.me?.login ? `<p class="muted" style="margin-top:10px;font-size:var(--fs-md)">Signed in as @${esc(S.me.login)} · <a href="/auth/logout">Sign out</a></p>` : ''}`;
}

// ---------- pages: research ----------
function findingCard(f) {
  const col = f.v === 'holds' ? 'var(--good)' : f.v === 'partly' ? 'var(--warn)' : 'var(--line-2)', T = M.research.theory, src = f.src || '';
  let viz = '';
  if (/residual_bound/.test(src) && T) viz = `${evCurves(T, ['td', 'fixed', 'const'], { h: 190, w: 460 })}<p class="cap">Brier by windows left, as on the <a href="${href('research', 'evaluators')}">Evaluators</a> page.</p>`;
  else if (/search_exact/.test(src)) viz = `${famSpotTable(f.spots || [])}<p class="cap">Each family's edge in the nine Atlas spots against bots of its own level; the claim's spots are lit. <a href="${href('bots')}">Bots by spot</a></p>`;
  else if (/tdLoss_needs_closure/.test(src) && T) viz = `${tdScatter(T)}<p class="cap">If a low TD loss meant a good evaluator, the dots would rise to the left. They scatter.</p>`;
  else if (/omniscience_bias/.test(src) && f.botsShown?.length >= 2) viz = `${pairBox(f.botsShown[0], f.botsShown[1], { gapLabel: 'for seeing the hidden cards' })}${f.botsShown[2] ? `<p class="cap">Also: ${botChip(f.botsShown[2])} (1 window deep, blind)</p>` : ''}`;
  else if (/greedy_regret/.test(src) && f.botsShown?.length >= 2) viz = pairBox(f.botsShown[0], f.botsShown[1], { gapLabel: 'for the 1-ply bot' });
  return `<section class="box fcard" style="--fc:${col}"><div class="row" style="justify-content:space-between">${verdictPill(f)}<span class="src">${esc(src)}</span></div><h3>${esc(f.claim)}</h3><p><b>Proof:</b> ${esc(f.proof)}</p><p><b>Our games:</b> ${esc(f.data)}</p>${viz}</section>`;
}
function pageResearch() {
  const F = M.research.findings;
  return `<div class="phead"><h1>What we know about good play</h1><p class="lede">Claims proved in Lean, each tested on our own games and drawn with the picture it is about: evaluator curves, Atlas spots, two bots side by side. The verdict is computed from the current data, so it changes as runs finish.</p></div>
  <div class="notice" style="border-style:solid;border-color:var(--accent);background:var(--accent-soft)"><b>Bottom line:</b> ${esc(bottomLine(F))}</div>
  <div class="fcards wide">${F.map(findingCard).join('')}</div>`;
}
function pageEvaluators() {
  const T = M.research.theory; if (!T) return '<div class="notice">No evaluator report yet (research/eval-theory/td-report.json).</div>';
  const col = evColors(T), plays = id => M.bots[`h@${id}`] ? `h@${id}` : null;
  return `<div class="phead"><h1>Which evaluator predicts the winner?</h1><p class="lede">Brier score (mean squared error of the predicted win chance; 0 is perfect, 0.25 is a coin flip) by how many decision windows are left. The three best and the references are coloured; the rest are faint. ${T.games ? `${int(T.games)} games, ${int(T.windows)} windows.` : ''}</p></div>
  <div class="grid"><div class="c7 box"><div class="bh"><h3>Error by distance from the end</h3></div>${evCurves(T, null, { h: 270 })}</div>
  <div class="c5 box"><div class="bh"><h3>TD loss against real endings</h3><span class="sub">every evaluator</span></div>${tdScatter(T)}<p class="muted" style="font-size:var(--fs-sm);margin-top:6px">Proven endings: positions the omni solver proved won or lost. TD loss: disagreement with its own one-step lookahead. A constant scores well on TD loss and is right least often.</p></div>
  <div class="c12 box"><div class="scroll"><table><thead><tr><th>Evaluator</th><th class="n">Brier</th><th style="min-width:160px">on the Brier scale</th><th class="n">Proven right</th><th class="n hide-sm">Proven Brier</th><th class="n hide-sm">TD loss</th><th>Plays as</th></tr></thead><tbody>${[...T.evaluators].sort((a, b) => a.brier - b.brier).map(e => { const p = plays(e.id), x = Math.max(0, Math.min(100, (EV_HI - e.brier) / (EV_HI - EV_LO) * 100)); return `<tr><td><span class="bot" style="--c:${col(e.id) || 'var(--line-2)'}"><i></i><span>${esc(SWUApp.evName(e.id))}</span></span></td><td class="n">${e.brier.toFixed(3)}</td><td><span class="ev-trk"><b class="coin"></b><i style="left:${x}%;background:${col(e.id) || 'var(--muted)'}"></i></span></td><td class="n">${pct(e.provenAcc)}</td><td class="n hide-sm">${e.provenBrier?.toFixed(3) ?? '-'}</td><td class="n hide-sm">${e.tdLoss?.toFixed(4) ?? '-'}</td><td>${p ? `${botLink(p)}${styleTag(atl(p)?.summary?.style)} <span class="num">${M.bots[p].rating ?? ''}</span>` : '<span class="faint">no bot yet</span>'}</td></tr>`; }).join('')}</tbody></table></div><p class="muted" style="font-size:var(--fs-sm);margin-top:6px">Plays as: the heuristic bot that searches one move with this evaluator (h@name), with its Atlas style and rating, so prediction and play sit side by side.</p></div></div>`;
}
/** The analysed game's four win-chance curves, the two gaps they measure, and the checkpoints that moved most. */
function pageAnalysis() {
  if (!M.evals.length) return `<div class="phead"><h1>Position analysis</h1></div><div class="notice">No analysed games yet.</div>`;
  const out = M.evals.map(e => {
    const E = DATA.evals?.[e.gameId], P = E?.points || [], m = /results\/([^/]+)\/games\/([^/]+)\.jsonl$/.exec(e.replay || '') || /games\/([^/]+)\/games\/([^/]+)\.jsonl$/.exec(e.replay || '');
    const link = m && gameIdx.has(`${m[1]}/${m[2]}`) ? href('games', m[1], m[2]) : null;
    if (!P.length) return `<section class="box"><div class="bh"><h3>${botLink(e.p1)} vs ${botLink(e.p2)}</h3><span class="sub">${e.n} checkpoints</span></div><p class="muted">Curves not in this snapshot.</p></section>`;
    const V = [['p1_subjective', `${e.p1}'s own view`, 'var(--fa)'], ['p2_subjective', `${e.p2}'s own view`, 'var(--fb)'], ['objective_state', 'all-seeing', 'var(--ink-2)'], ['objective_hindsight', 'hindsight', 'var(--muted)', true]];
    const series = V.map(([k, name, color, dash]) => ({ name, color, dash, points: P.filter(p => p[k] != null).map((p, i) => [i, p[k]]) }));
    const mean = xs => xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;
    const hidden = mean(P.flatMap(p => [p.p1_subjective, p.p2_subjective].filter(v => v != null && p.objective_state != null).map(v => Math.abs(v - p.objective_state))));
    const luck = mean(P.filter(p => p.objective_state != null && p.objective_hindsight != null).map(p => Math.abs(p.objective_state - p.objective_hindsight)));
    const swings = P.map((p, i) => ({ p, i, d: i ? Math.abs((p.objective_state ?? 0) - (P[i - 1].objective_state ?? 0)) : 0 })).filter(x => x.p.note).sort((a, b) => b.d - a.d).slice(0, 4).sort((a, b) => a.i - b.i);
    return `<section class="box"><div class="bh"><h3>${botLink(e.p1)} <span class="faint">vs</span> ${botLink(e.p2)}</h3><span class="sub">${e.n} checkpoints · ${esc(e.winner === 'p1' ? e.p1 : e.winner === 'p2' ? e.p2 : '?')} won · rated by ${esc(e.evaluator?.model || '?')}</span>${link ? `<a class="more" href="${link}">Watch with the curves</a>` : ''}</div>
      <div class="grid"><div class="c8">${lineChart(series, { yLo: 0, yHi: 1, yFmt: pct, xLabel: 'checkpoint', h: 250 })}</div>
      <div class="c4 stack"><div class="gapbox"><div class="v">${hidden == null ? '-' : Math.round(hidden * 100)} pts</div><div class="k">hidden information: how far each player's own view sits from the all-seeing one, on average (pts of win chance)</div></div><div class="gapbox"><div class="v">${luck == null ? '-' : Math.round(luck * 100)} pts</div><div class="k">luck: how far the all-seeing view sits from hindsight, which also knows the draws to come</div></div></div></div>
      ${swings.length ? `<h4 style="margin:10px 0 6px">Where the all-seeing view moved most</h4><div class="swings">${swings.map(x => `<div><span class="mono faint">#${x.i + 1} · round ${x.p.round ?? '-'}</span><b class="${(x.p.objective_state ?? 0) >= (P[x.i - 1]?.objective_state ?? 0) ? 'good' : 'bad'}">${pct(x.p.objective_state)}</b><span>${esc(numFix(x.p.note))}</span></div>`).join('')}</div>` : ''}</section>`;
  }).join('');
  return `<div class="phead"><h1>Position analysis</h1><p class="lede">An LLM rates positions from four viewpoints; every curve is the chance that player 1 wins: each player's own view, an all-seeing view, and hindsight. The gaps measure hidden information and luck. The game viewer draws the same curves under the board.</p></div>${out}`;
}
/** Research lines placed by the bots they produced: one row per line on one rating axis, its best bot's style and
 *  nine spots on the right. Lines without rated bots (tools, studies) are listed under it. */
function expCard(e, full) {
  const p = e.progress, prog = p?.total ? `<div class="row" style="font-size:var(--fs-sm)"><span class="track" style="flex:1;position:relative;height:6px;background:var(--sunken);border-radius:3px"><i style="position:absolute;left:0;top:0;bottom:0;width:${Math.min(100, p.done / p.total * 100)}%;background:var(--accent);border-radius:3px"></i></span><span class="mono">${p.done}/${p.total} ${esc(p.unit || '')}</span></div>` : '';
  const runs = runsIn(e);
  return `<section class="box stack xcard" style="gap:8px"><div class="row" style="justify-content:space-between"><span class="pill ${esc(e.status)}">${esc(e.status)}</span><span class="mono faint" style="font-size:var(--fs-xs)">${ago(e.updatedAt)} ago</span></div><h3>${full ? esc(e.title) : `<a href="${href('research', 'experiments', e.id)}">${esc(e.title)}</a>`}</h3>${e.hypothesis ? `<p style="font-size:var(--fs-md);color:var(--ink-2)"><b>Hypothesis:</b> ${esc(e.hypothesis)}</p>` : ''}${prog}${evidence(e, { max: full ? 12 : 6, fp: full })}${e.conclusion ? `<p style="font-size:var(--fs-md)"><b>Found:</b> ${esc(e.conclusion)}</p>` : ''}${runs.length ? `<p style="font-size:var(--fs-sm)" class="muted">Run${runs.length > 1 ? 's' : ''}: ${runs.map(r => `<a class="mono" href="${href('runs', r.id)}">${esc(r.id)}</a>`).join(', ')}</p>` : ''}${full && runs[0] && runs[0].bots.length <= 14 ? `<div><h4 style="margin:6px 0">Every game in ${esc(runs[0].id)}</h4>${gameGrid(runs[0])}</div>` : ''}${full && e.chart ? widgetHtml({ type: 'line', title: `${e.chart.y || ''} by ${e.chart.x || ''}`, x: e.chart.x, yFormat: e.chart.yFormat, series: e.chart.series }) : ''}${S.aud === 'project' && e.owner ? `<span class="muted" style="font-size:var(--fs-sm)">${esc(e.owner)}</span>` : ''}</section>`;
}
function pageLines() {
  const ps = M.panels.filter(p => !/^arena-/.test(p.id));
  const rated = Object.values(M.bots).filter(b => b.rating != null), lo = Math.floor((Math.min(...rated.map(b => b.rating)) - 20) / 100) * 100, hi = Math.ceil((Math.max(...rated.map(b => b.rating)) + 20) / 100) * 100;
  const X = v => (v - lo) / (hi - lo) * 100;
  const rows = ps.map(p => ({ p, bots: (p.bots || []).filter(id => M.bots[id]?.rating != null).sort((a, b) => M.bots[b].rating - M.bots[a].rating) })).filter(x => x.bots.length).sort((a, b) => M.bots[b.bots[0]].rating - M.bots[a.bots[0]].rating);
  const tools = ps.filter(p => !rows.some(x => x.p === p));
  const ticks = []; for (let v = lo; v <= hi; v += 100) ticks.push(v);
  const axis = `<div class="ln-row ln-axis"><span></span><div class="ln-track">${ticks.map((v, i) => `<span class="${i % 2 ? 'odd' : ''}" style="left:${X(v)}%">${v}</span>`).join('')}</div><span class="hide-sm faint" style="font-size:var(--fs-xs)">its best bot, Atlas</span></div>`;
  return `<div class="phead"><h1>Research lines</h1><p class="lede">Every line of work, placed by the bots it produced: each dot is one of its bots on the shared rating scale, the label is its best. Right: that bot's style and nine spots. Arena builders have their own pages under Arena.</p></div>
  <section class="box lines">${axis}${rows.map(({ p, bots }) => { const best = bots[0]; return `<div class="ln-row"><div class="ln-name"><a href="${href('research', 'lines', p.id)}">${esc(p.title)}</a> <span class="pill ${esc(p.status)}">${esc(p.status)}</span><small title="${esc(numFix(p.now || ''))}">${esc(numFix(p.now || ''))}</small></div><div class="ln-track">${ticks.map(v => `<i class="tk" style="left:${X(v)}%"></i>`).join('')}${[...bots].reverse().map(id => `<a class="d ${id === best ? 'best' : ''}" href="${href('bots', id)}" style="left:${X(M.bots[id].rating)}%;--c:${botColor(id)}" title="${esc(`${id}: ${M.bots[id].rating}`)}"></a>`).join('')}<span class="ln-lab" style="left:${X(M.bots[best].rating)}%">${esc(best)} ${M.bots[best].rating}</span>${bots.length > 1 ? `<span class="ln-n" style="left:${X(M.bots[bots.at(-1)].rating)}%">${bots.length} bots</span>` : ''}</div><div class="ln-atlas hide-sm">${styleTag(atl(best)?.summary?.style)}${fingerprint(best)}</div></div>`; }).join('')}</section>
  ${tools.length ? `<section class="box" style="margin-top:12px"><div class="bh"><h3>Tools and studies</h3><span class="sub">lines that measure and explain</span></div><div class="stack" style="gap:6px">${tools.map(p => `<a class="brow" href="${href('research', 'lines', p.id)}"><b>${esc(p.title)}</b><span>${esc(numFix(p.now || ''))}</span></a>`).join('')}</div></section>` : ''}
  <div style="margin-top:10px">${fpKey()}</div>`;
}
/** A line's bots in the Bots table's terms: rating, nine spots, style. */
function pageLine(r) {
  const p = M.panels.find(x => x.id === r.parts[2]); if (!p) return '<div class="notice">No such research line.</div>';
  const mine = e => (e.owner && (e.owner.includes(p.title) || p.title.includes(e.owner) || e.owner === p.thread)) || (e.metrics || []).some(m => (p.bots || []).includes(BOTALIAS(String(m.label || '').split(/[\s,]+/)[0])));
  const exps = M.experiments.filter(mine);
  const bt = botTable(p.bots || []);
  return `<p><a href="${href('research', 'lines')}">← Research lines</a></p><div class="phead"><div><div class="eyebrow">${esc(S.aud === 'project' ? p.thread || '' : 'research line')} · updated ${ago(p.updatedAt)} ago</div><h1>${esc(p.title)}</h1></div></div>
  ${bt ? `<section class="box" style="margin-bottom:12px"><div class="bh"><h3>Its bots</h3><span class="sub">described the Atlas's way</span></div>${bt}</section>` : ''}
  <div class="grid"><div class="c5 stack"><section class="box">${panelBody(p)}</section>${exps.map(e => expCard(e, false)).join('')}</div><div class="c7 stack">${(p.widgets || []).map(w => `<section class="box">${widgetHtml(w)}</section>`).join('') || '<p class="muted">No charts posted.</p>'}</div></div>`;
}
/** Speed and strength: what thinking time buys. One dot per bot (family colour), log time against rating; the line
 *  joins the bots no other bot beats on both. The timing table is folded under it. */
function pageSpeed() {
  const all = Object.values(M.bots).filter(b => b.speed?.mean != null), bots = all.filter(b => b.rating != null);
  if (!bots.length) return `<div class="phead"><h1>Speed and strength</h1></div><div class="notice">No bot has both a rating and timed decisions yet.</div>`;
  const W = 900, H = 400, L = 54, R = 150, T = 14, B = 38;
  const lx0 = Math.floor(Math.log10(Math.min(...bots.map(b => b.speed.mean)))), lx1 = Math.ceil(Math.log10(Math.max(...bots.map(b => b.speed.mean))));
  const y0 = Math.floor((Math.min(...bots.map(b => b.rating)) - 30) / 100) * 100, y1 = Math.ceil((Math.max(...bots.map(b => b.rating)) + 30) / 100) * 100;
  const X = v => L + (Math.log10(v) - lx0) / (lx1 - lx0) * (W - L - R), Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const front = []; let best = -1e9; for (const b of [...bots].sort((a, b) => a.speed.mean - b.speed.mean)) if (b.rating > best) { best = b.rating; front.push(b); }
  const top = new Set([...front.map(b => b.id), ...M.order.slice(0, 5)]);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Decision time against rating">`;
  for (let e = lx0; e <= lx1; e++) s += `<line class="grid-line" x1="${X(10 ** e)}" x2="${X(10 ** e)}" y1="${T}" y2="${H - B}"/><text x="${X(10 ** e)}" y="${H - B + 15}" text-anchor="middle">${e >= 3 ? `${10 ** (e - 3)} s` : `${+(10 ** e).toPrecision(1)} ms`}</text>`;
  for (const v of niceTicks(y0, y1, 5)) s += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 3}" text-anchor="end">${v}</text>`;
  s += `<text x="${W - R}" y="${H - 4}" text-anchor="end">time per decision (log scale) →</text><text x="${L}" y="${T - 3}" style="font-size:9.5px">rating</text>`;
  s += `<path d="${front.map((b, i) => `${i ? `L${X(b.speed.mean).toFixed(1)},${Y(front[i - 1].rating).toFixed(1)}L` : 'M'}${X(b.speed.mean).toFixed(1)},${Y(b.rating).toFixed(1)}`).join('')}L${X(10 ** lx1)},${Y(front.at(-1).rating)}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  for (const b of [...bots].sort((a, c) => top.has(a.id) - top.has(c.id))) s += `<a href="${href('bots', b.id)}"><circle cx="${X(b.speed.mean)}" cy="${Y(b.rating)}" r="${top.has(b.id) ? 6 : 4.5}" fill="${botColor(b.id)}" fill-opacity="${top.has(b.id) ? 1 : .7}" stroke="${top.has(b.id) ? 'var(--ink)' : 'var(--surface)'}" stroke-width="${top.has(b.id) ? 1.2 : 1}"><title>${esc(`${b.id}: ${ms(b.speed.mean)} a decision, rating ${b.rating}${b.speed.lang || b.lang ? ` (${b.speed.lang || b.lang})` : ''}`)}</title></circle></a>`;
  const labs = [...bots].filter(b => top.has(b.id)).map(b => ({ b, x: X(b.speed.mean) + 9, y: Y(b.rating) + 3 })).sort((a, c) => a.y - c.y);
  for (let i = 1; i < labs.length; i++) for (let j = 0; j < i; j++) if (Math.abs(labs[i].x - labs[j].x) < 110 && labs[i].y - labs[j].y < 11) labs[i].y = labs[j].y + 11;
  for (const l of labs) s += `<text x="${l.x}" y="${l.y}" paint-order="stroke" stroke="var(--surface)" stroke-width="3" style="font-size:10.5px;fill:var(--ink)">${esc(l.b.id)}</text>`;
  const fams = [...new Set(bots.map(b => b.fam))];
  return `<div class="phead"><h1>Speed and strength</h1><p class="lede">What thinking time buys. Each dot is a bot in its family colour: time per decision (log scale, harness-timed, engine time excluded) against rating. The dashed line joins the bots that no other bot beats on both speed and rating; labelled: those and the top five.</p></div>
  <section class="box"><div class="chart">${s}</svg></div><div class="row" style="gap:6px 12px;margin-top:6px">${fams.map(f => famChip(f)).join('')}</div></section>
  <details class="box" style="margin-top:12px"><summary><b>Timing table</b> <span class="muted">${all.length} bots, fastest first</span></summary><div class="scroll" style="margin-top:8px"><table><thead><tr><th>Bot</th><th class="n">Rating</th><th class="hide-sm">Style</th><th>Language</th><th class="n">Mean</th><th class="n">p95</th><th class="n hide-sm">Decisions</th><th class="hide-sm">Measured by</th></tr></thead><tbody>${[...all].sort((a, b) => a.speed.mean - b.speed.mean).map(b => `<tr><td>${botLink(b.id)}</td><td class="n">${b.rating ?? '-'}</td><td class="hide-sm">${styleTag(atl(b.id)?.summary?.style)}</td><td>${langChip(b.speed.lang || b.lang)}</td><td class="n">${ms(b.speed.mean)}</td><td class="n">${ms(b.speed.p95)}</td><td class="n hide-sm">${int(b.speed.n)}</td><td class="muted hide-sm">${esc(b.speed.src || '')}</td></tr>`).join('')}</tbody></table></div></details>`;
}
/** Newest results on Home, drawn with the same evidence rows as the Experiments page. */

function botChip(id, { fp = true, rating = true } = {}) {
  const b = M.bots[id];
  return `<span class="bchip">${botLink(id)}${styleTag(atl(id)?.summary?.style)}${fp ? fingerprint(id) : ''}${rating && b?.rating != null ? `<span class="num" title="rating">${b.rating}</span>` : ''}</span>`;
}
function foLink(a, b) { return atl(a) && atl(b) ? `<a class="fo-link" href="${href('bots', 'faceoff')}?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}" title="the two bots spot by spot">Face-off</a>` : ''; }
/** A result between two bots, drawn as a small face-off: a's share of the games (face-off colour a) against b's. */
function vsRow(a, b, share, { n = null, note = '', fp = false, link = true } = {}) {
  const w = Math.max(0, Math.min(1, share)) * 100;
  return `<div class="vs-row"><span class="l">${botLink(a)}${styleTag(atl(a)?.summary?.style)}${fp ? fingerprint(a) : ''}</span><span class="split" title="${esc(`${a} won ${pct(share)}${n ? ` of ${n} games` : ''} against ${b}`)}"><i class="a" style="width:${w}%"></i><i class="b" style="width:${100 - w}%"></i><b></b><em>${pct(share)}</em></span><span class="r">${botLink(b)}${styleTag(atl(b)?.summary?.style)}${fp ? fingerprint(b) : ''}</span>${(link && foLink(a, b)) || '<span></span>'}${note ? `<span class="note">${esc(note)}</span>` : ''}</div>`;
}
/** A score against a field, the run tables' way: bar from 0 to 100% with the 50% line. */
function scoreRow(lead, v, note = '') {
  return `<div class="sc-row"><span class="l">${lead}</span><span class="sc" title="${esc(pct(v))}"><i style="width:${Math.max(0, Math.min(1, v)) * 100}%;--c:${v >= .5 ? 'var(--pos-4)' : 'var(--neg-4)'}"></i><b></b></span><em>${pct(v)}</em>${note ? `<span class="note">${esc(note)}</span>` : ''}</div>`;
}
const EV_LO = 0.10, EV_HI = 0.25;
/** An evaluator on the Evaluators page's Brier scale (0.25 = coin flip on the left, better to the right), with the
 *  bot that plays with it when there is one (h@<name>). */
function brierRow(name, v) {
  const x = Math.max(0, Math.min(100, (EV_HI - v) / (EV_HI - EV_LO) * 100)), bot = M.bots[`h@${name}`] ? `h@${name}` : null;
  return `<div class="ev-row"><span class="l mono">${esc(name)}</span><span class="ev-trk" title="Brier ${v.toFixed(4)}"><b class="coin"></b><i style="left:${x}%"></i></span><em>${v.toFixed(3)}</em><span class="r">${bot ? `${botLink(bot)}${styleTag(atl(bot)?.summary?.style)}<span class="num">${M.bots[bot].rating ?? ''}</span>` : ''}</span></div>`;
}
const brierAxis = () => `<div class="ev-row axis"><span>evaluator</span><span class="ev-ax"><span>0.25 coin flip</span><span>better →</span><span>${EV_LO.toFixed(2)}</span></span><span>Brier</span><span>the bot that plays with it</span></div>`;
/** A game's length in decision windows with the part an exact solver can see lit at the end. */
function horizonBar(windows, solved) {
  const w = Math.max(1.5, solved / windows * 100);
  return `<div class="horizon" title="${esc(`about ${Math.round(windows)} windows in a game; the solver proves the last ${solved}`)}"><div class="hz"><i style="width:${w}%"></i></div><div class="hz-l"><span>start of game</span><span>proved exactly: last ${solved} windows (${pct(solved / windows)})</span></div></div>`;
}
const BOTALIAS = id => /^random-[abc]$/.test(id) ? 'random' : id;
const isBot = t => !!M.bots[BOTALIAS(t)];
/** Sort an experiment's metrics into the shared pictures: two bots (face-off), one bot or a field (score bar),
 *  an evaluator (Brier scale), and plain numbers. */
function evidence(e, { max = 8, fp = false } = {}) {
  const vs = [], one = [], brier = [], field = [], other = [];
  for (const m of (e.metrics || []).slice(0, max)) {
    const lab = String(m.label || ''), v = +m.value, isPct = m.format === 'pct';
    const two = /^(\S+)\s+vs\s+(\S+?),?(\s|$)/.exec(lab), first = lab.split(/[\s,]+/)[0];
    if (/brier/i.test(lab) && isFinite(v)) brier.push({ name: lab.replace(/\s*brier.*$/i, ''), v });
    else if (isPct && /minus|difference/i.test(lab)) other.push({ ...m, format: null, value: `${pts(v)} pts` });
    else if (isPct && two && isBot(two[1]) && isBot(two[2])) vs.push({ a: BOTALIAS(two[1]), b: BOTALIAS(two[2]), v, n: /\((\d+) games?\)/.exec(lab)?.[1], note: lab.slice(two[0].length).replace(/^[\s,]+|\s*win rate\s*/gi, '').replace(/\(\d+ games?\)/, '').trim() });
    else if (isPct && isBot(first) && /^\S+\s+(score|win)/i.test(lab)) one.push({ id: BOTALIAS(first), v, note: lab.slice(first.length).replace(/^[\s,]+/, '') });
    else if (isPct) field.push({ label: lab, v });
    else other.push(m);
  }
  const byLab = k => (e.metrics || []).find(m => k.test(m.label || ''));
  const hz = byLab(/solve horizon/i), mpw = byLab(/moves per window/i), tree = byLab(/game-tree size/i);
  const windows = hz && mpw && tree && +mpw.value > 1 ? +tree.value / Math.log10(+mpw.value) : null;
  let h = '';
  if (vs.length) h += `<div class="ev-block">${vs.map(x => vsRow(x.a, x.b, x.v, { n: x.n, note: x.note, fp })).join('')}</div>`;
  if (one.length) h += `<div class="ev-block">${one.map(x => scoreRow(`${botLink(x.id)}${styleTag(atl(x.id)?.summary?.style)}${fp ? fingerprint(x.id) : ''}`, x.v, x.note)).join('')}</div>`;
  if (field.length) h += `<div class="ev-block">${field.map(x => scoreRow(esc(x.label), x.v)).join('')}</div>`;
  if (brier.length) h += `<div class="ev-block">${brierAxis()}${[...brier].sort((a, b) => a.v - b.v).map(x => brierRow(x.name, x.v)).join('')}</div>`;
  if (windows) h += horizonBar(windows, +hz.value);
  const rest = other.filter(m => !windows || ![hz, mpw, tree].includes(m));
  if (rest.length) h += `<div class="ev-nums">${rest.map(m => `<span><b>${esc(m.format === 'pct' ? pct(m.value) : m.value)}</b> ${esc(m.label)}</span>`).join('')}${windows ? `<span><b>≈${Math.round(windows)}</b> windows in a game (${esc(mpw.value)} moves a window, 10^${esc(tree.value)} lines)</span>` : ''}</div>`;
  else if (windows) h += `<div class="ev-nums"><span><b>≈${Math.round(windows)}</b> windows in a game (${esc(mpw.value)} moves a window, 10^${esc(tree.value)} lines)</span></div>`;
  return h;
}
/** Runs an experiment names in its text, so the card links to the run and its every-pair grid. */
function runsIn(e) {
  const t = [e.hypothesis, e.conclusion, e.title, ...(e.metrics || []).map(m => m.label)].join(' ');
  return M.runs.filter(r => r.id.length > 5 && new RegExp(`(^|[^\\w-])${r.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(t));
}
function pageExperiments() {
  const xs = [...M.experiments].sort((a, b) => (a.status === 'running') - (b.status === 'running') || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return `<div class="phead"><h1>Experiments</h1><p class="lede">Each states a hypothesis and what it found. Results between two bots are drawn as small face-offs, scores as the run tables' bars (line = 50%), evaluators on the Brier scale of the Evaluators page.</p></div><div class="xcards">${xs.map(e => expCard(e, false)).join('')}</div>`;
}
function pageExperiment(r) {
  const e = M.experiments.find(x => x.id === r.parts[2]);
  return e ? `<p><a href="${href('research', 'experiments')}">← Experiments</a></p>${expCard(e, true)}` : '<div class="notice">No such experiment.</div>';
}
const EVC = { const: 'var(--muted)', legacy: 'var(--s2)', fixed: 'var(--s3)', td: 'var(--s5)' };
/** Evaluator colours: the references (Constant, the heuristics, TD fit) keep theirs, the three best get strong
 *  colours, the rest are drawn faint so the chart says which ones matter. */
function evColors(T) {
  const best = [...T.evaluators].sort((a, b) => a.brier - b.brier).map(e => e.id).filter(id => !EVC[id]).slice(0, 3), pal = ['var(--s1)', 'var(--s4)', 'var(--s7)'];
  return id => EVC[id] || (best.includes(id) ? pal[best.indexOf(id)] : null);
}
function evCurves(T, ids, { h = 230, w = 640, labels = true } = {}) {
  const col = evColors(T), cats = T.evaluators[0]?.byLeft.map(b => `${b.lo}${b.hi ? `–${b.hi}` : '+'}`).reverse() || [];
  const es = T.evaluators.filter(e => !ids || ids.includes(e.id));
  const series = es.map(e => ({ name: SWUApp.evName(e.id), color: col(e.id) || 'var(--line-2)', width: col(e.id) ? 2 : 1.2, nolabel: !col(e.id), points: [...e.byLeft].reverse().map((b, i) => [i, b.brier]) }));
  series.sort((a, b) => (a.nolabel ? 0 : 1) - (b.nolabel ? 0 : 1));
  return lineChart(series, { xCats: cats, yFmt: v => v.toFixed(2), xLabel: 'windows left →', h, w, labels });
}
/** TD loss against being right on solver-proven endings: if TD loss judged evaluators, the dots would climb to the left. */
function tdScatter(T, { w = 460, h = 230 } = {}) {
  const E = T.evaluators.filter(e => e.tdLoss != null && e.provenAcc != null), col = evColors(T); if (E.length < 3) return '';
  const L = 46, R = 104, Tp = 10, B = 34, x1 = Math.max(...E.map(e => e.tdLoss)) * 1.08, y0 = Math.floor(Math.min(...E.map(e => e.provenAcc)) * 20) / 20 - .02, y1 = 1;
  const X = v => L + v / x1 * (w - L - R), Y = v => Tp + (1 - (v - y0) / (y1 - y0)) * (h - Tp - B);
  let s = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="TD loss against proven endings">`;
  for (const v of niceTicks(y0, y1, 4)) s += `<line class="grid-line" x1="${L}" x2="${w - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 3}" text-anchor="end">${pct(v)}</text>`;
  for (const v of niceTicks(0, x1, 4)) s += `<text x="${X(v)}" y="${h - B + 14}" text-anchor="middle">${v}</text>`;
  s += `<text x="${w - R}" y="${h - 4}" text-anchor="end">TD loss (lower looks better) →</text><text x="${L}" y="${Tp - 2}" style="font-size:9.5px">right on proven endings</text>`;
  const pts2 = E.map(e => ({ e, x: X(e.tdLoss), y: Y(e.provenAcc), c: col(e.id) })).sort((a, b) => a.y - b.y);
  for (const p of pts2) s += `<circle cx="${p.x}" cy="${p.y}" r="${p.c ? 5 : 3.5}" fill="${p.c || 'var(--line-2)'}" ${p.e === E.reduce((a, e) => e.tdLoss < a.tdLoss ? e : a) || p.e === E.reduce((a, e) => e.provenAcc > a.provenAcc ? e : a) ? 'stroke="var(--ink)" stroke-width="1.2"' : ''}><title>${esc(SWUApp.evName(p.e.id))}: TD loss ${p.e.tdLoss.toFixed(4)}, right on ${pct(p.e.provenAcc)} of proven endings</title></circle>`;
  const lowTd = E.reduce((a, e) => e.tdLoss < a.tdLoss ? e : a), mostRight = E.reduce((a, e) => e.provenAcc > a.provenAcc ? e : a);
  for (const p of pts2) if (!p.c && (p.e === lowTd || p.e === mostRight)) p.c = 'var(--ink-2)';
  let last = -99; for (const p of pts2.filter(p => p.c)) { const y = Math.max(p.y + 3, last + 11); last = y; s += `<text x="${p.x + 8}" y="${y}" style="fill:${p.c};font-size:10px">${esc(SWUApp.evName(p.e.id))}</text>`; }
  return `<div class="chart">${s}</svg></div>`;
}
/** Each family's edge in every Atlas spot against bots of its own level, with the spots a claim is about lit. */
function famSpotTable(on = []) {
  const fam = M.research.famSpots; if (!fam || !SITS().length) return '';
  const F = [['search', 'Search', 'search'], ['onePly', '1-ply', 'heuristic'], ['learned', 'Learned', 'learned']];
  let lastG = null;
  return `<table class="fst"><thead><tr><th></th>${F.map(([, l, f]) => `<th><span class="fam" style="--c:${famColor(f)}">${l}</span></th>`).join('')}</tr></thead><tbody>${SITS().map(s => {
    const g = s.group !== lastG ? `<tr class="g"><td colspan="${F.length + 1}">${esc(AT.GROUP[s.group] || s.group)}</td></tr>` : ''; lastG = s.group;
    return `${g}<tr class="${on.includes(s.id) ? 'on' : ''}"><td>${spotIcon(s.id, 'pict s')}<span>${esc(s.label)}</span></td>${F.map(([k]) => { const v = fam[s.id]?.[k]; if (!v) return '<td class="e faint">·</td>'; const c = AT.edgeColor(v.mean); return `<td class="e" style="--c:${c.bg};--fc:${c.fg}" title="${v.bots} bots">${edgeTxt(v.mean)}</td>`; }).join('')}</tr>`;
  }).join('')}</tbody></table>`;
}
/** Two bots a claim compares: their chips with style, nine spots and rating, the gap, and head to head if they met. */
function pairBox(a, b, { gapLabel = '' } = {}) {
  const A = M.bots[a], B = M.bots[b]; if (!A || !B) return '';
  const h = M.h2h[a]?.[b], d = (A.rating ?? 0) - (B.rating ?? 0);
  return `<div class="pair"><div>${botChip(a)}</div><div>${botChip(b)}</div><div class="pair-f"><span><b class="${d >= 0 ? 'good' : 'bad'}">${d >= 0 ? '+' : '−'}${Math.abs(d)}</b> rating ${esc(gapLabel)}</span>${h ? `<span>head to head ${h[0]}-${h[1]}${h[2] ? `-${h[2]}` : ''}</span>` : '<span class="faint">never met</span>'}${foLink(a, b)}</div>${h && h[0] + h[1] ? vsRow(a, b, (h[0] + (h[2] || 0) / 2) / (h[0] + h[1] + (h[2] || 0)), { n: h[0] + h[1] + (h[2] || 0), link: false }) : ''}</div>`;
}
function botTable(ids, { extra = null } = {}) {
  const rows = [...new Set(ids)].filter(id => M.bots[id]).sort((a, b) => (M.bots[b].rating ?? -1) - (M.bots[a].rating ?? -1));
  if (!rows.length) return '';
  return `<div class="scroll"><table><thead><tr><th>#</th><th>Bot</th><th class="n">Rating</th><th>Nine spots</th><th class="hide-sm">Style</th><th class="n">Games</th><th class="n">Win %</th><th class="n hide-sm">Speed</th></tr></thead><tbody>${rows.map(id => { const b = M.bots[id]; return `<tr class="click" data-href="${href('bots', id)}"><td class="rank">${b.rank ?? ''}</td><td>${botLink(id)}</td><td class="n"><b>${b.rating ?? '-'}</b></td><td>${fingerprint(id, 'md')}</td><td class="hide-sm">${styleTag(atl(id)?.summary?.style)}</td><td class="n">${b.games}</td><td class="n">${pct(b.winRate)}</td><td class="n hide-sm">${ms(b.speed?.mean)}</td></tr>`; }).join('')}</tbody></table></div>`;
}
/** How the builder arena works, drawn from the real roster: builders on the left write their bots, the bots on one ring
 *  all play each other (baselines too), and each round's results go back to the builders. */
function arenaDiagram({ compact = false } = {}) {
  const A = M.arena, st = A.standings, all = A.competitors, cs = all.slice(0, compact ? 6 : 8), base = A.baselines || [];
  if (!cs.length) return '';
  const W = compact ? 440 : 720, cardW = compact ? 150 : 250, cardH = compact ? 24 : 36, gap = compact ? 6 : 8, top = 22;
  const H = Math.max(top + cs.length * (cardH + gap) + (compact ? 44 : 54), compact ? 236 : 306);
  const r = compact ? 62 : 100, cx = W - r - (compact ? 64 : 110), cy = top + (H - top - (compact ? 44 : 54)) / 2;
  const id = compact ? 'adc' : 'adf', sys = c => !c.harness ? 'no builder' : c.harness.kind === 'script' ? 'script, no LLM' : [capw(c.harness?.model), c.harness?.effort && `${c.harness.effort} effort`, c.harness?.memory && `memory: ${c.harness.memory}`].filter(Boolean).join(' · ');
  const nodes = [];
  cs.forEach((c, i) => { const th = (cs.length === 1 ? 180 : 235 - i * 110 / (cs.length - 1)) * Math.PI / 180; nodes.push({ kind: 'b', c, name: c.latest || c.name, x: cx + r * Math.cos(th), y: cy + r * Math.sin(th) }); });
  base.forEach((b, i) => { const th = (base.length === 1 ? 0 : -35 + i * 70 / (base.length - 1)) * Math.PI / 180; nodes.push({ kind: 'base', name: b, x: cx + r * Math.cos(th), y: cy + r * Math.sin(th) }); });
  let s = `<svg viewBox="0 0 ${W} ${H}" class="adiag" role="img" aria-label="How the builder arena works"><defs><marker id="${id}-i" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L8,4L0,8z" fill="var(--ink-2)"/></marker><marker id="${id}-a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L8,4L0,8z" fill="var(--accent)"/></marker></defs>`;
  s += `<text x="4" y="12" class="ad-h">${compact ? 'builders' : 'builders: a model in a harness, or a script'}</text><text x="${cx}" y="12" text-anchor="middle" class="ad-h">${compact ? 'their bots play each other' : 'their bots: every bot plays every other each round'}</text>`;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) s += `<line x1="${nodes[i].x.toFixed(1)}" y1="${nodes[i].y.toFixed(1)}" x2="${nodes[j].x.toFixed(1)}" y2="${nodes[j].y.toFixed(1)}" class="ad-e"/>`;
  cs.forEach((c, i) => {
    const y = top + i * (cardH + gap), n = nodes[i], col = famColor(c.harness?.kind === 'script' ? 'search' : 'llm'), rt = st?.global?.[c.latest];
    s += `<a href="${href('arena', 'builders', c.name)}"><rect x="2" y="${y}" width="${cardW}" height="${cardH}" rx="5" class="ad-card" style="--c:${col}"/><rect x="2" y="${y}" width="4" height="${cardH}" rx="2" fill="${col}"/>`;
    s += `<text x="12" y="${y + (compact ? 16 : 15)}" class="ad-n">${esc(c.name)}</text>${compact ? '' : `<text x="12" y="${y + 29}" class="ad-s">${esc(sys(c))}</text>`}${rt != null || !compact ? `<text x="${cardW - 6}" y="${y + (compact ? 16 : 15)}" text-anchor="end" class="ad-s">${rt != null ? rt : 'not rated yet'}</text>` : ''}</a>`;
    const x1 = cardW + 4, y1 = y + cardH / 2, mx = (x1 + n.x) / 2;
    s += `<path d="M${x1},${y1} C${mx},${y1} ${mx},${n.y.toFixed(1)} ${(n.x - (compact ? 13 : 16)).toFixed(1)},${n.y.toFixed(1)}" class="ad-w" marker-end="url(#${id}-i)"/>`;
  });
  if (all.length > cs.length) s += `<text x="12" y="${top + cs.length * (cardH + gap) + 10}" class="ad-s">and ${all.length - cs.length} more builders</text>`;
  for (const n of nodes) {
    const col = n.kind === 'b' ? famColor(n.c.harness?.kind === 'script' ? 'search' : 'llm') : botColor(n.name), lab = n.kind === 'b' ? n.name.replace(`${n.c.name}-`, '') : n.name;
    s += `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${compact ? 10 : 13}" fill="${col}" class="${n.kind === 'base' ? 'ad-base' : ''}"><title>${esc(n.kind === 'b' ? `${n.name}: ${n.c.name}'s bot` : `${n.name}: baseline, a fixed bot with no builder`)}</title></circle>`;
    if (n.kind === 'b') s += `<text x="${n.x.toFixed(1)}" y="${(n.y + 3.5).toFixed(1)}" text-anchor="middle" class="ad-v">${esc(lab.length > 4 ? lab.slice(0, 4) : lab)}</text>`;
    else s += `<text x="${(n.x + (compact ? 14 : 18)).toFixed(1)}" y="${(n.y + 4).toFixed(1)}" class="ad-s">${esc(lab)}${compact ? '' : ' (baseline)'}</text>`;
  }
  const fy = H - (compact ? 22 : 26), lastY = top + cs.length * (cardH + gap) - gap;
  s += `<path d="M${cx},${(cy + r + (compact ? 12 : 16)).toFixed(1)} C${cx},${fy} ${cx - 30},${fy} ${cx - 40},${fy} L${cardW / 2 + 20},${fy} C${cardW / 2},${fy} ${cardW / 2},${fy} ${cardW / 2},${lastY + 8}" class="ad-f" marker-end="url(#${id}-a)"/>`;
  s += `<text x="${(cardW / 2 + cx) / 2}" y="${fy + 15}" text-anchor="middle" class="ad-fl">${compact ? 'results go back; builders improve their bots' : 'after each round: the report and every lost game go back; each builder improves its bot'}</text>`;
  return `<div class="adwrap${compact ? ' compact' : ''}">${s}</svg></div>`;
}
// ---------- pages: lab (project only) ----------
const TCOL = [['working', 'Working'], ['blocked', 'Blocked'], ['review_ready', 'Review ready'], ['completed', 'Done']];
function pageLab() {
  const T = M.threads;
  return `<div class="phead"><h1>Work threads</h1><p class="lede">Every thread in the project and what it is doing. From dashboard/threads.json (written by the console); the live version reads each thread's checklist through the Claude Code Remote connector.</p></div><div class="kanban">${TCOL.map(([k, l]) => `<div class="col"><div class="eyebrow">${l} · ${T.filter(t => t.status === k).length}</div>${T.filter(t => t.status === k).map(t => `<div class="tcard"><b>${esc(t.title)}</b><span class="muted">${esc(t.note || '')}</span><span class="mono faint" style="font-size:var(--fs-xs)">active ${ago(t.lastActivity)} ago</span></div>`).join('')}</div>`).join('')}</div>`;
}
function pageWaiting() {
  const w = M.threads.filter(t => t.status === 'blocked' || t.status === 'review_ready');
  return `<div class="phead"><h1>Waiting on Eric</h1><p class="lede">Threads that are blocked or ready for review. Each decision page a thread publishes would be listed here too.</p></div><div class="board-list">${w.map(t => `<div class="tcard"><div class="row"><span class="pill ${esc(t.status)}">${esc(t.status.replace('_', ' '))}</span><b>${esc(t.title)}</b></div><span class="muted">${esc(t.note || '')}</span></div>`).join('') || '<div class="notice">Nothing is waiting.</div>'}</div>`;
}
function pageHealth() {
  const own = Object.values(M.bots).filter(b => b.ratingFrom === 'app').sort((a, b) => b.games - a.games);
  const unmapped = Object.values(M.bots).filter(b => b.games >= 8 && !b.atlas?.mapped).sort((a, b) => (b.rating || 0) - (a.rating || 0));
  const noCard = Object.values(M.bots).filter(b => b.games >= 20 && !b.card);
  const stale = M.panels.filter(p => p.status === 'running' && NOW() - Date.parse(p.updatedAt) > 6 * 3600e3);
  const errs = M.runs.filter(r => r.errors);
  return `<div class="phead"><h1>Data health</h1><p class="lede">What the app found while reading the shared folder. Each item names the file and the owner to ask.</p></div>
  <div class="grid"><section class="c6 box"><div class="bh"><h3>Bots with no spot map</h3><span class="sub">${unmapped.length} bots with 8+ games</span></div><p class="muted" style="font-size:var(--fs-md);margin-bottom:6px">The Atlas maps spots from replays. These bots' runs kept fewer than 5 replays, so their pages show an empty strip. Fix: keep replays in their next ladder (owner: each bot's thread).</p><div class="row" style="gap:6px">${unmapped.map(b => `${botLink(b.id)}<span class="faint" style="font-size:var(--fs-sm)">${b.atlas?.replayGames ?? 0}</span>`).join(' ')}</div>
    <div class="bh" style="margin-top:14px"><h3>Rated by the app, not the Atlas</h3><span class="sub">${own.length}</span></div><p class="muted" style="font-size:var(--fs-md);margin-bottom:6px">${M.ratings?.from === 'app' ? 'meta/ratings.json was not found, so every rating is the app\'s own fit (same rules). Owner: Strategy meta analyzer.' : `Ratings come from meta/ratings.json (meta analyzer, ${M.ratings?.generatedAt ? `${ago(M.ratings.generatedAt)} ago` : 'no time'}). These bots are not in it yet (games newer than its hourly refresh, or runs it skips), so the app fits them with the same rules.`}</p>${own.length ? own.slice(0, 16).map(b => `${botLink(b.id)}<span class="faint" style="font-size:var(--fs-sm)">${b.games}</span>`).join(' ') : '<p class="muted">None.</p>'}</section>
  <section class="c6 box"><div class="bh"><h3>Bots with 20+ games and no card</h3></div>${noCard.length ? noCard.map(b => botLink(b.id)).join(' ') : '<p class="muted">None.</p>'}<div class="bh" style="margin-top:14px"><h3>Research lines silent for 6 h but marked running</h3></div>${stale.map(p => `<p style="font-size:var(--fs-md)">${esc(p.title)} <span class="muted">${ago(p.updatedAt)}</span></p>`).join('') || '<p class="muted">None.</p>'}<div class="bh" style="margin-top:14px"><h3>Runs with unrated games</h3></div>${errs.map(r => `<p style="font-size:var(--fs-md)"><a href="${href('runs', r.id)}" class="mono">${esc(r.id)}</a> ${r.errors}</p>`).join('') || '<p class="muted">None.</p>'}${M.warnings.length ? `<div class="bh" style="margin-top:14px"><h3>Files that did not parse</h3></div>${M.warnings.map(w => `<p class="mono" style="font-size:var(--fs-sm)">${esc(w)}</p>`).join('')}` : ''}</section></div>`;
}

function betBox() {
  if (!ATL()) return '';
  return `<section class="box"><div class="bh"><h3>Who to bet on in each spot</h3><span class="sub">★ = the bot that wins the most points of win chance above an average bot from there (8+ games)</span><a class="more" href="${href('bots')}">All bots by spot</a></div>${betTiles({ mini: true })}<p class="verdict" style="margin-top:10px">${verdictLine()}</p><div style="margin-top:8px">${standoutsLine()}</div></section>`;
}
function compVersion(c) { return [...c.versions].reverse().map(v => v.name).find(n => atl(n)) || c.latest; }
function winsBox(id, title = 'Where it wins') {
  const a = atl(id), A = ATL();
  const head = `<div class="bh"><h3>${esc(title)}</h3><span class="sub">points of win chance above an average bot in the same spot (Strategy Atlas)</span><a class="more" href="${href('bots', 'faceoff')}?a=${encodeURIComponent(id)}">Face-off</a></div>`;
  if (!A) return '';
  if (!a || !(a.games >= AT.MIN_GAMES && a.replayGames >= 5)) return `<section class="box">${head}<div style="margin-bottom:8px">${fingerprint(id, 'md')}</div><p class="muted">No spot map yet. The Atlas maps a bot once it has 8+ rated games and 5+ of them with replays${a ? ` (this bot has ${a.games} games, ${a.replayGames || 0} with replays)` : ''}. Runs that keep replays fill it in on the next hourly refresh.</p></section>`;
  const best = a.summary?.best?.id, worst = a.summary?.worst?.id;
  let rows = '', lastG = null;
  for (const s of SITS()) {
    if (s.group !== lastG) { rows += `<div class="grp">${esc(AT.GROUP[s.group] || s.group)}${a.summary?.groups?.[s.group] ? ` <span style="text-transform:none;letter-spacing:0">· ${edgeTxt(a.summary.groups[s.group].edge)} pts over ${a.summary.groups[s.group].n} games</span>` : ''}</div>`; lastG = s.group; }
    const c = a.situations?.[s.id];
    const rank = (A.ranks[s.id] || []).indexOf(id), nR = (A.ranks[s.id] || []).length;
    const P = e => 50 + 50 * Math.max(-1, Math.min(1, e / 0.4));
    const bar = c?.n ? `<span class="trk"><i class="z"></i><i class="b" style="left:${Math.min(50, P(c.edge))}%;width:${Math.abs(P(c.edge) - 50)}%;--c:${Math.abs(c.edge) < 0.03 ? 'var(--line-2)' : c.edge > 0 ? 'var(--pos-4)' : 'var(--neg-4)'};${c.n < 5 ? 'opacity:.45' : ''}"></i></span>` : '<span class="trk"><i class="z"></i></span>';
    const mk = A.best[s.id] === id ? '<span class="mk star">★ best of all bots</span>' : s.id === best ? '<span class="mk up">▲ its best spot</span>' : s.id === worst ? '<span class="mk down">▼ its worst spot</span>' : '';
    rows += `<div class="row2">${spotIcon(s.id)}<div class="lab">${esc(s.label)}<small>${esc(s.short)}</small></div>${bar}<span class="v ${c?.n ? (c.edge >= 0 ? 'good' : 'bad') : 'faint'}">${c?.n ? edgeTxt(c.edge) : '-'}</span><span class="meta">${c?.n ? `won ${c.wins} of ${c.n}${rank >= 0 ? ` · #${rank + 1} of ${nR}` : ''}` : 'no games'} ${mk}</span></div>`;
  }
  return `<section class="box">${head}<div class="wins">${rows}</div><p class="muted" style="font-size:var(--fs-sm);margin-top:8px">Faded bars: fewer than 5 games in that spot. Rank counts bots with 8+ games there.</p></section>`;
}
function styleBars(id) {
  const a = atl(id), keys = ['baseShare', 'baseDmg', 'kills', 'rounds'];
  if (!a?.style || a.style.baseShare == null) return '';
  const meta = Object.fromEntries((ATL()?.style || []).map(s => [s.id, s]));
  const lab = { baseShare: 'Attacks aimed at the base', baseDmg: 'Base damage per round', kills: 'Enemy units removed per round', rounds: 'Rounds per game' };
  return `<div class="stylebars" style="margin-top:12px">${keys.map(k => { const v = a.style[k], m = meta[k]?.range; if (v == null) return ''; const hi = Math.max(m?.max || v, v) * 1.05; return `<span>${lab[k]}</span><span class="trk" title="the line is the average bot"><i style="width:${v / hi * 100}%;--c:${botColor(id)}"></i>${m ? `<b style="left:${m.mean / hi * 100}%"></b>` : ''}</span><span class="v">${k === 'baseShare' ? pct(v) : v.toFixed(k === 'kills' ? 2 : 1)}</span>`; }).join('')}</div>`;
}
function pageFaceoff(r) {
  const A = ATL(); if (!A) return '<div class="notice">No Atlas data yet (meta/meta.json).</div>';
  const ids = A.mapped.map(b => b.id);
  let a = r.qs.get('a') || pref.get('foA', ids[0]), b = r.qs.get('b') || pref.get('foB', null);
  if (!atl(a)) a = ids[0];
  if (!atl(b) || b === a) b = ids.find(x => x !== a);
  pref.set('foA', a); pref.set('foB', b);
  const BA = atl(a), BB = atl(b), list = [...new Set([a, b, ...ids])];
  const opts = sel => list.map(id => `<option value="${esc(id)}" ${id === sel ? 'selected' : ''}>${esc(id)}${M.bots[id]?.rating ? ` · ${M.bots[id].rating}` : ''}</option>`).join('');
  let aw = 0, bw = 0, rows = '', lastG = null;
  const span = 0.45, P = e => 4 + 92 * (0.5 + 0.5 * Math.max(-1, Math.min(1, e / span))), has = c => c && c.n > 0;
  for (const s of SITS()) {
    if (s.group !== lastG) { rows += `<div class="fo-grp">${esc(AT.GROUP[s.group] || s.group)}</div>`; lastG = s.group; }
    const ca = BA.situations?.[s.id], cb = BB.situations?.[s.id];
    let win = '<span class="fo-win faint"><span class="nm">not enough games</span><span class="sm" title="not enough games">–</span></span>', tr = '<i class="rail"></i><i class="zero"></i>';
    if (has(ca) && has(cb)) {
      const d = ca.edge - cb.edge;
      if (Math.abs(d) < 0.03) win = '<span class="fo-win muted"><span class="nm">about even</span><span class="sm" title="about even">=</span></span>';
      else if (d > 0) { aw++; win = `<span class="fo-win" style="color:var(--fa)"><span class="nm">${esc(a)} </span>+${Math.round(d * 100)}</span>`; }
      else { bw++; win = `<span class="fo-win" style="color:var(--fb)"><span class="nm">${esc(b)} </span>+${Math.round(-d * 100)}</span>`; }
      const pa = P(ca.edge), pb = P(cb.edge);
      tr += `<i class="gap" style="left:${Math.min(pa, pb)}%;width:${Math.abs(pa - pb)}%;background:${ca.edge >= cb.edge ? 'var(--fa)' : 'var(--fb)'}"></i>`;
    }
    const dot = (c, col, who) => has(c) ? `<i class="dot" style="left:${P(c.edge)}%;border-color:${col};background:${c.n < 5 ? 'var(--surface)' : col}" title="${esc(who)}: ${edgeTxt(c.edge)} pts · won ${c.wins} of ${c.n}"></i>` : '';
    tr += dot(cb, 'var(--fb)', b) + dot(ca, 'var(--fa)', a);
    rows += `<div class="fo-row">${spotIcon(s.id)}<div class="fo-lab">${esc(s.label)}${A.best[s.id] === a || A.best[s.id] === b ? ` <span class="mk star" title="best of all bots here: ${esc(A.best[s.id])}">★</span>` : ''}<small>${esc(s.short)}</small></div><div class="fo-track">${tr}</div>${win}</div>`;
  }
  rows += `<div class="fo-row"><span></span><span class="fo-lab"></span><div style="display:grid;grid-template-columns:1fr auto 1fr;font-size:var(--fs-xs);color:var(--muted)"><span>← worse than an average bot</span><span>average</span><span style="text-align:right">better →</span></div><span></span></div>`;
  const h = M.h2h[a]?.[b];
  const sts = [['baseShare', 'Attacks aimed at the base', pct], ['baseDmg', 'Base damage per round', v => v.toFixed(1)], ['kills', 'Enemy units removed per round', v => v.toFixed(2)], ['rounds', 'Rounds per game', v => v.toFixed(1)]];
  const style = sts.map(([k, label, f]) => { const va = BA.style?.[k] || 0, vb = BB.style?.[k] || 0, mx = Math.max(va, vb, 1e-9); return `<div class="fo-st"><h4>${label}</h4><div class="bb"><i style="width:${100 * va / mx}%;background:var(--fa)"></i><em>${f(va)}</em></div><div class="bb"><i style="width:${100 * vb / mx}%;background:var(--fb)"></i><em>${f(vb)}</em></div></div>`; }).join('');
  return `<div class="phead"><h1>Face-off</h1><p class="lede">Pick two bots. Each row is one Atlas spot; the dots show how much better than an average bot each one does there.</p></div>
  <section class="box"><div class="fo-head"><select class="a" data-input="fo" data-k="a" aria-label="First bot">${opts(a)}</select><span class="eyebrow">vs</span><select class="b" data-input="fo" data-k="b" aria-label="Second bot">${opts(b)}</select><button type="button" class="searchbtn" data-act="foSwap">Swap</button></div>
    <div class="fo-sum"><span class="a">${esc(a)}</span> is better in ${aw} spot${aw === 1 ? '' : 's'}, <span class="b">${esc(b)}</span> in ${bw}</div>
    <div class="row" style="gap:6px 14px;font-size:var(--fs-md);color:var(--ink-2);margin-top:4px">${styleTag(BA.summary?.style)} vs ${styleTag(BB.summary?.style)} · rating ${M.bots[a]?.rating ?? BA.rating} vs ${M.bots[b]?.rating ?? BB.rating} · ${h ? `head to head ${h[0]}-${h[1]}${h[2] ? `-${h[2]}` : ''}` : 'they have not played each other'} · <a href="${href('bots', a)}">${esc(a)}</a> · <a href="${href('bots', b)}">${esc(b)}</a></div>
    <div class="fo-key"><span><i style="border-color:var(--fa);background:var(--fa)"></i>${esc(a)}</span><span><i style="border-color:var(--fb);background:var(--fb)"></i>${esc(b)}</span><span><i style="border-color:var(--muted)"></i>hollow dot = fewer than 5 games in that spot</span><span class="mk star">★</span> best of all bots in that spot</div>
    <div class="fo-grid">${rows}</div>
    <div class="fo-styles">${style}</div></section>`;
}
/** The Atlas now lives in Bots (Eric, 18:18: the kit belongs in the all-bots view); old links land there. */
function atlasMoved(r) { const sp = r.qs.get('spot'); setTimeout(() => location.replace(`${href('bots')}${sp ? `?spot=${encodeURIComponent(sp)}` : ''}`)); return '<p class="muted">The Strategy Atlas moved to Bots…</p>'; }
function startGuide() {
  for (const el of document.querySelectorAll('.gpick')) el.addEventListener('click', () => { GUIDE.i = Object.keys(AT.SPOTS).indexOf(el.dataset.spot); GUIDE.t0 = performance.now(); GUIDE.auto = false; $('guide-play').textContent = 'Play all'; });
  $('guide-play').addEventListener('click', () => { GUIDE.auto = !GUIDE.auto; $('guide-play').textContent = GUIDE.auto ? 'Pause' : 'Play all'; GUIDE.t0 = performance.now(); });
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { GUIDE.auto = false; $('guide-play').hidden = true; guideAt(Object.keys(AT.SPOTS)[GUIDE.i], 1, 0); return; }
  if (!GUIDE.raf) { if (!GUIDE.t0) GUIDE.t0 = performance.now(); GUIDE.raf = requestAnimationFrame(guideFrame); }
}
function guideAt(id, k, glow) {
  const svg = $('guide-svg'); if (!svg) return false;
  const s = sit(id), S2 = AT.SPOTS[id], A = ATL();
  svg.innerHTML = AT.drawBoard(id, k, { glow });
  if ($('guide-title').dataset.id !== id) {
    $('guide-title').dataset.id = id; $('guide-title').textContent = s.label; $('guide-grp').textContent = AT.GROUP[s.group] || s.group;
    $('guide-say').textContent = S2.say; $('guide-rule').textContent = `counts when, at the start of a round: ${s.short} · this side wins ${pct(s.field?.rate)} of the time`;
    $('guide-bet').innerHTML = AT.rankIn(A, id).slice(0, 3).map((b, i) => `<div class="row" style="gap:8px;font-size:var(--fs-base)"><span class="mk ${i ? '' : 'star'}">${i ? i + 1 : '★'}</span>${botLink(b.id)}<span class="mono good">${edgeTxt(b.situations[id].edge)} pts</span><span class="muted" style="font-size:var(--fs-sm)">won ${b.situations[id].wins} of ${b.situations[id].n}</span></div>`).join('') || '<span class="muted">No bot has 8+ games here yet.</span>';
    for (const el of document.querySelectorAll('.gpick')) el.classList.toggle('on', el.dataset.spot === id);
  }
  return true;
}
function guideFrame(now) {
  const ids = Object.keys(AT.SPOTS), MS = { hold0: 700, tween: 1900, hold1: 2400 }, total = MS.hold0 + MS.tween + MS.hold1;
  let t = now - GUIDE.t0;
  if (t > total) { if (GUIDE.auto) { GUIDE.i = (GUIDE.i + 1) % ids.length; GUIDE.t0 = now; t = 0; } else t = total; }
  const k = t < MS.hold0 ? 0 : t < MS.hold0 + MS.tween ? AT.ease((t - MS.hold0) / MS.tween) : 1;
  const glow = k === 1 ? 0.5 + 0.5 * Math.sin((t - MS.hold0 - MS.tween) / 160) : 0;
  if (!guideAt(ids[GUIDE.i], k, glow)) { GUIDE.raf = 0; return; }
  GUIDE.raf = requestAnimationFrame(guideFrame);
}
// ---------- search ----------
let SEARCH = [];
function buildSearch() {
  SEARCH = [];
  for (const s of SECTIONS) { if (s.lab && S.aud === 'public') continue; SEARCH.push({ k: 'page', t: s.label, h: s.id ? href(s.id) : '#/' }); for (const [k, l] of s.sub || []) if (k) SEARCH.push({ k: 'page', t: `${s.label}: ${l}`, h: href(s.id, k) }); }
  for (const s of SITS()) SEARCH.push({ k: 'spot', t: s.label, h: `${href('bots')}?spot=${s.id}`, x: s.short });
  for (const id of Object.keys(M.bots)) SEARCH.push({ k: 'bot', t: id, h: href('bots', id), x: M.bots[id].rating ?? '', c: botColor(id) });
  for (const c of M.arena.competitors) SEARCH.push({ k: 'builder', t: c.name, h: href('arena', 'builders', c.name), x: c.title });
  for (const r of M.runs) SEARCH.push({ k: 'run', t: r.id, h: href('runs', r.id), x: `${r.n} games` });
  for (const p of M.panels.filter(p => !/^arena-/.test(p.id))) SEARCH.push({ k: 'line', t: p.title, h: href('research', 'lines', p.id) });
  for (const e of M.experiments) SEARCH.push({ k: 'experiment', t: e.title, h: href('research', 'experiments', e.id) });
}
let palSel = 0;
function palRender() {
  const q = $('palq').value.trim().toLowerCase();
  let hits = q ? SEARCH.filter(s => s.t.toLowerCase().includes(q)).sort((a, b) => a.t.toLowerCase().indexOf(q) - b.t.toLowerCase().indexOf(q) || a.t.length - b.t.length) : SEARCH.filter(s => s.k === 'page');
  if (q.length >= 3) { let n = 0; for (let i = M.games.length - 1; i >= 0 && n < 8; i--) { const g = M.games[i]; if (String(g[1]).toLowerCase().includes(q) && hasReplay(i)) { hits.push({ k: 'game', t: g[1], h: href('games', M.runs[g[0]].id, g[1]), x: M.runs[g[0]].id }); n++; } } }
  hits = hits.slice(0, 30); palSel = Math.min(palSel, hits.length - 1);
  $('pallist').innerHTML = hits.map((s, i) => `<li><a href="${s.h}" role="option" aria-selected="${i === palSel}"><span class="k">${s.k}</span><span>${s.c ? `<span class="bot" style="--c:${s.c}"><i></i><span>${esc(s.t)}</span></span>` : esc(s.t)}</span><span class="muted mono" style="font-size:var(--fs-sm)">${esc(s.x ?? '')}</span></a></li>`).join('') || '<li class="muted" style="padding:10px">Nothing found.</li>';
}
function openPal() { $('palq').value = ''; palSel = 0; palRender(); $('pal').showModal(); $('palq').focus(); }
$('searchbtn').addEventListener('click', openPal);
$('palq').addEventListener('input', () => { palSel = 0; palRender(); });
$('palq').addEventListener('keydown', e => {
  const items = [...$('pallist').querySelectorAll('a')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); palSel = (palSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length); items.forEach((a, i) => a.setAttribute('aria-selected', i === palSel)); items[palSel]?.scrollIntoView({ block: 'nearest' }); }
  if (e.key === 'Enter' && items[palSel]) { location.hash = items[palSel].getAttribute('href'); $('pal').close(); }
});
$('pallist').addEventListener('click', e => { if (e.target.closest('a')) $('pal').close(); });
document.addEventListener('keydown', e => { if (e.key === '/' && !e.target.closest('input,select,textarea') && !$('pal').open) { e.preventDefault(); openPal(); } });

// ---------- theme: system, light, dark (remembered per viewer) ----------
const THEMES = [['system', '<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/>', 'Theme: follows the system'],
  ['light', '<circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3"/>', 'Theme: light'],
  ['dark', '<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z"/>', 'Theme: dark']];
function setTheme(t) {
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const [, icon, label] = THEMES.find(x => x[0] === t) || THEMES[0];
  $('themebtn').innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">${icon}</svg>`; $('themebtn').title = label; $('themebtn').setAttribute('aria-label', label);
  pref.set('theme', t); buildColors();
}
$('themebtn').addEventListener('click', () => { const cur = document.documentElement.dataset.theme || 'system'; setTheme(THEMES[(THEMES.findIndex(x => x[0] === cur) + 1) % THEMES.length][0]); render(true); });
setTheme(pref.get('theme', 'system'));
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { buildColors(); render(true); });

// ---------- boot ----------
indexGames(); buildColors(); buildSearch(); setChip();
window.addEventListener('hashchange', () => render(false));
render(false);
if (window.claude?.use) setTimeout(() => startLive(false), 400);
else if (HOSTED) startApi();
if (HOSTED) {
  const b = $('sharebtn'); b.hidden = false; b.innerHTML = SHARE_ICON;
  b.addEventListener('click', () => { const r = route(); if (r.parts[0] !== 'share') location.hash = `#/share?from=${encodeURIComponent(location.hash || '#/')}`; });
}
