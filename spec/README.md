# swu_bot interface spec

Language-neutral description of the contracts other tools build against: how a bot plays the engine, and what a
recorded game looks like. Engine: `forceteki` pinned at `2be4fcd`.

| Document | What it covers | Who builds on it |
|---|---|---|
| [protocol.md](protocol.md) | The bot protocol (v2): JSON messages between a bot and the referee, over stdio, in process or through a server; time limits, failure, simulations, fairness. | Every bot, in any language; the arena. |
| [bot-interface.md](bot-interface.md) | The JavaScript layer under it: `EnvGame`, how actions become engine calls, the match loop, determinism, and native bots with direct engine access. | JS search code, the referee itself. |
| [replay-format.md](replay-format.md) | `replays/<id>/index.json` and `games/<id>.jsonl` (header, steps with board snapshots, end), the viewer's HTTP routes, live-follow rules, compatibility rules. | Viewers, analysis (LLM evaluation curves), dashboards. |
| [MIGRATION.md](MIGRATION.md) | What changed since the first spec, by audience. | Anyone with code written against v1. |
| [stdio-protocol.md](stdio-protocol.md) | Protocol v1, which the referee still speaks. | Existing v1 bots. |

Schemas (JSON Schema 2020-12) in [`schemas/`](schemas/):

- `protocol.schema.json`: every protocol message, both directions, v1 and v2.
- `replay-event.schema.json`: one line of a game file.
- `tournament-index.schema.json`: `index.json`.
- `tournament-list.schema.json`: `GET /api/tournaments`.

Any JSON Schema 2020-12 validator works (ajv: `new (require('ajv/dist/2020'))()`); for `.jsonl` files validate each
line on its own. The schemas reference nothing outside their own file.

Examples in [`examples/`](examples/), from a real keyed game (engine `2be4fcd`, real card data):

- `transcript-v2.jsonl`: messages between the referee and `bot/examples/search-bot.js` running as a program, in
  order: `hello`, the first decision, a decision with simulations (one simulation, cut after its first move), and
  `over`. The referee sends `hello`, `decide`, `simulated` and `over`; the bot sends the rest.
- `tournament-index.json`: the index of a 6-game run (search, Python and native random bots), with `timing` and `key`.

Real replays: `/mnt/project-files/games/demo/` (v1 fields) and `/mnt/project-files/games/protocol-v2/` (all fields).

## Compatibility promise

- Every bot is a protocol client; the hello envelope (`protocol`, `v: 1`, `bot`) never changes, so any bot can read
  it, and the bot picks its version in `ready`. v1 bots keep working.
- Replay readers ignore unknown fields and event types; writers add, never rename (see replay-format.md).
- Without a key, games are the same as upstream `thrazznos/swu_bot`: `npm run gate` gives 594/342/486 steps, p2 wins.
- Bump `header.v` (replays) or add a protocol version only for a breaking change.

## Checking a bot

`node bot/protocol-test.js` runs the conformance checks (determinism, keyed seeds, time budgets, stdio/in-process
parity, simulations leave no trace, replays play again, v1 bots, splits, simulation mistakes, bot failures). To try
your own program, register it in `bot/external-bots.json` and play it:
`node bot/tournament.js --bots my-bot,node-random --games 4 --out replays/try`, then validate the replays and check
`index.json` for `ERROR` games and their `by`.

## Verified against real games

With real card data (2026-10-11): `npm run gate` gives 594/342/486 steps (p2 wins). A keyed game between the search
bot and the Python bot (5,196 protocol messages, simulations included), the replays of that game and of two
tournaments (27 games, 8,278 lines) and both indexes validate against the schemas; the schemas reject 10 hand-made
bad messages.
