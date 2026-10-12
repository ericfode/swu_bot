# Equal-work search benchmarks

`tools/omni-search-bench.js` measures actual native `Search::solve` calls through
`omni-rs prove`. It compares frozen inputs and preserved binaries, alternates
workload order and rotates binary order, excludes warmups, and rejects any change
in position identity, result, depth, completion, nodes, decisions or transpositions.
It never passes `--rules-receipt` during timing. Rollout `omni-rs bench` numbers
measure a different operation and should be reported separately.

The default [workload sources](search-workloads.json) select fifteen action windows
from five committed recordings: opening and later boards in ordinary strict-pool
and compiled-effects games, plus three semantic boundaries per constructed live
modifier case. Chirpa samples another friendly Ewok entering and leaving; D’Qar
Cargo Frigate samples damage and a healed phase buff; Kino samples other friendly
exhausted counts of two, one and zero. Each position gets 15,000 search nodes.
These are a small reproducible suite, not a sample of all possible games. Each
source has a pinned trace hash; its pool hash is checked against the trace header.
To add a workload, choose explicit zero-based `stateIndexes` from a committed trace
and explain its role. Keep both ordinary gameplay and targeted rules cases.

## Preserve artifacts and prepare positions

Use Node 22. Run from the repository root. Save the baseline before changing source,
using identical Cargo profiles, Rust toolchains and target architecture on both builds.
Keep receipts outside the repository (or in ignored replay storage).

```sh
mkdir -p /tmp/omni-search-performance/before
cargo build --release -p omni-rs
cargo rustc --locked -p omni-wasm --lib --target wasm32-unknown-unknown --release -- -C link-arg=-zstack-size=16777216
cp target/release/omni-rs /tmp/omni-search-performance/before/omni-rs
cp target/wasm32-unknown-unknown/release/omni_wasm.wasm /tmp/omni-search-performance/before/omni_wasm.wasm
git rev-parse HEAD > /tmp/omni-search-performance/before/commit.txt
rustc --version > /tmp/omni-search-performance/before/rustc.txt
node tools/omni-search-bench.js prepare bot/omni-rs/benchmarks/search-workloads.json /tmp/omni-search-performance/inputs
node --test tools/test/omni-search-bench.test.js
```

Preparation copies the current catalog and every selected pool, and exports the
recorded full states with their original seeds. It creates `inputs/workloads.json`.
The prover itself is deterministic and has no random seed. Preserve the candidate
binaries similarly in an `after` directory after implementation and validation.
The candidate must accept the same frozen catalog. Changing a catalog while timing
would confound the comparison.

Write `/tmp/omni-search-performance/comparison.json`:

```json
{
  "workloads": "inputs/workloads.json",
  "rounds": 9,
  "warmups": 1,
  "variants": [
    {"id": "before", "binary": "before/omni-rs", "wasm": "before/omni_wasm.wasm", "backend": "auto", "commit": "BASELINE_SHA"},
    {"id": "after", "binary": "after/omni-rs", "wasm": "after/omni_wasm.wasm", "backend": "auto", "commit": "CANDIDATE_SHA"},
    {"id": "interpreter", "binary": "after/omni-rs", "backend": "interpreter", "commit": "CANDIDATE_SHA"}
  ]
}
```

Paths are relative to the JSON file that names them. `wasm` and `commit` are optional
metadata; a supplied Wasm artifact is hashed and sized, not executed by this tool.
Use two variants for a direct before/after comparison. A third forced Interpreter
variant can expose remaining overhead and supplies an additional work/result check.

```sh
node tools/omni-search-bench.js run /tmp/omni-search-performance/comparison.json /tmp/omni-search-performance/results
```

Output directories must not already exist. The runner snapshots all binaries,
pools, catalogs and positions, records their SHA-256 hashes and sizes in
`manifest.json`, and verifies the snapshots again at the end. `runs.jsonl` retains
commands and raw stdout/stderr as each child exits, including on a failed run.
`measurements.json` retains timings and counts; `summary.json` reports per-workload
and total weighted time/node, throughput, sample variance, standard deviation,
coefficient of variation, and paired percent changes against the first variant.
Total weighted cost is total search time divided by total actual nodes, per round.
Search time excludes process startup, catalog loading and input parsing. Raw process
wall time is recorded separately and must not be substituted for search time.

The paired bootstrap interval is descriptive, uses a fixed seed and requires at
least five rounds. An interval crossing zero is reported as no resolved direction.
Even an interval excluding zero does not eliminate shared-host interference or
justify a claim about all games. Do not run builds, other benchmarks or sampling
profilers concurrently with timed comparisons. Report early completed searches
using their actual counts; identical requested budgets alone do not establish equal
work. This harness checks count/result equality, not every visited state. Preserve
full native/Interpreter/Wasm Karabast conformance checks separately.

## Profile separately

Use a larger node budget on the same prepared position, with no time limit. On
macOS, run the child and sample its PID from a second terminal:

```sh
/tmp/omni-search-performance/before/omni-rs prove /tmp/omni-search-performance/inputs/chirpa-other-ewok-entry-removal.jsonl --pool /tmp/omni-search-performance/inputs/chirpa-other-ewok-entry-removal-pool.json --catalogue /tmp/omni-search-performance/inputs/catalog.json --backend auto --nodes 1000000 --depth 12
sample PID 10 1 -file /tmp/omni-search-performance/chirpa-sample.txt
```

`sample` records inclusive and self stack counts. Count search-worker samples;
process startup and the main thread waiting on the worker are separate. Repeat on
ordinary compiled and strict control workloads before choosing an optimization.
Release binaries retain symbol names on this platform; if a platform needs a
symbol-rich build, use it for profiling only and retain that build's provenance.
On Linux use `perf record -g -- COMMAND` and `perf report` where available.

For dispatch coverage, repeat a separate proof with `--rules-receipt /tmp/receipt.json`.
The receipt shows executed rule programs, not their CPU cost. Never mix those
instrumented timings or profiler timings into the benchmark summary.
