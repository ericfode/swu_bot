# Human meta from SWU Stats vs our ladder

Do leaders that win for human players also win in our bot ladder? Human numbers come from **SWU Stats
(swustats.net)**, whose aggregate APIs are free to use with visible credit: show "SWU Stats (swustats.net)" wherever
these numbers appear.

```bash
node analysis/swustats/fetch.js --out /mnt/project-files/human-meta/swustats        # two GETs, 3 s apart
node analysis/swustats/compare.js --human /mnt/project-files/human-meta/swustats \
     --results /mnt/project-files/results --permute 300                             # -> compare.json
```

- `fetch.js` reads robots.txt first, sends two requests at least 1 s apart (3 s by default) with a User-Agent that
  names this project, and writes `human-summary.json`: wins and plays per leader, per base and per leader pair, plus the
  first-player win rate. SWU Stats counts only games played with a deck imported from it, so absolute win rates run
  high (about 58%); compare leaders with each other, not with 50%.
- `compare.js` fits one logistic model over every decided ladder game:
  `P(p1 wins) = σ(bot1 − bot2 + leader1 − leader2 + base1 − base2 ± first)`, with ridge shrinkage on leaders and bases
  (each has only tens of games). A second fit puts one coefficient κ on the human strength instead. `--permute N`
  shuffles human values across leaders to get an honest p-value for κ, since the model's own error bar ignores that
  games share a leader.

Result on 2026-10-11 (2,000 decided games, 28 runs, 46 bots): κ = 0.31 ± 0.09, but shuffled human values reach that
11% of the time, and the leader rank correlation is −0.04. Human leader strength does not carry over, most likely because
ladder decks are random (`bot/env.js` `randomDeck`: a random leader and base plus random cards of their aspects) while a
human's leader comes with a deck built around it. Humans going first win 56.2%; our bots going first win 54.2%, but that
edge goes away once bot strength is taken out (−0.01 ± 0.07 logit).
