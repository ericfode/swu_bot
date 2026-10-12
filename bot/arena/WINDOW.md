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
| Browsers, the app | the invite list, from Eric's Share page only | `GET /api/app`, `/api/me`, `/api/status`, `/api/replays/<run>/<game>`; `GET`, `POST /api/share` (an admin) |

## The API

Reads (a signed-in friend, or the project token):

- `GET /api/app`: the app's model, built in the window by the app's own loaders, with builder and thread names removed.
- `GET /api/status`, `standings`, `report?round=K`, `games?round=K`, `versions?name=X`, `panel?name=X`: the arena's own
  read methods, same shapes as `api.js`, answered from what the arena sent. Other methods answer 501 until phase B.
- `GET /api/replays/<run>` lists a run's games (`?sizes=1` adds sizes); `GET /api/replays/<run>/<game>?from=<byte>`
  returns the replay from that byte, with its full size in `x-size`, so a viewer can follow a game being played.
- `GET /api/docs/<collection>[/<id>]`: raw documents. Friends may read `arena`, `runs`, `evals`, `lens` and `meta`;
  the rest reaches them only through `/api/app`.
- People are never named to readers. A run against people (a feed's run, or an id starting `karabast`) is stored as
  sent, and only the programs that write (bearer tokens from feed up) read it back that way. Everyone else (a
  sign-in, a view link's guest, an MCP app) reads a copy: the person's seat is `opponent` in the run document and
  `a person` in the replay's header and on each board. The copy holds whole lines only, so offsets into it stay valid
  while the game is played, and `?sizes=1` gives `size: null` for its games (`x-size` on each read gives the size).

Writes need a bearer token (the project token, or the admin token); a session cookie never writes, whatever its role,
except an admin changing the invite list from the app's Share page (below):

- `PUT /api/docs/<collection>/<id>` with a JSON body; `DELETE` removes one. Collections: arena, runs, ladders, league,
  experiments, evals, panels, bots, threads, lens, meta, research, admin. The `admin` collection needs the admin token
  to read or write: the proxy adds the project token to every process in the project, competitor bots included.
- `POST /api/replays/<run>/<game>?at=<bytes>` appends lines at that offset, which must be the replay's current size;
  otherwise 409 with the size to resend from, so a retry never doubles a line. `PUT` replaces a whole replay.
- `PUT /api/docs/admin/invites` with `{"logins": [...]}` changes who may sign in, without a deploy
  (`SWU_WINDOW_TOKEN=<ARENA_ADMIN_TOKEN> node bot/arena/push.js invites a,b,c`).
- `GET /api/share` lists who may sign in (`invites`, plus `admins` and `fromEnv`, which only a deploy changes);
  `POST /api/share` with `{"add": "<login>"}` or `{"remove": "<login>"}` changes the invite document. Admins only: the
  admin token, or an admin's sign-in from the app's Share page, where the request must carry `Origin` equal to
  `ARENA_PUBLIC_URL` and a JSON body, so a page elsewhere cannot send it. A change takes effect on the next request.
- `POST /api/share` with `{"addLink": "<who it is for>"}` makes a view link, `{"removeLink": "<id>"}` removes one
  (the `admin/links` document). Opening `/v/<key>` lets anyone holding the link read the window with no sign-in (Eric's
  typed OK, 2026-10-12 04:30): it sets a 30-day guest session tied to that link and sends the browser to `/`, which
  keeps the link's `#/page`. A guest reads like a friend and never writes; removing the link locks its guests out on
  their next request. Someone already signed in keeps their own session when they open a link.
- `GET /api/me` answers `{login, role}` (plus `guest: true` for a view link's guest) for the app; the Share page shows
  the invite list and the view links to admins.

## Through MCP

`node bot/arena/mcp.js --remote https://swu-arena.fly.dev [--token T]` is the same API as MCP tools, for a Claude (or
any MCP client) that loads data the way a user would. It offers the arena reads the window answers (`arena_status`,
`arena_standings`, `arena_report`, `arena_games`, `arena_versions`, `arena_panel`) and the window's own tools:
`window_docs` and `window_replays` read, `window_put_run` uploads a local results run (index, ladder, replays; only
what the window lacks, and it reports how many replays the window has), `window_put_doc` one JSON document (a local
.json file or inline) and `window_put_dir` a folder of them. Uploads need the project token (in cloud sessions the
proxy adds it; elsewhere `--token`), and a competitor's server (ARENA_COMPETITOR) gets the reads only.

### Each person's own app: `/mcp` with GitHub sign-in (oauth.js)

`https://swu-arena.fly.dev/mcp` is a remote MCP server (Streamable HTTP, JSON answers, no sessions) for each invited
person's own app. On claude.ai: Settings, Connectors, Add custom connector, paste the address. In Claude Code:
`claude mcp add --transport http swu-arena https://swu-arena.fly.dev/mcp`, then `/mcp`. The app finds the sign-in
on its own: `/mcp` answers 401 with `WWW-Authenticate: Bearer resource_metadata=...`, which points to
`/.well-known/oauth-protected-resource` and from there to `/.well-known/oauth-authorization-server`. The app registers
itself (`POST /oauth/register`, public clients, no secret), opens `/oauth/authorize` in a browser, where the person
signs in with GitHub and presses Allow, and trades the code and its PKCE verifier (S256 only) at `/oauth/token` for an
access token (1 hour) and a refresh token (30 days from its last use; each use gives a new one, and an old one used
again ends the grant). `/oauth/revoke` ends a grant.

What an app may do: read, as its person, with role friend (an admin's app is no admin) and via `oauth`, and submit
that person's bots; nothing else it does writes. Removing the person's invite cuts their apps off on the next call.
Its tools: `whoami`, the arena reads (`arena_status`, `arena_standings`, `arena_report`, `arena_games`,
`arena_versions`, `arena_panel`), `window_docs` (the friends' collections: arena, runs, evals, lens, meta; scrubbed),
`window_replays` and `window_replay` (a game in slices of up to 100 KB), and three for building a bot:

- `arena_guide`: how to write and submit a bot (`BUILD.md`), or the whole bot protocol (`spec/protocol.md`).
- `arena_submit {kind: js|python|wasm, note, files, base64?, entry?, name?}`: stores the bot in the `submissions`
  collection as `<login>.<time>`, state `pending`. The default `name` is the person's builder name (their login,
  lowercase, `_` for `-`); another name must start with it and `_`, and may not be the builder name of anyone else who
  can sign in (the intake checks the prefix again). Limits: about 3 MB of files, 3 waiting at once, 20 a day, and no
  competitor someone else owns. The window never runs it.
- `arena_my_submissions`: the person's own submissions, without their files. Each is pending, then checking, then
  accepted (the version) or rejected (the error lines). A check that fails on the arena's side (no result) puts it back
  to pending, files and all, and it is tried again after a few minutes, three times at most.

The arena's intake (`intake.js`, started by `launch.sh` next to the uplink) reads `submissions` with the project
token. It packs each bot into a WebAssembly bundle, enters it, and writes the outcome back. Each version records the
submission it came from, so a submission checked again (an intake that stopped, or a window that missed the result)
gets the version it already has. Only one intake runs per arena (`intake.pid` in its work folder). Friends never read the
collection raw. The project token does not open `/mcp`: pushing stays with `mcp.js` above. Tokens are kept
only as SHA-256 hashes, in `auth/oauth.json` on the volume. A person's connected apps are listed on the app's Build a
bot page (Arena, Build a bot), through `GET /api/apps`, and `POST /api/apps {"disconnect": "<id>"}` ends one (from
this site's own pages: Origin and JSON).

## Who may do what (auth.js)

- Friends sign in with GitHub. A login in `ARENA_ADMINS` (default ericfode) is an admin; one in `ARENA_INVITES` or the
  invite document is a friend; anyone else sees who to ask. Sessions last 14 days and survive deploys.
- A view link (`/v/<key>`, made on the Share page) lets in anyone holding it as a guest: role friend, no login, for 30
  days or until the link is removed.
- The project's threads send `Authorization: Bearer <ARENA_PUSH_TOKEN>` (role project). Cloud sessions started since
  2026-10-12 ~04:45 get it as the environment variable `ARENA_PUSH_TOKEN`, which `push.js` reads (after
  `SWU_WINDOW_TOKEN`); where the egress proxy adds it for swu-arena.fly.dev, no variable is needed. The arena's
  uplink (`ops/launch.sh`) does not pass it on: competitors run as the same user and could read it from `/proc`. Elsewhere set `SWU_WINDOW_TOKEN`.
- `ARENA_ADMIN_TOKEN` (a Fly secret only Eric holds) is role admin: the only bearer that may change the invite list.
- An MCP app's access token (`swua_...`, from `/oauth/token`) reads as its person with role friend, never more.

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
  whole file when it ends. `bot/karabast/feed.js` is a working feed that does all three. (`push.js run` is for
  the project's own runs: it also writes `ladders/<id>`, which a feed token may not.)
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
