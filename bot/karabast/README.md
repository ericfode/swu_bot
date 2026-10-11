# Karabast client

Talks to a Karabast game server (the forceteki `server/gamenode` that runs karabast.net) the way its web client does,
without a browser. Plain CommonJS on Node 22's built-in `WebSocket` and `fetch`, no dependencies.

| file | what it does |
|---|---|
| `socket.js` | Socket.IO v4 client on path `/ws`, plus the HTTP calls (create, join and spectate a lobby). Refuses any host but localhost unless the caller names it. |
| `frame.js` | Reads `gamestate` frames: legal actions for a seat (same kinds as `bot/env.js` legalActions), the `game` message for an action, and the privacy scrub. |
| `spectate.js` | Watches games as a spectator and writes scrubbed frames as JSON Lines, which `importer/import.js` turns into replays. `--predict <evaluator>` prints P(win) as the game goes. |
| `selfplay.js` | Two random players on a local server: a test for the above and a game for `spectate.js` to watch. |

## Try it on a local copy

Build and start forceteki's server in development mode (anonymous players and spectators, no timers, no database):

```bash
cd <forceteki checkout> && npm ci && npm run get-cards && npm run dev     # serves http://localhost:9500
```

Then, from this repo (card data from the same checkout):

```bash
export SWU_CARD_JSON=<forceteki checkout>/test/json
node bot/karabast/selfplay.js --seed 4 --delay-ms 30 &          # a public lobby, so spectators are allowed
node bot/karabast/spectate.js --public --games 1 --out captures --predict race
node importer/import.js captures --out replays/karabast-local --source karabast-spectate
```

`race` and `base` read only the public board. The fitted evaluators need bot/eval's spectator view (both hands
hidden), since a spectator sees neither hand.

## What a spectator gets

The public board only. Karabast hides both hands and face-down resources from spectators and never sends deck order
(`Card.getSummary`). The importer marks such replays `pov: "spectator"` with both hands hidden.

## Privacy

Every frame is scrubbed before it is written: player ids and usernames become `player1`/`player2` (also inside log
text), spectators become "a spectator", `user` objects (settings, cosmetics) are dropped, and player chat keeps only a
stub so the log positions stay. File names are a hash of the lobby and game ids.

## The live site

Not used yet. Karabast's Terms of Service say nothing about bots or recording; see the
[decision page](https://claude.ai/artifact/MEsM6CB2hyK8Azrj2ajJ5K) for the options. Facts that matter there:
spectating on karabast.net needs a login (anonymous spectators are a development-only setting), spectators are named
in the game log and shown to both players, and public games and quick match have a 20 s per-prompt timer with a 120 s
bank. Running against any non-local host needs `--allow-host <host>` and, to spectate, a session token
(`--token-env <VAR>`).
