# SWU Arena app

One web app to watch the arena and read the research: Home (the game playing now, live boards, the arena, top
bots, what we learned), Arena, Bots, Games, Research and, in the project build only, Lab. The design and the reasons
behind it are in [DESIGN.md](DESIGN.md).

It builds into one self-contained HTML file. The file carries a snapshot of the data, a few full replays and small
board traces for the live grid. Opened as a Claude artifact with the project's files allowed, it switches to live
data and reads the shared folder every 15 s.

## Build

```bash
npm run app                          # project build -> app/dist/app.html
npm run app -- --public              # public build  -> app/dist/public.html
npm run app -- --public --shell      # no data: the arena window's page, which loads its data from the window's API
node app/build.mjs --data DIR --out FILE
```

`--data` is the shared project folder (default `$SWU_DATA`, else `/mnt/project-files`). The build prints one JSON
line: output path, size, bot and game counts, where ratings came from, and any part it could not find.

| | Project build | Public build (Eric's pick 6) |
|---|---|---|
| Lab (work threads, waiting on Eric, data health) | yes | no |
| Which thread built a bot, owns a line or ran an experiment | yes | removed from the data, not only hidden |
| Live mode (reads the shared folder) | yes | no |
| Everything else | yes | yes |

## What it reads

The app adds no data format. Each part belongs to the thread that writes it; the app only reads it.

| Input | Path in the data folder | Owner |
|---|---|---|
| Runs, bot cards, panels, experiments, evals, threads | `results/`, `dashboard/` | Research dashboard (contract: `dashboard/README.md`) |
| Loader and board glyphs | `dashboard/site/core.cjs`, `dashboard/site/glyph.cjs` | Research dashboard |
| Spots, styles, edges | `meta/meta.json` | Strategy meta analyzer |
| Ratings (Atlas rules, one file for every bot) | `meta/ratings.json` | Strategy meta analyzer |
| Atlas words, icons and colours | `meta/atlas-kit.js` in this repo (else `meta/kit/` in the data folder) | Strategy meta analyzer |
| Board viewer | `studio/dist-kit/` after `npm --prefix studio run build:kit` (else `viewer-kit/`) | Holotable |
| Arena roster, tournament, standings, rounds, versions | `arena/` | Arena |
| Strategy diagrams | `arena/strategy/strategy-diagram.js` | Arena |
| Card art (webp) | `card-art/<SET>/<NNN>.webp` | shared folder (official card images) |

Ratings: every bot listed in `meta/ratings.json` shows that rating. A bot not listed yet (games newer than the meta
analyzer's hourly refresh, or runs it skips) gets the app's own Bradley-Terry fit with the same rules, and Lab > Data
health lists it.

## Tokens

All in `src/style.css` `:root`; use them, never a raw size or colour.

- Type: eight sizes, `--fs-2xs` 10px, `--fs-xs` 11, `--fs-sm` 12, `--fs-md` 13, `--fs-base` 14, `--fs-lg` 16,
  `--fs-xl` 20, `--fs-2xl` 26. Text is never smaller than 10px. Pixel sizes remain only inside SVG drawings, where
  they are drawing units.
- Spacing: `--sp-2` to `--sp-24` (2, 4, 6, 8, 10, 12, 16, 24px); `--gap` is the grid gap.
- Corners: `--r-xs` 2px (bars, cells), `--r-sm` 4px (chips, pills), `--r` 6px (boxes), `--r-lg` 12px (tiles,
  dialogs), `--r-pill`.
- Colour: page tokens (`--ink`, `--muted`, `--faint`, `--accent`, ...) in light and dark; every text colour passes
  4.5:1 on the surface. The Atlas colours (spot-edge ramp `--pos-*`/`--neg-*`, `--you`, `--them`, `--clock`,
  `--mid`, family colours `--f-*`) come from the kit: the build inlines `AtlasKit.css()` ahead of the stylesheet.

Owners' result widgets (dashboard contract section 5) draw with the same pieces: `faceoff` as the face-off bar,
`score` as the score bar with the 50% line, `spots` as the bots table with each bot's nine spots.

## Code

- `src/page.html`: the page shell; `build.mjs` inlines everything into it.
- `src/style.css`: one stylesheet, light and dark (the header button cycles system, light, dark).
- `src/model.cjs`: the data model shared by the build (Node) and the page (live mode). Bot names follow the Atlas
  (`random-a/b/c` are `random`; before the heuristic fix, `heuristic` is `legacy`).
- `src/atlas.js`: spot rules on a replay snapshot, built on the Atlas kit.
- `src/app.js`: routes and pages. Results are drawn with shared pieces (face-off bar, score bar with the 50% line,
  Brier scale, nine-spot strip, board glyph), never as stat boxes.
- `test/`: unit tests for the model (`npm test` runs them; no card data needed).

## Next

- Hosted: the arena window (`bot/arena/WINDOW.md`) serves a shell build (`--public --shell`, no data) and the page
  loads everything from the window's API: the model from `/api/app` (built there by the same loaders), replays from
  `/api/replays`, card art from the public card CDN.
- Commit the console's `core.cjs` and `glyph.cjs` into the repo (Research dashboard thread), so a build needs only
  the data folder for data.
