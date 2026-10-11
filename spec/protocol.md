# Bot protocol (v2)

Every bot is a **client** of the match runner, the **referee**. They exchange JSON messages; the same messages travel
over a pipe to a program in any language, as plain objects to a JavaScript object in the same process, or over a
server API such as the arena's. Only the transport differs. Bots that drive the engine object directly are a special
case for JavaScript search code ([bot-interface.md](bot-interface.md#native-bots)).

Schema: [`schemas/protocol.schema.json`](schemas/protocol.schema.json). Reference clients: `bot/examples/random_bot.py`
(Python, standard library), `bot/examples/random-bot.js` and `bot/examples/search-bot.js` (JavaScript, in process or as
a program; the second searches with simulations). Conformance checks: `node bot/protocol-test.js`.

## Conversation

```
referee                              bot
  hello  (ms) ─────────────────────▶
              ◀─────────────────────  ready
  decide (ms) ─────────────────────▶                       ┐ once per decision
              ◀─────────────────────  sim                  │ any number of times,
  simulated   ─────────────────────▶                       │ only when decide.sim is true
              ◀─────────────────────  act                  ┘
  over   (ms) ─────────────────────▶
              ◀─────────────────────  ok
  hello  ...                                                 next game, or the end of the session
```

1. **One message at a time.** Each side sends one message and then waits for the other. `hello`, `decide` and `over`
   each get exactly one final reply (`ready`, `act`, `ok`). Between a `decide` and its `act` the bot may send `sim`
   requests, and each gets one `simulated` reply. Nothing is sent unprompted.
2. **Time.** `hello`, `decide` and `over` carry `ms`: the time the bot has for its final reply, counted from when the
   referee sent the message. For `decide` it covers every `sim` exchange in between, including the referee's time
   running them. Defaults: 30000 for `hello` (it includes starting a program), 10000 for `decide` and `over`.
3. **Failure.** A reply of `{"t":"error","error":"why"}`, a reply that is late, malformed or not allowed (an index
   out of range, an illegal split), or a program that exits, ends the game: outcome `ERROR`, blamed on that seat.
   That bot gets no `over`, and its connection is closed; a program is started again for its next game.
4. **Growth.** Readers ignore unknown fields. Fields are only added within a version; a new message type or a changed
   meaning needs a new version.
5. **End.** The session ends after any `ok`, or before the first `hello`. On stdio the referee closes the bot's stdin;
   a binding without end-of-file sends `{"t":"bye"}`, which gets no reply.

## Transports

- **stdio.** The referee starts the program and writes one JSON object per line (UTF-8, `\n`) to its stdin; the bot
  answers one line per reply on stdout and logs only to stderr. One program plays one seat at a time and may play many
  games in a row, each starting with `hello`. End-of-file on stdin means exit. Implemented by `bot/stdio.js`
  `StdioClient`; register programs in `bot/external-bots.json` (below).
- **In process (JavaScript).** An object `{ name, hello?(msg), decide(msg, sim), over?(msg) }`. Each method returns
  the reply or a promise of it; `hello` defaults to `{"t":"ready","v":2}` and `over` to `{"t":"ok"}`. `sim(request)`
  returns a promise of the `simulated` reply: always `await` it. Messages are shared objects, so do not modify them.
  `serve(client)` in `bot/stdio.js` runs the same object as a stdio program, so a bot tested in process can be
  deployed as a program unchanged. In-process code runs inside the referee and can reach the engine, so it is trusted:
  the referee enforces `ms` when control comes back to it, but cannot stop a synchronous loop.
- **Request-response (HTTP, WebSocket, MCP tool calls).** One call per bot message: the call carries the bot's
  message and returns the referee's next message; the first call carries no message and returns `hello`. `ms` counts
  from when the referee hands its message out. Sessions, authentication and match-making belong to the server that
  offers this binding (the arena), not to this protocol.

## Messages

### `hello` → `ready`

```json
{"t":"hello","protocol":"swu-bot-stdio","v":1,"versions":[1,2],"bot":"rust-mcts","you":"p1","seed":1968796899,"ms":30000,
 "players":[{"id":"p1","name":"p1","bot":"rust-mcts"},{"id":"p2","name":"p2","bot":"heuristic"}],
 "deck":{"metadata":{"name":"Darth Vader / Echo Base","author":"bot"},"leader":{"id":"SOR_010","count":1},"base":{"id":"SOR_023","count":1},"deck":[{"id":"SOR_042","count":3}]},
 "opponent":{"metadata":{"name":"...","author":"bot"},"leader":{"id":"SHD_009","count":1},"base":{"id":"SHD_021","count":1},"deck":[...]}}
```

| Field | Meaning |
|---|---|
| `protocol`, `v`, `bot` | Always `swu-bot-stdio`, `1`, and the name the bot is registered under. `hello` looks the same in every version so that any bot can read it. |
| `versions` | Protocol versions the referee speaks: `[1, 2]`. |
| `you` | Your seat this game, `p1` or `p2`. |
| `seed` | Integer in `[0, 2^32)` for this game and seat. Seed your own RNG from it to make games reproducible. It tells you nothing about the game's hidden cards. |
| `players` | Both seats: engine name and bot name. |
| `deck`, `opponent` | Both deck lists (they are open, see Fairness): `{ metadata, leader, base, deck: [{ id, count }] }` with set codes `<SET>_<NNN>`. |

Reply `{"t":"ready","v":2,"name":"rust-mcts","sim":true}`. `v` is the version you pick from `versions`; omitted means
1, anything not offered is an error. `sim: true` asks for simulations (the referee then creates the game with
rollback enabled). `name` is informational.

### `decide` → `act`

```json
{"t":"decide","seq":12,"you":"p1","sim":true,"ms":10000,
 "prompt":{"type":"actionWindow","signature":"actionWindow|-","title":"Choose an action","promptTitle":null,"selectCardMode":null,"selected":[],"actionWindow":true},
 "state":{"round":2,"phase":"action","initiative":"p1","players":{"p1":{...},"p2":{...}}},
 "actions":[{"i":0,"kind":"button","label":"Pass","arg":"pass"},
            {"i":1,"kind":"card","label":"wampa","cardUuid":"Card_41","card":{"id":"Card_41","n":"Wampa","s":"SOR_042","zone":"hand","ctl":"p1"}}],
 "revealed":[]}
```

Reply `{"t":"act","i":1}` with the index of the chosen action. For a `distribute` action you may add the split:
`{"t":"act","i":0,"split":[{"id":"Card_7","amount":2},{"id":"Card_9","amount":1}]}`; without one the referee picks a
random legal split.

| Field | Meaning |
|---|---|
| `seq` | Decision number in this game, from 1. |
| `sim` | `true` when `sim` requests are allowed now: you asked for them and this is an action window. |
| `ms` | Your time for the `act`, simulations included. |
| `prompt` | What is being asked, below. |
| `state` | The board as your seat sees it, below. |
| `actions` | The legal actions, never empty, below. |
| `revealed` | Cards revealed to both players since your last decision (`{ id, n, s, zone, ctl }`), for reveals that show no prompt. |

**Prompt.** `type` (the engine prompt type, `null` for target selection), `signature` (the shape string replays
record), `title` and `promptTitle` (texts, may be `null`), `selectCardMode` (`single`, `multiple` or `null`),
`selected` (ids already selected in a multi-select prompt), `actionWindow` (`true` at the top-level "choose an
action" prompt), and `cards` when the prompt shows cards: `[{ id, n, s, zone, ctl, st }]` with `st` one of
`selectable`, `selected`, `unselectable`, `invalid`, `viewOnly`. These are the cards a player at the table would see,
such as an opponent's hand shown by a "look at" effect.

**State.** `round`, `phase` (`setup`, `action`, `regroup`), `initiative` (a seat or `null`) and `players.p1`/`p2`:

| Field | Meaning |
|---|---|
| `name` | Engine user name. |
| `base` | `{ id, n, s, hp, d }`: printed HP and damage. |
| `leader` | `{ id, n, s, dep, x }` (`dep` 1 = deployed, then also listed as a unit; `x` 1 = exhausted), or `null`. |
| `res` | `{ ready, total }` resources. |
| `handCount`, `deck` | Cards in hand and left in the deck. |
| `force`, `credits` | `force: 1` when the player has the Force token; `credits`: credit tokens. Absent when zero. |
| `hand`, `resources` | Your own player only: `[{ id, n, s }]`, resources with `x: 1` when exhausted (you can play from them with Smuggle). |
| `discard` | `[{ id, n, s }]`. |
| `ground`, `space` | Units the player controls: `{ id, n, s, p, h, d, x?, sn?, u?, cap? }`: power, max HP, damage, exhausted, Sentinel, upgrades `[{ id, n, s, t }]` (`t` 1 = token) and captured cards `[{ id, n, s }]`. |

`id` is the engine card id, stable for the whole game; `n` is the title and `s` the set code or `null` (tokens). The
opponent's hand and resources and both decks' order are never shown.

**Actions.** `i`, `kind` and `label` always; `arg` (a string, or a number for choice-menu buttons) and `cardUuid` when
the action has them; plus:

| `kind` | What it is | Extra |
|---|---|---|
| `button` | A prompt button (Pass, Done, a menu choice). | |
| `card` | Click a card: play it, attack with it, target it, select it. | `card: { id, n, s, zone, ctl }` |
| `option` | A dropdown entry or a number (`label` `#<n>`). A "name a card" dropdown lists about 1,900 entries. | |
| `displayCard` | Pick one of the shown cards (`arg` is its id). | |
| `perCardButton` | A button on one shown card. | |
| `distribute` | Split damage, healing or tokens. | `distribute: { type, amount, canDistributeLess, canChooseNoTargets, maxTargets, tokenType, targets: [{ id, cap }] }` (`cap: null` = no cap) |

A legal split names only listed targets, each at most once, with integer amounts from 0 to `cap`, at most
`maxTargets` non-zero entries, and a total equal to `amount` (at most `amount` with `canDistributeLess`; 0 only with
`canChooseNoTargets`).

### `sim` → `simulated`

During a decision whose `sim` is `true`, a bot can play ahead on a private copy of the game.

| Request | Effect | Reply |
|---|---|---|
| `{"t":"sim","op":"begin","deal":3}` | Starts a simulation from the real position, ending any open one first, and deals the hidden cards again (below). `deal` is optional. | a position |
| `{"t":"sim","op":"act","i":3}` (`split` allowed) | Plays action `i` of the last position for whichever seat had to act. | the next position |
| `{"t":"sim","op":"end"}` | Ends the simulation; does nothing when none is open. Never fails. | `{"t":"simulated","op":"end"}` |

A position is `{"t":"simulated","op":"begin","actor":"p1","prompt":{...},"state":{...},"actions":[...]}`, with the
same shapes as `decide`. `actor` is the seat that must act: you play both seats, so you choose the opponent's moves
too (when both seats have a prompt, yours comes first). When the simulated game ends the reply is
`{"t":"simulated","op":"act","over":{"winner":"p1"}}`. `state` is always from your seat.

Every reply echoes `op`. Only `begin` and `act` can fail: sims off for this decision, out of time, no open simulation,
a bad index or split, the simulated game already over, an engine error, or an unknown `op`. The reply is then
`{"t":"simulated","op":"act","error":"why"}` and no simulation is open any more; the game goes on. Your final `act`
refers to the real `decide` and ends an open simulation first.

**What a simulation hides.** At `begin` every card hidden from you is dealt again at random: your deck order, and the
opponent's hand, face-down resources and deck, from one shuffle of all three. Zone sizes and the number of exhausted
resources stay. The randomness comes from a stream private to your seat, so a simulation never changes the real game,
and it cannot be predicted from anything you are sent. Within one decision, the same `deal` number gives the same
cards and the same random outcomes for the same moves, so a search can compare actions on one deal; a `begin` without
`deal` gets a deal not used before. Simulations leave one trace: the engine numbers new cards (tokens) from a counter
that a rollback does not rewind, so cards created later in the real game get different ids than in the same game
played without simulations. Play is otherwise identical.

### `over` → `ok`

```json
{"t":"over","you":"p1","winner":"p2","outcome":"won","round":14,"steps":412,"error":null,"by":null,"ms":10000}
```

`winner` is `p1`, `p2`, `draw` or `null`; `outcome` is `won`, `STEP_CAP`, `STUCK` or `ERROR`; for `ERROR`, `error`
says why and `by` names the seat that caused it (`null`: the engine or the referee). Sent after every game a v2 bot
joined, failed ones included, except to a bot that caused the failure. Reply `{"t":"ok"}` once any learning you want
to finish before the next game is done. A failure here changes no result; the program is restarted for its next game.

## Fairness

- **Deck lists are open.** Both lists are in `hello`. Engine card ids follow deck-list order, and simulations deal
  from the opponent's real unseen cards, so a closed list could not be kept secret anyway.
- **Seeds hide nothing.** The referee derives every random stream (decks, engine shuffles, `hello.seed`, simulations)
  from the game seed and a secret key (`playGame({ key })`; `bot/tournament.js` draws one per run and writes it to
  `index.json` when the run ends, which makes every game reproducible). Without a key the streams follow from the seed
  alone, which suits development and `npm run gate` but lets a bot that guesses the seed rebuild the hidden cards.
- **Programs in other languages need a sandbox to be held to these rules.** A program on the referee's machine could
  read the live replay files (they show both hands while a game runs) or the viewer's port. Run untrusted programs
  without access to `replays/` and the viewer. In-process clients and native bots are trusted.

## Running bot programs

`bot/external-bots.json` (or the file named by `$SWU_EXTERNAL_BOTS`) maps a bot name to a program; the name then works
in `node bot/tournament.js --bots ...` like any other bot.

```json
{
  "rust-mcts": { "cmd": "bot/rust/target/release/swu-bot-rs", "args": ["mcts"], "lang": "rust" },
  "py-random": { "cmd": "python3", "args": ["bot/examples/random_bot.py"], "stderr": "ignore", "lang": "python" }
}
```

| Option | Default | Meaning |
|---|---|---|
| `cmd`, `args` | required, `[]` | Program to start. |
| `cwd`, `env` | repo root, `{}` | Working directory, extra environment variables. |
| `stderr` | `inherit` | `inherit` shows the program's stderr, `ignore` drops it. |
| `timeoutMs`, `startTimeoutMs` | 10000, 30000 | This bot's `ms` for `decide`/`over` and for `hello`. |
| `lang` | none | Language label for replays and the dashboard (`rust`, `python`, ...). |

A tournament keeps one process per bot for the whole run (two when a game needs the same bot in both seats). From
JavaScript: `new StdioClient(name, options)` from `bot/stdio.js`, passed to `playGame` like any bot.

## Versions

A bot whose `ready` has no `v`, or `v: 1`, plays protocol v1 ([stdio-protocol.md](stdio-protocol.md)): it gets no
`over` and no simulations, and its split may be called `distribution`. It also receives the v2 fields in `hello` and
`decide`, which it ignores. To move a v1 bot to v2: answer `ready` with `"v":2`, answer `over` with `ok`, and rename
`distribution` to `split`. What else changed for bot authors is in [MIGRATION.md](MIGRATION.md).
