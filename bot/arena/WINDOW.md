# The arena window (swu-arena on Fly)

The window is the arena and its research as the people who sign in see them, at https://swu-arena.fly.dev. Builders submit
bots here, the games machine (swu-arena-games, below) plays them and sends the results back, and the project's threads
send their ladders and research the same way. The window itself never runs a bot.

## One API, and every part talks to it

Eric's rule (2026-10-11): the links between the parts go through the API, never through the shared folder. So each
part sends its own data to the window, and anything that reads it (friends' browsers, the app, research threads)
asks the same API.

| Part | Sends | Through |
|---|---|---|
| Arena (games machine + api.js) | status, standings, roster (no tokens), round reports, versions, panels | the games machine, every 20 s, and the playing round's replays every 3 s (`push.js` `arenaPusher`; see "The games machine" below); never a game job, whose bots must not get the proxy |
| Ladders (`bot/ladder.js`) | each run's index and report, each game's replay as it is played | started by ladder.js itself when `SWU_WINDOW` is set; it outlives the ladder to send the run's last state. Cloud sessions set `SWU_WINDOW`, so their ladders show on the live window: unset it for a test run |
| Meta analyzer (holocron's `lab/meta/analyze.js`) | the Atlas model and the ratings | at the end of each run when `SWU_WINDOW` is set |
| Research lines and the dashboard | panels, experiments, evals, bot cards, league, lens, threads | `node bot/arena/push.js dir <collection> <folder>` |
| Browsers, the app | the invite list and the arena settings, from Eric's admin pages only | `GET /api/app`, `/api/me`, `/api/status`, `/api/replays/<run>/<game>`; `GET`, `POST /api/share` and `/api/arena-settings` (an admin) |

## The API

Reads (a signed-in friend, or the project token):

- `GET /api/app`: the app's model, built in the window by the app's own loaders, with builder and thread names removed.
  A game still marked running whose replay (or, with no replay, whose run's documents) sent nothing for 20 minutes
  shows as stopped, with no result (`outcome: "abandoned"` in the model; the stored document is unchanged), so a run
  that was killed or lost its pusher stops showing as live. A sender that comes back makes the game live again.
  `push.js` sends a running run's index again every 5 minutes, changed or not, so a long game with no replay stays live.
- `GET /api/status`, `standings`, `report?round=K`, `games?round=K`, `versions?name=X`, `panel?name=X`: the arena's own
  read methods, same shapes as `api.js`, answered from what the arena sent. Other methods answer 501.
- `GET /api/replays/<run>` lists a run's games (`?sizes=1` adds sizes); `GET /api/replays/<run>/<game>?from=<byte>`
  returns the replay from that byte, with its full size in `x-size`, so a viewer can follow a game being played.
- `GET /api/docs/<collection>[/<id>]`: raw documents. Friends may read `arena`, `runs`, `evals`, `lens` and `meta`;
  the rest reaches them only through `/api/app`.
- People are never named to readers. A run against people (a feed's run, or an id starting `karabast`) is stored as
  sent, and only the programs that write (bearer tokens from feed up) read it back that way. Everyone else (a
  sign-in, a view link's guest, an MCP app) reads a copy: the person's seat is `opponent` in the run document and
  `a person` in the replay's header and on each board. The copy holds whole lines only, so offsets into it stay valid
  while the game is played, and `?sizes=1` gives `size: null` for its games (`x-size` on each read gives the size).
- The one exception is Eric's: a feed may send each person's karabast.net name as `person` on a game row (below). The
  window keeps those names only in the `admin/people` document, `{names: {<game id>: name}}`, which needs the admin
  token or an admin's sign-in (the app has shown no games against people since 2026-10-14). The run
  document, replays, `/api/app`, MCP apps and the project token still read `opponent` and `a person`.

Writes need a bearer token (the project token, or the admin token); a session cookie never writes, whatever its role,
except an admin changing the invite list from the app's Share page (below):

- `PUT /api/docs/<collection>/<id>` with a JSON body; `DELETE` removes one. Collections: arena, runs, ladders, league,
  experiments, evals, panels, bots, threads, lens, meta, research, admin. The `admin` collection needs the admin token
  to read or write: the proxy adds the project token to every process in the project, bots included.
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
- `GET /api/arena-settings` gives Eric's arena settings, `{settings, updatedAt, by}`: `gamesPerPair` (even, 2 to 10)
  and `thinkCapSec` (10 to 600, each bot's thinking per game) for the arena, `workers` (games at once, 1 to 16) and
  `roundGapMin` (0 to 240, from one round's end to the next round's start) for the games machine. A setting left out
  is the machine's default (`server/README.md`, "The games machine"). `POST /api/arena-settings` with
  `{"set": {"<name>": <value> or null}}` changes some of them, null going back to the default; admins only, from the
  app's own pages as for `/api/share`. The games machine reads them every minute with its own token, which may only
  read.
- `GET /api/me` answers `{login, role, signin}` (plus `guest: true` for a view link's guest) for the app; the Share
  page shows the invite list, the block list and the view links to admins, and `GET /api/share` adds `signin` and the
  submission `limits`.

The app's model (`/api/app`, ~0.6 MB gzipped) carries an ETag, so a tab that has it gets a 304 with no body. Every
open tab asks for it every 15 seconds while it is shown (a hidden tab does not ask). The model is gzipped once per
build, rebuilt at most every 30 seconds, and a build that comes out the same keeps its ETag.

## Through MCP

`node bot/arena/mcp.js --remote https://swu-arena.fly.dev [--token T]` is the same API as MCP tools, for the project's
threads (or any MCP client) that load data the way a user would. It offers the arena reads the window answers
(`arena_status`, `arena_standings`, `arena_report`, `arena_games`, `arena_versions`, `arena_panel`) and the window's
own tools:
`window_docs` and `window_replays` read, `window_put_run` uploads a local results run (index, ladder, replays; only
what the window lacks, and it reports how many replays the window has), `window_put_doc` one JSON document (a local
.json file or inline) and `window_put_dir` a folder of them. Uploads need the project token (in cloud sessions the
proxy adds it; elsewhere `--token`). Its `arena_*` tools only read; builders submit bots through `/mcp` below.

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
  can sign in (the intake checks the prefix again; while anyone with GitHub may sign in, a name with a suffix is
  refused when it is the builder name of another account on github.com, which the window asks GitHub). Limits: about 3
  MB of files; per competitor 3 waiting at once and 20 a day; and no competitor someone else owns. Everyone but an
  admin also has at most 2 competitors (`ARENA_BOTS_PER_PERSON`) and 10 submissions a day over all of them
  (`ARENA_SUBMITS_PER_DAY`), and the arena takes at most 20 competitors from builders who are not admins
  (`ARENA_OUTSIDE_BOTS`), because a round plays every pair of bots and so grows with the square of their number. An
  admin has 60 submissions a day and any number of competitors. The window never runs it.
- `arena_my_submissions`: the person's own submissions, without their files. Each is pending, then checking, then
  accepted (the version) or rejected (the error lines). A check that fails on the arena's side (no result) puts it back
  to pending, files and all, and it is tried again after a few minutes, three times at most.

### An agent with no browser: a connect link (the device grant)

A program that cannot open a browser, such as a Claude builder running headless on someone's own computer, connects
with the OAuth device grant (RFC 8628), for one competitor name:

    node bot/arena/connect.js --name kim_b_sprite --label "Kim's laptop builder" --out ~/.swu-arena-token

`connect.js` asks `POST /oauth/device_authorization {name, label}` for a code, prints the link
(`/oauth/device?user_code=XXXX-XXXX`), and polls `/oauth/token` until the person opens it, signs in with GitHub,
checks the code and presses Allow. The token (`swuk_`, 90 days, no refresh) is saved to `--out` (mode 600), never
printed. It reads like the person's app and submits only as that competitor: `arena_submit` refuses any other
`name`, and `arena_my_submissions` lists only that competitor's submissions. The name is checked when the person
answers and again when the token is made, with the rules `arena_submit` uses. Connecting the same name again ends
the old token; the agent shows on the person's Build a bot page, where Disconnect ends it. Use it as a header:
`claude mcp add --transport http swu-arena https://swu-arena.fly.dev/mcp --header "Authorization: Bearer $(cat ~/.swu-arena-token)"`.

The arena's intake (`intake.js`, which the games machine runs every minute) reads `submissions` with a project
token. It packs each bot into a WebAssembly bundle, enters it, and writes the outcome back. Each version records the
submission it came from, so a submission checked again (an intake that stopped, or a window that missed the result)
gets the version it already has. Friends never read the collection raw. The project token does not open `/mcp`:
pushing stays with `mcp.js` above. Tokens are kept only as SHA-256 hashes, in `auth/oauth.json` on the volume. A
person's connected apps are listed on the app's Build a bot page (Arena, Build a bot), through `GET /api/apps`, and
`POST /api/apps {"disconnect": "<id>"}` ends one (from this site's own pages: Origin and JSON).

## Who may do what (auth.js)

- People sign in with GitHub. A login in `ARENA_ADMINS` (default ericfode) is an admin; one in `ARENA_INVITES` or the
  invite document is a friend. With `ARENA_SIGNIN=github` (set in `fly.toml` since 2026-10-16) anyone else with a
  GitHub account is a member: a member reads what a friend reads and submits their own bots, within the limits below,
  but only friends lend their browser to the swarm (its games are rated) and use the open tables while `ARENA_TABLES`
  is `invited`. With `ARENA_SIGNIN=invited` (the default) anyone else sees who to ask. Sessions last 14 days and
  survive deploys.
- A login in the block list (`admin/blocked`, `{"logins": [...]}`; the Share page's Block, or `POST /api/share
  {"block": "<login>"}` / `{"unblock": "<login>"}`) may not sign in, invited or not, nor play, send feedback or use its
  apps; an admin is never blocked. It takes effect on the next request. The person's bots stay in the arena until
  they are withdrawn.
- A view link (`/v/<key>`, made on the Share page) lets in anyone holding it as a guest: role friend, no login, for 30
  days or until the link is removed.
- A game's own page (`/g/<run>/<game>`; gamelinks.js) opens for anyone, with no sign-in: that game and nothing else of
  the arena (see "Game pages").
- The project's threads send `Authorization: Bearer <ARENA_PUSH_TOKEN>` (role project). Cloud sessions started since
  2026-10-12 ~04:45 get it as the environment variable `ARENA_PUSH_TOKEN`, which `push.js` reads (after
  `SWU_WINDOW_TOKEN`); where the egress proxy adds it for swu-arena.fly.dev, no variable is needed. Elsewhere set
  `SWU_WINDOW_TOKEN`.
- `ARENA_GAMES_TOKEN` is role project too: the games machine's own token (its secret `SWU_WINDOW_TOKEN`), so it can be
  replaced without touching the threads' token.
- `ARENA_ADMIN_TOKEN` (a Fly secret only Eric holds) is role admin: the only bearer that may change the invite list.
- An MCP app's access token (`swua_...`, from `/oauth/token`) reads as its person with role friend, never more.

## Outside machines (feeds)

A machine outside the project, such as the Karabast Sprite that streams c-clock's games against people, gets its own
token: the Fly secret `ARENA_FEED_TOKEN_<NAME>` (for example `ARENA_FEED_TOKEN_KARABAST`), stored on that machine and
never in a thread. `<NAME>` is letters and digits only, so one feed's names never start with another feed's name and a
hyphen. A feed token reads like a friend and writes only what carries its name, `<name>` or `<name>-<id>`:

- `PUT /api/docs/runs/karabast`: the game list with `"id": "karabast"`, in the tournament index shape (`TournamentIndex`,
  Holotable's src/data/types.ts), with game ids `karabast-<id>`. A game with `outcome: "running"` shows in the app's grid of
  running games; a finished one has `outcome` `"won"` (with `winnerSeat` `p1` or `p2`), `"draw"` or `"abandoned"`. The
  window keeps only the fields the app reads, each checked for its type: on the run `createdAt` (required), `bots` and
  `gamesPerPairing`; on each game `id` (distinct), `p1`, `p2`, `outcome`, `winnerSeat` (set from the outcome), `rounds`,
  `steps` and `error` (text). It drops every other field and refuses a document that does not fit with a 400. A game's
  `person` (the person's karabast.net name, up to 64 characters of plain text) goes to `admin/people` instead of the run;
  a name that does not fit is dropped, never the run. It stamps `"feed": "karabast"` on the run,
  and the app leaves every run a feed sent out of its pages, bot records and ratings.
- `POST /api/replays/karabast/karabast-<id>?at=<bytes>`: the replay's new lines while the game is played; `PUT` the
  whole file when it ends. `bot/karabast/feed.js` (in this repo's history, before the split) was a working feed that
  does all three. (`push.js run` is for the project's own runs: it also writes `ladders/<id>`, which a feed token may
  not.)
- `PUT /api/docs/lens/karabast-<id>`: the game's win-probability lens (swu-lens/1), under the game's id, which is how
  the viewer finds it.

## Card art for the isolated pages (art.js)

`GET /art/<SET>/<NNN>.png` (and `<NNN>-b.png`, a leader's deployed side) is the image of
`https://cdn.swu-db.com/images/cards/<SET>/<NNN>.png`, fetched by the window. The play page (`/tables`) points the
viewer kit's art here (`SWUViewer.setArtResolver`) because its isolation (`require-corp`) blocks images from a site that
does not allow it, and the CDN sends no CORP or CORS header. It answers anyone signed in with GitHub, a view link's
guest or a token. Browsers keep each image a year, and the window remembers for an hour that a card has no art (404).

The CDN's images are ~270 KB JPEGs of 1120x1560. After the first request for a card, the window makes it a WebP of at
most 1000 px on its long side (~70 KB, the same look at the largest size Holotable shows a card) with `cwebp` (the
Debian package `webp`, in the image), one at a time in the background, and keeps it in `<home>/art` (up to 150 MB,
oldest out first; none written when the volume has under 200 MB free) and in memory (48 MB, with the CDN images it
has not made smaller yet). A browser whose `Accept` names `image/webp` (Chrome, Firefox, Safari 16+) gets the WebP once
it is made and the CDN's image until then; others always get the CDN's image (`Vary: Accept`). Without `cwebp` every
image goes as the CDN has it.

## Files sent as they are (static.js)

The app (`/`, 2.7 MB), the viewer kit (`/kit.js`, `/tables/kit.js`: one file, 2.4 MB), the kit's
license list and `/strategy-diagram.js` are read and compressed once per version (gzip at once, brotli in the
background: the app is 622 KB that way, 785 KB gzipped), not for every request, and carry an `ETag` that names their
content, so a reload is a 304 with no body. Their `cache-control` stays `no-cache`: the URLs stay the same when a deploy
changes the file. Before 2026-10-16 each visit gzipped the app and the kit again (~75 ms of the window's one CPU each)
and sent them in full.

## The play page (tables.js)

`/tables` is the arena's one play page (Eric, 2026-10-16: "there should be just one play page"; the app's Play button
opens it, and `/play` and `/play?bot=<name>` send people here). People play each other or any arena bot on Holotable's
play screen (`bot/table/README.md`): the versus screen lists Eric's JEPA bot and the latest round's versions, and the
page downloads the rules engine at once and the bot the person looks at while they choose, with its progress. Every
game runs in a player's tab (`tables-worker.js` on the swarm's engine pack), so the window and the games machine play
nothing; the window puts people in touch, lists the bots, reads SWUDB decks and keeps the finished games, readable by
anyone signed in with GitHub (`spec/open-tables.md`).

- `ARENA_TABLES` says who may play other people and `ARENA_PLAY` who may play the bots, each `invited` (the default:
  signed in with GitHub and invited), `github` (anyone signed in with GitHub; their sign-in then returns to `/tables`
  though they cannot read the arena) or `off`. The page is for anyone either lets in; someone who may play only the bots
  gets the bot screen alone (`people: []`) and the lobby's routes refuse them. `ARENA_PLAY` only adds bots-only
  players: whoever may play people may also play the bots (the lobby plays one when nobody comes), so `ARENA_PLAY=off`
  means no bots-only players, not no bots. The logs page and reader tokens are for
  anyone signed in with GitHub whatever the modes. A view link's guest has no GitHub login, so the page asks them to
  sign in. The files come through the swarm relay, so the page needs `SWARM_HELPER_TOKEN` too.
- The page is cross-origin isolated (COOP same-origin, COEP `require-corp`, as the swarm's pages are, because Safari
  has no `credentialless`) since arena bots block on a SharedArrayBuffer stdin; card art comes through `/art/`
  (above). A browser that does not isolate the page shows the arena bots as unavailable and plays the JEPA bot.
- `GET /tables`, `/tables/kit.js` (its license list `/tables/swu-viewer-kit.licenses.txt` is open to anyone, like
  `/swu-viewer-kit.licenses.txt`), `/tables/<file>?b=<build>` (`engine.json`, `tables-worker.js`, `bot-worker.js`,
  the JEPA bot's `tx-t10.safetensors` and `tx-t10-e.safetensors`, `python-lib.json`, `python.wasm`: the games
  machine's files of that build, kept on the window's disk so they load while it sleeps; with none kept and the machine
  asleep, `/api/tables/info` answers `ready: false, waking: true` and wakes it at most every 15 minutes, and the page
  opens anyway: the loading bar under Play says "Waking the games machine · 0:23 of ~1:00", and a Play press starts
  the game once the files are here), and `/tables/logs`. Every file answer has
  `x-raw-length`, the unzipped size, which is what a page reading the body counts. A URL with `?b=` names its build,
  so browsers keep the file a year; it goes brotli to a browser that takes it (made once, in the background, next to
  the gzip on the window's disk: the engine pack is 1.0 MB that way, 1.5 MB gzipped), else gzipped.
- `GET /tables/bot/<sha256>.tar`: an arena version's canonical tar, only for a version of the latest round. The swarm
  relay (`lineup()`, `sendBot()`) gets the lineup (`GET /v1/swarm/lineup.json`) and each of its bundles
  (`GET /v1/swarm/bot/<sha256>`) from the games machine as soon as it learns the lineup, checks each sha256 and keeps
  the tars with their gzips and brotlis in `<home>/swarm-bots` (the latest round's only), so they load while the
  machine sleeps. Browsers keep a bundle a year (its URL names it). 503 while the machine is asleep and the
  window does not have it yet (it is woken, at most every 15 minutes).
- `GET /api/tables/info`: the files (`pack`, `worker`, `botWorker`, each `{url, bytes, wire}`), `runtimes` (the files
  of each interpreter a bundle may need, `python-3.14-wasi`: `{lib, wasm}`), the deck lists, the person's random id
  (`pl_` and 6 hex, `admin/tables-ids`), their games, `people` (the ways to pair, empty for bots only), the lineup's
  `round`, and the bots. The JEPA bot comes first (`kind: 'jepa'`, `files: [{url, path, bytes, wire}]`, its models:
  the page sends `[[path, bytes]]` to the worker with its first game), then the latest round's versions by arena rating
  (`kind: 'arena'`, the arena's title, owner, rating and note, `runtime`, `capMs`, `bundle: {url, hex, bytes, wire}`).
  `runtime` is what the bundle's `arena.json` names once the window has the bundle, else what the submission's files
  say; `capMs` is that round's time per bot per game, which the tab plays the version under. `bytes` and `wire` (about
  what a file downloads, gzipped) are null when the window does not know a size yet.
- `POST /api/tables/deck {text}`: a SWUDB link (read from SWUDB's deck API on the window, `swudb.js`) or a pasted deck
  list, as the arena's deck form; the host's worker checks it against the card data.
- The lobby (`lobby.js`, rooms in memory): `POST /api/tables/invite` (a room and a 6-letter code), `POST
  /api/tables/join {code}`, `POST /api/tables/queue` (the two who waited longest are paired; the one who waited longer
  hosts), `GET /api/tables/stream` (server-sent events, resumed with Last-Event-ID), `POST /api/tables/send {msg}` and
  `POST /api/tables/leave`. The tabs send the WebRTC handshake through it, then the game itself when they cannot link
  directly. At most 256 KB a message and 8 MB waiting for one side; a room goes after 30 minutes unread or 12 hours.
- `POST /api/tables/games {replay, seat}`: each tab sends the finished game; the same replay is kept once (run
  `tables`, a people run, unrated) and each sender adds who played their seat to `admin/tables-people`. At most 80
  games a day per person. `GET /api/tables/games` and `/api/tables/games/<id>.jsonl` give a person their own games (an
  admin every game, with who played it). `POST /api/tables/me {renew: true}` gives a new random id.
- `POST /api/tables/token` (from the logs page) makes a reader token; `/api/open/*` reads the kept games with it
  (`spec/open-tables.md`).
- The old play page's games (run `play`, until 2026-10-16) stay in the store as they were; the play page lists only its
  own.

## Feedback (feedback.js)

Every page the window sends has a feedback button and the ` key (Backquote), so people can say what went wrong or what
would be better, right where they saw it (Eric, 2026-10-16). The window adds `<script src="/feedback.js" defer>` to
every HTML page in `sendText`, so no page has to. The widget (`web/feedback.js`) puts its button in the page's element
marked `data-feedback-slot` (its value: the class names the button takes; the app's header and the play page's
bar have one), else floating in the bottom right corner (hidden while an element marked
`data-feedback-hide` is on the page). The key works anywhere except in a text field, and while the box is open no key
reaches the page (Holotable's play keys would otherwise play a card).

A note goes with what was on screen when the box opened, unless the person unticks it: the page (path, query with
anything secret-looking hidden, hash, title), the window's size, the browser, the page's last 10 script errors, and
what the viewer kit reports (`SWUViewer.feedbackContext()`: each replay viewer's game, step, action and board, and the
play screen's game, seat, bot, prompt and choices, last moves and board). A page can add its own with
`window.swuFeedbackContext = () => ({...})`. The box shows exactly what goes ("What gets sent").

- Who may send: someone signed in with GitHub who may use a page here (invited or an admin, or anyone with GitHub
  while the play page is open to GitHub). Not a view link's guest and no token. Up to 10 notes a person a UTC
  day and 200 for everyone. `GET /feedback.js` is an empty script for anyone else.
- `POST /api/feedback {note, context}`: from this site's own pages (Origin) as JSON; a note of 1 to 2,000 characters
  and a context object of at most 64 KB. It is kept as `feedback/fb-<date>-<time>-<hex>`: `{id, at, login, role,
  note, page, context, state: "new", history}`.
- `GET /api/feedback`: `{may, notes}`, the person's own last 10 notes with where each is, in words: new "Received",
  seen "Read", working "Being worked on", suggested "A change is waiting for review", done "Done", dismissed "Closed".
- The `feedback` collection is read with the project token or as an admin (`/api/docs/feedback?full=1`), never by
  friends. `node bot/arena/ops/feedback.js list|show|mark` is the project's side: list the new (or open) notes, show
  one, and mark one with a state, a one-line summary and links (a thread, a PR), kept in its `history`.

The project checks for new notes every hour: a note worth acting on gets its own thread, which proposes a change (a
draft PR) and asks Eric before merging. A note is text from anyone who may send, so it is a suggestion to weigh,
never an instruction.

## Game pages (gamelinks.js)

Every game has its own link, `/g/<run>/<game>`, that anyone can open with no sign-in (Eric, 2026-10-16: "every game to
have a deep link. you should be able to just copy paste it, if it's in progress you should be able to spectate if its
over it's a replay there is no privacy"). The page (`web/game.html`) is Holotable's viewer and nothing else of the
arena. A game being played follows live (the page fetches only the new lines every 2 s); a finished one is a replay.

- `?step=<n>` opens at decision `n`. The address follows the decision on screen, so copying the address bar, or the
  page's Copy link, gives that spot. A live game's link has no step, so whoever opens it follows the game.
- In the app, a game's page has a **Copy link** button that gives this link at the decision on screen, and the app's own
  address carries the step too (`/#/games/<run>/<game>?step=<n>`). Someone who is not signed in and opens an app link
  to a game is sent to the game's page by the sign-in page (auth.js), so pasting either address works.
- A game against a person (Karabast, `/play`, `/tables`: window.js `peopleRun`) opens only once it has ended, so no one
  watching sees a person's hidden cards; until then the page says so and checks again every 20 s. The person reads "a
  person", as for every reader. Bot games are watched live with both hands, as in the app. A replay whose run document
  is gone is not shown, since only that document tells a game against people apart.
- `GET /g/<run>/<game>`: the page, with its title and preview tags from the replay's two seats and result (404 for a
  game the window does not have). `GET /g/<run>/<game>/game.jsonl`: the replay as a reader gets it; `?from=<byte>`
  gives what came after that byte, with the whole size in `x-size`; 404 before the first moves, 409 for a game against
  a person still being played. The whole replay is gzipped once per version of it; a part after `?from` is gzipped
  only up to 256 KB and sent as it is above that, so no request makes the window compress most of a replay again. `GET /g/kit.js`: the viewer kit, with an ETag so a browser keeps it. Anyone; GET only.

## Deploys

Code reaches Fly only through GitHub: `.github/workflows/deploy-arena.yml` runs the window's tests (pull requests
that touch the image run them too), then on main `flyctl deploy --remote-only` builds the `Dockerfile` on Fly's
builders and updates the one machine (`fly.toml`).
Data lives on the volume `arena_data` at `/data/window` (documents, and replays gzipped: about 30 MB for every
replay recorded so far).

One-time setup (Eric): the network secret and allowed domain for swu-arena.fly.dev with the same value set as the Fly
secret `ARENA_PUSH_TOKEN`; a GitHub OAuth App with callback `https://swu-arena.fly.dev/auth/github/callback`, its
client ID and secret as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`; an `ARENA_ADMIN_TOKEN` Fly secret, if invites
should change without a deploy; and a deploy token as the repository secret `FLY_API_TOKEN` (until it is set, merges
run the tests and deploy nothing). Threads send data when `SWU_WINDOW=https://swu-arena.fly.dev` is set in their environment.

## The games machine (swu-arena-games)

The window stores submissions; the games machine plays them. It is the Fly app `swu-arena-games` (`fly.games.toml`,
`Dockerfile.games`), one machine with 2 dedicated CPUs and a 3 GB volume, running the arena server's games role
(`server/src/main-games.ts`, [server/README.md](../../server/README.md)), which plays the rounds and calls
`node bot/arena/gamesctl.js` for the Node work:

```
 window ──POST /wake──▶ server ──gamesctl intake──▶ versions/ ──gamesctl round──▶ round ──▶ play-seed (bots as arena)
   ▲      (flycast)       │
   └── submissions, standings, round replays: gamesctl push through the server's loopback proxy (its token) ──┘
```

- It has a private address only (flycast). The window calls `http://swu-arena-games.flycast/wake` (`ARENA_GAMES_WAKE`)
  on every submission and every 6 hours; Fly's proxy starts the stopped machine for that request.
- Every minute it runs the intake, then starts a round when the lineup changed (90 s after the last version came in,
  so a quick fix joins the same round) or the last round is a day old. Rounds are round robins of every competitor's
  newest version and the residents (the arena's own bots: heuristic, rush, c-clock, rust-greedy2, rust-search,
  node-search and py-clock), 2 games a pair. Residents are entries made by house submissions (README.md, "The games
  machine"); the image builds no bot of its own.
- A submission written straight to the `submissions` collection with the project token (`ops/house-submit.js`, the
  arena's own bots) wakes the machine like arena_submit's, when it is new and pending.
- It pushes the arena's state and the round replays to the window every 20 s, like the old uplink, into the same
  `arena`, `runs` and `ladders` collections the app reads; while a round plays, that round's index and replays also
  go every 3 s, and the app's Live board follows a game that is playing.
- With nothing to do for 10 minutes (`GAMES_IDLE_MIN`) it exits, and the machine stays stopped until the next wake-up.
  A round runs at most 6 hours (`GAMES_ROUND_HOURS`).
- Only the server holds the window token; its Node children reach the window through a loopback proxy with a nonce.
  Every child gets an environment built from nothing; the game jobs and the intake's checker run as the user arena in
  their own namespaces, with `/.fly`, the server's folder and the round-seed secret hidden (`ops/isolate.sh`).
- Helpers: a computer of Eric's can play some of a round's seeds through `fly proxy` ([HELPER.md](HELPER.md)). The
  machine listens on `GAMES_HELPER_PORT`; helpers stay off until the `GAMES_HELPER_TOKENS` secret names one.

Deploys: `.github/workflows/deploy-games.yml` on every merge that touches `bot/`, `server/`, the engine pin or the
image, with the repository secret `FLY_GAMES_TOKEN` (`fly tokens create deploy -a swu-arena-games`). It checks out
forceteki with `FORCETEKI_TOKEN` when that secret exists. Locally, the server's games role plays against a local window
(server/README.md, "The games machine").

## Run it locally

    ARENA_MODE=window WINDOW_HOME=/tmp/window ARENA_PUSH_TOKEN=t ARENA_PUBLIC_URL=http://localhost:8080 \
      node bot/arena/server.js --host 127.0.0.1 --port 8080
    SWU_WINDOW=http://localhost:8080 SWU_WINDOW_TOKEN=t node bot/arena/push.js run /mnt/project-files/results/<run>

Build the page first with `npm run app -- --public --shell` (the viewer kit is prebuilt in `vendor/holotable`).
