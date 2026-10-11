# swu_bot interface spec

Language-neutral description of the two contracts other tools build against. Both describe the repo as it is at
commit `6e1ca1b` (engine `forceteki` pinned at `2be4fcd`); the only addition is the optional stdio adapter.

| Document | What it covers | Who builds on it |
|---|---|---|
| [bot-interface.md](bot-interface.md) | The in-process JS bot contract: `choose({game, pid, actions, rng})`, action kinds and how each maps to an engine call, `EnvGame`, the match loop, determinism, the rollback API. | JS bots (heuristic, search). |
| [stdio-protocol.md](stdio-protocol.md) | Proposed JSON Lines protocol over stdin/stdout so any language can play through the in-process contract unchanged. Implemented by `bot/players/external.js`. | Rust / Python / learned bots. |
| [replay-format.md](replay-format.md) | `replays/<id>/index.json`, `games/<id>.jsonl` (header, steps with board snapshots, end), the viewer's HTTP routes, live-follow rules, and the compatibility rules for extending the format. | Viewers, analysis (LLM evaluation curves), dashboards. |

Schemas (JSON Schema 2020-12) in [`schemas/`](schemas/):

- `replay-event.schema.json`: one line of a game file.
- `tournament-index.schema.json`: `index.json`.
- `tournament-list.schema.json`: `GET /api/tournaments`.
- `stdio-protocol.schema.json`: every stdio message, both directions.

Examples in [`examples/`](examples/):

- `real-stdio-excerpt.jsonl`: the first messages of a real game between the adapter and a Python bot (engine
  `2be4fcd`, real card data).

Real replays are in `/mnt/project-files/games/demo/`. The `fake-*` files were written by the real writers (`match.js`,
`recorder.js`, `external.js`) playing a fake two-card game with made-up stats, so they show shapes, not SWU play:

- `fake-game.jsonl`: a replay.
- `fake-stdio-transcript.jsonl`: every message of one game between the adapter and `bot/examples/random_bot.py`.
- `tournament-index.json`: an index, written by hand from `tournament.js`.

Any JSON Schema 2020-12 validator works (ajv: `new (require('ajv/dist/2020'))()`); for `.jsonl` files validate each
line on its own. The schemas reference nothing outside their own file.

## Compatibility promise

- Nothing here changes the original runner, recorder or viewer. A bot that speaks the stdio protocol plugs into the
  original repo by adding `bot/observe.js`, `bot/players/external.js` and the small registry hook in `bot/tournament.js` (`loadExternalBots` and one branch in `makeBot`).
- Replay readers ignore unknown fields and event types; writers add, never rename (see replay-format.md).
- Bump `header.v` (replays) or `v` (stdio) only for a breaking change.

## Checking a non-JS bot without card data

`node bot/stdio-smoke.js -- <cmd> [args...]` plays a fake game against your bot through the real `match.js`, recorder
and adapter (it needs `forceteki/build`, not card data), and `--out dir` saves the replays and a transcript.

## Verified against real games

With real card data (2026-10-11): `npm run gate` still gives 594/342/486 steps (p2 wins) on this branch. The 12 demo
replays (4,870 lines) and a 12-game tournament of the stdio bot against random and heuristic bots (4,315 replay lines,
2,152 stdio messages) all validate. Every `card` action's target can be found by `id` in the observation.
