# Ongoing-effect target optimization — October 11, 2026

The largest remaining avoidable hotspot in the effect-heavy search positions is
ongoing-effect target checking. The fresh baseline puts ongoing-effect resolution
at **28–35%** of sampled search time in seed 2, with target validation accounting
for **19–23%**. The earlier seed-1 positions spend more time in action legality
and snapshot/rollback work. The bottleneck depends on the board.

The baseline already includes the prompt-legality cache and the previous
snapshot/rollback changes. At measurement time, all engine changes were local
and uncommitted.

## Change and safety

[OngoingCardEffect.ts](https://github.com/ericfode/forceteki/blob/2ebed8ca2dce46ced42ca90de470e0f427c596dd/server/game/core/ongoingEffect/OngoingCardEffect.ts)
previously could call `target.isBlank()` twice per non-source-only candidate,
including effects that granted neither an ability nor a keyword. Each call can
scan the target's ongoing effects three times.

The two conditions now check the effect kind before checking blanking:

```ts
this.impl.valueWrapper.isGainAbility() && target.isBlank()
this.impl.type === EffectName.GainKeyword && target.isBlank()
```

`isBlank` only reads the target's effects; the current `isGainAbility`
implementations return constant booleans. The effect type is readonly and its
value wrapper is already initialized. Reordering these pure checks avoids
irrelevant scans. It retains the source restrictions, partial blanking rules,
keyword removal rules, hidden-zone exception, targeting shortcuts, and dynamic
value evaluation. No game-state cache or invalidation mechanism was added.

## Search measurements

The original full profile was repeated before and after the change: seed 1
rounds 2/3/4 in all four modes, and seed 2 rounds 4/6 in Rust and ISMCTS.
All 157 samples per version perform identical verified work.

The separate paired comparison uses isolated persistent engine processes, fresh
shadows and reset bots, alternating execution order, and disabled span clocks.
Only `OngoingCardEffect.js` differs between workers. Startup, preparation and
interprocess commands are outside the search timer.

The first run used five measured pairs after two warmup pairs per position/mode.
Its small gains and large timing outliers justified one longer confirmation run
across all five positions, with ten measured pairs after three warmup pairs.
Both runs are retained; none of their samples are discarded.

| Position | Rust paired reduction | ISMCTS paired reduction |
|---|---:|---:|
| Seed 1, round 2 | -1.9% | 1.7% |
| Seed 1, round 3 | -0.1% | 0.8% |
| Seed 1, round 4 | 0.2% | 0.1% |
| Seed 2, round 4 | 1.6% | 1.3% |
| Seed 2, round 6 | 1.2% | 0.7% |

These pooled medians use all **15 measured pairs per position/mode**. The
effect-heavy positions show only about **0.7–1.6%** improvement when both runs
are retained. The smaller Rust position regresses by **1.9%**. Most other small
position changes are near zero. The initial seed-2 gains of 1.5–3.9% shrank
to −0.1–1.2% in the longer run. This supports a small reduction in redundant
work, but not a reliable, broadly material wall-time improvement.


Percentages are medians of individual `100 * (1 - after / before)` reductions;
negative values mean slower searches. Separate median times and every raw pair
are available in the linked data. Shared desktop load and separate process JIT
and heap histories remain uncontrolled. These measurements do not establish a
uniform speedup or improved playing strength.

The fresh CPU profiles still put ongoing-effect resolution at roughly 27–30% of
seed-2 search time after the change. Blanking checks beneath target validation
fell in sampled milliseconds in all four seed-2 recordings, but the size varies
and CPU attribution is approximate. This is a small reduction in that work,
not removal of the whole bottleneck.

## Behavior verification

- Full engine suite: **8,995 specs, 0 failures, 9 pending**.
- Whole-suite undo mode: **8,807 specs, 0 failures, 18 pending**.
- **8 new focused specs pass**, covering full/partial blanking, ability sources,
  keyword removal, hidden-zone Smuggle, source-only and explicit-card targets,
  dynamic recalculation, and rollback. The original implementation passes the
  seven behavior specs and fails only the assertion that irrelevant blanking
  scans must be skipped, as expected.
- Root tests: **134/134 pass**. Engine ESLint, new-test ESLint, production/test
  builds, and card validation pass (2,071 card files, 2,048 card test files).
- Determinism gate: **594 / 342 / 486 steps**, **p2 winning all three**, identical
  with and without recording.
- Full-profile comparisons retain identical fixtures, chosen actions,
  request/reply hashes, simulator work counts, and native search results. No
  simulator errors or failed native playouts occurred. Every search checks that
  the real root remains unchanged.

Across both paired runs, all **150 measured pairs** and **50 warmup pairs**
match in decisions, protocol traces, work counts and native search results.

Pending tests are existing disabled tests and dedicated undo suites skipped by
the whole-suite undo harness, including the new dedicated rollback test that
passes in the normal suite. Network-dependent tests used localhost fixtures.
These checks establish equivalence for the exercised cases, not an exhaustive
proof over every possible game state.

## Evidence and reproduction

See the committed [measurement summary](MEASUREMENTS.md) for portable metrics,
test totals and hashes. Paths under `results/` below identify local evidence
excluded from the repository; they are not downloadable artifacts.

- [Harness instructions](README.md#other-engine-modules)
- Verification summary and hashes (`results/search-profile-effects-baseline/verification.json`)
- Original five-pair run (`results/search-profile-effects-paired/comparison.json`)
- Ten-pair confirmation (`results/search-profile-effects-confirmation/comparison.json`)
- CPU attribution comparison (`results/search-profile-effects-baseline/cpu-comparison.json`)
- Baseline profiles: seed 1 (`results/search-profile-effects-before-seed1/profile.json`), seed 2 (`results/search-profile-effects-before-seed2/profile.json`)
- Optimized profiles: seed 1 (`results/search-profile-effects-after-seed1/profile.json`), seed 2 (`results/search-profile-effects-after-seed2/profile.json`)
- Normal engine tests (`results/search-profile-effects-baseline/engine-tests-normal.log`), undo tests (`results/search-profile-effects-baseline/engine-tests-undo.log`), original-code regression check (`results/search-profile-effects-baseline/focused-tests-original.log`)

Raw measurements and logs are local gitignored files under `results/`.

The next change, [candidate discovery caching](CANDIDATE_CACHE.md), reuses unchanged
arena/base membership while keeping effect conditions and values live.
