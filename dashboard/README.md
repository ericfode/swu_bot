# Research dashboard: shared code

`site/core.cjs` and `site/glyph.cjs` are the research dashboard's data loader and board glyph, kept here so the app
(`app/`, `npm run app`) can import them from the repo and needs the shared project folder only for data.

- `site/core.cjs`: `loadSources(reader)` reads every result source the dashboard uses (tournament indexes under
  `results/`, `dashboard/league`, experiments, evals, panels, bot cards, `meta/meta.json`, `meta/ratings.json`,
  `research/eval-theory/td-report.json`); `computeLeague(runs, botMeta, ratings)` ranks bots by the Strategy Atlas
  rating (`meta/ratings.json`) and keeps the running Elo as form; `computePerf`, `pickLiveGame`, `liveCandidates`,
  `atlasRating`. Works in Node (`require`) and in the browser (`window.SWU`); no dependencies.
- `site/glyph.cjs`: `glyph(state, opts)` draws a recorder Snapshot as a small board icon; `tree()` draws a search
  tree of them. Node (`require`) or browser (`window.SWUGlyph`); no dependencies.

The dashboard itself (page template, build script, data contract) lives in the shared folder,
`/mnt/project-files/dashboard/` (contract: its `README.md`). The "Research dashboard" thread owns both copies and
sends a PR here whenever it changes these two files there.
