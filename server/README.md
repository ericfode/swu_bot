# Arena server (stage 4: the record)

The TypeScript rewrite of the arena server (Eric's pick 9B) on [Effect 4](https://effect.website), over one SQLite
file (pick 2A), with games played by Node (pick 1A). Stage 4 builds the record: every rated game, round, version
and rating in one place, the one-time import of today's arena into it, and export API v1 with its MCP tools.
Nothing deploys it yet; switching the live site over is stage 6.

## The record

One SQLite file (`<ARENA_DATA>/arena.db`) and a replay folder next to it (`<ARENA_DATA>/replays/<round>/<game>.jsonl.gz`).
The schema is one migration in `src/Db.ts`.

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
| `POST /api/v1/rounds`, `GET/POST /api/v1/settings` | Admin only: start a rated round of versions; read or change the settings. |

The MCP server at `/mcp` has the same reads as tools, built from the same schemas, so an agent and an HTTP client get
the same records and the same refusals: `arena_arenas`, `arena_standings`, `arena_competitors`, `arena_versions`,
`arena_version_stats`, `arena_rounds`, `arena_round`, `arena_games`, `arena_game` and `arena_replay` (a slice of a
replay's lines). All are marked read-only.

Auth is two bearer tokens from the environment (`ARENA_ADMIN_TOKEN`, `ARENA_READ_TOKEN`) for now; sign-in (GitHub,
MCP OAuth) replaces them in stage 6.

## Rounds

A rated round is a durable workflow (`src/Rounds.ts`): each job (one seed's games, at most 8) is an activity whose
result is stored in SQLite, and a last activity rates the round. Each job's games and replays are recorded as soon as
it finishes. Kill the server mid-round and start it again: the round carries on, and finished jobs are not played
again.

The game player (`src/Player.ts`) runs `node bot/arena/play-seed.js` per job and checks its output against a schema
before anything is recorded. It still asks for each bot as a resident built into the games image; stage 5 sends it
the submitted bundle instead.

## Run it

Node 22.18 or newer runs the TypeScript directly (type stripping), so there is no build step.

```bash
cd server && npm ci
npm test                      # 16 tests: settings, ratings, the import, export API = MCP, rounds, a restart mid-round
npm run typecheck
ARENA_ADMIN_TOKEN=a ARENA_READ_TOKEN=r npm start   # http://127.0.0.1:8787, data in ./data (ARENA_DATA)
```

The Server workflow (`.github/workflows/server.yml`) runs the tests and the typecheck when `server/` changes.

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
