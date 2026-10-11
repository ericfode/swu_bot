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
| `material` | hand-made | the shipped heuristic weights, including its low-base term |
| `material-fixed` | hand-made | same weights, but a low base counts against you |
| `race` | hand-made | rounds each side needs to kill the other base, compared as a log ratio |
| `linear` | fitted | logistic regression on the 30 per-side feature differences |
| `linear-deck` | fitted | same, opponent's hidden hand valued from their known decklist |
| `mlp` | fitted | tiny net, logit = g(me, opp) - g(opp, me) so both players' views agree |
| `mlp-deck` | fitted | same, with known decklists |

Hand-made evaluators get one fitted number, the logistic scale, so all of them output calibrated probabilities.
Features are in `features.js` (base HP, board power/HP, keywords, shields, leader, resources, hand size and
quality, deck, initiative, a damage-pressure ratio, round, who acts next).

**Views.** `subjective`: the judge sees its own hand; the opponent hand is a count (or, for `-deck` models, the count
times the average unseen card of their decklist). `objective`: both hands visible.

**Note on the shipped heuristic.** `bot/players/heuristic.js` scores base HP as `hp*0.9 + (12-hp)^2/6` when
`hp <= 12`. The second term grows as the base drops, so below about 9 HP each point of damage *raises* that
side's value. `material-fixed` flips the sign; compare it with `material` to see what the term costs.

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
