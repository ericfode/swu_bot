# Search profiling

Measures a bot searching from a fixed action-window position. Game preparation,
card loading, child startup, and the first shadow build/replay are outside the
search timer. This is not a tournament benchmark.

The committed [measurement summary](MEASUREMENTS.md) records the historical
October 11 measurements and their original revision. Raw profiles, transcripts,
fixtures and preserved baseline builds are local-only, gitignored evidence.
The publication branch uses the current Cargo workspace binary path
`target/release/swu-bot-rs`; that path correction postdates the recorded timings.

From the repository root, with Node 22 and the normal engine/card setup:

```sh
cargo build --release --locked --manifest-path bot/rust/Cargo.toml
node --expose-gc tools/search-profile/run.cjs --out results/search-profile --rounds 2,3,4 --repeats 5 --warmups 2 --cpu
```

Without a Rust build, use `--modes js-inprocess,js-stdio,ismcts`. Other options:
`--seed 2`, `--rounds 4,6`, `--repeats 3`, `--warmups 1`. Fixture preparation
fails explicitly if the game ends before reaching the requested roots. Nothing
contacts an external model or service.

The output directory contains:

- `fixtures.json`: decks, exact setup moves, stable split targets, root views and
  legal actions. A deterministic rush policy only prepares these positions.
- `profile.json`: machine/runtime revisions, individual samples, counters,
  timing aggregates, trace hashes and engine-free tape measurements.
- `*-tape.json`: each protocol search's request/response transcript.
- `*.cpuprofile`: ordinary V8 CPU profiles, openable in DevTools; only emitted
  with `--cpu`.
- `*-cpu-summary.json`: sampled self/inclusive times. Inspector startup/stop
  overhead is explicitly excluded from the percentage denominator, while the
  raw recording and the excluded duration are retained.

## Method

Every sample builds a fresh shadow, verifies that it matches the live fixture,
and resets the bot. The actual search uses production `ClientSeat`/`NativeSeat`,
the simulator, and the unchanged bot algorithms. The profiling tools do not
modify engine source; they measure the engine build currently installed.
Existing functions are wrapped in memory for attribution. JavaScript in-process
and stdio use the same search implementation and seed; normalized request and
reply hashes must match. The live root must remain unchanged after every sample.

After warming each mode, mode order and instrumentation/control order alternate.
Controls turn span clocks off but retain the lightweight wrappers and transcript
collection. `--expose-gc` permits collection before, outside each search; GC during
search remains part of its cost. CPU samples run separately from the reported
timing controls. Absolute timings fluctuate on a shared desktop; percentages and
work counters are more useful than tiny differences between mode medians.

The search bots are intentionally reported separately:

- JavaScript example: up to 16 root candidates, horizon 40; identical algorithm
  in process and over stdio.
- Rust: default six candidates, one hidden deal, at most 60 subsequent steps per
  candidate. Its internal three-second cap remains enabled. Complete request
  hashes/counts disclose changes in completed work; a tape replay that performs
  different work is marked unavailable, never compared as equivalent.
- ISMCTS: default 6 iterations per action, clamped to 32–128, one exchange per
  rollout. Each root starts with fresh belief state, not earlier game observations.
  This measures computation cost, not playing strength.

## Reading the timings

- `prepareMs` is the first shadow construction/replay, excluded from `searchMs`.
- `decisionMs` is the outer seat decision, including the subsequent shadow
  consistency check, root packaging, final cleanup, and optional profiler setup.
  Use samples with `cpu:false` for its timing.
- `searchMs` measures the actual client `decide` or native `choose` call. Root
  packaging and final simulator cleanup are outside it; current clients explicitly
  end simulations before returning.
- `simulationMs` is time inside real simulator callbacks. `botAndTransportMs`
  is the remainder: bot processing, both sides' wire encoding, pipes, scheduling,
  and minor harness bookkeeping. It is **not pure pipe latency**.
- `rows.*.inclusiveMs` includes nested spans; do not add parent and child rows.
  `selfMs` subtracts timed children and can be summed without that double count.
  Medians of separate rows need not sum to a median total.
- `engine.apply` includes rule resolution, prompt/legal-action generation, and
  automatic snapshots. `engine.legalActions` only exports already generated
  prompt actions; it does not measure the expensive legality checks.
- `engine.restore` includes state restoration, rebuilding the pipeline/prompt,
  and diagnostic captures. Snapshot construction can happen during `apply` even
  though the explicit `engine.mark` operation is cheap. `engine.snapshotBuild`
  measures retained-game-object cleanup and serialization; it excludes the
  snapshot factory's separate serialization of `game.state`.
- `json.wire.*` covers **parent-side** encoding/decoding only. Child JSON is in
  `botAndTransportMs`. Engine snapshots use their own V8 serialization.
- Tape replay feeds the real bot exactly the recorded simulator replies, verifies
  its request path and final choice, and removes engine computation. It measures
  warm bot + JSON + pipe + scheduling cost together. It is a control experiment,
  not a number to subtract directly from a live run with different wakeup/cache
  behavior.

## Comparison setup

Create fresh fixture files for the examples below after the normal engine/card
setup. These minimal runs also produce a search profile in each output directory:

```sh
node --expose-gc tools/search-profile/run.cjs --out results/search-profile-fixtures-seed1 --seed 1 --rounds 2,3,4 --modes ismcts --repeats 1 --warmups 0
node --expose-gc tools/search-profile/run.cjs --out results/search-profile-fixtures-seed2 --seed 2 --rounds 4,6 --modes ismcts --repeats 1 --warmups 0
```

They prepare five roots from the current checkout; the historical fixture files
are not distributed. The runners verify matching root state and legal actions
when replaying each fixture against both engine versions.

The comparison commands are templates for a new change: start with a baseline
engine build, preserve the indicated compiled modules, apply the intended source
change, then rebuild. Copying an already optimized module and rebuilding identical
source does not recreate the historical baseline. Exact stage-by-stage replay of
the published measurements also requires their preserved intermediate builds.

## Paired optimization comparison

`compare.cjs` compares the authorized ActionWindow prompt-refresh optimization
with its original implementation. Preserve the **unoptimized compiled file before
rebuilding the modified source**; the runner needs both versions:

```sh
mkdir -p results/search-profile-cache-baseline
cp forceteki/build/server/game/core/gameSteps/ActionWindow.js results/search-profile-cache-baseline/ActionWindow.js
npm --prefix forceteki run build
node --expose-gc tools/search-profile/compare.cjs --baseline results/search-profile-cache-baseline/ActionWindow.js --fixtures results/search-profile-fixtures-seed1/fixtures.json,results/search-profile-fixtures-seed2/fixtures.json --out results/search-profile-cache-paired --pairs 5 --modes rust-stdio,ismcts
```

The generated fixture files contain five exact positions: seed 1 rounds 2, 3 and
4, plus seed 2 rounds 4 and 6. The runner loads these fixtures rather than
generating new positions. It defaults to two warmup pairs and five measured
pairs per position/mode; `--warmups` and `--pairs` override those counts. Run it
after other builds, tests and benchmarks finish.

Both variants use the same loaded engine and current ActionWindow constructor.
The runner switches only the `continue`, `getSelectableCards` and `setPrompt`
prototype descriptors, deleting the own override for the original inherited
`setPrompt`, and restores the current descriptors in `finally`. Engine files are
never rewritten. Every search has a fresh verified shadow and reset bot; variant
and mode order alternate. This runner is specific to this method-only change
plus its transient optional field, not a general comparison of engine revisions.

`comparison.json` retains raw warmup/sample timings, before/after order, compiled
and harness hashes, behavior checks, and per-position/mode aggregates. Every pair
must match the chosen action, request and response hashes, simulator counts,
native statistics except elapsed time, and native search result. Errors, failed
playouts or changed work fail the comparison; partial output is marked failed.
Protocol tapes from the first measured pair and the exact fixtures are saved too.

`medianPairedSearchImprovementPercent` is the median of each pair's
`100 * (1 - after.searchMs / before.searchMs)`; positive values mean less search
time. Separate before/after medians are also recorded, but their ratio is a
different statistic. Paired ordering reduces shared-load confounding; desktop
load remains uncontrolled, and replacing prototypes can affect JIT compilation
and inline caches. These measurements do not provide process isolation.

## Snapshot and rollback comparison

`compare-snapshots.cjs` compares the snapshot/rollback optimization using two
persistent engine processes. Preserve both **pre-change compiled modules before
rebuilding**; both baselines should already include the earlier prompt cache:

```sh
mkdir -p results/search-profile-snapshot-baseline
cp forceteki/build/server/game/core/GameObjectUtils.js results/search-profile-snapshot-baseline/GameObjectUtils.js
cp forceteki/build/server/game/core/snapshot/GameStateManager.js results/search-profile-snapshot-baseline/GameStateManager.js
npm --prefix forceteki run build
node --expose-gc tools/search-profile/compare-snapshots.cjs \
  --baseline results/search-profile-snapshot-baseline \
  --fixtures results/search-profile-fixtures-seed1/fixtures.json,results/search-profile-fixtures-seed2/fixtures.json \
  --out results/search-profile-snapshot-paired \
  --pairs 5 --warmups 2 --modes rust-stdio,ismcts
```

The baseline worker installs a loader hook before importing the engine, compiling
the saved modules at their original filenames. This preserves relative imports,
the normal module cache and each engine's private symbol identities. The current
worker loads the installed build normally; all other modules, including the
prompt cache, are shared source. Engine files are never rewritten.

Each worker verifies the exact supplied fixture. Samples run sequentially, with
alternating variant and mode order, fresh shadows and reset bots. Startup, IPC
and preparation are outside `searchMs`; active span clocks and CPU profiling are
disabled. Run this after other builds, tests and benchmarks finish. Separate
processes avoid prototype switching, but desktop load and independent JIT/heap
history still affect timings.

The output and behavior checks match `compare.cjs`, including comparisons against
the first equivalent warmup or sample. `medianPairedSearchImprovementPercent`
remains the median of individual `100 * (1 - after / before)` search-time changes;
`medianPairedSearchSpeedup` is the median of individual `before / after` ratios.
Positive improvement means faster searches with identical verified work.

For an ablation, create another baseline directory containing one saved module
and the other module from the current build. Both filenames are required; at
least one must differ from current. Use a separate output directory and report
which module differs. This measures that change with the other optimization
already enabled, rather than attributing an additive share of the combined gain.

### Other engine modules

Use `--modules` to compare a different set of compiled engine modules. Supply
comma-separated paths relative to `forceteki/build/server/game`; the baseline
directory must mirror those paths. For example, preserve the current compiled
file **before rebuilding the next change**:

```sh
mkdir -p results/search-profile-target-baseline/core/ongoingEffect
cp forceteki/build/server/game/core/ongoingEffect/OngoingCardEffect.js results/search-profile-target-baseline/core/ongoingEffect/OngoingCardEffect.js
npm --prefix forceteki run build
node --expose-gc tools/search-profile/compare-snapshots.cjs \
  --baseline results/search-profile-target-baseline \
  --modules core/ongoingEffect/OngoingCardEffect.js \
  --fixtures results/search-profile-fixtures-seed1/fixtures.json,results/search-profile-fixtures-seed2/fixtures.json \
  --out results/search-profile-target-paired \
  --pairs 5 --warmups 2 --modes rust-stdio,ismcts
```

Only the selected modules differ between workers; all other engine changes are
present on both sides. Include every module changed by the optimization. Paths
must be unique `.js` files without absolute paths, traversal or empty segments.
The runner verifies selected modules loaded and records each module's original
filename, saved filename and before/after hashes. Omitting `--modules` preserves
the original two-file comparison and its flat baseline layout.

See [REPORT.md](REPORT.md) for the original October 11 findings,
[OPTIMIZATION.md](OPTIMIZATION.md) for the prompt-legality change, and
[SNAPSHOT_OPTIMIZATION.md](SNAPSHOT_OPTIMIZATION.md) for snapshot/rollback results.
[EFFECT_OPTIMIZATION.md](EFFECT_OPTIMIZATION.md) covers the subsequent ongoing-effect
target checks, including both timing runs and their limited measured benefit.
[CANDIDATE_CACHE.md](CANDIDATE_CACHE.md) covers reuse of unchanged arena/base
candidates, invalidation tests, the same profile rerun and a cache-only ablation.
