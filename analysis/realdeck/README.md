# Real deck lists: do human winners also win for our bots?

`bot/decks/ash-meta-2026-09.json` holds 27 real Premier tournament decks (19 leaders). A mirror ladder plays them with
one bot on both seats (`node bot/ladder.js --decks bot/decks/ash-meta-2026-09.json --bots c-clock#a,c-clock#b ...`), so
the decks are the only thing that differs between games. `compare.js` asks whether the decks that win for the bot are
the decks that win for humans.

```bash
node analysis/realdeck/compare.js --runs <run dir>[,<run dir>...] \
     --decks bot/decks/ash-meta-2026-09.json --human bot/decks/ash-meta-2026-09.human.json \
     [--online /mnt/project-files/human-meta/swustats/human-summary.json] [--out realdeck.json] [--permute 1000] \
     [--min-games 10] [--max-incomplete 0.10]
```

A run directory needs `index.json` (and `ladder.json` when present). A run that is still going is fine: it is read
as a smaller run. Each run is keyed by the `id` in its `index.json` (or the directory name when there is none, with
`#2`, `#3` added to repeats); its bot (entry names without the `#a` tag) is a separate field. Games are matched to decks
by the deck names in each index entry, never by seed. Tests: `cd analysis && npm test`.

Decks are read the way `bot/decklists.js` `normalizeDeck` reads them (padded card ids, the same default name). The
sha256 of the `--decks` file's raw bytes (the hash `loadDecks` writes to `ladder.json` `config.decks.sha256`) is
checked against each run, with a warning when they differ.

## What counts

- Decided games only: `winnerSeat` p1 or p2. A draw counts half.
- Games that end in ERROR, STEP_CAP, STUCK or anything else are left out of every rate and model, but each deck
  reports them as `incomplete` (by outcome, and as a share of its finished games). Games still running are ignored.
- A deck whose finished games are more than `--max-incomplete` incomplete (default 0.10) is **left out of every
  correlation**: deck, pair (every pair with it), leader, style, split-half and run vs run. A deck that crashes the
  engine in a third of its games only shows the games where the bug did not fire, so its rate is not a fair one. It
  stays in the strength model (its decided games still count for its opponents) and in the deck table, marked
  `left out`; the console and `runs[].leftOut` say which decks and why. As a check, the deck correlations are also
  given with those decks put back (`withLeft`). In the c-clock run this leaves out `lando-calrissian_law_blue`
  (185 of 520 games incomplete, 184 of them the Barriss Offee engine bug, CLAUDE.md known engine bugs).

## The human side

- **Human BT strength (like for like).** One Bradley-Terry model `P(a beats b) = σ(h[a] − h[b])` over every human
  cell between two of these 27 decks, thin cells included, from the cell's games `[wins, losses, draws]`. A draw counts
  half a win for each side (as on the bot side). The same small ridge as the bot model; strengths are centred with an
  SE each. The bot plays a uniform round robin of these 27 main decks, so this is the comparison on the same deck pool.
- **Field game win rate.** Each archetype's game win rate against the whole real meta (best of three, with
  sideboards, every list of that archetype). Kept for reference; it is not like for like.

## What it computes (per run)

1. **Per deck**: decided games, wins, win rate with a Wilson 95% CI, incomplete games and share, and a strength from
   one logistic model `P(p1 wins) = σ(s[p1 deck] − s[p2 deck] + seat)`. Strengths have a small ridge (prior SD 1.4
   logit) and are centred; the SE is for the centred value. The run also reports the P1 win rate and the seat term.
2. **Deck agreement**, over decks with enough decided games that are not left out:
   - bot strength vs human BT strength: Pearson with a Fisher-z 95% CI, tie-aware Spearman, the slope, and a one-sided
     permutation p-value (the human values are shuffled across decks N times, p = (k + 1) / (N + 1)). Reliability of
     each side from its SEs, (observed variance − mean SE²) / observed variance, and the disattenuated
     r = r / sqrt(rel bot · rel human): marked and clamped to ±1 when it comes out above 1 in size, null when a
     reliability is not above 0. The split-half value of the bot side is shown next to its SE-based one.
   - bot strength (and bot win rate, as a centred logit) vs the field game win rate (centred logit), the same way.
3. **Pair agreement**: for each deck pair, the bot's win rate of a over b (both seat orders) vs the human cell for a over
   b. Thin human cells (fewer than 10 matches, about 56% of them) are left out. Pearson weighted by the human games in
   the cell (unweighted Pearson and Spearman are shown too), and the share of pairs where both pick the same favourite
   (pairs within 2 points of 50% on either side do not count). Pairs share decks, so they are not independent: the
   p-values for both come from a deck-label permutation test (QAP / Mantel). The deck labels on the bot side are
   shuffled, rows and columns of the pair matrix together, N times (`--permute`, deterministic shuffles),
   p = (k + 1) / (N + 1). The sign test on the favourite count is kept only as a description (it would be right if
   the pairs were independent).
4. **Leader agreement** (with `--online`): decks pooled by leader (games-weighted mean strength) vs the centred logit of
   the SWU Stats online leader win rate, leaders with at least 200 plays.
5. **Reliability**: split-half. Within each deck pair the seeds are ranked; games of an even-ranked seed form half A,
   odd ones half B. Both games of a seed stay together and every pair is split, whatever the number of pairs (splitting
   by seed parity would put all of a pair's seeds in one half when the deal walks an even number of pairs). Two
   independent fits, their correlation and the Spearman-Brown value for the full run. With 2+ runs, the strength
   correlation between every two runs: run vs run when they use the same bot, bot vs bot agreement when they do not.
6. **Style** (hyperaggro, softaggro, midrange, softcontrol, hardcontrol): the bot win rate of the decks of that style in
   games against other styles, with a Wilson CI; the rate over all games (`allGamesInclSameStyle`, no CI: a same-style
   game adds a win and a loss to the same pool, which pulls it toward 50%); and the human mean field game win rate of
   those decks.

Output JSON: `{credit, generatedAt, options, deckFile, humanSource, onlineSource, humanModel, runs, decks, agreement:
{deck, pair, leader, style, splitHalf, betweenRuns}}`. `deckFile` has the deck count and sha256, `humanModel` the
human BT summary (pairs, thin pairs, games, draws, reliability), each `decks[]` entry its `humanBT` strength, SE and
games, `runs[]` the `leftOut` decks and `warnings`. The console gets a short summary and a deck table sorted by bot
strength.

## Skill vs agreement (`skill.js`)

Do stronger bots agree more with humans? `skill.js` measures each bot's skill on these decks with a gauntlet against
one reference bot, then joins it with that bot's agreement from `compare.js`.

```bash
K=$(openssl rand -hex 32)   # keep it: every gauntlet that should share deals uses the same --key and --seed
node bot/ladder.js --decks bot/decks/ash-meta-2026-09.json --bots heuristic,rust-search --vs c-clock --games 702 --key $K --seed 1 --id gauntlet-1
node analysis/realdeck/compare.js --runs <c-clock mirror>,<heuristic mirror>,<rust-search mirror> ... --out compare.json
node analysis/realdeck/skill.js --gauntlet <gauntlet dir>[,<gauntlet dir>...] --compare compare.json [--out skill.json]
```

- **Whole passes**: `--games` should be a multiple of 2P (P = 351 deck pairs for 27 decks, so 702). Then every deck
  sits on the challenger's side as often as on the reference's, and deck luck cancels. The script checks this on each
  challenger's decided games (the games its rate counts) and warns when a deck sits on one side more often: a part
  pass, a run read while it is going (seeds finish out of order), or games dropped as incomplete (a deck with an
  engine bug). Run ids must be unique.
- **Skill**: the challenger's score against the reference in decided games (draws half), a Wilson 95% CI and an Elo
  difference. An ERROR game a bot caused (`by` set: it threw, made an illegal move or timed out) is a loss for that bot,
  as in `bot/ladder-report.js`. Engine errors, STEP_CAP and STUCK games are counted by outcome and left out. The
  reference is 50% by definition. All gauntlet runs must share the reference, and each challenger plays in one run
  only, as one copy.
- **Paired**: every two challengers over the seeds both played with the same decks from the same seats (and the same
  game key, or none on both), all four games decided: the mean score difference per seed with a 95% CI. With the same
  `--key` and `--seed`, two gauntlet runs deal the same games, so ISMCTS can run apart from the faster bots and still
  pair.
- **Agreement** per bot, from its mirror run in `compare.json` (the biggest when there are several): deck r against the
  human BT strengths (and disattenuated), the same-favourite share, the aggro-minus-control gap in win rate against
  other styles beside the same gap in the human field rates (`styleExcess` = bot gap − human gap, `styleDistance` its
  size), and the r of its deck strengths with the reference bot's. When compare.js left different decks out of
  different bots' deck correlations (too many incomplete or too few decided games), a warning says their measures are
  not on the same decks. A deck file sha256 that differs between `compare.json`, the mirror runs used and the gauntlets
  gets a warning too, and gauntlets from different deck files never pair.
- **Trend**: Spearman of skill against each of those over the bots that have both, with an exact two-sided permutation
  p for up to 8 bots. With a handful of bots this describes; it does not prove a rule.

- **Deck-type row** (`skill.byStyle`): the challenger's score against the reference split by the style of the deck it
  holds (hyperaggro .. hardcontrol, from the deck file's `metadata.style`), with a Wilson CI each. A bot keeps its deck
  in both games of a seed, so within a pass it holds one side of each deck pair: the overall score is fair, but in a
  split the cards stay in, and a bot that played exactly like the reference would score its decks' strength there, not
  50%. So each cell also has `expected`, what the reference itself scores with the same decks from the same seats (the
  deck model compare.js fits to the reference's mirror, which had its own deals: P(p1 wins) = σ(s[p1 deck] − s[p2
  deck] + seat)), and `edge` = score − expected. A bot weaker overall loses points in every cell, more where that
  expectation is far from its own level, so each cell also has `par`: the same model shifted on the logit scale by one
  amount per bot, so that it gives the bot's overall score (Σ σ(l + d) = Σ y). Par is what a bot of that strength
  would score with those decks if it handled every deck type like the reference; `vsPar` = score − par, and a row's
  vsPar averages to 0 over its games. Above 0, the bot does better with that deck type than its level says; below,
  worse. Neither has a CI, and both carry the noise of the mirror's model. Without a mirror of the reference in the
  compare file there is no `expected` or `par`.

## The standard bot test (`bot-test.js`)

Every new bot gets the same test: one pass of the 27 decks against c-clock (702 games), on the same deals as every bot
tested before, so its score compares with theirs and pairs with them game for game.

```bash
npm run realdeck:test -- --bot <bot> [--mirror] [--record] [--workers 4] [--panel /mnt/project-files/dashboard/panels/realdeck-test.json]
npm run realdeck:test -- --report [--panel ...]     # rebuild skill.json and the panel from the runs already played
npm run realdeck:test -- --bot <bot> --dry-run      # print the commands only
```

- Runs go in `--dir` (default `/mnt/project-files/human-meta/realdeck` when it exists, else `results/realdeck`): the
  gauntlet as `test-<bot>-<n>`, the mirror (with `--mirror`) as `mirror-<bot>-<n>`. `--resume <run id>` finishes a
  gauntlet of the same bot that stopped (no write for an hour). It is refused for a run still going or already done
  (ladder.js may start a done run over), for a run of another bot, deck file, seed or key, and for a run whose key is
  not published yet (ladder.js publishes it when a run finishes; a resume would deal the rest from a new key).
- **Same deals**: the run key is the one the last report named (`skill.json` `standard.keyId`), else the key of the
  gauntlet against c-clock on the same deck file and seed 1 that finished first (its `ladder.json` `config.key`). In a
  folder with none, the first test draws a new key and the later ones reuse it; a test started while that first one
  is still running warns that one of the two will be left out. The key also lets a program rebuild the hidden cards,
  so it is read from that run only, printed only as its id, and never committed.
- **Report**: every gauntlet in the folder on those deals (the others are listed as left out, with the reason) and
  one run per challenger: its newest finished run, or its newest unfinished one when it has none (a bot tested again
  replaces its older games once the new run is done). They are joined through `skill.js` with `compare-702.json`
  (compare.js on one-pass mirrors). `--mirror` reruns compare.js on the mirrors in that file with this bot's replaced
  by the new one (mirrors whose folder is gone are listed and dropped; c-clock's mirror is played too when the file
  has none, since par needs it), so the report has its agreement with humans, and rewrites `compare-702.json` and
  `.txt`. Writes `skill.json` and `skill.txt` in the folder.
- **Panel** (`--panel <file>`, research dashboard contract section 5): each bot's score against c-clock as a face-off
  with its 95% CI (and "running, k of 702 games" while its run goes on, or "stopped" once it has not written for an
  hour), a table of each bot's score by the deck type it holds with each cell coloured by its points above or below
  par (Atlas edge steps) and c-clock's own score with the same decks as its first row, the latest bot's deck-type
  row as face-offs, and the agreement table for bots with a mirror. The goal, mental model, plan and thoughts of an
  existing panel file are kept (a mental model the script wrote by default before is replaced); a finished test
  adds one thought with its result.
- A pass takes about as long as 702 games of the bot (c-clock answers in well under a millisecond). Bots that need
  more time per decision can use `--workers`.

## Read with care

- The human field rate is for the archetype (leader + base group) over every list of it in 53 events, not for this
  exact list. The cells (and so the human BT strengths) are archetype against archetype too.
- Human games are best of three with sideboards; the bot plays single games with the main deck.
- 27 decks share 19 leaders, so decks are not fully independent; the deck permutation test treats them as exchangeable.
- Pair rates are noisy on the bot side too: a full run of 7,020 games gives each pair 20 games.
- Online (SWU Stats) rates run high (about 58%) because only the side with an imported deck is counted. Compare leaders
  with each other, not with 50%. The online data is "format premier, all weeks", so an older leader's rate carries the
  earlier metas it was played in.
- A run with two different bots (not a mirror) gets a warning: bot and deck effects can mix.

## Credit

- Tournament deck lists and match results: TCGEngine / SWU Stats (github.com/TCG-Engine/TCGEngine, MIT), from public
  melee.gg Premier events (event list via swu-competitivehub.com).
- Online leader win rates: SWU Stats (swustats.net).

Every page or report that shows these numbers keeps these lines (the JSON carries them in `credit`).
