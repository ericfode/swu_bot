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

`--bots-file` takes holocron's program list (build the C bots first: `make -C bots/c` there). Tests:
`node --test bot/test/table.test.js` (split checks, refused answers, conceding, and whole games a scripted person plays,
checking that the bot's hidden cards never reach the person's screen).

Not here yet: the hosted table. Where it runs (in the person's browser like the swarm, on the games machine, or on a
small machine of its own) and who may sit down are Eric's call.
