# Arena: the hosted bot arena

Invited people (builders) write Star Wars Unlimited bots on their own computers and submit them to the arena window.
The games machine packs each bot into a WebAssembly bundle, rates it in rounds against the other builders' bots and
the project's own bots, and sends the results back to the window, where friends watch them. Both run on Fly.

```
builder ──/mcp arena_submit──▶ window (swu-arena) ──POST /wake──▶ games machine (swu-arena-games)
                                 ▲                                  intake ─▶ versions ─▶ referee ─▶ ladder
                                 └──── status, standings, panels, round replays (push.js) ───┘
```

## The window (swu-arena)

`ARENA_MODE=window node bot/arena/server.js` (`Dockerfile`, `fly.toml`) serves https://swu-arena.fly.dev: the arena
and the research for invited friends, behind GitHub sign-in. It stores the documents and replays the other parts send
it, and it never runs a bot. `WINDOW.md` describes its API, sign-in and deploys.

- `window.js`: the HTTP API and the document store. `server.js` starts it.
- `auth.js`: who may do what (friends, view links, the project's token, the games machine's token, feeds).
- `oauth.js`, `mcp-http.js`: `/mcp`, the remote MCP server each person's app signs in to with GitHub. Builders submit
  bots there (`arena_submit`) and read their results.
- `connect.js`: the device grant for an agent with no browser, such as a builder's Claude Code on their own computer.
- `BUILD.md`: how to write and submit a bot. `/mcp` serves it as `arena_guide`.
- `push.js`: the client every part of the project uses to send its data to the window.

`GET /` is the SWU Arena app (`app/`) when its friends build exists: run `npm run app -- --public` to make
`app/dist/public.html`, or point `ARENA_APP` at another build. Without a build, `/` is the arena's old web page
(`web/index.html`), which the window also serves at `GET /arena`. That page makes every call as `POST /api/<method>`,
which the window does not answer, so it shows no data there.

## The games machine (swu-arena-games)

One Fly machine (`fly.games.toml`, `Dockerfile.games`) with a private address only. The window wakes it with
`POST /wake` on every submission and every 6 hours. With nothing to do for 10 minutes it stops until the next wake.
`ops/games-entry.sh` starts one of two programs, picked by `GAMES_COORDINATOR` in `fly.games.toml`:

- `elixir`, what runs today: the coordinator in `coord/` (`coord/README.md`). It runs `node bot/arena/gamesctl.js
  <command>` for each step (setup, warm, plan, referee-cmd, intake, push) and keeps the window token in its own process.
- `node`: `games.js`, a Node loop that calls the intake, the referee and `push.js` itself (the fallback until it is
  removed).

Both run the same Node code: `gamesctl.js` takes its setup, round planning and referee command from `games.js`. Each
cycle has three parts:

1. The intake, every minute and right after a wake (`intake.js` `intakeOnce`). It reads the window's pending
   submissions and packs each bot into a bundle (JavaScript through Javy, Python with CPython for WASI, a ready
   bundle as it is; `bot/compiled/README.md`). It registers the builder's competitor the first time (owner
   `github:<login>`) and submits the bundle as its next version (`api.js` `submit`, kind `wasm`). The window gets the
   version or the error lines back.
2. A round (`referee.js --round K`), when the lineup changed (90 s after the last version came in, so a quick fix
   joins the same round) or the last round is a day old.
3. The push (`push.js` `arenaPusher`), every 20 s: status, standings, roster (without tokens), round reports,
   versions and panels, and the replays of the newest two rounds, into the window's `arena`, `panels`, `experiments`,
   `runs` and `ladders` collections.

A round is a round robin (`bot/ladder.js`) of every competitor's newest version and the residents, 2 games per pair
(one seed, both seats). The residents are the roster's baselines, the project's own bots: heuristic, rush, and
c-clock, rust-greedy2, rust-search, node-search and py-clock built to WebAssembly in the image (`ARENA_RESIDENTS`
overrides). Ratings are Bradley-Terry with the residents' mean pinned to 1500, per round and over all rounds, so
versions compare across rounds. A round cut short by a stop (a deploy) resumes at the next start and keeps the games
already played.

Isolation: submitted code runs only in the wasmtime sandbox (`bot/compiled/run.py`): no network, no files but its own
and the card data, no other programs. Packing and checking a submission run in a child process without the token, in
its own PID and mount namespace (`ops/isolate.sh`), as the user `arena`. The referee runs as root in its own
namespaces, with a minimal environment and `/.fly` hidden, and it alone reads the round-seed secret. The ladders it
starts, where bot code runs, run as `arena` with no capabilities (`referee.js` `spawnBots`). The network is shared.

Its data is on the volume (`GAMES_DATA`, `/data`): `arena/` (`ARENA_HOME`: `roster.json`, `versions/<name>-v<N>/`,
`standings.json`, `rounds/r<K>.md`, `panels/`), `results/arena-r<K>/` (each round's ladder and replays), `intake/`,
`wasm-cache/`, `home/` (the bots' HOME), `dash/` and `secret/` (root's only). Without `ARENA_HOME`, `home.js` uses
`/mnt/project-files/arena` when that folder exists (the old arena's data, which the project build of the app still
reads), else `arena-home/` in the repo.

The code, besides `games.js`, `gamesctl.js` and `intake.js`:

- `referee.js`: plays one rated round per run and writes `standings.json`, `rounds/r<K>.md` and the panels.
- `api.js`: competitors, versions and results (below).
- `registry.js`: resolves `<name>-v<N>` to its version folder for `bot/players/index.js`. A `wasm` version runs from
  its `bundle/` folder under `bot/compiled/run.py`.
- `home.js`: where the arena's files are, and the helpers that read and write them.
- `dash.js`: the competitor panels, the leaderboard and the experiment (Elo over rounds) that the window shows.
- `starters/`: the bots `api.js` `register` copies into a new competitor (its v0; a builder's own bot is v1).

Deploys, secrets and a local run of the games machine: `WINDOW.md` ("The games machine") and `coord/README.md`.

## Rules for bots

`BUILD.md` ("Rules of the sandbox") has the limits for submitted bots: time per call, memory, no network, no files,
only their own code. Every bot, the residents included, also plays under these rules:

- **Time cap.** Each bot may think 60 s per game (`roster.json` `thinkCapMs`). A bot program, which every submitted
  bot is, is timed in wall time from its start to each answer. An in-process resident is timed in CPU time, with
  twice the cap in wall time as a second limit (`bot/players/guard.js`).
- **Forfeits.** A bot loses the game (outcome `ERROR` with `by` = its seat, and `faultKind` load, error, time or hang)
  when it fails to load or start, answers with something that is not a legal action (or a bad split, or a malformed
  reply), goes over the time cap, or does not answer for 30 s past the cap. Only engine errors outside the bot are
  unrated (`ERROR` with `by` null).
- **No hidden information.** Decklists are public: a bot may use the multiset of all cards each player owns. It may
  not learn which hidden zone an opponent card is in, the opponent's hand or either deck's order; counts are fine. A
  bot program sees only what the protocol sends it (`spec/protocol.md`).
- **Determinism.** Use the seed from `hello` (or the `rng` an in-process bot gets), never a clock or other randomness.
  Prefer count-based search budgets over wall-clock ones.
- **Secret seeds.** Each round's seeds and its key (which deals every game, so a seed alone says nothing about hidden
  cards) come from the round-seed secret, which only the referee reads. A game's key is published once every game
  dealt from it has ended.

## One API

`api.js` is the arena's data layer. The games machine calls it in-process: the intake registers and submits, and
`push.js` reads what it sends. Methods: `status`, `register`, `submit`, `withdraw`, `rejoin`, `versions`,
`standings`, `report`, `panel`, `panels`, `games`, `ladder`; the header of `api.js` lists their arguments. The window
answers `status`, `standings`, `report`, `games`, `versions` and `panel` with the same JSON shapes, from what the games
machine sends.

- `withdraw {name}` benches a competitor: it plays no ladder that starts from now on. `withdraw {name, version}` stops
  rating one broken version, so the referee rates the newest one not withdrawn. Versions, games and ratings stay;
  `rejoin` with the same arguments undoes either. The window offers neither, so they are run on the games machine,
  against its arena folder.
- `ARENA_AUTH=1` makes changes need the token `register` returned, or `ARENA_ADMIN_TOKEN`. The games machine leaves it
  off: only its intake changes competitors.

`mcp.js` serves the API as MCP tools over stdio, one per method, named `arena_<method>`:

    node bot/arena/mcp.js                                  a local arena folder (ARENA_HOME)
    node bot/arena/mcp.js --remote https://swu-arena.fly.dev [--token T]
                                                           the window: its arena reads, plus window_* tools that read
                                                           its collections and upload local runs and documents

The window mode is how the project's threads read and push window documents (`WINDOW.md`, "Through MCP"). Builders
use the window's own `/mcp` instead.

Readers (the app, research threads, friends' browsers) use these calls or the window's documents, never the arena's
files (Eric, 2026-10-11: every edge goes through the API):

| file | call | on the window |
|---|---|---|
| `roster.json`, `standings.json`, `versions/*/SUBMISSION.json` | `status`, `standings`, `versions` | the same, and `arena/roster` |
| `results/<ladder>/index.json`, `games/*.jsonl` | `games {round}` | `games`, then `GET /api/replays/<run>/<game>` |
| `results/<ladder>/ladder.json` (ratings) | `ladder {round}` | `ladders/<run>` |
| `panels/`, the dashboard's `arena-*` panels and `arena` experiment | `panels`, `panel {name}` | `panel`, `panels/<id>`, `experiments/arena` |

## Strategy diagrams

Panels from the old arena carry declarative diagrams (schema `swu-strategy/1`, a dashboard widget
`{type: 'strategy'}`). Nothing posts new ones. The app still draws them with `web/strategy-diagram.js`, whose header
has the schema.
