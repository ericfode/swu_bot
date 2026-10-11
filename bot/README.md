# bot/ — headless environment for forceteki

Runs the real rules engine with no server, sockets, lobby or login, so bots can play it.

Run from the **swu_bot repo root** (the engine submodule `forceteki/` needs `npm install`, `npm run get-cards` and `npm run build` done first):

    node bot/random-run.js [numGames] [startSeed] [maxSteps]
    node bot/debug-seed.js <seed>        # replay one seed and dump the context if it errors

## Files
- `env.js` — `Env` (card data, random deck builder) and `EnvGame` (`start()`, `legalActions(pid)`, `apply(pid, action)`).
  Actions are plain objects: `button`, `card`, `option`, `displayCard`, `perCardButton`, `distribute`.
- `random-run.js` — random-vs-random games; prints per-game outcome, games/sec and the prompt shapes it saw.
- `debug-seed.js` — replays one seed deterministically and prints the last actions and prompt state on failure.

## Notes
- Games are reproducible: engine RNG is seeded via `game.setRandomSeed`, bot choices via `seededRng`.
- Engine input rules learned the hard way: the distribute-damage prompt's `Done` button is *not* a menu click
  (it is sent via `statefulPromptResults`); in "cards with buttons" prompts only the per-card buttons are legal;
  indirect damage on a unit may not exceed its remaining HP.
- Undo/snapshots are disabled by default (`newGame({ undo: true })` enables `UndoMode.Free` for search experiments).

## Recording and tournaments
- `recorder.js` — read-only per-step board snapshots (`snapshot(envGame)`); `match.js` — `playGame(env, {seed, bots, record, snapshot})`.
- `players/random.js` — bots are `{name, choose({game, pid, actions, rng}) -> action}`; register new ones in `tournament.js` `makeBot`.
- `node bot/tournament.js --bots a,b,c --games 10 --out replays/my-run [--seed 1]` writes `index.json` + `games/<id>.jsonl` (JSON Lines: `header`, `step` x N, `end`). First seat alternates each game.
- `node bot/gate.js` — determinism gate: seeds 1-3 must give 594/342/486 steps (p2 wins) with and without recording. Run it after touching `recorder.js` or `match.js`.
- View results with `npm run viewer` (see viewer/ in the repo CLAUDE.md).

## Bots in other languages
- `players/external.js` — `ExternalBot`: runs any program that speaks the stdio JSON Lines protocol in `spec/stdio-protocol.md`, as an ordinary bot. Register programs by name in `external-bots.json` (or `$SWU_EXTERNAL_BOTS`) and use the name in `--bots`.
- `observe.js` — the plain-JSON board/prompt/action view those bots receive (replay snapshot plus card uuids, opponent hand hidden).
- `examples/random_bot.py` — reference client. `node bot/stdio-smoke.js -- <cmd> [args]` checks a bot against a fake game (needs `forceteki/build`, no card data).
- The full interface and replay format are written up in `spec/`.
