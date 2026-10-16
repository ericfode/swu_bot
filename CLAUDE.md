# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The SWU Arena: a Star Wars Unlimited arena where bots play each other on the real forceteki rules engine, driven headlessly (no web client, lobby or socket layer). It holds only what the live arena runs: the game player and referee, the arena window and API, the arena server that runs the games machine, the SWU Arena app, the bot interface spec and the arena's baseline bots (random, rush, the heuristic family). `README.md` has setup, daily commands and "Where things went"; `bot/README.md` describes the player, the referee and the built-in bots.

## Where things went (October 2026 split)

- [holocron](https://github.com/ericfode/holocron) (`ericfode/holocron`): every research bot (ISMCTS, omni, learned, JEPA, Jev, the bots in other languages), `bot/examples/`, evaluators, learning, deck building, analysis, the meta analyzer and Strategy Atlas model, Lean theory, the importer and the Karabast player, sweeps and measurement scripts. It keeps a copy of the game player under `engine/`: fix player bugs here first, then copy the fix there.
- [kessel](https://github.com/ericfode/kessel) (`ericfode/kessel`): the Rust rules simulator, its WebAssembly build and the card compiler (were `bot/omni-rs`, `bot/omni-wasm`, `bot/card-compiler`, `bot/cards`). The referee runs a prebuilt copy from `vendor/kessel`.
- [holotable](https://github.com/ericfode/holotable) (`ericfode/holotable`): the replay and tournament viewer (was `studio/`). The app and the window embed its prebuilt viewer kit from `vendor/holotable`.
- Everything moved is still in this repo's history; a few files moved nowhere (`bot/protocol-test.js`, `bot/rollback-test.js`, `bot/determinism-check.js`, `bot/karabast/feed.js`, Kessel's reference-game generator under `bot/cards/reference/`, the card-conversion skill). New research code goes to holocron, not here.

## Repo layout

- `forceteki/` — **git submodule** of `ericfode/forceteki`, pinned to `2ebed8ca2` (upstream `SWU-Karabast/forceteki` plus the search-engine optimizations). It has its own `CLAUDE.md` describing the engine; that file applies when working inside it.
- `bot/` — headless environment, referee (`protocol.js`), recorder, built-in bots, ladder and tournament runners (plain CommonJS JS, no build step). Protocol bots get card data only in `hello.cards` (`bot/game-cards.js`, `spec/protocol.md`): no bot is handed a card folder, `/cards` or `SWU_CARD_JSON`, locally or in the arena; in-process native bots (random, rush, heuristic) read the engine's card objects. `bot/sims/` runs the referee's simulations on Kessel; `bot/compiled/` is the WebAssembly sandbox submitted bots run in; `bot/arena/` is the hosted arena (window, API, the game player `play-seed.js`, `gamesctl.js`, intake; `bot/arena/README.md`); `bot/table/` seats a person against a bot for Holotable's play page (`bot/table/README.md`).
- `server/` — the arena server in TypeScript on Effect 4. Its games role (stage 5: `server/src/main-games.ts`, `server/src/games/`; roles games, helper and replay) is the only program the games machine runs (`Dockerfile.games`, `fly.games.toml`): it decides when the hosted arena takes submissions, plays rounds (every game through `bot/arena/play-seed.js`), leases seeds to helpers and pushes results, and calls `bot/arena/gamesctl.js` for the Node work that serves the old window. The record (stage 4: one SQLite file and a replay folder, the one-time import of today's arena, export API v1 and its MCP tools) is not deployed yet. See `server/README.md`. The Elixir coordinator it replaced (`coord/`) is in the history.
- `app/` — the SWU Arena app (watch the arena, read the research): one HTML file built from the shared project folder by `app/build.mjs`; see `app/README.md` and `app/DESIGN.md`.
- `vendor/` — prebuilt Kessel and Holotable files at pinned commits, with `VERSION.json` and `vendor/refresh.js`; see `vendor/README.md`. Never edit them by hand.
- `spec/` — the bot protocol, bot interface and replay format. `meta/atlas-kit.js` and `dashboard/site/` are the two pieces of the Atlas and the dashboard the window serves.
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

`npm test` covers the unit tests (ratings, report, bot choices on mock boards, the arena, the sandbox, the Rust simulations); the end-to-end sanity check is the random-run command above (seeds 1-3 give 594/342/486 steps, p2/p2/p2 winners — runs are deterministic).

## Recording and viewing

```bash
npm run tournament -- --bots rush,heuristic,random --games 4 --out replays/demo   # recorded replays
npm run app                  # SWU Arena app -> app/dist/app.html (--public for the friends build, --data DIR)
npm run dev -- <bot folder>  # bot dev harness: the arena's check, its sandbox and deal vs heuristic,rush; never pushes
node bot/dev.js --view <run> # that run's replays on 127.0.0.1 (runs go to <bot folder>/.runs/)
npm run gate                 # determinism gate: seeds 1-3 = 594/342/486 steps, p2 wins, with recording on
node bot/trace.js check <replays>   # trace checks: recorded games must play out the same again, board by board
npm run ladder -- --bots rush,aggro,tempo,control,heuristic,random --games 10   # round robin -> results JSON (see bot/README.md)
npm test                     # unit tests; the real-game ones need card data
npm run lint                 # Perch semantic lint with Jev (see "Linting" below)
python3 bot/compiled/build.py   # the sandbox's own test bundle (node-random) in build/compiled (bot/compiled/README.md)
node --test bot/test/sims.test.js   # the referee's Rust simulations on vendored Kessel, in a real game
```

- A ladder started where `SWU_WINDOW` is set (cloud sessions set it) sends its run to the live arena window. Unset `SWU_WINDOW` for any test run, and never `require('bot/ladder.js')` to inspect it: loading it starts a ladder.
- The real-deck test, the ladder research and the human-game importer are holocron's (`npm run realdeck:test` there).
- Replay format is decisions plus a compact board snapshot per step, so the viewer never needs the engine. Files are ~0.6-1.4 MB each but ~25 KB gzipped on the wire. Format: `spec/replay-format.md`; snapshot fields: `bot/view.js`, types in Holotable's `src/data/types.ts`.
- The viewer is Holotable's (its own repo); the window serves its kit (`vendor/holotable/swu-viewer-kit.js`) as `/kit.js` and the app embeds it. Refresh it with `node vendor/refresh.js holotable <clone> <commit>`.
- Card art comes from `https://cdn.swu-db.com/images/cards/<SET>/<NNN>.png` (`-b` suffix = deployed leader side). Tokens and unreleased sets (e.g. TS26) have no art and fall back to stat tiles automatically; Card art can also be toggled off.

## Linting (Perch + Jev)

[Perch](https://github.com/lakeday-org/perch) (`@lakeday/perch`, a root devDependency) is a semantic linter: it asks TypeSafe's Jev model about each method and reports likely defects with a confidence.

```bash
npm install                  # once, at the repo root (or the cloud setup script installs perch globally)
npm run lint                 # core code changed since origin/main (committed only); exit 3 = findings
npm run lint:full            # all core code; only when there is a reason
npm run lint:shared          # code in the shared project folder: dashboard, viewer kit, research, env scripts
npm run perch -- issues      # any perch command: issues, check <file::method>, close <id> --reason ...
npm run perch -- usage 7     # Jev requests per day, from the shared ledger
```

Usage rule for every thread. Perch (semantic lint with Jev) is advisory, never a gate, and reads only the project's shared core, never bot code (`tools/perch/scope.js`, Eric's call). Run `npm run lint` once per PR, after committing and before you open the PR or mark it ready; it reads only committed core code changed since origin/main and says so when a change touches only bots. If you changed code in the shared project folder (dashboard, viewer kit, research or env scripts), run `npm run lint:shared` once. Run either again only after substantial new code, never to get different answers. Do not run `npm run lint:full`, a raw `perch scan`, or `--force`, and do not raise the `PERCH_*` limits or widen the scope, unless Eric or the task asks. If `npm run perch -- usage` says "unknown command", your branch predates these limits: merge origin/main first. Findings are leads, not facts: read the code, fix real ones in the same PR when they are small and in scope, close false positives with `npm run perch -- close <id> --reason "..."` (add `shared` before `close` for shared-folder code), and list real ones you leave in the PR description. If perch hits its budget, is turned off, or fails, carry on without it and say so in one line.

- `tools/bin/perch` sets `PERCH_BASE_URL` to TypeSafe System One (model `jev-latest`) and turns on `NODE_USE_ENV_PROXY` when `HTTPS_PROXY` is set. Locally, export `PERCH_API_KEY` or `TYPESAFE_API_KEY`. In Claude Code cloud sessions the egress proxy injects the Jev key, so no key is needed.
- Scope (`tools/perch/scope.js`, an allow-list): Perch reads the arena's part of the shared core, meaning the runners, recorder, ratings, bot protocol and registry, the arena, the sandbox, the spec, the app, the Atlas kit and tools. It never reads the code of specific bots (`bot/players/*` except the registry, arena starters), the referee's Rust simulations (`bot/sims/`, out of scope as they were under `bot/omni/rs`), `vendor/` or tests: Eric's call, 2026-10-11. The research code it used to read is in holocron. A new folder of core code must be added to `include`. Named paths outside the scope are refused, and built bundles (over 256 KB or minified) are skipped. Every perch command that reads code or findings (scan, check, issues, close, reopen, doctor) runs in a git snapshot that holds only the in-scope files at HEAD (`.perch/core`), so Jev never sees bot or test code, not even as a caller or callee. `check` also sees uncommitted in-scope changes. Closed issues are added back to `.perch/closed.jsonl`; `rules` and `setup` run in the repo itself. `perch shared <command>` does the same for the code in `/mnt/project-files` (`.perch/shared`); its closed issues live in the shared folder.
- Limits in the wrapper (`tools/perch/policy.js`): `scan` needs a scope (a path, `--since` or `--paths`); all core code needs `--full`. `coverage` is refused, since it measures tests and tests are out of scope. `--parallel` defaults to 8, one perch command at a time per checkout, and a 15 minute timeout (`PERCH_TIMEOUT_MIN`).
- `tools/perch/jev-cache.mjs` caches Jev answers by request content, so unchanged code is free and gets the same verdict every run (fresh answers vary by up to ±0.06). `--force` asks again; use it after Jev changes model, since requests name `jev-latest` and entries live 30 days (`PERCH_CACHE_DAYS`). It also enforces budgets: `PERCH_RUN_REQUESTS` (default 250) per run and `PERCH_DAILY_REQUESTS` (default 2000, Eric's pick) per UTC day for the whole project. Over budget, methods without a cached answer fail (HTTP 409) and the run exits 1; perch itself stops after 16 such failures in a row. A limit of 0 means cached answers only.
- The cache, the usage ledger and the off switch live in `/mnt/project-files/perch/` when that folder exists (shared by all threads), else in `.perch/jev/` (`PERCH_JEV_DIR` overrides). `PERCH_DISABLED=1` or a `DISABLED` file there turns off every Jev command (exit 0).
- Config is `perch.yaml` (ignores `forceteki/` and generated output; no custom rules yet). Results go to `.perch/` (gitignored, except `.perch/rules/` and `.perch/closed.jsonl`, which are committed).
- Findings are probabilities, not facts. Read the code before changing it, and `perch close <id> --reason "..."` false positives. `perch ci`, `perch cloud` and `perch login` need Perch Cloud, which this repo does not use.

## Fly.io (MCP server)

`.mcp.json` starts Fly's MCP server (`flyctl mcp server`, through `tools/bin/fly-mcp`): tools for apps, machines, volumes, secrets, certs, IPs and logs. In cloud sessions `.claude/hooks/session-start.sh` builds flyctl from source through the Go module proxy (a few minutes the first time), and the egress proxy injects the Fly key for api.fly.io and api.machines.dev, so no key is stored anywhere. Locally, flyctl uses your own `fly auth login`. Creating Fly resources costs money: the compute budget is $70 a month. Two apps: `swu-arena` (the window, `fly.toml`) and `swu-arena-games` (the games machine that plays submitted bots, `fly.games.toml`, private address only; `bot/arena/WINDOW.md`).

## Architecture of `bot/env.js`

`env.js` constructs a forceteki `Game` directly instead of going through the server:

- `Env` loads card data once (first `require` of the ~2000 card modules takes ~7 s, so do it once per process) and builds random 50-card decks (not validated by the project's `DeckValidator`).
- `EnvGame` wraps one game: `start()`, `legalActions(pid)`, `apply(pid, action, rng)`, `over`, `winners`, `round`, `promptSignature(pid)`.
- Actions are plain objects of kind `button`, `card`, `option`, `displayCard`, `perCardButton`, `distribute`.
- "Who must act" = whichever player has at least one legal action; the waiting player's prompt has no buttons and no selectable cards.
- Game over is `game.winnerNames.length > 0`.
- The bot RNG (`seededRng`) and engine RNG (`game.setRandomSeed`) are separate; seed both for reproducibility.
- Undo/snapshots are off by default; `newGame({ undo: true })` enables `UndoMode.Free` (needed for rollback-based search).

Engine input is always followed by `game.continue()`. Prompt-handling rules already encoded in `env.js` that are easy to get wrong:

- The distribute-damage/healing `Done` button has `command: 'statefulPromptResults'` — send the split that way, never as a menu click. Indirect damage on a unit may not exceed its `remainingHp` (bases uncapped), and the sum must equal `amount` unless `canDistributeLess`.
- "Cards with buttons" display prompts (`perCardButtons` present): cards are not clickable; only per-card buttons are legal. Plain display-selection prompts click the card via `menuButton(pid, cardUuid, promptUuid, 'menuButton')`.
- Number prompts and dropdowns answer with `menuButton(pid, String(value), promptUuid)`. Multi-select card prompts: click cards, then `Done`.
- `build/` only compiles `server/`; the test harness helpers (`forceteki/test/helpers/*`) depend on Jasmine globals, so `env.js` does not use them.

## Known engine bugs (found by random play, not fixed — engine is read-only here)

1. `TakeCover.ts`: `.card` read from an undefined heal event throws, even during playability checks. Repro: `node bot/debug-seed.js 8`.
2. Maul, Master of the Shadow Collective: choosing "Choose nothing" threw `Expected exactly one target for delayed effect but found 0`. Not reproducible by seed yet.
3. `TriggerWindowBase.js:141`: a null contract failure on "Resolve all" when both players have triggers and an Advantage token was defeated (seen in a simulation: Han Solo, It'll Work attacks Mandalorian Scout, then Opponent, then Resolve all).
4. Sundari Palace: its "resource up to 1 card from your hand" prompt also offers the opponent's hand cards. The referee sends those to bots as hidden cards (`bot/view.js` `hiddenFrom`). Repro: `playGame` seed 22, key `6f7edba65b86e374e9df5b8ba5ca3719eb57dc9d1fb10f09301d213e5e8dce6c`, bots `heuristic` vs `py-clock`, p2's decision 59.
5. Mystic Monastery: its action stays legal while the player already has the Force; used then, it changes nothing and does not count toward its 3 uses. When the opponent is out for the phase, the player gets the same action window again, so a bot that prefers the action over passing loops until the step cap (found by the example search bot, now holocron's `bots/examples/search-bot.js` and this repo's `bot/test/fixtures/search-bot.js`, before its loop guard).
6. Rollback (undo on, `UndoMode.Free`) does not restore everything: the order of simultaneous triggers, token ids made in one step, and whether an action ability "will have no effect" can come out differently after a rollback than in a game never rolled back. So the referee never rolls back the real game: every lookahead runs on a copy (`Shadow` in `bot/protocol.js`) that is rebuilt when it drifts. Seen in an ISMCTS game (seed 3005, rust-search vs ismcts-vlinear-deck). Also seen as which of several Shield tokens a hit defeats: forceteki keeps the first Shield trigger it collected, so a fresh game defeats the first Shield, and after a rollback it can defeat another one (`/mnt/project-files/omni/stress/r5-pool972/shield-probe.js`).
7. `ItBindsAllThings.ts`: its `then` reads `thenContext.events[0].totalDistributed`, which throws `Cannot read properties of undefined (reading 'totalDistributed')` when the heal made no event, also during playability checks (`hasAnyLegalEffects`). Same shape as #1. Seen once: seed 1, key `e1540cffc63f5e63cc6cd8dad8a8f96a77f8ee3dd05da42d6c5c45747e82afc7`, a Jev look test bot vs `node-search`, step 22.
8. `BarrissOffeeRedeemingHerself.ts` (ASH_044): its "if you do" step reads `individualEvents[0].card` before checking that anything was healed, so playing her when the heal resolves on nothing throws `Cannot read properties of undefined (reading 'card')`. It ends 36% of the real-deck games of `lando-calrissian_law_blue` (the only list in `bot/decks/` that runs her). Repro: `playGame` seed 19, decks `lando-calrissian_law_blue` vs `admiral-piett_jtl_blue`, bots `c-clock#b` vs `c-clock#a`, key `e0976551196cb25b019af62563b83e2e05c3f13d7dedaa334e7a30a0bc8ee9b3`.
9. `JustifierRelentless.ts`: its `ifYouDoCondition` reads `.willDefeat` from an undefined event (5 of 7,020 real-deck games).

Treat engine errors during random play as findings to report, not something to patch in `forceteki/`.
