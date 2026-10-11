# Handoff: single-player SWU bot on the forceteki engine

Written 2026-10-10 at the end of a cloud session. Everything below was observed or run, except where marked **untested**.

## Goal
Build a single-player Star Wars Unlimited client with an AI opponent, using the existing forceteki rules engine
directly (no web client, no lobby/socket layer). Planned ladder: random bot -> heuristic bot -> search bot -> (maybe) learned policy.

## Where things are
- Repo: `C:\projects\programming\swu_bot\forceteki` (clone of SWU-Karabast/forceteki), branch `bot-env`, based on commit `2be4fcd`.
- `npm install`, `npm run get-cards` and `npm run build` have been run. `build/` and `test/json/` (gitignored) exist.
- New code lives only in `bot/` (untracked, **nothing committed yet**). No engine files were modified.
- Node: repo wants 22.x (my Linux sandbox used 22.23). Your Windows Node may differ; if the build misbehaves, use 22.

## What exists in bot/
- `env.js` — `Env` (loads card data, builds random decks) and `EnvGame` (`start()`, `legalActions(pid)`, `apply(pid, action, rng)`, `over`, `winners`, `round`, `promptSignature(pid)`).
- `random-run.js` — `node bot/random-run.js [games] [startSeed] [maxSteps]` (run from repo root).
- `debug-seed.js` — `node bot/debug-seed.js <seed>` replays a seed and dumps last actions + prompt state on error.
- `README.md` — short usage notes. ESLint (repo config, `curly: all` etc.) passes on these files.

## How the engine is driven (verified)
- Build a `Game` directly (`new Game(config, { router })`); config needs `cardDataGetter` (`UnitTestCardDataGetter('test/json')`), a no-op `scheduler`, `pushUpdate`, `userTimeoutDisconnect`, `undoMode`. The router can be a stub; `handleError` should throw so engine errors surface.
- Decks: `new Deck({ leader:{id,count}, base:{id,count}, deck:[{id,count}], metadata, isPresentInDb }, cardDataGetter)` where ids are set codes like `SOR_123`. Then `game.selectDeck(playerId, deck)`, `game.setRandomSeed(seed)`, `await game.initialiseAsync()`.
- Input is always followed by `game.continue()`. A player's prompt is `game.getPlayerById(id).currentPrompt()`; selectable/selected cards are on `player.promptState`.
- Inputs: `menuButton(pid, arg, uuid, method)`, `cardClicked(pid, cardUuid)`, `perCardMenuButton(pid, arg, cardUuid, uuid)`, `statefulPromptResults(pid, results, uuid)`.
- Game over: `game.winnerNames.length > 0`. The waiting player's prompt has no buttons and no selectable cards, so "who must act" = whoever has >=1 legal action.

## Rules learned the hard way (all encoded in env.js)
- Distribute-damage/healing prompt: its `Done` button has `command: 'statefulPromptResults'` — do NOT send it as a menu click; send the split via `statefulPromptResults`.
- Indirect damage on a unit may not exceed its `remainingHp` (bases uncapped). Sum must equal `amount` unless `canDistributeLess`.
- "Cards with buttons" display prompts (`perCardButtons` present): the cards are not clickable; only per-card buttons are legal. Plain display-selection prompts click the card via `menuButton(pid, cardUuid, promptUuid, 'menuButton')`.
- Number prompts and dropdowns answer with `menuButton(pid, String(value), promptUuid)`.
- Multi-select card prompts: click cards, then the `Done` button.

## Measurements (cloud sandbox, 2 cores — your machine is probably faster)
- 50 seeded random-vs-random games: 49 finished with a winner; 1 hit an engine bug (below).
- Typical game: ~300-600 decisions, 11-22 rounds. About 5 ms/decision, ~0.5 games/s per core.
- Prompt shapes seen (18): actionWindow, resource(multi), single/multi card select, optionalTrigger, triggerWindow, initiative, number, dropdown, displayCards (several variants), distributeAmongTargets, batchTriggerResolution, passDelay.
- Random decks: 50 cards, <=3 copies, aspects limited to leader+base. **Not** validated by the project's DeckValidator.

## Suspected engine bugs found by random play (not reproduced in the real client)
1. `server/game/cards/07_TS26/events/TakeCover.ts`: `then` does `thenContext.events.find(x => x.name === EventName.OnDamageHealed).card`. If no heal event exists (nothing damaged / no target chosen) `.card` is read from `undefined` and throws, even during a playability check. Repro: `node bot/debug-seed.js 8`. Likely fix: guard / `?.card`.
2. Maul, Master of the Shadow Collective: choosing "Choose nothing" on the "take control of a unit until Maul leaves the arena" prompt threw `Expected exactly one target for delayed effect but found 0` (`DelayedEffectSystem`). Seen once (seed 1 before my choice logic changed); **not currently reproducible by seed** — needs a targeted repro.

## Gotchas
- Loading the engine requires every card module (~2000 files); first `require` takes ~7 s locally. Do it once per process.
- `build/` only compiles `server/`. Test-harness helpers (`test/helpers/*`) use Jasmine globals, so I did not use them; env.js constructs `Game` itself.
- Bot RNG (`seededRng`) and engine RNG (`setRandomSeed`) are separate; both seeded, so runs are reproducible.
- Undo/snapshots are off by default (`newGame({ undo: true })` -> `UndoMode.Full`).

## Suggested next steps
1. Commit `bot/` on `bot-env` (suggested message: "Add headless bot environment and random-play runner").
2. Measure snapshot cost **(untested)**: with `undo: true`, time `game.takeManualSnapshot(player)` and `game.rollbackToSnapshot(playerId, { type: SnapshotType.Quick, playerId })` (see `test/helpers/IntegrationHelper.js` for how the harness calls them). This number decides search depth.
3. Heuristic bot: score the position after trying each legal action on a snapshot, roll back, pick the best. Features: board power/HP, base HP race, resources/tempo, hand size, initiative. Evaluate after the engine resolves the action so card text is applied for free.
4. Bot-vs-bot tournament runner (swap first player, several decks) reporting win rate/Elo vs the random baseline.
5. Search layer: determinization for hidden info (opponent hand/deck), group "action + its targets" into one search move.
6. Decide on a human-facing client (fork the existing web client against a local server vs. a CLI/text client on env.js).
7. Optionally file the two suspected engine bugs upstream, and validate generated decks with the project's DeckValidator.

## Paste-able prompt for a fresh local session
> Read bot/HANDOFF.md and bot/README.md in this repo (branch bot-env). Run `node bot/random-run.js 5 1 6000` to confirm the environment works, then commit bot/ and start on next step 2 (snapshot/rollback timing).
