# Holotable

A second tournament and replay viewer for the bot lab. It reads the **same files** as `viewer/` (`replays/<id>/index.json` and `games/<id>.jsonl`, written by `bot/tournament.js` and `bot/recorder.js`) and uses the same deep links (`#/t/<tournament>/g/<game>?step=300`), so the two viewers are interchangeable on any replays folder.

Stack: Vite + React 19 + TypeScript, Tailwind CSS v4, Motion (animation), Recharts, cmdk (command palette), Zustand, Lucide icons.

## Run

```bash
cd studio && npm install
npm run dev                         # http://localhost:5190, serves ../replays itself (no server.cjs needed)
REPLAYS_DIR=/path/to/replays npm run dev
npm run build && npm run preview    # production build, same /api and /replays routes
```

From the repo root: `npm run studio:dev`, or `npm run studio` for build + preview.

### Without real games

The engine's card data can't be downloaded everywhere, so `fixtures/generate.mjs` writes two hand-made tournaments in the exact replay format (a simplified SWU-like game; one game is left without an end record to show live following):

```bash
npm run fixtures                                   # -> fixtures/replays/
REPLAYS_DIR=$PWD/fixtures/replays npm run dev
npm run build:static                               # one self-contained HTML file with the fixtures baked in -> dist-static/
```

The original viewer reads the same fixtures: `REPLAYS_DIR=$PWD/studio/fixtures/replays node viewer/server.cjs`.

## What's in it

- **Tournaments**: standings with Elo (same K=24 sequential rules as `viewer/`), recent form, the Elo race over the tournament, a head-to-head heat map, first-seat win rate, and a filterable game list. Indexes with running games refresh every 2 s.
- **Replay**: the table laid out as in SWU (ground arena, base and leader, space arena per seat), units animated in and out, damage and healing pop-ups, base HP rings, the initiative token sliding between seats, exhausted cards turned, hidden hands per perspective.
- **Momentum timeline**: base HP, board power, hand size and a simple material edge for every decision, with round bands. Click or drag it to seek. The material edge is a placeholder lane; evaluator curves (heuristic scores, LLM analysis) are meant to plug in as more lanes in `src/components/Momentum.tsx`.
- **Decision log** grouped by round, with what each decision changed (units entering or defeated, base damage, resources).
- Keyboard: ← → step, shift for 10, `[` `]` (or ↑ ↓) jump a round, space play, Home/End, ⌘K / Ctrl+K command palette.
- Live games (no end record yet) are re-read every second; the view follows the newest move until you scrub away.

## Layout

- `src/data/` — format types (copied from `viewer/src/core/types.ts`), loading (`source.ts`, `staticSource.ts`), derived metrics and unit tracking (`derive.ts`), standings (`stats.ts`).
- `src/components/` — `Board`, `Card`, `Momentum`, `Log`, `Shell` (nav and command palette).
- `src/pages/` — home, tournament and game pages.
- `vite.config.ts` — includes a small plugin that serves `/api/tournaments` and `/replays/*` exactly like `viewer/server.cjs`.
