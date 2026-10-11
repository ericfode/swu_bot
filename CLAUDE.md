# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A single-player Star Wars Unlimited (SWU) client with an AI opponent. It drives the real forceteki rules engine headlessly (no web client, lobby or socket layer). Planned bot ladder: random -> heuristic -> search -> (maybe) learned policy. `bot/HANDOFF.md` has the full state, measurements and next steps; read it first (note: its layout section predates the submodule move below).

## Repo layout (tiered git repos)

- `forceteki/` — **git submodule** of `SWU-Karabast/forceteki`, pinned to upstream `2be4fcd`. It has its own `CLAUDE.md` describing the engine; that file applies when working inside it.
- `bot/` — headless environment, recorder, bots and tournament runner (plain CommonJS JS, no build step).
- `viewer/` — replay and tournament viewer (Vite + React + TypeScript, own `package.json`) plus a dependency-free `server.cjs`.
- `replays/` — recorded tournaments (gitignored): `replays/<id>/index.json` and `games/<id>.jsonl`.

**Do not modify anything inside `forceteki/` without asking the user first.** Bug workarounds belong in `bot/`. Upgrading the engine means moving the submodule pin and committing it in this repo.

## Commands

Engine setup (once, inside the submodule; Node 22.x required):

```bash
cd forceteki && npm install && npm run get-cards && npm run build
```

`bot/` loads the engine from `forceteki/build/server` and card data from `forceteki/test/json` (both gitignored, so they must exist). After engine changes, rebuild with `npm run build` in `forceteki/`. If you hit `Importing card class with repeated id!`, delete `forceteki/build/` and rebuild.

Run from the **swu_bot repo root**:

```bash
node bot/random-run.js [games] [startSeed] [maxSteps]   # e.g. node bot/random-run.js 5 1 6000
node bot/debug-seed.js <seed>                           # replay one seed, dump last actions + prompt state on error
```

`npm test` covers the pure parts (ratings, report, bot choices on mock boards); the end-to-end sanity check is the random-run command above (seeds 1-3 give 594/342/486 steps, p2/p2/p2 winners — runs are deterministic).

## Recording and viewing

```bash
npm run demo                 # 3 random bots, 4 games per pairing -> replays/demo
npm run viewer               # build viewer/, serve on http://localhost:5180 (PORT, REPLAYS_DIR to override)
npm run viewer:dev           # Vite dev server; proxies /api and /replays to :5180 (run server.cjs too)
npm run gate                 # determinism gate: seeds 1-3 = 594/342/486 steps, p2 wins, with recording on
npm run ladder -- --bots rush,aggro,tempo,control,heuristic,random --games 10   # round robin -> results JSON (see bot/README.md)
npm test                     # unit tests (ratings, ladder report, bot logic on mock boards); no card data needed
npm run lint                 # Perch semantic lint with Jev (see "Linting" below)
```

- Replay format is decisions plus a compact board snapshot per step, so the viewer never needs the engine. Files are ~0.6-1.4 MB each but ~25 KB gzipped on the wire. Format and snapshot fields: `bot/recorder.js`, types in `viewer/src/core/types.ts`.
- `viewer/src/core/` (Board, CardView, Replay, api, stats) is shared by the tournament page and the single-game page; both embed the same `<Replay game={...} />`.
- Card art comes from `https://cdn.swu-db.com/images/cards/<SET>/<NNN>.png` (`-b` suffix = deployed leader side). Tokens and unreleased sets (e.g. TS26) have no art and fall back to stat tiles automatically; Card art can also be toggled off.
- Deep link to a step: `#/t/<tournament>/g/<game>?step=300`.

## Linting (Perch + Jev)

[Perch](https://github.com/lakeday-org/perch) (`@lakeday/perch`, a root devDependency) is a semantic linter: it asks TypeSafe's Jev model about each method and reports likely defects with a confidence.

```bash
npm install                  # once, at the repo root (or the cloud setup script installs perch globally)
npm run lint                 # committed code changed since origin/main; exit 3 = findings
npm run lint:full            # every method in the repo; only when there is a reason
npm run perch -- issues      # any perch command: issues, check <file::method>, close <id> --reason ...
npm run perch -- usage 7     # Jev requests per day, from the shared ledger
```

Usage rule: lint is advisory, never a gate. Run `npm run lint` once after committing, before you open or update a PR. Do not re-run it hoping for other answers. Treat findings under ~75% as leads to check, not facts.

- `tools/bin/perch` sets `PERCH_BASE_URL` to TypeSafe System One (model `jev-latest`) and turns on `NODE_USE_ENV_PROXY` when `HTTPS_PROXY` is set. Locally, export `PERCH_API_KEY` or `TYPESAFE_API_KEY`. In Claude Code cloud sessions the egress proxy injects the Jev key, so no key is needed.
- Limits in the wrapper: `scan` and `coverage` need a scope (a path, `--since` or `--paths`; the whole repo needs `--full`), `--parallel` defaults to 8, one run at a time per checkout, and a 15 minute timeout (`PERCH_TIMEOUT_MIN`).
- `tools/perch/jev-cache.mjs` caches Jev answers by request content, so unchanged code is free and gets the same verdict every run (fresh answers vary by up to ±0.06). `--force` asks again. It also enforces budgets: `PERCH_RUN_REQUESTS` (default 250) per run and `PERCH_DAILY_REQUESTS` (default 1000) per UTC day for the whole project; over budget, perch stops with HTTP 402.
- The cache, the usage ledger and the off switch live in `/mnt/project-files/perch/` when that folder exists (shared by all threads), else in `.perch/jev/` (`PERCH_JEV_DIR` overrides). `PERCH_DISABLED=1` or a `DISABLED` file there turns off every Jev command (exit 0).
- Config is `perch.yaml` (ignores `forceteki/` and generated output; no custom rules yet). Results go to `.perch/` (gitignored, except `.perch/rules/` and `.perch/closed.jsonl`, which are committed).
- Findings are probabilities, not facts. Read the code before changing it, and `perch close <id> --reason "..."` false positives. `perch ci`, `perch cloud` and `perch login` need Perch Cloud, which this repo does not use.

## Architecture of `bot/env.js`

`env.js` constructs a forceteki `Game` directly instead of going through the server:

- `Env` loads card data once (first `require` of the ~2000 card modules takes ~7 s, so do it once per process) and builds random 50-card decks (not validated by the project's `DeckValidator`).
- `EnvGame` wraps one game: `start()`, `legalActions(pid)`, `apply(pid, action, rng)`, `over`, `winners`, `round`, `promptSignature(pid)`.
- Actions are plain objects of kind `button`, `card`, `option`, `displayCard`, `perCardButton`, `distribute`.
- "Who must act" = whichever player has at least one legal action; the waiting player's prompt has no buttons and no selectable cards.
- Game over is `game.winnerNames.length > 0`.
- The bot RNG (`seededRng`) and engine RNG (`game.setRandomSeed`) are separate; seed both for reproducibility.
- Undo/snapshots are off by default; `newGame({ undo: true })` enables `UndoMode.Full` (needed for rollback-based search).

Engine input is always followed by `game.continue()`. Prompt-handling rules already encoded in `env.js` that are easy to get wrong:

- The distribute-damage/healing `Done` button has `command: 'statefulPromptResults'` — send the split that way, never as a menu click. Indirect damage on a unit may not exceed its `remainingHp` (bases uncapped), and the sum must equal `amount` unless `canDistributeLess`.
- "Cards with buttons" display prompts (`perCardButtons` present): cards are not clickable; only per-card buttons are legal. Plain display-selection prompts click the card via `menuButton(pid, cardUuid, promptUuid, 'menuButton')`.
- Number prompts and dropdowns answer with `menuButton(pid, String(value), promptUuid)`. Multi-select card prompts: click cards, then `Done`.
- `build/` only compiles `server/`; the test harness helpers (`forceteki/test/helpers/*`) depend on Jasmine globals, so `env.js` does not use them.

## Known engine bugs (found by random play, not fixed — engine is read-only here)

1. `TakeCover.ts`: `.card` read from an undefined heal event throws, even during playability checks. Repro: `node bot/debug-seed.js 8`.
2. Maul, Master of the Shadow Collective: choosing "Choose nothing" threw `Expected exactly one target for delayed effect but found 0`. Not reproducible by seed yet.

Treat engine errors during random play as findings to report, not something to patch in `forceteki/`.
