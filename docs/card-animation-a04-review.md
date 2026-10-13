# A04 independent review

Reviewer: `animation_a05_spec`, GPT-6.1-sol / `xhigh`, 2026-10-11. This reviewer authored the future A05 specification, not A04 rules, fixtures or signatures. Scope remains the entire imported catalogue. A04 did not earn a clean first-pass batch or a lower-effort trial.

Status: **finally accepted 10/10 on frozen candidate80; first independent pass remains 9/10**. Galactic Ambition's departure/counter obstruction is corrected and independently verified. The original caption failure and BUILD70 badge failure remain preserved. No clean first-pass batch or lower-effort trial is earned.

## Frozen evidence

First-pass production: `http://127.0.0.1:5191/#/effects`, served fingerprint `c1b2849b22d4d9d28ff149462c925aa2d6ad251d63d6100bc771b24a3111dcdd` (60-card catalogue).

The review root is `results/card-effects-review/A04-gpt61/`:

- `source60/served-manifest.json`: 33 hashed animation source files plus 53 read-only JSON/rules/test files saved before A05 source changes.
- `source-oracle.json`: source60 compared against an independent, manually specified complete primary ending oracle.
- `initial-desktop/` and `initial-mobile/`: all ten ordered 18/46/72/90/100% contacts, individual frames, natural overlay-free endings and full pages. Each manifest records the served build.
- `lifecycle-desktop/` and `lifecycle-mobile/`: six real natural timing samples per card, independently checked endings, repeated frozen frames, Replay/reset/backward seek/reseek, cancellation and reduced-motion completion.
- `frozen-raster-differences.json`: unchanged progress/geometry and the measured raster differences described below.
- `scripts/ending-oracle.cjs`, `source-audit.cjs`, `lifecycle.mjs`, `snapshot-source.mjs`: reproducible independent audit runners. The ending oracle imports no production builder or resolver.

All 20 ordered contacts, all 20 actual natural timing contacts and all 20 overlay-free natural endings were actually inspected. Captures alone are not a visual verdict. Desktop is 1440×1100; mobile is 390×844. The selected scene remains one legal example, not proof of all conditional branches.

Root reported full smoke PASS (134 root tests, 127 studio tests, analysis and both viewer builds) and the animation kit PASS for the frozen build. Root's recorded Calculated Lethality check is attributed separately below.

## First-pass scores and independent completed state

Scores are readability / meaning / impact, out of five. Acceptance requires readability and meaning ≥4, impact ≥3, and no material contradiction or clipped result.

| Identity / exact print | Independent primary result and inspected meaning | First scores | Verdict |
| --- | --- | --- | --- |
| I Am Your Father / SOR_233 | P2 explicitly says NO; three actual top cards reach P1 hand, deck 24; Wampa damage remains 1. Choice and three arrivals are clear. | 4 / 5 / 4 | Pass |
| Maximum Firepower / SOR_234 | Stationary exhausted Trooper deals 3, ready TIE deals 2; Luke damage 5. Numbered shots distinguish current power; both source poses remain unchanged. | 5 / 5 / 4 | Pass |
| Galactic Ambition / SOR_235 | Actual hand Wampa enters exhausted for free; own base damage 13, resources 1/10. Destination and ending are correct, but mobile source counters disappear behind the caption during departure. | 3 / 5 / 4 | **Reject** |
| Medal Ceremony / SOR_245 | Three witnessed Rebel incarnations each retain one permanent XP and remain exhausted. History marks precede persistent badges. | 5 / 5 / 4 | Pass |
| You're My Only Hope / SOR_246 | Private top Wampa plays directly from deck for 1; deck 26/resources 6/10, exhausted. Card back precedes public play; no invented hand transfer or free branch. | 5 / 5 / 4 | Pass |
| Calculated Lethality / SHD_039 | Trooper and Academy go to discard; old tokens cease; three new XP distribute two to Marine/one to X-Wing. Count includes the token; visible result is defeat, not damage. | 4 / 5 / 4 | Pass |
| Mystic Reflection / SHD_051 | Force-qualified Wampa becomes power 2/max HP 3, damage remains 1; the phase status remains visible. Capacity reduction and existing damage remain distinct. | 5 / 5 / 3 | Pass |
| Midnight Repairs / SHD_054 | Budget eight removes 2/2/1/3 damage across four units on both sides/arenas. Maximum HP, bases and unallocated damage remain unchanged. | 5 / 5 / 4 | Pass |
| Covert Strength / SHD_075 | Same Marine heals two and gains one permanent XP: power 4/max HP 4/damage 0. Quiet same-host healing and capacity gain read separately. | 4 / 5 / 3 | Pass |
| Unexpected Escape / SHD_076 | Captor exhausts/survives, its pocket goes one→zero; actual P1-owned Marine is rescued exhausted with a new incarnation to P1 ground. It reads as a rescue, not a free play. | 5 / 5 / 4 | Pass |

The independent source audit also verifies canonical numeric identities, installed JSON print/aspect/cost mappings and exact before-card names/stats. Source event payments are 5, 6, 9, 0, 3, 6, 1, 4, 1 and 1 respectively; Hope's nested payment is additionally 1. Initial resources suffice. Source disposal occurs once, input fixtures/cues remain unchanged, playback nonce does not change ending identities, deck order/counts and instance uniqueness hold, and leader summaries remain unchanged.

The oracle checks exact stable IDs/prints/owners, effective power, maximum HP and damage separately, exhaustion, permanent token IDs/contributions, phase status, captive membership and fresh rescue incarnation, and actual hand/discard/deck/resource/base results. Rendered DOM checks independently confirm expected IDs, values, poses, tokens, statuses and captive ownership; they do not merely compare natural completion to the held board.

## Material first-pass failure

`lifecycle-mobile/galactic-ambition/natural-30.png` shows the actual natural frame at about 1.62 seconds. The Wampa departure ghost's lower half, including its 4/5 counters, crosses behind the caption while FREE HAND PLAY remains visible. Fixed 46/72/90% samples and the final board are correct, so sampling only destination poses missed this defect. Root independently viewed the same raw image and accepted the rejection.

The original failure is retained; there was no repeated favorable recapture. BUILD70 independently checked the correction and found the source-badge obstruction below. The renderer must provide a newly frozen correction before acceptance.

Local skill refinement: include early natural source departure/travel clearance on mobile, between the prescribed frozen samples, whenever cards leave hand/deck/captive pockets. Caption clearance must protect the moving source card and its counters as well as its destination label.

## Timing, lifecycle and frozen raster behavior

Both viewport runs pass all ten manual ending oracles, natural-versus-held completion, repeated Replay, reset to the original before state, backward seek and reseek to 100%. Interrupting Calculated Lethality at about 40%, selecting Maximum Firepower and holding it at 18% for seven seconds does not allow a stale callback to advance or settle it. Selected identity, progress and state remain correct. Browser errors are empty and the served fingerprint remains frozen.

Observed desktop/mobile natural durations in milliseconds:

| Card | Desktop | Mobile |
| --- | ---: | ---: |
| Father | 5240 | 5282 |
| Maximum | 5863 | 5826 |
| Ambition | 5487 | 5466 |
| Medal | 4825 | 4879 |
| Hope | 5671 | 5654 |
| Calculated | 6039 | 6003 |
| Mystic | 4458 | 4406 |
| Midnight | 5393 | 5441 |
| Covert | 4255 | 4211 |
| Escape | 5209 | 5252 |

Reduced-motion mode reaches all ten correct completed boards at both sizes. Some mobile selections complete immediately; other scenes still take their usual duration. This evidence establishes correct completion, not a universal instant or motionless skip.

Four repeated 90% captures retain `0.9000` progress and identical DOM geometry for every card. All desktop repeated hashes match. The original mobile Father capture reports `freezeStable=false` and stays preserved. In the separate four-frame mobile lifecycle evidence Father differs in ten pixels among 317,952 (maximum channel difference 1) along the outer board edge; Ambition/Hope differ in four pixels among 318,688 around a rounded caption corner (maximum differences 7/6). No text, counter, identity, progress or position moves.

Cross-session initial-versus-lifecycle held images show small raster differences: desktop 97–1,823 pixels, mobile 0–2,160. The largest is 0.71% of Escape's board pixels; the inspected pair retains the same words, poses and results. These are not all asserted to be edge-only, nor is their exact browser compositing cause proven. The diagnostic preserves bounds and magnitudes, rather than rerunning until a favorable hash appears.

## Earlier corrections and coverage limits

Prehandoff author/integration corrections are separate from this first independent pixel pass. Root corrected Father/Mystic descriptions and narrowed example-only Father/Hope beats. Its evidence-gate regressions found incomplete Hope payment, Escape exhaustion and Maximum sequence/source proof. This reviewer inspected and preserved the initial 4-pass/3-fail log as `pre-handoff-gates-initial.log`; implementation corrected these before BUILD60-READY. Author diagnostics also corrected settled-label overlaps before handoff. None of these establish a clean independent first pass.

Root's actual recorded action checker passes Calculated Lethality on this same c1b build: `random-c-vs-random-a-8.jsonl`, action steps 283..286. An unupgraded own Rogue One LAW_119 departs and awards no XP; before/after, Replay and backward seek pass. The inspected report is `results/card-effects-state-check/a04-recorded.json`. Nine A04 cards have no matching recording. Their synthetic primaries are visually/state verified; missing recordings remain a coverage limit.

No fresh games, paid providers, engine edits or commits were used for this review. Covert Strength's alternate Smuggle scene, arbitrary other Hope card types/entry triggers, and other conditional branches are not visually demonstrated by these ten primaries.

## BUILD70 correction and regression result

Production fingerprint `c292b47c08cc0dcb63fcc12bb50b4d5f5c253c5ce65cf498837755f841e94316` is saved at `source70/served-manifest.json` (36 animation source files, 87 A04/A05 authority files). `source-oracle-corrected70.json` passes all ten original manual ending oracles. Later source80 edits are not this evidence.

`corrected70-desktop/` and `corrected70-mobile/` contain all ten prescribed ordered contacts and natural endings. `corrected70-lifecycle-desktop/` and `corrected70-lifecycle-mobile/` contain all ten timing contacts and independent lifecycle checks. All 20 ordered contacts, all 20 natural timing contacts and all 20 natural overlay-free endings were actually inspected. All ten state oracles, Replay/reset/backseek/reseek/cancel/reduced-motion completion checks pass at both sizes; errors are empty and the build remained frozen. Root smoke passed 134 root/156 studio tests plus analysis and both builds; its corrected kit build passed.

**Remaining rejection:** `corrected70-lifecycle-mobile/galactic-ambition/natural-30.png`, at 1624 ms/~30.3% (display rounds to 31%), shows the source FREE HAND PLAY badge across Wampa's lower art/counters. The caption now clears the departure, but the moving 4/5 counters are still obscured by its own badge. Root independently viewed and confirmed the same raw image. Ambition remains 3/5/4; the other nine retain their passing scores. All completed boards remain correct.

`frozen-raster-differences-corrected70.json` preserves initial mobile Father/Ambition hash failures. Four repeated 90% frames keep identical progress and DOM geometry. Repeated changes are only 4–8 pixels for these scenes and four pixels for Hope, around board/caption corners, with channel differences at most seven. No favorable repeated capture replaced the failures.

Root's inspected `results/card-effects-state-check/a05-recorded.json` verifies the same Calculated Lethality recording again on c292: before/after, Replay and backward seek pass. Missing A04 recordings remain the earlier nine; this shared report additionally checks A05 Commission and does not create new A04 coverage.

## Candidate80 final acceptance

The A04/A05 correction candidate serves fingerprint `5711c6dd384fb40ed2e224bed2616e6bd28ebb400843ba9972f5c628ccb56198`. `source80-candidate/` saves 39 hashed animation source files and 87 A04/A05 authority files. A06 main signatures are unimported in this candidate; its catalogue count is not A06 implementation or acceptance. This receipt accepts A04 only.

`source-oracle-candidate80.json` passes all ten complete manual source endings. `candidate80-endings-desktop/endings.json` and `candidate80-endings-mobile/endings.json` independently pass all twenty A04/A05 rendered endings at each size. These manual checks remain separate from natural=held comparisons.

Affected-scene captures in `corrected-candidate80-desktop/` and `corrected-candidate80-mobile/` cover Father, Ambition, Hope and Escape at18/46/72/90/100% plus natural endings. `candidate80-lifecycle-*` independently captures six actual natural timing frames, checks final state, Replay/reset/backseek/reseek, interrupted selection and reduced-motion completion. All eight ordered contacts, eight natural timing contacts and eight overlay-free natural endings were actually inspected. Browser errors are empty, identity/progress stay fixed, and the served fingerprint remains frozen. Other six cards retain the earlier complete independent review, with source/rendered endings rechecked against this candidate.

`candidate80-origin-*` adds18/24/30/36/42/46% departure frames. FREE HAND PLAY now sits in the middle gap and clears the travelling Wampa/counters at every sampled pose. The actual mobile natural30 frame at1625ms/~30.3% also shows unobscured4/5 counters and caption clearance. Ambition earns **4/5/4**; the other nine passing scores are unchanged. No material blocker remains.

Candidate desktop/mobile durations are Father5232/5282ms, Ambition5432/5473ms, Hope5604/5656ms and Escape5206/5266ms. Cancellation Escape→Father held18% stays unchanged for seven seconds. Reduced-motion completion passes; usual-duration playback remains for some scenes, so this does not claim universal instant completion.

`frozen-raster-differences-candidate80.json` retains repeated mobile4–8-pixel board/caption-corner differences with maximum channel delta7 and identical progress/geometry. The independent Spark-origin probe's mobile exact-JSON false is separately adjudicated at≤0.000122px relative SVG bounds; raw reports are retained. No favorable recapture replaced failed evidence.

Root reports full smoke134root/179studio tests, analysis/both viewers and kit PASS. Its inspected `results/card-effects-state-check/a06-interim-recorded.json` again passes Calculated Lethality before/after/Replay/backseek on5711; the other nine A04 recordings remain missing. `acceptance.json` records final10/10 separately from the preserved original9/10 first pass. Lower effort remains unearned.
