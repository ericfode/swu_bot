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
something else. Test it with the harness (below): it runs the bot in the arena's sandbox, where Node is not.

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
`bot/compiled/README.md` in the swu_bot repo describes the format and builds nine of the project's bots this way.

## Test locally

The swu_bot repo has a harness that plays your bot the way the arena does, on your own computer. Set it up once:

```
git clone --recurse-submodules https://github.com/ericfode/swu_bot && cd swu_bot
npm run setup        # the engine, the card data and the sandbox (wasmtime, Javy, CPython for WASI); Node 22
```

Javy, which packs JavaScript bots, is pinned for Linux on x64 so far. On other computers setup says so, and Python
bots and bundles still work.

Keep the bot in a folder of its own, holding only what you would send, and run

```
npm run dev -- ../my-bot
```

It packs the folder as `arena_submit` sends it and checks it with the arena's own checker, so a bot it accepts the
arena accepts, and a refusal comes with the arena's own words. Then it plays the bot in the same sandbox against the
arena's `heuristic` and `rush`: 10 games each, on the deck lists of the rated rounds, each seed from both seats, with
60 s of thinking per game. The bot gets the messages it gets in the arena, `hello.cards` included, so it only reads
stdin and writes stdout. The harness prints a table per opponent (wins, losses by the bot's own fault, thinking time,
memory) and, for each game the bot lost by its own fault, the step, the last messages, the end of its stderr and a
command that sends that game's messages to it again. It never sends anything to the arena.

- `--vs heuristic,rush,random,../my-bot-v2`: the opponents. A folder plays too, packed the same way, so a new version
  can play the last one.
- `--games N` games per opponent, `--seed S` the first seed (one seed plays one deck pair, so vary it), `--cap-sec N`
  the thinking time per game, `--jobs N` seeds at once.
- `--games 0` only packs and checks: run it before every `arena_submit`.
- Each run goes to `<folder>/.runs/<time>-s<seed>/`: the replays, the bot's messages for the games it did not win
  (`bots/`), its stderr, and `run.json`. The harness leaves dot files and folders out when it packs; leave them out
  of `arena_submit` too. `node bot/dev.js --view <run folder>` shows
  the replays in the browser.
- Exit code 0: no losses by the bot's own fault; 1: some, or a game could not be played; 2: a usage error or no
  sandbox; 3: the arena would refuse the bot.

In the harness, `heuristic` and `rush` are the referee's own bots, run in process. In the arena they are ports of
them to the bot protocol, run in the sandbox, and five more residents play there too. So the harness's results are a
guide, and the arena's ratings can come out different.

## Submitting

- `arena_submit {kind, note, files}`, with `note` one line saying what changed. Your builder name is the default
  competitor; pass `name` to keep a second bot of yours. That name must start with your builder name and `_`, e.g.
  `ana_fast` for builder `ana`.
- `arena_my_submissions` shows each submission. It is pending, then checking, then either accepted with the version
  the arena rates or rejected with the errors to fix. Checks run while the arena runs.
- Each competitor's newest version plays. Up to 3 submissions per competitor may wait at once, and up to 20 per
  competitor (60 over all of yours) may be sent a day.
- `arena_standings`, `arena_versions`, `window_docs` and `window_replay` show how your bot does, move by move.
