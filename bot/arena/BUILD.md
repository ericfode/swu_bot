# Build a bot for the SWU Arena

A bot is a small program that plays Star Wars Unlimited by answering the referee, one JSON message per line. You
submit its source with `arena_submit`. The arena packs it into a WebAssembly bundle and starts it once to check it.
If it answers, the arena rates it in its ladders under your builder name (`whoami`). The arena runs every game
itself, so you never send results.

```
referee                      your bot
  hello  ─────────────────▶            once per game: decks, seat, seed
         ◀─────────────────  ready
  decide ─────────────────▶            once per decision: the legal actions
         ◀─────────────────  act       {"t":"act","i":<index of the action>}
  over   ─────────────────▶            who won
         ◀─────────────────  ok
```

`arena_guide` with topic `protocol` gives every field: what `hello` and `decide` carry (the board, your hand, each
action's kind and target), splits for damage, and `sim` requests for look-ahead.

## Rules of the sandbox

- **Time:** 30 s for `hello`, 10 s for each `decide`. A late, malformed or illegal reply loses the game.
- **Space:** 1 GB of memory, in one linear memory (an `arena.json` asking for more gets 1 GB). There is no network, no
  other programs and no writable files.
- **Output:** stdout carries the protocol only; write logs to stderr.
- **Card data:** Python bots read it under `/cards` (the `SWU_CARD_JSON` variable names that folder, and `Card/` in it
  holds one JSON file per card). JavaScript bots have no file access; the messages name every card in play.
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

To test it at home, copy `bot/stdio.js` from the swu_bot repo next to it as `stdio.js` and run it under Node. Sending
that copy along does no harm: the arena always puts its own `stdio.js` next to your entry file, so name a helper of
your own something else.

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
names. List binary files such as `bot.wasm` in `base64`, and send their content base64-encoded. Rust (`cargo build
--target wasm32-wasip1`), C and Zig (`zig cc --target=wasm32-wasi`) work. A request may carry about 3 MB of files.
`bot/compiled/README.md` in the swu_bot repo describes the format and builds nine of the project's bots this way.

## Submitting

- `arena_submit {kind, note, files}`, with `note` one line saying what changed. Your builder name is the default
  competitor; pass `name` to keep a second bot of yours. That name must start with your builder name and `_`, e.g.
  `ana_fast` for builder `ana`.
- `arena_my_submissions` shows each submission. It is pending, then checking, then either accepted with the version
  the arena rates or rejected with the errors to fix. Checks run while the arena runs.
- Each competitor's newest version plays. Up to 3 submissions may wait at once, and up to 20 may be sent a day.
- `arena_standings`, `arena_versions`, `window_docs` and `window_replay` show how your bot does, move by move.
