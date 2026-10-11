/**
 * Strategy Atlas kit: the one shared picture language and vocabulary for describing bots.
 * Spots (game situations) with their icons, play styles, bot families and the Atlas's terms.
 *
 * Works as a browser script (sets window.AtlasKit, also as window.ATLAS_KIT) and as a Node module (require).
 * No dependencies and no DOM use at load time, so it can be inlined into any page.
 * The Strategy Atlas page is built from this file, and meta/export-kit.js copies it with ready-made SVGs
 * to /mnt/project-files/meta/kit/ on every refresh, so every page that uses it stays in step with the Atlas.
 */
(function (root, factory) {
  const kit = factory();
  if (typeof module === 'object' && module.exports) module.exports = kit;
  else root.AtlasKit = root.ATLAS_KIT = kit;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;

  /** A spot cell counts (can be "best") with this many games; under THIN games it is drawn hollow or hatched. */
  const MIN_GAMES = 8, THIN = 5;

  /** Groups, in display order. */
  const GROUPS = [
    { id: 'Behind', label: 'When behind' },
    { id: 'Even', label: 'Close or long' },
    { id: 'Ahead', label: 'When ahead' },
  ];

  /**
   * Spots: a round start seen from one player. A game enters a spot at the first round start where `rule` holds.
   * `label` and `short` must match meta/analyze.js SITUATIONS (build-page.js checks this).
   * `board` is the icon's final frame; `focus` is the part of the table the spot is about.
   */
  const SPOTS = [
    { id: 'base_behind', group: 'Behind', label: 'Base behind', short: 'your base 5+ HP lower', test: (x) => x.round >= 2 && x.baseLead <= -5, rule: 'round 2 or later and your base has 5+ HP less than theirs',
      say: 'Your base has 5 or more HP less left than theirs.', focus: 'base', gap: true,
      board: { you: { base: 12, units: [3, 2], hand: 3 }, them: { base: 21, units: [2, 3], hand: 3 }, round: 4 } },
    { id: 'board_behind', group: 'Behind', label: 'Board behind', short: '4+ less power on board', test: (x) => x.round >= 2 && x.boardLead <= -4, rule: 'round 2 or later and your units have 4+ less total power than theirs',
      say: 'Their units on the table have 4 or more power more than yours.', focus: 'units', gap: true,
      board: { you: { base: 24, units: [2, 1], hand: 3 }, them: { base: 24, units: [3, 4, 2, 3], hand: 3 }, round: 3 } },
    { id: 'low_base', group: 'Behind', label: 'Near death', short: 'your base at 8 HP or less', test: (x) => x.myBase <= 8, rule: 'your base has 8 HP or less',
      say: 'Your base is down to 8 HP or less. One or two more hits and you lose.', focus: 'base', only: 'you',
      board: { you: { base: 7, units: [2], hand: 2 }, them: { base: 18, units: [3, 2], hand: 3 }, round: 6 } },
    { id: 'cards_behind', group: 'Behind', label: 'Fewer cards', short: '2+ fewer cards in hand', test: (x) => x.round >= 2 && x.handLead <= -2, rule: 'round 2 or later and you hold 2+ fewer cards than they do',
      say: 'You hold 2 or more fewer cards than they do, so you have fewer options.', focus: 'hand', gap: true,
      board: { you: { base: 26, units: [2, 3], hand: 1 }, them: { base: 26, units: [2, 3], hand: 5 }, round: 3 } },
    { id: 'close_mid', group: 'Even', label: 'Close at R4', short: 'even at round 4', test: (x) => x.round === 4 && Math.abs(x.baseLead) <= 3 && Math.abs(x.boardLead) <= 3, rule: 'round 4 and both base HP and board power are within 3',
      say: 'Round 4 starts and both sides are level: base and board within 3.', focus: 'round', even: true,
      board: { you: { base: 22, units: [3, 2, 3], hand: 3 }, them: { base: 21, units: [2, 3, 3], hand: 3 }, round: 4 } },
    { id: 'long_game', group: 'Even', label: 'Long game', short: 'round 8 or later', test: (x) => x.round >= 8, rule: 'round 8 or later',
      say: 'The game reaches round 8. Most games are over by then.', focus: 'round', late: true,
      board: { you: { base: 13, units: [4, 2], hand: 2 }, them: { base: 15, units: [3, 3], hand: 2 }, round: 8 } },
    { id: 'base_ahead', group: 'Ahead', label: 'Base ahead', short: 'your base 5+ HP higher', test: (x) => x.round >= 2 && x.baseLead >= 5, rule: 'round 2 or later and your base has 5+ HP more than theirs',
      say: 'Your base has 5 or more HP more left than theirs.', focus: 'base', gap: true,
      board: { you: { base: 21, units: [2, 3], hand: 3 }, them: { base: 12, units: [3, 2], hand: 3 }, round: 4 } },
    { id: 'board_ahead', group: 'Ahead', label: 'Board ahead', short: '4+ more power on board', test: (x) => x.round >= 2 && x.boardLead >= 4, rule: 'round 2 or later and your units have 4+ more total power than theirs',
      say: 'Your units on the table have 4 or more power more than theirs.', focus: 'units', gap: true,
      board: { you: { base: 24, units: [3, 4, 2, 3], hand: 3 }, them: { base: 24, units: [2, 1], hand: 3 }, round: 3 } },
    { id: 'kill_range', group: 'Ahead', label: 'Lethal range', short: 'their base at 8 HP or less', test: (x) => x.oppBase <= 8, rule: 'their base has 8 HP or less',
      say: 'Their base is down to 8 HP or less. You can finish them soon.', focus: 'base', only: 'them',
      board: { you: { base: 18, units: [3, 2], hand: 3 }, them: { base: 6, units: [2], hand: 2 }, round: 6 } },
  ];
  for (const s of SPOTS) s.end = s.board; // older name for the final state
  const SPOT = Object.fromEntries(SPOTS.map((s) => [s.id, s]));

  /** One player's side of a recorder snapshot (bot/view.js shape): base HP left, board power, unit HP, hand, resources. */
  function sideOf(state, pid) {
    const p = state.players[pid];
    const units = [...(p.ground || []), ...(p.space || [])];
    return {
      base: p.base.hp - p.base.d,
      power: units.reduce((s, u) => s + (u.p || 0), 0),
      hpLeft: units.reduce((s, u) => s + Math.max(0, (u.h || 0) - (u.d || 0)), 0),
      units: units.length,
      hand: Array.isArray(p.hand) ? p.hand.length : (p.hand || 0),
      res: p.res ? p.res.total : 0,
    };
  }
  /** The features every spot rule and the average-bot fit read, for `pid` at a round-start snapshot. */
  function view(state, pid) {
    const me = sideOf(state, pid), them = sideOf(state, pid === 'p1' ? 'p2' : 'p1');
    return {
      round: state.round,
      myBase: me.base,
      oppBase: them.base,
      baseLead: me.base - them.base,
      boardLead: me.power - them.power,
      hpLead: me.hpLeft - them.hpLeft,
      handLead: me.hand - them.hand,
      resLead: me.res - them.res,
      initiative: state.initiative === pid ? 1 : 0,
    };
  }
  /** Spot ids whose rule holds for `pid` in a round-start snapshot. */
  function spotsAt(state, pid) {
    try { const x = view(state, pid); return SPOTS.filter((s) => s.test(x)).map((s) => s.id); } catch { return []; }
  }
  const GROUP = Object.fromEntries(GROUPS.map((g) => [g.id, g.label]));

  /** The even opening every animated icon starts from. */
  const OPEN = { you: { base: 30, units: [2, 3], hand: 4 }, them: { base: 30, units: [2, 3], hand: 4 }, round: 1 };

  /** Icon anatomy, for legends. */
  const ICON_PARTS = [
    { part: 'halves', text: 'Top half is the opponent (THEM, orange), bottom half is you (YOU, blue).' },
    { part: 'base', text: 'Tower = base HP left (30 at the start). It turns red at 8 HP or less.' },
    { part: 'units', text: 'Cards on the table = units, with their power.' },
    { part: 'hand', text: 'Fanned cards = cards in hand.' },
    { part: 'round', text: 'Tag on the centre line = round number (R8+ = round 8 or later). Small icons show it only for Close at R4 and Long game.' },
    { part: 'focus', text: 'In the small icons, the part the spot is about stays bright; the rest is dimmed.' },
  ];

  /**
   * Play styles, from per-round stats measured in replays (meta/analyze.js describe()). "High" = top third of the field.
   * The order is the order of the tests: the first that holds wins.
   */
  const STYLES = [
    { id: 'Racer', quadrant: 'Racers · hit the base', test: '80%+ of attacks at the base and high base damage', text: '80%+ of attacks at the base, high base damage' },
    { id: 'Bruiser', quadrant: 'Bruisers · do both', test: 'many units removed and high base damage', text: 'high base damage and many kills' },
    { id: 'Controller', quadrant: 'Controllers · clear the board', test: 'many units removed and under 60% of attacks at the base', text: 'many kills, attacks units more than the base' },
    { id: 'Cautious', quadrant: 'Passive', test: 'base damage in the bottom third', text: 'low base damage' },
    { id: 'Balanced', quadrant: null, test: 'none of the above', text: 'none of these' },
    { id: 'Random', quadrant: null, test: 'the random bot family', text: 'plays random legal moves' },
  ];

  /** [style, meaning] pairs for a legend. */
  const STYLE_KEY = STYLES.filter((x) => x.id !== 'Random').map((x) => [x.id, x.text]);

  /** Style traits, per round of the bot's own decisions. */
  const TRAITS = [
    { id: 'baseDmg', label: 'Base damage / round', fmt: 'num' },
    { id: 'baseShare', label: 'Attacks at base', fmt: 'pct' },
    { id: 'attacks', label: 'Attacks / round', fmt: 'num' },
    { id: 'kills', label: 'Units killed / round', fmt: 'num' },
    { id: 'deploys', label: 'Units added / round', fmt: 'num' },
    { id: 'passShare', label: 'Passes', fmt: 'pct' },
    { id: 'initiative', label: 'Initiative claims / round', fmt: 'num' },
    { id: 'rounds', label: 'Game length (rounds)', fmt: 'num' },
  ];

  /** Bot families: colour = family everywhere (dashboard bot cards use the same `family` values). */
  // The research console's family bands (Eric's audit picks), so every page uses one colour per family.
  // `hue` is the console's oklch hue band (per-bot shades spread across it), `chroma` its chroma; light and dark
  // are the band's middle as hex (oklch L 0.55, or 0.60 for warm hues, in light mode; L 0.76 in dark mode).
  const FAMILIES = [
    { id: 'search', family: 'search', label: 'Search', desc: 'simulates futures (MCTS, alpha-beta, PIMC)', hue: [236, 254], chroma: 0.17, light: '#0076cc', dark: '#3ab9ff' },
    { id: 'learned', family: 'learned', label: 'Learned', desc: 'a trained model picks or scores moves', hue: [290, 306], chroma: 0.17, light: '#7f55c6', dark: '#bf96ff' },
    { id: 'llm', family: 'llm', label: 'LLM', desc: 'a language model picks moves', hue: [188, 200], chroma: 0.17, light: '#008d8e', dark: '#00d1d0' },
    { id: 'heur', family: 'heuristic', label: 'Heuristic', desc: 'scores moves with a hand-written evaluation', hue: [40, 56], chroma: 0.17, light: '#cd5800', dark: '#ff8b44' },
    { id: 'rules', family: 'rules', label: 'Rules', desc: 'fixed priority list, no position score', hue: [88, 98], chroma: 0.17, light: '#a37a00', dark: '#d6ac00' },
    { id: 'random', family: 'random', label: 'Random', desc: 'uniform random choice', hue: [250, 250], chroma: 0.025, light: '#677380', dark: '#a6b3c1' },
    { id: 'arena', family: 'other', label: 'Other', desc: 'not classified yet (most arena entrants)', hue: [70, 80], chroma: 0.035, light: '#8d7e69', dark: '#bfae99' },
    { id: 'human', family: 'human', label: 'Humans', desc: 'real karabast.net players', hue: null, chroma: 0, light: '#0f1420', dark: '#eef0f4' },
  ];
  const FAM_BY_FAMILY = Object.fromEntries(FAMILIES.map((f) => [f.family, f]));
  // The dashboard and app call hand-written bots (rust-greedy, rush) family "rules".
  FAM_BY_FAMILY.rules = FAM_BY_FAMILY.heuristic;
  /** Family key -> label, e.g. FAMLABEL.heur = 'Heuristic'. */
  const FAMLABEL = Object.fromEntries(FAMILIES.map((f) => [f.id, f.label]));
  /** Family key ('heur', 'search', ...) for a bot's `family` field; anything unknown counts as 'other'. */
  const famKey = (family) => (FAM_BY_FAMILY[family] || FAM_BY_FAMILY.other).id;
  const famLabel = (family) => (FAM_BY_FAMILY[family] || FAM_BY_FAMILY.other).label;
  const famColor = (family) => `var(--f-${famKey(family)})`;

  /** The Atlas's words. Use them as written so every page reads the same. */
  const TERMS = {
    spot: 'A kind of game situation, checked at the start of each round from one player\'s side. A game counts in a spot from the first round start where its rule holds.',
    averageBot: 'What a 1500-rated bot is expected to win from the same position against the same opponent (a logistic fit on every round start).',
    edge: 'Points of win chance above (+) or below (−) an average bot in the same spot. +10 = wins 10 more of every 100 such games.',
    vsOwn: 'The same, measured against the bot\'s own level. A bot\'s best and worst spot use this, so a strong bot still has a weak spot.',
    best: 'The bot with the highest edge in a spot, among bots with 8+ games there.',
    rating: 'Overall strength from every finished game (Bradley-Terry, 1500 = average). Counts all games; a spot counts only games that reach it.',
    clock: '⏱ = games lost by timing out or a broken reply (a timeout, or a protocol error by that bot). Each one counts as a loss.',
    thin: 'Hollow dot or hatched cell = fewer than 5 games in that spot: treat it as a hint.',
    style: 'How a bot plays, from its own moves: base damage, units removed and where its attacks go (see STYLES).',
    star: '★ = the best bot in that spot.',
    upDown: '▲ ▼ = the bot\'s best and worst spot for its own level (vsOwn).',
    humans: 'Real karabast.net games, both seats as one competitor, scored like an average bot facing an equal opponent. Never ranked among bots.',
  };

  /** Edge as signed points: +12, −3, 0. */
  const pp = (x) => { const v = Math.round(x * 100); return v === 0 ? '0' : (v > 0 ? '+' : '−') + Math.abs(v); };
  /** |edge| below EDGE_STEPS[i] gets colour step i (0 = neutral --mid, 1..5 = --pos-n or --neg-n). */
  const EDGE_STEPS = [0.03, 0.08, 0.14, 0.22, 0.32];
  /** Diverging colour step for an edge: { bg, fg } as CSS vars (--pos-1..5, --neg-1..5, --mid). */
  function edgeColor(e) {
    const a = Math.abs(e);
    let step = EDGE_STEPS.findIndex((t) => a < t);
    if (step < 0) step = 5;
    if (!step) return { bg: 'var(--mid)', fg: 'var(--ink-2)' };
    return { bg: `var(--${e > 0 ? 'pos' : 'neg'}-${step})`, fg: step >= 4 ? 'var(--panel)' : 'var(--ink)' };
  }

  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const lerp = (a, b, t) => a + (b - a) * t;
  const powerOf = (units) => units.reduce((a, b) => a + b, 0);

  /**
   * SVG body (no <svg> wrapper, viewBox 0 0 240 150) of a spot's table at tween position k (0 = opening, 1 = the spot).
   * `mini` drops text and dims what the spot is not about; `glow` (0..1) pulses the focus outline.
   */
  function drawBoard(id, k = 1, { mini = false, glow = 0 } = {}) {
    const S = SPOT[id], A = OPEN, B = S.board;
    const dim = (part) => (k > 0.55 && S.focus !== part ? (mini ? 0.22 : 0.4) : 1);
    const side = (who, top) => {
      const a = A[who], b = B[who];
      const ink = who === 'you' ? 'var(--you)' : 'var(--them)';
      const yB = top ? 8 : 82, yU = top ? 22 : 96, yH = top ? 28 : 102;
      const hp = lerp(a.base, b.base, k), hpFrac = hp / 30, low = hp <= 8.5;
      let g = '';
      const bh = 58, fill = bh * hpFrac;
      const hot = S.focus === 'base' && (!S.only || S.only === who) && k > 0.6;
      g += `<g opacity="${dim('base')}"><rect x="8" y="${yB}" width="34" height="${bh}" rx="4" fill="var(--panel)" stroke="${hot ? 'var(--ink)' : 'var(--line-2)'}" stroke-width="${hot ? 2 + glow * 2 : 1.5}"/>`;
      g += `<rect x="11" y="${yB + bh - fill + 2}" width="28" height="${Math.max(0, fill - 4)}" rx="2" fill="${low ? 'var(--neg-4)' : ink}"/>`;
      if (!mini) g += `<text x="25" y="${yB + bh / 2 + 5}" text-anchor="middle" class="bd-num" style="fill:${hpFrac > 0.45 ? 'var(--panel)' : 'var(--ink)'}">${Math.round(hp)}</text>`;
      g += '</g>';
      // Units: slots fade in or out across the tween.
      const n0 = a.units.length, n1 = b.units.length, slots = Math.max(n0, n1);
      g += `<g opacity="${dim('units')}">`;
      for (let i = 0; i < slots; i++) {
        let op = 1;
        if (i >= Math.min(n0, n1)) { const j = i - Math.min(n0, n1), m = Math.abs(n1 - n0), t0 = j / (m + 1), t1 = (j + 1) / (m + 1); const f = Math.max(0, Math.min(1, (k - t0) / (t1 - t0))); op = n1 > n0 ? f : 1 - f; }
        if (op <= 0.01) continue;
        const pw = (n1 >= n0 ? b.units : a.units)[i] ?? b.units[i] ?? a.units[i];
        const x = 52 + i * 27, sc = 0.6 + 0.4 * op;
        g += `<g opacity="${op}" transform="translate(${x + 12} ${yU + 16}) scale(${sc}) translate(${-(x + 12)} ${-(yU + 16)})"><rect x="${x}" y="${yU}" width="24" height="32" rx="3" fill="${ink}"/>`;
        if (!mini) g += `<text x="${x + 12}" y="${yU + 21}" text-anchor="middle" class="bd-num" style="fill:var(--panel)">${pw}</text>`;
        g += '</g>';
      }
      if (!mini && k > 0.6 && S.focus === 'units') g += `<text x="52" y="${top ? yU - 4 : yU + 43}" class="bd-lab">total power ${powerOf(b.units)}</text>`;
      g += '</g>';
      // Hand: fanned cards.
      const h = Math.round(lerp(a.hand, b.hand, k));
      g += `<g opacity="${dim('hand')}">`;
      for (let i = 0; i < h; i++) g += `<rect x="${170 + i * 9}" y="${yH}" width="13" height="20" rx="2" fill="${ink}" stroke="var(--panel)" stroke-width="1.2" transform="rotate(${(i - (h - 1) / 2) * 6} ${176 + i * 9} ${yH + 26})"/>`;
      if (!mini) g += `<text x="${170}" y="${top ? yH - 6 : yH + 34}" class="bd-lab">${h} in hand</text>`;
      g += '</g>';
      if (!mini) g += `<text x="236" y="${top ? 11 : 146}" text-anchor="end" class="bd-who" style="fill:${ink}">${who === 'you' ? 'YOU' : 'THEM'}</text>`;
      return g;
    };
    const r = Math.round(lerp(A.round, B.round, ease(Math.min(1, k * 1.1))));
    let g = `<line x1="4" x2="236" y1="75" y2="75" stroke="var(--line-2)" stroke-dasharray="3 4"/>`;
    g += side('them', true) + side('you', false);
    const rHot = S.focus === 'round' && k > 0.6;
    // Round tag: a square-cornered tag, not a circle (a circle read as a clock). Small icons show it only for spots about the round.
    if (!mini || S.focus === 'round') g += `<g opacity="${dim('round')}"><rect x="${mini ? 192 : 194}" y="${mini ? 63 : 64}" width="${mini ? 44 : 40}" height="${mini ? 24 : 22}" rx="3" fill="var(--panel)" stroke="${rHot ? 'var(--ink)' : 'var(--line-2)'}" stroke-width="${rHot ? 2 + glow * 2 : 1.5}"/><text x="214" y="${mini ? 81 : 80}" text-anchor="middle" class="bd-round" style="${mini ? 'font-size:17px' : ''}">R${r}${S.late && k > 0.95 ? '+' : ''}</text></g>`;
    // The measured gap, as a pill on the centre line once the tween lands.
    if (!mini && k > 0.6) {
      let txt = null;
      const you = B.you, them = B.them;
      if (S.gap && S.focus === 'base') { const d = you.base - them.base; txt = `you ${d > 0 ? '+' : '−'}${Math.abs(d)} HP`; }
      if (S.gap && S.focus === 'units') { const d = powerOf(you.units) - powerOf(them.units); txt = `you ${d > 0 ? '+' : '−'}${Math.abs(d)} power`; }
      if (S.gap && S.focus === 'hand') { const d = you.hand - them.hand; txt = `you ${d > 0 ? '+' : '−'}${Math.abs(d)} cards`; }
      if (S.only) txt = `${S.only === 'you' ? 'your' : 'their'} base ${B[S.only].base} HP`;
      if (S.even) txt = 'level: base and board within 3';
      if (S.late) txt = 'round 8 or later';
      if (txt) {
        const w = txt.length * 6.1 + 14, op = Math.min(1, (k - 0.6) * 3);
        g += `<g opacity="${op}"><rect x="${128 - w / 2}" y="66" width="${w}" height="18" rx="9" fill="var(--ink)"/><text x="128" y="79" text-anchor="middle" class="bd-pill">${txt}</text></g>`;
      }
    }
    return g;
  }

  /**
   * Bots shown on the Atlas from a meta.json (`swu-meta/1`): MIN_GAMES+ games and 5+ replays, strongest first.
   * rankIn(bots, spot) orders them in one spot (MIN_GAMES+ games there); its first is the spot's ★ best.
   */
  const mappedOf = (meta) => meta.bots.filter((b) => b.games >= MIN_GAMES && b.replayGames >= 5).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const rankIn = (bots, sid) => bots.filter((b) => b.situations && b.situations[sid] && b.situations[sid].n >= MIN_GAMES).sort((a, b) => b.situations[sid].edge - a.situations[sid].edge);
  /**
   * The labelled extremes the Atlas shows first: top rating next to the bot best in the most spots (they often differ),
   * most base-focused, removes the most units, lost games on the clock.
   */
  function standouts(bots) {
    const out = [];
    const bot = bots.filter((b) => b.family !== 'human' && b.rating != null);
    if (bot.length) {
      const top = bot.reduce((a, b) => (b.rating > a.rating ? b : a));
      out.push({ kind: 'top', text: 'top rating (all games)', bot: top.id, value: String(top.rating) });
      const wins = {};
      for (const s of SPOTS) { const r = rankIn(bot, s.id)[0]; if (r) wins[r.id] = (wins[r.id] || 0) + 1; }
      const [most, n] = Object.entries(wins).sort((a, b) => b[1] - a[1])[0] || [];
      if (most) out.push({ kind: 'spots', text: 'best in the most spots', bot: most, value: `${n} of ${SPOTS.length}` });
    }
    const styled = bots.filter((b) => b.style && b.style.kills != null);
    if (!styled.length) return out;
    const maxBy = (k) => styled.reduce((a, b) => (b.style[k] > a.style[k] ? b : a), styled[0]);
    const racer = maxBy('baseShare'), killer = maxBy('kills'), clock = bots.filter((b) => b.forfeits).sort((a, b) => b.forfeits - a.forfeits);
    out.push({ kind: 'racer', text: 'most base-focused', bot: racer.id, value: `${Math.round(racer.style.baseShare * 100)}% of attacks at the base` });
    out.push({ kind: 'killer', text: 'removes the most units', bot: killer.id, value: `${killer.style.kills.toFixed(2)} a round` });
    if (clock.length) out.push({ kind: 'clock', text: 'lost games by timing out or a broken reply', bots: clock.map((b) => [b.id, b.forfeits]) });
    return out;
  }

  /** The small final-frame icon, as the Atlas uses it in tiles and grid headers. */
  const miniBoard = (id, cls = 'pict') => `<svg class="${cls}" viewBox="0 0 240 150" aria-hidden="true">${drawBoard(id, 1, { mini: true })}</svg>`;

  /** A whole <svg> for a spot. Defaults to the small final-frame icon. */
  function spotSvg(id, { k = 1, mini = true, cls = 'pict', label = true } = {}) {
    const S = SPOT[id];
    const aria = label ? `role="img" aria-label="${S.label}: ${S.short}"` : 'aria-hidden="true"';
    return `<svg class="${cls}" viewBox="0 0 240 150" ${aria}>${drawBoard(id, k, { mini })}</svg>`;
  }

  /**
   * Plays the guide animation in an <svg viewBox="0 0 240 150"> element: tween from the opening into each spot, hold, next.
   * Returns { stop(), show(id) }. `onSpot(spot)` is called when a new spot starts (for captions).
   * Honours prefers-reduced-motion by showing final frames only.
   */
  const TIMING = { hold0: 700, tween: 1900, hold1: 2400 };
  function animate(svg, { ids = SPOTS.map((s) => s.id), onSpot = null, loop = true } = {}) {
    let i = 0, t0 = performance.now(), raf = 0, auto = loop, last = null;
    const total = TIMING.hold0 + TIMING.tween + TIMING.hold1;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const draw = (id, k, glow) => { svg.innerHTML = drawBoard(id, k, { glow }); if (onSpot && last !== id) { last = id; onSpot(SPOT[id]); } };
    const frame = (now) => {
      if (!svg.isConnected) { raf = 0; return; }
      let t = now - t0;
      if (t > total) { if (auto) { i = (i + 1) % ids.length; t0 = now; t = 0; } else t = total; }
      const k = t < TIMING.hold0 ? 0 : t < TIMING.hold0 + TIMING.tween ? ease((t - TIMING.hold0) / TIMING.tween) : 1;
      draw(ids[i], k, k === 1 ? 0.5 + 0.5 * Math.sin((t - TIMING.hold0 - TIMING.tween) / 160) : 0);
      raf = requestAnimationFrame(frame);
    };
    if (reduce) draw(ids[0], 1, 0); else raf = requestAnimationFrame(frame);
    return {
      stop() { cancelAnimationFrame(raf); raf = 0; },
      show(id) { i = Math.max(0, ids.indexOf(id)); t0 = performance.now(); auto = false; if (reduce) draw(ids[i], 1, 0); },
      play() { auto = true; t0 = performance.now(); },
    };
  }

  /** Colour tokens the icons and family dots use. Same values as the Atlas page. */
  const TOKENS = {
    light: { '--ink': '#0f1420', '--ink-2': '#4a5263', '--panel': '#ffffff', '--line-2': '#c9ced8', '--mid': '#eef0f3', '--you': '#2a5bd7', '--them': '#d0603a', '--neg-4': '#cc4632',
      '--pos-1': '#dbe8fb', '--pos-2': '#a9c8f3', '--pos-3': '#5f9be8', '--pos-4': '#2a6fd0', '--pos-5': '#184f95', '--neg-1': '#fbe0dc', '--neg-2': '#f4b0a6', '--neg-3': '#e8735f', '--neg-5': '#962a1c', '--clock': '#b4361f' },
    dark: { '--ink': '#eef0f4', '--ink-2': '#b4bac8', '--panel': '#161a23', '--line-2': '#343a48', '--mid': '#1e232e', '--you': '#6f9cf0', '--them': '#e58258', '--neg-4': '#d9654f',
      '--pos-1': '#1d2c45', '--pos-2': '#23467a', '--pos-3': '#2f66b3', '--pos-4': '#4a8ae6', '--pos-5': '#8db8f5', '--neg-1': '#3a2220', '--neg-2': '#6a2f27', '--neg-3': '#a5412f', '--neg-5': '#f2a092', '--clock': '#f08a72' },
  };
  /** What the drawings reference, so a page can map them to its own tokens. */
  const CSS_VARS = ['--you', '--them', '--ink', '--ink-2', '--panel', '--line-2', '--neg-4'];
  const CSS_CLASSES = ['bd-num', 'bd-lab', 'bd-who', 'bd-round', 'bd-pill'];
  const famTokens = (mode) => Object.fromEntries(FAMILIES.map((f) => [`--f-${f.id}`, f.id === 'human' ? 'var(--ink)' : f[mode]]));
  const decl = (o) => Object.entries(o).map(([k, v]) => `${k}: ${v};`).join(' ');

  /**
   * CSS for the icons: tokens (light, dark by system preference, and [data-theme] overrides) plus the text classes.
   * `base: false` leaves out the general tokens (ink, panel, you, them, ...) for a page that defines its own.
   * `scope` is the selector the tokens go on (':root' for a page, 'svg' inside a standalone SVG file).
   */
  function css({ base = true, scope = ':root' } = {}) {
    const light = { ...(base ? TOKENS.light : {}), ...famTokens('light') }, dark = { ...(base ? TOKENS.dark : {}), ...famTokens('dark') };
    const dk = scope === ':root' ? ':root:not([data-theme="light"])' : scope;
    return [
      `${scope} { ${decl(light)} }`,
      `@media (prefers-color-scheme: dark) { ${dk} { ${decl(dark)} } }`,
      scope === ':root' ? `:root[data-theme="dark"] { ${decl(dark)} }` : '',
      '.bd-num { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: 13px; font-weight: 600; }',
      '.bd-lab { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: 9.5px; fill: var(--ink-2); }',
      '.bd-who { font-family: "Saira Semi Condensed", "Arial Narrow", system-ui, sans-serif; font-size: 10px; font-weight: 700; letter-spacing: .12em; }',
      '.bd-round { font-family: "Saira Semi Condensed", "Arial Narrow", system-ui, sans-serif; font-size: 12px; font-weight: 700; fill: var(--ink); }',
      '.bd-pill { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: 10px; font-weight: 600; fill: var(--panel); }',
    ].filter(Boolean).join('\n');
  }

  /** Adds css() to the page once. */
  function injectCss(opts) {
    if (typeof document === 'undefined' || document.getElementById('atlas-kit-css')) return;
    const st = document.createElement('style');
    st.id = 'atlas-kit-css';
    st.textContent = css(opts);
    document.head.appendChild(st);
  }

  return { VERSION, MIN_GAMES, THIN, GROUPS, GROUP, SPOTS, SPOT, OPEN, ICON_PARTS, STYLES, STYLE_KEY, TRAITS, FAMILIES, FAMLABEL, TERMS, TIMING,
    sideOf, view, spotsAt, mappedOf, rankIn, standouts,
    famKey, famLabel, famColor, pp, EDGE_STEPS, edgeColor, ease, drawBoard, miniBoard, spotSvg, animate,
    TOKENS, CSS_VARS, CSS_CLASSES, css, injectCss };
});
