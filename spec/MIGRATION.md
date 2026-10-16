# Moving to protocol v2

What changed between the first spec (protocol v1, replay header `v: 1`) and this one, by who is affected. v1 bots,
old replays and old indexes still work. Without a key, games are the same as in the original swu_bot (`npm run gate`:
594/342/486 steps, p2 wins).

Written before the October 2026 split (`README.md`, "Where things went"): the research paths it names
(`bot/examples/`, `bot/learn/`, `bot/eval/`, `bot/info/`, `bot/omni/`, `bot/jev/`, `bot/rust/`) are in holocron's
`bots/` and `lab/` now, and `bot/players/external.js` is gone (use `StdioClient` from `bot/stdio.js`).

## Card data comes in `hello` (2026-10-16)

Every `hello` carries `cards`: the engine's card object for each card of both deck lists and for the 13 tokens, sorted
by `internalName` ([protocol.md](protocol.md#hello--ready)). It is the only card data a protocol bot gets, everywhere:
the arena, helpers, the browser swarm, tables, and local ladders and tournaments, which run the same referee.

- A bot that read the card files (`Card/*.json` under `$SWU_CARD_JSON`, or `forceteki/test/json`) reads
  `hello.cards` instead. Nothing hands a bot a card folder any more: the sandbox (`bot/compiled/run.py`, the swarm's
  workers) mounts no `/cards` and sets no `SWU_CARD_JSON`, and the referee sets it for no program it starts.
- Index the cards by `setId` (what board refs carry in `s`), every `setCodes` entry (deck lists may name a card by a
  reprint code: `JTL_020` is the card whose `setId` is `HMW_022`), `internalName` (action labels) and `title`
  (tokens, whose `s` is `null`).
- A submitted bundle whose `arena.json` asks for `"cards": {"use": "mount"}` is refused (the intake, and the arena
  API's `submit`): drop the `cards` key. Bundles built by `bot/compiled/build.py` and packed by the intake no longer
  have one. A version entered before 2026-10-16 that still has the key runs, but gets no `/cards`: a bot that read
  the card files plays without card data until a new version reads `hello.cards`.
- `hello` grows to 24-75 KB, one line on stdio.

## Bot programs (Rust, Python, any language)

A v1 bot runs unchanged. To move to v2:

1. Answer `hello` with `{"t":"ready","v":2}`. Add `"sim":true` to get simulations.
2. Answer `over` with `{"t":"ok"}`.
3. Send a chosen split as `split` (v1 called it `distribution`; both are accepted).

What v2 gives a bot ([protocol.md](protocol.md)):

| New | Use |
|---|---|
| `over` | The result of every game: train, log, reset state. |
| `hello.deck`, `hello.opponent` | Both deck lists, before the first decision. A known-decklist bot no longer needs to guess. |
| `sim` / `simulated` | Play ahead on a private copy of the game. Each `begin` deals your hidden cards again (your deck order, the opponent's hand, face-down resources and deck), so a search over `begin`s is a determinized search, as ISMCTS needs. A numbered `deal` repeats the same cards, for comparing actions on one deal. |
| `ms` on `hello`, `decide`, `over`, `simulated` | The time you have (`null`: no limit). For `decide` it covers all simulations; each `simulated` says what is left. |
| `decide.revealed` | Cards revealed to both players since your last decision. |
| `prompt.cards` | The cards a prompt shows, with their state (`selectable`, `viewOnly`, ...), e.g. an opponent's hand shown by a "look at" effect. |
| unit `cap` | Cards a unit has captured (open information). |
| player `force`, `credits` | The Force token and credit tokens. |
| player `passed`, `out` | The player passed its last action / is done for the action phase. You can now tell when your pass ends the phase. |
| base and leader `epic` | The epic action (base) or deploy (leader) is used up; a defeated leader no longer looks undeployed. |

Things that changed for every bot, v1 included:

- **Card ids** are `c` and a number (`c41`), stable for the whole game and the same in replays and simulations. They
  were engine ids (`Card_41`). Treat them as opaque strings.
- **Hidden cards are never named.** When an engine bug lets you pick a card in the opponent's hand (Sundari Palace),
  the action shows `label: "hidden card"` and `card.id: "hidden"`. Answer by index as usual.
- **Failure loses.** A late, malformed or illegal reply, an `error` reply, or an exit ends the game as `ERROR` with
  `by` set to your seat, and the other seat wins. You get no `over`, your stdin is closed, and the program is started
  again for its next game.
- **Process lifetime.** `bot/tournament.js` keeps one process per bot for the whole run (two when a bot plays both
  seats of a game). Reset per-game state at each `hello`. `cmd` must be the bot itself or `exec` it: closing a program
  ends its stdin and kills it 2 s later.

`hello.seed` is still a 32-bit integer for your own RNG, but it now comes from a stream of its own, so in a keyed game
it says nothing about the hidden cards.

## JavaScript bots

- **Native bots** (`{ name, choose(ctx) }`, [bot-interface.md](bot-interface.md#native-bots)) work unchanged.
  `choose` may now return a promise. To pick a distribute split, return a copy of the action with
  `split: [{ id, amount }]`; `forcedDistribution` is gone. A throw or an illegal action now loses the game
  (`by` = its seat) instead of counting as an engine error.
- A JavaScript bot that does not need the engine itself should be a **protocol client** instead:
  `{ name, hello?(msg), decide(msg, sim), over?(msg) }`, which runs in process or, through `serve()` from
  `bot/stdio.js`, as a program. See `bot/examples/random-bot.js` and `bot/examples/search-bot.js`.
- `bot/observe.js` is replaced by `bot/view.js`: `view(game, seat)`, `promptView(game, pid)`,
  `actionView(game, action, i, pid)` (pass `pid` so hidden cards stay hidden), `snapshot(game)`.
  `bot/players/external.js` still exports `ExternalBot`, now the same class as `StdioClient` in `bot/stdio.js`.
  `seededRng` lives in `bot/rng.js` and is still exported from `bot/env.js`.
- `EnvGame` adds `seatOf(pid)`, `pidOf(seat)`, `winner`, and `cardId(uuid)` / `uuidOf(id)` between engine uuids and
  card ids; `apply` returns the split it sent; `splitError(action, split)` checks one. `determinize(game, pid, rng)` in
  `bot/protocol.js` deals the hidden cards again for lookahead.
- `playGame` takes `key` (secret seeding) and `limits` (reply budgets), returns `by`, `key` and `timing`, refuses one
  protocol client in both seats, and closes no bot. `makeBot(name, taken)` in `bot/players/index.js` hands out one
  process per bot name for the whole run (`taken`: the bots already seated in this game); call `closeBots()` at the
  end and await it before `process.exit()`, so every program sees the end of its input and exits.
  `bot/ladder-worker.js`, `bot/learn/*.js`, `bot/eval/arena.js` and `bot/rust/check.js` do.
- A native bot with `needsUndo` gets the referee's copy of the game as `ctx.game`, never the real one, and the real
  game runs without rollback. Before, its rollbacks could change how the real game played out (seen with an ISMCTS bot:
  a later "will have no effect" check came out differently, so the opponent lost its simulations and the replay could
  not be played again). Nothing changes in how such a bot reads or searches the game.
- A script with its own game loop that calls `choose` itself (`bot/info/dial.js`, `bot/omni/export-positions.js`)
  can drive only native bots; a bot program (a protocol client from `makeBot`) plays through `playGame`.
- `bot/jev/look.js` (the Jev look-ahead adapter) is a native bot now: it runs the v1 Jev program and imagines on the
  copy, after dealing every card hidden from Jev again, so an imagined line no longer follows the real opponent hand.

## Replay readers (viewers, analysis, dashboards)

Every addition is optional and `header.v` stays `1` ([replay-format.md](replay-format.md)):

| Where | Added |
|---|---|
| every card ref | `id`: card id, `c` and a number, stable for the game, the same id the protocol uses. |
| unit | `cap`: captured cards. |
| player | `handCount`, `force`, `credits`, `passed`, `out`. Both hands are still listed. |
| base, leader | `epic`: the epic action or deploy is used. |
| `header` | `decks` (both full deck lists), `players[].lang`. Written before the bots' `hello`, so a game whose bot failed there has a header and an end. |
| `step.action` | `i` (index of the action among the legal ones, a training label), `id` (the card clicked or picked), `split`. |
| `end` | `by`: the seat that caused an `ERROR`, or `null`; `key` in keyed games. |
| `index.json` | `games[].by`, `games[].timing` (per-seat decision times measured by the referee), `games[].key`. |

Scoring: an `ERROR` with `by` set is a loss for that bot (the viewer, `bot/ladder-report.js`); with `by: null` it has
no result.

With `decks`, each step's `i` and `split`, the seed and the game's `key`, a replay can be played again on the engine,
which brings back deck order and face-down resources; ids come out the same.

## Tournaments and servers

- `node bot/tournament.js --key K|none`, and the same option on `bot/ladder.js`, `bot/learn/eval.js` and
  `bot/learn/collect.js`. By default each run draws a random key; every game gets its own key derived from it,
  written to its index entry and replay when the game ends (`end` lines in collect's output). `--key none` seeds from
  the seed alone, as the original swu_bot does. Bot programs can read the referee's command line, so give `--key` only to play a
  finished run again. The run key is in `ladder.json` (`config.key`) when the run is done, in eval's `summary.json`,
  and in collect's last line.
- A/B runs: within one run every pairing gets the same decks for the same seed, as before. Two separate runs get the
  same decks only with the same `--key` (take it from the first run) or with `--key none`; before, the same `--seed`
  was enough.
- `bot/learn/collect.js` writes `winner: null` for a game a bot broke (`outcome` "ERROR", `by` that seat), so it is
  never a training label, and keeps each program's own time limits.
- Bot programs are registered in `bot/external-bots.json` as before, with an optional `lang` and `adapter`.
- The messages are the same over every transport. A server (such as the arena) offers the request-response binding
  in [protocol.md](protocol.md#transports): each call carries the bot's message and returns the referee's next one.
  Sessions, authentication and match-making are the server's own.

## Compatibility with the original swu_bot

The interface stays compatible with the original `thrazznos/swu_bot`: the `hello` envelope is unchanged, v1 bots
still play, replays only gain fields, and unkeyed games are identical. The referee is `bot/rng.js`, `bot/view.js`,
`bot/stdio.js`, `bot/protocol.js` and `bot/match.js`, plus the changes to `bot/env.js` and `bot/recorder.js` (now a
one-line alias of `view.snapshot`). The example clients are in Holocron's `bots/examples/`.
