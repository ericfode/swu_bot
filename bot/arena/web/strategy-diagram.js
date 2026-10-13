/*
 * Draws a "swu-strategy/1" diagram as SVG: {title, caption, nodes: [{id, label, kind, value, note}], edges: [{from, to,
 * weight, label}], highlight: [node ids], steps: [{caption, highlight}]}, with one column per node kind in the order
 * input, memory, feature, decision, action. Panels from the old arena carry these as widgets {type: 'strategy', ...}.
 * No dependencies; uses anime.js for the pulse and storyboard if window.anime exists, CSS otherwise. Colors come from
 * CSS variables on the host
 * (--ink, --muted, --line, --accent, --good, --bad, --panel) with fallbacks, so it fits both themes.
 *   SWUStrategy.render(element, diagram)  -> { destroy() }
 * destroy() stops the storyboard timer and every animation and empties the element; rendering into an element again
 * destroys what was drawn there before. A storyboard step without a caption shows none.
 */
(function (root) {
  const KINDS = ['input', 'memory', 'feature', 'decision', 'action'];
  const NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent, text) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function render(host, d) {
    if (host.__swuStrategy) host.__swuStrategy.destroy();
    host.textContent = '';
    const cols = KINDS.filter((k) => d.nodes.some((n) => n.kind === k));
    const byCol = cols.map((k) => d.nodes.filter((n) => n.kind === k));
    const rows = Math.max(...byCol.map((c) => c.length));
    const W = Math.max(520, cols.length * 170), H = Math.max(160, rows * 52 + 40);
    const pos = {};
    byCol.forEach((col, ci) => col.forEach((n, ri) => {
      pos[n.id] = { x: 70 + ci * ((W - 140) / Math.max(1, cols.length - 1 || 1)), y: 30 + (ri + 0.5) * ((H - 40) / col.length) };
    }));
    if (cols.length === 1) for (const n of d.nodes) pos[n.id].x = W / 2;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;font:12px system-ui,sans-serif;color:var(--ink,#1a2230)';
    if (d.title) { const t = document.createElement('div'); t.textContent = d.title; t.style.cssText = 'font-weight:600;font-size:13px'; wrap.appendChild(t); }
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': d.title || 'strategy diagram' });
    svg.style.maxWidth = '100%';
    wrap.appendChild(svg);
    const cap = document.createElement('div');
    cap.style.cssText = 'color:var(--muted,#5a6577);min-height:1.4em';
    cap.textContent = d.caption || '';
    wrap.appendChild(cap);
    host.appendChild(wrap);
    const maxW = Math.max(1e-9, ...d.edges.map((e) => Math.abs(e.weight ?? 1)));
    const edgeEls = d.edges.map((e) => {
      const a = pos[e.from], b = pos[e.to];
      const w = Math.abs(e.weight ?? 1) / maxW;
      const color = (e.weight ?? 1) < 0 ? 'var(--bad,#a3322a)' : 'var(--muted,#5a6577)';
      const mx = (a.x + b.x) / 2;
      const p = el('path', { d: `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`, fill: 'none', stroke: color, 'stroke-width': (1 + 5 * w).toFixed(2), opacity: 0.45 }, svg);
      if (e.label) el('text', { x: mx, y: (a.y + b.y) / 2 - 4, 'text-anchor': 'middle', fill: 'var(--muted,#5a6577)', 'font-size': 10 }, svg, e.label);
      return { e, p };
    });
    const maxV = Math.max(1e-9, ...d.nodes.map((n) => Math.abs(n.value ?? 0)));
    const nodeEls = d.nodes.map((n) => {
      const g = el('g', { transform: `translate(${pos[n.id].x},${pos[n.id].y})` }, svg);
      const r = 9 + 9 * (n.value === undefined ? 0.4 : Math.abs(n.value) / maxV);
      const c = el('circle', { r: r.toFixed(1), fill: 'var(--panel,#f8f9fb)', stroke: (n.value ?? 0) < 0 ? 'var(--bad,#a3322a)' : 'var(--accent,#c2410c)', 'stroke-width': 2 }, g);
      el('text', { y: r + 13, 'text-anchor': 'middle', fill: 'var(--ink,#1a2230)', 'font-size': 11 }, g, n.label);
      if (n.note || n.value !== undefined) el('title', {}, g, [n.label, n.value !== undefined ? `value ${n.value}` : '', n.note || ''].filter(Boolean).join('\n'));
      return { n, g, c };
    });
    let timer = null, anims = [], dead = false;
    function stopAnims() {
      anims.forEach((a) => a.pause && a.pause()); anims = [];
      if (root.anime && root.anime.remove) root.anime.remove([...edgeEls.map((x) => x.p), ...nodeEls.map((x) => x.c)]);
    }
    function apply(highlight, caption) {
      if (dead) return;
      const on = new Set(highlight || []);
      stopAnims();
      for (const { n, c } of nodeEls) {
        c.setAttribute('stroke-width', on.has(n.id) ? 4 : 2);
        c.style.fill = on.has(n.id) ? 'var(--accent-soft,#fbe6da)' : '';
      }
      for (const { e, p } of edgeEls) {
        const hot = on.has(e.from) && on.has(e.to);
        p.setAttribute('opacity', hot ? 0.95 : on.size ? 0.18 : 0.45);
        p.setAttribute('stroke-dasharray', hot ? '6 6' : '');
        if (hot && root.anime) anims.push(root.anime({ targets: p, strokeDashoffset: [24, 0], duration: 900, easing: 'linear', loop: true }));
      }
      if (root.anime && on.size) anims.push(root.anime({ targets: nodeEls.filter((x) => on.has(x.n.id)).map((x) => x.c), scale: [1, 1.12], direction: 'alternate', loop: true, duration: 700, easing: 'easeInOutSine' }));
      if (caption !== undefined) cap.textContent = caption;
    }
    apply(d.highlight);
    if (d.steps && d.steps.length && !(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      let i = 0;
      timer = setInterval(() => { const s = d.steps[i++ % d.steps.length]; apply(s.highlight, s.caption || ''); }, 2600);
    }
    const view = {
      destroy() {
        if (dead) return;
        dead = true;
        clearInterval(timer); timer = null;
        stopAnims();
        if (host.__swuStrategy === view) { host.__swuStrategy = null; host.textContent = ''; }
      }
    };
    host.__swuStrategy = view;
    return view;
  }
  root.SWUStrategy = { render };
})(typeof window !== 'undefined' ? window : globalThis);
