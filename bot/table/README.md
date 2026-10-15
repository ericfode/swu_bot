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
`host.js` against the JEPA bot), `bot/test/swarm-engine.test.js` (the play worker plays the same game as Node) and
`bot/test/play.test.js` (the window's side).

## The hosted table: /play on the arena window

Eric's picks (2026-10-15): the game runs in the person's browser, against his JEPA bot only, the person picks their
deck, and finished games go back to the arena.

```
window /play ── play.html + Holotable's kit (SWUViewer.mountPlay) ── worker: play-worker.js
                                                                     referee (forceteki) ◀─▶ jepa-tx-gate (vendor/jepa)
           ◀── POST /api/play/games {replay} at the end ──┘
```

- `jepa.js`: the JEPA bot (`jepa-tx-gate`: holocron's JavaScript port in `vendor/jepa`, with its two models) as an
  in-process protocol client. Its planner asks the referee for simulations, which re-deal the person's hidden cards.
- `host.js`: `createTableHost`, one game at a time in the tab: `options()`, `start({deck, botDeck, seed, key})`,
  `act()`, `concede()`, and `cardText()` (card text for the lists' cards and the tokens). The bot's deck is one of
  the lists picked by the game's seed unless the person names one.
- `bot/swarm/build.js` bundles it as `play-worker.js` on the swarm's engine pack (`bot/swarm/pack.js` adds this folder,
  `vendor/jepa` and the deck lists); the games machine serves both, and the window keeps them on its disk.
- `bot/arena/play.js`: the window's side. `ARENA_PLAY` says who may play: `invited` (the default), `github` (anyone
  signed in with GitHub) or `off`. Games are kept in the run `play` as a people run, unrated, with who played each
  one in `admin/people`; `bot/arena/WINDOW.md` has the routes.

The bot runs in the person's tab, so a person who opens the browser's developer tools could read the bot's hand. That
is why these games are unrated.
