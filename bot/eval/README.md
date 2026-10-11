# Position evaluation bench

Question: how should a bot value a position it can only see from one side? This folder holds several answers and
measures them two ways:

1. **Prediction.** On held-out games, how well does the evaluator's P(win) predict the winner? Score = Brier
   (mean squared error of the probability; 0.25 is a coin flip, lower is better), plus log loss and accuracy.
2. **Play.** The same one-ply lookahead bot (`bot/players/heuristic.js`) with only the evaluator swapped plays a
   round-robin. Bot names are `h@<evaluator>` (`h2@<evaluator>` for depth 2); `tournament.js` accepts them too.

Every evaluator reads the recorder snapshot (`bot/recorder.js`), not live engine objects, so the same code scores
recorded games from any source (including upstream tournaments) and positions inside the bot.

## Evaluators

| name | kind | idea |
|---|---|---|
| `base` | hand-made | remaining base HP difference; the floor |
| `material` | hand-made | the heuristic weights before the sign fix (heuristic.js `legacy` profile) |
| `material-fixed` | hand-made | same weights with the fix (heuristic.js's current default) |
| `race` | hand-made | rounds each side needs to kill the other base, compared as a log ratio |
| `linear` | fitted | logistic regression on the 30 per-side feature differences |
| `linear-deck` | fitted | same, opponent's hidden hand valued from their known decklist |
| `mlp` | fitted | tiny net, logit = g(me, opp) - g(opp, me) so both players' views agree |
| `mlp-deck` | fitted | same, with known decklists |

Generation 3 (`linear-g3`, `linear-deck-g3`, `mlp-g3`, `mlp-deck-g3`) adds strong-play data: omni's games (`replays.js`
below) and ISMCTS search leaves. Gen 2 keeps the default names until gen 3 is tested in play.

Generation 4 (`*-g4`) is gen 3's data without the `deckLow` feature (`fit.js --drop deckLow --suffix -g4`). Gen 3 put
about 4 base HP on each card below 5 left in the deck, learned mostly from long random games. In omni's 72
solver-proven endgames that weight picked the losing side, so gen 3 got only 46-49 of them right. Gen 4 gets 55-57,
and its held-out Brier is the same for linear (0.157) and better for the net (0.153 vs 0.156). Base HP alone still
gets 63.

Generation 5 (`*-g5`) is the first self-play generation: gen 4's data plus ladders 3-6 and 1,652 games other bots
recorded (league, Rust, Python, JEPA, ISMCTS, Jev ladders), 3,506 games in all, still without `deckLow`. On the 665
held-out games of all sources the net scores 0.170 (gen 4: 0.174). It is a little worse on the old sources alone
(0.158 vs 0.153) and better on the new ones (0.177 vs 0.186). On omni's 225 proven positions it gets 202-204 right
(gen 4: 195-200).

Hand-made evaluators get one fitted number, the logistic scale, so all of them output calibrated probabilities.
Features are in `features.js` (base HP, board power/HP, keywords, shields, leader, resources, hand size and
quality, deck, initiative, a damage-pressure ratio, round, who acts next).

**Views.** `subjective`: the judge sees its own hand; the opponent hand is a count (or, for `-deck` models, the count
times the average unseen card of their decklist). `objective`: both hands visible. `spectator`: neither hand visible,
only both counts, which is what a Karabast spectator sees. On the 665 held-out games it costs about 0.001 Brier against
the subjective view, so a spectator can call games almost as well as a player. `score.js` reports it for every
position, including captures where both hands are hidden (which have no subjective or objective view), split by
source and round. Its `paired` row scores the spectator view on exactly the judges and positions the subjective view
uses, so the two compare like with like on one-seat captures too (on engine games the two rows agree).
`fit.js --view spectator` fits on spectator frames instead, so captures with no visible hand become training rows.

**Real Karabast games.** On the 181 decided public KaraBuddy games (6,383 positions, spectator view, no decklists in the
captures) the best model is `mlp-g5` at Brier 0.213, against 0.171 on engine games. A linear model fitted only on real
games, 5-fold by game, scores 0.210, so more engine games of the same kind will not close the gap. Concessions are not
the cause: 72 games end with the loser's base intact (judged on the final frame), and the model calls those slightly
better (0.203) than games that end with the base destroyed (0.218). One action before a destroyed base, the model still
favours the loser in 20 of 109 real games (14 of 168 heuristic games, 1 of 131 omni games). In all 20 the winner was
the one to act, and in 13 the winner's ready units could not deal the damage, so the finish came from cards a
spectator cannot see (events, leader abilities). `flags.js` lists concessions made while the board favoured the
conceder, and likely blunders, with viewer links. Results: `/mnt/project-files/research/position-eval/real-games.json`.

**Note on the heuristic's base term.** Until 2026-10-11 `bot/players/heuristic.js` scored base HP as `hp*0.9 + (12-hp)^2/6`
when `hp <= 12`. The second term grows as the base drops, so below about 9 HP each point of damage *raised* that
side's value. heuristic.js now subtracts it (the old behaviour is its `legacy` profile). `material` keeps the old
sign and `material-fixed` the new one, so the pair measures what the bug cost.

## Run it

```bash
# 1. data: recorded checkpoints (state before each action-window decision) + decklists, 4 processes
node bot/eval/arena.js --bots random-a,random-b --games 900 --seed 100000 --out data/random --record positions --every 4
node bot/eval/arena.js --bots heuristic,heuristic-x,random --games 60 --seed 200000 --out data/heur --record positions --every 2
# 2. fit all evaluators (writes bot/eval/models/*.json); 20% of games (by id hash) are held out
node bot/eval/fit.js --data data/random,data/heur
# 3. held-out Brier, plus the same checkpoints as an LLM analysis file (analysis/analyze.js output)
node bot/eval/score.js --data data/random,data/heur --json brier.json --llm game.claude.json --replay game.jsonl
# 4. ladder: same search, different evaluators (index.json is the normal tournament format)
node bot/eval/arena.js --bots random,heuristic,h@material,h@linear,h@mlp --games 8 --out results/eval-ladder-1 --record full
# 5. research dashboard panel + experiment files
node bot/eval/publish.js --brier brier.json --ladder results/eval-ladder-1/index.json
```

`arena.js` writes the same `index.json` / `games/<id>.jsonl` as `tournament.js` (viewer and dashboard read them
unchanged), and adds `decks/` and `positions/` next to them.

### Using games recorded by other bots

`replays.js` turns any tournament folder (`games/*.jsonl` replays) into a position dataset for `fit.js` and `score.js`.
Decklists are redrawn from the seed, as `match.js` draws them:

```bash
node bot/eval/replays.js --from /mnt/project-files/results/omni-ref-1,/mnt/project-files/results/omni-ref-2 --out data/omni --every 2
```

### Scoring another bot's lens scores

`lensfit.js` takes the per-step score from swu-lens/1 files (`dashboard/lens/<gameId>.json`, default field `edge`) and
the matching replays. It fits the score → P(p1 wins) map with 5 folds split by game, and scores the bench evaluators
on the same positions:

```bash
node bot/eval/lensfit.js --lens /mnt/project-files/dashboard/lens --replays /mnt/project-files/results --json omni-lens-fit.json
# --evals a,b,c picks the bench evaluators; only the fold-0 column is fair for models trained on these games
```
