# Real deck lists: do human winners also win for our bots?

`bot/decks/ash-meta-2026-09.json` holds 27 real Premier tournament decks (19 leaders). A mirror ladder plays them with
one bot on both seats (`node bot/ladder.js --decks bot/decks/ash-meta-2026-09.json --bots c-clock#a,c-clock#b ...`), so
the decks are the only thing that differs between games. `compare.js` asks whether the decks that win for the bot are
the decks that win for humans.

```bash
node analysis/realdeck/compare.js --runs <run dir>[,<run dir>...] \
     --decks bot/decks/ash-meta-2026-09.json --human bot/decks/ash-meta-2026-09.human.json \
     [--online /mnt/project-files/human-meta/swustats/human-summary.json] [--out realdeck.json] [--permute 1000] [--min-games 10]
```

A run directory needs `index.json` (and `ladder.json` when present). A run that is still going is fine: it is read
as a smaller run. Each run is named by its bot, without the `#a` tag. Tests: `cd analysis && npm test`.

## What counts

- Decided games only: `winnerSeat` p1 or p2. A draw counts half.
- Games that end in ERROR, STEP_CAP, STUCK or anything else are left out of every rate and model, but each deck
  reports them as `incomplete` (by outcome). A deck with a buggy card can lose games to engine errors, so look at this
  column before you trust a low deck. Games still running are ignored.

## What it computes (per run)

1. **Per deck**: decided games, wins, win rate with a Wilson 95% CI, incomplete games, and a strength from one logistic
   model `P(p1 wins) = σ(s[p1 deck] − s[p2 deck] + seat)`. Strengths have a small ridge (prior SD 1.4 logit) and are
   centred; the SE is for the centred value. The run also reports the P1 win rate and the seat term.
2. **Deck agreement**: bot strength (and bot win rate, as a centred logit) vs the human archetype game win rate (centred
   logit). Pearson with a Fisher-z 95% CI, tie-aware Spearman, the slope (bot logit per human logit), and a one-sided
   permutation p-value: the human values are shuffled across decks N times, p = (k + 1) / (N + 1).
3. **Pair agreement**: for each deck pair, the bot's win rate of a over b (both seat orders) vs the human cell for a over
   b. Thin human cells (fewer than 10 matches, about 56% of them) are left out. Pearson weighted by the human games in
   the cell, and the share of pairs where both pick the same favourite (pairs within 2 points of 50% on either side do
   not count), with a sign test.
4. **Leader agreement** (with `--online`): decks pooled by leader (games-weighted mean strength) vs the centred logit of
   the SWU Stats online leader win rate, leaders with at least 200 plays.
5. **Reliability**: even vs odd seeds give two independent fits; their correlation and the Spearman-Brown value for the
   full run. With 2+ runs, the strength correlation between every pair of runs (bot vs bot).
6. **Style** (hyperaggro, softaggro, midrange, softcontrol, hardcontrol): pooled bot win rate of the decks of that style,
   the same against other styles only, and the human mean game win rate of those decks.

Output JSON: `{credit, generatedAt, options, runs, decks, agreement: {deck, pair, leader, style, splitHalf, betweenRuns}}`.
The console gets a short summary and a deck table sorted by bot strength.

## Read with care

- The human rate is for the archetype (leader + base group) over every list of it in 53 events, not for this exact list.
- 27 decks share 19 leaders, so decks are not fully independent; the permutation test treats them as exchangeable.
- Pair rates are noisy on the bot side too: a full run of 7,020 games gives each pair 20 games.
- Online (SWU Stats) rates run high (about 58%) because only the side with an imported deck is counted. Compare leaders
  with each other, not with 50%.
- A run with two different bots (not a mirror) gets a warning: bot and deck effects can mix.

## Credit

- Tournament deck lists and results: TCGEngine / SWU Stats (github.com/TCG-Engine/TCGEngine, MIT), from public melee.gg
  decklists.
- Online leader win rates: SWU Stats (swustats.net).

Every page or report that shows these numbers keeps these lines (the JSON carries them in `credit`).
