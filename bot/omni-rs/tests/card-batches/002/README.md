# Conversion batch 002

This batch adds **100 runtime-executable cards, from 564 to 664**, with no admission
regressions. The generated catalogue has 809 conversions: 470 source-AST programs
and 339 metadata-only programs. Runtime admission includes 323 source programs,
339 metadata-only cards, and two native token adapters; 1,794 known definitions
remain explicitly rejected.

The additions comprise 67 keyword cards, 31 event-group cards, and two cards using
printed-name predicates. The compiler and runtime now preserve supported live and
phase keywords, numeric keyword stacking, bounded dynamic trigger labels, group
event identity, nested selection, and simultaneous Shield/damage/defeat ordering.
All engine inputs use the unchanged pinned revision
`2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`, exported and built separately from the
concurrently used main checkout.

## Accounting and evidence

- [manifest.json](manifest.json) is the final **retrospective** selection, frozen
  after exploratory prototypes and admission measurement. [baseline.json](baseline.json),
  [after.json](after.json), and [report.json](report.json) account for exactly 100
  gains and zero losses. Accounting deliberately does not claim conformance.
- [exploratory-queue.json](exploratory-queue.json) preserves the original prospect
  queue; [its context](exploratory-queue-context.json) explicitly retires it.
  `SEC_084` remains blocked by Plot, and `SHD_075`/`SHD_160` by Smuggle.
- [receipt-index.json](receipt-index.json) binds 185 complete engine games and
  their generation pools by exact SHA-256. All match the final native and rebuilt
  Wasm runtimes. Existing trace bytes were retained through runtime fixes.
- [family-witness-ledger.json](family-witness-ledger.json) maps all 100 gains to
  semantic evidence. It distinguishes direct positive/negative/interaction
  assertions, shared-mechanism coverage supported by source/IR review, and 98
  ordinary card-play observations. Two leader cards have dedicated deployment
  cases. Merely playing a card is not an effect witness.
- [verification.json](verification.json) records final source, build, catalogue,
  pool and receipt hashes, test commands, logs and reviewer status. It also records
  fresh agreement on the original 300-game corpus and previous committed corpora.

All 100 raw card definitions and complete IR programs were independently reviewed
by GPT-6.1 Sol at high effort; implementation workers used low effort. Tests include
152 Rust workspace tests, 177 repository JS tests, 38 compiler/accounting/exporter
tests and 11 Wasm/adapter tests. The portable npm package passes extraction checks.
Perch was excluded at the user's request.

## Corrections and limits

Differential cases caught false intrinsic Sentinel inferred from keyword mentions,
Overwhelm damage passing through a Shield, selection toggle/cap mistakes, repeated
optional Pass prompts, Shield identity/player-order errors, and incorrect
damage-callback versus stat-death ordering. Raw-IR validation also rejects capture
scopes or expanded event counts that the runtime cannot preserve.

Four invalid constructed leader fixtures remain byte-for-byte under
[retired-fixtures](retired-fixtures), with recorded reasons and corrected indexed
replacements. An apparent last-Shield engine timeout was instead the harness
formatting a failed assertion over cyclic Card objects. Correct scalar assertions
produce three completed HP-death games; the original diagnostic is preserved with
its corrected interpretation. Retired or diagnostic-only inputs are not counted.

The [conversion skill](../../../../../.agents/skills/swu-card-conversion/SKILL.md)
captures these demonstrated failure modes. [skill-forward-test.json](skill-forward-test.json)
records an independent low-effort trial against raw keyword data and a prior
proposal; it correctly identified three keyword-metadata mistakes. A separate
[final readiness trial](skill-readiness-review.json) reproduced the exact batch
accounting and input/build hashes, checked all 185 terminal games, and independently
matched three HP/Shield games in native and Wasm. Its pre-publication verdict
correctly required the final HIGH approval and tested commit that were still pending
at the time; publication evidence resolves those steps separately. Its initial
sampling missed overbroad dedicated-card labels that HIGH review caught; the
follow-up verifies the corrected mappings and is not a new blinded trial. These
targeted process checks and finite game traces do not establish universal correctness or a
statistical reliability rate. Unsupported semantics remain rejected.
