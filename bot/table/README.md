# The table: people play bots

A person sits at a table as one more seat. The referee (`match.js`, `protocol.js`) sends that seat the same protocol v2
`decide` a bot gets: the board from that seat (the bot's hand, resources and both decks hidden) and the legal moves.
Holotable's play page (`#/play` in [holotable](https://github.com/ericfode/holotable)) draws the board and answers with
`act`. So a person needs no rules code of their own, and the bot cannot tell a person from another bot; a bot's own
simulations re-deal the person's hidden cards, as for any opponent.

```
Holotable #/play  ──decide/act──▶  referee (forceteki)  ◀──decide/act──  bot (a program or an arena bundle)
```

- `person.js`: `PersonSeat`, the person's protocol client. No clock (the referee sends `ms: null`). A wrong answer (an
  old decision, an index out of range, a split that does not add up) is refused and the decision stays open, so a slip
  never loses the game; `concede()` ends it.
- `table.js`: `playTable` plays one game and also tells the screen every move from either seat (`move`, with the
  board from the person's seat; a card the person cannot see is "a hidden card") and the end (`end`, with the replay).
- `serve.js`: a table on one computer, for trying it out. People pick a bot and two of the tournament deck lists;
  every game is written in the replay format to `replays/table/`, so Holotable lists it as the tournament `table`.

```bash
# in holotable: npm run build      (or npm run dev, which sends /table/api to TABLE_URL, default http://127.0.0.1:8790)
node bot/table/serve.js --site ../holotable/dist \
  --bots-file ../holocron/bots/external-bots.json --offer c-clock3me-s,heuristic,rush   # then open http://127.0.0.1:8790/#/play
```

`--bots-file` takes holocron's program list (build the C bots first: `make -C bots/c` there); `serve.js` offers the
JEPA bot too. Tests: `node --test bot/test/table.test.js` (split checks, refused answers, conceding, and whole games a
scripted person plays, checking that the bot's hidden cards never reach the person's screen, one of them through
`host.js` against the JEPA bot), `bot/test/swarm-engine.test.js` (the play worker plays the same game as Node, and
an arena bundle plays a whole game in `bot/swarm/play-host.js`) and `bot/test/play.test.js` (the window's side).

## The hosted table: /play on the arena window

Eric's picks (2026-10-15): the game runs in the person's browser, the person picks their deck, and finished games go
back to the arena. On 2026-10-16 he asked to pick the bot too, so a tab downloads only that one: the JEPA bot, or a
WebAssembly version of the arena's latest round.

```
window /play ── play.html: pick a bot, download it ── worker: play-worker.js (bot/swarm/play-host.js)
   + Holotable's kit (SWUViewer.mountPlay)                   referee (forceteki) ◀─▶ jepa-tx-gate (vendor/jepa)
                                                                                 ◀─▶ an arena bundle (bot worker)
           ◀── POST /api/play/games {replay} at the end ──┘
```

- `jepa.js`: the JEPA bot (`jepa-tx-gate`: holocron's JavaScript port in `vendor/jepa`, with its two models) as an
  in-process protocol client. Its planner asks the referee for simulations, which re-deal the person's hidden cards.
- `host.js`: `createTableHost`, one game at a time in the tab: `options()`, `start({bot, deck, botDeck, seed, key})`,
  `act()`, `concede()`, and `cardText()` (card text for the lists' cards and the tokens). The bot's deck is one of
  the lists picked by the game's seed unless the person names one.
- `bot/swarm/play-host.js`: the worker's host. It writes the JEPA bot's models when its first game brings them
  (`addFiles`), unpacks an arena version's tar where the registry finds it (`addBundle(name, hex, tar, capMs)`, checked
  against its sha256), loads Python for a Python bundle (`addPython`), and makes each game's bot: an arena version is a
  fresh program in its own bot worker, guarded with the round's time per game, stopped when the game ends.
- `bot/swarm/build.js` bundles it as `play-worker.js` on the swarm's engine pack (`bot/swarm/pack.js` adds this folder,
  `vendor/jepa` and the deck lists; the models are files of their own); the games machine serves them, and the window
  keeps them on its disk. Messages: `{t: 'init', packBytes, botWorker}`, then `{t: 'start', bot, deck, botDeck, files,
  bundle, python}` (what this bot needs that the worker has not had yet), `{t: 'act', act}`, `{t: 'concede'}`; out
  `ready` (with `options`, `cardText`, `isolated`), `started` or `refused`, `acted`, `msg` (every table message).
- `bot/arena/play.js`: the window's side. `ARENA_PLAY` says who may play: `invited` (the default), `github` (anyone
  signed in with GitHub) or `off`. Games are kept in the run `play` as a people run, unrated, with who played each
  one in `admin/people`; `bot/arena/WINDOW.md` has the routes.

The bot runs in the person's tab, so a person who opens the browser's developer tools could read the bot's hand. That
is why these games are unrated.
