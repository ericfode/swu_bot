# Ongoing-effect candidate cache — October 11, 2026

The engine now reuses the candidate list for effects targeting `AnyAttackable`
while arena and base membership are unchanged. In the effect-heavy search
positions, the combined change reduces target checks by **40–52%** and paired
search time by **6.6–11.5% for Rust** and **5.7–6.2% for ISMCTS**. Smaller
positions range from **1.5% slower to 3.0% faster**.

The baseline already includes the prompt-legality, snapshot/rollback and
blanking-check optimizations. At measurement time, the engine was built
locally with these changes uncommitted.

## What is cached

[OngoingCardEffect.ts](https://github.com/ericfode/forceteki/blob/2ebed8ca2dce46ced42ca90de470e0f427c596dd/server/game/core/ongoingEffect/OngoingCardEffect.ts)
previously fell back to every registered card for `AnyAttackable`, even though
that filter can only accept cards in the ground arena, space arena or base zone.
The current card definitions use it for effects granted by attached upgrades.
This caused repeated deck, hand and resource scans during effect resolution.

A per-game WeakMap now holds the ordered arena-and-base candidate list. Its key
checks:

- The registered-card ID array's identity and length, including token additions.
- Both arenas' card-array identities.
- Each base zone's leader, credit and upgrade arrays, plus its base and Force token.

Current zone APIs replace these arrays when membership changes. Rollback
replaces the registered-card array and hydrates the zone collections, invalidating
the cache before restored effects are reconciled. A miss filters `game.allCards`,
preserving the original registration order. Every call returns a fresh array so
callers cannot modify the cached list.

Activation, conditions, controller/type restrictions, blanking, custom matching,
and dynamic recalculation still run normally. Existing targets are revalidated
even after they leave the candidate zones. Source-only, explicit-card, `Any`,
arena and other concrete-zone paths retain their existing behavior. Explicit
card targets can bypass zone filters, so they do not enter this cache.

This is a bounded cache of candidate discovery. Effect predicates can read
damage, exhaustion, initiative, phase, watcher history and mutable collections;
the existing effect dirty flag does not track all of those dependencies. Reusing
complete effect results would require a broader dependency contract.

## Measured work reduction

Separate diagnostic decisions count actual calls; their timings are not used as
benchmarks. All ten diagnostic searches match the normal-profile decisions,
protocol traces and native results. Effect-resolution calls, accepted-target
checks, and static/dynamic recalculation counts also match before and after.

| Position / search | Target checks before → after | Candidate queries / rebuilds | Reused queries |
|---|---:|---:|---:|
| Seed 2, round 4 / Rust | 152,163 → 73,138 | 844 / 49 | 94.2% |
| Seed 2, round 4 / ISMCTS | 138,818 → 81,325 | 602 / 120 | 80.1% |
| Seed 2, round 6 / Rust | 110,697 → 65,406 | 476 / 58 | 87.8% |
| Seed 2, round 6 / ISMCTS | 154,887 → 92,326 | 666 / 126 | 81.1% |

The target-check totals include every effect. Other effects still account for
substantial work; for example, Ewok Archers has an `Any`-zone predicate that
ultimately only accepts its source.

## Search timings

The original full profile was repeated before and after: seed 1 rounds 2/3/4 in
all four modes, and seed 2 rounds 4/6 in Rust and ISMCTS. All **157 samples per
version** match in fixtures, chosen actions, request/reply hashes, simulator work,
and native search results. These runs include instrumentation controls and CPU
recordings.

The separate timing comparison uses isolated persistent engine processes, fresh
shadows and reset bots, alternating execution order, and disabled span clocks.
Only the compiled `OngoingCardEffect.js` differs between workers. Startup,
preparation and interprocess commands are outside the search timer.

The first run used five measured pairs after two warmup pairs per position/mode.
Large outliers prompted one confirmation across every position, with ten measured
pairs after three warmup pairs. The table pools **all 15 pairs per position/mode**;
no samples were discarded.

| Position | Rust paired time reduction | ISMCTS paired time reduction |
|---|---:|---:|
| Seed 1, round 2 | 2.4% | 1.0% |
| Seed 1, round 3 | 2.6% | -1.5% |
| Seed 1, round 4 | -1.4% | 3.0% |
| Seed 2, round 4 | 11.5% | 6.2% |
| Seed 2, round 6 | 6.6% | 5.7% |

Percentages are medians of individual `100 * (1 - after / before)` reductions,
not ratios of separate median times. Negative values mean slower searches.
Shared desktop load and independent process JIT/heap histories remain uncontrolled;
the raw data includes large outliers. These measurements support a useful gain
on the effect-heavy positions, not a uniform speedup or improved playing strength.

A separate **50-pair ablation** retains the narrower candidate list but rebuilds
it on every query. Adding caching to that version reduces paired time by
**5.7–9.7% for Rust** and **4.4–4.7% for ISMCTS** on seed 2. Seed-1 changes range
from -0.7% to 2.0%. This establishes a measured benefit from reuse in the tested
effect-heavy positions. Ablation percentages are separate experiments and should
not be added to or subtracted from the combined percentages.

The CPU recordings support the target-check reduction. On seed 2 round 4,
sampled effect-resolution time falls from **117.6 to 88.1 ms for Rust**, and
**154.1 to 107.9 ms for ISMCTS**. On round 6, ISMCTS's effect-resolution share is
essentially unchanged (26.4% → 26.6%), despite fewer checks. The new cache helper
costs 2.7–7.0 sampled milliseconds across seed 2; total `Game.allCards` attribution
is mixed. Single CPU recordings provide approximate attribution, not precise
speedup estimates. Inclusive categories overlap.

## Behavior checks

- Full engine suite: **9,005 specs, 0 failures, 9 pending**.
- Whole-suite undo mode: **8,817 specs, 0 failures, 19 pending**.
- **10 new focused specs pass**, covering shared reuse, registration order,
  fresh returned arrays, same-count swaps, both arenas, base tokens, leader
  deployment, base upgrades, token creation/removal, live controller/condition
  checks, dynamic values, blanking, explicit targets and warmed-cache rollback.
- The four focused eligibility/value specs also pass against the original module.
- Root tests: **134/134 pass**. Production/test builds, engine ESLint, new-test
  ESLint and card validation pass (2,071 card files, 2,048 card test files).
- Determinism gate: **594 / 342 / 486 steps**, **p2 wins all three**, with identical
  results with and without recording.
- Combined and ablation runs retain **200 matching measured pairs and 70 matching
  warmup pairs**. No simulator errors or failed native playouts occurred. Every
  search verifies that the real root remains unchanged.

Pending tests are disabled existing tests and dedicated undo cases skipped by
the whole-suite undo harness. The new dedicated rollback case passes in the
normal suite. These checks establish equivalence for the exercised cases.

## Evidence and reproduction

See the committed [measurement summary](MEASUREMENTS.md) for portable metrics,
test totals and hashes. Paths under `results/` below identify local evidence
excluded from the repository; they are not downloadable artifacts.

- Verification script (`results/search-profile-targets-baseline/verify.cjs`) and verified results, counts and hashes (`results/search-profile-targets-baseline/verification.json`)
- Five-pair comparison (`results/search-profile-targets-paired/comparison.json`), ten-pair confirmation (`results/search-profile-targets-confirmation/comparison.json`), cache-only ablation (`results/search-profile-targets-cache-ablation/comparison.json`)
- Diagnostic counters (`results/search-profile-targets-baseline/count-effects.cjs`), before counts (`results/search-profile-targets-baseline/effect-counts.json`), after counts (`results/search-profile-targets-baseline/effect-counts-after.json`)
- CPU comparison (`results/search-profile-targets-baseline/cpu-comparison.json`)
- Before seed 1 (`results/search-profile-targets-before-seed1/profile.json`), before seed 2 (`results/search-profile-targets-before-seed2/profile.json`), after seed 1 (`results/search-profile-targets-after-seed1/profile.json`), after seed 2 (`results/search-profile-targets-after-seed2/profile.json`)
- Normal engine log (`results/search-profile-targets-baseline/engine-tests-normal.log`), undo log (`results/search-profile-targets-baseline/engine-tests-undo.log`), focused log (`results/search-profile-targets-baseline/focused-tests.log`)

Use the [module comparison runner](README.md#other-engine-modules) with
`--modules core/ongoingEffect/OngoingCardEffect.js`. The preserved pre-change
module is in `results/search-profile-targets-baseline`; the cache-disabled
narrowing-only module is in `results/search-profile-targets-uncached`, generated
by this ablation helper (`results/search-profile-targets-baseline/make-uncached-candidates.cjs`).
The commands and fixture paths are retained in each comparison's metadata.

Raw measurements, preserved modules and logs are local gitignored files under
`results/`.
