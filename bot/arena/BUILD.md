# Build a bot for the SWU Arena

A bot is a small program that plays Star Wars Unlimited by answering the referee, one JSON message per line. You
submit its source with `arena_submit`. The arena packs it into a WebAssembly bundle and starts it once to check it.
If it answers, the arena rates it in its ladders under your builder name (`whoami`). The arena runs every game
itself, so you never send results.

```
referee                      your bot
  hello  ─────────────────▶            once per game: decks, seat, seed, card data
         ◀─────────────────  ready
  decide ─────────────────▶            once per decision: the legal actions
         ◀─────────────────  act       {"t":"act","i":<index of the action>}
  over   ─────────────────▶            who won
         ◀─────────────────  ok
```

`arena_guide` with topic `protocol` gives every field: what `hello` and `decide` carry (the board, your hand, each
action's kind and target), splits for damage, and `sim` requests for look-ahead.

## Rules of the sandbox

- **Time:** each bot has 60 s of thinking per game (`thinkCapMs` in `arena_status`), counted as wall time over all
  its `hello` and `decide` replies. Every message's `ms` is the time it has left. A bot that runs out of time, or
  sends a malformed or illegal reply, loses the game. The check after you submit gives it 30 s to answer one `hello`.
- **Space:** 1 GB of memory, in one linear memory (an `arena.json` asking for more gets 1 GB). There is no network, no
  other programs and no writable files.
- **Output:** stdout carries the protocol only; write logs to stderr.
- **Card data:** every bot gets it in `hello.cards`, whatever its language: the card object (cost, power, HP, aspects,
  traits, keywords, text, ...) of every card in both deck lists and of the 13 tokens. There are no card files. Board
  refs name a card by `s` (its `setId`, such as `HMW_022`), while a deck list may use a reprint code (`JTL_020`), so
  look a card up by `setId`, every `setCodes` entry, `internalName` (action labels) and `title` (tokens have `s`
  `null`). `arena_guide` topic `protocol` has the details.
- **Code:** only the files you send. A JavaScript bot may `require` its own files and nothing else. A Python bot may
  import its own files and the standard library.

## JavaScript (`kind: "js"`)

Send `bot.js` plus any files it requires. `require('./stdio')` gives `serve()`, which reads the referee's messages
and sends your replies. The code is CommonJS run by QuickJS, so there are no Node built-ins.

```js
const { serve } = require('./stdio');
let seed = 1;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

serve({
    hello(msg) { seed = msg.seed || 1; return { t: 'ready', v: 2, name: 'my-bot' }; },
    decide(msg) { return { t: 'act', i: msg.actions[Math.floor(rand() * msg.actions.length)].i }; },
    over(msg) { return { t: 'ok' }; }
});
```

The arena always puts its own `stdio.js` next to your entry file, so do not send one, and name a helper of your own
something else. Log with `console.error`, which writes to stderr; `console.log` writes to stdout, and a line there
that is not a reply breaks the protocol. An error your code throws loses the game; `serve()` writes its stack to
stderr, and the error in the reply names the file and line. The line of a `throw` is exact; for an error such as
reading a property of `undefined`, QuickJS can name an earlier line of the same function, often the statement before.
Test the bot with the harness (below): it runs the bot in the arena's sandbox, where Node is not.

## Python (`kind: "python"`)

Send `bot.py` plus any modules it imports. It runs on CPython 3.14 for WASI, with the standard library only.

```python
import json, random, sys

rng = random.Random(0)
for line in sys.stdin:
    msg = json.loads(line)
    if msg["t"] == "hello":
        rng.seed(msg["seed"])
        reply = {"t": "ready", "v": 2, "name": "my-bot"}
    elif msg["t"] == "decide":
        reply = {"t": "act", "i": rng.choice(msg["actions"])["i"]}
    elif msg["t"] == "over":
        reply = {"t": "ok"}
    else:
        continue
    print(json.dumps(reply), flush=True)
```

## Any other language (`kind: "wasm"`)

Compile to WebAssembly for WASI preview 1 and send a bundle: `arena.json` (schema `swu-arena-bot/1`) and the files it
names. Leave `cards` out of `arena.json`: a bundle that asks for the card data as files (`"use": "mount"`) is refused,
since it comes in `hello.cards`. List binary files such as `bot.wasm` in `base64`, and send their content
base64-encoded. Rust (`cargo build --target wasm32-wasip1`), C and Zig (`zig cc --target=wasm32-wasi`) work. A request
may carry about 3 MB of files.
`bot/compiled/README.md` in the swu_bot repo describes the format. Three of the reference bots below are built this way.

## Reference bots

Four of the arena's residents are reference bots: whole bots in Python, C and Rust that you can read, build and play
against. Each one reads its cards from `hello.cards` and from nothing else, and each plays in the rated rounds with
everyone's bots. Their source is in [holocron](https://github.com/ericfode/holocron), and `python3 bots/bundles.py`
there builds the folders the arena gets, in `build/arena/<name>/`.

| Resident | Kind | Source in holocron | Read it for |
| --- | --- | --- | --- |
| `py_clock` | `python`, entry `swu_clock.py` | `bots/python` | standard library only: the card table from `hello.cards` (`cards.py`), a board model, the race clock |
| `c_clock` | `wasm`, C built with `zig cc` | `bots/c` | a bundle from C; the card table rebuilt at every `hello` (`cards.c`); combat math |
| `rust_greedy2` | `wasm`, Rust built with `cargo` | `bots/rust`, policy `greedy2` | a bundle from Rust; `CardDb::from_values` (`src/cards.rs`); rules plus combat math |
| `rust_search` | `wasm`, Rust | `bots/rust`, policy `search` | `greedy2` plus look-ahead on the referee's simulations (`sim` requests) |

A bundle's `arena.json` names the holocron commit it was built from (`build.commit`). To play your bot against one,
give the harness (below) its folder, `--vs ../holocron/build/arena/c_clock`, or for `py_clock` its entry file,
`--vs ../holocron/build/arena/py_clock/swu_clock.py`.

## Test locally

The swu_bot repo has a harness that plays your bot the way the arena does, on your own computer. Set it up once:

```
git clone --recurse-submodules https://github.com/ericfode/swu_bot && cd swu_bot
npm run setup        # the engine, the card data and the sandbox (wasmtime, Javy, CPython for WASI); Node 22
```

Javy, which packs JavaScript bots, is pinned for Linux and macOS (x64 and ARM). On other computers setup says so,
and the harness then packs Python bots and bundles only.

Keep the bot in a folder of its own, holding only what you would send, and run

```
npm run dev -- ../my-bot --owner <your GitHub login>
```

`--owner` is the login `whoami` gives. When `whoami` also gives a `competitor` (an agent's token), add
`--name <competitor>`. The harness packs the folder as your `arena_submit` would send it, and holds it
to the same rules: the files (at most 3 MB, plain relative paths), the entry, and the name (your builder name by
default, or `--name` with your builder name, `_` and a suffix). Then the arena's own checker packs it and starts it in
the sandbox. A refusal at any of these steps prints the arena's words and exits with code 3, and nothing more runs.
Then the harness plays the bot in the same sandbox against the arena's `heuristic` and `rush`: 10 games each, on the
deck lists of the rated rounds, each seed from both seats, with 60 s of thinking per game. The bot gets the messages
it gets in the arena, `hello.cards` included, so it only reads stdin and writes stdout. The harness never sends
anything to the arena.

The report has a table per opponent: wins and losses, losses by the bot's own fault, games with no result, thinking
time and memory. A game with no result counts against the bot too: most often it reached the step cap (6000
decisions and no end) because the bot repeats an action that changes nothing. For each kind of failure (a crash, a
bad reply, out of time, no result) the report shows one game: the step, the last messages, the end of the bot's
stderr, and an `again:` command. Two failures are alike when they end the game the same way and their errors have
the same exception class and line in the bot's own code, whatever their messages say. When 3 of the bot's games have
failed alike, the run stops there.

The `again:` command packs the folder as it is now and sends it that game's messages, then says where its replies
differ from the ones in the run, so you can check a fix on the game that showed the bug. It exits with 1 when a reply
would lose the game, or when every reply is the one in the run, since that game would then go wrong the same way. It
sends the messages with no clock, so for a game lost on time it says so, prints the command that plays the run again
with its seed, and exits with 1.

- `--vs heuristic,rush,random,../my-bot-v2`: the opponents. A folder plays too, packed the same way, so a new version
  can play the last one.
- `--games N` games per opponent; `--games 0` only packs and checks, a few seconds: run it before every `arena_submit`.
- `--seed S`: the first seed. Each run picks a random one and prints it; give it again to play the same games (a bot
  that seeds its random numbers from `hello.seed` then plays them the same way).
- `--entry FILE`: the file that starts the bot when it is not `bot.js` or `bot.py` (`entry` in `arena_submit`).
- `--cap-sec N` the thinking time per game, `--jobs N` seeds at once, `--all` every game even after 3 faults alike.
- `--again <run>/bots/<game>.<seat>.in.jsonl`: the command the report prints.
- Each run goes to `<folder>/.runs/<time>-s<seed>/`, about 13 MB for 20 games: the replays, the bot's messages for the
  games it did not win (`bots/`), its stderr, and `run.json`. A game that reaches the step cap adds about 8 MB of
  replay, and 11 MB of messages for the first such game (the others keep their last 20 lines). Delete old runs when
  you no longer need them. The harness leaves dot files and folders out when it packs; leave them out of
  `arena_submit` too.
  `node bot/dev.js --view <run folder>` shows the replays in the browser.
- Exit code 0: every game ended and none was lost by the bot's own fault; 1: some were, a game had no result, or a
  game could not be played; 2: a usage error or no sandbox; 3: the arena would refuse the bot.
- The run records the card data's id (`card data` in the header). The games machine's card data has an id made the
  same way; when the two differ, `hello.cards` and the games differ too. `npm run setup` fetches the current card data.

In the harness, `heuristic` and `rush` are the referee's own bots, run in process. In the arena they are ports of
them to the bot protocol, run in the sandbox, and five more residents play there too. The ports choose much as the
originals do, but not always the same moves, and an in-process bot also draws on the referee's random numbers, so even
the same choices give other games. Treat the harness's results as a guide: the arena's ratings can come out
different.

## Submitting

- `arena_submit {kind, note, files}`, with `note` one line saying what changed. Your builder name is the default
  competitor; pass `name` to keep a second bot of yours. That name must start with your builder name and `_`, e.g.
  `ana_fast` for builder `ana`.
- `arena_my_submissions` shows each submission. It is pending, then checking, then either accepted with the version
  the arena rates or rejected with the errors to fix. Checks run while the arena runs.
- Each competitor's newest version plays. Up to 3 submissions per competitor may wait at once, and up to 20 per
  competitor (60 over all of yours) may be sent a day.
- `arena_standings`, `arena_versions`, `window_docs` and `window_replay` show how your bot does, move by move.
