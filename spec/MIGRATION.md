# Moving to protocol v2

What changed between the first spec (protocol v1, replay header `v: 1`) and this one, by who is affected. Nothing is
removed: v1 bots, old replays and old indexes still work. Without a key, games are the same as upstream's
(`npm run gate`: 594/342/486 steps, p2 wins).

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
| `ms` on `hello`, `decide`, `over` | The time you have. For `decide` it covers all simulations. |
| `decide.revealed` | Cards revealed to both players since your last decision. |
| `prompt.cards` | The cards a prompt shows, with their state (`selectable`, `viewOnly`, ...), e.g. an opponent's hand shown by a "look at" effect. |
| unit `cap` | Cards a unit has captured (open information). |
| player `force`, `credits` | The Force token and credit tokens. |

Two things changed for every bot, v1 included:

- **Failure.** A late, malformed or illegal reply, an `error` reply, or an exit ends the game as `ERROR` with `by` set
  to your seat. You get no `over`, your stdin is closed, and the program is started again for its next game.
- **Process lifetime.** `bot/tournament.js` keeps one process per bot for the whole run (two when a bot plays both
  seats of a game). Reset per-game state at each `hello`.

`hello.seed` is still a 32-bit integer for your own RNG, but it now comes from a stream of its own, so it says nothing
about the game's hidden cards.

## JavaScript bots

- **Native bots** (`{ name, choose(ctx) }`, [bot-interface.md](bot-interface.md#native-bots)) work unchanged. To pick
  a distribute split, return a copy of the action with `split: [{ id, amount }]`; `forcedDistribution` is gone.
- A JavaScript bot that does not need the engine itself should be a **protocol client** instead:
  `{ name, hello?(msg), decide(msg, sim), over?(msg) }`, which runs in process or, through `serve()` from
  `bot/stdio.js`, as a program. See `bot/examples/random-bot.js` and `bot/examples/search-bot.js`.
- `bot/observe.js` is replaced by `bot/view.js` (`view(game, seat)`, `promptView`, `actionView`, `snapshot`).
  `bot/players/external.js` still exports `ExternalBot`, now the same class as `StdioClient` in `bot/stdio.js`.
  `seededRng` lives in `bot/rng.js` and is still exported from `bot/env.js`.
- `EnvGame` adds `seatOf(pid)`, `pidOf(seat)` and `winner`; `apply` returns the split it sent; `splitError(action,
  split)` checks one. `determinize(game, pid, rng)` in `bot/protocol.js` deals the hidden cards again for lookahead.
- `playGame` takes `key` (secret seeding) and `limits` (reply budgets), and returns `by` and `timing`.

## Replay readers (viewers, analysis, dashboards)

Every addition is optional and `header.v` stays `1` ([replay-format.md](replay-format.md)):

| Where | Added |
|---|---|
| every card ref | `id`: engine card id, stable for the game, the same id the protocol uses. |
| unit | `cap`: captured cards. |
| player | `handCount`, `force`, `credits`. Both hands are still listed. |
| `header` | `decks` (both full deck lists), `players[].lang`. |
| `step.action` | `i` (index of the action among the legal ones, a training label), `id` (the card clicked or picked), `split`. |
| `end` | `by`: the seat that caused an `ERROR`, or `null`. |
| `index.json` | `games[].by`, `games[].timing` (per-seat decision times measured by the referee), `key`. |

With `decks`, each step's `i` and `split`, and the seed (and `key`, if the run had one), a replay can be played again
on the engine, which brings back deck order and face-down resources. One caveat: tokens made after a simulation get
different ids than in the same game played without simulations, so compare such games up to a renaming of ids.

## Tournaments and servers

- `node bot/tournament.js --key K|none`. By default each run draws a random key; every random stream comes from it
  and the seed, and `index.json` gets the key when the run ends. `--key none` seeds from the seed alone, as upstream.
- Bot programs are registered in `bot/external-bots.json` as before, with an optional `lang`.
- The messages are the same over every transport. A server (such as the arena) offers the request-response binding
  in [protocol.md](protocol.md#transports): each call carries the bot's message and returns the referee's next one.
  Sessions, authentication and match-making are the server's own.

## For upstream

The interface stays compatible with `thrazznos/swu_bot`: the `hello` envelope is unchanged, v1 bots still play,
replays only gain fields, and unkeyed games are identical. Adopting the bot side means copying `bot/rng.js`,
`bot/view.js`, `bot/stdio.js`, `bot/protocol.js` and `bot/match.js`, plus the small changes to `bot/env.js`,
`bot/recorder.js` and `bot/tournament.js`.
