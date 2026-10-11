# Atlas Kit

One picture language and one set of words for describing bots, taken from the Strategy Atlas. Use it on any page
that says where a bot wins or how it plays (dashboard, arena app, viewers), so every page reads the same.

This folder is written by `meta/export-kit.js` in the swu_bot repo on every hourly Atlas refresh. Do not edit it
here; change `meta/atlas-kit.js` (the source the Atlas page is built from) and the next refresh copies it.

| file | what |
|---|---|
| `atlas-kit.js` | the kit: UMD, a plain script (`window.AtlasKit`, also `window.ATLAS_KIT`) or Node module (`require`). No dependencies, no DOM use at load, safe to inline. |
| `kit.css` | the colour tokens (light, dark, `[data-theme]`) and the icon text classes, if you prefer a file to `injectCss()` |
| `kit.json` | the same words and data without code: spots, groups, icon parts, styles, traits, families, terms, colour tokens |
| `spots/<id>.svg` | small icon, final frame (what the Atlas uses in tiles, grid headers and the face-off) |
| `spots/<id>-full.svg` | large picture with numbers and labels, final frame |
| `spots/<id>-anim.svg`, `spots/<id>-mini-anim.svg` | looping animation: even opening, tween into the spot, hold. Works in `<img>` |
| `demo.html` | everything on one page, with the live guide animation |

The SVG files carry their own colours and follow light or dark mode. Inline SVG from `atlas-kit.js` uses CSS
variables, so call `AtlasKit.injectCss()` once (or `injectCss({ base: false })` if your page already defines
`--ink`, `--panel`, `--you`, `--them` and the edge ramp). The drawings use only `CSS_VARS` (`--you`, `--them`,
`--ink`, `--ink-2`, `--panel`, `--line-2`, `--neg-4`) and the classes in `CSS_CLASSES` (`bd-*`); family dots use
`--f-<key>`, and `edgeColor()` returns `--pos-1..5`, `--neg-1..5` and `--mid`.

Exports: `SPOTS` (list) and `SPOT` (by id: `say`, `focus`, `board` = the final state, `rule`, `short`, `label`, `group`),
`GROUPS`/`GROUP`, `drawBoard(id, k, { mini, glow })`, `miniBoard(id, cls)`, `spotSvg`, `animate`, `STYLES`, `TRAITS`,
`FAMILIES`/`FAMLABEL`/`famKey`, `TERMS`, `MIN_GAMES` (8), `THIN` (5), `EDGE_STEPS`, `edgeColor`, `pp`, `css`, `injectCss`,
`STYLE_KEY` (style one-liners). Spot rules run too: `view(state, pid)` reads a replay snapshot from one side, `SPOT[id].test(view)`
says if the spot holds, `spotsAt(state, pid)` lists the spots that hold. Ranking: `mappedOf(meta)` (bots with 8+ games and 5+
replays), `rankIn(bots, spotId)`, `standouts(bots)` (the Atlas's one-line summary).

Family colours match the console: Search blue, Heuristic orange, Rules mustard, Learned purple, LLM teal, Random grey.

Heuristic bots: games from before the heuristic fix (PR #10, 2026-10-11 11:37 UTC) are named `legacy` and
`legacy-<profile>` (e.g. `legacy-tempo`); plain `heuristic`, `aggro`, `tempo`, `control` mean the fixed code.

## The words

- **Spot**: a kind of game situation, checked at the start of each round from one player's side. Nine spots in three
  groups: When behind (Base behind, Board behind, Near death, Fewer cards), Close or long (Close at R4, Long game),
  When ahead (Base ahead, Board ahead, Lethal range). Ids, names, rules and one-line meanings are in `SPOTS`.
- **Edge**: points of win chance above (+) or below (−) an average bot in the same spot against the same opponent.
  Format with `pp()`, colour with `edgeColor()`.
- **vsOwn**: the same against the bot's own level; a bot's best and worst spot use it.
- **Best in a spot**: highest edge among bots with 8+ games there.
- **Style**: Racer, Bruiser, Controller, Cautious, Balanced (and Random), from the bot's own moves. Rules in `STYLES`.
- **Family**: colour = family everywhere: Rules, Search, LLM, Learned, Arena entrant, Random, Humans.
  `famKey(bot.family)` and `famColor(bot.family)` map a dashboard bot card's `family` field.
- **⏱**: games lost by a late or broken reply; each counts as a loss.
- **★** best bot in a spot; **▲ ▼** a bot's best and worst spot for its own level; hollow dot or hatched cell = under 5 games.
- All definitions: `TERMS`.

## Use

```html
<script src="atlas-kit.js"></script>
<script>
  AtlasKit.injectCss();
  el.innerHTML = AtlasKit.spotSvg('low_base');                    // small icon, final frame
  el.innerHTML = AtlasKit.spotSvg('low_base', { mini: false });   // large, with numbers
  AtlasKit.animate(svgEl, { onSpot: (s) => (caption.textContent = s.say) });   // the guide animation
</script>
```

Per-bot numbers for each spot (edge, games, best and worst spot, style) are in `/mnt/project-files/meta/meta.json`
(`swu-meta/1`, see `meta/README.md` in the repo). Spot ids there match the kit.
