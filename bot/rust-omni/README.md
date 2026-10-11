# rust-omni

rust-search with its playouts in the native rules simulator (`bot/omni-rs`). Registered as `rust-omni` in
`bot/external-bots.json`; build with `cargo build --release` at the repo root (binary `target/release/swu-omni-bot`).

    node bot/rust-omni/pool-decks.js --n 8 --seed 2 --out replays/pool-decks.json
    node bot/ladder.js --bots rust-omni,rust-search --decks replays/pool-decks.json --games 56 --key none

How it works, at each action window:

1. **Map the real position.** Both deck lists come in `hello`, so every card id names a known card even while it is
   hidden (`src/view.rs` `Table`, numbered like the engine). From the referee's board view it builds several guesses of
   the hidden cards (my deck order; the opponent's hand, resources and deck) and loads each into the simulator.
2. **Check the mapping.** Every action the referee offers must be exactly one simulator action and the other way
   round. If not, or a card is outside the simulator's pool, it plays as rust-search and says why once on stderr.
3. **Search.** Greedy2's best 8 actions are the candidates; an attack is one candidate per target. Each candidate
   is played on every guess (8 by default), then greedy2 plays both seats to the end of the round's action phase
   inside the simulator, and rust-search's board score rates the result. The best average wins; the attack target
   it picked is played at the target prompt that follows.

Everything runs in-process: about 10 ms per decision, against about 120 ms for rust-search's referee simulations.
The board score is rust-search's, except that base HP counts 2.0 per point (1.35 there): see the results below.

The simulator only knows its card pool (`bot/omni/rs/pool.json`: 8 bases, 3 leaders, 88 keyword-only units), so
rust-omni only searches games where both decks come from that pool. Any other game is a rust-search game.

Settings for experiments (`env` in `bot/external-bots.json`): `SWU_OMNI_WIDTH` (8), `SWU_OMNI_DEALS` (8),
`SWU_OMNI_STEPS` (400 per playout), `SWU_OMNI_TARGETS` (1: score each attack target; 0: greedy2 picks targets),
`SWU_OMNI_POOL`, and rust-search's score weights `SWU_EVAL_*`.

## Results

Pool decks only, both seats per seed, `--key none`, forceteki 2be4fcd. 56-game rows: 8 decks
(`pool-decks.js --n 8 --seed 2`), seeds 101-128, the same games for every row. ms = harness time per decision.

| rust-omni setting | vs rust-search | vs c-clock | ms |
| --- | --- | --- | --- |
| greedy2 picks the attack targets | 25-31 | | 8 |
| attack targets scored, base 1.35 | 31-25 | 14-42 | 10 |
| same, 24 guesses per candidate | 33-23 | | 28 |
| same, one more round per playout | | 16-40 | 19 |
| same, playouts to the end of the game (8 / 32 guesses) | | 16-40 / 16-40 | 51 / 201 |
| same, units x2 / units x1.5 and base 2.0 | | 16-40 / 19-37 | |
| **base 2.0 (default)** | **33-23** | **20-36** | 8-11 |
| base 3.0 / 4.0 / 6.0 | 29-27 / / | 22-34 / 21-35 / 20-36 | |
| (reference) rust-search, rust-greedy2 | | 14-42, 13-43 | 92, 1 |

On 6 other decks (`--seed 1`), seeds 1-15: 18-12 against rust-search with greedy2 picking targets, 20-10 with
targets scored.

c-clock beats every greedy2-based bot on these decks by about the same margin (its race clock decides when to hit
the base). Longer playouts and more guesses did not close the gap; valuing base damage more did, partly. On these
keyword-only decks most games end the same whatever the search setting (46-54 of 56 winners agree between rows), so
small differences are noise.
