// Board-position glyph: a whole SWU Snapshot (recorder format, spec/replay-format.md) in a 40x48 icon.
// Player 2 is drawn in the top half and player 1 in the bottom half, mirrored around the centre line.
//   outer edge bar   base HP left (full width = full HP)
//   tall row         ground units; short row nearest the edge: space units
//   each unit        width fixed, height = power (cap 7), opacity = HP left; outline only = exhausted
//   left pips        cards in hand (up to 6); right pips: ready resources (filled) of total (hollow), up to 8
//   triangle         on the centre line, points at the player with initiative
// glyph(state, opts) returns an <svg> string. opts: {size, x, y, title, selected, value (0..1, colours the frame), colors:{p1,p2,ink,line,bg,faint}}
(function (root) {
    const DEF = { p1: 'var(--s1)', p2: 'var(--s2)', ink: 'var(--ink)', line: 'var(--line)', bg: 'var(--surface)', faint: 'var(--faint)', accent: 'var(--accent)', hi: 'var(--div-hi)', lo: 'var(--div-lo)' };
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    function half(ps, seat, top, C) {
        if (!ps) return '';
        const col = C[seat];
        const Y = (y, h = 0) => top ? y : 48 - y - h; // mirror for the bottom half
        let s = '';
        const hp = ps.base?.hp || 30, left = Math.max(0, hp - (ps.base?.d || 0));
        s += `<rect x="5" y="${Y(1.2, 2.6)}" width="30" height="2.6" rx="1.3" fill="${C.line}"/>`;
        s += `<rect x="5" y="${Y(1.2, 2.6)}" width="${(30 * left / hp).toFixed(2)}" height="2.6" rx="1.3" fill="${col}"/>`;
        const row = (units, y0, maxH) => {
            let r = '';
            const list = (units || []).slice(0, 6);
            list.forEach((u, i) => {
                const h = Math.max(1.2, Math.min(7, u.p || 0) / 7 * maxH), x = 5.5 + i * 5;
                const op = u.h ? Math.max(0.3, (u.h - (u.d || 0)) / u.h) : 1;
                const y = top ? y0 : 48 - y0 - h; // grow away from the edge row toward the centre
                r += u.x ? `<rect x="${x}" y="${y.toFixed(2)}" width="3.6" height="${h.toFixed(2)}" fill="none" stroke="${col}" stroke-width=".8" opacity="${op.toFixed(2)}"/>`
                    : `<rect x="${x}" y="${y.toFixed(2)}" width="3.6" height="${h.toFixed(2)}" rx=".6" fill="${col}" opacity="${op.toFixed(2)}"/>`;
            });
            if ((units || []).length > 6) r += `<text x="35.2" y="${top ? y0 + 3 : 48 - y0 - 0.5}" font-size="3.4" fill="${C.ink}" text-anchor="end">+</text>`;
            return r;
        };
        s += row(ps.space, 5.2, 4.6);
        s += row(ps.ground, 11.2, 9.6);
        const hc = ps.handCount != null && Number.isFinite(+ps.handCount) ? +ps.handCount : ps.hand?.length || 0; // handCount also covers a hidden hand (protocol-v2 point-of-view states)
        const hand = Math.max(0, Math.min(6, hc));
        for (let i = 0; i < hand; i++) s += `<circle cx="2.3" cy="${Y(6 + i * 2.7).toFixed(2)}" r=".9" fill="${C.ink}" opacity=".55"/>`;
        const tot = Math.min(8, ps.res?.total || 0), rdy = Math.min(tot, ps.res?.ready || 0);
        for (let i = 0; i < tot; i++) s += `<circle cx="37.7" cy="${Y(5.5 + i * 2.15).toFixed(2)}" r=".85" ${i < rdy ? `fill="${col}"` : `fill="none" stroke="${col}" stroke-width=".5"`}/>`;
        if (ps.leader?.dep) s += `<path d="M36.2 ${Y(1.2)} l1.5 ${top ? 2.6 : -2.6} l1.5 ${top ? -2.6 : 2.6}z" fill="${col}"/>`;
        return s;
    }

    function glyph(state, o = {}) {
        const C = { ...DEF, ...(o.colors || {}) };
        const size = o.size || 40;
        const frame = o.value == null ? (o.selected ? C.accent : C.line)
            : `color-mix(in srgb, ${o.value >= 0.5 ? C.hi : C.lo} ${Math.round(Math.min(1, Math.abs(o.value - 0.5) * 2.4) * 100)}%, ${C.line})`;
        let s = `<svg ${o.x != null ? `x="${o.x}" y="${o.y}"` : ''} width="${size}" height="${(size * 1.2).toFixed(1)}" viewBox="0 0 40 48" role="img" aria-label="${esc(o.title || 'board position')}">`;
        if (o.title) s += `<title>${esc(o.title)}</title>`;
        s += `<rect x=".5" y=".5" width="39" height="47" rx="3" fill="${C.bg}" stroke="${frame}" stroke-width="${o.selected || o.value != null ? 1.6 : 0.8}"/>`;
        if (!state?.players) return s + `<text x="20" y="27" font-size="6" text-anchor="middle" fill="${C.faint}">?</text></svg>`;
        s += `<line x1="4" x2="36" y1="24" y2="24" stroke="${C.line}" stroke-width=".6"/>`;
        s += half(state.players.p2, 'p2', true, C) + half(state.players.p1, 'p1', false, C);
        if (state.initiative) s += `<path d="M1 ${state.initiative === 'p2' ? 25.6 : 22.4} l2 ${state.initiative === 'p2' ? -3.2 : 3.2} l2 ${state.initiative === 'p2' ? 3.2 : -3.2}z" fill="${C[state.initiative]}"/>`;
        return s + '</svg>';
    }

    // Lays out a decision tree ({label, state, value, visits, chosen, note, children}) left to right.
    // Returns {svg, width, height}. Chosen edges are drawn heavy; edge labels are the child's action.
    function tree(rootNode, o = {}) {
        const C = { ...DEF, ...(o.colors || {}) };
        const G = o.glyph || 34, GH = G * 1.2, colW = o.colW || 150, rowH = GH + 16, pad = 6;
        let leaf = 0, maxDepth = 0;
        const nodes = [];
        const walk = (n, d) => {
            maxDepth = Math.max(maxDepth, d);
            const kids = (n.children || []).slice(0, o.maxChildren || 8);
            const me = { n, d, kids: [] };
            nodes.push(me);
            if (!kids.length) me.row = leaf++;
            else { me.kids = kids.map(k => walk(k, d + 1)); me.row = (me.kids[0].row + me.kids.at(-1).row) / 2; }
            return me;
        };
        walk(rootNode, 0);
        const W = pad * 2 + maxDepth * colW + G + 4, H = pad * 2 + Math.max(1, leaf) * rowH;
        const X = d => pad + d * colW, Yc = r => pad + r * rowH + GH / 2;
        let s = '';
        for (const m of nodes) for (const k of m.kids) {
            const x1 = X(m.d) + G, y1 = Yc(m.row), x2 = X(k.d), y2 = Yc(k.row), mx = (x1 + x2) / 2;
            const on = k.n.chosen;
            s += `<path d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" stroke="${on ? C.accent : C.line}" stroke-width="${on ? 2 : 1}"/>`;
            const lab = String(k.n.label || '').slice(0, 26) + (String(k.n.label || '').length > 26 ? '…' : '');
            const stat = [k.n.visits != null ? `${k.n.visits}v` : '', k.n.value != null ? `${Math.round(k.n.value * 100)}%` : ''].filter(Boolean).join(' · ');
            s += `<text x="${x2 - 4}" y="${y2 - GH / 2 - 3}" font-size="10.5" text-anchor="end" fill="${on ? C.ink : C.faint}" font-weight="${on ? 600 : 400}">${esc(lab)}</text>`;
            if (stat) s += `<text x="${x2 - 4}" y="${y2 + 4}" font-size="9.5" text-anchor="end" fill="${C.faint}" font-family="var(--mono, monospace)">${esc(stat)}</text>`;
        }
        for (const m of nodes) s += glyph(m.n.state, { ...o, size: G, x: X(m.d), y: Yc(m.row) - GH / 2, value: m.n.value, selected: m.d === 0, title: [m.n.label, m.n.note].filter(Boolean).join(' · ') || 'position' });
        return { svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="max-width:none;overflow:visible">${s}</svg>`, width: W, height: H };
    }

    const api = { glyph, tree };
    if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SWUGlyph = api;
})(typeof window !== 'undefined' ? window : globalThis);
