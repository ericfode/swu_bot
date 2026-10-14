# Position analysis

Walks a recorded game turn by turn and asks Claude who is winning, from four viewpoints. The output is one JSON
file per game plus an interactive page that draws the curves and the gaps between them. The same numbers double as
a fitness signal for bots.

Input is the existing replay format (`bot/recorder.js`, `spec/replay-format.md`); nothing in `bot/` or the
replay format changes.

## The four views

Every value is stored as **P(p1 wins)**, so all curves share one axis.

| view | judged from | knows | does not know |
|---|---|---|---|
| `subjective_p1` | player 1's seat | own hand, public board, both discards, opponent hand size, the log with the opponent's resource choices hidden | opponent's hand |
| `subjective_p2` | player 2's seat | same, mirrored | player 1's hand |
| `objective` | an observer | both hands, the full log so far | deck order, the future |
| `omniscient` | an analyst after the game | every checkpoint with all hands, the draws that came, the result | nothing |

The omniscient view is a hindsight judgement, not just the result: a winning position that is later thrown should
score high before the mistake and drop at it. It runs as one call over the whole game and also names the turning
points. The replay format does not record deck order or which cards were resourced, so even the objective view
cannot see those.

The gaps are the research signal:

- `subjective - objective`: what the hidden hand was worth to that player (information gap).
- `omniscient - objective`: how much of the outcome was still open given perfect state knowledge (draws and later play).

## Usage

```bash
cd analysis && npm install && cd ..        # once: the Anthropic SDK

# Claude (needs ANTHROPIC_API_KEY or `ant auth login`)
node analysis/analyze.js replays/demo/games/<game>.jsonl --out analysis/out/game.json
node analysis/analyze.js replays/demo --batch           # whole tournament as one Message Batch, half price
node analysis/report.js analysis/out/game.json --baseline analysis/out/game.heuristic.json
# with the shared game viewer (Holotable kit) embedded and synced to the curves
node analysis/report.js analysis/out/game.json --kit /mnt/project-files/viewer-kit/swu-viewer-kit.js --art-pack /mnt/project-files/viewer-kit/art-pack-demo.json
# plus the omni bot's card values in the kit's Lens view, when the game has a lens file
node analysis/report.js analysis/out/game.json --kit ... --lens /mnt/project-files/dashboard/lens/<gameId>.json

# free and offline: the heuristic evaluator, same output format
node analysis/analyze.js analysis/fixtures/fixture-game.jsonl --evaluator heuristic --out analysis/out/fixture.heuristic.json

# fitness per bot across many analysed games
node analysis/fitness.js analysis/out
```

Useful options (full list at the top of `analyze.js`):

- `--model` (default `claude-opus-5-5`), `--effort` for checkpoint calls (default `medium`), `--omni-effort` (default `high`).
- `--granularity turn|round`: a checkpoint after every player turn (default), or once per round.
- `--max-checkpoints N`: evenly subsample long games. A turn-level game has 100 to 250 checkpoints, so 3 calls each.
  A kept checkpoint covers all turns since the previous one (its `actions` list them all; `actor` is null if both
  players acted).
- `--views subjective_p1,objective`: run a subset.
- `--dashboard /mnt/project-files/dashboard/evals`: also write the research dashboard's eval file.
- `--dump-prompts file.jsonl` then `--answers answers.jsonl --label name`: run the exact same requests through any
  other model or process and feed the answers back (`{"game": ..., "id": ..., "output": {...}}` per line; `game`
  is in every dumped request and is needed when one file covers several games).

Answers are cached in `analysis/.cache` by a hash of model, effort, prompt and schema, so re-running or re-rendering
costs nothing. Direct calls use streaming, adaptive thinking, structured outputs (a JSON schema per view) and
server-side refusal fallbacks; `--batch` drops the fallbacks because the Batches API does not take them.

## Output (`t: "analysis"`, `v: 1`)

```jsonc
{
  "t": "analysis", "v": 1, "promptVersion": "pos-eval-1",
  "game": { "id", "file", "seed", "players": [{ "id": "p1", "bot", "deck" }], "winner", "rounds", "steps", "outcome" },
  "evaluator": { "kind": "llm|heuristic|external", "model", "effort", "omniEffort", "batch" },
  "settings": { "views", "granularity", "logWindow" },
  "checkpoints": [{
    "i": 12, "step": 47, "fromStep": 46, "round": 4, "phase": "action", "actor": "p2", "actions": ["tie-ln-fighter"],
    "views": {
      "subjective_p1": { "p1": 0.41, "p_win": 0.41, "confidence": 0.6, "factors": { "board", "base_race", "cards", "resources", "initiative" }, "key_factor": "board", "why": "..." },
      "subjective_p2": { "p1": 0.38, "p_win": 0.62, ... },   // p_win and factors are in the judging player's frame
      "objective": { "p1": 0.35, ... },
      "omniscient": { "p1": 0.22, "note": "...", "interpolated": false }
    }
  }],
  "omniscient": { "turningPoints": [{ "i", "by": "p1|p2|luck", "what" }], "summary": "...", "missing": 0 },
  "usage": { "calls", "cached", "errors", "input_tokens", "output_tokens", "cost_usd" }
}
```

`step` is the replay's `Step.n`, so a checkpoint deep-links into the viewer (`#/t/<tournament>/g/<game>?step=47`).

## Fitness

`fitness.js` credits each checkpoint's change in the objective P(win) to the player who acted in that turn, in that
player's frame. Per bot it reports credit per turn (mean win probability gained per own turn) and blunders per 100
turns (turns that cost more than 12 points). Regroup draws land on whoever acted last, so compare bots over many
games. A checkpoint where both players acted (round granularity, or turns merged by `--max-checkpoints`) credits
nobody, and `unattributed` reports the share of the curve's movement that had no owner, so for bot fitness analyse
every turn. It also scores each view against the result (Brier) and reports the mean information and hindsight gaps,
which is how to tell whether an LLM evaluator knows more than the heuristic one.

## Example

`examples/random-b-vs-random-a-2.*` is a real recorded game (random bots, demo tournament seed 2) at 40 checkpoints.
The `.claude.json` answers were produced by Claude through Claude Code subagents answering the `--dump-prompts`
requests one at a time in order (no API key was available), then loaded with `--answers`; the raw answers are in
`.answers.jsonl`. `.heuristic.json` is the baseline on the same checkpoints. The answers were given to the
`pos-eval-1` prompts (before subjective logs also hid picks from hidden zones). At 40 checkpoints every one covers
turns by both players, so the example has curves and gaps but no per-turn credit.

```bash
node analysis/report.js analysis/examples/random-b-vs-random-a-2.claude.json --baseline analysis/examples/random-b-vs-random-a-2.heuristic.json --game <path to the replay>
```

## Fixture

`fixtures/fixture-game.jsonl` is a game from `fixtures/sim.js`, a small SWU-like simulator that writes the exact
replay format. It is not the real rules; it exists so the pipeline and the page can be developed without the engine
build. Real games from `bot/tournament.js` work unchanged.

`test/mock-llm.test.js` runs the Claude path end to end against a fake client (direct, cache and batch).
