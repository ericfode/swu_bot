# Karabast client

Talks to a Karabast game server (the forceteki `server/gamenode` that runs karabast.net) the way its web client does,
without a browser. Plain CommonJS on Node 22's built-in `WebSocket` and `fetch`, no dependencies.

| file | what it does |
|---|---|
| `socket.js` | Socket.IO v4 client on path `/ws`, plus the HTTP calls (create, join and spectate a lobby, enter the queue). Refuses any host but localhost unless the caller names it. |
| `frame.js` | Reads `gamestate` frames: legal actions for a seat (same kinds as `bot/env.js` legalActions), the `game` message for an action, and the privacy scrub. |
| `observe.js` | A frame as a protocol bot sees it: the `decide` message's prompt, state and actions (spec/protocol.md). |
| `seat.js` | One protocol bot playing one seat, with the undo rules and the command allow-list below. |
| `queue.js` | Quick match as a bot: enter the queue with a deck, play the match, leave; with `--games N`, a loop that queues again after each game. Counts people (`ledger.js`) and writes what it is doing to `status.json`. |
| `spectate.js` | Watches games as a spectator and writes scrubbed frames as JSON Lines, which `importer/import.js` turns into replays. `--predict <evaluator>` prints P(win) as the game goes. |
| `live-view.js` | Serves recorded games to the Holotable viewer kit while they are played: a game picker, the board following each move, and an evaluator's chance that p1 wins. |
| `feed.js` | Streams our bot's games against people to the arena window (`runs/karabast`, replays, lens), with our hand face-down while a game is live. |
| `watchdog.js` | Keeps a `queue.js` loop going: restarts it when it is stuck or died, and raises an alert past its restart budget. |
| `ledger.js` | The people cap: counts each real person a run touches (salted hashes, no ids) and stops at the limit. |
| `selfplay.js` | Two protocol bots on a local server, through `seat.js`: the end-to-end test. `--pester-undo` makes seat 2 ask for undos. |
| `fidelity.js` | Checks `observe.js` against the referee: the same engine state, seen through a Karabast frame and through `bot/view.js`. |

## Try it on a local copy

Build and start forceteki's server in development mode (anonymous players and spectators, no database):

```bash
cd <forceteki checkout> && npm ci && npm run get-cards && npm run dev     # serves http://localhost:9500
```

Then, from this repo (card data from the same checkout; `make -C bot/c` for c-clock):

```bash
export SWU_CARD_JSON=<forceteki checkout>/test/json
node bot/karabast/selfplay.js --bots c-clock,js-random --games 4 --pester-undo 0.5     # public lobbies: timer and undo requests on
node bot/karabast/selfplay.js --bots c-clock,c-clock --decks bot/decks/ash-meta-2026-09.json
node bot/karabast/spectate.js --public --games 1 --gap 1 --out captures --predict mlp-g5   # while a game runs
node importer/import.js captures --out replays/karabast-local --source karabast-spectate
node bot/karabast/queue.js --bot c-clock --deck admiral-piett_jtl_blue --out runs/q     # needs a second player in the queue
node bot/karabast/queue.js --bot c-clock --deck admiral-piett_jtl_blue --games 50 --gap 25 --out runs/q   # a loop
node bot/karabast/fidelity.js --games 20                                               # needs forceteki/build
```

## How a bot plays a seat (`seat.js`)

- Every protocol program in `bot/external-bots.json` can play (c-clock, rust-greedy2, ...), and `js-random`. The bot is
  seat `p1`. It never gets simulations (`sim: false`): Karabast keeps the deck order and the other hand.
- `hello` carries our deck list. For the opponent it carries only the leader and base the table shows, with an empty
  deck, since a Karabast opponent's list is not known.
- The seat sends only prompt answers (`cardClicked`, `menuButton`, `perCardMenuButton`, `statefulPromptResults`), plus
  `concede` and one chat line. It refuses `rollbackToSnapshot` (undo), timer resets and settings.
- Undo prompts never reach the bot. In public games the opponent must approve each undo (Karabast's "undo with
  confirmation"). The seat allows 2 requests per game and denies the rest, and never picks "Deny and Block Requests".
  When a cost can no longer be paid it picks Abandon, then a free Undo, and asks for an undo only when nothing else is
  offered. Any other button with "undo" in its label is hidden from the bot.
- A bot that fails (error, bad answer, no answer before the prompt timer) gets a random legal action played for it and
  is restarted. After 2 failures in a game the seat concedes, so a human is never left waiting on a dead bot's clock.
- The server ignores an answer it cannot take (a third card in "select 2"). After 1 s with no change the seat asks the
  bot again without that action. Each ignored answer is an error in the server's log, so after 4 in a row at one
  decision (a game the server can no longer move) the seat concedes.
- Two players with the same name break a game: the engine finds a player's opponent by name
  (`Game.getOtherPlayer`), and the first frame fails to serialize. Give each local bot run its own `--username`.

## Watch a game as it is played (`live-view.js`)

```bash
node bot/karabast/live-view.js --runs <folder holding spectate/queue --out folders> --kit /mnt/project-files/viewer-kit --predict mlp-g5
```

Open http://localhost:8080. The page lists every recorded game, newest first, and follows the newest live one unless you
pick another. Each frame file is turned into a replay by the importer whenever it grows. A game with no winner whose
file changed in the last 5 minutes is served without its `end` line, so the kit re-fetches it every second and follows
each move. `--predict` adds the evaluator's P(p1 wins) from the public board (no hands) as a score on the timeline.
Use the shared kit build (`/mnt/project-files/viewer-kit`, 2026-10-11 evening or later): an older kit, such as one
built from `studio/` on main before the Holotable branch lands, shows the board without card text or the win chance.
The server reads only the frame files, the runs' `games.jsonl` and `status.json`, and the two kit files. It listens on
127.0.0.1 unless `--host` says otherwise; any other host requires `--key <secret>`, which puts every route under `/<secret>/` (a live bot game shows our bot's hand).

In a bot game (`<run>/frames/`) the frames are our seat's view, so that seat is named after the bot ("c-clock (ours)")
and the other one "opponent", and the picker says whether our bot won. A watched game is two people and says so.
The page polls every 2 s, so a game shows up a few seconds after its first board, and shows the newest queue run's
state from its `status.json`: in the queue since when, playing, between games, or stopped and why. When the bot starts
a game the page isn't showing, a button opens it.

## Play games back to back (`queue.js --games N`)

With `--games` above 1, `queue.js` queues again `--gap` seconds after each game (at least 25: a finished lobby keeps
its users ~20 s). A wait with no match queues again without using up a game, and `--max-waits` of them in a row
(default 6) stop the run. Any other failure, a game cut off with no result included, counts as a game and toward
`--max-errors` failures in a row (default 3). It also stops on the people cap, a ledger error or the stop
file, and exits 1 when it ended on a failure. `<out>/status.json` is rewritten whole every 30 s and at each change
(`state`: starting, queued, playing with `file`, between games, stopped with `reason`; plus `played`, `won`, `lost`,
`errors`), so a reader tells a dead run from one waiting in the queue.

A seat gives up on a game that does not start within 3 minutes of the match (no result, so it counts as a failure)
and concedes a started game that sends no frame for 10 minutes (seat options `startMs`, `idleMs`). Before these, a
match whose game never started held the loop in the queue for good (2026-10-11, 20:56).

`watchdog.js` checks the loop once a minute: a `queue.js` process must be running and the newest `status.json` fresh
(under 3 minutes old) and no longer than a set time in one state (starting 5 minutes, queued 15, playing 90, between
games 5). Otherwise it stops the old process and runs `--start` again, at most `--max-restarts` times (default 3) in
two hours; past that it stops restarting and writes an `alert`. It leaves a loop that stopped on purpose (people cap,
games done) alone, waits 20 minutes after a loop that ran out of opponents, and never restarts while the stop file
exists. What it saw goes to `--out` (state, verdict, `alert`, recent restarts and events), rewritten every check, for
an agent or a person to read.

## Games against people in the app (`feed.js`)

`feed.js` sends the bot games under `--runs` to the arena window (`SWU_WINDOW`, see bot/arena/WINDOW.md "Outside
machines"): the game list as `runs/karabast` (tournament index shape, ids `karabast-<frame hash>`, our seat named
after the bot and the other "opponent"), each replay as it grows, and with `--predict` its lens under the game's id.
It reads the window's feed token (`ARENA_FEED_TOKEN_KARABAST`, which the window knows from PR #106 on) from
`--token-file`, a file kept on the Sprite. Watched games between two people are not sent.

While a game is live it hides what the opponent cannot see: our hand goes face-down (count only), and a card our bot
put into resources, drew or took from a hidden zone is called "a hidden card": a choice is named only when one more
copy of that card reaches the public board, or when it clicked a card already there. A last step whose choice depends
on the next one waits for it, so a line once sent never changes. The whole replay replaces the live one when the game
ends: when its frames name a winner, or when queue.js has written its row (the seat won, lost, conceded or gave up). A
game that only went quiet stays hidden, since it may resume.

## What a bot sees (`fidelity.js`)

The same engine state was turned into a protocol message twice, once from the Karabast frame (`observe.js`) and once
the way our referee does it (`bot/view.js`). Over 50 random games (20 with random decks, 30 with the real Premier
decks in `bot/decks`), 10,516 of 10,569 decisions (99.5%) were identical. What differs:

- A card shown by a prompt from a hidden zone (a deck search) has `zone` and `ctl` null: the frame does not say
  where it is.
- `passed` is never set, and `out` only when the player claimed the initiative.
- Upgrades and selected cards come in arena order, not attach or pick order.
- About one decision in six lists its actions in another order (same actions).

## What a spectator gets

The public board only. Karabast hides both hands and face-down resources from spectators and never sends deck order
(`Card.getSummary`). The importer marks such replays `pov: "spectator"` with both hands hidden. When a player undoes,
the frames go back in time; the log says "has rolled back to", and the importer keeps the positions in order.

## Privacy

Every frame is scrubbed before it is written: player ids and usernames become `player1`/`player2` (also inside log
text), spectators become "a spectator", `user` objects (settings, cosmetics) are dropped, and player chat keeps only a
stub so the log positions stay. File names are a hash of the lobby and game ids.

## The live site

In use since 2026-10-11: a 4-game pilot (4 losses), then 3 watched games. Eric picked public games, recording public games politely and asking Karabast's developers through a
friend (2026-10-11, [decision page](https://claude.ai/artifact/MEsM6CB2hyK8Azrj2ajJ5K)), with a limit of 10 real
people. Before any live run:

- Behind an HTTPS proxy (Claude Code cloud sessions) run it with `NODE_USE_ENV_PROXY=1`, or Node's fetch and
  WebSocket go around the proxy and fail; `socket.js` refuses a non-local host without it.
- A run against a non-local host needs `--allow-host <host>` and `--ledger <file>`. The ledger stops a run before a
  game that would pass `--max-people` (default 10). Places are reserved before each game (1 for a bot game, 2 for a
  watched one), so a bot run and a recorder can share one ledger. A place stays counted whenever someone may have
  been reached without being identified: a bot run that entered the queue and failed or waited with no match, a
  recorder that joined a game and saw no frame. `--stop-file <file>` stops a run before the next game.
- Karabast logs every engine error and sends severe ones to its developers' Discord (Lobby `handleError`), so
  `queue.js` refuses decks with cards that are known to throw (Barriss Offee, ASH_044).
- Spectating needs a login (anonymous spectators are a development-only setting): a session token in the variable
  named by `--token-env`. The token is the `jwtToken` field of `https://karabast.net/api/auth/session` while logged in
  (valid about two months); keep it in an environment secret, never in a file. Spectators are named in the game log
  and shown to both players.
- Public games and quick match have a 20 s per-prompt timer with a 120 s bank. c-clock's slowest answer in the local
  games was 33 ms.
