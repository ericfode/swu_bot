'use strict';
/*
 * Render an analysis file as one self-contained interactive HTML page.
 *
 *   node analysis/report.js <analysis.json> [--baseline other-analysis.json] [--game game.jsonl] [--out report.html] [--fragment]
 *
 * --baseline overlays a second evaluator's objective curve (e.g. the heuristic) for comparison.
 * --game defaults to the replay path stored in the analysis; it adds the board at each checkpoint.
 * --fragment omits <!doctype>/<html>/<head>/<body> (for publishing as a claude.ai Artifact).
 * --kit swu-viewer-kit.js inlines the shared game viewer (Holotable kit) with the replay, synced to the curves;
 *   without it the page shows a compact board summary per checkpoint instead.
 */

const fs = require('fs');
const path = require('path');
const { loadGame, checkpoints } = require('./lib/game');
const { gameFitness } = require('./fitness');
const { toDashboard } = require('./analyze');

function opt(argv, k, d) {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
}

function boardSummaries(game, a) {
    const cps = checkpoints(game, { granularity: a.settings.granularity });
    const byStep = new Map(cps.map((c) => [c.step, c.stepIndex]));
    const side = (p) => ({
        base: [p.base.n, p.base.hp - p.base.d, p.base.hp],
        res: p.res.total,
        hand: p.hand.map((c) => c.n),
        deck: p.deck,
        leader: p.leader ? [p.leader.n.split(',')[0], p.leader.dep] : null,
        units: [...p.ground.map((u) => ['g', u.n, u.p, u.h - u.d, u.x ? 1 : 0]), ...p.space.map((u) => ['s', u.n, u.p, u.h - u.d, u.x ? 1 : 0])]
    });
    return a.checkpoints.map((c) => {
        const k = byStep.get(c.step) ?? game.steps.findIndex((s) => s.n === c.step);
        const st = game.steps[k]?.state;
        return st ? { p1: side(st.players.p1), p2: side(st.players.p2), init: st.initiative } : null;
    });
}

function build(a, { baseline = null, boards = null, jsonl = null }) {
    const fit = gameFitness(a, { view: 'objective' });
    const data = {
        game: a.game,
        evaluator: a.evaluator,
        settings: a.settings,
        usage: a.usage,
        omniscient: a.omniscient,
        fitness: { seats: fit.seats, views: fit.views, gaps: fit.gaps },
        cps: a.checkpoints.map((c) => ({ i: c.i, step: c.step, round: c.round, phase: c.phase, actor: c.actor, actions: c.actions, v: c.views })),
        baseline: baseline ? { model: baseline.evaluator.model, byStep: Object.fromEntries(baseline.checkpoints.map((c) => [c.step, c.views.objective?.p1 ?? null])) } : null,
        boards,
        jsonl,
        evals: jsonl ? toDashboard(a) : null
    };
    return { data, title: `${a.game.players.map((p) => p.bot).join(' vs ')}` };
}

const CSS = String.raw`
/* Layout: one column reading down a match report; summary strip, the win-probability chart, the gap chart, then the checkpoint inspector beside the turning points. */
:root {
  --bg: #eef0f3; --surface: #fdfdfc; --ink: #11141a; --ink-2: #4b515d; --muted: #80858f;
  --grid: #e2e4e9; --axis: #c4c7cf; --ring: rgba(17,20,26,.10);
  --s-p1: #2a78d6; --s-p2: #eb6834; --s-obj: #11141a; --s-omni: #1baf7a; --s-base: #9aa0aa;
  --good: #0a7d0a; --bad: #c43c3c; --band: rgba(17,20,26,.035);
  --f-display: "Chakra Petch", "Segoe UI", system-ui, sans-serif;
  --f-body: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --f-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0d0f13; --surface: #161920; --ink: #eceef2; --ink-2: #b6bbc6; --muted: #858a94;
  --grid: #262a32; --axis: #363b45; --ring: rgba(255,255,255,.10);
  --s-p1: #3987e5; --s-p2: #d95926; --s-obj: #eceef2; --s-omni: #199e70; --s-base: #6b717c;
  --good: #2fb62f; --bad: #e46a6a; --band: rgba(255,255,255,.03); color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #0d0f13; --surface: #161920; --ink: #eceef2; --ink-2: #b6bbc6; --muted: #858a94;
  --grid: #262a32; --axis: #363b45; --ring: rgba(255,255,255,.10);
  --s-p1: #3987e5; --s-p2: #d95926; --s-obj: #eceef2; --s-omni: #199e70; --s-base: #6b717c;
  --good: #2fb62f; --bad: #e46a6a; --band: rgba(255,255,255,.03); color-scheme: dark; }
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--ink); font-family: var(--f-body); font-size: 15px; line-height: 1.5; margin: 0; }
.wrap { max-width: 1180px; margin: 0 auto; padding-inline: 20px; padding-block: 28px 56px; display: grid; gap: 20px; }
header { display: grid; gap: 6px; }
.eyebrow { font-family: var(--f-mono); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
h1 { font-family: var(--f-display); font-weight: 600; font-size: clamp(24px, 3.4vw, 34px); line-height: 1.15; margin: 0; text-wrap: balance; letter-spacing: .01em; }
h2 { font-family: var(--f-display); font-weight: 600; font-size: 17px; margin: 0; letter-spacing: .02em; }
.sub { color: var(--ink-2); max-width: 75ch; }
.vs { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: baseline; color: var(--ink-2); font-size: 14px; }
.seat { display: inline-flex; align-items: center; gap: 8px; }
.key { width: 18px; height: 3px; border-radius: 2px; display: inline-block; flex: none; }
.win { font-family: var(--f-mono); font-size: 12px; padding: 2px 7px; border-radius: 4px; border: 1px solid var(--ring); color: var(--ink); }
.panel > *, .cols > * { min-width: 0; }
.panel { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 18px 18px 14px; min-width: 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 12px 14px; display: grid; gap: 2px; }
.tile .l { font-size: 12.5px; color: var(--ink-2); }
.tile .v { font-family: var(--f-display); font-size: 26px; font-weight: 600; }
.tile .d { font-size: 12px; color: var(--muted); }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--ink-2); margin: 8px 0 4px; }
.legend button { all: unset; cursor: pointer; display: inline-flex; gap: 7px; align-items: center; padding: 2px 4px; border-radius: 4px; }
.legend button[aria-pressed="false"] { opacity: .38; }
.legend button:focus-visible { outline: 2px solid var(--s-p1); }
.chart { position: relative; width: 100%; }
.chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.chart text { font-family: var(--f-mono); font-size: 11px; fill: var(--muted); }
.chart .lbl { font-family: var(--f-body); font-size: 12px; fill: var(--ink-2); }
.tip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--ring); border-radius: 8px; padding: 9px 11px; box-shadow: 0 6px 20px rgba(0,0,0,.12); font-size: 12.5px; min-width: 210px; max-width: 290px; z-index: 2; }
.tip .h { font-family: var(--f-mono); font-size: 11px; color: var(--muted); margin-bottom: 4px; }
.tip .a { color: var(--ink-2); margin-bottom: 6px; }
.tip .row { display: grid; grid-template-columns: 16px 1fr auto; gap: 6px; align-items: center; }
.tip .row b { font-family: var(--f-mono); font-weight: 600; color: var(--ink); }
.cols { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 20px; align-items: start; }
@media (max-width: 860px) { .cols { grid-template-columns: 1fr; } }
.inspect { display: grid; gap: 14px; }
.inspect .meta { font-family: var(--f-mono); font-size: 12px; color: var(--muted); }
.views { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
.view { border-top: 2px solid var(--c); padding-top: 8px; display: grid; gap: 6px; }
.view .p { font-family: var(--f-display); font-size: 22px; font-weight: 600; }
.view .why { color: var(--ink-2); font-size: 13.5px; }
.fac { display: grid; grid-template-columns: 74px 1fr; gap: 3px 8px; align-items: center; font-size: 11.5px; color: var(--muted); }
.fac .bar { position: relative; height: 8px; background: var(--grid); border-radius: 2px; }
.fac .bar i { position: absolute; top: 0; bottom: 0; background: var(--c); border-radius: 2px; }
.fac .bar::after { content: ""; position: absolute; left: 50%; top: -2px; bottom: -2px; width: 1px; background: var(--axis); }
.board { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 12.5px; }
@media (max-width: 520px) { .board { grid-template-columns: 1fr; } }
.board h3 { font-size: 12px; font-family: var(--f-mono); letter-spacing: .06em; text-transform: uppercase; margin: 0 0 4px; color: var(--ink-2); display: flex; gap: 8px; align-items: center; }
.board ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 2px; }
.board .u { display: flex; justify-content: space-between; gap: 8px; }
.board .u span:last-child { font-family: var(--f-mono); color: var(--ink-2); white-space: nowrap; }
.board .x { opacity: .55; }
.hp { font-family: var(--f-mono); }
.tp { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.tp li { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: start; }
.tp button { all: unset; cursor: pointer; font-family: var(--f-mono); font-size: 11.5px; padding: 2px 7px; border-radius: 4px; border: 1px solid var(--ring); color: var(--ink); white-space: nowrap; }
.tp button:hover, .tp button:focus-visible { background: var(--band); outline: 2px solid var(--s-p1); outline-offset: 1px; }
.who { font-size: 11px; font-family: var(--f-mono); color: var(--muted); }
.summary { color: var(--ink-2); font-size: 14px; }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
th { font-weight: 600; color: var(--ink-2); font-size: 12px; }
td.n, th.n { text-align: right; font-family: var(--f-mono); }
.scroll { overflow-x: auto; }
details summary { cursor: pointer; font-family: var(--f-display); font-weight: 600; }
.note { font-size: 12.5px; color: var(--muted); }
.pos { color: var(--good); } .neg { color: var(--bad); }
`;

const JS = String.raw`
const D = JSON.parse(document.getElementById('data').textContent);
const $ = (s, el = document) => el.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; };
const h = (tag, cls, text, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (parent) parent.appendChild(e); return e; };
const pct = (x) => x == null ? '–' : (100 * x).toFixed(0) + '%';
const pretty = (s) => String(s).replace(/-/g, ' ');
const bot = (seat) => D.game.players.find((p) => p.id === seat)?.bot ?? seat;
const deck = (seat) => String(D.game.players.find((p) => p.id === seat)?.deck ?? '').replace(/#/g, ', ').replace(/-/g, ' ');

const SERIES = [
  { key: 'subjective_p1', name: 'P1 subjective', note: 'P1 sees own hand', color: 'var(--s-p1)' },
  { key: 'subjective_p2', name: 'P2 subjective', note: 'P2 sees own hand', color: 'var(--s-p2)' },
  { key: 'objective', name: 'Objective', note: 'both hands, no future', color: 'var(--s-obj)' },
  { key: 'omniscient', name: 'Hindsight', note: 'whole game known', color: 'var(--s-omni)' }
].filter((s) => D.cps.some((c) => c.v[s.key] && c.v[s.key].p1 != null));
if (D.baseline) SERIES.push({ key: 'baseline', name: 'Baseline (' + D.baseline.model + ')', note: 'objective view', color: 'var(--s-base)', dash: '2 4' });
const val = (c, key) => key === 'baseline' ? (D.baseline.byStep[c.step] ?? null) : (c.v[key] && c.v[key].p1 != null ? c.v[key].p1 : null);
const shown = new Set(SERIES.map((s) => s.key));
let selected = 0;

// ---------- header ----------
$('#title').textContent = bot('p1') + ' vs ' + bot('p2');
$('#eyebrow').textContent = (D.game.engine === 'fixture-sim' ? 'Fixture game (simulated)' : 'Game ' + D.game.id) + ' · seed ' + D.game.seed + ' · ' + D.game.rounds + ' rounds · ' + D.game.steps + ' decisions';
const vs = $('#vs');
for (const seat of ['p1', 'p2']) {
  const s = h('span', 'seat', null, vs);
  const k = h('i', 'key', null, s); k.style.background = seat === 'p1' ? 'var(--s-p1)' : 'var(--s-p2)';
  h('span', null, seat.toUpperCase() + ' ' + bot(seat) + ' · ' + deck(seat), s);
  if (D.game.winner === seat) h('span', 'win', 'winner', s);
}
const ev = D.evaluator;
const evText = ev.kind === 'heuristic' ? 'heuristic evaluator (no LLM)' : (ev.model + (ev.effort ? ', effort ' + ev.effort : '') + (ev.batch ? ', batch' : ''));
h('span', null, 'Evaluated by ' + evText + (D.usage && D.usage.cost_usd ? ' · $' + D.usage.cost_usd.toFixed(2) : ''), vs);

// ---------- tiles ----------
const tiles = $('#tiles');
const tile = (l, v, d) => { const t = h('div', 'tile', null, tiles); h('div', 'l', l, t); h('div', 'v', v, t); if (d) h('div', 'd', d, t); };
const gp = (x) => x == null ? '–' : (100 * x).toFixed(1) + ' pts';
tile('What P1 could not see', gp(D.fitness.gaps.info_p1), 'mean |P1 subjective − objective|');
tile('What P2 could not see', gp(D.fitness.gaps.info_p2), 'mean |P2 subjective − objective|');
tile('What the future held', gp(D.fitness.gaps.hindsight), 'mean |objective − hindsight|');
const obj = D.fitness.views.objective;
if (obj && obj.brier != null) tile('Objective view accuracy', obj.brier.toFixed(3), 'Brier score vs the result (0 is perfect, 0.25 is a coin flip)');

// ---------- charts ----------
let X0 = 46, X1 = 1000, W = 1040;
function measure(wrap) { W = Math.max(340, Math.round(wrap.clientWidth || 1040)); X0 = 46; X1 = W - 34; }
const steps = D.cps.map((c) => c.step);
const sMin = Math.min(...steps), sMax = Math.max(...steps);
const x = (s) => X0 + (s - sMin) / Math.max(1, sMax - sMin) * (X1 - X0);
const rounds = [];
D.cps.forEach((c) => { const r = rounds[rounds.length - 1]; if (!r || r.round !== c.round) rounds.push({ round: c.round, from: c.step, to: c.step }); else r.to = c.step; });

function frame(svg, H, y, ticks, fmt) {
  rounds.forEach((r, j) => {
    const nx = rounds[j + 1] ? x(rounds[j + 1].from) : X1;
    if (j % 2 === 0) el('rect', { x: x(r.from), y: 8, width: Math.max(0, nx - x(r.from)), height: H - 34, fill: 'var(--band)' }, svg);
    if (nx - x(r.from) > 22) el('text', { x: (x(r.from) + nx) / 2, y: H - 8, 'text-anchor': 'middle' }, svg).textContent = 'R' + r.round;
  });
  for (const t of ticks) {
    el('line', { x1: X0, x2: X1, y1: y(t), y2: y(t), stroke: 'var(--grid)', 'stroke-width': 1 }, svg);
    el('text', { x: X0 - 8, y: y(t) + 4, 'text-anchor': 'end' }, svg).textContent = fmt(t);
  }
}

function lines(svg, y, series, get) {
  const g = el('g', {}, svg);
  for (const s of series) {
    if (!shown.has(s.key)) continue;
    let d = '', pen = false;
    D.cps.forEach((c) => { const v = get(c, s.key); if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + x(c.step).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; });
    el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.key === 'objective' ? 2.25 : 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': s.dash || 'none' }, g);
  }
  return g;
}

function hover(svg, wrap, H, onTip) {
  const cross = el('line', { y1: 8, y2: H - 26, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' }, svg);
  const sel = el('line', { y1: 8, y2: H - 26, stroke: 'var(--ink)', 'stroke-width': 1, 'stroke-dasharray': '3 3' }, svg);
  const hit = el('rect', { x: X0, y: 0, width: X1 - X0, height: H, fill: 'transparent', tabindex: 0, role: 'slider', 'aria-label': 'Checkpoint', 'aria-valuemin': 0, 'aria-valuemax': D.cps.length - 1 }, svg);
  const tip = h('div', 'tip', null, wrap); tip.hidden = true;
  const nearest = (evt) => {
    const r = svg.getBoundingClientRect();
    const sx = (evt.clientX - r.left) / r.width * W;
    let best = 0, bd = Infinity;
    D.cps.forEach((c, j) => { const dd = Math.abs(x(c.step) - sx); if (dd < bd) { bd = dd; best = j; } });
    return best;
  };
  const show = (j, evt) => {
    const c = D.cps[j];
    cross.setAttribute('x1', x(c.step)); cross.setAttribute('x2', x(c.step)); cross.setAttribute('visibility', 'visible');
    tip.replaceChildren(); onTip(tip, c); tip.hidden = false;
    const r = svg.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    const px = x(c.step) / W * r.width;
    const left = px + 14 + tip.offsetWidth > wr.width ? px - 14 - tip.offsetWidth : px + 14;
    tip.style.left = Math.max(0, left) + 'px'; tip.style.top = (evt && evt.clientY ? Math.min(evt.clientY - wr.top + 10, wr.height - tip.offsetHeight) : 10) + 'px';
  };
  hit.addEventListener('pointermove', (e) => show(nearest(e), e));
  hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
  hit.addEventListener('click', (e) => select(nearest(e)));
  hit.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); select(Math.max(0, Math.min(D.cps.length - 1, selected + (e.key === 'ArrowRight' ? 1 : -1)))); show(selected); }
  });
  return (j) => { const c = D.cps[j]; sel.setAttribute('x1', x(c.step)); sel.setAttribute('x2', x(c.step)); hit.setAttribute('aria-valuenow', j); };
}

function tipHead(tip, c) {
  h('div', 'h', '#' + c.i + ' · round ' + c.round + ' ' + c.phase + ' · decision ' + c.step, tip);
  h('div', 'a', c.actor ? c.actor.toUpperCase() + ': ' + c.actions.map(pretty).join(' › ') : (c.actions.map(pretty).join(' › ') || 'start'), tip);
}
function tipRow(tip, color, name, value, dash) {
  const r = h('div', 'row', null, tip);
  const k = h('i', 'key', null, r); k.style.background = color; if (dash) k.style.opacity = .7;
  h('span', null, name, r); h('b', null, value, r);
}

const markers = [];
function drawMain() {
  const svg = $('#main svg'), wrap = $('#main');
  measure(wrap);
  const H = Math.round(Math.min(380, Math.max(260, W * 0.42)));
  svg.replaceChildren(); wrap.querySelectorAll('.tip').forEach((t) => t.remove());
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  const y = (p) => 8 + (1 - p) * (H - 42);
  frame(svg, H, y, [0, .25, .5, .75, 1], (t) => (t * 100) + '%');
  el('line', { x1: X0, x2: X1, y1: y(.5), y2: y(.5), stroke: 'var(--axis)', 'stroke-width': 1 }, svg);
  el('text', { x: X1 + 6, y: y(1) + 4, class: 'lbl' }, svg).textContent = 'P1';
  el('text', { x: X1 + 6, y: y(0) + 4, class: 'lbl' }, svg).textContent = 'P2';
  lines(svg, y, SERIES, val);
  // end dots with a surface ring
  for (const s of SERIES) {
    if (!shown.has(s.key)) continue;
    const last = [...D.cps].reverse().find((c) => val(c, s.key) != null);
    if (last) el('circle', { cx: x(last.step), cy: y(val(last, s.key)), r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
  }
  // turning points
  for (const t of (D.omniscient && D.omniscient.turningPoints) || []) {
    const c = D.cps.find((q) => q.i === t.i); if (!c) continue;
    const v = val(c, 'omniscient'); if (v == null || !shown.has('omniscient')) continue;
    el('circle', { cx: x(c.step), cy: y(v), r: 6, fill: 'none', stroke: 'var(--s-omni)', 'stroke-width': 2 }, svg);
  }
  const setSel = hover(svg, wrap, H, (tip, c) => {
    tipHead(tip, c);
    for (const s of SERIES) if (shown.has(s.key)) tipRow(tip, s.color, s.name, pct(val(c, s.key)), s.dash);
  });
  markers[0] = setSel;
}

const GAPS = [
  { key: 'g1', name: 'P1 subjective − objective', color: 'var(--s-p1)', get: (c) => diff(c, 'subjective_p1', 'objective') },
  { key: 'g2', name: 'P2 subjective − objective', color: 'var(--s-p2)', get: (c) => diff(c, 'subjective_p2', 'objective') },
  { key: 'g3', name: 'Hindsight − objective', color: 'var(--s-omni)', get: (c) => diff(c, 'omniscient', 'objective') }
];
function diff(c, a, b) { const p = val(c, a), q = val(c, b); return p == null || q == null ? null : p - q; }
function drawGaps() {
  const svg = $('#gaps svg'), wrap = $('#gaps');
  measure(wrap);
  const H = Math.round(Math.min(220, Math.max(170, W * 0.26)));
  svg.replaceChildren(); wrap.querySelectorAll('.tip').forEach((t) => t.remove());
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  const all = D.cps.flatMap((c) => GAPS.map((g) => g.get(c))).filter((v) => v != null);
  const m = Math.max(.1, Math.ceil(Math.max(...all.map(Math.abs), .05) * 10) / 10);
  const y = (d) => 8 + (m - d) / (2 * m) * (H - 42);
  frame(svg, H, y, [-m, -m / 2, 0, m / 2, m], (t) => (t > 0 ? '+' : '') + Math.round(t * 100));
  el('line', { x1: X0, x2: X1, y1: y(0), y2: y(0), stroke: 'var(--axis)', 'stroke-width': 1 }, svg);
  el('text', { x: X1 + 6, y: y(m) + 4, class: 'lbl' }, svg).textContent = 'P1↑';
  el('text', { x: X1 + 6, y: y(-m) + 4, class: 'lbl' }, svg).textContent = 'P2↑';
  const g = el('g', {}, svg);
  for (const s of GAPS) {
    let d = '', pen = false;
    D.cps.forEach((c) => { const v = s.get(c); if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + x(c.step).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; });
    if (d) el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round' }, g);
  }
  markers[1] = hover(svg, wrap, H, (tip, c) => {
    tipHead(tip, c);
    for (const s of GAPS) { const v = s.get(c); tipRow(tip, s.color, s.name, v == null ? '–' : (v > 0 ? '+' : '') + (100 * v).toFixed(1) + ' pts'); }
  });
  const lg = $('#gapLegend'); lg.replaceChildren();
  for (const s of GAPS) { const b = h('span', 'seat', null, lg); const k = h('i', 'key', null, b); k.style.background = s.color; h('span', null, s.name, b); }
}

function legend() {
  const lg = $('#legend'); lg.replaceChildren();
  for (const s of SERIES) {
    const b = h('button', null, null, lg); b.type = 'button'; b.setAttribute('aria-pressed', shown.has(s.key));
    const k = h('i', 'key', null, b); k.style.background = s.color; if (s.dash) k.style.backgroundImage = 'linear-gradient(90deg, var(--surface) 50%, transparent 0)', k.style.backgroundSize = '6px 3px';
    h('span', null, s.name + ' · ' + s.note, b);
    b.addEventListener('click', () => { shown.has(s.key) ? shown.delete(s.key) : shown.add(s.key); legend(); drawMain(); markers[0](selected); });
  }
}

// ---------- inspector ----------
function factorBars(parent, f, color) {
  const box = h('div', 'fac', null, parent); box.style.setProperty('--c', color);
  for (const [k, v] of Object.entries(f || {})) {
    h('span', null, pretty(k.replace('_', ' ')), box);
    const bar = h('div', 'bar', null, box); const i = h('i', null, null, bar);
    const w = Math.min(1, Math.abs(v)) * 50; i.style.left = (v >= 0 ? 50 : 50 - w) + '%'; i.style.width = w + '%';
    bar.title = k + ' ' + v;
  }
}
function boardSide(parent, seat, b) {
  const col = h('div', null, null, parent);
  const t = h('h3', null, null, col); const k = h('i', 'key', null, t); k.style.background = seat === 'p1' ? 'var(--s-p1)' : 'var(--s-p2)';
  h('span', null, seat.toUpperCase() + ' · base ', t); h('span', 'hp', b.base[1] + '/' + b.base[2], t);
  const ul = h('ul', null, null, col);
  const li = (a, bb, cls) => { const l = h('li', 'u' + (cls ? ' ' + cls : ''), null, ul); h('span', null, a, l); h('span', null, bb, l); };
  li('Resources · deck', b.res + ' · ' + b.deck);
  if (b.leader) li('Leader ' + b.leader[0], b.leader[1] ? 'deployed' : 'ready');
  for (const u of b.units) li((u[0] === 's' ? '✦ ' : '') + u[1], u[2] + '/' + u[3], u[4] ? 'x' : '');
  if (!b.units.length) li('No units', '');
  li('Hand (' + b.hand.length + ')', '');
  const hand = h('li', 'note', b.hand.join(', ') || 'empty', ul);
}
function inspect(j) {
  const c = D.cps[j], box = $('#inspect'); box.replaceChildren();
  h('div', 'meta', 'Checkpoint ' + c.i + ' of ' + (D.cps.length - 1) + ' · round ' + c.round + ' ' + c.phase + ' · decision ' + c.step + ' · ← → to step', box);
  h('h2', null, c.actor ? c.actor.toUpperCase() + ' (' + bot(c.actor) + '): ' + c.actions.map(pretty).join(' › ') : (c.actions.map(pretty).join(' › ') || 'Game start'), box);
  const views = h('div', 'views', null, box);
  for (const s of SERIES) {
    if (s.key === 'baseline') continue;
    const v = c.v[s.key]; if (!v) continue;
    const card = h('div', 'view', null, views); card.style.setProperty('--c', s.color);
    h('div', 'who', s.name + ' · ' + s.note, card);
    if (v.error) { h('div', 'why', 'Not evaluated: ' + v.error, card); continue; }
    h('div', 'p', 'P1 ' + pct(v.p1), card);
    const why = v.why || v.note; if (why) h('div', 'why', why, card);
    if (v.factors) factorBars(card, s.key === 'subjective_p2' ? Object.fromEntries(Object.entries(v.factors).map(([k, x]) => [k, -x])) : v.factors, s.color);
  }
  if (D.boards && D.boards[j]) { const bd = h('div', 'board', null, box); boardSide(bd, 'p1', D.boards[j].p1); boardSide(bd, 'p2', D.boards[j].p2); }
  h('div', 'note', 'Factor bars point right when they favour P1.', box);
}
// the shared game viewer (Holotable kit), when inlined: its playhead and the curves follow each other
let viewer = null;
function select(j, fromViewer) {
  selected = j; markers.forEach((m) => m && m(j)); inspect(j);
  if (viewer && !fromViewer) viewer.seek(D.cps[j].step);
}
if (window.SWUViewer && D.jsonl) {
  try {
    viewer = window.SWUViewer.mount($('#kit'), {
      jsonl: D.jsonl, evals: D.evals, layout: 'full', step: 0,
      onStep: (i) => {
        // the checkpoint whose position is on the board: the last one at or before the playhead
        let j = 0;
        D.cps.forEach((c, k) => { if (c.step <= i) j = k; });
        if (j !== selected) select(j, true);
      }
    });
  } catch (e) {
    $('#kit').textContent = 'The game viewer could not start: ' + e.message;
  }
} else {
  $('#kitPanel').hidden = true;
}

// ---------- turning points, credit, table ----------
function sidebar() {
  const box = $('#story');
  const o = D.omniscient;
  if (o && o.summary) h('p', 'summary', o.summary, box);
  const ul = h('ul', 'tp', null, box);
  for (const t of (o && o.turningPoints) || []) {
    const j = D.cps.findIndex((c) => c.i === t.i); if (j < 0) continue;
    const li = h('li', null, null, ul);
    const b = h('button', null, 'R' + D.cps[j].round + ' #' + t.i, li); b.type = 'button'; b.addEventListener('click', () => select(j));
    const d = h('div', null, null, li); h('div', 'who', t.by === 'luck' ? 'luck' : t.by.toUpperCase() + ' · ' + bot(t.by), d); h('div', null, t.what, d);
  }
  if (!ul.children.length) h('p', 'note', 'No turning points: the hindsight view did not run or found none.', box);

  const cr = $('#credit');
  const tbl = h('table', null, null, h('div', 'scroll', null, cr));
  const hr = h('tr', null, null, h('thead', null, null, tbl));
  ['Player', 'Turns', 'Credit / turn', 'Blunders', 'Best turn', 'Worst turn'].forEach((t, k) => h('th', k ? 'n' : '', t, hr));
  const tb = h('tbody', null, null, tbl);
  for (const [seat, s] of Object.entries(D.fitness.seats)) {
    const r = h('tr', null, null, tb);
    h('td', null, seat.toUpperCase() + ' ' + s.bot, r); h('td', 'n', s.turns, r);
    const cpt = s.creditPerTurn; h('td', 'n ' + (cpt > 0 ? 'pos' : cpt < 0 ? 'neg' : ''), cpt == null ? '–' : (cpt > 0 ? '+' : '') + (100 * cpt).toFixed(2) + ' pts', r);
    h('td', 'n', s.blunders, r);
    for (const m of [s.best, s.worst]) { const td = h('td', 'n', m ? (m.delta > 0 ? '+' : '') + (100 * m.delta).toFixed(0) + ' @#' + m.i : '–', r); if (m) td.title = m.actions.join(' › '); }
  }

  const t = $('#table');
  const tt = h('table', null, null, h('div', 'scroll', null, t));
  const th = h('tr', null, null, h('thead', null, null, tt));
  ['#', 'Round', 'Decision', 'Actor', 'Actions', ...SERIES.map((s) => s.name)].forEach((x, k) => h('th', k > 4 || k < 3 ? 'n' : '', x, th));
  const tbody = h('tbody', null, null, tt);
  D.cps.forEach((c) => {
    const r = h('tr', null, null, tbody);
    h('td', 'n', c.i, r); h('td', 'n', c.round, r); h('td', 'n', c.step, r); h('td', null, c.actor || '', r); h('td', null, c.actions.map(pretty).join(' › '), r);
    for (const s of SERIES) h('td', 'n', pct(val(c, s.key)), r);
  });
}

legend(); drawMain(); drawGaps(); sidebar();
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { drawMain(); drawGaps(); markers.forEach((m) => m && m(selected)); }, 120); });
select(D.cps.length - 1 > 0 ? Math.min(D.cps.length - 1, (D.omniscient && D.omniscient.turningPoints && D.omniscient.turningPoints[0] ? D.cps.findIndex((c) => c.i === D.omniscient.turningPoints[0].i) : 0)) : 0);
`;

function html(data, title, fragment, kit = null) {
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    const body = `<title>${title.replace(/</g, '&lt;')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600&family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${CSS}</style>
<div class="wrap">
  <header>
    <div class="eyebrow" id="eyebrow"></div>
    <h1 id="title"></h1>
    <div class="vs" id="vs"></div>
  </header>
  <div class="tiles" id="tiles"></div>
  <section class="panel" id="kitPanel" aria-labelledby="h-kit">
    <h2 id="h-kit">The game</h2>
    <div class="note">Scrub or play the replay; the curves and the analyst notes below follow the playhead, and clicking a curve moves it.</div>
    <div id="kit"></div>
  </section>
  <section class="panel" aria-labelledby="h-main">
    <h2 id="h-main">Who is winning, by viewpoint</h2>
    <div class="note">Every curve is the probability that P1 wins, so the views share one axis. Click a point to inspect it; turning points are ringed.</div>
    <div class="legend" id="legend"></div>
    <div class="chart" id="main"><svg role="img" aria-label="Win probability for player 1 at each checkpoint, one line per viewpoint"></svg></div>
  </section>
  <section class="panel" aria-labelledby="h-gaps">
    <h2 id="h-gaps">How far each view sits from the objective one</h2>
    <div class="note">Percentage points of P1 win probability. Above zero means that view rates P1 higher than an observer who sees both hands.</div>
    <div class="legend" id="gapLegend"></div>
    <div class="chart" id="gaps"><svg role="img" aria-label="Gap between each viewpoint and the objective view"></svg></div>
  </section>
  <div class="cols">
    <section class="panel inspect" id="inspect" aria-live="polite"></section>
    <section class="panel" aria-labelledby="h-story" style="display:grid;gap:12px">
      <h2 id="h-story">How it was decided</h2>
      <div id="story" style="display:grid;gap:12px"></div>
      <h2>Decision credit (objective view)</h2>
      <div class="note">Change in a player's own win probability across their turns. Summed over many games this is a fitness signal for a bot.</div>
      <div id="credit"></div>
    </section>
  </div>
  <details class="panel" id="table"><summary>All checkpoints as a table</summary></details>
</div>
<script type="application/json" id="data">${json}</script>
${kit ? `<script>${kit.replace(/<\/script/gi, '<\\/script')}</script>\n` : ''}<script>${JS}</script>`;
    return fragment ? body : `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    const file = argv.find((x) => !x.startsWith('--') && !argv[argv.indexOf(x) - 1]?.startsWith('--'));
    if (!file) {
        console.error('usage: node analysis/report.js <analysis.json> [--baseline other.json] [--game game.jsonl] [--kit swu-viewer-kit.js] [--out report.html] [--fragment]');
        process.exit(2);
    }
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    const baseline = opt(argv, 'baseline') ? JSON.parse(fs.readFileSync(opt(argv, 'baseline'), 'utf8')) : null;
    const gamePath = opt(argv, 'game', a.game.file);
    const kit = opt(argv, 'kit') ? fs.readFileSync(opt(argv, 'kit'), 'utf8') : null;
    let boards = null;
    let jsonl = null;
    if (gamePath && fs.existsSync(gamePath)) {
        if (kit) {
            jsonl = fs.readFileSync(gamePath, 'utf8');
        } else {
            boards = boardSummaries(loadGame(gamePath), a);
        }
    }
    const { data, title } = build(a, { baseline, boards, jsonl });
    const out = opt(argv, 'out', file.replace(/\.json$/, '.html'));
    fs.writeFileSync(out, html(data, title, argv.includes('--fragment'), kit));
    console.error(`wrote ${out}`);
}

module.exports = { build, html };
