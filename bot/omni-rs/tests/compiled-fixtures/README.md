# Compiled ability conformance receipts

Sixteen complete games from the unmodified forceteki engine match the Rust
runtime: **3,748 decisions, 1,274 action windows, and every terminal winner**.
The checker compares the complete canonical legal-action set at every prompt and
full state at every action window. These are gameplay comparisons, not an
inventory or admission count.

The corpus uses the exact 450-card pool in `pool.json`. Across these games,
**110 distinct cards were actually played**, including 40 with compiled ability
programs. This does not establish conformance for every admitted card or every
interaction. Leaders and resource/deck-only cards are separate from played-card
coverage.

Twelve ordinary seeded games cover random/random, heuristic/heuristic, and both
mixed pairings (seeds 3001–3003). Four targeted deck games (4001–4004) exercise new
ability families. All choices and outcomes after the initial shuffled deal are
produced by the real engine; off-aspect cards pay their normal costs.

`conformance.json` records exact receipt hashes and positive event witnesses for
all eight primitive families: damage, heal, draw, ready, exhaust, defeat, Shield,
and Experience. The targeted games also include two Shields on one unit, six
Experience tokens on one unit, exhaust-then-Experience, Experience-then-damage,
and defeat-then-select-another-target continuations. `observed-coverage.json`
keeps the per-game played-card and event observations.

These receipts exposed and now cover optional target prompts, choosing an
ineffective target when another target is effective, effectless event
confirmation, unit action-menu ordering, dynamic healing amounts, and token
attachment/removal order. Captured-context continuation factories that the IR
cannot preserve are explicitly rejected by the compiler.

Run from the repository root:

```sh
cargo test -p omni-rs --test compiled_conformance
target/debug/omni-rs check bot/omni-rs/tests/compiled-fixtures/*.jsonl.gz --catalogue bot/card-compiler/generated/catalog.json --pool bot/omni-rs/tests/compiled-fixtures/pool.json
```

To create new receipts without overwriting this immutable pool:

```sh
node bot/omni/rs/make-compiled-fixtures.js --out replays/compiled-card-fixtures --targeted-seeds 4001-4004
```
