# Games helpers: your computer plays some of the arena's games

The games machine (Fly app `swu-arena-games`, [WINDOW.md](WINDOW.md)) plays every rated round. A helper is a computer
of yours that takes some of those games while a round runs, plays them, and sends the results back. It runs the
machine's own image in Docker, in a helper role of the Elixir coordinator ([coord/README.md](../../coord/README.md)).

```
your computer                                       the games machine (private address only)
┌────────────────────────────────┐                  ┌──────────────────────────────────────────────┐
│ Docker: the games image        │  fly proxy       │ coordinator ──ARENA_REMOTE──▶ referee ─▶ ladder│
│  coord (helper role)           │──18090 ─▶ 8090──▶│ helper API :8090    relay 127.0.0.1:8082 ◀────┘│
│   └─ play-seed.js ─▶ 2 games   │  (your Fly login)│  leases, bundles     (offers, results)        │
└────────────────────────────────┘                  └──────────────────────────────────────────────┘
```

- The ladder on the machine stays the owner of the round. While a helper waits for work, the ladder offers it one
  seed: both games of that seed (the same deal, one from each seat), so seat luck still cancels out. It hands out the
  seed whose bots have the fewest helper games so far.
- The helper plays the seed under the same rules (time cap, watchdog, step cap), sends both results and replays back,
  and the ladder checks them (ids, outcomes, the game key, the replays' first and last lines) before it records them
  as it records its own games. Anything off, and the ladder plays the seed itself.
- A helper that stops answering for 90 s loses its seed, and the machine plays it. A seed a helper holds too long
  (twice the machine's median game time, once nothing else is left) is taken back the same way.
- Every game records where it ran: `host` in the round's index (null on the machine), and the round's results say
  how many games each computer played and its milliseconds per decision (2A: helper games count; a faster computer
  gives clock bots more search, which this report makes visible).

## What it can and cannot reach

- No Erlang cluster. The helper only asks for work and sends results over HTTP. Nodes in a cluster can run any code
  on each other, and the games machine runs strangers' bots next to the window token.
- `fly proxy` runs on your computer under your own Fly login, outside the container. It dials the machine's private
  address (`swu-arena-games.internal`), which only exists while the machine runs, so a helper never wakes or keeps up
  the machine. Port 8090 is not a public service; it is reachable only inside the Fly organization, and only with a
  helper token.
- Fly holds only the token's sha256 (`GAMES_HELPER_TOKENS`, `name:hash`). The token stays on your computer in
  `~/.config/swu-helper/env` and goes into the container as an env file. The helper keeps it inside the coordinator;
  the processes that play games never get it.
- The helper plays only WebAssembly bots (submitted bundles and the residents built into the image) and the
  in-process heuristic and rush. Bot code runs as the image's `arena` user with no capabilities; the container gets
  no folder of yours, only a Docker volume.
- A helper could send made-up results for the seeds it holds, so tokens go only to your own computers. To revoke all
  helpers: `sh bot/arena/ops/helper.sh revoke` (takes effect with the next games deploy).

## Running it (macOS or Linux)

Needs Docker (Docker Desktop on a Mac) and flyctl logged in as you (`fly auth login`).

1. Once: `sh bot/arena/ops/helper.sh init`. It makes the token and stages its hash on Fly
   (`fly secrets set --stage`); the next deploy of the games machine takes it.
2. Whenever you want to help: `sh bot/arena/ops/helper.sh` (Ctrl-C stops it). It reads the image the machine runs
   (`fly machine list`), pulls it (`fly auth docker`), keeps `fly proxy 18090:8090` running, and starts the container.
   Slots: one seed (two games at once) each, `--slots N` to choose; by default (Docker CPUs - 1) / 2. On a Mac it runs
   under `caffeinate -i`, so the computer stays awake while it plays.
3. When the games machine moves to a new build, the helper stops with code 3 and the script pulls the new image. If the
   machine still runs the image the helper just ran (its build or card data differ for another reason, such as an image
   built without `GIT_SHA`), the script stops and says so.

The image is built for Intel CPUs (`linux/amd64`). On an Apple chip Docker runs it under emulation: turn on "Use
Rosetta for x86_64/amd64 emulation" in Docker Desktop's settings, or the coordinator may crash at start.

## Protocol

Helper to machine, HTTP on the machine's port 8090 (`GAMES_HELPER_PORT`), every request with
`authorization: Bearer <token>` and `x-helper-build: <commit>`:

| Route | |
|---|---|
| `POST /v1/hello` `{build, cards, slots}` | 200 `{ok, name, heartbeatMs, leaseLostMs, claimMs}`; 409 when the build or card data differ, with the image to pull |
| `POST /v1/claim` `{slot}` | waits up to 25 s: 200 `{lease, job, bundles, deadlineMs}` or 204 |
| `GET /v1/bundle/<sha256>` | a bundle of a seed this helper holds (canonical tar, `bot/compiled/bundle.py`) |
| `POST /v1/lease/<id>/heartbeat` | at once, then every 30 s: 200 `{continue: true}`, or 410 when the seed was taken back; without the first one within 15 s the seed goes back |
| `POST /v1/lease/<id>/result` | `{results, replays}` or `{failed}`; 410 when taken back |

Ladder to coordinator, loopback only (`ARENA_REMOTE` = `http://127.0.0.1:8082/r/<nonce>`, a new nonce each boot):
`GET status` (helpers waiting), `PUT bundle/<sha256>`, `POST offer` (200 lease or 204 nobody waiting), `GET lease/<id>`
(running, done with the results, or lost with a reason), `DELETE lease/<id>` (take back).

The machine and the helper must run the same image: the coordinator compares the commit (`/app/BUILD_SHA`, from
deploy-games.yml) and a hash of the card data (`/app/CARDS_SHA`). The seed's game key goes to the helper; the round's
run key never does.

## Turning it on

All of it is off until the games machine has both `GAMES_HELPER_PORT = "8090"` in fly.games.toml and a
`GAMES_HELPER_TOKENS` secret. Off, the machine plays exactly as before: no listener, no relay, and the ladder plays
every game itself. The port is set since 2026-10-13, so the secret is the one step left: `sh helper.sh init`, then
`fly secrets deploy -a swu-arena-games` (or the next games deploy).
