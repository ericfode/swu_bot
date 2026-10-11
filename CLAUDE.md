# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A single-player Star Wars Unlimited (SWU) client with an AI opponent. It drives the real forceteki rules engine headlessly (no web client, lobby or socket layer). Planned bot ladder: random -> heuristic -> search -> (maybe) learned policy. `bot/HANDOFF.md` has the full state, measurements and next steps; read it first (note: its layout section predates the submodule move below).

## Repo layout (tiered git repos)

- `forceteki/` — **git submodule** of `SWU-Karabast/forceteki`, pinned to upstream `2be4fcd`. It has its own `CLAUDE.md` describing the engine; that file applies when working inside it.
- `bot/` — all new code lives here (plain CommonJS JS, no build step).

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

There is no test suite or linter for `bot/` of its own; the sanity check is the random-run command above (seeds 1-3 give 594/342/486 steps, p2/p2/p2 winners — runs are deterministic).

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
