# Generated card programs in native Rust and Wasm

Measured October 11, 2026 against the simulator at `bffd936`. Both Wasm targets
contain the same 1,001,955-byte binary. The compiler discovers every known card;
it does not claim to execute every card.

| Coverage stage | Definitions |
|---|---:|
| Inventoried, excluding test mocks | 2,458 |
| Converted into IR | 612 |
| Of those, compiled from TypeScript source | 273 |
| Of those, plain/keyword cards from metadata | 339 |
| Runtime admitted | 450 |
| Runtime rejected with explicit reasons | 2,008 |

The 450 runtime admissions consist of 112 source-IR cards, 336 metadata-only cards,
and two separately reviewed native token adapters. Every known card appears in
the [catalog and blocker reports](../../bot/card-compiler/README.md).
**All-card conversion remains incomplete.**

## Differential conformance

| Corpus | Games | Decisions | Full action windows | Native mismatches | Wasm mismatches |
|---|---:|---:|---:|---:|---:|
| Original 100-card pool, now using generated programs | 300 | 57,604 | 25,949 | 0 | 0 |
| Expanded 450-card pool | 16 | 3,748 | 1,274 | 0 | 0 |

The checker initializes a game once and compares legal action sets, full state and
terminal outcome throughout. The expanded corpus actually plays **110 distinct cards,
40 with IR abilities**. It witnesses all eight implemented effect primitives and
three continuation patterns; it does not verify every admitted card or interaction.
The [expanded fixtures and receipts](../../bot/omni-rs/tests/compiled-fixtures/README.md)
are committed, including exact pool bytes and input hashes.

A real Chrome browser loaded the ES module with the generated catalog and replayed
`effect-interactions-4001`: 395 decisions, 143 windows, winner `p2`. The browser
observation in [summary.json](summary.json) is explicitly a transcription of tool
output. The full 16-game Wasm corpus was checked in Node.

## Matched endgame benchmark

This repeats the 103 positions and fresh JS time budgets from
[the initial Wasm report](../omni-wasm-1/README.md), now running the generated
programs. The benchmark positions still use the original 100-card pool; these
are not performance measurements across all 450 admitted cards.

| Measurement | JavaScript | Native Rust + IR | Wasm + IR |
|---|---:|---:|---:|
| Positions proved | 66 / 103 | 102 / 103 | 102 / 103 |
| Total search time | 336.23 s | 12.92 s | 13.96 s |
| Time including imports and JS call | — | — | 14.00 s |
| Weighted search-node cost | 3,502.33 µs | 5.76 µs | 6.86 µs |
| Mean earliest proof before recorded ending | 4.44 windows | 6.38 windows | 6.38 windows |

All **66 shared proofs agree**. Wasm completes the tested workload in **24.02× less
elapsed time**, including position imports. Catalog/pool initialization costs
121.44 ms separately; all 103 imports take 33.58 ms combined. Loading the catalog
once amortizes that setup cost over retained games.

Each Rust solve receives the measured elapsed time of its exact JavaScript
position and a depth limit of 12. JavaScript uses depth 8, a cumulative 2,000-node
budget per window solve, and stops after two unknown windows. The horizon remains
censored by that sampling boundary: Rust proves the earliest sampled position in
15 of 16 games. Per-node accounting differs, and these are single runs on a
development machine, not a universal speedup guarantee. Both runs have one
unproved position: `aggro-vs-control-108`, window 64.

```sh
npm run cards:compile
npm run cards:test
npm run cards:check
npm run wasm:build
npm run wasm:test

node bot/omni/wasm/check.js --catalogue bot/card-compiler/generated/catalog.json --pool bot/omni/rs/pool.json replays/omni-rs-corpus/*.jsonl.gz
node bot/omni/wasm/prove.js replays/omni-wasm-matched.jsonl --catalogue bot/card-compiler/generated/catalog.json --pool bot/omni/rs/pool.json --depth 12 --ms-field jsMs
target/release/omni-rs prove replays/omni-wasm-matched.jsonl --catalogue bot/card-compiler/generated/catalog.json --pool bot/omni/rs/pool.json --depth 12 --ms-field jsMs
```

Local checks: 90 Rust workspace tests, 167 JavaScript tests, 12 compiler tests,
and 10 Wasm/adapter tests passed after integrating current main. The daily local
conversion job is authorized to implement and push tested increments; repository
CI runs generation and verification and publishes review artifacts. Neither
changes the pinned engine source or silently admits unsupported rules.
