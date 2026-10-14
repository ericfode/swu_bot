# SWU Arena + Research app: design pass

Owner: the "Arena and research app design" thread (started 2026-10-11 17:20 from Eric's ask: "a deep design pass on
the interface that users will use to see the arena running and get to the research information. The current
research page has basically everything I want, but is not laid out well as an application.").

Code: `app/` in this repo (`app/src`, built by `app/build.mjs`, see `app/README.md`). The prototype and Eric's picks
page were published from the project's shared folder (`app-design/`): prototype
https://claude.ai/artifact/ERWJYCn8o1FZVZVeoFP91r, picks https://claude.ai/artifact/NffMnCx8DasXQaS79Cagwc. Eric's six
picks (18:21): Home = Broadcast; the app lives both as the project page and hosted with the arena; Atlas rules
everywhere, ratings written once by the meta analyzer; one replay ladder for the unmapped top bots; this thread builds
the shell and owners keep their parts; friends see everything except Lab and builder names (which thread built what).

## 0. Core rule: the Strategy Atlas is the app's one framework (Eric, 2026-10-11 ~17:36, via the coordinator)

Every bot page, card, comparison and live view describes bots with the same Atlas spot icons and words. In the
prototype everything drawn or worded comes from the meta analyzer's shared kit `meta/atlas-kit.js` (`window.AtlasKit`,
inlined by `app/build.mjs`, the same file the dashboard inlines). `app/src/atlas.js` only adds the spot rules on a replay
snapshot, who to bet on, the standouts line and the Atlas model built from `meta/meta.json`:

- **Words**: the nine spots (Base behind, Board behind, Near death, Fewer cards, Close at R4, Long game, Base ahead,
  Board ahead, Lethal range) in three groups When behind / Close or long / When ahead; edge = "points of win chance
  above an average bot"; ★ best of all bots in a spot (8+ games there); ▲ ▼ the bot's own best and worst spot;
  ⏱ games lost by a late or broken reply; styles Racer, Bruiser, Controller, Cautious, Balanced.
- **Icons and colours**: the Atlas's tiny-table pictogram per spot and its edge ramp (blue better, red worse).
- **Where it shows**: a 9-cell spot strip (the bot's "fingerprint") next to every rating (bots table, top bots,
  competitor cards, bot header); "Where it wins" on bot and competitor pages; Bots > Face-off (the Atlas face-off);
  Bots > All bots (animated spot guide, verdict, standouts, every bot's edge in every spot; picking a spot sorts
  the table by it, which is "who to bet on"); Games > Now playing (the spots each side is in under every board); Home "Who to bet on" row; under every game viewer, the spots each side is in at the current step and how
  that bot does there (`SWUAtlas.spotsAt` on the replay snapshot; the Atlas itself reads spots at round starts).
- **Gap it exposed**: 9 of the top 20 bots had no spot map because their ladders kept no replays. The meta thread's
  replay ladder (results/atlas-map-1, 224 games, Eric's pick 4) mapped 7 of them; bend and bend-jev-ties are still
  unmapped (their compiler can't be cloned in the sandbox).

**Building blocks, not pages (Eric, 18:18):** "the point of almost all of the claude artifacts was to build building
blocks that this would integrate all together." So a thread's kit or view goes inside the app view about the same
objects (the Atlas inside the all-bots table, small boards inside Home, Arena and Games), never as its own tab.

## 1. Who uses it, and for what

| who | job | where they should land |
|---|---|---|
| Eric, checking in between meetings (often on a phone) | What is happening now? What changed since I looked? Does anything need me? | Home |
| Eric, doing research | Which evaluator is best? Where does each bot win? Why did A lose to B? What did experiment X find? | Research, a bot's page, a game's page |
| Friends watching the arena | Who is winning? Watch a live game. What is my favourite competitor thinking? | Arena > Live |
| Friends competing (later, hosted on Fly) | Join, submit, see my results and the games I lost | Arena > Competitor page, Join |
| Project threads (Claude) | Publish results | They write files; the app shows them (no UI work per thread) |

## 2. What is wrong with today's pages (details in INVENTORY.md)

1. **One 38,654 px page.** The research console is 8 sections stacked (about 43 screens at 1440x900). No navigation,
   no URL per view, so nothing can be linked ("look at rust-search" or "look at the evaluator chart").
2. **Everything at full size at once.** 74-row standings, a 74x74 head-to-head grid that is mostly empty, a 74-row
   speed strip plot, 26 strategy panels each 1,500 px or taller.
3. **Objects are not first class.** A bot shows up in 6 places (standings row, grid row, speed row, strategy panel,
   spot tile, card drawer) but has no page of its own. Games have no list and no page.
4. **Three ratings for one bot.** rust-search is 1716 on the console (sequential Elo, K=24, in run order), 1936 on the
   Strategy Atlas (Bradley-Terry over all games), and the arena uses a third (Bradley-Terry per round, baselines
   pinned at 1500). No label says which one you are looking at.
5. **Three visual languages, two of them with opposite colours.** Console: search = blue, heuristic = orange.
   Atlas: heuristic = blue, search = orange. Arena web UI: system font, no family colours at all.
6. **The arena is split in three.** Competitor panels sit in the console's Strategies section; standings, games and
   join sit in the arena web UI; round reports are markdown files. There is no "watch the arena" screen.
7. **Internal and public mixed.** Work threads, thread names as owners ("Rust bot (continued)"), "Example data"
   tags and fixture panels sit next to results a friend would read.
8. **"Live" is unclear.** "Now playing" is the newest game of any ladder (today an eval ladder), not the arena. The
   pill says Snapshot or Live, but not what is live.

## 3. Principles

1. **Objects first.** Bot, Game, Run (a ladder or arena round), Competitor, Finding, Experiment, Research line.
   Each has exactly one page and one URL, and every mention of it anywhere is a link to that page.
2. **Now, then recent, then everything.** Every page opens with what is live or new, then a summary, and keeps full
   tables one click away (Show all / filters), never all at once.
3. **One rating, with its scope in the label.** "Rating" = Bradley-Terry (`bot/ratings.js` method) with the Atlas's
   bot names (`meta/analyze.js` canonical, as of 18:30: random-a/b/c = random; in runs before the heuristic
   fix, heuristic = legacy and its profiles legacy-aggro, legacy-tempo, legacy-control) and its rules (only decided games and forfeits count). Measured 2026-10-11 18:38: 72
   of 75 bots within 15 points of the Atlas, median 3 (gaps are games newer than the Atlas's hourly refresh). Arena pages say "Arena rating, round k" or "all rounds". Sequential Elo stays
   only as the "form" line on a bot page (it shows change over time, which BT cannot).
4. **One colour system everywhere.** Family colours come from the Atlas kit (`AtlasKit.FAMILIES`), one source for
   the Atlas, the dashboard and the app. Since 18:30 the kit carries the console's hue bands (search blue, learned
   violet, LLM teal, heuristic orange, rules gold, random grey, other khaki); each bot gets its own shade in its
   family's band. Green and red only for good and bad. Arena builders take their family's colour plus system chips.
5. **Live is a mode with a named source.** The header always says what is live: "Arena round 2 · ladder · 14/60
   games", or "No live games · last game 4 min ago (eval-ladder-8)".
6. **Two audiences, one app.** Public build (Fly, friends): Home, Arena, Bots, Games. Project build
   (artifact, Eric and threads) adds Lab: work threads, data health, things waiting on Eric.
7. **Plain words.** Owners are shown as what the bot is ("Rust rule bots"), not thread names. Labels say what a
   number is in the reader's words (win chance, base HP), with the method one hover away.
8. **No splats (Eric, 18:19).** A result is drawn with the building block about the same objects, never as a
   stat box or a generic bar list: a result between two bots = a small face-off (split bar, face-off colours,
   both bots' Atlas style); one bot's score = the run tables' score bar with the 50% line; a bot = its chip with
   Atlas style, nine-spot strip and rating; an evaluator = a dot on the Evaluators page's Brier scale with the bot
   that plays with it; a position = the console's board glyph; a game = a small board or the viewer. App code:
   `vsRow()` and `scoreRow()` in app.js.

## 4. Structure

Top bar: logo, four sections, live status chip, search (press `/`): jump to any bot, game, run or page.
Phone: the four sections move to a bottom tab bar; Lab sits in the menu.

```
Home
Arena      Live · Standings · Builders → builder page · Rounds → round page · Join
Bots       All bots, with the Atlas built in (filter by family, style; sort by any spot) → bot page · Face-off ·
           Speed · Evaluators
Games      Now playing (grid of small live boards) · All games (filter) → game page · Runs → run page
Lab        Work threads · Waiting on Eric · Data health          (project build only)
```

2026-10-14 (Eric): only Speed and Evaluators of the old Research section made sense to a reader, so they moved under
Bots and the rest (findings, position analysis, experiments, research lines) left the app; the data stays in the
window's store and MCP. Games against people left too: they get their own page on the Karabast Sprite.

### Home
- **Live hero** (Eric 18:18: "excellent and exciting"): the arena game when a round's ladder runs, else the newest
  game; compact viewer-kit board that keeps playing; both bots as links; "Watch" opens the game page.
- **Also playing**: four small boards from Now playing, linking to the full grid.
- **Arena card**: phase and clock (work phase 42 min left / ladder 14 of 60 games / idle: next round), leader, link.
- **Top bots**: top 8 by rating with family colour, record and a form sparkline.
- **What we learned**: the bottom line and the findings with their verdict pills (holds / consistent / lead / not
  tested), from the Lean x meta research section.
- **What's new**: one merged feed from file timestamps (run finished, new bot rated, experiment changed status,
  research line posted a thought, arena version submitted). Newest first, 12 items, "since your last visit" marker.
- **Waiting on you** (project build): threads blocked or ready for review, with links.

### Arena (Eric 18:18: builders, the systems that build bots, compete)
- **How it works** diagram on Live, Builders and the Home card (Eric 18:56: a picture of the parts, plain labels,
  no "Not a X, a Y"): the real roster's builder cards (model, effort, memory, or script) on the left, each wired to
  its bot; all bots, baselines included, on one ring with a line for every pairing; a dashed return arrow for each
  round's report and lost games. Phones get the compact version. Next to it, what the tournament compares (model,
  effort, memory, same setup run again, a script with no LLM), derived from the roster.
- **Live** (default): phase banner + clock. Ladder phase: live board on the left, the round's game grid (every pair,
  done / playing / queued, colour = who won) and the round's standings updating on the right. Work phase: a feed of
  every competitor's thoughts and submissions, newest first, plus each one's strategy diagram. Idle: roster, the
  schedule and the last round's result.
- **Standings**: rating by round (one line per competitor), table per round, all-round table.
- **Builders**: a table of the systems with the cells that differ from most others highlighted, then one card each
  (system chips, "now" line, the bots it built with their ratings, spot strip of the newest). **Builder page**: versions as a timeline (vN, note, rating that round), current thinking (now, idea, plan,
  thoughts), animated strategy diagram, results per opponent, lost games (links to game pages).
- **Rounds**: each round's report (rendered from rounds/rK.md) and its games.
- **Join** (hosted): how to connect (MCP / HTTP / CLI), register, submit.

### Bots
- **All bots** (the Atlas built in): the animated spot guide with its nine spot buttons, verdict and standouts on
  top; one table with rating ± 2 SE, every bot's edge in all nine spots (grouped When behind / Close or long / When
  ahead, ★ best in spot, faded under 5 games, "no spot map yet" for unmapped bots), style, games, win %, form, speed;
  family rows (search, 1-ply, learned) at the foot. Clicking a spot (button or column) sorts by it and ranks the bots
  with 8+ games there ("who to bet on"); `#/bots?spot=<id>` links to that. Filters: family, style, name. Phone: the
  nine columns fold into the 9-cell strip. Face-off stays a sub-tab.
- **Bot page**: header (name in family colour, language, one line, rating, rank, record); How it plays (bot card:
  how, sees, lookahead, strengths, weaknesses, variants, code); Form (sequential Elo over games); Where it wins
  (9 spots, edge vs an average bot and vs its own level); Opponents (W-L per opponent, sorted by games); Speed
  (p50/p95 against the field); Its research line (the panel: now, plan, thoughts, widgets); Games (latest, lost).

### Games
- **Now playing** (default): every running game as a small board drawn in the Atlas's picture language from a slim
  replay state (`SWUApp.slimState`): base HP left, units with power (space units outlined, damage dot), hand size,
  resources, initiative, round, HP lead; under it the spots each side is in and that bot's edge there. Snapshot:
  boards replay ~60 frames per game cut by `app/build.mjs` (`DATA.traces`). Live: running games read the end of their
  replay file every 5 s (one read each, from the last offset); finished games read it once. Runs that keep no replay
  files (anchored-ladder-1) are listed without a board. Then "Just finished", at most 3 per run.
- **All games**: 6,593 games in 56 runs, 2,798 with replays. Filters: bot, run, result, length, has analysis.
- **Game page**: the shared viewer kit, full layout, with evals and lens when they exist; header with both bots, the
  run and the result; pivotal plays; analysis curves under the board.
- **Runs**: each ladder or round with date, bots, games, winner. **Run page**: standings in that run, crosstable,
  its games.

### Research
Audited after Eric's 18:19 note; every page now draws its results with the shared pieces (principle 8).
- **Overview**: bottom line and the six findings; each finding carries its own picture: evaluator curves (same
  chart as Evaluators), each family's edge in the nine Atlas spots with the claim's spots lit, TD loss against
  proven endings (scatter), and two-bot comparisons (chips, gap, head to head, face-off link).
- **Evaluators**: curves with the three best and the references coloured, the rest faint; the TD-loss scatter; the
  table puts each evaluator on the Brier scale next to the bot that plays with it (h@name, style, rating).
- **Position analysis**: the four win-chance curves drawn on the page, the hidden-information and luck gaps as
  numbers, and the checkpoints where the all-seeing view moved most with the analyst's notes.
- **Experiments**: hypothesis, progress, then `evidence()`: face-offs, score bars, the Brier scale, and for the
  solver study a game-length bar with the proved part lit (about 100 windows, last 3.4 proved); linked runs.
- **Research lines**: one row per line on one rating axis, a dot per bot it produced, its best bot's style and
  nine spots; tools and studies listed under it. A line page starts with its bots in the Bots table's terms, then
  its experiments, its panel and its widgets (bot names become chips, search trees use the console's board glyphs,
  custom views run in a sandboxed frame).
- **Speed** (now "Speed and strength"): time per decision against rating, the line joining bots nothing beats on
  both; the timing table folded. Fixed: legacy twins no longer repeat the fixed bot's timing.
- Run pages and arena standings: standings with style and nine spots next to the every-pair grid; a run an
  experiment names shows "Why this run".

### Lab (project only)
Work threads (status board, live checklist through the Claude Code Remote connector), Waiting on Eric (blocked /
review-ready threads and open decision pages), Data health (files that failed to parse, stale producers, example
data still showing).

## 5. Behaviour

- **URLs**: `#/bots/rust-search`, `#/games/<run>/<game>?step=300`, `#/arena/competitors/pimc_1`. Hosted: real paths.
- **Live data**: the project build reads the shared folder through the artifact `files` capability (same reader as
  the console: re-read every 12 s, tail a running game every 1.5 s). The hosted build reads the arena HTTP API plus
  results/. Both run the same page code over one data adapter.
- **Opening any game**: snapshot mode bundles a few games; live mode loads any replay on demand, so every game in
  the list opens in the viewer.
- **Search**: one index of bots, competitors, runs, games (by id and bots), pages.
- **Phone**: one column, bottom tabs, the board in its compact layout, tables scroll inside their own box.

## 6. What it reuses (no new data formats)

Dashboard contract (league, experiments, evals, panels, bot cards, lens), `dashboard/site/core.cjs` (loader, league,
speed), `meta/meta.json` (spots), `research/eval-theory/td-report.json` (evaluators), arena files (`roster.json`,
`standings.json`, `rounds/`, `versions/*/SUBMISSION.json`, arena panels), the viewer kit, `arena/strategy` renderer.

## 7. Changes owners would need (sent through the coordinator, not made here)

- Strategy meta analyzer (`meta/`): (a) family colours: done at 18:30 (the kit now has the console's bands and a
  rules family); (b) shared module: already existed, `meta/kit/atlas-kit.js`, imported by the dashboard and the app;
  (c) one ratings file for every bot, mapped or not: done (`meta/ratings.json`, fork PR #81). The app reads it and
  fits only the bots it does not list yet.
- Recorder (core code, if Eric picks it in Pick 3): write a slim board trace for every game even when full replays
  are off (about 19 KB a game against about 200 KB, measured on eval-ladder-8), so every running game gets a board in
  Now playing and every bot a spot map.
- Arena (`bot/arena/web/`): adopt the app shell or redirect `/` to the app; keep `/api`.
- Research dashboard contract: add result widget types so owners stop posting bot results as stat boxes and bar
  lists: `faceoff` ({a, b, share, n}), `score` ({bot, value}), `spots` ({bot}), drawn by the same pieces as the app.
- Research dashboard: none needed for the prototype; if Eric picks this structure, its section renderers move
  into a shared module the app imports.
