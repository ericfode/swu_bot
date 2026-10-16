# bot/ — the arena's game player and referee

Runs the real rules engine with no server, sockets, lobby or login, so bots can play it, and referees games between
bots. This is what the hosted arena (`bot/arena/`) plays its rounds with. The research bots, their runners and the
analysis moved to [holocron](https://github.com/ericfode/holocron), which keeps a copy of these files under
`engine/`: fix player bugs here first, then copy the fix there.

Run from the **swu_bot repo root** (the engine submodule `forceteki/` needs `npm install`, `npm run get-cards` and
`npm run build` done first):

    node bot/random-run.js [numGames] [startSeed] [maxSteps]
    node bot/debug-seed.js <seed>        # replay one seed and dump the context if it errors

## Files
- `env.js` — `Env` (card data, random deck builder) and `EnvGame` (`start()`, `legalActions(pid)`, `apply(pid, action)`).
  Actions are plain objects: `button`, `card`, `option`, `displayCard`, `perCardButton`, `distribute`.
- `random-run.js` — random-vs-random games; prints per-game outcome, games/sec and the prompt shapes it saw.
- `debug-seed.js` — replays one seed deterministically and prints the last actions and prompt state on failure.
- `decklists.js`, `cardpool.js`, `decks/` — fixed deck lists and card pools for `ladder.js --decks` / `--pool`; the
  arena's start check sends a new bot two decks from `decks/ash-meta-2026-09.json` (`decks/README.md`).

## Notes
- Games are reproducible: engine RNG is seeded via `game.setRandomSeed`, bot choices via `seededRng`.
- Engine input rules learned the hard way: the distribute-damage prompt's `Done` button is *not* a menu click
  (it is sent via `statefulPromptResults`); in "cards with buttons" prompts only the per-card buttons are legal;
  indirect damage on a unit may not exceed its remaining HP.
- Undo/snapshots are disabled by default (`newGame({ undo: true })` enables `UndoMode.Free` for search experiments).

## Recording and tournaments
- `match.js` — `playGame(env, {seed, bots, record, snapshot, key, limits})` plays one game; `view.js` — the board
  snapshots replays record (`recorder.js` gives the same `snapshot`, and `addReplayKey`, which writes a game's key on
  its replay's end line).
- `node bot/tournament.js --bots a,b,c --games 10 --out replays/my-run [--seed 1] [--key K|none]` writes `index.json` +
  `games/<id>.jsonl` (JSON Lines: `header`, `step` x N, `end`). First seat alternates each game.
- `node bot/gate.js` — determinism gate: seeds 1-3 must give 594/342/486 steps (p2 wins) with and without recording.
  Run it after touching `view.js` or `match.js`.
- `node bot/trace.js check <replay.jsonl[.gz] | folder>...` — trace checks: plays recorded games again on this engine
  from their decks, seed, key and moves, and names the first step whose board differs (exit 1). A game that ended in
  an engine error is checked to raise it again on the same move. `bot/test/traces/` holds eight games of the live
  arena that `npm test` replays; after a change meant to alter the boards, `node bot/trace.js rewrite <files>` records
  them again.
- View replays in Holotable ([holotable](https://github.com/ericfode/holotable)) or on the arena window, which embeds
  its viewer kit from `vendor/holotable`.

## The bot protocol
Every bot is a client of the bot protocol (`spec/protocol.md`): JSON messages, over stdio for a program in any
language or as plain objects in process.
- `dev.js` — the bot dev harness, `npm run dev -- <bot folder> --owner <login>` (or `--house` for one of the arena's own
  bots): packs the folder as that submitter's `arena_submit` would and holds it to its rules, start-checks it with the
  arena's checker (`arena/intake.js --check`), deals a gauntlet against `heuristic` and `rush` (or `--vs` folders) on
  the rated rounds' deck lists and limits, plays each seed with `arena/play-seed.js` in the sandbox, and writes the
  replays, the bot's transcripts and a report to `<folder>/.runs/`. Games lost by a fault or with no result that look
  alike (kind, exception class, the bot's own line) are reported once, with an `--again` command that sends that game's
  messages to the folder as it is now; 3 alike stop the run (`--all` plays on). `node bot/dev.js --view <run>` serves
  that run's replays with the viewer kit on 127.0.0.1. It never sends anything to a window. It is the one way to run a
  bot program locally.
- `stdio.js` — `StdioClient` runs a bot program; `serve(client)` runs an in-process client as a program. No engine
  dependency. With `log` set, a client writes what it sent and read, the program's stderr and the sandbox's stats
  next to that path (the ladder worker sets it under `SWU_BOT_LOG`, which `dev.js` uses).
- `protocol.js` — the referee: hello/decide/over, time limits, blame (a bot that breaks a game loses it), simulations
  (`sim` requests) on a separate copy of the engine with hidden cards dealt again.
- `game-cards.js` — the card data every protocol bot gets in `hello.cards`: the engine's card objects for both deck
  lists and the tokens, built once per game by `match.js`. It is the only card data a protocol bot gets; nothing hands
  a bot a card folder. Native bots (in process, no `hello`) read the engine's card objects.
- `sims/` — simulations on Kessel's Rust engine for a bot that asks for them (`"simEngine": "rust"`):
  `rust-sims.js` runs the vendored Kessel package (`vendor/kessel`, see `vendor/README.md`) when every card of the
  game is in its pool (`sims/pool.json`, checked by `pool.js`) and deals the hidden cards again, and the referee falls
  back to forceteki otherwise. `state.js` exports a forceteki position in Kessel's format, `rust-view.js` builds the
  bot's view of a Rust position. `test/sims.test.js` plays a real game with them.
- `rng.js` — seeded and keyed random streams; `view.js` — what a seat sees (board, prompt, actions).
- `external-bots.json` (or the file `$SWU_EXTERNAL_BOTS` names) maps a name to a program the referee starts with
  `StdioClient`, outside any sandbox, so the name works in `--bots` for `tournament.js` and `ladder.js`. It is the
  referee's own plumbing for trusted programs (this repo's sandboxed `node-random-wasm`, holocron's research bots);
  a bot for the arena is tested with `dev.js`. An entry is `{ cmd, args, cwd, env, stderr, timeoutMs,
  startTimeoutMs, lang, stateful, inputs }`: the program (the bot itself, or a script that `exec`s it), its working
  folder (default the repo root) and extra environment, `inherit` or `ignore` for its stderr, its `ms` for
  `decide`/`over` and for `hello` (a game's own `limits` override them), a language label, `stateful: true` when it
  learns from game to game (`ladder.js --resume` then plays the run again from the start), and other files it reads
  (so `--resume` notices when they change). A tournament keeps one process per bot for the whole run (two when a game
  needs the same bot in both seats). The tests' example clients are in `test/fixtures/`; they use the repo's own
  modules, so they run only here.
- `compiled/` — the WebAssembly sandbox the arena runs submitted bots in (`compiled/README.md`).

## Bots and the ladder
- Registry: `players/index.js` (`makeBot(name)`), used by `tournament.js`, `ladder.js` and the arena.
  - `random*` — uniform random. `rush` — rule-based, no lookahead: plays its most expensive card, attacks face, then
    passes.
  - `heuristic`, `aggro`, `tempo`, `control` — the same one-ply rollback search (`players/heuristic.js`) with different
    evaluation profiles (`players/profiles.js`); `heuristic` is the original weights with the base-danger sign fixed,
    `legacy` is the original evaluation bit-for-bit (inverted danger term included). Add `-dN` for depth N.
  - `<agent>` and `<agent>-v<N>` — the arena's competitors (`arena/registry.js`).
  - `name#tag` enters the same bot twice (`aggro#1,aggro#2`) as a sanity check.
  - Every other bot (ISMCTS, omni, learned, Jev, the bots in other languages) is in holocron with its own registry.
- `node bot/ladder.js --bots rush,aggro,tempo,control,heuristic,random --games 10 [--workers 3] [--seed 1] [--record] [--key K|none]`
  runs a round robin on worker threads. The arena played its rounds with it until stage 5; the games machine now deals
  them the same way and plays each seed with `arena/play-seed.js` (`server/README.md`). Each seed is played
  once from each seat (random decks follow the seat, so deck luck cancels). Decks come from a random run key, as in
  `tournament.js`; it is saved in `ladder.json` (`config.key`) when the run is done. Pass it as `--key` to give a
  second run the same games, or use `--key none` to deal from the seed alone. After every game it rewrites
  `<out>/<id>/index.json` (same tournament index as `tournament.js`) and `<out>/<id>/ladder.json` (schema
  `swu-ladder/1`: per-bot W/L/D, win rate with 95% CI, sequential Elo, Bradley-Terry Elo, pair matrix, Elo history).
  Writes are atomic. `--record` also saves `games/<id>.jsonl` replays (~1 MB each). `--out` defaults to
  `/mnt/project-files/results` when it exists, else `results/`. With `SWU_WINDOW` set (cloud sessions set it) the run
  is also sent to the live arena window: unset it for a test run.
- `--vs a,b,c` turns the ladder into a gauntlet: each `--bots` entry plays each `--vs` entry on the same seeds (not each
  other).
- `--decks <file>` plays fixed deck lists instead of random decks (`decklists.js`, whose header says how deck pairs are
  dealt; `--deal seat` deals them as the arena's rated rounds do, `--skip-decks a,b` leaves lists out), and
  `--pool <file>` deals the random decks from a card pool only (`cardpool.js`).
- `npm test` — unit tests for ratings, the report, bot logic on mock boards, the arena, the sandbox and the Rust
  simulations (most need `forceteki/build`; the real-game ones need card data).

## Arena
- `bot/arena/` is the hosted arena on Fly: builders submit bots on the arena window (swu-arena.fly.dev), and the games
  machine packs each one into a WebAssembly bundle and rates it in rounds against the project's own bots. Bots live
  in the arena folder (`ARENA_HOME`); `players/index.js` resolves `<agent>` and `<agent>-v<N>` names through
  `arena/registry.js`. See `bot/arena/README.md`.
