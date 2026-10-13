# A06 independent review

Reviewer: `animation_a05_spec`, GPT-6.1-sol / `xhigh`, 2026-10-11. This reviewer did not author A06's specification, implementation, fixtures or signatures. Scope remains the entire imported catalogue. A04/A05's failed first passes remain preserved; clean streak zero means no effort reduction is earned.

Status: **accepted 10/10 after four independent semantic corrections; first independent pass 6/10, clean batch false**. Final source/production fingerprint is `5758df9e07be7a4dfcd6fd5fc4247cf963e43f5ef8cd09e801fc3a3d39a18d45`. The corrected first frozen pixel matrix passes all ten cards and Anger's separate next-action boundary at both sizes. No material blocker remains. Clean streak stays zero and `xhigh` remains required.

The durable receipt is `results/card-effects-review/A06-gpt61/acceptance.json`; `first-pass.json` and `first-independent-findings.json` retain the original four rejects. Candidate80/5711 accepted A04/A05 corrections only; A06's main module was unimported there. Earlier catalogue entries or author source captures were not independent A06 acceptance.

## Read-only source audit preparation

The ten installed JSON identities, exact sole prints and aliases, every matching `forceteki/server/game/cards/02_SHD/events/` implementation, relevant card tests and supporting Ambush/control/rescue/action systems were inspected. `docs/card-animation-a06-spec.md` separates complete clauses from one selected legal primary. No engine source edits, builds, games, providers or commits were used by this reviewer.

Independent scripts live in `results/card-effects-review/A06-gpt61/scripts/`. `ending-oracle.cjs` is manually specified from the rules and written fixtures; it imports no production builder or resolver. `source-audit.cjs` compares actual construction to that oracle. Preparation artifacts retain `sourceFingerprint=null` and are not frozen acceptance. Final `source-oracle.json` passes all ten saved-source primaries and the separate Anger boundary: **11/11**.

`source80/served-manifest.json` preserves all **39** served source hashes and **126** read-only JSON/rules/test/system hashes. Every saved hash was verified again when writing the receipt. The separately hashed `studio/src/lib/cards.ts` loader dependency is declared in `audit-support-manifest.json`; it is not misrepresented as one of the served manifest's 39 files. A07's working tree is separate from these immutable source80 bytes and the frozen production captures.

| Identity / exact print / canonical ID | Primary event price | Independent expected ending |
| --- | ---: | --- |
| Timely Intervention / SHD_129 / 6847268098 | 1, plus nested unit2 | Actual hand X-Wing plays, gets phase Ambush, chosen trigger attacks TIE. New X-Wing remains exhausted2/3/damage2; TIE enters P2 discard; resources7/10; existing X-Wing unchanged. |
| Moment of Glory / SHD_130 / 1701265931 | 3 | Marine becomes7/maxHP7/damage1/ready, with phase buff; no healing or token. Resources7/10. |
| Choose Sides / SHD_132 / 2346145249 | 7 | Same Marine ownerP1 moves to P2 ground ready/damage1; same TIE ownerP2 moves to P1 space exhausted. Permanent controller statuses, same incarnations. Resources3/10. |
| Give In to Your Anger / SHD_144 / 3012322434 | 5 | Ready Trooper takes1 and retains current-incarnation next-P2-action obligation; no attack/exhaustion yet. Resources5/10. |
| Headhunting / SHD_145 / 5896817672 | 6 | Hunter attacks Trooper at5 then rests3/exhausted/damage3; Marine attacks Wampa and departs; X-Wing attacks TIE then exhausted/damage2. Wampa remains damage4; Trooper/TIE P2 discard, Marine P1 discard. Resources4/10. |
| Cripple Authority / SHD_156 / 3228620062 | 4 | Totals8 vs10: P1 draws actual Repair/deck26 while P2 chooses Open Fire to discard. P1 ready4/8; P2 ready2/10; Takedown retained. |
| The Chaos of War / SHD_159 / 8090818642 | 7 | Source already out of hand; own hands3/2 deal simultaneous own-base damage3/2. Bases18/22 remaining; five hand cards stay. Resources3/10. |
| Desperate Attack / SHD_179 / 6962053552 | 3 | Damaged Marine attacks enemy base at5 then rests3/exhausted/damage1. Enemy base19; no base counterdamage. Resources7/10. |
| Detention Block Rescue / SHD_180 / 8576088385 | 5 | Actual pocket count1 selects6 damage; Veteran departs to P2 discard, then ownerP1 Marine rescues clean3/3/exhausted/fresh entry2. No captor/pocket, no When Played. Resources5/10. |
| Pillage / SHD_181 / 4772866341 | 6 | P1 chooses P2; P2 chooses actual Takedown/Open Fire to its discard and retains Resupply. Resources4/10. |

Each primary disposes of the source once, preserves unrelated bases/units/decks/poses and actual physical-card identity. Complete known-deck/resource-ID order, stable nonce-independent identities, owner/controller zones, maximumHP/damage distinction and full status metadata are independently asserted. Missing aspect occurrences are counted separately, including both Aggression symbols on Chaos.

Anger's required **next-action** oracle begins at the exact immediate ending, with the source already paid/discarded. An actual ordinary Trooper→Sentinel Defender attack deals3 and receives4 simultaneously; both units enter owner discards, obligation consumed once, resources/decks/bases unchanged. No second event payment or repeated one-point ability hit occurs. The lifecycle runner handles this scene separately and cancels it into Moment of Glory to test stale completion.

## First independent semantic failures

`scripts/evidence-gates.cjs` checks that complete rich signatures and suppression use the same supported evidence. The prebuild run passes27/31 probes: all ten good primaries and all ten missing-transition rejections pass, but four contradictory contracts still produce rich receipts. Root confirmed these are material independent findings and invalidate clean A06 even before formal pixel handoff.

- Anger: restriction and final constraint name a different causing event from `cue.source`; the renderer still claims the event's next-action obligation.
- Headhunting: attacker receipt says current power9 while the before Hunter has3, forward damage11, and only the actual +2 bounty boost is supported; rich attacks still render.
- Detention: declared rescue entry is exhausted, but actual final Marine is ready; rich EXHAUSTED rescue still renders.
- Pillage: explicit typed `selection=random` contradicts the chosen-card/chooser contract; rich chosen-card lanes still render.

`evidence-gates-prep-saved.json` records exact module hashes/timestamp and preserves those unbuilt bytes in `evidence-gates-prep-saved-source/`. Initial logs remain separate. A test-only Cripple probe initially mutated an aliased shared group, inadvertently changing both windows; the corrected detached-window mismatch properly rejects. It is not a fifth product failure. The independent full source-ending oracle still passes11/11.

Root owns maintained regression additions; this reviewer keeps its manual repro script separate. Author additionally found Timely's entered unit disappearing at42/43% before Ambush, saved as `source-timely-timing-initial`; this is author evidence, separate from the four independent semantic findings. Paid source events remaining in hand and Headhunting survivors fading during final repack were also author/root prehandoff failures. Initial author evidence remains preserved alongside corrected directories.

Independent unbuilt correction reruns pass31/31 gates and11/11 endings with their separately saved source hashes. Root's maintained initial log is preserved as `maintained-gates-initial.log`:22/26 groups passed, with the same four product failures. Final `evidence-gates-frozen80.json` passes **31/31** against saved5758 bytes: ten supported primaries, ten sparse-transition rejections and eleven incomplete/contradictory-contract probes. Successful corrections do not reset the first independent findings.

## Frozen pixel and completed-state review

`initial-desktop/` and `initial-mobile/` contain all ten primaries at18/46/72/90/100% plus natural completion. `boundary-desktop/` and `boundary-mobile/` contain Anger's separately selected **Next P2 action**. Each manifest records requested identity, title/caption/progress, source fingerprint, image hashes, retained comparison image and browser errors. All **22 ordered contacts, 22 six-sample natural contacts and 22 actual natural endings were inspected**. `ending-contacts/` arranges the unchanged natural ending screenshots for review; raw images remain in each lifecycle directory.

Scores are readability / meaning / impact, taking the lower result across both sizes. Original semantic rejects remain separate from these corrected frozen pixel scores.

| Card | Scores | Final observation | First semantic review |
| --- | --- | --- | --- |
| Timely Intervention | 4 / 5 / 4 | Hand entry and separate payments lead to chosen Ambush; exhausted new X-Wing keeps phase status. | Pass |
| Moment of Glory | 4 / 5 / 3 | Phase +4/+4 and original wound remain legible; no healing or token. | Pass |
| Choose Sides | 4 / 5 / 4 | Paired owner-preserving transfers; permanent controller labels and poses persist. | Pass |
| Give In to Your Anger | 5 / 5 / 3 | One wound, ready unit and future obligation; no premature attack. | **Reject → corrected** |
| Headhunting | 4 / 5 / 4 | Three ordered attacks, counterdamage and losses; attack bonuses expire and survivors stay visible. | **Reject → corrected** |
| Cripple Authority | 4 / 5 / 4 | Total resources govern independent draw/choice lanes; readiness does not decide them. | Pass |
| The Chaos of War | 5 / 5 / 4 | Source excluded, own-hand3/2 count reaches own bases simultaneously; cards retained. | Pass |
| Desperate Attack | 4 / 5 / 4 | Existing damage enables attack-only +2; base takes5, no counterdamage, resting power restored. | Pass |
| Detention Block Rescue | 4 / 5 / 4 | Pocket1 selects6 damage; captor departs, Marine rescues clean/exhausted with fresh incarnation. | **Reject → corrected** |
| Pillage | 4 / 5 / 3 | P1 chooses player; P2 chooses its two actual cards and retains third. | **Reject → corrected** |
| Anger next-action boundary | 4 / 5 / 4 | Sentinel-directed ordinary attack loses both units; obligation consumed without event repayment. | Required boundary, not an eleventh identity |

The manual rendered oracle passes **22/22** scenes, independently of natural==held comparisons. It asserts actual card/resource IDs and owner/controller zones, hand/deck/discard counts, bases, leaders, poses, stat counters, status duration/constraint metadata, Sentinel and captive pockets. `lifecycle-desktop/mobile/lifecycle.json` and their boundary equivalents also pass natural completion, Replay/reset, backward seek, reseek and repeated completion. Cancellation held Moment of Glory at18% for seven seconds after leaving another primary or Anger's boundary; neither stale callback overwrote it. Reduced-motion completion passes every scene. All browser error lists are empty and each runner confirms5758 remained served.

Measured natural primary durations (desktop / mobile, seconds) are Timely6.105/6.045, Glory4.491/4.407, Sides5.851/5.864, Anger4.407/4.413, Hunt6.825/6.795, Cripple4.867/4.815, Chaos5.008/5.031, Desperate4.859/4.894, Detention5.890/5.863 and Pillage4.668/4.610. Boundary4.480/4.438. Reduced-motion timings are postselection waits, not duration claims; mobile Sides had already settled by the first2ms observation.

`additional-poses-desktop/mobile/` preserves Timely35/38/40/41/42/43/44/45/46/48% and Headhunting87/89/90/92/94/96/99%. The42/43 and89/96 seams were actually inspected at both sizes: Timely's entered2/3 card stays continuously visible when Ambush begins, and Hunt's continuing Hunter/Wampa/X-Wing retain full counters through final repack.

## Exact-hash and geometry qualifications

Initial desktop and boundary exact hashes pass. Initial mobile Timely, Cripple and Chaos hashes differ; none were recaptured to obtain a favorable hash. `initial-raster-adjudication.json` compares each saved original with `settle-90-repeat.png`: **four of366,528 pixels each**, maximum channel delta1, all in the lower-right rounded board corner. Requested title/caption,0.9000 progress and all measured geometry are exactly equal.

`raster-differences.json` separately quantifies all four held captures: every layout/progress measurement is identical. Several mobile rounded board/caption edges differ by4–14 pixels, maximum channel delta21 in Glory's five caption-corner pixels. All desktop held frames and both boundary held sets are exact. These are preserved raster qualifications; no primary text or counters change.

The broad `landing-desktop/mobile/report.json` intentionally retains its failed native-old-position probes. Defender closing a transferred Marine's slot, hand cards closing removed source/discard slots, and mobile headquarters closing a removed captive-panel footprint are ordinary layout reflows. Hunt's active survivor ghosts settle independently of the old underlying positions. `landing-adjudication.json` compares every arriving card and all three continuing Hunt survivors to actual final slots: **all within2px**, with no material arrival failure. It preserves the92/63px arena,52/104px hand and49px captive-panel reflows rather than hiding them behind a passing report.

Residual polish: some center receipts touch decorative base-ring arcs. Complete HP numerals stay visible; decorative proximity is not a clipped result.

## Recording coverage and acceptance boundary

Root's final portable recording checker passes **8 available cases**, before/after/Replay/backseek, at5758 with `errors=[]`. Its exact report is preserved as `recorded-coverage-root.json`, separate from this reviewer's fresh showcase checks. Four Timely recordings include the previously missed Smuggle plus nested hand play/Ambush case `random-b-vs-random-a-2.jsonl`, step139/actions136..139: sourceP2c101 leaves resources, deck34→33, Admiral PiettIBH060c75 plays from hand/pay4, combat wounds occur on both sides. The three other Timely cases do not supply every nested-play/choice detail. Chaos and Desperate have actual checks, with Calculated Lethality and Commission as shared regressions.

Seven A06 cards lack available recordings: Glory, Sides, Anger, Hunt, Cripple, Detention and Pillage. No games were generated to fill those gaps. Recording snapshots remain generic where choice, sequence, count basis or trigger cause is unknown; available before/after verification does not authorize rich invented chronology.

Acceptance covers one explicit legal primary per identity and Anger's explicit separate trigger boundary. Alternative optional choices, Timely's alternate payment/play routes, and other targets remain complete rules metadata or supported-recording branches, not newly accepted staged scenes. Phase statuses retain their declared duration; elapsed animation time never executes a future game phase or action. Engine sources remain read-only. Root's fullsmoke134root/185studio, corrected studio/typecheck and kit builds passed; this reviewer performed no build, product mutation, engine edit, paid call, game or commit.

**BUILD-CLEAR80:**10 accepted identities, original first independent6/10, clean streak0, GPT-6.1-sol / `xhigh`. The source80 snapshot and evidence remain immutable while later source work proceeds.
