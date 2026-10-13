# Engine reference traces for omni-rs

Run from the repository root with Node 22 and the normal engine setup:

```sh
node bot/omni/rs/make-pool.js
node bot/omni/rs/trace.js --pool bot/omni/rs/pool.json --bots random,random --seeds 1-75 --out replays/omni-rs --gzip
node bot/omni/solve-games.js --pool bot/omni/rs/pool.json --bots aggro,control --seeds 1-8 --budget 2000 --stop 2 --out replays/omni-rs-solves
node bot/omni/export-positions.js replays/omni-rs-solves replays/omni-rs-positions.jsonl --pool bot/omni/rs/pool.json
```

The pool contains 100 cards: eight plain bases, the three requested leaders, 88 units with empty or supported keyword-only text, and Shield. Each entry includes the downloaded card metadata, numeric keyword values parsed from text, and an inclusion reason. The generator validates the whole rules text after removing reminder text; a supported keyword at the beginning is insufficient. It rejects pilot text and unsupported keyword tags. At least 50 cards can be dealt for every leader/base pair, respecting the existing dealer's three-copy limit and its stricter one-copy limit for unique cards. An explicit pool is optional; unrestricted deals retain the original code path.

A pool hash is SHA-256 over the exact pool file bytes. Solve results record the path and hash; export reads that same file and refuses a changed hash. `--pool` may relocate an identical pool, but cannot silently apply a subset to an unrestricted solve run. New pool solves also store each window’s full-state hash and chosen canonical action key; export checks both when present, while preserving support for earlier solve records. Pool exports preserve the existing `state`/`deckOrder` fields and add `fullState` for the Rust simulator.

## JSONL records

Trace schema `omni-rs-trace-v1` begins at the first action window. Setup and mulligans run in forceteki. Every later engine decision is recorded, including selections that the engine accepts without changing the game. The actual engine game is advanced continuously; subsequent snapshots are comparison checkpoints, never simulator reset instructions.

- `meta`: schema, seed, bot names, complete dealt decks, and pool provenance.
- `state`: `step` and `state` at each top-level action window.
- `decision`: `step`, acting seat (`p1`/`p2`), prompt type/title/selected stable IDs/action-window flag, canonical legal `actions`, chosen key, and engine coverage events emitted while applying that choice.
- `result`: final step, winner (`p1`, `p2`, or `draw`) and full terminal `state`.

`state` has `round`, `phase`, `initiative`, `initiativeClaimed`, `prevPassed`, `activePlayer`, `actor`, `winner`, `nextCardId`, and `players`. `nextCardId` is the length of the engine's complete card registry, including tokens outside visible zones, so future Shield IDs remain reproducible.

Each player's state has `hand`, top-first `deck`, ordered `resources` with `exhausted`, ordered `discard`, `ground`, `space`, `leader`, `base`, and `out` (finished with this action phase). Cards use `{id, setCode, name}`, where IDs are `EnvGame.cardId` values such as `c17`. Shield uses `TOKEN_SHIELD`. Units include `damage`, `exhausted`, observed `power`/`hp`, and ordered `upgrades` with a token flag. Leaders include `deployed`, `exhausted`, and `epicUsed`; a deployed leader also appears in its arena with its unit statistics. Bases include `damage`, `hp`, and `epicUsed`. `prevPassed` identifies a prior consecutive pass; `out` is distinct from a temporary pass.

## Canonical action identity

The key is the JSON serialization of the five-element tuple:

```text
[kind, stableCardIdOrNull, argOrNull, methodOrNull, label]
```

A card UUID in an argument is normalized to its stable ID. Prompt UUIDs are intentionally omitted because they change under rollback. JSON tuple encoding preserves strings containing separators. Card identity, method, argument and label are all retained; the exporter aborts if any two actions at a decision have the same key. All tuple fields are also present in the action object for diagnostics.

Satine's engine healing menu represents several different choices. The exporter enumerates every concrete legal allocation: zero healing `[]`, or `[[stableId, amount]]` for amounts 1 and 2 for every offered target. The allocation occupies `arg` in the tuple. Undamaged targets and allocations larger than missing health remain legal when the engine offers them; actual healing is clamped by the rules. Distributions outside Satine's bounded, single-target healing shape are refused.

Coverage events are `onCardPlayed`, `onAttackDeclared`, `onCardDefeated`, `onLeaderDeployed`, and `onUpgradeAttached`, with the relevant card reference. Bot lookahead events are excluded. Bots requiring rollback get undo enabled, their chosen actions are refreshed after lookahead, and a full-state comparison rejects any bot search that changes the live action-window state.

Trace generation exits nonzero on any failed game and writes a `.error.json` with the engine error. It never edits engine source. Small real-engine fixtures live in `bot/omni-rs/tests/fixtures`; bulk traces belong in ignored `replays/`.

## Focused fixture construction

```sh
node bot/omni/rs/make-fixtures.js
```

This regenerates three additional small engine fixtures, independently of the 300-game measurement corpus. The two `keywords-and-unique` games use legal 50-card decks containing three copies of unique units. They exercise both unique-defeat choices and Mae (`HMW_055`), whose three aspects prevent the normal in-aspect dealer from selecting her. Mae pays the normal missing-aspect penalty. Her two trigger orders are exercised, including survival and defeat during Ambush before Shielded resolves.

The three-decision `vader-dual-lethal` fixture starts from a naturally reached ready deployed-Vader window and constructs the initial base damage values as 28 for the attacker and 29 for the defender. All recorded actions and resulting state come from the unmodified engine. Vader attacks the enemy base but targets his own base with the On Attack ability. His own base dies first; combat still completes and defeats the other base. The first declared winner remains, even though both bases end at 30 damage. This is explicitly marked as a constructed scenario and is not counted as an ordinary measured game.

Together with the three normal-game fixtures, the six compressed files are approximately 122 KB. The Rust conformance test discovers and checks all of them.

## Stress test with bots

```sh
cargo build --release -p omni-rs && npm run wasm:build -- --target node
node bot/omni/rs/stress.js --bots heuristic,aggro,control,c-clock,rust-search,node-search --seeds 1-4 \
    --pool bot/omni/rs/pool.json --out replays/omni-rs-stress --workers 3 --sim-every 5
```

Bots play ordinary games through the referee (`bot/match.js`), every pair once per seed, on decks dealt from the pool.
forceteki decides every game. The Rust simulator (the WebAssembly build) only follows along (`mirror.js`):

- **Real moves.** From the first action window on, Rust is loaded with forceteki's full state, then gets every move
  the bots make. Before each move it compares the legal action sets; at each action window, the full state; at the
  end, the final state and winner.
- **Lookahead moves.** Bots that ask for simulations (`rust-search`, `node-search`) try many moves no real game
  reaches. One simulation in `--sim-every` is followed the same way, from its re-dealt start position. `0` turns it off.

After a disagreement the mirror waits for the next action window and loads forceteki's state again, so one game can
show several. A checker bug never changes a game: it is counted as `mirror-error` and that line stops being checked.
The checker reads the engine only; the same game with and without it makes the same moves.

Output in `--out`: `games-<worker>.jsonl` (one line per game: outcome, moves checked, findings) and `summary.json`
(totals, findings by kind, source and card, engine errors). Each finding has a file `findings/<game>-<n>.jsonl.gz` in
the trace format above: the last loaded window and the moves after it, up to the disagreement. `target/release/omni-rs
check --pool <pool> <file>` replays it on the Rust side alone and stops at the same place (if Rust now agrees, it
stops at "missing terminal result" instead, since the file ends there). Finding kinds: `actions` (legal action sets
differ, with the keys only one side has), `state` (full states differ, with the differing paths), `apply` (Rust
refused the chosen move), `terminal`, `rust-error` and `mirror-error`. `cards` and `lastCard` (the card of the move
before the disagreement) name the cards involved; `summary.json` counts findings per card.

For the compiled card pool (PR #121, 830 cards), add `--catalogue bot/card-compiler/generated/catalog.json --pool
bot/card-compiler/generated/runtime-pool.json --selection-toggles`: the compiled card programs, and forceteki with the
opt-in select-card rule that this Rust engine follows (`env.newGame({ selectionToggles: true })`). `omni-rs check` then
needs the same `--catalogue` and `--pool`.

`--views` also builds, from the Rust state, the protocol views a bot would get from Rust simulations (`rust-view.js`)
and compares them with `bot/view.js` on forceteki: the action list at every checked decision and the board at every
action window. The first difference in a line is a `view` finding.

First run (`/mnt/project-files/omni/stress/r1-pool100/`, `summary-short.json` for the totals):
11 bots (heuristic, aggro, control, tempo, rush, random, c-clock, py-clock, rust-greedy2, rust-search, node-search),
every pair on seeds 21-22, 110 games on the 100-card pool: 13,647 real moves and 6,703 action windows, plus 13,441
moves and 6,066 windows inside 1,631 bot simulations, with no disagreement and no engine error. A `--views` run had no
view difference either.

Second run (`/mnt/project-files/omni/stress/r2-pool830/`, `FINDINGS.md`), the same bots and seeds on the 830-card pool of
PR #121 before it merged: 12,687 real moves and 5,813 moves inside 610 simulations, no engine error, and 3 findings from
2 Rust bugs. Force Illusion (LOF_223) offers already-exhausted enemy units to exhaust, where forceteki skips that step.
The deployed C-3PO leader (SEC_015) loses its On Attack trigger.

## Simulations on the Rust engine (opt-in)

A protocol bot that sends `"simEngine": "rust"` in `ready` gets its simulations from the Rust simulator whenever every
card in the game is in the pool (`rust-sims.js`; spec/protocol.md#simulations-on-the-rust-engine). Otherwise it gets
forceteki simulations, as every bot does by default. `node-search-rust` is `node-search` opted in: on pool decks it
spends about 17 ms per decision against 35 ms, and in three test games (seeds 31-33 against heuristic) it played games of
the same length with the same winner. The WebAssembly package
must be built (`npm run wasm:build -- --target node`); without it the referee says so once and serves forceteki.
