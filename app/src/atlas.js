// The Strategy Atlas framework, used everywhere in the app (Eric, 2026-10-11: one framework for every bot).
// Everything drawn or worded comes from the Strategy meta analyzer's shared kit (meta/kit/atlas-kit.js, window.AtlasKit),
// which the build inlines just before this file: spot icons, the spot list and words, styles, the edge colour ramp.
// This file only adds what the app needs on top: the spot rules on a replay snapshot (for live views), who to bet on,
// the standouts line and a compact Atlas model built from meta/meta.json.
(function (root) {
  const K = root.AtlasKit;
  if (!K) throw new Error('Atlas kit (meta/kit/atlas-kit.js) did not load');
  const MIN_GAMES = K.MIN_GAMES;
  const GROUP = K.GROUP;
  const STYLE_KEY = K.STYLES.filter(s => s.id !== 'Random').map(s => [s.id, s.text]);
  const SPOTS = K.SPOT; // by id: label, short, rule, say, group, focus
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // The kit's spot rules as code, read from one player's side (meta/analyze.js SITUATIONS, same thresholds as K.SPOT[id].rule).
  const RULES = {
    base_behind: x => x.round >= 2 && x.baseLead <= -5,
    board_behind: x => x.round >= 2 && x.boardLead <= -4,
    low_base: x => x.myBase <= 8,
    cards_behind: x => x.round >= 2 && x.handLead <= -2,
    close_mid: x => x.round === 4 && Math.abs(x.baseLead) <= 3 && Math.abs(x.boardLead) <= 3,
    long_game: x => x.round >= 8,
    base_ahead: x => x.round >= 2 && x.baseLead >= 5,
    board_ahead: x => x.round >= 2 && x.boardLead >= 4,
    kill_range: x => x.oppBase <= 8,
  };
  function sideOf(state, pid) {
    const p = state.players[pid], units = [...(p.ground || []), ...(p.space || [])];
    return { base: (p.base?.hp ?? 0) - (p.base?.d ?? 0), power: units.reduce((s, u) => s + (u.p || 0), 0), hand: Array.isArray(p.hand) ? p.hand.length : (p.hand || 0) };
  }
  function view(state, pid) {
    const me = sideOf(state, pid), them = sideOf(state, pid === 'p1' ? 'p2' : 'p1');
    return { round: state.round, myBase: me.base, oppBase: them.base, baseLead: me.base - them.base, boardLead: me.power - them.power, handLead: me.hand - them.hand };
  }
  /** Spot ids that hold for `pid` on a replay snapshot (the Atlas reads them at round starts). */
  function spotsAt(state, pid) { try { const v = view(state, pid); return K.SPOTS.map(s => s.id).filter(k => RULES[k](v)); } catch { return []; } }

  /** A spot icon with an accessible name: the kit's small final-frame drawing. */
  const icon = (id, cls = 'pict', title = '') => SPOTS[id] ? `<svg class="${cls}" viewBox="0 0 240 150" role="img" aria-label="${esc(title || SPOTS[id].label)}">${title ? `<title>${esc(title)}</title>` : ''}${K.drawBoard(id, 1, { mini: true })}</svg>` : '';

  /** Who to bet on in each spot: mapped bots with 8+ games there, best edge first. */
  function rankIn(atlas, sid) { return atlas.mapped.filter(b => (b.situations[sid]?.n || 0) >= MIN_GAMES).sort((a, b) => b.situations[sid].edge - a.situations[sid].edge); }

  /** The standouts line: the labelled extremes a reader asks for first. */
  function standouts(atlas) {
    const styled = atlas.mapped.filter(b => b.style?.kills != null);
    if (!styled.length) return [];
    const maxBy = k => styled.reduce((a, b) => (b.style[k] > a.style[k] ? b : a), styled[0]);
    const racer = maxBy('baseShare'), killer = maxBy('kills'), clock = atlas.mapped.filter(b => b.forfeits).sort((a, b) => b.forfeits - a.forfeits);
    const out = [];
    out.push({ kind: 'racer', bot: racer.id, text: 'most base-focused', value: `${Math.round(racer.style.baseShare * 100)}% of attacks at the base` });
    out.push({ kind: 'killer', bot: killer.id, text: 'removes the most units', value: `${killer.style.kills.toFixed(2)} a round` });
    if (clock.length) out.push({ kind: 'clock', bots: clock.map(b => [b.id, b.forfeits]), text: 'lost games by a late or broken reply' });
    return out;
  }

  /** Builds the Atlas view of the meta model: mapped bots, best per spot, ranks, verdict, standouts. */
  function build(meta) {
    if (!meta?.bots) return null;
    const mapped = meta.bots.filter(b => b.games >= MIN_GAMES && b.replayGames >= 5).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    const atlas = { generatedAt: meta.generatedAt, totals: meta.totals, situations: meta.situations, style: meta.style, mapped, byId: Object.fromEntries(meta.bots.map(b => [b.id, b])), best: {}, ranks: {} };
    for (const s of meta.situations) { const r = rankIn(atlas, s.id); atlas.ranks[s.id] = r.map(b => b.id); if (r[0]) atlas.best[s.id] = r[0].id; }
    const won = {}; for (const id of Object.values(atlas.best)) won[id] = (won[id] || 0) + 1;
    const most = Object.entries(won).sort((a, b) => b[1] - a[1])[0], top = mapped[0];
    atlas.verdict = most && top ? (most[0] === top.id ? { same: true, top: top.id, n: most[1] } : { same: false, top: top.id, most: most[0], n: most[1] }) : null;
    atlas.standouts = standouts(atlas);
    return atlas;
  }

  root.SWUAtlas = { KIT: K, GROUP, MIN_GAMES, STYLE_KEY, SPOTS, RULES, pp: K.pp, view, spotsAt, drawBoard: K.drawBoard, icon, edgeColor: K.edgeColor, rankIn, build, ease: K.ease, TIMING: K.TIMING };
})(typeof window !== 'undefined' ? window : globalThis);
