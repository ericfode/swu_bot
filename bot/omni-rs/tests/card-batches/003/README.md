# Conversion batch 003

This batch adds **103 executable cards, from 664 to 767**: all 100 cards in the
governing selection and three incidental gains (`HMW_272`, `SEC_075`, `SOR_049`).
There are no admission regressions. The catalogue contains 895 conversions:
556 source-AST programs and 339 metadata-only programs. Runtime admission includes
426 source programs, 339 metadata-only cards and two native token adapters;
1,691 known definitions remain rejected.

The implementation adds self When Defeated windows, supported trigger aliases,
printed Coordinate abilities, bounded token-unit creation, scalar owner-hand
discard, printed-cost predicates and supported grouped draws. It preserves
captured trigger eligibility, root and nested event windows, simultaneous token
entry, the winner latch and internal terminal prompt ownership. Engine source and
build use the unchanged isolated pin `2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`.

## Accounting and evidence

- [manifest.json](manifest.json) retains the original named 100-card queue.
  Selection occurred after 90 exploratory admissions and before the final ten
  implementations completed; this is not a fully prospective trial.
  [report.json](report.json) records all outcomes and the three outside gains.
- [receipt-index.json](receipt-index.json) binds **202 completed engine games**,
  with 27,718 decisions and 12,057 action-window states. Its eleven corpora retain
  their original generation pools: the first 90 hand-play games use the earlier
  754-card pool, while the others use the final 767-card pool.
- [family-witness-ledger.json](family-witness-ledger.json) maps all 103 gains to
  complete source/IR hashes and evidence. Every card has an observed hand play;
  42 have dedicated printed-effect assertions and 61 have shared-mechanism
  evidence plus source/IR review. Playing a card is not a dedicated effect check.
  There are 99 targeted cases and 103 per-card play games.
- [verification.json](verification.json) identifies the tested source and build
  hashes, fresh native/Wasm comparisons, regression results and command logs.
  [final-review.json](final-review.json) records the independent high-effort
  review and its exact publication boundary.

## Review corrections and skill trial

Review distinguished trigger capture, card movement, contingent effects, state
checks and trigger resolution. Child event windows can pass their triggers to a
parent; their existence does not establish a separate trigger-resolution boundary.
Created tokens enter before the framework stat-death sweep. A latched winner can
coexist with automatic effects and an internal prompt that accepts no further
external input. These distinctions were checked against actual engine cases.

The initial 195-case verification passed but missed an empty-deck continuation:
Mos Espa Watermonger's draw resolves by dealing fatigue even when it draws zero
cards, so its `ifYouDo` discard must still run. HIGH review also identified grouped
fatigue timing and an empty group's inherited success flag in accepted synthetic
IR shapes. A further actual Skyway Cloud Car case exposed loss of the live
attacker identity during death-trigger resolution, which made a Raid unit an
illegal extra target. The dedicated case asserts selector eligibility and optional
Pass, not a positive return-to-hand result. A terminal counterpart asserts
that the latched winner can retain the attack and its Raid power in the final
snapshot. The implementation and regression tests were corrected before
publication. The [review-corrections](review-corrections) directory preserves the
earlier checkpoint and the LOW evaluator's missed finding. Those earlier passing
checks do not authorize the corrected implementation.

The refined [conversion skill](../../../../../.agents/skills/swu-card-conversion/SKILL.md)
now covers helper defaults, event boundaries, terminal prompt ownership and
resolution status versus numerical result. An independent GPT-6.1 Sol worker at
low effort then derived [expected outcomes](proof-forward/expectations-before-generation.json)
for **I Want Proof, Not Leads** with zero or one card remaining in its deck,
before generating two complete engine games. The cases assert actual draw counts,
fatigue and the mandatory discard menu. They exercise printed `then` behavior;
the three separate Watermonger cases exercise `ifYouDo` and terminal behavior.

Implementation workers used GPT-6.1 Sol at low effort; independent review used
high effort. This targeted skill trial is not a statistical estimate of worker
reliability, and finite traces do not prove every possible card interaction.
Synthetic diagnostics remain separate from actual-card conformance counts.
Unsupported shapes continue to fail closed. Perch was excluded at the user's
request.
