# Holotable

A second tournament and replay viewer for the bot lab. It reads the **same files** as `viewer/` (`replays/<id>/index.json` and `games/<id>.jsonl`, written by `bot/tournament.js` and `bot/recorder.js`) and uses the same deep links (`#/t/<tournament>/g/<game>?step=300`), so the two viewers are interchangeable on any replays folder.

Stack: Vite + React 19 + TypeScript, Tailwind CSS v4, Motion (animation), Recharts, cmdk (command palette), Zustand, Lucide icons.

## Run

```bash
cd studio && npm install
npm run dev                         # http://localhost:5190, serves ../replays itself (no server.cjs needed)
REPLAYS_DIR=/path/to/replays npm run dev
EVALS_DIR=… LENS_DIR=… npm run dev  # also serve position evaluations (/evals/<gameId>.json) and lens files (/lens/<gameId>.json, /lens/<dir>/<gameId>.json, /lens/evaluators.json)
CARD_TEXT=/path/card-text.json npm run dev  # printed card data at /card-text.json (default /mnt/project-files/viewer-kit/card-text.json when it exists; CARD_TEXT= to turn off)
npm run build && npm run preview    # production build, same /api and /replays routes
```

From the repo root: `npm run studio:dev`, or `npm run studio` for build + preview.

### Without real games

The engine's card data can't be downloaded everywhere, so `fixtures/generate.mjs` writes two hand-made tournaments in the exact replay format (a simplified SWU-like game; one game is left without an end record to show live following):

```bash
npm run fixtures                                   # -> fixtures/replays/
REPLAYS_DIR=$PWD/fixtures/replays npm run dev
npm run build:static                               # one self-contained HTML file with the fixtures baked in -> dist-static/
STATIC_REPLAYS=../replays npm run build:static     # same, with real tournaments instead (colon-separate several folders)
STATIC_EVALS=… STATIC_LENS=… npm run build:static  # also bake in evaluations and lens files (one <gameId>.json each; STATIC_LENS subfolders and evaluators.json too)
STATIC_DATA=files STATIC_REPLAYS=… npm run build:static  # keep the data out of the page: staged in static-data/data/ to publish beside it
```

Both static builds also stage the printed card data (`CARD_TEXT`, same default as above) as `card-text.json`, cut down to the cards in the staged games (~240 KB for the 18 real games): baked into the page, or `data/card-text.json` with `STATIC_DATA=files`.

A single-file page has to stay under 16 MB, which holds about 28 games. With `STATIC_DATA=files` the page is ~1 MB and fetches `data/manifest.json`, `data/<tournament>/…` and `data/_evals|_lens/<gameId>.json` relative to itself when opened, so a preview can carry over a hundred games. Pair it with an art pack (`scripts/art-pack.py`, split into parts when big) published as `art-pack.json` beside the page.

The original viewer reads the same fixtures: `REPLAYS_DIR=$PWD/studio/fixtures/replays node viewer/server.cjs`.

## What's in it

- **Tournaments**: standings with Elo (same K=24 sequential rules as `viewer/`), recent form, the Elo race over the tournament, a head-to-head heat map, first-seat win rate, and a filterable game list. Indexes with running games refresh every 2 s.
- **Replay**: the table laid out as in SWU (ground arena, base and leader, space arena per seat), units animated in and out, damage and healing pop-ups, base HP rings, the initiative token sliding between seats, exhausted cards turned, hidden hands per perspective.
- **Momentum timeline**: base HP, board power, hand size and the chosen score (from player 1's side) for every decision, with round bands; position evaluations add four P(p1 wins) curves. A score with a fitted or its own chance is drawn on the 0-100% axis; a rough or uncalibrated one is dashed on its own axis. Click or drag it to seek.
- **Scores** (`src/data/score.ts`): each lens file is one score (swu-lens/1, format in `/mnt/project-files/omni/LENS.md` plus `/mnt/project-files/viewer-kit/LENS-proposal.md`). The viewer reads its label, unit, chance, weights per step and parts from the file, never from built-in constants; the only built-in score is Omni v1 (`src/data/omniV1.ts`), used for old omni files and, estimated from the board, for games with no file. Files live at `lens/<gameId>.json` (the default path) and `lens/<dir>/<gameId>.json`, listed in `lens/evaluators.json`. With two or more for a game a **Score** picker appears (`?score=<dir>` deep links one; the pick is saved), and the board, chips, breakdown, inspector, timeline and swings all follow the chosen score.
- **Card values** (header button, a card with a value chip): every card's value in the chosen score drawn on the card, with the search's verdicts on the boards it searched. On by default when the score has a file for the game. Each part of the score has one colour and icon (`src/data/terms.ts`, `components/TermIcon.tsx`) used on the cards, the totals, the legend and the breakdown, so a number leads to its row. The **Board score** tab breaks the step into those parts with their rules; the **Weights** tab lists the weights in force.
- **Card inspector**: the hovered card at a readable size in the side panel, or next to the pointer when there is no side panel. Leader fronts and bases are drawn landscape.
- **Card text** (`src/lib/cardText.ts`, `components/CardFace.tsx`): with printed card data loaded (`card-text.json`, `swu-card-text/1` from `viewer-kit/make-card-text.py`, keyed by set code like a replay card's `s`), a card with no image (Vector, missing art, a failed image, an unreleased set) is drawn in the inspector as a readable text face: name, subtitle, cost, aspect pips, type, arena and traits, rules text (triggers bold, `[costs]` boxed, reminder text dim), a leader's epic action and deployed side, printed power/HP, upgrade bonus or base HP; the type size steps down until the text fits. Tiles take their real aspect colours (Vigilance blue, Command green, Aggression rust red, Cunning yellow, Heroism off-white, Villainy black; several aspects split across the diagonal), shaded away from the seat colours and the score violet. Without the data, cards keep the monogram tiles in muted per-name tones. The app asks its data source for it (`/card-text.json` from the dev/preview server, `card-text.json` in a static build); the kit takes `cardText` in mount options or `SWUViewer.loadCardText(url | object)`.
- **Tokens**: units with no set code (the recorder writes `s: null` for tokens: Battle Droid, Clone Trooper, X-Wing, Mandalorian, Beast, Spy…) carry a TOKEN tag on the card; token upgrades (Shield, Experience, Advantage, Weakness) are the light `t: 1` chips.
- **Decision log** grouped by round, with what each decision changed (units entering or defeated, base damage, resources).
- Keyboard: ← → step, shift for 10, `[` `]` (or ↑ ↓) jump a round, space play, Home/End, ⌘K / Ctrl+K command palette.
- Live games (no end record yet) are re-read every second; the view follows the newest move until you scrub away.

## Layout

- `src/data/` — format types (copied from `viewer/src/core/types.ts`), loading (`source.ts`, `staticSource.ts`), derived metrics and unit tracking (`derive.ts`), standings (`stats.ts`), action classes (`actions.ts`), evaluations (`evals.ts`), lens files and scores (`lensFile.ts` reads a file, `score.ts` resolves a score over a game, `calibrate.ts` chance maps, `terms.ts` rows, `omniV1.ts` the built-in Omni v1).
- `src/components/` — `Board`, `Card`, `CardZoom` (inspector and floating zoom), `Momentum`, `Log`, `Shell` (nav and command palette).
- `src/kit/` — the embeddable viewer (`GameViewer`) and the `SWUViewer` bundle (`npm run build:kit`).
- `src/pages/` — home, tournament and game pages.
- `vite.config.ts` — includes a small plugin that serves `/api/tournaments` and `/replays/*` exactly like `viewer/server.cjs`.
