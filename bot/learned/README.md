# Learned bot: a tiny world model + action model (tinygrad)

A small neural network that plays SWU through the normal bot interface. Training is in Python with
[tinygrad](https://github.com/tinygrad/tinygrad); playing is plain JS (`model.js`, no dependencies), so the bot runs
in-process in `bot/tournament.js` like the heuristic bot.

## The network

One encoder and three heads, trained together (`train.py`):

| Part | Input -> output | Trained on |
|---|---|---|
| `enc` | state features (68) -> latent `z` (128) | through the heads below: this is the "world model" encoding |
| `val` | `z` -> expected result for the deciding seat, `tanh`, -1..+1 | final game results |
| `pol` | `[z, prompt (26), action (56)]` -> one logit per legal action, softmax over the legal set | the teacher's choice |
| `dyn` | `[z, action]` -> change in state features after the action | recorded transitions |

Features (`features.js`) are computed from the seat's observation (`observe.js`): the replay snapshot plus card uuids,
with the opponent's hand removed. It has the same shape as the stdio protocol's `state`, so a non-JS bot can rebuild
the same inputs. Printed card stats (cost, power, HP, keywords) come from `forceteki/test/json/Card` (`cards.js`).

## Bots

| Name | What it does | Speed |
|---|---|---|
| `learned-pi` | Plays the policy head's top action at every prompt. A loop guard lowers actions already tried in the exact same position, so pick-then-cancel loops end. | ~1 ms a decision |
| `learned-v` | The heuristic bot's one-ply engine lookahead (`bot/players/heuristic.js`), with positions scored by the value head instead of the hand-written formula. Other prompts use the policy. | like `heuristic` |

Model file: `$SWU_LEARNED_MODEL`, default `models/learned/current.json`. Both bots read only their own seat's view.

## Pipeline

```bash
# 1. teacher-labelled games (heuristic bot = teacher); run several workers with different seeds
node bot/learned/gen.js --out data/learned/run1/w0 --games 150 --seed 10000 --teacher 0.35
# 2. train (python3 -m pip install tinygrad numpy). JITBEAM=1 makes tinygrad search kernel variants: the first run
#    spends ~20 min compiling (cached on disk after that), then a step is ~3x faster than without it
JITBEAM=1 python3 bot/learned/train.py --data data/learned/run1 --data data/learned/traj-random --out models/learned/current.json --steps 4000
node bot/learned/check-model.js models/learned/current.json     # JS forward pass == tinygrad, on saved cases
# 3. play: parallel round-robin in the tournament format (+ ladder.json for the dashboard)
node bot/learned/arena.js --bots learned-pi,random --games 40 --workers 4 --seed 50000 --out replays/learned-vs-random --record
# 4. self-play data: the student plays the unlabelled windows instead of random moves
node bot/learned/gen.js --out data/learned/run2/w0 --games 150 --seed 20000 --student models/learned/current.json
```

Games from other threads in the shared "swu-traj/1" format (`/mnt/project-files/learn/README.md`) convert with
`node bot/learned/from-traj.js --in <dir> --out data/learned/traj-x/w0 [--labels played]`. Without `--labels played`
they only train the value head (use that for random games).

`gen.js` details: the heuristic's search costs 1-3 s per action window, so only `--teacher` (a fraction) of action
windows get a search label; every other prompt gets the heuristic's cheap rule-based choice. The behaviour policy plays
the teacher's label with probability `--follow` (0.85), otherwise the student (with `--student`) or a random action.
Output format is described at the top of `gen.js`.

`panel.js` writes the research dashboard panel (`/mnt/project-files/dashboard/panels/learned-world-model.json`):
model metrics, what the value head reacts to, arena standings, and, with `SWU_LEARNED_THOUGHTS` set while games run,
the bot's last decision (policy probabilities and value).

## Results so far

See `/mnt/project-files/results/learned-v1/` (ladder) and the dashboard panel. With 411 teacher games, `learned-pi`
copies the teacher on ~60% of held-out action windows (chance 18%) and ~82% of other prompts (chance 28%), and beats
random 29-10 over 40 games with no search. The value head overfits (held-out MSE ~0.85 vs 1.0 for guessing 0).

## Limits

- Teacher labels are imitation: `learned-pi` can at best copy the heuristic bot, and it is trained on games where
  most unlabelled windows were random moves. Self-play rounds (step 4) are how it gets past that.
- The dynamics head is trained and measured but no bot uses it yet. The next step is lookahead without the engine,
  which also works for stdio bots that cannot `mark`/`restore`.
- Distribute splits are still random (`env.js` decides them), as for every in-process bot.
