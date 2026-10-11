# Bot protocol v1

Version 1 is the first form of the [bot protocol](protocol.md). The referee still speaks it, so v1 bots keep working
unchanged; new bots should use v2. Both versions share one schema,
[`schemas/protocol.schema.json`](schemas/protocol.schema.json).

A bot plays v1 when its `ready` has no `v` or `"v":1`. Compared with v2:

| | v1 | v2 |
|---|---|---|
| Messages | `hello` → `ready`, `decide` → `act`, `error` | also `over` → `ok`, `sim` → `simulated`, `bye` |
| Game end | Not told; the next `hello` or end-of-file comes instead. | `over` with the result. |
| Looking ahead | No. | Simulations, when `ready` has `"sim":true`. |
| Split field in `act` | `distribution` | `split` (`distribution` is still accepted) |

Everything else is the same: transport, `hello`, `decide` and `act`. A v1 bot also receives the fields v2 added to
`hello` and `decide` (`versions`, `ms`, `deck`, `opponent`, `sim`, `revealed`, `prompt.cards` and `cap`),
and ignores them as v1 already required. `decide.sim` is always `false` for a v1 bot.

Two things changed for v1 bots too:

- `hello.seed` comes from a stream of its own, not the match rng, so it tells nothing about the hidden cards.
- `bot/tournament.js` keeps one process per bot for the whole run, so a program plays many games in a row (v1 always
  allowed this; the old runner started a process per game). After a game the bot broke, it is started again.

Moving to v2 takes three changes: answer `ready` with `"v":2`, answer `over` with `{"t":"ok"}`, and rename
`distribution` to `split`. [MIGRATION.md](MIGRATION.md) lists everything else that changed.
