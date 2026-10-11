# Card batch 001

This batch adds **114 runtime-admitted cards**, taking the pool from 450 to 564.
The requested batch of 100 is recorded in `manifest.json`; 14 additional cards
became executable through the same rule families. Source conversion rises from
612 to 723 (273 to 384 source-AST cards; 339 metadata-only cards unchanged).
Of the 111 newly source-converted cards, 31 still have explicit runtime blockers.
There are no admission regressions. The catalog contains 2,458 known cards;
1,894 remain outside the executable pool.

The final manifest was selected **after exploratory family implementation**.
`baseline.json` preserves the original 450-card baseline at `8c66ea6`.
`exploratory-queue.json` and its context preserve the earlier alphabetical helper
demonstration; it was not the selected batch. `after.json` and `report.json`
provide the per-card accounting. Admission is separate from conformance.

## Tested behavior

All 146 committed engine recordings match native Rust and WebAssembly:
**12,929 decisions, 4,453 action windows, and 146 terminal results**.

| Corpus | Games | Purpose |
| --- | ---: | --- |
| `play` | 109 | Each new hand-play card actually played in a completed engine game |
| `constant` | 7 | Static self/aura stats, source departure, lethal changes, all three new bases |
| `leader` | 2 | Both new leaders' actions, deployment and relevant deployed behavior |
| `phase` | 12 | Signed/stacked/zero modifiers, expiry, death, bounce, token cleanup and conditional effects |
| `query` | 7 | Lexical target capture, arena filtering, simultaneous expiry, nested and sequential selections |
| `query-edge` | 2 | Optional internal selection and missing-target behavior |
| `unique` | 7 | Unique choices, aura activation, entering lethal units and queued triggers after source death |

Generators assert the intended positive or edge-case outcomes. Their witness
files deliberately retain the generation-time `unassessed` label.
`verification.json` records the subsequent successful native/Wasm comparisons,
source and binary hashes, and exact commands. `receipt-index.json` binds every
trace and pool by SHA-256. `family-witness-index.json` maps candidates to positive
and negative cases and the native/Wasm checks. CI compares these immutable recordings with the
**current** generated programs, so later compiler changes must still agree.

The unchanged original 300-game corpus also passes in both builds: 57,604
decisions and 25,949 action windows. Both earlier committed corpora (6 original
and 16 expanded games), 82 Rust core tests, the full 112-test Rust workspace,
173 repository JS tests, 25 compiler/accounting/exporter tests, and 11 Wasm tests
pass. The packaged Node and browser loaders pass isolated import/search checks.

## Reproduce

Use Node 22 and the pinned engine source/build `2be4fcd`. This batch used an
isolated export and fresh build because another writer was editing the shared
engine checkout. Do not reuse a build from different source.

```sh
npm run cards:compile
npm run cards:check
npm run cards:test
npm test
cargo test --locked --workspace
cargo build --locked -p omni-rs --release
npm run wasm:build
npm run wasm:test
npm run wasm:pack
npm run wasm:pack:check
```

`card_batch_conformance.rs` and `card-batches.test.js` discover every indexed
batch. For one corpus, pass its own `pool.json` to either checker:

```sh
target/release/omni-rs check bot/omni-rs/tests/card-batches/001/query/*.jsonl.gz --pool bot/omni-rs/tests/card-batches/001/query/pool.json --catalogue bot/card-compiler/generated/catalog.json
node bot/omni/wasm/check.js bot/omni-rs/tests/card-batches/001/query/*.jsonl.gz --pool bot/omni-rs/tests/card-batches/001/query/pool.json --catalogue bot/card-compiler/generated/catalog.json
```

## Review and process

GPT-6.1 Sol workers implemented the batch at low reasoning effort. An independent
Sol reviewer used high effort to inspect all 114 new card sources and shared
semantics. Review and differential testing found and fixed lexical query
capture, phase-expiry death batching/order, nested selection commitment and
menus, ineffective Ambush ordering, leader Shielded deployment, zero modifiers,
discard type filtering, stale-pool accounting, Unique timing, and entry-trigger capture before defeats.

The repository conversion skill incorporates those failures.
`skill-forward-test.json` records an independent low-effort readiness trial and
its limits. Finite differential cases do not prove every possible interaction;
uncertain rule shapes remain rejected, including collection effect targets and
both-player resource readiness.
