# JEPA bot: planning in a learned latent space (tinygrad)

A bot whose moves come from a **Joint Embedding Predictive Architecture** (LeCun, "A Path Towards Autonomous
Machine Intelligence", 2022; I-JEPA / V-JEPA). It learns an embedding of the board and a predictor of *future
embeddings* given an action, then picks moves by imagining futures in that embedding space. It never
reconstructs a board, which is the difference from a generative world model (and from the "world head" of the
Rust and tinygrad learned bots, which predict board numbers directly).

Not to be confused with the Jev bot (`bot/jev/`), which asks TypeSafe's Jev model.

## The model

```
observation ─ state (73) + card tokens (≤32) ─> encoder E ─> z (96)            Ē = EMA copy of E (target encoder)
legal action ─ action (62) + card id ────────> action enc ─> a (64)
[z, a, h]  ─> predictor P ─> ẑ_h = z + P(z, a, h)    trained so ẑ_h ≈ Ē(observation h of my decisions later), h ∈ {1, 4}
z          ─> value V ─> logit "I win from here"
```

- **Encoding is shared** with the Rust learned bot: `features.py` is a line-by-line port of
  `bot/rust-learned/src/features.rs` (state 73, action 62, FNV-1a card/label id in 2048 buckets); on 5,939 real
  decisions the two give the same numbers (max difference 2e-7, f32 rounding) and the same ids. On top of it
  the JEPA reads card tokens: hand, both boards, leaders and bases, each with its id and live stats.
  Card ids are embedded as the sum of three small tables indexed by different functions of the bucket,
  because a 2048-row gather is a one-hot mask in tinygrad.
- **Training data is shared** too: the "swu-traj/1" games written by `bot/learn/collect.js`
  (`/mnt/project-files/learn/README.md`). The targets are the same seat's next recorded decision (+1) and
  fourth next (+4) in the same game, so the latent future includes the opponent's replies.
- **Losses** (`train.py`), in two stages:
  1. JEPA prediction `‖ẑ_h − sg(Ē(x_{t+h}))‖²` plus VICReg variance and covariance terms on z so it cannot
     collapse. With `--w-value 0` (the default) the encoder learns from this self-supervised loss only.
  2. The value head, either `--value-mode frozen` (V alone on frozen z, ẑ_1, ẑ_4) or `--value-mode predictor`
     (V, predictor and action encoder fine-tuned together on `V(ẑ)` against the outcome while the JEPA loss
     keeps the predictor on target, as in EfficientZero), early-stopped on held-out games.

  Why two stages: v1 trained the value head through the encoder, and it memorised outcomes (a deck's leader
  and base nearly name a training game); its held-out value loss was best at step 500 and then rose.
- **Planning** (`jepa_bot.py`): for each legal move, `score = (1 − mix)·σV(ẑ_1) + mix·σV(ẑ_4)`; best score wins
  (`--temp` samples instead). A loop guard stops it repeating a pick when the same observation keeps coming back.
- **Probes**: after training, ridge regression from z to readable numbers (base HP, hand, board power, ...).
  They only explain the latent on the dashboard ("what it imagines"); they play no part in choosing moves.

Training is tinygrad (CPU). Play is numpy only (`check_parity.py` checks the two forward passes agree to 1e-6),
so the bot starts fast and needs no tinygrad.

## Commands (from the repo root)

```bash
python3 -m pip install tinygrad numpy           # training only; play needs numpy
node bot/learn/collect.js --games 2000 --seed 200000 --workers 4 --out data/traj/rr --bots random-a,random-b
node bot/learn/collect.js --games 1200 --seed 210000 --workers 4 --out data/traj/rush-random --bots rush,random-a
node bot/learn/collect.js --games 800 --seed 220000 --workers 4 --out data/traj/rush-rush --bots rush,rush#2
python3 bot/jepa/data.py --out data/jepa/mix-v1.npz data/traj/rr data/traj/rush-random data/traj/rush-rush
python3 bot/jepa/train.py --data data/jepa/mix-v1.npz --out bot/jepa/models/jepa-v1
python3 bot/jepa/check_parity.py --model bot/jepa/models/jepa-v1.safetensors --data data/jepa/mix-v1.npz
node bot/learn/eval.js --bots jepa,random-a --games 100 --workers 4
python3 bot/jepa/panel.py --thoughts /tmp/jepa-thoughts.json      # dashboard panel (needs /mnt/project-files)
```

Registered bots (`bot/external-bots.json`, `lang: python`): `jepa` (v1, mix 0.5), `jepa-h1` (v1, mix 0, next
decision only) and `jepa-pure` (v2p, the pure-JEPA encoder). `SWU_JEPA_THOUGHTS=<file>` makes the bot write its
latest decision for the panel. Card data is read from `$SWU_CARD_DATA` (default `forceteki/test/json`).

**Use the ladder, not `eval.js`, to measure strength against rule bots.** `bot/learn/eval.js` and `collect.js`
build each bot once per worker and reuse it across games. Rush keeps a loop-guard map of positions it has seen,
so in later games it thinks it is looping and passes early. Head-to-head numbers against rush from `eval.js` are
too kind to the other bot (jepa looked 41-18 there and is 2-8 on the ladder). `bot/ladder.js` builds fresh bots
for every game.

## Results

Ladder `jepa-ladder-1` (`/mnt/project-files/results/jepa-ladder-1`): 6 bots, 10 games per pair, seeds from both
seats, 150 games, 1 engine error.

| Bot | BT Elo | Record | ms / decision |
|---|---|---|---|
| rust-greedy2 | 2081 | 49-1 | 3.2 |
| rush | 1661 | 35-15 | 0.15 |
| jepa-h1 | 1491 | 26-24 | 9.3 |
| jepa | 1422 | 22-28 | 10.3 |
| jepa-pure | 1276 | 13-36 | 12.5 |
| random | 1069 | 4-45 | 0.01 |

jepa beats random 9-1, loses to rush 2-8 and to rust-greedy2 0-10. jepa-h1 beat jepa 7-3; jepa beat jepa-pure 8-2.

Model versions (`models/*.train.json` hold the training logs; safetensors for v1, v2 and v2p):

| Model | Recipe | Held-out value acc. | vs rush (eval.js) | vs rust-greedy2 (eval.js) |
|---|---|---|---|---|
| v1 (`jepa`, `jepa-h1`) | V trained with the encoder, step-500 checkpoint | 0.702 | 41-18 | 2-57 |
| v2 | encoder on JEPA loss only, V on frozen latents | 0.719 | 10-29 | 1-37 |
| v2p (`jepa-pure`) | v2, then predictor + action encoder + V tuned on V(ẑ) | – | 29-30 | – |
| v3 | as v2, plus 1500 rust-greedy2 games | 0.738 | 11-49 | 0-60 |
| v3p | v3, then predictor + V tuned | – | 12-47 | 2-58 |
| v1p | v1, then predictor + V tuned (encoder frozen) | – | 6-53 | – |

The eval.js columns are against the handicapped rush (see above): compare rows with each other only.

**Lesson: better at predicting the winner is not better at choosing moves.** The only label is who won. Every
later version learned "who is ahead" better (up to 74% on unseen games) and played worse. Choosing a move needs
the difference between moves from one position, and the outcome label says almost nothing about that, least of
all in lopsided games (adding rust-greedy2 games made it worse). The latent is fine: linear probes read the board
back with R² 0.95 to 0.99. The weak part is the score on imagined futures, and the test below traces that to the predictor.

## Which part is weak (oracle test)

Swap one part for a perfect stand-in and see what changes. Protocol v2 lets a bot play moves on a private copy of
the game (`sim`), so `jepa_bot.py --score` can replace the predictor's imagined future with the real one:

- `--score sim-v` (`jepa-sim-v`): play each move on the copy, then score the real next position with the same
  encoder and value head. A perfect predictor.
- `--score sim-eval` (`jepa-sim-eval`): the same real position, scored by the position-evaluation thread's
  `linear-deck-g4` (`bot/eval`) through `eval_helper.js`. A perfect predictor and a better judge.
- `--log <file>` with any score mode writes all three score lists for every action window, and
  `oracle_report.py` compares them.

Inside a simulation the opponent plays like rush (the training data's main opponent; a stand-in that always
passed made Pass look best). `--judge round` (default) plays both seats rush-style to the end of the round's action
phase and scores my first decision after it; `--judge window` scores my next action window, which favours Pass and
Claim Initiative because they get judged after the next draw. Moves that change nothing (a cancelled click) score 0.
Simulations are only allowed at action windows, so the other 63% of decisions (targets, cards, resources) still
use the imagined score, and a 2.5 s guard falls back to it when time runs short.

```bash
python3 bot/jepa/oracle_report.py jepa-h1.jsonl --json report.json
```

Results on jepa-h1's own action windows (about 2,600 per run; ladders `jepa-oracle-1-window` and
`jepa-oracle-2` in `/mnt/project-files/results`):

| Comparison | run 1 (window): agree / chance, ρ | run 2 (round): agree / chance, ρ |
|---|---|---|
| imagined vs real, same value head | 16% / 25%, −0.44 | 48% / 38%, 0.46 |
| imagined vs real, evaluator | 15% / 25%, −0.50 | 31% / 36%, −0.18 |
| value head vs evaluator, both real | 63% / 25%, 0.97 | 59% / 36%, 0.77 |
| score spread over a position's moves, imagined / real | 3.3 / 16.9 pts | 3.0 / 4.2 pts |

*Agree* = both rank the same move first; ρ = Spearman over one position's moves, median over positions.

**The predictor is the weak part.** The encoder holds the board and the value head ranks real futures like the
fitted evaluator. The imagined futures barely differ between moves, and their ranking is near or below chance. The
likely cause is the data: each game shows one move per position, so the predictor learns roughly the average
future. A better predictor should raise imagined-vs-real agreement toward the value-head-vs-evaluator level.

Play does not separate the parts yet: the test bots were +83 / +161 Elo over jepa-h1 in run 1 and −110 / −160 in
run 2, inside the ±100 noise of 10 games per pair, because most of their decisions still come from imagination.
Next: train the predictor on simulated branches (every legal move from sampled positions) and re-run the
comparison.

## Training the predictor on branches (v1b)

Eric's pick after the oracle test. `branches.js` plays rush and random games and, at a third of the action windows
(the only place the engine rolls back exactly), plays every legal move on the same game with rollback, then both
seats play on until the mover's next and 4th next decision. `branch_train.py` fine-tunes the predictor and the
action encoder on those futures, with the encoder and value head frozen: the plain error plus the error after
subtracting each position's mean over its moves (the part that tells moves apart), mixed with recorded games.

```bash
node bot/jepa/branches.js --games 1000 --workers 4 --seed 700000 --bots rush,random --out data/branch/rush-random
node bot/jepa/branches.js --games 800 --workers 4 --seed 710000 --bots rush,rush --out data/branch/rush-rush
python3 bot/jepa/branch_train.py --model bot/jepa/models/jepa-v1.safetensors --branches data/branch/rush-random \
    data/branch/rush-rush --data data/jepa/mix-v1.npz --cache data/jepa/branches-v1.npz --out bot/jepa/models/jepa-v1b
```

1,800 games gave 30,417 branch points (about 5 moves each) in 40 minutes; 1% of games ended early on engine errors
after a rollback (known engine bug 6 in the repo CLAUDE.md, plus bug 7). v1b and the numbers below predate
`--w-terminal`: moves that end the game before their target (2% before the next decision, 8% before the 4th) were
left out of training and of the held-out comparison; both now use the result. On 2,983 held-out branch points the
imagined ranking of moves got much closer to the real one:

| Score of a move vs the real future | v1 | v1b |
|---|---|---|
| next decision: median ρ, top-1 agree (chance 31%) | 0.43, 43% | 0.69, 61% |
| 4 decisions on: median ρ, top-1 agree (chance 30%) | 0.40, 38% | 0.50, 43% |

On the bots' own action windows in a ladder (`results/jepa-branch-2`, judged after the round as in the oracle
test), v1b's ranking also agrees with `linear-deck-g4` on the real future (ρ 0.40, top-1 53% vs chance 48%) where
v1's did not (ρ −0.16, 34% vs 38%).

**It plays worse.** `jepa-branch-2` (10 games per pair): jepa-h1 1542 (29-31), jepa-b (v1b, mix 0.5) 1431,
jepa-h1b (v1b, mix 0) 1378 (19-41); jepa-h1 beat jepa-h1b 9-1. v1b also changed the prompts branches cannot cover
(same pick as v1 in 24% of resource prompts, 70% of target prompts, 48% of action windows), so `jepa-h1w` uses v1b
in action windows only (`--window-model`). `jepa-branch-3` (20 games per pair): jepa-h1 1414, jepa-h1b 1299,
jepa-h1w 1278; jepa-h1 beat jepa-h1w 13-7 and jepa-h1b 14-6. So the window choices themselves got worse.

**Lesson: a predictor that tracks the real next position better does not make this planner stronger.** The
yardstick from the oracle test (imagined-vs-real agreement) rose and play fell. This fits the oracle runs, where the
perfect predictor (`jepa-sim-v`) was not clearly stronger either. What limits the bot is the planning itself: one
move scored by V a short way ahead, while 63% of decisions are follow-up and resource prompts it plans no further.
jepa-h1 (v1) stays the JEPA entry.

## Planning whole moves (jepa-plan)

`--score plan` (registered as `jepa-plan`: model v1, mix 0) plans each action window on the referee's copy of the game
(protocol v2 simulations). Every candidate move (the 16 best by the imagined score, plus Pass) is played together with
its follow-up choices: at each of my follow-up prompts (targets, cards, options) the best 6 options by the imagined
score each get a line of their own, 3 at the second level, the greedy choice below that. The opponent's prompts inside
my move are played like rush. A line stops where the move has settled: anyone's next action window, the end of the
action phase, or the end of the game. The value head scores that real position (an opponent-to-act position is read as
my action window, the same way for every move); a move's score is its best line. The chosen line's follow-up choices
are replayed at the real follow-up prompts while the prompt matches; resource prompts and anything else use the
imagined score.

```bash
node bot/ladder.js --bots jepa-plan,jepa-h1,rush,rust-greedy2,h@linear-deck-g4 --games 20 --workers 4 --seed 860000 --id jepa-plan-1
```

Result (`results/jepa-plan-1`, 20 games per pair, random decks, seats alternate):

| Bot | W-L | BT Elo | vs jepa-plan |
|---|---|---|---|
| rust-greedy2 | 63-17 | 1723 | 17-3 |
| h@linear-deck-g4 | 60-20 | 1693 | 16-4 |
| rush | 37-43 | 1483 | 9-11 |
| **jepa-plan** | 33-47 | 1446 | |
| jepa-h1 | 7-73 | 1155 | 5-15 |

Planning whole moves lifts the bot by about 290 Elo: it beats jepa-h1 15-5 and rush 11-9, where jepa-h1 went 0-20
against rush in the same run (3-17 and 2-8 in the branch runs). It planned all 2,014 of its action windows, 9.6 lines
and 0.32 s each (no window ran out of time); 1,308 follow-up prompts were answered from the plan, 29 plans were dropped
because the real prompt differed, and 2,288 resource prompts plus about 200 other prompts used the imagined score.

So the planning scope was the main limit. h@linear-deck-g4 plans the same way (each move with its first follow-up
choices, judged where the move settles, `bot/players/heuristic.js`) and answers the other prompts with hand-written
rules; it also runs inside the engine, so its lookahead sees the real hidden cards. The remaining gap (about 250 Elo)
therefore sits in the scorer (value head against the fitted linear-deck evaluator) and the unplanned prompts, mostly
resources, which simulations cannot reach (sims are allowed only in action windows). A run of the same planner scored
by the linear-deck evaluator would measure the scorer's share. jepa-plan was then the JEPA entry (now jepa-plan-r, below).

## Learning from recorded games (jepa-plan-r)

The real-deck gauntlets left thousands of recorded games between strong bots. `from_replays.js` turns them into
training rows: each game is played again on the engine from its header (decks, seed, key), and at every recorded
decision with more than one legal action the acting seat's view, prompt and legal actions are written as
`collect.js` writes them for live games, with the recorded choice. A game that drifts from its recording is dropped
(none did).

```bash
R=/mnt/project-files/human-meta/realdeck; L=/mnt/project-files/results
node bot/jepa/from_replays.js --out data/traj/replays --workers 4 $R/ash-gauntlet-cclock-1 $R/ash-gauntlet-cclock-2 \
  $R/ash-gauntlet-ismcts-1 $R/ash-heuristic-1 $R/ash-h4-1 $R/ash-learned-vh-1 $R/ash-rust-search-1 $R/ash-ismcts-1 \
  $L/atlas-map-1 $L/eval-ladder-6 $L/eval-ladder-7 $L/eval-ladder-8
python3 bot/jepa/data.py --out data/jepa/replays.npz data/traj/replays
python3 bot/jepa/resource_policy.py fit --out bot/jepa/models/resource-v1.json data/traj/replays
```

Data: 7,840 games (1,003,147 decisions, 687 distinct deals) from 12 runs, mostly the real-deck gauntlets of c-clock,
heuristic, h4, learned-vh, rust-search and ismcts.

**Better value heads did not play better.** On held-out games of the new data:

| Model | Recipe | Brier | Accuracy |
|---|---|---|---|
| v1 | as before (3,480 random-deck games) | 0.203 | – |
| v1r | v1, value head refit on the new data (`--init`, `--steps 0`) | 0.171 | 0.733 |
| v4 | trained from scratch on the new data (8,000 + 6,000 steps) | 0.146 | 0.786 |

Played as the planner's scorer, none of them moved: jepa-plan 12.1%, with v1r 13.7%, and with the fitted
linear-deck-g4 evaluator as scorer 16.4% (all against c-clock, below).

**The leak was resourcing.** The planner only plans action windows; the resource prompts used the imagined score,
which often skipped resourcing. In sample games jepa-plan had 4.3 resources at round 5, c-clock 6.0.
`resource_policy.py` copies the resource choices of c-clock and rust-search in the recorded games: a conditional
logit over the offered hand cards (cost bands, card type, off-aspect, second copy, space, and a weight per card seen
at least 30 times) and a logistic model for "resource nothing" in the regroup phase. On held-out games it picks the
teacher's card 66% of the time (features only 64%, a hand rule 64%, chance 22%) and the stop choice 97.5%.
`--resource <model.json>` uses it at every resource prompt; `--resource rule` uses the hand rule (heuristic.js's
keep score, resource every time) as an ablation.

Fresh deals against c-clock (27 real decks from `bot/decks/ash-meta-2026-09.json`, seats alternate, one secret key
for every run, so each bot plays the same deals; these deals are outside the gauntlets the models learned from):

| Bot | Wins | Paired with jepa-plan-r (same deals) |
|---|---|---|
| **jepa-plan-r** (v1 + resource-v1) | 266/694 = 38.3% ± 3.6 | |
| jepa-plan-rr (v1 + hand rule) | 247/693 = 35.6% ± 3.6 | r alone won 71, rr alone 53 |
| jepa-plan-r4 (v4 + resource-v1) | 149/458 = 32.5% ± 4.3 (stopped) | r alone won 68, r4 alone 50 |
| jepa-plan-eval (scorer linear-deck-g4) | 28/171 = 16.4% ± 5.5 (stopped) | |
| jepa-plan-v1r (v1r) | 39/284 = 13.7% ± 4.0 (stopped) | |
| jepa-plan (v1) | 32/264 = 12.1% ± 3.9 (stopped) | r alone won 82, jepa-plan alone 6 |

Standard bot test (`npm run realdeck:test -- --bot jepa-plan-r`, 702 games vs c-clock):
35.2% [31.7, 38.8], Elo −106; between lisp (37.7%) and h@linear-deck-g4 (33.2%). Its deals overlap the
gauntlets the resource model learned from, so the fresh-deal number above is the cleaner one.

In 60 recorded games against c-clock (`--record`, 30 per bot), jepa-plan had 3.4 resources when round 3's action
phase started and 4.3 at round 5, where c-clock had 4.0 and 6.0; jepa-plan-r had 4.0 and 6.0.

Random decks (`results/jepa-plan-r-1`, 20 games per pair, seats alternate):

```bash
node bot/ladder.js --bots jepa-plan-r,jepa-plan,rush,rust-greedy2,h@linear-deck-g4 --games 20 --workers 4 --seed 870000 --id jepa-plan-r-1
```

| Bot | W-L | BT Elo | jepa-plan-r vs it |
|---|---|---|---|
| h@linear-deck-g4 | 55-25 | 1613 | 7-13 |
| rust-greedy2 | 48-32 | 1559 | 11-9 |
| **jepa-plan-r** | 44-36 | 1529 | |
| rush | 27-53 | 1403 | 13-7 |
| jepa-plan | 26-54 | 1395 | 13-7 |

So the resource picker learned on real decks carries over to random decks (about +130 Elo over jepa-plan).

So resourcing at all is most of the gain (12% to 36%), and learned picks add about 3 points over the hand rule.
The new value head trained on strong-bot games (v4) plays worse than v1 with the same resource model, although it
predicts the winner better. jepa-plan-r is the JEPA entry.

`jepa-plan-reval` (registered) is jepa-plan-r with linear-deck-g4 scoring the planner's settled positions: run on the
same deals, it says whether the value head is now the main limit.
