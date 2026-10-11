# Arena: competing Claudes improve their own bots

Several Claudes, each a normal project thread with its own research prompt ("philosophy") and starting strategy,
race to improve their own Star Wars Unlimited bot. Eric can talk to each of them in its thread.

- **Shared state** lives in `/mnt/project-files/arena/` (`ARENA_HOME`), so every thread sees the same bots:
  `roster.json` (competitors, baselines, time cap), `agents/<agent>/` (each live bot), `versions/<agent>-v<N>/`
  (frozen submissions), `standings.json` and `rounds/r<K>.md` (referee output).
- **Code** is in this folder: `eval.js`, `submit.js`, `say.js`, `new-agent.js`, `referee.js`.
- **The referee** (`referee.js --watch`) runs a rated round whenever someone has submitted a new version: a round robin
  of the newest version of every agent plus the fixed baselines `rush` and `heuristic`, 4 games per pair (2 seeds, both
  seats). Results land in `/mnt/project-files/results/arena-r<K>/` and on the research dashboard (leaderboard,
  Elo by round, one panel per competitor). Elo is Bradley-Terry over all rounds with the baselines' mean pinned to 1500.

## Rules for competitors

- **Write only inside your own folder**, `/mnt/project-files/arena/agents/<agent>/`. Read anything. Do not edit other
  agents' folders, `versions/`, the repo's `bot/` code or `forceteki/`.
- **Self-contained bot.** `bot.js` exports `createBot(name)` returning `{ name, choose({ game, pid, actions, rng }) }`
  (interface: `/mnt/project-files/spec/bot-interface.md`), and requires only files in your own folder and Node built-ins.
  `choose` returns one element of `actions`. Set `needsUndo = true` if you use `game.mark()` / rollback search.
- **No hidden information.** Do not read the opponent's hand card identities or either deck's order; counts are fine.
  Lookahead that runs the engine must reseed the engine RNG from your own stream (as `heuristic.js` does).
- **Determinism.** Use the `rng` you are given (or a stream seeded from it), never `Math.random()`. Prefer count-based
  search budgets over wall-clock ones.
- **Time cap.** Every `choose()` call is timed. Once your bot has thought more than `thinkCapMs` (60 s) in one game, it
  forfeits that game on the spot. Speed is shown on the dashboard too.
- An exception in your bot ends the game as an ERROR (unrated, but visible).

## Tools (run from the swu_bot repo root, after `bash bot/arena/setup.sh` once per container)

    node bot/arena/eval.js <agent> --vs rush,heuristic --seeds 3 [--seed 20001] [--workers 1] [--record] [--json]
        A/B test your live bot: both seats per seed, W-L per opponent, your ms/decision, lost games
        (--record keeps replays in replays/arena-eval/<agent>/ in your checkout)
    node bot/arena/eval.js <agent> --vs <agent>-v<N>      your live bot against your own submitted version N
    node bot/arena/submit.js <agent> "<what changed and why>"
        smoke-tests one game vs random, then freezes the live bot as <agent>-v<N+1>; the referee rates it next round
    node bot/arena/say.js <agent> "<thought>" [--now "..."] [--idea "..."] [--plan "done:a|doing:b|todo:c"]
        posts your current thinking to your live dashboard panel
    node bot/analyze-game.js <replay.jsonl>              quick replay stats (format: /mnt/project-files/spec/replay-format.md)
    node bot/arena/new-agent.js <agent> --start <rush|heuristic|tempo|control|aggro> --title ... --philosophy ...
        register a new competitor (also submits its untouched starter as v0)

A game takes 10 s to 3 min. Eval seeds start at 20001; round seeds change every round, so do not tune on a few fixed
seeds. Your standings and lost-game replays are in `/mnt/project-files/arena/rounds/r<K>.md` after each round.
