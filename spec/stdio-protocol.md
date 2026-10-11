# stdio bot protocol (v1, proposed)

Lets a bot written in any language (Rust, Python, ...) play through the unchanged in-process interface. The adapter
`bot/players/external.js` is an ordinary bot object (`{ name, choose }`); for each decision it sends the bot process
one JSON line on stdin and reads one JSON line back from stdout. `match.js`, `tournament.js`, `env.js` and the replay
format are untouched, so the original repo can run these bots by copying two files (`bot/observe.js`,
`bot/players/external.js`) and adding the registry lines in `tournament.js`.

Schema: [`schemas/stdio-protocol.schema.json`](schemas/stdio-protocol.schema.json). Reference client:
`bot/examples/random_bot.py` (standard library only).

## Running one

Register it in `bot/external-bots.json` (or a file named by `$SWU_EXTERNAL_BOTS`):

```json
{
  "rust-greedy": { "cmd": "bots/rust/target/release/swu-greedy", "args": [], "timeoutMs": 10000 },
  "py-random":   { "cmd": "python3", "args": ["bot/examples/random_bot.py"], "stderr": "ignore" }
}
```

then use the name like any other bot: `node bot/tournament.js --bots rust-greedy,heuristic --games 10 --out replays/r1`.

| Option | Default | Meaning |
|---|---|---|
| `cmd`, `args` | required, `[]` | Program to start. |
| `cwd` | repo root | Working directory. |
| `env` | `{}` | Extra environment variables. |
| `timeoutMs` | `10000` | Per-decision reply timeout. |
| `startTimeoutMs` | `30000` | Timeout for the `hello` reply (includes process start). |
| `stderr` | `inherit` | `inherit` shows the bot's stderr, `ignore` drops it. |

From JavaScript: `new ExternalBot(name, options)` from `bot/players/external.js`.

## Transport

- UTF-8 JSON Lines: exactly one JSON object per line, `\n`-terminated, in both directions.
- Strict request/response: the adapter sends one message and waits for exactly one reply line. The bot never writes
  to stdout unprompted. **stdout is protocol only; log to stderr.** Flush after every line.
- The process is started at its first decision and can serve several games in a row: each game starts with a new
  `hello`. Stdin closing (EOF) means stop; exit then.
- If the bot does not reply in time, replies with something that is not JSON, sends `{"t":"error"}`, picks an
  index out of range, or exits, the adapter throws and the game ends with outcome `ERROR` and that message.
- Every message has `t` (type). Ignore unknown fields: later versions may add them.

## Messages

### `hello` (adapter -> bot) / `ready` (bot -> adapter)

```json
{"t":"hello","protocol":"swu-bot-stdio","v":1,"bot":"py-random","you":"p2","seed":2837461923,"players":[{"id":"p1","name":"p1"},{"id":"p2","name":"p2"}]}
```

| Field | Meaning |
|---|---|
| `protocol`, `v` | Always `swu-bot-stdio`, `1`. |
| `bot` | The name this bot was registered under. |
| `you` | Seat this bot plays this game. |
| `seed` | Integer in `[0, 2^32)` drawn from the match RNG. Seed your own RNG from it to keep games reproducible. |
| `players` | Seats and engine names. |

Reply `{"t":"ready","v":1,"name":"py-random"}`. `v` is optional; if present and not `1` the adapter refuses to play.
`name` is informational.

### `decide` (adapter -> bot) / `act` (bot -> adapter)

```json
{"t":"decide","seq":12,"you":"p1",
 "prompt":{"type":null,"signature":"-|single","title":"Choose a unit to attack","promptTitle":"Wampa","selectCardMode":"single","selected":[],"actionWindow":false},
 "state":{ "round":2,"phase":"action","initiative":"p1","players":{ "p1":{...}, "p2":{...} } },
 "actions":[
   {"i":0,"kind":"card","label":"battlefield-marine","cardUuid":"c41","card":{"id":"c41","n":"Battlefield Marine","s":"SOR_095","zone":"groundArena","ctl":"p2"}},
   {"i":1,"kind":"card","label":"echo-base","cardUuid":"c7","card":{"id":"c7","n":"Echo Base","s":"SOR_023","zone":"base","ctl":"p2"}},
   {"i":2,"kind":"button","label":"Cancel","arg":"cancel"}
 ]}
```

Reply with the chosen action's index: `{"t":"act","i":0}`.

`seq` counts decisions within the game from 1. `you` repeats the seat.

**`prompt`**

| Field | Meaning |
|---|---|
| `type` | Engine `promptType` or `null` (target selection prompts have none). See bot-interface.md for values. |
| `signature` | `promptSignature(pid)`, the same string replays record as `prompt`. |
| `title`, `promptTitle` | Prompt text and the prompt's source (often the card whose ability asks). Either may be `null`/`""`. |
| `selectCardMode` | `single`, `multiple` or `null`. |
| `selected` | Card uuids already selected in a multi-select prompt. |
| `actionWindow` | `true` at the top-level "choose an action" prompt of the action phase. |

**`state`** is the replay snapshot ([replay-format.md](replay-format.md#snapshot-state)) seen from your seat, with
these differences:

- every card ref (base, leader, hand, discard, units, upgrades) has `id`, the engine card uuid, which is what
  `cardUuid`, `card.id` and distribute target ids refer to;
- each player has `handCount`; only your own player has `hand`, the opponent's is omitted;
- only your own player has `resources`: your resource cards (`{ id, n, s }`, plus `x: 1` when exhausted), since
  cards can be played from there (Smuggle). The opponent's resources are face down, so only `res` counts.

Deck order is never shown.

**`actions[]`** are `legalActions(pid)` in order, without engine objects. `i`, `kind`, `label` are always present;
`arg` and `cardUuid` are copied when the action has them. `arg` is a string, except that buttons in choice menus
("Choose an ability:", "Yourself / Opponent", ...) carry a number. A dropdown can be long: "name a card" prompts list
every card name (about 1,900 `option` actions, a ~150 KB line). Extra fields:

| `kind` | Extra |
|---|---|
| `card` | `card: { id, n, s, zone, ctl }`: the card's uuid, title, set code, current zone (`hand`, `groundArena`, `spaceArena`, `base`, `discard`, `resource`, ...) and controlling seat. |
| `distribute` | `distribute: { type, amount, canDistributeLess, canChooseNoTargets, maxTargets, tokenType, targets: [{ id, cap }] }`; `cap: null` means uncapped; `maxTargets`/`tokenType` may be `null`. |

Action kinds and what they do are in [bot-interface.md](bot-interface.md#actions).

**Choosing a distribute split.** For a `distribute` action the reply may add the split:

```json
{"t":"act","i":0,"distribution":[{"id":"c41","amount":2},{"id":"c7","amount":3}]}
```

Rules (the adapter checks them and throws if broken): ids are targets, no repeats, integer amounts `0..cap`, at most
`maxTargets` non-zero entries, total equal to `amount` (at most `amount` if `canDistributeLess`; `0` only if
`canChooseNoTargets`). Without `distribution` the engine side picks a random legal split, as for in-process bots.

### `error` (bot -> adapter)

`{"t":"error","error":"why"}` as any reply aborts the game with that message.

## Not in v1

- **Game end.** The in-process interface has no end-of-game call, so a bot is never told the result; it sees the
  next `hello` or EOF. A learning bot can read the outcome from the replay. A possible additive fix: `match.js` calls
  `bot.gameOver?.(result)` after the loop, which the adapter would forward as `{"t":"over","winner":...}`.
- **Search.** Out-of-process bots cannot `mark`/`restore` the engine. A later version could expose
  `{"t":"try","seq":...}` requests answered by the adapter with the resulting observation, but that changes the
  strict one-reply-per-message flow and is left for when a bot needs it.
- **History.** Each `decide` is self-contained. A bot that wants the opponent's moves can diff consecutive states.
