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
  never loses the game; `concede()` ends it. Its `ready` asks for `noEffect` marks (spec/protocol.md), so the screen
  greys a card whose move would change nothing.
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
scripted person plays, checking that the bot's hidden cards never reach the person's screen), `bot/test/open-table.test.js`
(the play page's host: people games, the JEPA bot, arena bots, custom decks), `bot/test/swarm-engine.test.js` (the play
page's worker plays the same games as Node, and arena bundles play whole games in it) and `bot/test/tables.test.js`
(the window's side).

## The play page: /tables on the arena window

The arena's one play page (Eric, 2026-10-16: "there should be just one play page"; the app's Play button and `/play`
open it). It took over the old `/play` page's opponents and downloads: the versus screen lists the JEPA bot and the
latest round's versions, and the tab downloads only the bot the person looks at. Eric's picks (2026-10-16): people play
each other or any arena bot, no ratings yet, every game hosted by a player's
browser; the finished games are kept for training and anyone signed in with GitHub can read them with a free reader
token; players appear in the logs by a random id, never a GitHub name; both players are trusted in this first version
(no signed moves, no deal proof).

```
person's tab ── tables.html + Holotable's kit ── worker: tables-worker.js
                                                 referee (forceteki) ◀─▶ a bot: JEPA, or an arena bundle in bot workers
                                                                     ◀─▶ the other person (people games)
guest's tab ── tables.html + kit ◀── WebRTC data channel, or the window's lobby relay ──▶ host's tab
both tabs ── POST /api/tables/games {replay, seat} at the end
```

- `open.js`: `createOpenHost`, one game at a time in the host's tab: `options()`, `checkDeck(deck)` (a deck list such
  as SWUDB exports it, checked against the card data like the arena's lists), `start({mode: 'bot' | 'people', ...})`,
  `act()` and `peerAct()` (the guest's answers), `concede()` and `peerConcede()`, `cardText()`. An arena bot is made by
  the registry from its bundle, which the worker unpacked under `ARENA_HOME`, and gets the arena's thinking time. In a
  people game the guest's seat is a `PersonSeat` whose messages go to `sendPeer`; the host's tab holds both hands and
  the deal (trusted). Which seat the host takes comes from the game's seed.
- `jepa.js`: the JEPA bot (`jepa-tx-gate`: holocron's JavaScript port in `vendor/jepa`, with its two models) as an
  in-process protocol client. Its planner asks the referee for simulations, which re-deal the person's hidden cards.
  Its card tables come from each game's `hello.cards`, as any bot's card data does. The person's screen gets `hello`
  without `cards` (`person.js`): the page draws cards from `cardText()`.
- `host.js`: what the tables share: `deckOptions`, `pickDecks` (the bot's deck is one of the lists picked by the game's
  seed unless the person names one) and `cardTextOf` (card text for the lists' cards and the tokens).
- `table.js` `playSeats`: a game between any two seats, each person seat with its own screen; a concession from either
  person ends the game for both (`end.concededBy`).
- `bot/swarm/build.js` bundles it as `tables-worker.js` on the swarm's engine pack, with the WASI host and the bot
  workers' spawn, so arena bundles (compiled and Python) run as they do on the swarm page.
- `bot/arena/web/tables.html`: the page. It downloads the engine as soon as it opens (not when it opens on an invite
  link: a guest only draws the host's game), and a bot's own files (its bundle, Python, the JEPA bot's models) while
  the versus screen shows it (`table.prepare`), each file once; links two tabs (a WebRTC data channel when the browsers can reach each other, else the
  window's lobby carries the game; a direct link that drops goes on through the lobby), and makes the pasted codes for
  games with no lobby. `bot/arena/tables.js` and `bot/arena/lobby.js` are the window's side (`bot/arena/WINDOW.md`),
  and `spec/open-tables.md` is the log API.
