# coord: the games machine's coordinator

An Elixir release that takes over from `bot/arena/games.js` on the Fly app `swu-arena-games`. Elixir decides *when*
things happen (wake-ups, the intake cadence, rounds, idle stop, shutdown); Node still decides *what* happens, through
`node bot/arena/gamesctl.js <command>` (intake, round planning, the window protocol, the referee). The window token
never leaves the BEAM: children reach the window through a signing proxy on loopback.

```
POST /wake ──▶ Endpoint ──▶ Scheduler ──(Oban: intake, rounds)──▶ gamesctl intake / referee-cmd ──▶ referee (FLAME)
                                │                                          │
                                └──▶ Pusher ──▶ gamesctl push ──▶ WindowProxy (127.0.0.1, nonce) ──▶ window
```

The design is in the project's coordinator design note (M1); the modules follow it: `Coord.Proc` is the only code
that starts OS processes, `Coord.Gamesctl` builds each command and checks its one JSON line, `Coord.Scheduler` holds
the phases, the 20 s tick and the idle rule, `Coord.Workers.{Intake,Round}` are the Oban jobs, `Coord.Shutdown` and
`Coord.Pusher` order the stop, `CoordWeb.WindowProxy` signs the children's window requests.

## Running the tests

Elixir 1.19 and OTP 28; the NIF of exqlite is built from source (`config :exqlite, force_build: true`), so a C
compiler is needed.

```bash
cd coord
MIX_ENV=test mix deps.get
mix compile --warnings-as-errors && mix format --check-formatted && mix test
mix test --include node     # also runs the real bot/arena/gamesctl.js (node 22 on the PATH)
```

The tests replace node with `test/support/fake_node`, a shell script that logs its argv and environment and prints a
canned result per command; it goes through the real `Coord.Proc`. They run as root or not; isolate.sh is never used
in the tests.

## Building and running the release

```bash
MIX_ENV=prod mix release --overwrite      # _build/prod/rel/coord
GAMES_DATA=/srv/x/data GAMES_APP=$PWD/.. PORT=18181 GAMES_PROXY_PORT=18182 GAMES_LISTEN=0.0.0.0 \
  SWU_WINDOW=http://127.0.0.1:18080 SWU_WINDOW_TOKEN=t _build/prod/rel/coord/bin/coord start
```

`rel/env.sh.eex` turns distribution off and crash dumps off (a dump would hold the token).

| Variable | Default | |
|---|---|---|
| `GAMES_DATA` | `/data` | the volume; the coordinator keeps `coord/` (0700) in it |
| `GAMES_APP` | `/app` | the repo checkout holding `bot/arena/gamesctl.js` |
| `PORT` | 8080 | `POST /wake`, `GET /healthz` |
| `GAMES_LISTEN` | `::` | 0.0.0.0 is used where the host has no IPv6 |
| `GAMES_PROXY_PORT` | 8081 | the window proxy, 127.0.0.1 only |
| `GAMES_IDLE_MIN` | 10 | stop after this long with nothing to do |
| `GAMES_REPLAY_HOURS` | 24 | passed to `gamesctl plan` |
| `GAMES_ROUND_HOURS` | 6 | a round running longer is stopped and cancelled until the next boot |
| `GAMES_GAMES`, `GAMES_WORKERS` | 2, 2 | passed to `gamesctl referee-cmd` |
| `GAMES_REQUIRE_MOUNT` | unset | `1`: refuse to start unless `GAMES_DATA` is its own file system |
| `SWU_WINDOW` | required in prod | the window's address |
| `SWU_WINDOW_TOKEN` | required in prod | taken out of the environment at boot |
| `ARENA_RESIDENTS`, `SWU_CARD_JSON` | unset | passed on to the children when set |

What it writes under `GAMES_DATA`: `coord/coord.db` (Oban's jobs; deleting it loses nothing), `coord/procs/<pgid>.json`
(one per running child, for reaping after a crash), `coord/intake.json` (intake's state), `tmp/push/state.json`
(push's state) and `tmp/<kind>/` (the `/tmp` isolate.sh gives an arena child).

Exit codes: 0 when idle or stopped by SIGTERM (the machine stays stopped until the next wake), 1 when `gamesctl setup`
fails, the volume is missing (`GAMES_REQUIRE_MOUNT=1`), the token is missing, or the supervision tree gives up.

What it checks in gamesctl's answers (a refused answer is logged and nothing runs): `plan` names a round from 0 to
1,000,000 or null; `referee-cmd` gives a list of strings with `--round K`, an env from the referee's allow-list with
no token, proxy or Fly variable, an absolute cwd, and, when the BEAM is root, a command that starts with
`bash <GAMES_APP>/bot/arena/ops/isolate.sh` and passes it `--hide /.fly --hide <GAMES_DATA>/coord` before `--`.
