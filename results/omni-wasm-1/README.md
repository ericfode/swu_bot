# JavaScript, native Rust and WebAssembly comparison

Measured on October 11, 2026 at commit `4d06bdc`, on an Apple M5 Max with Node 22.22.3,
Rust 1.98.0 and wasm-bindgen 0.2.129. This report covers the original **100-card pool**.
It predates the generic card-program interpreter and makes no performance claim for the expanded catalog.
The Node and browser builds contain the same 604,202-byte Wasm binary. State, checkpoints,
and complete proof searches stay inside Wasm; no JavaScript callback runs per search node.

## Correctness

The JavaScript adapter replayed **300 complete games, 57,604 decisions and 25,949 action-window snapshots**
with zero differences in legal actions, full state or terminal result. The original corpus SHA-256 receipts
are in [the native report](../omni-rs-1/coverage.json); Wasm receipts are in [check-results.jsonl](check-results.jsonl).
The six committed regression fixtures also pass. A real browser loaded the ES module and Wasm, cloned state,
ran a 761-node winning proof and completed a 10,000-window rollout. Its receipt is in [summary.json](summary.json).

## Fresh endgame comparison

The JavaScript baseline was rerun for `aggro,control` and `tempo,rush`, seeds 101–108 each.
Each implementation received the same 103 attempted positions from the 16 games. Native and Wasm received
the JavaScript solver's measured wall-clock allowance for each exact position, with depth limit 12.
JavaScript used its default depth limit 8, cumulative 2,000-node budget per window, and stopped after two unknown windows.

| Measurement | JavaScript | Native Rust | Wasm through JS |
|---|---:|---:|---:|
| Positions proved | 66 / 103 | 102 / 103 | 102 / 103 |
| Total search time | 336.23 s | 11.98 s | 13.33 s |
| Time including state import and JS call | — | — | 13.36 s |
| Search nodes visited | 96,002 | 2,522,663 | 2,081,321 |
| Weighted time per search node | 3,502.33 µs | 4.75 µs | 6.40 µs |
| Mean earliest proof, windows before recorded ending | 4.44 | 6.38 | 6.38 |
| Maximum observed distance before ending | 10 | 12 | 12 |

**All 66 shared proofs agree on the winner.** Wasm finished this workload in **25.17× less elapsed time**,
including its imports, while proving more positions. Its average per-node cost was about 547× lower;
node accounting differs between the two provers, so this is not a universal engine speedup.
Wasm initialization plus pool loading took 9.40 ms; importing all 103 positions took 31.49 ms total.

The horizon is censored by the JavaScript sampling boundary: Rust proved the earliest sampled position in
15 of 16 games. These measurements do not establish its maximum reach. `fromEnd` measures distance in the
recorded bot game, not proof depth. The incomplete position was `aggro-vs-control-108`, window 64.

## Simulator throughput

Three fixture states each ran one million complete action-window transitions. Each transition includes
the resulting prompts and state hash. These rollouts exclude transposition-table search and setup cost.

| Fixture | Native µs/window | Wasm µs/window |
|---|---:|---:|
| heuristic-vs-heuristic-1 | 3.80 | 3.79 |
| heuristic-vs-heuristic-2 | 4.21 | 4.03 |
| random-vs-random-1 | 4.78 | 4.12 |
| Weighted mean | 4.26 | 3.98 |

All three pairs have identical decision counts and 64-bit checksum hex strings. This is one sequential
measurement on a development laptop with other compiler work active, not evidence that Wasm is inherently
faster than native. Both comfortably exceed the original 40 µs/window target. Wasm had a 10,000-node warmup
per fixture; setup is excluded. The full rows and exact checksums are in [summary.json](summary.json).

## Reproduce

```sh
npm run wasm:build -- --install-tools
npm run wasm:test
node bot/omni/wasm/check.js replays/omni-rs-corpus/*.jsonl.gz

# Repeat for tempo,rush; filenames include the pairing.
node bot/omni/solve-games.js --pool bot/omni/rs/pool.json --bots aggro,control --seeds 101-108 --budget 2000 --stop 2 --sample 0 --out replays/omni-wasm-js-baseline
node bot/omni/export-positions.js replays/omni-wasm-js-baseline replays/omni-wasm-positions.jsonl --pool bot/omni/rs/pool.json
node tools/omni-rs-report.js prepare replays/omni-wasm-js-baseline replays/omni-wasm-positions.jsonl replays/omni-wasm-matched.jsonl
node bot/omni/wasm/prove.js replays/omni-wasm-matched.jsonl --depth 12 --ms-field jsMs
target/release/omni-rs prove replays/omni-wasm-matched.jsonl --depth 12 --ms-field jsMs

node bot/omni/wasm/bench.js bot/omni-rs/tests/fixtures/heuristic-vs-heuristic-1.jsonl.gz 1000000 1
target/release/omni-rs bench bot/omni-rs/tests/fixtures/heuristic-vs-heuristic-1.jsonl.gz --nodes 1000000
```

`js-positions.jsonl` retains measured JS outcomes and budgets but omits full states. Regenerate full exported
positions using the commands above. Individual proof receipts are in `wasm-proof-results.jsonl` and
`native-proof-results.jsonl`. Corpus generation and coverage limits are documented in the native report.
