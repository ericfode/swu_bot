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

A `d` line is exactly the `decide` message the referee would send that seat (same `bot/view.js`
code), plus `i`, the index that was chosen. Decisions with one legal action are skipped unless `--all`.

Labels: Q and V learn "did the deciding seat win this game"; the world head learns the change of the
board block of the state until that seat's next action window. With random players this makes
Q(s, a) the win rate of "take a, then play randomly", one step of policy improvement over random.
Retraining on the new bot's own games repeats the step.

## Results so far (2026-10-11, 4 CPU cores)

| Model | Trained on | Labels | Head-to-head |
|---|---|---|---|
| learned-v1 | 4000 random-vs-random games (1.56M decisions) | game result | 196-3 vs random-a, 48-52 vs rust-greedy |
| learned-v2 | + 2400 games of v1 (exploring) vs rust-greedy and vs itself | game result | 99-99 vs rust-greedy, 29-10 vs heuristic, 110-89 vs v1 |
| learned-v3td | same data | 50% result, 50% v2's value at my next action window | 110-90 vs v2 |
| **learned-v4** | + 2400 games of v3td vs rust-greedy and itself (8678 games, 2.58M decisions) | 50% result, 50% v3td's value | **199-1 vs random-a, 138-61 vs rust-greedy**, 132-67 vs v3td |

Knobs on v4 against rust-greedy (200 games each, same seeds): plain Q 138-61, `--heur 1` 148-52,
`--world 1` 120-78. The world model predicts the board well enough to train on but does not yet help
as a lookahead. Training takes about 30 s per epoch on CPU; a decision takes well under a millisecond.

Lesson from v3: bootstrapping from the value of the *next decision* made the bot much worse (24-175 vs
rust-greedy). The next decision is usually the target prompt of the same action, so its value says
nothing about the action. Bootstrapping from the next *action window* (after the action resolved) works.

Another round: `node bot/learn/selfplay-round.js --model bot/rust-learned/models/learned-v4.safetensors --next learned-v5`
(records 2400 games of the current model vs rust-greedy and itself, then trains the next model).

## Commands (from the repo root)

```bash
cargo build --release --manifest-path bot/rust-learned/Cargo.toml
bot/rust-learned/target/release/swu-learned train --data data/traj/random-v1 --out bot/rust-learned/models/learned-v1.safetensors --epochs 3 [--teacher M --td 0.5]
bot/rust-learned/target/release/swu-learned explain --model M --data DIR   # what the value head looks at
node bot/learn/eval.js --bots rust-learned,random-a --games 200 --workers 4 [--out results/x] [--record]
node bot/tournament.js --bots rust-learned,rust-greedy --games 10 --out replays/learned
```

Registered bots (`bot/external-bots.json`, all on `models/learned-v4.safetensors`): `rust-learned` (Q only), `rust-learned-world`
(`--world 1`), `rust-learned-heur` (`--heur 1`), `rust-learned-explore` (`--temp 0.3 --epsilon 0.05`, for collecting self-play data). `SWU_LEARNED_THOUGHTS=<file>` makes the bot write its
latest decision (top actions with win chances) for the research dashboard. Card data is read from
`$SWU_CARD_DATA` (default `forceteki/test/json`).
