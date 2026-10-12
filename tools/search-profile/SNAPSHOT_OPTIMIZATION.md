# Snapshot and rollback optimization — October 11, 2026

Follow-up: [ongoing-effect target optimization](EFFECT_OPTIMIZATION.md).

Implemented a cached restore recipe for each engine class, plus a single pass
for snapshot collection and transient-object cleanup. The strongest measured
benefit comes from the restore cache: it reduced native ISMCTS search time by
**6.7–8.7%** in the two positions tested with that change isolated. Rust showed
little benefit from the cache alone. Combined results across all five positions
are mixed, with several gains and small regressions; the tables below retain both.

The baseline **already includes the previous prompt-legality optimization**.
At measurement time, these changes were built locally and uncommitted inside
the engine submodule on `2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`.

## Why this target

The existing engine already avoids cloning every object's old state during
rollback. However, `copyState` walks the same class hierarchy and decorator
metadata for every object on every restore. Prior CPU samples put its own work
at roughly 5–11% of native search time. That repeated discovery is avoidable
without changing snapshot ownership or game rules.

[GameObjectUtils.ts](https://github.com/ericfode/forceteki/blob/2ebed8ca2dce46ced42ca90de470e0f427c596dd/server/game/core/GameObjectUtils.ts) now
builds the ordered restore recipe once and caches it in a `WeakMap` keyed by the
actual instance prototype. Recipes hold field names and hydration functions;
each restore reads fresh state and resolves references in the current game.
Derived/base order, duplicate wrapper traversal, primitive setter calls, bulk
copy behavior, and restoration hooks remain intact.

[GameStateManager.ts](https://github.com/ericfode/forceteki/blob/2ebed8ca2dce46ced42ca90de470e0f427c596dd/server/game/core/snapshot/GameStateManager.ts)
now compacts the registered-object list in place, preserves retained registration
order, removes unused mappings, and collects the snapshot record in that same
pass. This replaces temporary sets, a filter, and a separate record-building pass.

Snapshots still use the same V8-serialized buffer format and deep isolation.
Nested arrays, maps, sets and `stateValue` payloads can change in place, which
makes sharing live state or reusing decoded snapshots unsafe without additional
mutation tracking. Every retained object still receives its restoration hooks;
automatic snapshots used for cost-payment recovery remain enabled.

## Five-position comparison

Each row uses five measured old/new pairs after two warmup pairs, with alternating
variant and mode order. Baseline and optimized engines run in separate persistent
Node processes to preserve their module-private metadata symbols. Only one worker
executes a sample at a time. Each sample resets the bot and uses a fresh verified
shadow. Startup, fixture replay, IPC and initial shadow construction are excluded.

| Position | Rust median ms, old → new | Rust paired reduction | ISMCTS median ms, old → new | ISMCTS paired reduction |
|---|---:|---:|---:|---:|
| Seed 1, round 2 | 107 → 105 | 5.2% | 301 → 290 | −2.3% |
| Seed 1, round 3 | 127 → 120 | 9.1% | 416 → 362 | 13.1% |
| Seed 1, round 4 | 174 → 167 | 2.1% | 544 → 498 | 8.5% |
| Seed 2, round 4 | 387 → 410 | −3.9% | 588 → 544 | 3.4% |
| Seed 2, round 6 | 368 → 359 | −0.8% | 658 → 623 | 4.2% |

“Paired reduction” is the median of each pair's `100 * (1 - new / old)`;
negative values indicate regressions. It is not the ratio of the separate
medians, so the direction can differ on noisy rows. These are small samples on
an uncontrolled shared desktop (Apple M5 Max, macOS arm64, Node 22.22.3).
Separate process JIT and heap histories add variability. Small gains or
regressions should be treated as uncertain, and there is no uniform speedup claim.

## Which change helped

Two additional comparisons held one optimized component fixed while changing
the other, using the same five-pair/two-warmup method on both round-4 positions.

| Isolated change | Seed 1 Rust | Seed 1 ISMCTS | Seed 2 Rust | Seed 2 ISMCTS |
|---|---:|---:|---:|---:|
| Cached restore recipe | 0.3% | 8.7% | −1.6% | 6.7% |
| Snapshot collection/compaction | −1.1% | 0.2% | 2.6% | −2.6% |

This supports the restore cache as the principal useful change for native
search. The compaction change removes passes and allocations, but these timings
do not establish a material end-to-end gain from it alone. Rust performs fewer
restores than native ISMCTS in these workloads, limiting its benefit.

The separately rerun instrumented profile gives the following representative
component medians for seed 1, round 4:

| Engine work | Rust, old → new | ISMCTS, old → new |
|---|---:|---:|
| Retained-object snapshot construction | 31.0 → 26.5 ms | 64.1 → 58.4 ms |
| Object-state restoration | 17.6 → 11.9 ms | 153.1 → 114.6 ms |
| Snapshot / restore calls | 61 / 6, unchanged | 118 / 66, unchanged |

These are unpaired instrumented component timings, not additional end-to-end
speedup estimates. Snapshot construction here excludes the factory's separate
serialization of `game.state`. CPU sampling also showed `copyState` self time
falling from 7.7 to 3.7 ms in the Rust sample and 48.1 to 39.8 ms in the native
sample; sampling and JIT attribution are approximate.

## Verification

- Full engine suite: **8,987 specs, 0 failures, 9 pending**.
- Whole-suite undo mode: **8,799 specs, 0 failures, 17 pending**.
- **13 new regression specs** pass on both original and optimized implementations.
  They cover cold/warm restoration, inherited ordering and wrapper duplicates,
  bulk copy, same-name class isolation, references across separate games, all
  reference containers, null/undefined values, retained registration order,
  monotonic IDs, unchanged buffer format, and deep state isolation over repeated
  deserializations and rollbacks.
- Full engine ESLint and card validation pass (2,071 card files, 2,048 card test
  files). Root unit tests pass **134/134**.
- Seeded determinism gate retains **594 / 342 / 486 steps**, with **p2 winning all
  three**, identically with and without recording.
- The same complete search profiles were rerun: four modes on seed 1 rounds
  2/3/4 and Rust/ISMCTS on seed 2 rounds 4/6. All **157 samples per version** match
  in fixture states, decisions, request/reply hashes, work counts and native
  search results. There are zero simulator errors or failed native playouts.
- Across the main comparison and both isolated comparisons, all **90 measured
  pairs** and **36 warmup pairs** match in behavior. Every search also verifies
  that the real root remains unchanged.

Pending tests are existing disabled tests and dedicated undo suites skipped by
the whole-suite undo harness. Network-dependent tests used loopback access for
their local fixtures. No external analysis service was used.

## Evidence and reproduction

See the committed [measurement summary](MEASUREMENTS.md) for portable metrics,
test totals and hashes. Paths under `results/` below identify local evidence
excluded from the repository; they are not downloadable artifacts.

- [Harness instructions](README.md#snapshot-and-rollback-comparison)
- Verification summary and source hashes (`results/search-profile-snapshot-baseline/verification.json`)
- Main paired samples (`results/search-profile-snapshot-paired/comparison.json`)
- Restore-cache isolation (`results/search-profile-snapshot-hydration-ablation/comparison.json`)
- Snapshot-compaction isolation (`results/search-profile-snapshot-compaction-ablation/comparison.json`)
- Baseline profiles: seed 1 (`results/search-profile-snapshot-before-seed1/profile.json`), seed 2 (`results/search-profile-snapshot-before-seed2/profile.json`)
- Optimized profiles: seed 1 (`results/search-profile-snapshot-after-seed1/profile.json`), seed 2 (`results/search-profile-snapshot-after-seed2/profile.json`)
- Normal engine tests (`results/search-profile-snapshot-baseline/engine-tests-final.log`), undo tests (`results/search-profile-snapshot-baseline/engine-tests-undo.log`), original-code regression check (`results/search-profile-snapshot-baseline/focused-tests-original.log`)

Raw measurements and logs are local gitignored files under `results/`.
