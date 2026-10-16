# The swarm: browser tabs that play arena games

Anyone signed in to the window with GitHub and invited can open `/swarm` and press **Join**. While the tab is open it
plays seeds of the running round for the games machine, the way a helper does (`bot/arena/HELPER.md`), and the round
report counts its games under the helper name `swarm`. The lease API it speaks is in `spec/executor.md`.

```
browser tab (/swarm on the window)                        window (swu-arena)            games machine (private)
┌───────────────────────────────────────────────┐        ┌─────────────────────┐       ┌─────────────────────┐
│ page ─ executor worker: hello, claims,         │ HTTPS  │ /api/swarm/*        │ 6PN   │ helper API :8090    │
│        heartbeats, results (executor.js)        │──────▶│ swarm-relay.js:     │──────▶│ leases, bundles,    │
│   └─ referee workers, one game each:            │        │ signed-in people,   │       │ GET /v1/swarm/<file>│
│        engine from engine.json (runtime.js)     │◀──────│ the swarm's token,  │◀──────│ (built with its     │
│        └─ bot workers: a bundle under WASI      │ files  │ who holds which seed│       │  own image)         │
└───────────────────────────────────────────────┘        └─────────────────────┘       └─────────────────────┘
```

## What runs in the tab

- **The engine, unchanged.** `runtime.js` is a small CommonJS runtime with the Node built-ins the engine and bot code
  use: an in-memory `fs`, POSIX `path`, SHA-256 and HMAC for the deal keys, `v8` snapshots as `structuredClone` (both
  deep-copy plain data), timers with `unref()`. `pack.js` packs what it needs from the games image as `engine.json`: the
  engine's build, the card data, the bot code and npm packages a traced game loads, the resident bundles. `engine.js`
  sets it up (a silent logger instead of winston, `crypto.randomUUID` for uuid).
- **One game per referee worker** (`referee-host.js`, `referee.js`), as `ladder-worker.js` plays them: both bots guarded
  with the lease's cap, `match.js` plays, the replay is kept line by line. Before a seed, `play-seed.js`'s own
  `checkJob` and `checkResolved` check the job, and each version's canonical tar is checked against the job's bundle id
  before it is unpacked (`tar.js`).
- **Each bot in its own worker under WASI** (`wasi.js`, `bot-worker.js`, `processes.js`): the referee's
  `python3 bot/compiled/run.py <bundle>` becomes a worker that runs the bundle as `run.py` does under wasmtime (argv, env,
  read-only `/bot`, Python's library for Python bundles; no card files: the card data comes in `hello.cards`). The bot
  blocks on its stdin, a SharedArrayBuffer pipe, which is why the page is cross-origin isolated (COOP and COEP). A bot
  gets no network, no files of the person's, no cookies: it can only call what the host gives it.
- **The executor** (`executor.js`), a worker so hidden tabs do not throttle its timers: hello, one claim per slot,
  heartbeats, results. A seed ends as `{failed}`, and the machine plays it itself, when a bot ran out of time or hung,
  the computer slept, or the game ran past the lease's `gameMs`.

The window's play page (`/play`, `bot/arena/play.js`) loads the same `engine.json` with a worker of its own,
`play-worker.js` (`play-host.js`): the referee and a table (`bot/table/host.js`) in one worker, a person at the other
seat. The opponent is the JEPA bot, which runs in that worker, or a WebAssembly version of the arena's latest round,
which runs in a bot worker as it does here (`processes.js`, `bot-worker.js`). Its stdin pipe is a SharedArrayBuffer, so
the page is cross-origin isolated with `require-corp`, as the swarm's page is (Safari has no `credentialless`), and shows
the card art through the window (`bot/arena/art.js`). The JEPA bot's two models are
files of their own next to `engine.json` (`pack.js` MODELS), downloaded only by a person who picks that bot, and
`build.js` adds every file's size to `manifest.json` for the page's progress bar. The page plays no arena games.

The open tables (`/tables`, `bot/arena/tables.js`) load it with `tables-worker.js`: the referee, the JEPA bot, the
WASI host and the bot workers' spawn, so a person plays an arena bundle (compiled or Python) in their own tab, unpacked
under `ARENA_HOME` as the referee worker unpacks a lease's bundles; or two people play, this tab hosting the game for
both (`bot/table/open.js`). The JEPA bot's models come with the first game against it, as on the play page. That
page is cross-origin isolated like the swarm page.

Not the same as a helper: no memory cap per bot (a browser cannot cap a memory the module defines itself), and thinking
time is the tab's wall clock, so a slow or busy computer gives clock bots less search (the report's ms/decision shows
it, as it does for helpers). Nobody checks a swarm result twice: the swarm is for people Eric trusts (spec/executor.md).

## Checks

- `node --test bot/test/swarm.test.js`: hashes, paths, modules, the stdin pipe, the WASI host's folders, bundle tars, and
  the window's relay (who may, slot names, only your own seeds).
- `node --test bot/test/swarm-engine.test.js`: a game under the runtime is the same game as in Node, and so is a game
  the play worker plays (needs the engine); an arena version (the `node-random` bundle of `bot/compiled/build.py`)
  plays a whole game against a person in `play-host.js`.
- On one computer, with the games image (`docker run ... swu-helper:<sha>`), end to end:

```bash
node bot/swarm/pack.js --root /app --out DIR && node bot/swarm/build.js --out DIR    # inside the games image
node bot/swarm/dev-server.js --files DIR --seeds 12 --bundle some.tar:<sha256>       # then open /swarm
```

`dev-server.js` puts the window's real relay and page in front of a stand-in machine that hands out seeds and checks
each result with the ladder's own `checkDone`. Measured that way on an Apple M5 Max: a rust-greedy2-wasm vs heuristic game
in a tab gives the same replay, byte for byte, as the games image with wasmtime; seeds with Rust, C, JavaScript (Javy)
and Python (CPython for WASI) bundles and a version unpacked from its tar all pass `checkDone`; the engine loads in a
worker in under a second.

## Turning it on

The games image builds the files (`Dockerfile.games`) and serves them on `GET /v1/swarm/<file>`. The window relays only
when it has `SWARM_HELPER_TOKEN`, a helper token whose sha256 is listed in the machine's `GAMES_HELPER_TOKENS` under the
name `swarm`. Without it `/swarm` says the swarm is off.
