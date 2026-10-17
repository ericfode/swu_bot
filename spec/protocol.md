# Bot protocol (v2)

Every bot is a **client** of the match runner, the **referee**. They exchange JSON messages; the same messages travel
over a pipe to a program in any language, as plain objects to a JavaScript object in the same process, or over a
server API such as the arena's. Only the transport differs. Bots that drive the engine object directly are a special
case for JavaScript search code ([bot-interface.md](bot-interface.md#native-bots)).

Schema: [`schemas/protocol.schema.json`](schemas/protocol.schema.json). A bot for the arena is a program that reads
these messages on stdin and writes its replies on stdout: [`bot/arena/BUILD.md`](../bot/arena/BUILD.md) has a whole
bot in Python and in JavaScript, and [Running bot programs](#running-bot-programs) says how to play one.

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
   referee sent the message, or `null` for no limit. For `decide` it covers every `sim` exchange in between, including
   the referee's time running them. Defaults: 30000 for `hello` (it includes starting a program), 10000 for `decide`
   and `over`.
3. **Failure.** A reply of `{"t":"error","error":"why"}`, a reply that is late, malformed or not allowed (an index
   out of range, an illegal split), or a program that exits, ends the game: outcome `ERROR`, `by` that seat, and the
   other seat wins. That bot gets no `over`, and its connection is closed; a program is started again for its next
   game.
4. **Growth.** Readers ignore unknown fields. Fields are only added within a version; a new message type or a changed
   meaning needs a new version.
5. **End.** The session ends after any `ok`, or before the first `hello`. On stdio the referee closes the bot's stdin;
   a binding without end-of-file sends `{"t":"bye"}`, which gets no reply.

## Transports

- **stdio.** The referee starts the program and writes one JSON object per line (UTF-8, `\n`) to its stdin; the bot
  answers one line per reply on stdout and logs only to stderr. One program plays one seat at a time and may play many
  games in a row, each starting with `hello`. End-of-file on stdin means exit. Every bot the arena plays is such a
  program, run in its WebAssembly sandbox (`bot/compiled/run.py`, started by `bot/stdio.js` `StdioClient`).
- **In process (JavaScript).** An object `{ name, hello?(msg), decide(msg, sim), over?(msg) }`. Each method returns
  the reply or a promise of it; `hello` defaults to `{"t":"ready","v":2}` and `over` to `{"t":"ok"}`. `sim(request)`
  returns a promise of the `simulated` reply: always `await` it. Messages are shared objects, so do not modify them.
  A JavaScript bot program is written this way: `serve(client)` from `./stdio` (BUILD.md) answers the messages on
  stdin with the object's replies. The referee's own `heuristic` and `rush` are such objects run inside the referee,
  where code can reach the engine and is trusted: the referee enforces `ms` when control comes back to it (past it,
  `sim` promises never settle, so a loop of sims cannot hold the referee up), but it cannot stop a synchronous loop.
- **Request-response (HTTP, WebSocket, MCP tool calls).** One call per bot message: the call carries the bot's
  message and returns the referee's next message; the first call carries no message and returns `hello`. `ms` counts
  from when the referee hands its message out. Sessions, authentication and match-making belong to the server that
  offers this binding (the arena), not to this protocol.

## Messages

### `hello` → `ready`

```json
{"t":"hello","protocol":"swu-bot-stdio","v":1,"versions":[1,2],"bot":"rust-mcts","you":"p1","seed":1968796899,
 "players":[{"id":"p1","name":"p1","bot":"rust-mcts"},{"id":"p2","name":"p2","bot":"heuristic"}],
 "deck":{"metadata":{"name":"Darth Vader / Echo Base","author":"bot"},"leader":{"id":"SOR_010","count":1},"base":{"id":"SOR_023","count":1},"deck":[{"id":"SOR_042","count":3}]},
 "opponent":{"metadata":{"name":"...","author":"bot"},"leader":{"id":"SHD_009","count":1},"base":{"id":"SHD_021","count":1},"deck":[...]},
 "ms":30000,
 "cards":[...,
  {"title":"Search Your Feelings","subtitle":null,"cost":4,"hp":null,"power":null,"text":"Search your deck for a card and draw it. (Then, shuffle your deck.)","deployBox":null,"epicAction":null,"unique":false,"rules":"After searching your deck, shuffle it.\n","upgradePower":null,"upgradeHp":null,"id":"7485151088","aspects":["villainy","vigilance"],"traits":["innate"],"keywords":[],"types":["event"],"setId":{"set":"SOR","number":42},"setCodes":[{"set":"SOR","number":42}],"internalName":"search-your-feelings"},
  {"title":"Shield","subtitle":null,"cost":0,"hp":0,"power":0,"text":"If damage would be dealt to attached unit, prevent that damage. If you do, defeat a Shield token on it.","deployBox":null,"epicAction":null,"unique":false,"rules":null,"upgradePower":0,"upgradeHp":0,"id":"8752877738","aspects":[],"traits":["armor"],"keywords":[],"types":["token","upgrade"],"setId":{"set":"SOR"},"internalName":"shield"},
  ...]}
```

| Field | Meaning |
|---|---|
| `protocol`, `v`, `bot` | Always `swu-bot-stdio`, `1`, and the name the bot is registered under. `hello` looks the same in every version so that any bot can read it. |
| `versions` | Versions offered for this game: `[2]` in the hosted arena; `[1, 2]` for local callers that allow legacy clients. |
| `you` | Your seat this game, `p1` or `p2`. |
| `seed` | Integer in `[0, 2^32)` for this game and seat. Seed your own RNG from it to make games reproducible. In a keyed game it tells you nothing about the hidden cards (see Fairness). |
| `players` | Both seats: engine name and bot name. |
| `deck`, `opponent` | Both deck lists (they are open, see Fairness): `{ metadata, leader, base, deck: [{ id, count }] }` with set codes `<SET>_<NNN>`. |
| `cards` | The card data of this game: every card it can show you, as the engine's own card objects (below). |

**Card data (`hello.cards`).** A bot gets its card data here and nowhere else: finding it is the referee's job, and a
bot reads no card files (a sandboxed bot has none). It comes once per game. The array holds the engine's card object
for each card of both lists (leader, a second leader, base, deck and sideboard) and the 13 tokens (Battle Droid, Clone
Trooper, TIE Fighter, X-Wing, Spy, Mandalorian, Beast, Experience, Shield, Advantage, Weakness, The Force, Credit).
Each card appears once, and the array is sorted by `internalName`, so both seats get the same array. Fields are the
engine's: `title`, `subtitle`, `cost`, `power`, `hp`, `upgradePower`, `upgradeHp` (an upgrade's modifiers), `arena`
(`ground` or `space`, where it applies), `aspects`, `traits`, `keywords`, `types`, `unique`, `text`, `rules`,
`deployBox` and `epicAction` (texts), `setId`, `setCodes`, `internalName`, and where a card has them `pilotText` and
the `backSide*` fields of a two-sided card. `id` is the engine's own number for the card, not a card id (`c41`) of
the game. Two real lists give 42-68 cards (`hello` is 24-43 KB), two random decks 106-117 (62-75 KB).

Index it by every name a message can use:

- **`setId`**: the card's own set code, `{ "set": "HMW", "number": 22 }`, or `HMW_022` with the number padded to three
  digits. Board refs in `decide` (`s`) carry it.
- **every entry of `setCodes`**: a deck list may name a card by a reprint code. `JTL_020` in a list is Shield Generator
  Complex, whose `setId` is `HMW_022` (`setCodes` holds both), and the board then shows it as `HMW_022`.
- **`internalName`**: the `label` of `card` and `displayCard` actions and the part after `:` of a `perCardButton`
  label.
- **`title`**: `n` in a card ref. Tokens have no set number: a token's `setId` names its set and has no `number`
  (Shield: `{ "set": "SOR" }`, Battle Droid: `{ "set": "TWI" }`), and it has no `setCodes`. Tokens come with
  `s: null`, so a token is found by its title among the cards whose `types` include `token`. Two other refs have
  `s: null`: a card a prompt shows (`prompt.cards`) that the engine cannot place comes with `n` set to its
  `internalName`, and a hidden card (`id: "hidden"`, see Actions) names no card at all.

The labels of a "name a card" dropdown are titles of cards outside the game too: those cards are not in `hello.cards`.
`hello.cards` is card data, one entry per card of the game, and is not the same thing as the card refs of `decide`
(`{ id, n, s, ... }` in `state`, `actions[].card`, `revealed`, and `prompt.cards`, the cards a prompt shows): a ref
names one physical card of this game by its card id, and its `s`, `n` or the action's label finds its data here.

Reply `{"t":"ready","v":2,"name":"rust-mcts","sim":true}`. `v` is the version you pick from `versions`; omitted means
1 for legacy local callers. The hosted arena requires an explicit `"v":2`; v1, missing `v`, and native `choose()` bots
are refused before the engine starts. Anything not offered is an error. `sim: true` asks for simulations (the referee then keeps a copy of the game to
run them on). `name` is informational. Reset any per-game state here: one program plays many games.

`playGame` enforces this with `requiredProtocol: 2`. Its result's `protocols` maps seats to the numeric version each
successfully negotiated, independently of the optional build strings in `versions`. The replay end records the same
map. A failed hello contributes no entry; an earlier accepted seat is still recorded. `requiredProtocol` records the
policy in the result and replay header/end, including games that fail before any seat is accepted.

`simEngine` (optional, with `sim: true`): `"rust"` asks for simulations on the Rust simulator, which is far faster
(see [Simulations on the Rust engine](#simulations-on-the-rust-engine)). Leave it out for forceteki simulations.

`noEffect` (optional, `true`): in the action window, mark each `card` action whose every move would change nothing
(below). Made for screens that grey such moves (a person's seat asks for it); it costs a fraction of a millisecond per
card action.

`version` (optional, a string of at most 200 characters, for example a git commit or a bundle id `sha256:...`) names
the build of the bot that plays this game. The referee records it with the game result (`versions` by seat). It
matters for a bot that changes between games, such as one an agent updates between rounds on a server it runs
itself: the arena can tie results to the version that earned them and keep one version per round.

### `decide` → `act`

```json
{"t":"decide","seq":12,"you":"p1","sim":true,"ms":10000,
 "prompt":{"type":"actionWindow","signature":"actionWindow|-","title":"Choose an action","promptTitle":null,"selectCardMode":null,"selected":[],"actionWindow":true},
 "state":{"round":2,"phase":"action","initiative":"p1","players":{"p1":{...},"p2":{...}}},
 "actions":[{"i":0,"kind":"button","label":"Pass","arg":"pass"},
            {"i":1,"kind":"card","label":"wampa","cardUuid":"c41","card":{"id":"c41","n":"Wampa","s":"SOR_042","zone":"hand","ctl":"p1"}}],
 "revealed":[]}
```

Reply `{"t":"act","i":1}` with the index of the chosen action. For a `distribute` action you may add the split:
`{"t":"act","i":0,"split":[{"id":"c7","amount":2},{"id":"c9","amount":1}]}`; without one the referee picks a random
legal split.

| Field | Meaning |
|---|---|
| `seq` | Decision number in this game, from 1. |
| `sim` | `true` when `sim` requests are allowed now: you asked for them and this is an action window. |
| `simEngine` | `"rust"` when this decision's simulations run on the Rust simulator; absent when they run on forceteki. |
| `ms` | Your time for the `act`, simulations included. |
| `prompt` | What is being asked, below. |
| `state` | The board as your seat sees it, below. |
| `actions` | The legal actions, never empty, below. |
| `revealed` | Cards revealed to both players since your last decision (`{ id, n, s, zone, ctl }`), for reveals that show no prompt. |

**Prompt.** `type` (the engine prompt type, `null` for target selection), `signature` (the shape string replays
record), `title` and `promptTitle` (texts, may be `null`), `selectCardMode` (`single`, `multiple` or `null`),
`selected` (ids already selected in a multi-select prompt; `hidden` for a card hidden from you), `actionWindow` (`true` at the top-level "choose an
action" prompt), and `cards` when the prompt shows cards: `[{ id, n, s, zone, ctl, st }]` with `st` one of
`selectable`, `selected`, `unselectable`, `invalid`, `viewOnly`. These are the cards a player at the table would see,
such as an opponent's hand shown by a "look at" effect.

**State.** `round`, `phase` (`setup`, `action`, `regroup`), `initiative` (a seat or `null`) and `players.p1`/`p2`:

| Field | Meaning |
|---|---|
| `name` | Engine user name. |
| `base` | `{ id, n, s, hp, d, epic? }`: printed HP and damage; `epic: 1` once its epic action is used. |
| `leader` | `{ id, n, s, dep, x, epic? }` (`dep` 1 = deployed, then also listed as a unit, or a double-sided leader such as Chancellor Palpatine on its flipped side, which is no unit; `x` 1 = exhausted; `epic: 1` once its deploy is used, so a defeated leader shows `dep: 0, epic: 1`), or `null`. |
| `passed`, `out` | Action phase only. `passed: 1`: the player passed its last action, so the phase ends if the other player passes now. `out: 1`: the player is done for this phase (it claimed the initiative, or both passed). Absent otherwise. |
| `res` | `{ ready, total }` resources. |
| `handCount`, `deck` | Cards in hand and left in the deck. |
| `force`, `credits` | `force: 1` when the player has the Force token; `credits`: credit tokens. Absent when zero. |
| `hand`, `resources` | Your own player only: `[{ id, n, s }]`, resources with `x: 1` when exhausted (you can play from them with Smuggle). |
| `discard` | `[{ id, n, s }]`. |
| `ground`, `space` | Units the player controls: `{ id, n, s, p, h, d, x?, sn?, u?, cap? }`: power, max HP, damage, exhausted, Sentinel, upgrades `[{ id, n, s, t }]` (`t` 1 = token) and captured cards `[{ id, n, s }]`. |

`id` is the card id, `c` and a number: stable for the whole game, and the same in replays and simulations. `n` is the
title and `s` the set code or `null` (tokens). The opponent's hand and resources and both decks' order are never
shown.

**Actions.** `i`, `kind` and `label` always; `arg` (a string, or a number for choice-menu buttons) and `cardUuid` when
the action has them; plus:

| `kind` | What it is | Extra |
|---|---|---|
| `button` | A prompt button (Pass, Done, a menu choice). | |
| `card` | Click a card: play it, attack with it, target it, select it. | `card: { id, n, s, zone, ctl }`: `zone` is where the card is (`hand`, `resource`, `groundArena`, `spaceArena`, `base` for a base or a leader not deployed, `discard`, `deck`, `capture`, `outsideTheGame`, or `null`), `ctl` the seat that controls it |
| `option` | A dropdown entry or a number (`label` `#<n>`). A "name a card" dropdown lists about 1,900 entries. | |
| `displayCard` | Pick one of the shown cards (`arg` is its id). | |
| `perCardButton` | A button on one shown card. | |
| `distribute` | Split damage, healing or tokens. | `distribute: { type, amount, canDistributeLess, canChooseNoTargets, maxTargets, tokenType, targets: [{ id, cap }] }` (`cap: null` = no cap) |

A card hidden from you (in a deck, or in the opponent's hand or resources) is never named. When the engine lets you
pick one (a few effects do, by an engine bug), the action is `{ i, kind: "card", label: "hidden card", card: { id:
"hidden", n: "hidden card", s: null, zone, ctl } }`, with no `cardUuid`.

A legal split names only listed targets, each at most once, with integer amounts from 0 to `cap`, at most
`maxTargets` non-zero entries, and a total equal to `amount` (at most `amount` with `canDistributeLess`; 0 only with
`canChooseNoTargets`).

Some legal actions change nothing. Mystic Monastery's action, used while you already have the Force, leaves the board
as it was, and when the opponent is out for the phase you get the same decision again. A bot that ranks such an action
above passing repeats it until the step cap (`STEP_CAP`, nobody wins). Guard against it, for example by never making
the same choice twice for the same `state`, `prompt` and `actions`.

A client that sent `noEffect: true` in `ready` gets `noEffect: true` on such a `card` action in the action window: every
move the engine offers for that card (playing an event, using an ability) would change nothing now, by the engine's own
checks (the ones behind its "(No effect)" menu choices and its "will have no effect, play it anyway?" question). The
action stays legal. A check that fails counts as "has an effect", so a mark is never a guess.

<a id="undo"></a>**Undo (tables only).** A person playing a bot at a table (`bot/table/`, games nobody rates) may take
back moves; the arena never offers it to a bot. Such a seat's `decide` carries `undo: true` when it has a move to
take back, and the reply `{"t":"undo"}` takes back its last move that had more than one action, with every move after
it (the opponent's too). The referee plays the game again from the start through the moves that stand, never by
rolling the engine back, and asks that decision again. A reply `undo` to a decision without `undo: true` is a wrong
answer, as any other.

### `sim` → `simulated`

During a decision whose `sim` is `true`, a bot can play ahead on a private copy of the game.

| Request | Effect | Reply |
|---|---|---|
| `{"t":"sim","op":"begin","deal":3}` | Starts a simulation from the real position, ending any open one first, and deals the hidden cards again (below). `deal` is optional. | a position |
| `{"t":"sim","op":"act","i":3}` (`split` allowed) | Plays action `i` of the last position for whichever seat had to act. | the next position |
| `{"t":"sim","op":"end"}` | Ends the simulation; does nothing when none is open. Never fails. | `{"t":"simulated","op":"end"}` |

A position is `{"t":"simulated","op":"begin","ms":8211,"actor":"p1","prompt":{...},"state":{...},"actions":[...]}`, with
the same shapes as `decide`; `ms` is the time left for this decision (`null` for no limit), in every reply. `actor` is the seat that must act: you play both seats, so you choose the opponent's moves
too (when both seats have a prompt, yours comes first). When the simulated game ends the reply is
`{"t":"simulated","op":"act","over":{"winner":"p1"}}`. `state` is always from your seat.

Every reply echoes `op` (`null` for an unknown one). `end` never fails. Any other request can: sims off for this
decision, no open simulation, a bad index, deal or split, the simulated game already over, an engine error, or an
unknown `op`. The reply is then `{"t":"simulated","op":"act","ms":812,"error":"why"}` and no simulation is open any
more; the game goes on. Past the decision's `ms` a request gets no reply at all: the game is already lost. Your final
`act` refers to the real `decide` and ends an open simulation first.

**What a simulation hides.** At `begin` the cards you cannot see now are dealt again at random: your deck order, and
the opponent's hand, face-down resources and deck, from one shuffle of all three. Zone sizes and the number of
exhausted resources stay. Cards you saw earlier (a hand shown by a "look at" effect) are dealt again too: the referee
does not track what you saw, so keep it yourself. The randomness comes from a stream private to your seat and cannot
be predicted from anything you are sent. Within one decision, the same `deal` number gives the same cards and the same
random outcomes for the same moves, so a search can compare actions on one deal; a `begin` without `deal` gets a deal
not used before.

Simulations run on a second engine that follows the real game's moves, so they never touch the real game: a game plays
out exactly the same with or without them.

#### Simulations on the Rust engine

A bot that sends `"simEngine": "rust"` in `ready` gets its simulations from the Rust simulator (Kessel, run as
WebAssembly from `vendor/kessel` by `bot/sims/rust-sims.js`) for every decision where it knows every card in the game,
and forceteki simulations otherwise; `decide` says which with `simEngine`. The real game always runs on forceteki. The
Rust simulator knows a subset of the cards (the pool in `bot/sims/pool.json`, or `$SWU_RUST_POOL`) and is checked move
for move against forceteki (holocron's `bots/omni/rs/stress.js`), but it is a second implementation: treat a
disagreement as possible.

Requests, replies, deals and errors are the same, with these differences:

- The hidden cards are dealt again the same way (same zone sizes, same seat-private stream per `deal`), by a shuffle
  of their own, so a deal number gives other cards than it would on forceteki.
- `prompt` carries `actionWindow` and a `signature`: `actionWindow|-` at an action window as on forceteki, else
  `rust|` and the kinds of the legal actions (such as `rust|card|button`). `type`, `title`, `promptTitle` and
  `selectCardMode` are `null` and `selected` is empty.
- `state` has no `force` or `credits` (no card in the Rust pool uses them).
- A `distribute` choice is one action per allowed split, each with its `split` (`[{"id","amount"}]`) and no
  `distribute` field; a `split` you send with `act` is ignored.

### `over` → `ok`

```json
{"t":"over","you":"p1","winner":"p2","outcome":"won","round":14,"steps":412,"error":null,"by":null,"ms":10000}
```

`winner` is `p1`, `p2`, `draw` or `null`; `outcome` is `won`, `STEP_CAP`, `STUCK` or `ERROR`; for `ERROR`, `error`
says why and `by` names the seat that caused it, which loses (`winner` is the other seat); `by: null` means the engine
or the referee failed, and nobody wins. Sent after every game a v2 bot
joined, failed ones included, except to a bot that caused the failure. Reply `{"t":"ok"}` once any learning you want
to finish before the next game is done. A failure here changes no result; the program is restarted for its next game.

## Fairness

- **Deck lists are open.** Both lists are in `hello`. Engine card ids follow deck-list order, and simulations deal
  from the opponent's real unseen cards, so a closed list could not be kept secret anyway.
- **A key hides the hidden cards.** The referee derives every random stream (decks, engine shuffles, `hello.seed`,
  simulations) from the game seed and a secret key (`playGame({ key })`). `bot/tournament.js` draws a key per run and
  writes each game's own key (derived from the run key) to its index entry and replay when the game ends, so every
  game can be played again. `bot/ladder.js` plays each seed from both seats with the same key, so it writes the key
  once both games (in a gauntlet, every game on that seed) have ended. Without a key the streams follow from the seed alone: that suits development and
  `npm run gate`, but a bot can find a small seed from `hello.seed` or the deck lists and rebuild the hidden cards.
  Use a key whenever a bot is not trusted.
- **Programs in other languages need a sandbox to be held to these rules.** A program on the referee's machine, as the
  same user, could read the live replay files (they show both hands while a game runs), the viewer's port, or the
  referee's command line and environment (where a `--key` would be). Run untrusted programs as another user, without
  access to `replays/` and the viewer. In-process clients and native bots are trusted.

## Running bot programs

There is one way to run a bot program: the dev harness, `npm run dev -- <bot folder> --owner <your GitHub login>`. It
packs the folder as `arena_submit` sends it, checks it with the arena's checker, and plays it in the arena's sandbox
against `heuristic` and `rush` (or `--vs` other bot folders), on the rated rounds' deck lists and time rules, with
replays, transcripts and a report. The bot only talks this protocol on stdin and stdout; the harness does the rest and
sends nothing anywhere. `bot/arena/BUILD.md` ("Test locally") and the header of `bot/dev.js` describe it.

In a rated game each bot has a thinking budget for the whole game (60 s by default) in place of the defaults in
rule 2: every message's `ms` is the part of that budget the bot has left.

## Versions

A bot whose `ready` has no `v`, or `v: 1`, plays protocol v1 ([stdio-protocol.md](stdio-protocol.md)): it gets no
`over` and no simulations, and its split may be called `distribution`. It also receives the v2 fields in `hello` and
`decide`, which it ignores. To move a v1 bot to v2: answer `ready` with `"v":2`, answer `over` with `ok`, and rename
`distribution` to `split`. What else changed for bot authors is in [MIGRATION.md](MIGRATION.md).
