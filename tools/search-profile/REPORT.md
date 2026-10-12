# Search profile — October 11, 2026

Follow-up: [implemented prompt-refresh optimization and before/after results](OPTIMIZATION.md).
This report preserves the original, pre-optimization measurements.

**Keep stdio. The main cost is running and restoring the game engine during
search.** Across five fixed positions, move execution plus rollback used
81–85% of Rust search time and 90–93% of native ISMCTS time. Protocol board views
used another 8–9% for Rust; bot computation, wire JSON, pipes and scheduling
together used 5–7%. Parent-side wire JSON alone was 0.45–0.61%.

These are fresh local measurements on an Apple M5 Max, macOS arm64, Node
22.22.3. Repository HEAD was `9bbdcc1cfae6115bc73dc5b3e52559b93e8d2fe0` and engine
pin `2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`. Existing unrelated studio edits
were left alone. No engine or production bot source was changed.

## Isolated search workload

Only one decision is measured at each prepared root. Engine startup, fixture
creation, child startup, and first shadow replay are excluded. Each repetition
resets bot state and uses a fresh, verified shadow. Seed 1 uses two warmups and
five repetitions per mode, each with and without active span timers. Seed 2 uses
one warmup and three repetitions. Modes and span/control order alternate.

| Root | Legal root actions / units | Rust simulated actions | Rust search median | ISMCTS playouts | ISMCTS search median |
|---|---:|---:|---:|---:|---:|
| Seed 1, round 2 | 7 / 2 | 51 | 149 ms | 42 | 387 ms |
| Seed 1, round 3 | 9 / 2 | 67 | 176 ms | 54 | 494 ms |
| Seed 1, round 4 | 11 / 4 | 88 | 232 ms | 66 | 707 ms |
| Seed 2, round 4 | 9 / 4 | 137 | 484 ms | 54 | 698 ms |
| Seed 2, round 6 | 9 / 7 | 132 | 385 ms | 54 | 722 ms |

Times are medians of controls without active span clocks. Rust and ISMCTS use
different algorithms and horizons: the columns are not a speed contest. Native
ISMCTS has fresh belief state at each root, with no earlier game observations.
All searches completed their expected work; Rust stayed below its internal
three-second cap. There were no simulator errors or failed ISMCTS playouts.

## Where time goes

Percentages below divide each category's summed time by summed search time over
the instrumented repetitions for that root. These top-level categories do not
overlap. The ranges are across roots, so range endpoints should not be summed.

| Work | Rust search over stdio | Native ISMCTS |
|---|---:|---:|
| Execute moves, rules, prompts and automatic snapshots | 64–80% | 51–63% |
| Roll back to the root, including rebuilding the prompt | 5–18% | 30–39% |
| Construct board, prompt and action responses | 8–9% | Not used |
| Sample hidden cards | Included in simulator remainder | 4–7% |
| Bot + wire JSON + pipes + scheduling | 5–7% | No pipe |

In native ISMCTS, tree selection was about 0.1% of search time and leaf evaluation
about 0.6–1%. Most of the remaining bot work was hidden-card sampling and small
policy/bookkeeping operations. Rewriting the tree-selection loop would miss the
dominant costs.

### Evidence concerning stdio

The exact same JavaScript search was run in-process and over stdio on all three
seed-1 roots. Request traces, normalized simulator replies, and final choices
matched across transports and repetitions. A live end-to-end comparison is noisy
at these small deltas: even the ordering of medians reverses at one root. It does
not justify a precise pipe-speedup claim.

A separate control replayed each recorded simulator response to the real bot,
without running the engine. The request sequence and final action were checked:

| Recorded search | Simulator exchanges | Engine-free search median |
|---|---:|---:|
| JS stdio, seed 1 rounds 2 / 3 / 4 | 40 / 50 / 63 | 1.54 / 2.00 / 2.54 ms |
| Same JS, in-process | 40 / 50 / 63 | About 0.02 ms each |
| Rust stdio, seed 1 rounds 2 / 3 / 4 | 58 / 74 / 95 | 1.66 / 2.38 / 2.87 ms |
| Rust stdio, seed 2 rounds 4 / 6 | 144 / 139 | 5.14 / 4.55 ms |

Each tape result is the median of seven repeats after one warmup. This measures
bot work plus JSON, pipe and scheduling together; it does not isolate pure pipe
latency. Larger live exchange residuals may reflect different wakeup/cache/GC
behavior and harness bookkeeping; those causes were not isolated. The more defensible live conclusion is the measured
5–7% combined share for Rust, not a claim that the pipe costs exactly 1%.

### The engine's expensive paths

1. **Repeated legality checks while rebuilding action prompts.** Separate CPU
   sampling of the seed-1 round-4 search attributed about 26% of Rust search and
   32% of native ISMCTS search to `getCardLegalActions` inclusively. Source
   inspection explains repeated work: an incomplete `ActionWindow.continue()`
   builds the active prompt, highlights selectable cards from `UiPrompt.setPrompt`,
   then highlights them again from `ActionWindow.continue`. Each route calls
   `getSelectableCards`, scanning cards and running ability requirement checks.
   The same prompt presentation can therefore scan three times. The sampled
   `setPrompt` and legality percentages overlap; they must not be added.

   Sources: [ActionWindow.ts:108](https://github.com/ericfode/forceteki/blob/2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a/server/game/core/gameSteps/ActionWindow.ts),
   [UiPrompt.ts:108](https://github.com/ericfode/forceteki/blob/2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a/server/game/core/gameSteps/prompts/UiPrompt.ts).

2. **Internal snapshots during forward simulation.** The measured game-object
   snapshot portion (object cleanup and retained-object serialization) took
   9–15% of Rust search and 8–10% of native search, already included in the engine
   rows above. Total snapshot construction also includes the separate serialization
   of `game.state`, so its cost is at least that large. The explicit `mark()` looks cheap because it retains the existing
   cached snapshot. Entering a new action timepoint does the expensive work:
   serialize game state, clean up game objects, then serialize retained object
   states. This is engine state serialization, not the JSON sent through stdio.

   Sources: [SnapshotManager.ts:113](https://github.com/ericfode/forceteki/blob/2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a/server/game/core/snapshot/SnapshotManager.ts),
   [SnapshotFactory.ts:140](https://github.com/ericfode/forceteki/blob/2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a/server/game/core/snapshot/SnapshotFactory.ts),
   [GameStateManager.ts:136](https://github.com/ericfode/forceteki/blob/2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a/server/game/core/snapshot/GameStateManager.ts).

3. **Restoring the whole object graph and restarting the prompt pipeline.** In
   native search, restoring serialized object state took 21–26% of total search
   time; rebuilding/resuming the pipeline took another 6–13%. These are components
   of rollback, not additional costs. CPU profiles also identify `copyState`,
   `setState`, V8 serialization/deserialization, and rollback object traversal.

   Sources: [GameStateManager.ts:143](https://github.com/ericfode/forceteki/blob/2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a/server/game/core/snapshot/GameStateManager.ts),
   [Game.ts:2181](https://github.com/ericfode/forceteki/blob/2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a/server/game/core/Game.ts).

4. **Diagnostic snapshots are a small secondary cost.** Rollback captures state
   twice even when test-mode logging is disabled. That initially looked promising,
   but measurement puts it at only 0.3–0.8% of Rust search and about 1.5% of native
   search. It is not the main bottleneck.

## Next optimization target

First investigate reuse of legality results **within one unchanged prompt
refresh**. Compare the three scans' card IDs, mandatory-action flags and titles
before proposing a cache. Caching across actions or rollbacks needs stronger
invalidation rules.

Next investigate snapshot construction and object restoration. Merely disabling
automatic snapshots is not established as safe: action snapshots also support
cost-payment recovery. These findings identify places to optimize; they do not
prove a particular speedup or justify changing the engine without a separate
implementation decision.

Keep stdio and the current protocol. Board-view construction is a secondary
protocol-side target; changing the transport would leave the major engine costs
in place.

## Evidence and reproduction

See the committed [measurement summary](MEASUREMENTS.md) for portable metrics,
test totals and hashes. Paths under `results/` below identify local evidence
excluded from the repository; they are not downloadable artifacts.

- [Harness and timing definitions](README.md)
- Seed 1 raw measurements (`results/search-profile-2026-10-11/profile.json`)
- Seed 1 exact fixtures (`results/search-profile-2026-10-11/fixtures.json`)
- Seed 2 raw measurements (`results/search-profile-2026-10-11-seed2/profile.json`)
- Seed 2 exact fixtures (`results/search-profile-2026-10-11-seed2/fixtures.json`)
- Native CPU profile, seed 1 round 4 (`results/search-profile-2026-10-11/seed1-round4-ismcts.cpuprofile`)
- Rust referee CPU profile, seed 1 round 4 (`results/search-profile-2026-10-11/seed1-round4-rust-stdio.cpuprofile`)

Raw measurements live in gitignored `results/`. CPU profiles sample the parent
Node process; Rust internals are not CPU-profiled. Inspector overhead is excluded
explicitly in summaries. No process isolation or system-load control was imposed
on this shared desktop, so absolute milliseconds are approximate. Five roots are
useful evidence for these bots, not a comprehensive survey of every card or
position.

```sh
node --expose-gc tools/search-profile/run.cjs --out results/search-profile-2026-10-11 --rounds 2,3,4 --repeats 5 --warmups 2 --cpu
node --expose-gc tools/search-profile/run.cjs --out results/search-profile-2026-10-11-seed2 --seed 2 --rounds 4,6 --repeats 3 --warmups 1 --modes rust-stdio,ismcts --cpu
```
