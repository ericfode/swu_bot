# clj-forecast: a Clojure bot

A Star Wars Unlimited bot written in Clojure. It plays the real forceteki engine through the stdio protocol
(`spec/stdio-protocol.md`): `bot/players/external.js` runs the engine and sends one JSON line per decision; this
process answers with the index of the action it picks.

    bot/clojure/run.sh test                                   # unit tests (mock boards, no engine needed)
    node bot/ladder.js --bots clj-forecast,rush --games 10    # play it (registered in bot/external-bots.json)

Needs Java 11+ only. The first run of `run.sh` downloads Clojure 1.12 and data.json from Maven Central into
`bot/clojure/lib/` (gitignored). With the Clojure CLI, `clojure -M -m swu.main` in this folder does the same.
`run.sh compile` AOT-compiles into `classes/` for a faster start (about 1.5 s from source, once per process).

## How it decides

The engine cannot be rolled back from outside, so the bot keeps its own small model of the board (`board.clj`)
as plain immutable data and plays candidate moves on it. Every move is a pure function from board to board.

- **Model.** Units with power, HP, damage, ready state, shields, and keywords from the card JSON (Raid, Overwhelm,
  Saboteur, Restore, Grit, Sentinel, Ambush, Shielded). Attacks use real combat math: damage both ways at once,
  shields, Overwhelm spill, sentinels, Saboteur. Unit and upgrade plays add their stats; events and When Played
  text are read roughly ("deal 3 damage to a unit", "defeat a unit with 3 or less remaining HP", "draw 2 cards",
  "give a Shield token", ...). Anything it cannot read is valued at about its cost.
- **Evaluation.** Unit value (power, HP left, shields, keywords), base health on a curve that grows steeper near
  zero, a lethal-next-round bonus or threat, and cards in hand.
- **Forecast.** At each action window every legal action is played on the model, then a 3-ply alpha-beta search
  lets the opponent answer with its best attack (or pass), then us, then them. The action with the best result
  is played. The opponent's hand is hidden, so its card plays are not modelled.
- **Budget.** Before that, a knapsack over this round's ready resources picks which hand cards to play, so a
  cheap card does not block a better pair.
- **Other prompts.** Attack targets come from the same search (the target is planned when the attacker is
  clicked). Ability targets read the prompt text (damage, defeat, exhaust, heal, help). Damage splits kill the
  most valuable enemy units first. Resources: keep cheap on-aspect units, resource expensive or off-aspect cards,
  stop ramping around 9-12. Cancels "this will have no effect" prompts and does not retry a card it cancelled
  this round. A loop guard never repeats a choice that led straight back to the same observation.

## Results

One ladder, built once and not tuned on it: `results/clojure-ladder-1` (10 games per pair, seeds 701-705 from both
seats, the same lineup and seeds as `py-clock-ladder-1`, real card data, forceteki 2be4fcd).

| Bot | W-L | Win rate (95% CI) | BT Elo |
| --- | --- | --- | --- |
| rust-greedy2 | 63-7 | 90% (81-95) | 1902 |
| **clj-forecast** | **59-11** | **84% (74-91)** | **1825** |
| rush | 38-32 | 54% | 1529 |
| tempo | 31-38 | 45% | 1455 |
| control | 30-39 | 44% | 1441 |
| heuristic | 29-40 | 42% | 1430 |
| aggro | 23-46 | 33% | 1356 |
| random | 5-65 | 7% | 1062 |

Head to head: 5-5 vs rust-greedy2, 7-3 vs rush, 10-0 vs aggro and heuristic, 9-1 vs tempo, control and random.
Decision time (harness-measured, 5,255 decisions): median 3 ms, p95 about 140 ms, mean 60 ms; the first decision
of a process includes the JVM start and card loading (about 2 s).

## Files

| File | What |
| --- | --- |
| `src/swu/main.clj` | stdin/stdout loop. `$SWU_CLJ_LOG=<file>` appends one line per decision (prompt, actions, pick). |
| `src/swu/cards.clj` | Card stats from `forceteki/test/json/Card/*.json` (`$SWU_CARD_JSON`). |
| `src/swu/board.clj` | Board model, moves, evaluation, alpha-beta search. |
| `src/swu/policy.clj` | One chooser per prompt kind, the knapsack, the loop guard. `$SWU_CLJ_DEPTH` sets the search depth (default 3). |
| `test/swu/policy_test.clj` | Combat math, lethal, kill-the-threat, split legality, prompt counts. |
