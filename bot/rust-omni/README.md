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

Everything runs in-process: about 8 ms per decision, against about 130 ms for rust-search's referee simulations.

The simulator only knows its card pool (`bot/omni/rs/pool.json`: 8 bases, 3 leaders, 88 keyword-only units), so
rust-omni only searches games where both decks come from that pool. Any other game is a rust-search game.

Settings for experiments (`env` in `bot/external-bots.json`): `SWU_OMNI_WIDTH` (8), `SWU_OMNI_DEALS` (8),
`SWU_OMNI_STEPS` (400 per playout), `SWU_OMNI_TARGETS` (1: score each attack target; 0: greedy2 picks targets),
`SWU_OMNI_POOL`, and rust-search's score weights `SWU_EVAL_*`.
