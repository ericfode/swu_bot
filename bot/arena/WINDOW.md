# The arena window (swu-arena on Fly)

The window is the arena and its research as invited friends see them, at https://swu-arena.fly.dev. It is phase A of
the hosting plan (https://claude.ai/artifact/XsnHdQbtsxYTymkuTaDcCy): tournaments still play in the project, and the
window shows them live. In phase B the whole arena moves into the same image.

## One API, and every part talks to it

Eric's rule (2026-10-11): the links between the parts go through the API, never through the shared folder. So each
part sends its own data to the window, and anything that reads it (friends' browsers, the app, research threads)
asks the same API.

| Part | Sends | Through |
|---|---|---|
| Arena (referee + api.js) | status, standings, tournament, roster (no tokens), round reports, versions, panels | `node bot/arena/push.js arena` (a loop, every 20 s), which `ops/launch.sh` starts and `ops/keeper.sh` keeps alive when `SWU_WINDOW` is set at start; never the referee itself, whose bots must not get the proxy |
| Ladders (`bot/ladder.js`) | each run's index and report, each game's replay as it is played | started by ladder.js itself when `SWU_WINDOW` is set |
| Meta analyzer (`meta/analyze.js`) | the Atlas model and the ratings | at the end of each run when `SWU_WINDOW` is set |
| Research lines and the dashboard | panels, experiments, evals, bot cards, league, lens, threads | `node bot/arena/push.js dir <collection> <folder>` |
| Browsers, the app | nothing | `GET /api/app`, `/api/status`, `/api/replays/<run>/<game>` |

## The API

Reads (a signed-in friend, or the project token):

- `GET /api/app`: the app's model, built in the window by the app's own loaders, with builder and thread names removed.
- `GET /api/status`, `standings`, `report?round=K`, `games?round=K`, `versions?name=X`, `panel?name=X`: the arena's own
  read methods, same shapes as `api.js`, answered from what the arena sent. Other methods answer 501 until phase B.
- `GET /api/replays/<run>` lists a run's games (`?sizes=1` adds sizes); `GET /api/replays/<run>/<game>?from=<byte>`
  returns the replay from that byte, with its full size in `x-size`, so a viewer can follow a game being played.
- `GET /api/docs/<collection>[/<id>]`: raw documents. Friends may read `arena`, `runs`, `evals`, `lens` and `meta`;
  the rest reaches them only through `/api/app`.

Writes need a bearer token (the project token, or the admin token); a session cookie never writes, whatever its role:

- `PUT /api/docs/<collection>/<id>` with a JSON body; `DELETE` removes one. Collections: arena, runs, ladders, league,
  experiments, evals, panels, bots, threads, lens, meta, research, admin. The `admin` collection needs the admin token
  to read or write: the proxy adds the project token to every process in the project, competitor bots included.
- `POST /api/replays/<run>/<game>?at=<bytes>` appends lines at that offset, which must be the replay's current size;
  otherwise 409 with the size to resend from, so a retry never doubles a line. `PUT` replaces a whole replay.
- `PUT /api/docs/admin/invites` with `{"logins": [...]}` changes who may sign in, without a deploy
  (`SWU_WINDOW_TOKEN=<ARENA_ADMIN_TOKEN> node bot/arena/push.js invites a,b,c`).

## Who may do what (auth.js)

- Friends sign in with GitHub. A login in `ARENA_ADMINS` (default ericfode) is an admin; one in `ARENA_INVITES` or the
  invite document is a friend; anyone else sees who to ask. Sessions last 14 days and survive deploys.
- The project's threads send `Authorization: Bearer <ARENA_PUSH_TOKEN>` (role project). In cloud sessions the egress
  proxy adds it for swu-arena.fly.dev (a network secret in the environment's settings), so no thread holds the token.
  Elsewhere set `SWU_WINDOW_TOKEN`.
- `ARENA_ADMIN_TOKEN` (a Fly secret only Eric holds) is role admin: the only bearer that may change the invite list.

## Outside machines (feeds)

A machine outside the project, such as the Karabast Sprite that streams c-clock's games against people, gets its own
token: the Fly secret `ARENA_FEED_TOKEN_<NAME>` (for example `ARENA_FEED_TOKEN_KARABAST`), stored on that machine and
never in a thread. `<NAME>` is letters and digits only, so one feed's names never start with another feed's name and a
hyphen. A feed token reads like a friend and writes only what carries its name, `<name>` or `<name>-<id>`:

- `PUT /api/docs/runs/karabast`: the game list with `"id": "karabast"`, in the tournament index shape (`TournamentIndex`,
  viewer/src/core/types.ts), with game ids `karabast-<id>`. A game with `outcome: "running"` shows in the app's grid of
  running games; a finished one has `outcome` `"won"` (with `winnerSeat` `p1` or `p2`), `"draw"` or `"abandoned"`. The
  window keeps only the fields the app reads, each checked for its type: on the run `createdAt` (required), `bots` and
  `gamesPerPairing`; on each game `id` (distinct), `p1`, `p2`, `outcome`, `winnerSeat` (set from the outcome), `rounds`,
  `steps` and `error` (text). It drops every other field and refuses a document that does not fit with a 400. It stamps `"feed": "karabast"` on the run,
  and the app lists every run a feed sent as games against people, kept out of bot records and ratings.
- `POST /api/replays/karabast/karabast-<id>?at=<bytes>`: the replay's new lines while the game is played; `PUT` the
  whole file when it ends. `push.js run <folder> --follow` does both for a folder laid out like a ladder run.
- `PUT /api/docs/lens/karabast-<id>`: the game's win-probability lens (swu-lens/1), under the game's id, which is how
  the viewer finds it.

## Deploys

Code reaches Fly only through GitHub: `.github/workflows/deploy-arena.yml` runs the window's tests, then
`flyctl deploy --remote-only` builds the `Dockerfile` on Fly's builders and updates the one machine (`fly.toml`).
Data lives on the volume `arena_data` at `/data/window` (documents, and replays gzipped: about 30 MB for every
replay recorded so far).

One-time setup (Eric): the network secret and allowed domain for swu-arena.fly.dev with the same value set as the Fly
secret `ARENA_PUSH_TOKEN`; a GitHub OAuth App with callback `https://swu-arena.fly.dev/auth/github/callback`, its
client ID and secret as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`; an `ARENA_ADMIN_TOKEN` Fly secret, if invites
should change without a deploy; and a deploy token as the repository secret `FLY_API_TOKEN` (until it is set, merges
run the tests and deploy nothing). Threads send data when `SWU_WINDOW=https://swu-arena.fly.dev` is set in their environment.

## Run it locally

    ARENA_MODE=window WINDOW_HOME=/tmp/window ARENA_PUSH_TOKEN=t ARENA_PUBLIC_URL=http://localhost:8080 \
      node bot/arena/server.js --host 127.0.0.1 --port 8080
    SWU_WINDOW=http://localhost:8080 SWU_WINDOW_TOKEN=t node bot/arena/push.js run /mnt/project-files/results/<run>

Build the page first with `npm run app -- --public --shell` (and the viewer kit with `npm --prefix studio run build:kit`).
