# Action-window legality reuse — October 11, 2026

Follow-up: [snapshot and rollback optimization](SNAPSHOT_OPTIMIZATION.md).
The measurements below describe the earlier prompt-legality change.

The engine now computes selectable cards once per prompt refresh. An ordinary
incomplete `ActionWindow.continue()` previously scanned them three times: while
building the prompt and in two highlight passes. The optimized implementation
shares one result and removes the redundant highlight pass.

Across five fixed positions, median paired search-time reductions were **5–16%
for Rust over stdio** and **7–16% for native ISMCTS**. These are approximate local
measurements, with substantial noise in some positions. All 50 measured pairs
matched in behavior and completed the same search work.

## Implementation and lifetime

[ActionWindow.ts](https://github.com/ericfode/forceteki/blob/2ebed8ca2dce46ced42ca90de470e0f427c596dd/server/game/core/gameSteps/ActionWindow.ts)
retains the selectable-card list, mandatory-action flag, and prompt title during
one synchronous `setPrompt()` call. Computation remains lazy at the original first
read. A `finally` block clears the result on both success and exceptions. Later
refreshes, direct prompt reads, and card clicks check current legality afresh.
Rollback continues to rebuild the prompt through the existing pipeline.

The change is one engine source file plus
[eight integration tests](https://github.com/ericfode/forceteki/blob/2ebed8ca2dce46ced42ca90de470e0f427c596dd/test/scenarios/actionPhase/ActionWindowPromptCache.spec.ts).
At measurement time, the engine was rebuilt locally with this optimization
uncommitted on `2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`. The compiled baseline
was preserved before rebuilding.

## Paired measurements

Node 22.22.3, Apple M5 Max, macOS arm64. Each position/mode used two warmup
pairs followed by five measured pairs, alternating old/new order. Each search
used a fresh shadow and reset bot. Startup, fixture replay and first shadow
construction were outside the timer. Span clocks and CPU sampling were off.

| Position | Rust median ms, old → new | Rust paired reduction | ISMCTS median ms, old → new | ISMCTS paired reduction |
|---|---:|---:|---:|---:|
| Seed 1, round 2 | 120 → 113 | 6.4% | 323 → 299 | 9.7% |
| Seed 1, round 3 | 146 → 121 | 15.5% | 476 → 445 | 10.5% |
| Seed 1, round 4 | 182 → 165 | 10.4% | 604 → 504 | 16.3% |
| Seed 2, round 4 | 423 → 421 | 5.4% | 596 → 608 | 8.9% |
| Seed 2, round 6 | 439 → 409 | 6.2% | 768 → 739 | 6.6% |

The reduction is the median of each pair's `100 * (1 - new / old)`, **not** the
ratio of the two separate medians. The seed-2 round-4 ISMCTS row illustrates the
noise: its paired estimate is positive while its separate medians regress.
Individual pairs ranged from an 18% regression to a 25% reduction overall.
Consequently the smaller gains, especially on seed 2, are tentative; this is
not evidence of a guaranteed speedup in every position.

Both implementations ran in the same process by switching only the three
changed `ActionWindow` prototype methods. The current constructor was shared;
its added optional field is transient storage. Prototype replacement can affect
JIT compilation and inline caches. Load on this shared desktop was uncontrolled.
Full samples, ordering, method hashes and compiled-file hashes are in
comparison.json (`results/search-profile-cache-paired/comparison.json`).

## Behavior verification

- The complete engine suite passed: **8,974 specs, 0 failures, 9 pending**.
- Whole-suite undo mode passed: **8,786 specs, 0 failures, 17 pending**. The new
  dedicated rollback test also passed in the normal suite.
- All eight new tests passed, covering scan count, changed resources and unit
  exhaustion, fresh direct reads and clicks, exception cleanup, mandatory attacks,
  and rollback. Running them with the original implementation produced exactly
  three expected scan-count failures: two scans for `setPrompt()`, three for
  `continue()`, and two for the mandatory-attack prompt. The behavioral assertions
  still passed.
- Full engine ESLint and card validation passed (2,071 card files and 2,048 card
  test files checked). Root unit tests passed: **134/134**.
- The seeded game gate retained **594 / 342 / 486 steps**, with **p2 winning all
  three**, identically with and without recording.
- Both full profile runs were repeated: all four modes on seed 1 rounds 2/3/4,
  and Rust/ISMCTS on seed 2 rounds 4/6. Across 157 samples per version, fixture
  states, choices, protocol request/reply hashes and work counts matched. There
  were zero simulator errors or failed native playouts.
- The 50 measured pairs, plus 20 warmup pairs, additionally compared native
  search results and statistics excluding elapsed time. Every comparison matched.
  Every sample verified that search left the real root unchanged.

The initial sandboxed full-suite and root-unit runs failed because local HTTP
test servers could not bind loopback sockets. Both passed when rerun with local
socket access. Pending specs are disabled tests and dedicated undo suites that
the harness skips in whole-suite undo mode.

## Updated profile

In the separately sampled seed-1 round-4 CPU profiles, inclusive
`getCardLegalActions` share fell from **24.3% to 18.7% for Rust** and **30.9% to
21.2% for ISMCTS**. These samples are supporting evidence, not timing estimates
to combine with the paired table; inclusive frames overlap.

Move execution plus rollback still accounts for approximately **80–86% of Rust
search** and **89–93% of native search**. The measured retained-object snapshot
build portion is 10–18% for Rust and 9–13% for native search. Native object-state
restoration alone is 24–29%. Those costs remain inside the engine totals, and
snapshot construction also serializes `game.state` outside that measured portion.

Stdio remains a reasonable boundary: Rust's bot work, JSON, transport and
scheduling together are 4–7% of measured search time. Snapshot construction and
object restoration remain the next substantial areas to investigate.

## Evidence

See the committed [measurement summary](MEASUREMENTS.md) for portable metrics,
test totals and hashes. Paths under `results/` below identify local evidence
excluded from the repository; they are not downloadable artifacts.

- [Reproduction commands and methodology](README.md#paired-optimization-comparison)
- Assertions and profile summary (`results/search-profile-cache-baseline/verification.json`)
- Fresh baseline, seed 1 (`results/search-profile-cache-before-seed1/profile.json`) and seed 2 (`results/search-profile-cache-before-seed2/profile.json`)
- Optimized profile, seed 1 (`results/search-profile-cache-after-seed1/profile.json`) and seed 2 (`results/search-profile-cache-after-seed2/profile.json`)
- Normal engine suite (`results/search-profile-cache-baseline/engine-tests-unrestricted.log`), undo suite (`results/search-profile-cache-baseline/engine-tests-undo.log`), and original-code negative control (`results/search-profile-cache-baseline/focused-tests-original.log`)

Raw data and logs are local, gitignored artifacts under `results/`. The earlier
[profile report](REPORT.md) describes the measurements that motivated this change.
