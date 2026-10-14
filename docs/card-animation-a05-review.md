# A05 independent review

Reviewer `animation_a05_spec`, GPT-6.1-sol / `xhigh`, 2026-10-11. This reviewer wrote A05's source specification, not its implementation, fixtures, signatures or author captures. The manual ending oracle imports no production builder/resolver.

Status: **finally accepted 10/10 on frozen candidate80; first independent pass remains 9/10**. Spark of Hope's stale initial origin is corrected and independently verified. The entire imported catalogue remains the objective. A05 did not earn a clean first-pass batch or a lower-effort trial.

## Frozen source and inspected coverage

Production `http://127.0.0.1:5191/#/effects`, 70-card catalogue, fingerprint `c292b47c08cc0dcb63fcc12bb50b4d5f5c253c5ce65cf498837755f841e94316`. The immutable source is `results/card-effects-review/A04-gpt61/source70/`, including 36 manifest-hashed animation source files and 87 read-only A04/A05 JSON/rules/test files. Later source80 edits are not this review evidence.

Review artifacts live in `results/card-effects-review/A05-gpt61/`:

- `source-oracle.json`, `scripts/ending-oracle.cjs`, `source-audit.cjs`: exact complete manually specified primary endings, compared independently to production construction.
- `initial-desktop/` and `initial-mobile/`: ten cards at 18/46/72/90/100%, natural overlay-free ending and full page; served manifests preserve original pixel-hash failures.
- `lifecycle-desktop/` and `lifecycle-mobile/`: actual six-frame natural contacts with measured timestamps, rendered ending oracle, four repeated frozen frames, Replay/reset/backward seek/reseek, cancellation and reduced-motion completion.
- `landing-desktop/`, `landing-mobile/`, `landing-adjudication.json`: arriving card/captive/leader/resource alignment and final resource-rack continuity, with raw broad probe failures retained.
- `first-pass.json`, `frozen-raster-differences.json`: scores, material failure, unchanged progress/geometry and measured raster differences.

All 20 ordered contacts, all 20 actual natural timing contacts and all 20 overlay-free natural endings were actually inspected. Natural ending sheets contain the unaltered individual ending screenshots; raw images remain available. Desktop is 1440×1100, mobile 390×844.

Root reported full smoke PASS (134 root/156 studio tests, analysis and both builds), then corrected studio/CSS/animation-kit builds PASS. No review-side builds, games, providers, engine edits or commits occurred.

## Independent outcomes and first-pass scores

Scores are readability / meaning / impact, out of five; passing requires ≥4 / ≥4 / ≥3 and no material contradiction. Complete rules and one selected legal primary remain distinct.

| Identity / print | Independently checked primary and inspected meaning | Scores | Verdict |
| --- | --- | --- | --- |
| Evidence of the Crime / SHD_077 | Same Academy moves from Wampa to Marine, owner P2/controller P1; Wampa 4/5/damage1, Marine5/5/damage1. Hosts survive, permanent ownership/control badge remains. | 4 / 5 / 4 | Pass |
| Fell the Dragon / SHD_078 | Current power6 qualifies upgraded Wampa; Wampa+Academy enter P2 discard, no damage hit. Power gauge and direct cut distinguish the filter/destination. | 5 / 5 / 4 | Pass |
| Rival's Fall / SHD_079 | Deployed Vader leaves arena for actual owner leader slot exhausted, deployment spent persists; no P2 discard. Leader face/destination reads distinctly from ordinary defeat. | 5 / 5 / 4 | Pass |
| Remnant Reserves / SHD_093 | Three selected top-five units reach hand; only selected faces reveal; deck24, two unselected cards at bottom, suffix ordered. Three separate arrivals, no cost cap or arena play. | 4 / 5 / 4 | Pass |
| Palpatine's Return / SHD_094 | Actual discard Force Kylo costs2 after separate event8, enters exhausted6/7/damage0/fresh entry2; resources0/10. Explicit −8 ruler and discard route distinguish nested costs. | 5 / 5 / 4 | Pass |
| Spark of Hope / SHD_105 | Exact eligible Marine ends as exhausted resource11; ready8, source remains discard and decoys remain. Initial departure/witness incorrectly originates over surviving Defender, while Replay uses discard. | 3 / 3 / 3 | **Reject** |
| Rule with Respect / SHD_106 | Witnessed current enemy Wampa/TIE leave two arenas into Marine's pocket, ownerP2/count2; Marine survives ready3/3/damage1. Past-attack stamps do not replay old damage. | 5 / 5 / 4 | Pass |
| Enforced Loyalty / SHD_108 | Marine's successful defeat goes to P1 discard; two actual cards then reach P1 hand, deck25/resources6. Defeat and contingent draw remain distinct. | 4 / 5 / 4 | Pass |
| Endless Legions / SHD_109 | Pay16 from20; reveal four actual resources, play Marine→X-Wing→Wampa free/exhausted, leave Repair resourced; final4/17, no deck replacement. Numbered departures and shrinking totals preserve order. | 4 / 5 / 4 | Pass |
| Commission / SHD_127 | Private top ten selects one Item Electrostaff; only it reveals/draws, deck26, nine backs to bottom, upgrade remains in hand. No attachment or invented unit-only restriction. | 4 / 5 / 4 | Pass |

All ten source oracles pass exact numeric identity/sole print aliases/aspects/costs, before-card names/stats, complete known-deck order, hidden-zone membership, per-resource IDs/readiness, source disposal once and instance conservation. Event payments are 3/4/6/6/8/2/4/4/16/1; Return additionally pays2. Inputs remain immutable and nonce changes do not alter ending identities. Upgrade owner/controller, leader spent/exhausted/undeployed state, current/fresh incarnations, Sentinel preservation, maximum HP/damage distinction and captive ownership are checked independently.

## Material first-pass rejection

`initial-mobile/spark-of-hope/anticipation-18.png` and its desktop counterpart put the green latest-defeat witness check directly on surviving Echo Base Defender. At46 the selected Marine travel card departs that arena position, although the Marine begins in discard. This visually assigns eligibility/departure to the wrong surviving unit.

`lifecycle-mobile/spark-of-hope/natural-12.png` and the desktop natural12 frame instead place the witness at the discard counter after Replay. The different initial selection and reset routes establish stale geometry rather than incorrect source state. Root diagnosed an exact Marine arena measurement retained from the previous Palpatine fixture before the new board committed; the renderer is correcting initial measurement scope/after-commit measurement. Source70 and original failure remain preserved. No favorable repeated recapture replaced them.

The same shared geometry fix needs ordered cue-switch, Replay/reset and held/natural regression checks. A newly frozen corrected build must be reviewed before Spark is accepted.

## Lifecycle, timing and landing continuity

Both viewport runs pass every manually specified rendered ending, natural-versus-held completion, repeated Replay, original before-state reset, backward seek and reseek to100%. Interrupting Spark near40%, selecting Fell and holding18% for seven seconds does not permit a stale completion callback to change selection/progress/board. Browser errors are empty and c292 remained frozen.

| Card | Desktop natural ms | Mobile natural ms |
| --- | ---: | ---: |
| Evidence | 5434 | 5558 |
| Fell | 4503 | 4437 |
| Rival | 4854 | 4817 |
| Remnant | 5653 | 5677 |
| Return | 5802 | 5892 |
| Spark | 4835 | 4804 |
| Respect | 6078 | 6032 |
| Loyalty | 5240 | 5286 |
| Legions | 7033 | 7484 |
| Commission | 5613 | 5666 |

Reduced-motion mode reaches every correct completed board at both sizes. Some selections complete immediately, others retain their usual duration; this evidence proves completion, not universal motionless/instant behavior.

Every arriving hand/arena/captive/leader/resource card at99% aligns within two pixels of its actual ordinary completed destination at100%. Spark/Legions' completed resource slots also align within two pixels. The broad probe exits1 because surviving Defender repacks left92px/63px after Loyalty's adjacent Marine is removed, and mobile Rival's lower P1 section shifts up86.19px when Vader's extra enemy row disappears. These are recorded ordinary board reflows, not arriving-card/rack mislandings. `landing-adjudication.json` separates those observations without overwriting raw reports.

Four repeated90% frames keep identical progress0.9000 and DOM geometry for all cards. Desktop repeated hashes match. The original mobile Commission `freezeStable=false` is preserved. Equivalent four-frame lifecycle evidence differs in ten corner/outer-edge pixels among366,528, maximum channel delta1. Other mobile scenes show four to14 changed board/caption-corner pixels, maximum delta7. Words, counters and positions do not move; raster diagnostics preserve bounds rather than chasing favorable hashes.

## Author corrections and actual replay limits

Author diagnostics precede this independent first pass and stay separate. Their preserved `source-geometry/report.json` found a16px Legions final arena jump and about17px/16px resource-rack displacement when20 resources became17. The conditional explicit-manifest HQ footprint was corrected before BUILD70-READY. Other author source/corrected capture folders remain in the review root, with their own working-tree provenance; they are not independent production evidence.

The inspected root report `results/card-effects-state-check/a05-recorded.json` passes existing Commission, `random-a-vs-random-c-7.jsonl`, step19/actions17–19: actual c9 event pays1, c25 Naboo Royal Starship SEC_099 enters hand, deck44→43, arenas/bases unchanged; before/after, Replay and backward seek pass on c292. The recording does not expose all searched identities or bottom order. Nine A05 cards lack recordings; deliberate synthetic primaries are not new engine execution.

Base-attached Evidence sources remain a pinned-engine limitation. Nested captor cleanup, other Return/Legions units with unauthored entry effects, hidden searches without full explicit receipts and Commission's alternate Smuggle scene remain outside these primaries. Recorded snapshots do not manufacture their unobserved choices, faces, chronology, payment or future rules. Lower effort remains unearned after this failed first independent pass.

## Candidate80 final acceptance

Frozen correction fingerprint `5711c6dd384fb40ed2e224bed2616e6bd28ebb400843ba9972f5c628ccb56198` is saved at `../A04-gpt61/source80-candidate/` (39 hashed animation files/87 A04+A05 authority files). This accepts A05 only; A06 main signatures remain unimported in this intermediate candidate, and later complete80 work is separate.

`source-oracle-candidate80.json` independently passes all ten complete source endings. The two `../A04-gpt61/candidate80-endings-*/endings.json` reports pass all twenty A04/A05 rendered endings at each size, including all ten A05 primaries. Exact manual expected states, not only held/natural equality, still provide the state oracle.

The affected seven—Evidence, Remnant, Return, Spark, Respect, Loyalty and Legions—have new18/46/72/90/100%/natural captures in `corrected-candidate80-*`, plus six measured natural samples and complete lifecycle checks in `candidate80-lifecycle-*`. All fourteen ordered contacts, fourteen natural timing contacts and fourteen overlay-free natural endings were actually inspected. The other three retain the complete original independent review, with source/rendered endings rechecked on5711. All affected manual final oracles, Replay/reset/backseek/reseek, cancellation and reduced-motion completion pass at both sizes. Errors are empty and the build remains frozen.

`../A04-gpt61/candidate80-origin-*` explicitly enters Spark after Palpatine and compares18/24/30/36/46% with Replay-reset. Both routes focus the actual discard counter, never surviving Defender, and move the Marine from that same origin. Desktop rectangles match exactly; mobile relative SVG bounds differ by at most0.000122px while witness centers remain identical. The raw exact-JSON false is retained, with `candidate80-origin-adjudication.json`; no recapture or overwrite was used. Natural12/30/48% also show the correct route. Spark now earns **4/5/4**; all other passing scores are unchanged. No material blocker remains.

Candidate desktop/mobile natural durations: Evidence5441/5478ms, Remnant5635/5676, Return5809/5864, Spark4842/4811, Respect6078/6032, Loyalty5221/5282 and Legions7048/7475. Cancellation Legions→Evidence held18% remains unchanged for seven seconds. Reduced-motion completion passes; some scenes retain their usual duration.

`candidate80-landing-*` checks affected movement at99→100%. All actual arriving cards and Spark/Legions resource slots align within2px. The broad probe still exits1 for ordinary Defender repacking92px/63px after Loyalty's adjacent Marine is removed; `candidate80-landing-adjudication.json` preserves and separates that result.

The original candidate mobile Loyalty frozen-hash failure is retained. `candidate80-first-repeat-difference.json` measures just four changed pixels out of366,528 at the outer board corner, maximum channel delta1; selected title/caption/progress/DOM boxes agree exactly. Four-frame lifecycle differences remain4–14 corner pixels, maximum delta7, with fixed geometry/progress. `frozen-raster-differences-candidate80.json` preserves the diagnosis. No repeated favorable capture was substituted.

Root reports smoke134root/179studio tests, analysis/both viewers and kit PASS. Its inspected `results/card-effects-state-check/a06-interim-recorded.json` repeats Commission before/after/Replay/backseek PASS on5711; nine A05 recordings remain missing. `acceptance.json` records final10/10 separately from the preserved original9/10 first pass. Clean streak remains zero and lower effort remains unearned.

Residual polish, not a material failure: Spark's three-row completed receipt sits across the upper decorative base-ring arc. Existing raw mobile natural80/94 and held90 were inspected again; the full21 HP numeral remains visible at all three poses. No additional recapture was made.
