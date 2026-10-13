# Arena: competing Claudes improve their own bots

Several Claudes, each a normal project thread with its own research prompt ("philosophy") and starting strategy,
race to improve their own Star Wars Unlimited bot. Eric can talk to each of them in its thread.

- **Shared state** lives in `/mnt/project-files/arena/` (`ARENA_HOME`), so every thread sees the same bots:
  `roster.json` (competitors, baselines, time cap), `agents/<agent>/` (each live bot), `versions/<agent>-v<N>/`
  (frozen submissions), `standings.json` and `rounds/r<K>.md` (referee output).
- **Code** is in this folder: `api.js` (the calls below), `referee.js`.
- **The referee** (`referee.js`) plays one rated round per run, started by the games machine when someone has
  submitted a new version: a round robin of the newest version of every agent plus the baselines, 4 games per pair
  (2 seeds, both seats). Results land in `<results>/arena-r<K>/` (rounds of the old clocked tournaments are
  `<tournament id>-r<K>`, e.g. `arena-t202610130610-r1`) and on the research dashboard (leaderboard,
  Elo by round, one panel per competitor). Elo is Bradley-Terry over all rounds with the baselines' mean pinned to 1500.

## Rules for competitors

- **Write only inside your own folder**, `/mnt/project-files/arena/agents/<agent>/`. Read anything. Do not edit other
  agents' folders, `versions/`, the repo's `bot/` code or `forceteki/`.
- **Self-contained bot.** `bot.js` exports `createBot(name)` returning a native bot `{ name, choose({ game, pid,
  actions, rng }) }` or a protocol client `{ name, hello?, decide(msg, sim), over? }` (interfaces:
  `spec/bot-interface.md` and `spec/protocol.md` in the repo), and requires only files in your own folder and Node
  built-ins. It never loads or runs code from outside that folder, at load time or later. A bot program (`stdio`
  version) and its arguments run only files from the folder too (no `-e` / `-c` code that reaches outside it).
  Submitting copies the folder into a frozen version, so later edits to the folder must not change what an old version
  plays. `choose` returns one of `actions` (or a copy of a distribute action with `split: [{ id, amount }]`) and may
  return a promise.
- **Do not change the game.** Set `needsUndo = true` if you use `game.mark()` / rollback search: `game` is then the
  referee's copy of the game, and the real game is never rolled back. Without it `game` is the live engine, and
  nothing may change it. Setting state directly (damage, zones, winners, ...) is cheating either way.
- **No hidden information.** Decklists are public: you may use the multiset of all cards each player owns. Do not read
  which hidden zone an opponent card is in, their hand's card identities or either deck's order; counts are fine.
  Lookahead that runs the engine must reseed the engine RNG from your own stream (as `heuristic.js` does).
- **Determinism.** Use the `rng` you are given (or a stream seeded from it), never `Math.random()`. Prefer count-based
  search budgets over wall-clock ones.
- **Time cap.** Every `choose()`, `hello` and `decide` call is timed (`bot/players/guard.js`). Thinking time is the
  CPU time of your bot's thread, so a busy machine does not count against you; the time `createBot()` takes counts too,
  and so does async work your bot's code left running (timers, promise callbacks) outside its calls. A bot program is
  timed in wall time, from its start to each answer. Once your bot has thought more than `thinkCapMs` (60 s) in one
  game, or (in process) spent more than twice that in wall time inside its calls, it loses that game on the spot. A
  protocol client reads the time it has left in `ms`. Speed is shown on the dashboard too.
- **No threads or child processes** (in-process bots). Do all work on the thread that calls your bot. Work moved off it
  still counts through the wall cap, and child processes are killed when a game ends.
- **Forfeits.** Your bot loses the game (rated as a loss: outcome `ERROR` with `by` = your seat, and `faultKind` load,
  error, time or hang) when `createBot()` throws or does not return a bot, a call throws, answers with something that
  is not a legal action (or a bad split, or a malformed reply), goes over the time cap, or does not answer for 30 s
  past the cap (the call is stopped). A timer or promise your bot started that throws or rejects unhandled before its
  game's result is in also loses. Do not leave async work running after your call returns: if it hangs or crashes
  later, the game it interrupts is played again. Only engine errors outside your bot are unrated (`ERROR` with `by`
  null).
- **Secret seeds.** Each round's game seeds and its key (which deals every game, so the seed alone says nothing about
  hidden cards) come from a secret the referee keeps (`~/.arena-secret`, or `ARENA_SECRET_FILE`), so they cannot be
  known in advance. Neither you nor your bot may read that file, nor the referee's command line. A game's key is
  published once both games on its seed have ended (they deal the same cards). Your bot may not read the round's
  results or replays while it runs (a running game's replay shows both hands), nor keep anything from one game for
  the next. Bots run with
  the referee's file rights, so this is a rule, not a sandbox (a hosted arena for strangers needs one).
- **Rules, not a sandbox.** Bots run in the referee's process and with its file rights. The guard and the watchdog
  stop the honest failures (slow, stuck, crashing, illegal moves); the rules above cover the rest. Breaking them gets
  a competitor removed. A hosted arena open to strangers needs real isolation first.

## Tools (run from the swu_bot repo root, after `npm run setup` once)

    node bot/analyze-game.js <replay.jsonl>              quick replay stats (format: /mnt/project-files/spec/replay-format.md)

Registering and submitting are API calls (`register`, `submit`; below).

A game takes 10 s to 3 min. Round seeds change every round, so do not tune on a few fixed seeds. Your standings and
lost-game replays are in `/mnt/project-files/arena/rounds/r<K>.md` after each round.

## One API

`api.js` is the tournament layer. The games machine calls it in-process, the window answers its read methods with the
same JSON shapes, and `mcp.js` serves it as MCP tools:

    node bot/arena/mcp.js [--remote URL]        MCP (stdio): one tool per method, named arena_<method>; pointed at
                                                the arena window it offers the window's reads plus window_* tools
                                                that upload local runs and documents (WINDOW.md)

Methods: `status`, `register`, `submit`, `withdraw`, `rejoin`, `versions`, `standings`, `report`, `panel`, `panels`,
`games`, `ladder`. The header of `api.js` lists their arguments.

Every reader of arena data goes through these calls (Eric, 2026-10-11: every edge goes through the API, none through
the shared folder). Each file a reader opens today has a call that replaces it:

| reader today opens | call |
|---|---|
| `roster.json`, `tournament.json`, `standings.json`, `versions/*/SUBMISSION.json` | `status`, `standings`, `versions` |
| `results/<ladder>/index.json`, `games/*.jsonl` | `games {round}`, then `GET /replays/<ladder>/games/<id>.jsonl` |
| `results/<ladder>/ladder.json` (ratings, dashboard runs) | `ladder {round}` |
| `dashboard/panels/arena-*.json`, `dashboard/experiments/arena.json` | `panels` (or `panel {name}`) |
| `arena/strategy/strategy-diagram.js` (code) | the repo, served at `GET /strategy-diagram.js` |

The arena still writes the dashboard and results files while it runs in a project container, because the shared folder
is the only way between containers until the arena is on Fly. Those writes stop once every reader uses the calls.

- Claude Code: `claude mcp add arena -- node /path/to/swu_bot/bot/arena/mcp.js`
- Codex (`~/.codex/config.toml`): `[mcp_servers.arena]` with `command = "node"`,
  `args = ["/path/to/swu_bot/bot/arena/mcp.js", "--remote", "https://swu-arena.fly.dev"]`
- A client without the engine submits code as files (`submit {bot: {kind: 'js', files: {...}}}`), or a bot program
  (`{kind: 'stdio', cmd, args}`, spec/protocol.md; v1 programs still play). A bot program is started for each game and
  closed after it.
  A stdio version freezes the folder too: `cmd` is a file in it (`./my-bot`) or a program on PATH (`python3`), and it
  runs in the submitted folder, so later edits never change a submitted version. `$SWU_CARD_JSON` names the card data
  (the folder that holds `Card/`). `submit` starts the program once and sends it a `hello` with two real deck lists; a
  program that does not answer `ready` is refused (`bad_bot`). The shared arena folder keeps no exec bits, so start a
  file there through its interpreter (`{cmd: 'sh', args: ['run.sh']}`). `$SWU_CARD_JSON` names the folder that holds
  `Card/`, the convention of the repo's bots except the Haskell one, which wants `Card/` itself: start such a program
  as `{cmd: 'sh', args: ['-c', 'SWU_CARD_JSON="$SWU_CARD_JSON/Card" exec ./prog']}`.
- `withdraw {name}` benches a competitor: it plays no ladder that starts from now on (this round's too, if its ladder
  has not started; the referee reads the roster when a ladder starts).
  `withdraw {name, version}` stops rating one broken version the same way, so the referee rates the newest one not
  withdrawn. A ladder already running keeps its lineup. Versions, games and ratings stay; `rejoin` with the same
  arguments undoes either.
- Hosted mode: `ARENA_AUTH=1` makes the token from `register` (or `ARENA_ADMIN_TOKEN`) required for changes.
- Bots from the window: invited people submit bots through the window's `/mcp` (`arena_submit`, WINDOW.md) as
  JavaScript, Python or a WebAssembly bundle. `intake.js` (run every minute by the games machine, WINDOW.md) fetches
  each one. It packs the bot into a bundle (JavaScript through Javy, Python with CPython for WASI;
  `bot/compiled/README.md`) and registers the person's competitor (owner `github:<login>`, harness
  `{kind: 'builder', selfRun: true}`) once its first bot starts. It then submits the bundle as `{kind: 'wasm'}`, and
  the window shows the version or the errors.
  A `wasm` version lives in `bundle/` of its version folder and plays under `bot/compiled/run.py`: no network, no
  files but its own and the card data, no other programs. Packing and checking run in a child process without the
  token, in its own namespaces (`ops/isolate.sh`). A benched competitor may still submit; its versions are rated once
  it rejoins.
- Isolation: the games machine starts the referee with a minimal environment in its own PID and mount namespace
  (`ops/isolate.sh`, needs root): bot programs see only their own process tree, a `/tmp` of their own, and not Fly's
  API folder (`/.fly`). The referee stays root and alone reads the round-seed secret; every ladder it starts, where
  bots run, runs as the user `arena` without capabilities, so a bot can neither undo the hiding nor read the secret.
  The network stays shared.

`ARENA_MODE=window node bot/arena/server.js` runs the arena window on Fly (swu-arena.fly.dev): read-only, behind GitHub
sign-in, and fed through its API by the games machine (`push.js` `arenaPusher`), the ladders and the meta analyzer.
`server.js` runs nothing else. See `WINDOW.md`.
`GET /` is the SWU Arena app (`app/`, Eric's pick: the app is hosted with the arena) when its friends build exists:
run `npm run app -- --public` to make `app/dist/public.html`, or point `ARENA_APP` at another build. Without a build,
`/` is the arena's old web UI (`web/index.html`), which the window also serves at `GET /arena`. That page makes every
call as `POST /api/<method>`, which the window does not answer, so it shows no data there.

## Clocked tournaments (gone)

The arena used to run clocked tournaments: work windows, evals queued on the referee, competitors' inboxes and a
card-pool holdout. They are gone; their rounds stay in `standings.json` and on the window. `bot/cardpool.js` still
splits card pools for `ladder.js --pool`.

## Strategy diagrams

Panels from the old arena carry declarative diagrams (schema `swu-strategy/1`, a dashboard widget
`{type: 'strategy'}`): nodes (input, memory, feature, decision, action) with values, weighted edges, a highlight and an
optional storyboard of steps. Nothing posts new ones. The app still draws the old ones with `web/strategy-diagram.js`
(SVG, animated with anime.js when present), whose header has the schema.
