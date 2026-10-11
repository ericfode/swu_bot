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
