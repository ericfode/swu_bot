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

## Bots and the ladder
- Registry: `players/index.js` (`makeBot(name)`), used by `tournament.js` and `ladder.js`.
  - `random*` — uniform random. `rush` — rule-based, no lookahead: plays its most expensive card, attacks face, then passes.
  - `heuristic`, `aggro`, `tempo`, `control` — the same one-ply rollback search (`players/heuristic.js`) with different
    evaluation profiles (`players/profiles.js`); `heuristic` is the original weights with the base-danger sign fixed, `legacy` is the original evaluation bit-for-bit (inverted danger term included). Add `-dN` for depth N.
  - `ismcts[-bB][-hH][-nN]` — known-decklist Information Set MCTS (`players/ismcts.js`, `players/belief.js`). Both
    decklists are known; each iteration samples one world (my deck order; which unseen opponent cards are in hand,
    resources or deck), searches my turn with UCB in one shared tree, lets the opponent reply from its sampled hand and
    scores the result with the heuristic evaluation. `B` = belief sharpness: the weight of a card in the opponent's
    hand is `exp(-B * evidence)`, where evidence grows each time the opponent could afford the card but spent a window
    without paying for anything (0 = uniform over the decklist). `H` = exchanges before scoring, `N` = iterations
    per legal action. `ismcts-peek` searches the real hidden cards: an unfair control that measures what hidden
    information is worth. `ISMCTS_THOUGHTS=<dir>` makes the bots write their latest search there;
    `node bot/ismcts-panel.js --runs <ladder dir> --thoughts <dir> --watch 10` turns that into the dashboard panel.
    `node bot/determinize-check.js` checks that world sampling keeps zone sizes and that rollback restores exactly.
  - `name#tag` enters the same bot twice (`aggro#1,aggro#2`) as a sanity check.
- `node bot/ladder.js --bots rush,aggro,tempo,control,heuristic,random --games 10 [--workers 3] [--seed 1] [--record]`
  runs a round robin on worker threads. Each seed is played once from each seat (random decks follow the seat, so deck luck cancels).
  After every game it rewrites `<out>/<id>/index.json` (same tournament index as `tournament.js`, so the viewer and the
  research dashboard read it unchanged) and `<out>/<id>/ladder.json` (schema `swu-ladder/1`: per-bot W/L/D, win rate with
  95% CI, sequential Elo, Bradley-Terry Elo, pair matrix, Elo history). Writes are atomic. `--record` also saves `games/<id>.jsonl`
  replays (~1 MB each). `--out` defaults to `/mnt/project-files/results` when it exists, else `results/`.
- `--vs a,b,c` turns the ladder into a gauntlet: each `--bots` entry plays each `--vs` entry on the same seeds (not each
  other), which is what a parameter sweep needs: `node bot/ladder.js --bots ismcts-b0,ismcts-b1,ismcts-b4 --vs rush,heuristic --games 8`.
- `npm test` — unit tests for ratings, the report and bot logic on mock boards (needs `forceteki/build`, not card data).
