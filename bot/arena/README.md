# Arena: the hosted bot arena

Invited people (builders) write Star Wars Unlimited bots on their own computers and submit them to the arena window.
The games machine packs each bot into a WebAssembly bundle, rates it in rounds against the other builders' bots and
the project's own bots, and sends the results back to the window, where friends watch them. Both run on Fly.

```
builder ──/mcp arena_submit──▶ window (swu-arena) ──POST /wake──▶ games machine (swu-arena-games)
                                 ▲                                  intake ─▶ versions ─▶ round ─▶ play-seed
                                 └──── status, standings, panels, round replays (push.js) ───┘
```

## The window (swu-arena)

`ARENA_MODE=window node bot/arena/server.js` (`Dockerfile`, `fly.toml`) serves https://swu-arena.fly.dev: the arena
and the research for anyone signed in with GitHub. It stores the documents and replays the other parts send
it, and it never runs a bot. `WINDOW.md` describes its API, sign-in and deploys.

- `window.js`: the HTTP API and the document store. `server.js` starts it.
- `auth.js`: who may do what (members, friends, the block list, view links, the project's token, the games
  machine's token, feeds).
- `oauth.js`, `mcp-http.js`: `/mcp`, the remote MCP server each person's app signs in to with GitHub. Builders submit
  bots there (`arena_submit`) and read their results.
- `connect.js`: the device grant for an agent with no browser, such as a builder's Claude Code on their own computer.
- `BUILD.md`: how to write, test (`npm run dev`) and submit a bot. `/mcp` serves it as `arena_guide`.
- `push.js`: the client every part of the project uses to send its data to the window.
- `feedback.js`, `web/feedback.js`, `ops/feedback.js`: the feedback button and ` key on every page, the notes it
  keeps, and the project's side that reads them and marks where each one is (`WINDOW.md`, "Feedback").
- `gamelinks.js`, `web/game.html`: every game's own page, `/g/<run>/<game>`, live while it is played and a replay after,
  for anyone with no sign-in (`WINDOW.md`, "Game pages").

`GET /` is the SWU Arena app (`app/`) when its friends build exists: run `npm run app -- --public` to make
`app/dist/public.html`, or point `ARENA_APP` at another build. Without a build, `/` is the arena's old web page
(`web/index.html`), which the window also serves at `GET /arena`. That page makes every call as `POST /api/<method>`,
which the window does not answer, so it shows no data there.

## The games machine (swu-arena-games)

One Fly machine (`fly.games.toml`, `Dockerfile.games`) with a private address only. The window wakes it with
`POST /wake` on every submission and every 6 hours. With nothing to do for 10 minutes it stops until the next wake.
The arena server's games role runs it (`server/src/main-games.ts`, `server/README.md`): it keeps the window token in
its own process, plays the rounds, and runs `node bot/arena/gamesctl.js <command>` for the Node steps (setup, warm,
plan, round, publish, decks, intake, push). Each cycle has three parts:

1. The intake, every minute and right after a wake (`intake.js` `intakeOnce`). It reads the window's pending
   submissions and packs each bot into a bundle (JavaScript through Javy, Python with CPython for WASI, a ready
   bundle as it is; `bot/compiled/README.md`) and starts it once in the sandbox. Then root registers the builder's
   competitor the first time (owner `github:<login>`) and enters the bundle as its next version (`api.js` `submit`,
   kind `wasm`). The window gets the version or the error lines back.
2. A round, when the lineup changed (90 s after the last version came in, so a quick fix joins the same round) or
   the last round is a day old. `gamesctl round` gives its rules, lineup, deck lists and each version's bundle as a
   tar; the server plays each seed's games as one `play-seed.js` job, some at once on the machine and some on
   helpers ([HELPER.md](HELPER.md)), writes the round's files and has `gamesctl publish` write the standings.
3. The push (`push.js` `arenaPusher`), every 20 s: status, standings, roster (without tokens), round reports,
   versions and panels, and the replays of the newest two rounds, into the window's `arena`, `panels`, `experiments`,
   `runs` and `ladders` collections. While a round plays, the playing round's index and replays also go every 3 s
   (`gamesctl push --only round`), so a viewer follows each game move by move.

A round is a round robin (dealt as `bot/ladder.js` deals one) of every competitor's newest version and the
residents, 2 games per pair (one seed, both seats). Since 2026-10-15 its games deal the tournament deck lists
(`bot/decks/ash-meta-2026-09.json`, less `lando-calrissian_law_blue`, which an engine bug breaks: `referee.js`
ROUND_DECKS) by seat: seed s plays deck pair s mod P, and each deck stays with its seat, so in the two games of a seed
each bot plays both decks on the same shuffles (`decklists.js`). Helpers and the browser swarm get the seed's two
lists with its job. The residents are the arena's own bots: heuristic, rush, c-clock, rust-greedy2, rust-search,
node-search and py-clock. Ratings are Bradley-Terry with the residents' mean pinned to 1500: per round, the residents
that played it; over all rounds, the bots built into the image that ever played, so a resident's new version does not
move the scale and versions compare across rounds. A round cut short by a stop (a deploy) resumes at the next start
and keeps the games already played.

The residents are entries submitted like any builder's bot; the image builds no bot of its own:

- **Entries.** A house submission (`ops/house-submit.js <name> <folder> --note "..."`) writes a submission with owner
  `@arena` straight to the window, with the project token; no GitHub login can be that owner, so arena_submit cannot
  make one. The intake enters it as a resident entry (`resident: true`, owner `arena`, no starter version, first
  version v1); a later house submission under the same name is its next version. A resident may take the name of a
  built-in bot, never a builder's or a bot program's. Residents are rated with everyone, never lead a round, have no
  panel, and show as baselines in the app and in `status`.
- **Before.** Until 2026-10-14 the residents were built into the image as the roster's baselines (`heuristic`, `rush`,
  `c-clock-wasm`, `rust-greedy2-wasm`, `rust-search-wasm`, `node-search-wasm`, `py-clock-wasm`). The all-round ratings
  keep those built-in bots as their anchors, so old ratings stay put. The roster's `baselines` is now empty:
  `gamesctl.js setup` empties it at every start. (A local arena may still name baselines: `referee.js` `lineup`
  plays each until a resident entry with a version replaces it, `residentName`: `c_clock` replaces `c-clock-wasm`.)
  Each round records its anchors (`anchors` in `standings.json`).
- **A new volume.** The residents live on the games machine's volume like every entry. A new or replaced volume
  has none until the house submissions run again (`ops/house-submit.js`, once per resident); until then a builder
  alone plays no round (`gamesctl.js` plan says `no-opponent`).
- **Card data (2026-10-16).** Bots get the card data only in `hello.cards`; the sandbox mounts no `/cards`. The
  resident versions of c-clock, py-clock, rust-greedy2 and rust-search entered before then were built to read
  `/cards`: they still run, but play without card data (other moves, no error) until a version that reads
  `hello.cards` is house submitted. A bundle whose `arena.json` still has `"cards": {"use": "mount"}` is refused, so
  build them from a holocron whose bots read `hello.cards` and whose bundles have no `cards` key, and submit them
  right after the deploy that brings this change.
- The ports of heuristic and rush to the bot protocol live in Holocron (`ericfode/holocron`, `bots/ports/`); the
  other five are the bundles `bot/compiled/build.py` makes.

Isolation: submitted code runs only in the wasmtime sandbox (`bot/compiled/run.py`): no network, no files but its own
(the card data comes in `hello.cards`), no other programs. Packing and checking a submission run in a child process
without the token, in its own PID and mount namespace (`ops/isolate.sh`), as the user `arena`, with the arena's folders
hidden: it leaves a canonical tar in its job folder, and root unpacks and enters it without running it. `arena/` and
`dash/` are root's and cleaned on every start (`ops/own-tree.py`). The server alone reads the round-seed secret. Each
game job (`play-seed.js`), where bot code runs, runs the same way: as `arena` with no capabilities, with a minimal
environment and the server's folder, the secret and `/.fly` hidden. The network is shared.

Its data is on the volume (`GAMES_DATA`, `/data`): `arena/` (`ARENA_HOME`: `roster.json`, `versions/<name>-v<N>/`,
`standings.json`, `rounds/r<K>.md`, `panels/`), `results/arena-r<K>/` (each round's ladder and replays), `bundles/`
(each version's bundle as a tar), `intake/`, `wasm-cache/` (compiled code: root compiles, games read), `home/` (the
bots' HOME: empty, root's), `dash/`, and `secret/` and
`server/` (root's only); `server/README.md` has the whole layout. Without `ARENA_HOME`, `home.js` uses
`/mnt/project-files/arena` when that folder exists (the old arena's data, which the project build of the app still
reads), else `arena-home/` in the repo.

The code, besides `gamesctl.js` and `intake.js`:

- `play-seed.js`: plays one seed's games (a job: bots, decks, seed, key, limits) and answers their results and
  replays; the only way the games machine and its helpers play a game. The dev harness (`bot/dev.js`,
  `npm run dev -- <bot folder> --owner <login>`) plays a builder's games with it too, after arena_submit's rules and
  the same check as the intake (`intake.js --check`), so a bot behaves there as it will in a round. Started by the
  harness (`SWU_DEV_PARENT`), it stops its process group once the harness is gone.
- `referee.js`: a round's rules, lineup and deck lists (`gamesctl round`) and its standings, `rounds/r<K>.md` and
  panels (`gamesctl publish`). Run by hand, it still plays a whole round through `bot/ladder.js` (local rehearsals).
- `api.js`: competitors, versions and results (below).
- `registry.js`: resolves `<name>-v<N>` to its version folder for `bot/players/index.js`. A `wasm` version runs from
  its `bundle/` folder under `bot/compiled/run.py`.
- `home.js`: where the arena's files are, and the helpers that read and write them.
- `dash.js`: the competitor panels, the leaderboard and the experiment (Elo over rounds) that the window shows.
- `starters/`: the bots `api.js` `register` copies into a new competitor (its v0; a builder's own bot is v1).

Deploys, secrets and a local run of the games machine: `WINDOW.md` ("The games machine") and `server/README.md`.

## Rules for bots

`BUILD.md` ("Rules of the sandbox") has the limits for submitted bots: time per call, memory, no network, no files,
only their own code. Every bot, the residents included, also plays under these rules:

- **Time cap.** Each bot may think 60 s per game (`roster.json` `thinkCapMs`; the hosted arena sets its own). A bot
  program, which every submitted bot is (the residents included), is timed in wall time from its start to each
  answer. An in-process bot (a local arena's baseline) is timed in CPU time, with twice the cap in wall time as a
  second limit (`bot/players/guard.js`).
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
  cards) come from the round-seed secret, which only the games machine's server reads. A game's key is published once
  every game dealt from it has ended.

## One API

`api.js` is the arena's data layer. The games machine calls it in-process: the intake (as root) registers and
submits, and `push.js` reads what it sends. Methods: `status`, `register`, `submit`, `withdraw`, `rejoin`, `versions`,
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
