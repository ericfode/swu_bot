# Executors: who plays an arena seed, and how

An executor plays seeds of a rated round for the games machine and sends the results back. There are three kinds,
and all three speak the same lease API, plain HTTP and JSON:

| Executor | Where it runs | How it reaches the lease API |
|---|---|---|
| the games machine itself | Fly app `swu-arena-games` | in process (it owns the round) |
| a helper | a trusted computer, in Docker (`bot/arena/HELPER.md`) | `fly proxy` to the machine's port 8090, with its own token |
| a browser tab (the swarm) | a signed-in person's browser, at `/swarm` on the window (`bot/swarm/README.md`) | the window's `/api/swarm/*`, which relays to port 8090 with the swarm's token |

The machine stays the owner of the round. It hands out one **seed** at a time: both games of the same deal, one from
each seat. Whatever an executor does, a seed ends with a result, a failure, or the machine taking it back and playing
it itself.

## The job

A lease carries a job, version 1:

```json
{
  "v": 1,
  "seed": 3250146062,
  "key": "64 hex digits: the seed's game key (deals and hidden cards), never the round's run key",
  "maxSteps": 3000,
  "capMs": 60000,
  "hangMs": 120000,
  "gameMs": 1800000,
  "games": [
    { "id": "rust-greedy2-wasm-vs-node-search-wasm-3250146062", "p1": "rust-greedy2-wasm", "p2": "node-search-wasm" },
    { "id": "node-search-wasm-vs-rust-greedy2-wasm-3250146062", "p1": "node-search-wasm", "p2": "rust-greedy2-wasm" }
  ],
  "bots": {
    "rust-greedy2-wasm": { "kind": "resident" },
    "ericfode_opus-v7": { "kind": "wasm", "bundle": "64 hex digits: the bundle's id, the sha256 of its canonical tar" }
  }
}
```

- `capMs` is each bot's thinking time for a whole game, `hangMs` how long one call may take, `gameMs` the whole game.
  They are the round's own limits (the window's arena settings), never constants in an executor.
- A bot is `resident` (heuristic, rush, and the WebAssembly bots built into the games image) or `wasm` (a submitted
  version, whose bundle the executor fetches by id and must check against that id before it runs it).

## The result

```json
{
  "results": [{ "id": "<game id>", "result": { "outcome": "won", "winner": "<bot>", "winnerSeat": "p1", "by": null, "faultKind": null, "round": 7, "steps": 220, "ms": 31183, "think": { "p1": 1200.5, "p2": 980.25 } } }],
  "replays": { "<game id>": "<the replay, JSON Lines: header, steps, end (spec/replay-format.md)>" }
}
```

or `{"failed": "<why>"}`, and the machine plays the seed itself. The machine checks every result before it records
it (`bot/remote-lane.js` `checkDone`): one result per game, outcomes, winners and seats that agree, a replay whose
header names this game and whose end line says what the result says. Anything off, and it plays the seed itself.

An executor sends `failed` rather than a result when the result would say more about the executor than about the bots:
a bot that ran out of time or hung while the tab was hidden, or after the computer slept.

## The lease API

Every request carries the executor's credential: a helper token (`authorization: Bearer`) on port 8090, or a signed-in
session cookie on the window. The window adds the swarm's token itself and remembers which person holds which lease.
The machine's `swarm` routes are the ones that need no `x-helper-build` header and are still served while it stops.

| Machine (port 8090) | Window (the swarm) | |
|---|---|---|
| `POST /v1/hello` `{build, cards, slots}` | `POST /api/swarm/hello` | 200 `{ok, name, heartbeatMs, leaseLostMs, claimMs}`, or 409 when the executor's build or card data are not the machine's |
| `POST /v1/claim` `{slot}` | `POST /api/swarm/claim` | waits up to `claimMs`: 200 `{lease, job, bundles, deadlineMs}` or 204; `bundles` is `[{id, bytes}]`, one per version in the job |
| `GET /v1/bundle/<sha256>` | `GET /api/swarm/bundle/<sha256>` | a bundle of a seed this executor holds (canonical tar) |
| `POST /v1/lease/<id>/heartbeat` | `POST /api/swarm/lease/<id>/heartbeat` | at once, then every `heartbeatMs`: 200 `{continue: true}`, or 410 when the seed was taken back |
| `POST /v1/lease/<id>/result` | `POST /api/swarm/lease/<id>/result` | the result or `{failed}`; 410 when taken back |
| `GET /v1/swarm/<file>` | `GET /swarm/<file>` | the browser executor's files, built with the machine's own image: `manifest.json`, `engine.json`, `python-lib.json`, `python.wasm`, `referee-worker.js`, `bot-worker.js`, `executor-worker.js`, `play-worker.js`, `tables-worker.js` (the /tables page's worker), and the JEPA bot's models `tx-t10.safetensors` and `tx-t10-e.safetensors` (for the play and tables pages) |
| `GET /v1/swarm/lineup.json` | `bots` of `GET /api/play/bots` and of `GET /api/tables/info` | the latest round's versions whose bundle is on the machine, in roster order, and the round's time per bot per game: `{round, capMs, bots: [{bundle, bytes, name}]}`, or `{round: null, capMs: null, bots: []}` before the first round |
| `GET /v1/swarm/bot/<sha256>` | `GET /play/bundle/<sha256>`, `GET /tables/bot/<sha256>.tar` | the canonical tar of a version in that lineup, for a person playing it in their tab (the window's /play and /tables pages); 404 for any other |
| | `GET /api/swarm/info` | `{on, build, cards}`: whether the swarm is on, and the build the tab must load |

`build` is the commit the machine's image was built from and `cards` a hash of its card data; an executor that runs
anything else is refused with 409 and the image (helper) or files (tab) to load. A seed with no heartbeat for
`leaseLostMs` (90 s) goes back to the machine, so a closed tab or a sleeping laptop costs only that wait.

The swarm's slot ids are `<login>-<n>` (at most 32 characters), so the window and the machine's log can tell people
apart; the round report counts all browser games under the helper name `swarm`.
