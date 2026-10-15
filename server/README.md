# Arena server

The TypeScript rewrite of the arena server (Eric's pick 9B) on [Effect 4](https://effect.website), over one SQLite
file (pick 2A), with games played by Node (pick 1A). It has two parts:

- **The games machine** (stage 5, `src/main-games.ts`, `src/games/`): the program the Fly app `swu-arena-games` runs.
  It replaced the Elixir coordinator (`coord/`, in this repo's history). See "The games machine" below.
- **The record** (stage 4): every rated game, round, version and rating in one place, the one-time import of today's
  arena into it, and export API v1 with its MCP tools. Nothing deploys it yet; switching the live site over is stage 6.

## The games machine

`node src/main-games.ts` is the only program the games machine runs (`Dockerfile.games`, as root; `fly.games.toml`).
`COORD_ROLE` picks its role, and a first argument `replay` makes it the replay check:

- **games** (the default). It boots (checks the volume, takes the tokens out of its environment, runs `gamesctl
  setup`, stops process groups a crashed run left, warms the bundles), then ticks every 20 s, and at once on
  `POST /wake`: the intake about every minute, then `gamesctl plan`, then the round plan names. It plays the round
  itself: seeds and keys from the round-seed secret (never in a child), the round robin and the deck deal as
  `bot/ladder.js` dealt them, some games at once on the machine (`workers` in Eric's settings) and whole seeds leased
  to helpers, each seed's games one `bot/arena/play-seed.js` job. It writes `results/arena-r<K>/` as the ladder did
  (`index.json`, `ladder.json`, replays), keeps each game in `games.db` so a round cut by a deploy resumes with its
  finished games, and pushes to the window every 20 s (every 3 s while a round plays). With nothing to do for
  `GAMES_IDLE_MIN` minutes it exits 0, and Fly leaves the machine stopped until the next wake.
- **helper** (`COORD_ROLE=helper`): plays seeds the machine leases out, on a computer of Eric's
  ([bot/arena/HELPER.md](../bot/arena/HELPER.md)).
- **replay**: `node src/main-games.ts replay --results <arena-rK folder> --bundles <folder of tars> --names <file>
  --out <folder> [--only a,b] [--decks-dir <folder>]` plays a recorded round again from its seeds and compares every
  game and replay with the record (the stage 5 done check). It exits 0 only when every game came out the same.

No child gets a token: the server builds each child's environment from nothing (`src/games/Proc.ts`), and gamesctl's
`intake` and `push` reach the window through a loopback proxy that adds the token (`127.0.0.1:GAMES_PROXY_PORT`, a
new nonce each boot). Game jobs run as the user `arena` with no capabilities, in their own PID and mount namespaces
(`bot/arena/ops/isolate.sh`), with `/.fly`, `/data/secret` and `/data/server` hidden. The Node work that serves the
old window's contract stays in `bot/arena/gamesctl.js` until stage 6, one JSON line per command: `setup`, `warm`,
`plan`, `round` (a round's rules, lineup, deck lists and version tars), `publish` (standings, the round's report,
panels), `decks`, `intake` and `push`.

The volume (`GAMES_DATA`, `/data`):

| Path | Owner | Holds |
| --- | --- | --- |
| `server/` | root, 0700 | `games.db` (rounds and their games), `procs/` (a pidfile per child), `settings.json` (Eric's last settings), `round_end` |
| `secret/arena-secret` | root, 0600 | the round-seed secret |
| `arena/`, `results/`, `dash/` | root, readable by all | roster, versions, standings, round reports, panels; each round's `arena-r<K>/`; panel copies |
| `bundles/` | root | `<sha256>.tar`, each version's canonical bundle: play-seed and helpers read them |
| `work/<job>/` | root (`out/` the bots' user's) | one game job, removed once its results are read |
| `home/`, `wasm-cache/` | arena | the bots' HOME, wasmtime's compiled modules |
| `intake/`, `tmp/<kind>/` | root (`tmp/<kind>/` 1777) | the intake's checks; each isolated child's `/tmp` |
| `coord/` | root | the Elixir coordinator's state: its settings and round end are read once; hidden from children |

| Variable | Default | |
| --- | --- | --- |
| `COORD_ROLE` | games | `helper` makes it a helper |
| `GAMES_DATA` | `/data` | the volume |
| `GAMES_APP` | `/app` | the checkout with `bot/` and `forceteki/` |
| `PORT`, `GAMES_LISTEN` | 8080, `::` | `POST /wake` (202), `GET /healthz` (200), Fly's flycast service |
| `GAMES_PROXY_PORT` | 8081 | the window proxy, 127.0.0.1 only |
| `SWU_WINDOW` | | the window's address |
| `SWU_WINDOW_TOKEN` | | secret: taken out of the environment at boot |
| `GAMES_IDLE_MIN` | 10 | stop after this long with nothing to do |
| `GAMES_REPLAY_HOURS` | 24 | a round with an unchanged lineup plays again after this long (`gamesctl plan`) |
| `GAMES_ROUND_HOURS` | 6 | a longer round is stopped and held until the next boot (fractions allowed) |
| `GAMES_GAMES`, `GAMES_WORKERS`, `GAMES_THINK_CAP_SEC` | 2, 2, 60 | games per pair, games at once, each bot's thinking per game; Eric's arena settings win |
| `GAMES_REQUIRE_MOUNT` | unset | `1`: refuse to start unless `GAMES_DATA` is its own file system |
| `SWU_CARD_JSON` | unset | passed on to the children |
| `GAMES_HELPER_PORT`, `GAMES_HELPER_LISTEN` | unset, `FLY_PRIVATE_IP` | the helper API; on only with a port and a `GAMES_HELPER_TOKENS` entry |
| `GAMES_HELPER_TOKENS` | unset | secret: `name:sha256-of-token`, comma separated |
| `GAMES_HELPER_IMAGE` | `registry.fly.io/swu-arena-games` | the image a helper of another build is told to run |
| `GAMES_BUILD`, `GAMES_CARDS` | `/app/BUILD_SHA`, `/app/CARDS_SHA` | what a helper must match; set them only in rehearsals |
| `GAMES_HIDE`, `ARENA_USER` | unset, `arena` | more paths hidden from children (`:`-separated); the bots' user |
| `GAMES_HELPER_URL`, `GAMES_HELPER_SLOTS`, `GAMES_HELPER_TOKEN` | | helper only: the machine (through `fly proxy`), 1 to 16 slots (1), the token |

Exit codes: the games role 0 when idle or stopped (SIGTERM; Fly then leaves the machine stopped), 1 when it cannot
run (setup failed, no volume with `GAMES_REQUIRE_MOUNT=1`, no token, a bad setting: Fly restarts it up to 3 times).
The helper 0 when stopped, 1 when its token is refused or its setup is broken, 3 when the machine runs another build
(helper.sh then pulls it).

Locally, against a local window (unset `SWU_WINDOW` in your shell first, since cloud sessions point it at the live
window; keep the data outside `/tmp`, since isolate.sh gives each child its own `/tmp`; as root for the isolation):

```bash
GAMES_DATA=/srv/x/data GAMES_APP=$PWD/.. PORT=18181 GAMES_PROXY_PORT=18182 GAMES_LISTEN=127.0.0.1 \
  SWU_WINDOW=http://127.0.0.1:18080 SWU_WINDOW_TOKEN=t node src/main-games.ts
```

## The record

One SQLite file (`<ARENA_DATA>/arena.db`) and a replay folder next to it (`<ARENA_DATA>/replays/<round>/<game>.jsonl.gz`).
The schema is two migrations in `src/Db.ts`.

| Table | Holds |
| --- | --- |
| `people` | GitHub logins with a role (admin or friend) and who invited them. |
| `competitors` | A bot's name, title, owner and about text. House bots (the residents) have no owner. |
| `submissions` | Every upload, accepted or rejected, and the version it became. |
| `versions` | One row per version of a competitor (`alice_bot-v3`): its number, format (wasm, js, builtin), files and submission. Games name versions, never competitors. |
| `arenas`, `seasons` | An arena's rules (games per pair, time limit, hang limit, step limit) and its seasons. A rule change starts a new season. |
| `rounds` | A rated round: its lineup of versions, first seed, rules, state, and the durable workflow that plays it. |
| `games` | Every game: seed, deal key, the two versions, how it ended (`won`, `draw`, `forfeit`, `error`, `step_cap`, `stuck`, `abandoned`), its score, who was at fault and why, steps, time per seat, and where its replay is. `seq` orders the export. |
| `ratings` | After each round, two ratings per version: on that round's games, and on every game of the season so far. |
| `spots` | A version's edge in each of the Strategy Atlas's 9 spots (empty until stage 5 fills it). |
| `settings` | Eric's arena settings. |
| `traces` | Each game played again from its replay: whether it came out the same, the first difference, and the build that checked it. |

**Ratings** (`src/Ratings.ts`) are today's referee math, in one place: Bradley-Terry by the MM algorithm on the Elo
scale (`bot/ratings.js`), shifted so the house versions in the lineup average 1500, with a standard error per
version. A forfeit counts as a loss for the bot at fault; an error with no one at fault, a step cap, a stuck game and
an abandoned game are kept but not rated.

## Import today's arena

```bash
cd server
ARENA_DATA=./data ARENA_IMPORT_TOKEN=... NODE_USE_ENV_PROXY=1 npm run import -- --window https://swu-arena.fly.dev
npm run import -- --home /path/to/window-volume      # or a copy of the window's volume (WINDOW_HOME layout)
```

It only reads (GET `/api/docs/...` and `/api/replays/...`), writes everything in one transaction, then rates every
round and compares each rating and record with the window's own standings. Any difference undoes the whole import.
Running it again adds only what is new. `ARENA_PUSH_TOKEN` works as the token too.

On the live window (14 Oct 2026) it took one minute: 16 rounds, 2,862 games (2,820 rated), 41 versions, 29
submissions, all 2,862 replays (29 MB gzipped, plus a 2.1 MB database), and 216 of 216 standings numbers matched.

Choices it makes (each one is easy to change before stage 6):

- Today's rounds are the open arena's season 1. The season's note records that rounds 0-12 used 2 games per pair
  with a 60 s limit and rounds 13-15 used 6 games per pair with 45 s.
- The bots built into the games image (`c-clock-wasm`, `heuristic`, ...) become version 0 of the resident each one
  turned into (`c_clock`, `heuristic`, ...), under their old names, so every game names a version.
- Builders' `v0` starting versions are imported too, so version numbers match the window.
- `sha256` stays empty for imported versions: the bundles live on the games machine, which the import does not read.
- People: builders become friends and `ericfode` the admin (`--admins`). GitHub ids are filled at sign-in (stage 6).
  The admin documents, view links and invites stay behind; view links come over hashed in stage 6.
- Each game keeps both of today's time figures: the referee's thinking time per seat, and the decision timings.
- Versions of bots no longer in the roster (`rt_haiku`, `rt_opt`) are left out and listed in the report's notes.

## Export API v1

Every read takes a reader token. Asking for one arena, version, round or game that does not exist gets a 404 that
names it. The OpenAPI document is `/api/v1/openapi.json`, with a browsable page at `/api/v1/docs`.

| Path | Gives |
| --- | --- |
| `GET /api/v1/arenas`, `/arenas/:id` | Arenas with their rules and seasons. |
| `GET /api/v1/arenas/:id/standings?season=` | Each finished round's ratings, best first: that round's and the season's so far. |
| `GET /api/v1/competitors` | Bots with their owners. |
| `GET /api/v1/versions?competitor=`, `/versions/:id` | Versions. |
| `GET /api/v1/versions/:id/stats?arena=&season=` | One version's record, rating, head-to-heads, time used and spots. |
| `GET /api/v1/rounds?arena=&season=`, `/rounds/:id` | Rounds with games played and rated. |
| `GET /api/v1/games?arena=&season=&round=&version=&since=&before=&limit=` | Games, newest first, a page at a time (`next` is the `before` for the next page). |
| `GET /api/v1/games/:id`, `/games/:id/replay` | One game, and its replay as JSON lines (gzipped when the client accepts it). |
| `GET /api/v1/export/games.jsonl?arena=&season=&after=&since=` | Every game, oldest first, one per line. Pass the last `seq` read as `after` to resume. |
| `GET /api/v1/traces?differs=&limit=` | The nightly trace checks: counts, then each game's verdict, newest first. |
| `POST /api/v1/rounds`, `GET/POST /api/v1/settings` | Admin only: start a rated round of versions; read or change the settings. |

The MCP server at `/mcp` has the same reads as tools, built from the same schemas, so an agent and an HTTP client get
the same records and the same refusals: `arena_arenas`, `arena_standings`, `arena_competitors`, `arena_versions`,
`arena_version_stats`, `arena_rounds`, `arena_round`, `arena_games`, `arena_game`, `arena_replay` (a slice of a
replay's lines) and `arena_traces`. All are marked read-only.

Auth is two bearer tokens from the environment (`ARENA_ADMIN_TOKEN`, `ARENA_READ_TOKEN`) for now; sign-in (GitHub,
MCP OAuth) replaces them in stage 6.

## Rounds

In the record, a rated round is a durable workflow (`src/Rounds.ts`): each job (one seed's games, at most 8) is an
activity whose result is stored in SQLite, and a last activity rates the round. Each job's games and replays are
recorded as soon as it finishes. Kill the server mid-round and start it again: the round carries on, and finished jobs
are not played again.

The game player (`src/Player.ts`) runs `node bot/arena/play-seed.js` per job and checks its output against a schema
before anything is recorded. It still asks for each bot as a resident built into the games image; the games
machine's rounds (above) send each version's bundle instead.

## Trace checks

Every night at 04:00 UTC (a cluster cron, `src/Traces.ts`) the server plays its newest 1,000 unchecked games again
from their replays with `node bot/trace.js check`, 100 games to a process, and stores each verdict in the `traces`
table: did every recorded move stay legal and every board come out the same, and if not, the first step that differs.
A game is a function of its decks, seed, key and chosen moves, so a difference points at the engine, the referee or
the recorder. Each game is checked once. The checker runs at the lowest CPU priority and stops for the night when a
round starts, since bots are timed. On the 2,862 games of today's window, every one played out the same (about 0.5 s a
game).

`GET /api/v1/traces?differs=&limit=` and the MCP tool `arena_traces` give the counts (checked, came out differently,
not checked yet) and the verdicts, newest games first. `npm run traces -- --limit 1000` runs the same check by hand on
the record in `ARENA_DATA`; it needs the engine built in `ARENA_ROOT`.

## Run it

Node 22.18 or newer runs the TypeScript directly (type stripping), so there is no build step.

```bash
cd server && npm ci
npm test                      # the record's and the games machine's tests; real games skip without the engine
npm run typecheck
ARENA_ADMIN_TOKEN=a ARENA_READ_TOKEN=r npm start   # the record: http://127.0.0.1:8787, data in ./data (ARENA_DATA)
```

The CI workflow (`.github/workflows/ci.yml`) runs the tests and the typecheck when `server/`, `bot/` or the engine pin
changes, and `deploy-games.yml` runs them before every deploy of the games machine.

`npm start` plays real games only where the engine is built (`forceteki/build`, card data); `ARENA_ROOT` points at
another checkout that has it. A round's bots must be versions in the record:

```bash
curl -H 'Authorization: Bearer a' -H 'content-type: application/json' \
  -d '{"id":"r1","bots":["heuristic","rush"],"firstSeed":7}' http://127.0.0.1:8787/api/v1/rounds
curl -H 'Authorization: Bearer r' http://127.0.0.1:8787/api/v1/rounds/r1
```

## What the spike found

- **One schema everywhere works as advertised.** The OpenAPI document, the MCP tools' input schemas, the server's
  checks, the typed client's checks and the rows read from SQLite all come from `Domain.ts`. The same bad `limit` is
  refused with the same message over HTTP and over MCP.
- **Durable rounds work on SQLite.** A round killed with SIGKILL after its first job carried on in the restarted
  process and replayed only the unfinished job. Effect's cluster runs in single-process mode here
  (`SingleRunner`), keeping its messages and activity results in the arena's own SQLite file.
- **Two defaults needed changing.** Effect answers a request that fails its schema with an empty 400. A middleware
  now turns it into a 400 that says why (`InputErrors`). Unknown fields are ignored by default; the API now refuses
  them.
- **A killed server leaves its game process running** until that job ends, and the restarted server plays the same
  job again. Both results are the same games (same seeds), and the second write is ignored. The real stage should
  run each job in its own process group and stop leftovers at startup.
- **Effect 4 is new** (4.0.0 on 2026-10-01). Its HTTP, MCP, SQL and workflow modules are marked unstable, and node's
  SQLite is still experimental in Node 22. The pieces used here behaved as documented.
