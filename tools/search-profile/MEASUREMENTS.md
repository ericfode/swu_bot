# Published measurement summary

This is a sanitized summary of the October 11, 2026 local evidence. It contains
aggregate results, test counts and artifact hashes; raw timings, game fixtures,
transcripts, machine paths and logs are not included.

## Provenance and limits

- Measured parent revision: `9bbdcc1cfae6115bc73dc5b3e52559b93e8d2fe0`.
- Measured engine starting revision: `2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`,
  with successive uncommitted optimization stages identified by the hashes below.
- Publication base: `4ef9e97fefad16d8eb45c91aa8ad7c674df7a45d`. The timing runs
  predate this publication checkout; they are not measurements of the new PR base.
- Runtime: Node 22.22.3, macOS arm64, Apple M5 Max. Desktop load was uncontrolled.
- Publication updates the Rust binary location to the current Cargo workspace's
  `target/release/swu-bot-rs`. Fresh build, test or smoke results on that checkout
  are separate validation and do not replace the historical timings here.

Every timing pair used equivalent verified search work. The statistic below is
the median of each pair's `100 * (1 - after / before)`; negative values mean
slower searches. Prompt comparison switched methods within one process; later
stages used isolated persistent engine processes. JIT/heap history, small samples
and large outliers limit precision. Stages and ablations are separate experiments:
their percentages must not be added, subtracted or multiplied into a total gain.
These measurements do not establish a uniform speedup or improved playing strength.

## Main comparisons

Each stage compared seed 1 rounds 2/3/4 and seed 2 rounds 4/6 in Rust and ISMCTS.
The normal profile was also rerun in all four modes on seed 1; all 157 profile
samples per version retained equivalent behavior for each optimization stage.
Earlier optimizations remained enabled in each later stage's baseline.

### Prompt legality

5 measured pairs per position/mode; 50 measured pairs and 20 warmup
pairs in total.

| Position | Rust | ISMCTS |
|---|---:|---:|
| Seed 1, round 2 | 6.4% | 9.7% |
| Seed 1, round 3 | 15.5% | 10.5% |
| Seed 1, round 4 | 10.4% | 16.3% |
| Seed 2, round 4 | 5.4% | 8.9% |
| Seed 2, round 6 | 6.2% | 6.6% |

### Snapshot and rollback

5 measured pairs per position/mode; 50 measured pairs and 20 warmup
pairs in total.

| Position | Rust | ISMCTS |
|---|---:|---:|
| Seed 1, round 2 | 5.2% | -2.3% |
| Seed 1, round 3 | 9.1% | 13.1% |
| Seed 1, round 4 | 2.1% | 8.5% |
| Seed 2, round 4 | -3.9% | 3.4% |
| Seed 2, round 6 | -0.8% | 4.2% |

### Blanking checks

15 measured pairs per position/mode; 150 measured pairs and 50 warmup
pairs in total.

| Position | Rust | ISMCTS |
|---|---:|---:|
| Seed 1, round 2 | -1.9% | 1.7% |
| Seed 1, round 3 | -0.1% | 0.8% |
| Seed 1, round 4 | 0.2% | 0.1% |
| Seed 2, round 4 | 1.6% | 1.3% |
| Seed 2, round 6 | 1.2% | 0.7% |

### Candidate discovery

15 measured pairs per position/mode; 150 measured pairs and 50 warmup
pairs in total.

| Position | Rust | ISMCTS |
|---|---:|---:|
| Seed 1, round 2 | 2.4% | 1.0% |
| Seed 1, round 3 | 2.6% | -1.5% |
| Seed 1, round 4 | -1.4% | 3.0% |
| Seed 2, round 4 | 11.5% | 6.2% |
| Seed 2, round 6 | 6.6% | 5.7% |

The snapshot result is mixed; its isolated restore-recipe cache helps native
search more consistently than Rust. Blanking-check gains are small. Candidate
discovery helps the effect-heavy seed-2 positions; smaller positions remain mixed.

## Ablations

Each isolated comparison used five measured pairs and two warmup pairs per
position/mode. The snapshot ablations each contain 20 measured and eight warmup
pairs. Candidate caching contains 50 measured and 20 warmup pairs.

### Restore recipe only, with snapshot compaction already enabled

| Position | Rust | ISMCTS |
|---|---:|---:|
| Seed 1, round 4 | 0.3% | 8.7% |
| Seed 2, round 4 | -1.6% | 6.7% |

### Snapshot compaction only, with restore recipe already enabled

| Position | Rust | ISMCTS |
|---|---:|---:|
| Seed 1, round 4 | -1.1% | 0.2% |
| Seed 2, round 4 | 2.6% | -2.6% |

### Candidate cache only, against narrowing without reuse

| Position | Rust | ISMCTS |
|---|---:|---:|
| Seed 1, round 2 | 1.7% | 2.0% |
| Seed 1, round 3 | 1.0% | 1.4% |
| Seed 1, round 4 | -0.7% | 0.3% |
| Seed 2, round 4 | 9.7% | 4.4% |
| Seed 2, round 6 | 5.7% | 4.7% |

## Candidate-work counts

Separate diagnostic runs preserve decisions, traces, accepted targets and
recalculation counts. Their elapsed times are not benchmark results.

| Position / search | Target checks before → after | Candidate queries / rebuilds | Reused queries |
|---|---:|---:|---:|
| Seed 2, round 4 / Rust | 152,163 → 73,138 | 844 / 49 | 94.2% |
| Seed 2, round 4 / ISMCTS | 138,818 → 81,325 | 602 / 120 | 80.1% |
| Seed 2, round 6 / Rust | 110,697 → 65,406 | 476 / 58 | 87.8% |
| Seed 2, round 6 / ISMCTS | 154,887 → 92,326 | 666 / 126 | 81.1% |

## Final historical verification

- Full engine suite: 9,005 specs, 0 failures, 9 pending.
- Whole-suite undo: 8,817 specs, 0 failures, 19 pending.
- Candidate-cache focused tests: 10 pass; four eligibility/value cases also pass
  against the original module. Earlier stages' focused checks are documented in
  their individual reports.
- Root tests: 134/134 pass. Builds, engine/test ESLint and card validation passed
  (2,071 card files, 2,048 card-test files).
- Determinism gate: 594 / 342 / 486 steps, p2 wins, identical with and without recording.
- Candidate main runs plus ablation: 200 measured pairs and 70 warmup pairs match
  behavior; zero simulator errors or failed native playouts. Each search checks
  that its real root remains unchanged.

Pending tests are disabled existing cases and dedicated undo tests skipped by the
whole-suite undo harness. These checks establish equivalence for exercised cases,
not a proof over every possible game state.

## Measured compiled-module fingerprints

SHA-256 values identify the exact historical compiled artifacts. Module paths are
relative to `forceteki/build/server/game`. Baseline and intermediate builds are
local evidence, not files distributed with this summary.

| Stage / module | Before SHA-256 | After SHA-256 |
|---|---|---|
| Prompt / core/gameSteps/ActionWindow.js | `094c525c206693d6b69587eb4ed47a6ee3a3a083cb1be3c0d7c83fa2f486dd00` | `3ac8da0bd863d8acee7d1222350108a1d139be169a5707181a43fb75ef390005` |
| Snapshot / core/GameObjectUtils.js | `742cd763003200c27dfdc92afb5748a12a5b2d0f3595f098be98b292874d4159` | `35fb6a35e405891f3cda16be0f6ed894ad32e9490273a56023522f8426f2d66a` |
| Snapshot / core/snapshot/GameStateManager.js | `c9e03735555e655e8b9e69cd9aae2064099e8ee0cac7cb048bffe2f43377e5f6` | `839a44f6aacc6cb25e35e1e8a2442907566273d8c69dfd0cda84472480dfc2ec` |
| Blanking / core/ongoingEffect/OngoingCardEffect.js | `cfaa12dca299a24388c45289b0fab8d910a3abd899e64b858d3157a78d9e52b9` | `d684f078f1577b1cd1a23635c636390ef50b160318e897d95cc7e7a622529f97` |
| Candidates / core/ongoingEffect/OngoingCardEffect.js | `d684f078f1577b1cd1a23635c636390ef50b160318e897d95cc7e7a622529f97` | `d0f30ebe523c4b32403e37b1938b0dd2ff453a64e99f6c7e6503dedc624fd814` |
| Candidate ablation / core/ongoingEffect/OngoingCardEffect.js | `1abbf89f4099faeae60825d147909d643877e2c21c1ab8018d788d21012589f8` | `d0f30ebe523c4b32403e37b1938b0dd2ff453a64e99f6c7e6503dedc624fd814` |

Recorded historical `run.cjs` SHA-256, before the publication path correction:
`98f2c0f7a46cd2d8410adf99aa10606b9c29d172de6f7c7604beb12629993196`.

Source records were the completed comparisons for prompt, snapshot, both
snapshot ablations, both blanking runs, both candidate runs and the candidate
ablation, plus the final candidate verification record. Their local paths remain
documented as code paths in the reports. [README.md](README.md) explains how to
generate fresh fixtures and measurements; exact historical replay additionally
requires the preserved intermediate baseline builds.
