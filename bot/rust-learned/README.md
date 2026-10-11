# swu-learned: a tiny learned bot in Rust (Burn)

A small neural network that learns to play from recorded games, written in Rust with
[Burn](https://burn.dev) and run as a normal bot over the stdio protocol (`spec/stdio-protocol.md`).

## Why Burn

| Library | What it is | Why or why not here |
|---|---|---|
| **Burn** | Pure-Rust deep learning framework: layers, autodiff, optimizers, model files; CPU and GPU backends | Chosen. It feels like PyTorch, trains and runs from one codebase, and needs no C++ libraries. |
| Candle | Hugging Face's Rust tensor library | Made mainly for running big pretrained models; training loops are more do-it-yourself. |
| tch-rs | Bindings to libtorch (PyTorch's C++ core) | Fast, but drags in a ~2 GB native dependency. |

The model is saved as **safetensors**, which tinygrad, PyTorch and Candle can also read.

## The model

About 94k weights (a third of them the card embedding), from one shared state encoder:

```
state (73) ──MLP──> z (128) ──> value head      V(s)    logit of "I win from here"
action (62) + card/label embedding (16) ──> a (64)
[z, a] ──> j (128) ──> action head     Q(s, a) logit of "I win if I take a"      (the action model)
                   └─> world head      W(s, a) change of the board by my next action window (the world model)
```

Features (`src/features.rs`) are computed from the `decide` message only, from the deciding seat's
point of view, so one model plays both seats and training uses the exact same code as play.
Printed card stats (cost, power, HP, type, keywords) come from the engine's card data.

When it plays, each legal action gets

```
score(a) = Q(s, a) + world * V(s + W(s, a)) + heur * H(s + W(s, a))
```

`world` mixes in the world model's predicted board (scored by the value head), and `heur` a
hand-written heuristic `H` on that predicted board (`features::heuristic`). Both default to 0;
`--temp` samples instead of taking the best, `--epsilon` adds random moves. A loop guard stops it
from choosing the same thing again when an identical observation keeps coming back.

## Training data ("swu-traj/1")

`node bot/learn/collect.js --games 4000 --workers 4 --out data/traj/random-v1 [--bots random-a,random-b]`
plays games through the normal match loop (any bots, including external ones) and writes
`shard-<seed>.jsonl.gz`, one gzip member per game:

```jsonl
{"t":"game","seed":100000,"bots":["random-a","random-b"]}
{"t":"d","seq":3,"you":"p1","prompt":{...},"state":{...},"actions":[...],"i":1}
{"t":"end","seed":100000,"winner":"p1","outcome":"won","round":15,"steps":369,"error":null}
```

A `d` line is exactly the `decide` message the stdio adapter would send that seat (same `observe.js`
code), plus `i`, the index that was chosen. Decisions with one legal action are skipped unless `--all`.

Labels: Q and V learn "did the deciding seat win this game"; the world head learns the change of the
board block of the state until that seat's next action window. With random players this makes
Q(s, a) the win rate of "take a, then play randomly", one step of policy improvement over random.
Retraining on the new bot's own games repeats the step.

## Commands (from the repo root)

```bash
cargo build --release --manifest-path bot/rust-learned/Cargo.toml
bot/rust-learned/target/release/swu-learned train --data data/traj/random-v1 --out bot/rust-learned/models/learned-v1.safetensors --epochs 3
node bot/learn/eval.js --bots rust-learned,random-a --games 200 --workers 4 [--out results/x] [--record]
node bot/tournament.js --bots rust-learned,rust-greedy --games 10 --out replays/learned
```

Registered bots (`bot/external-bots.json`): `rust-learned` (Q only), `rust-learned-world`
(`--world 1`), `rust-learned-heur` (`--heur 1`). `SWU_LEARNED_THOUGHTS=<file>` makes the bot write its
latest decision (top actions with win chances) for the research dashboard. Card data is read from
`$SWU_CARD_DATA` (default `forceteki/test/json`).
