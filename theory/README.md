# Theory of optimal SWU play evaluation (Lean 4)

A formal model of "how good is this position?" for Star Wars Unlimited, checked by Lean 4 and
Mathlib. Every theorem below is fully proven: no `sorry`, only Lean's three standard axioms
(`propext`, `Classical.choice`, `Quot.sound`).

## Build

```bash
cd theory
lake exe cache get   # fast path; needs cache.mathlib.org to be reachable
lake build           # without the cache this builds ~1000 Mathlib files (~20 min on 4 cores)
```

Toolchain: `leanprover/lean4:v4.34.0`, Mathlib `v4.34.0`. In the Claude Code cloud container,
`release.lean-lang.org` and `cache.mathlib.org` were blocked, so elan was installed from
`raw.githubusercontent.com`, the toolchain tarball was downloaded from GitHub releases and linked
with `elan toolchain link`, and Mathlib was built from source.

## The model (`SwuTheory/Game.lean`)

One game for one fixed deal, seen by an omniscient observer: a finite-horizon two-player zero-sum
game with chance. A state holds everything (deck orders, hands, board, RNG position). `kind s` is
`max` (player 1 acts), `min` (player 2), `chance` (a shuffle or random pick) or `terminal`.
Moves are finite and nonempty. `height s` bounds the moves left and drops with every move.
Values are rational, because SWU's randomness is uniform over finite sets.

## What is proven

| Theorem | File | Plain meaning |
|---|---|---|
| `value_bellman`, `value_unique` | Value | The true value exists and is the only function that agrees with its own one-step lookahead. |
| `value_mem_Icc` | Value | With win = 1 and loss = 0, the value is a probability. |
| `search_exact` | Value | A search that reaches the end of the game returns the true value, whatever the evaluator (the endgame prover). |
| `search_value` | Value | A perfect evaluator gains nothing from deeper search. |
| `search_error` | Value | Search never makes a uniform evaluator error bigger. |
| `search_ge_value` | Value | An optimistic evaluator stays optimistic under search. |
| `residual_bound` | Value | If the evaluator's TD error is at most ε everywhere, its true error is at most ε × (moves left + 1). |
| `polVal_best`, `saddle_point` | Policy | Perfect policies exist for one deal, form an equilibrium, and reach the value. |
| `greedy_regret` | Policy | Greedy 1-ply play with an ε-accurate evaluator loses at most 2ε per remaining move, against any opponent. |
| `tdLoss_eq_zero_iff`, `value_minimizes_tdLoss` | Fitness | The perfect evaluator is the unique zero of the self-consistency (TD) loss on any closed set of positions. |
| `tdLoss_bound` | Fitness | TD loss ≤ m ε² (weights ≥ m) gives error ≤ ε × (moves left + 1). |
| `tdLoss_needs_closure` | Example | Without the positions' successors in the data, zero TD loss proves nothing. |
| `sq_loss_decomp`, `mean_minimizes_sq_loss` | Fitness | Fitting to game results learns the mean result. |
| `outcome_target_bias` | Fitness | That mean is the value of the play that made the games; vs a perfect opponent it is ≤ the true value. |
| `value_mapPayoff_mono` | Transform | Without chance, only the order of results matters. |
| `value_affine`, `rescore_flips_lottery` | Transform | With chance (SWU shuffles), a score must be calibrated: affine rescoring is safe, a merely monotone one can flip a decision. |
| `omniscience_bias`, `_min`, `_strict` | Information | Seeing hidden cards before choosing is worth ≥ choosing blind: omniscient evaluation overrates the side to move. |
| `maximin_le_minimax`, `maximin_lt_minimax_pennies` | Information | Answering a simultaneous prompt in order favors whoever answers second. |
| `perf_diff` | Hidden | Value minus what two policies get = expected sum, along their play, of each move's loss in true value. |
| `regret_bound` | Hidden | If each player-1 move gives up at most δ of true value, player 1 keeps ≥ value − δ × (moves left) against anyone. |
| `Info`, `Info.blind`, `blind_le_value`, `blind_gap` | Hidden | Information sets for player 1 and blind (observation-only) policies; the omniscient value overrates any blind player, by exactly its expected regret along play. |
| `pimc_choice_loss`, `blind_choice_loss_ge`, `pimc_loss_nonneg` | Hidden | At one information set, PIMC's move loses exactly the omniscience bias in expectation, and no blind move loses less. |
| `hiddenCoin_blind` | Hidden | A whole game where every blind policy gets 1/2 and the omniscient value is 1. |
| `coinFlip_value` | Example | The assumptions are consistent (a concrete game satisfies them). |

## What is assumed, not proven

- **Every SWU game ends** (the `height` field). Not derived from the card rules.
- **Shuffles are chance nodes with fresh randomness.** The real engine uses one shared RNG stream,
  so a search on the real seed can steer later shuffles. The model matches the engine only if
  shuffle results are frozen per event or drawn independently.
- **One fixed deal, perfect information.** Real SWU hides hands and deck order. Its true value
  is a Nash equilibrium of an imperfect-information game (exists by Nash/Kuhn); that is cited,
  not formalized. The Information and Hidden files bound the gap: at one decision, and over a
  whole game for a blind player 1. Not formalized: that the belief PIMC samples from equals the
  true conditional distribution of hidden cards given the play so far, which is what turns
  `perf_diff` plus `pimc_choice_loss` into "the omniscient value overrates PIMC by the expected
  sum of the information sets' biases along play". Player 2's information sets are not modelled
  (the opponent is omniscient or arbitrary).
- **Simultaneous prompts** (mulligan, setup and regroup resourcing) have a mixed-strategy value
  between maximin and minimax (von Neumann's minimax theorem, cited, not formalized).
- **Policy values are expected game results.** `polVal` is defined as that expectation by
  recursion; there is no separate formal model of sampled game trajectories.

## Measured: the PIMC gap on real endgames (`measure/pimc_bias.py`)

`bot/omni-rs/src/bin/omni-pimc.rs` takes the last 8 action windows of recorded games in the omni-rs
card subset. For each window it re-deals what the side to move cannot see (the opponent's hand,
face-down resources and deck together, keeping zone sizes, and the order of its own deck), 8 deals including the real
one. It solves every legal move in every deal with the Rust prover (depth 12, 20,000 nodes per
solve) and reports `E[best per deal] − best average`, the gap of `pimc_choice_loss`. Unproven moves
count as anywhere in [0, 1], which gives bounds on the gap.

```sh
cargo build --release -p omni-rs
node bot/omni/rs/trace.js --pool bot/omni/rs/pool.json --bots heuristic,heuristic --seeds 201-230 --out replays/pimc-traces --gzip
target/release/omni-pimc replays/pimc-traces/*.jsonl.gz --deals 8 --last 8 --nodes 20000 > pimc.jsonl
python3 theory/measure/pimc_bias.py pimc.jsonl
```

2026-10-11, 120 games (heuristic/heuristic, aggro/control, tempo/rush, random/heuristic; seeds
201-230), 960 windows: 740 had a proven move on the real deal; in 529 the gap is pinned down, and
it is 0 in all of them, so the sum along every game (163 player-games) is 0. Hidden cards changed
some move's value in 3 of the 740 windows; in the two that settled, a move that wins in every deal
existed. The other 211 windows are not settled within the budget (gap between 0 and its upper bound). Limits:
the subset has units only (no events, no leader actions), the windows that settle are mostly the
last 4, and the belief ignores what the opponent's earlier choices reveal.
