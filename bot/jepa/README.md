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
  `bot/rust-learned/src/features.rs` (state 73, action 62, FNV-1a card/label id in 2048 buckets). On top of it
  the JEPA reads card tokens: hand, both boards, leaders and bases, each with its id and live stats.
  Card ids are embedded as the sum of three small tables indexed by different functions of the bucket,
  because a 2048-row gather is a one-hot mask in tinygrad.
- **Training data is shared** too: the "swu-traj/1" games written by `bot/learn/collect.js`
  (`/mnt/project-files/learn/README.md`). The targets are the same seat's next recorded decision (+1) and
  fourth next (+4) in the same game, so the latent future includes the opponent's replies.
- **Losses** (`train.py`): JEPA prediction `‖ẑ_h − sg(Ē(x_{t+h}))‖²`; VICReg variance and covariance terms on z
  so it cannot collapse; value BCE on `V(z)` (grounds the latent) and on `V(sg(ẑ_h))` (so the planner's scorer
  is calibrated on imagined latents). The predictor gets no gradient from the value loss: it stays a pure
  latent world model.
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

Registered bots (`bot/external-bots.json`, `lang: python`): `jepa` (mix 0.5) and `jepa-h1` (mix 0, next decision
only). `SWU_JEPA_THOUGHTS=<file>` makes the bot write its latest decision for the panel. Card data is read from
`$SWU_CARD_DATA` (default `forceteki/test/json`).
