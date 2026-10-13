# Card animation batch ledger

This ledger tracks completed animation work separately from catalogue inventory and planned batches. Workflow: [swu-card-animation](../skills/swu-card-animation/SKILL.md). Rules and examples: [card animation language](card-animation-language.md). Repeated patterns and refactor candidates: [reuse catalogue](card-animation-reuse.md). This merge request contains the accepted 180-card runtime; later batch notes describe isolated work, which is not included.

## Scope and inventory — 2026-10-11

The user confirmed the **entire imported catalogue** and **GPT-6.1-sol at `xhigh`**. Work proceeds in rounds of ten with an improving animation skill, reducing effort only after measured reliability. The initial diagnostic review used GPT-6-sol before this clarification; it found useful defects but does not count as the requested acceptance pass. Do not interpret inventory as completed work.

| Inventory | Count | Source / meaning |
| --- | ---: | --- |
| Installed card JSON files | 2,479 | `forceteki/test/json/Card/*.json`; `_cardMap.json` has the same raw count. |
| Mock identities | 21 | `forceteki/test/json/_mockCardNames.json`; excluded from the imported real-card scope. |
| Imported non-mock identities | 2,458 | Raw card map minus mock identities. |
| Non-mock print codes | 2,549 | `_setCodeMap.json` has 2,570 entries before the 21 mock print codes are excluded. Reprints are not new animation identities. |
| Bot environment index | 2,039 | Current inventory audit of `Env.index()`; filters through `implementedCards`. This is not the complete engine-capability boundary: keyword-only cards can be excluded. |
| Existing authored event scenes | 20 | Approved composition baseline, now registered in `studio/src/effects/catalogue.ts`. |
| New scenes accepted | 160 | A01 through A16 accepted; clean streak0. |
| Freshly accepted under the completed-board contract | 180 | R01, R02 and A01 through A16 accepted. The remaining 2,278 identities are not yet accepted. |

Imported data and engine implementations are read-only references. Units, leaders, upgrades, bases, tokens, and delayed-trigger scenes are in scope; add their necessary semantics before calling those identities supported. Group verified reprints under one identity. The complete pending queue is generated with `node studio/scripts/card-animation-inventory.cjs --scope imported --out results/card-animation-catalogue/imported` (246 batches including the two baseline rounds).

## Starting evidence and demonstrated failure

The prior independent review is `results/card-effects-review/final-review.md`, with four-frame evidence in `results/card-effects-review/final/`. It accepted the twenty staged compositions at 18%, 46%, 72%, and 90%, and explicitly left small counters static. It did **not** inspect an overlay-free board after natural completion. The user then observed removed cards returning when the animation ended.

Skill revision 1 therefore requires explicit before/after presentation snapshots, an overlay-free completed-board capture, and completion/reset/seek/cancellation assertions. Preserve the accepted cinematic signatures while repairing that handoff. This finding invalidates claims of completed-board acceptance, not the historical judgment of the captured compositions.

Other observed lessons retained in revision 1: verify title/caption/progress to catch HMR contamination; compensate SVG rotations for nonuniform board scaling; keep destination labels out of captions; use separate per-recipient labels for opposing area effects. Sources: `round1-review.md`, `corrections-review.md`, and `final-review.md` in the same review directory.

## Batch queue

The first two rounds are regression/state-handoff work and do not establish reliability for authoring new scenes. Acceptance is recorded per batch below.

| Batch | Kind | Identities, in review order | Model / effort | State |
| --- | --- | --- | --- | --- |
| R01 | Existing 10 | Open Fire; Force Lightning; Force Choke; Takedown; Vanquish; Superlaser Blast; Overwhelming Barrage; Bombing Run; Make an Opening; Repair | GPT-6-sol / `xhigh` diagnostic; GPT-6.1-sol / `xhigh` independent acceptance | **10/10 accepted after correction; first pass 7/10.** [Review](card-animation-r01-review.md) |
| R02 | Existing 10 | Restock; Resupply; Command; Vigilance; Aggression; Cunning; Power of the Dark Side; The Force Is With Me; Waylay; Spark of Rebellion | GPT-6.1-sol / `xhigh` | **10/10 accepted after correction; first pass 9/10.** [Review](card-animation-r02-review.md) |
| A01 | New 10 | Moment of Peace; Mission Briefing; Keep Fighting; Outmaneuver; Attack Pattern Delta; Power Failure; Change of Heart; Sneak Attack; Recruit; Strike True | GPT-6.1-sol / `xhigh` rules/fixture, signature, and independent review agents | **10/10 accepted after correction; first pass 6/10.** Both regroup examples accepted. [Review](card-animation-a01-review.md) |
| A02 | New 10 | Search Your Feelings; It Binds All Things; The Emperor's Legion; Rebel Assault; U-Wing Reinforcement; Heroic Sacrifice; Karabast; For a Cause I Believe In; Rallying Cry; Force Throw | GPT-6.1-sol / `xhigh` | **10/10 accepted after correction; first pass 7/10.** Recruit regression also cleared. [Review](card-animation-a02-review.md) |
| A03 | New 10 | Precision Fire; Smoke and Cinders; Forced Surrender; No Good to Me Dead; I Had No Choice; Bamboozle; Disarm; Shoot First; Asteroid Sanctuary; Don't Get Cocky | GPT-6.1-sol / `xhigh` | **10/10 accepted after correction; first pass 9/10.** [Review](card-animation-a03-review.md) |
| A04 | New 10 | I Am Your Father; Maximum Firepower; Galactic Ambition; Medal Ceremony; You're My Only Hope; Calculated Lethality; Mystic Reflection; Midnight Repairs; Covert Strength; Unexpected Escape | GPT-6.1-sol / `xhigh` | **10/10 accepted after correction; first pass 9/10.** Galactic Ambition hand departure and badge clearance independently verified. [Review](card-animation-a04-review.md) |
| A05 | New 10 | Evidence of the Crime; Fell the Dragon; Rival's Fall; Remnant Reserves; Palpatine's Return; Spark of Hope; Rule with Respect; Enforced Loyalty; Endless Legions; Commission | GPT-6.1-sol / `xhigh` | **10/10 accepted after correction; first pass 9/10.** Spark of Hope starts from the actual discard after selection and Replay. [Review](card-animation-a05-review.md) |
| A06 | New 10 | Timely Intervention; Moment of Glory; Choose Sides; Give In to Your Anger; Headhunting; Cripple Authority; The Chaos of War; Desperate Attack; Detention Block Rescue; Pillage | GPT-6.1-sol / `xhigh` | **10/10 accepted after correction; first independent pass 6/10.** Both Anger stages accepted. [Review](card-animation-a06-review.md) |
| A07 | New 10 | Bravado; Triple Dark Raid; Let the Wookiee Win; Spare the Target; A New Adventure; Final Showdown; Look the Other Way; Bounty Posting; Ma Klounkee; Swoop Down | GPT-6.1-sol / `xhigh` | **10/10 accepted on first independent review.** Both boundaries accepted. [Review](card-animation-a07-review.md) |
| A08 | New 10 | Surprise Strike; Relentless Pursuit; Evacuate; Altering the Deal; No Bargain; Smuggler's Aid; This Is The Way; Confiscate; A Fine Addition; Lethal Crackdown | GPT-6.1-sol / `xhigh` data author; root secondary draft | **10/10 accepted after correction; first independent pass4/10.** Corrected Deal/Way desktop/mobile ordered, natural and completed pixels plus lifecycle pass on frozen110. Canonical metadata guard separately independently verified in unbuilt source120; carry into next build. [Review](card-animation-a08-review.md) |

| A09 | New 10 | Hello There; Equalize; I Have the High Ground; Grievous Reassembly; Guarding the Way; Disruptive Burst; Death by Droids; The Invasion of Christophsis; Reprocess; Consolidation of Power | GPT-6.1-sol / `xhigh` | All ten integrated and frozen110 built; full smoke134root/294studio, kit and8 recorded regressions pass. Independent153 evidence probes,28 ending/alternate oracles and6 High Ground combat negatives pass after source corrections. Original first-pass1/10 after nine semantic/visual failures. **10/10 accepted after correction** on frozen120, including all eight corrected routes at both sizes. [Review](card-animation-a09-review.md) |

### R01 acceptance — 2026-10-11

Independent reviewer `animation_review_r01_v2`, GPT-6.1-sol / `xhigh`, reviewed all ten desktop five-frame contact sheets and natural completions, with mobile checks for wide and persistent-status effects. First pass accepted 7/10; Force Lightning, Overwhelming Barrage, and Make an Opening failed because persistent status text was outside the card's clipping boundary. The corrected three were recaptured on desktop and mobile and accepted, retaining first-pass failures. Final fingerprint: `14d30b084ef3fda67800072ac990884e39799f35221fc4ccf3d4e5aca9727e6e`.

Evidence: `results/card-effects-review/R01-gpt61/`, including `corrected/`, `lifecycle-review.json`, and [the durable review](card-animation-r01-review.md). All ten passed replay/reset, backward seeking, repeated natural completion, and reduced-motion completion; an interrupted wipe could not replace a newly selected scene. Author validation passed 134 root tests, 53 studio tests, analysis checks, both viewer builds, embedded kit checks, eight recorded before/after/replay/seek cases, and four live-polling cases. Skill refinements require inspecting actual final-status pixels and including shared styles/page source in capture fingerprints. This regression batch does not increase the new-authoring clean streak.

### R02 acceptance — 2026-10-11

Independent reviewer `animation_review_r01_v2`, GPT-6.1-sol / `xhigh`, accepted all ten after correcting Power of the Dark Side's missing opponent-choice attribution. Its correct ending board alone did not establish who selected the defeated unit. The receipt and caption now identify the opponent's choice; corrected desktop/mobile pixels, natural timing, reset and replay passed. First pass remains 9/10. Corrected fingerprint: `27de73f05ebbbb66eab44877b3b4d9ebdbe3450f10eae172dd12691f9b81a35a`. Evidence and individual scores: [R02 report](card-animation-r02-review.md) and `results/card-effects-review/R02-gpt61/`. All twenty baseline scenes pass persistent state, cancellation, reset, and reduced-motion checks. New-authoring clean streak remains zero.

### A01 acceptance — 2026-10-11

Independent reviewer `animation_a01_review`, GPT-6.1-sol / `xhigh`, accepted all ten and both explicit regroup-start examples after corrections. First pass remains 6/10. Power Failure's generic defeat badges obscured its surviving host; Change of Heart and Sneak Attack estimated arriving card slots incorrectly; Recruit's long generic receipt crowded the board. Measured final layouts, compound-receipt suppression and explicit trigger-boundary fixtures repaired these. A second mobile correction clamps the three-row receipt as a group. Final fingerprint: `56dafba4adea9b1163e0d86cdec49c358a4b18ac34f9b2f51e6ae0abd77dfa42`.

Evidence and all scores: [A01 report](card-animation-a01-review.md), `results/card-effects-review/A01-gpt61/`. Exact ending boards, natural timing, replay/reset, backward seek, cancellation, stage selection/deep links and mobile reduced-motion completion pass. Original failed captures remain available alongside replacements. The full integration smoke gate subsequently passed 134 root tests, 86 studio tests, analysis checks, both viewer builds and the embedded kit build. This 6/10 first pass resets the clean streak; effort stays `xhigh`.

### A02 acceptance — 2026-10-11

Ten new source-verified examples add private whole-deck search/shuffle, actual-healing-derived damage, current-phase recovery, sequential attacks with temporary bonuses, three exhausted deck arrivals, combat-triggered self-defeat, public reveal/reordering, Raid and player-chosen discard. Full smoke and embedded-kit builds pass. Independent reviewer `animation_a02_review`, GPT-6.1-sol / `xhigh`, accepted all ten after a **7/10 first pass**. Search Your Feelings, The Emperor's Legion and Heroic Sacrifice had correct final states but mobile hand arrivals were obscured by the caption; the shared measured-hand change also regressed Recruit. A measured footer beneath the hand corrected all four while preserving real landing slots. Final fingerprint: `552512c84c8806d8cc38e5e068bca9e699d4f522df2eddd19121bc647e4837e1`.

Evidence and scores: [A02 report](card-animation-a02-review.md), `results/card-effects-review/A02-gpt61/acceptance.json`. Every initial desktop/mobile contact and natural ending was inspected; all four corrections were recaptured at both sizes with natural timing, repeated completion, seek, cancellation, footer cleanup and reduced motion checks. Tiny frozen-raster hash differences remain documented with identical measured geometry/progress and 10–19 changed pixels among roughly 313,000; they were not hidden through favorable recaptures. Fourteen recorded plays passed before/after, Replay and backward seeking; the new reusable replay checker also passed the two affected search/recovery recordings after correction. Recruit retains a small, centered moving-card size change as residual polish. The pinned It Binds All Things zero-heal branch remains an engine limitation; no engine repair or fresh gameplay acceptance is claimed. The clean streak stays zero.

### A03 acceptance — 2026-10-11

Independent reviewer `animation_a02_review`, GPT-6.1-sol / `xhigh`, accepted all ten after a **9/10 first pass**. Precision Fire's symbolic Shield fracture left the original attachment badge visible during the subsequent combat. The correction hides each measured Shield chip before combat without covering its host; independent natural samples confirm it is gone at 39.2%, before the 49% simultaneous hit. The small dark chip-cover rectangle remains residual polish. Final production fingerprint: `f855f97f0e64795f61c36d19d94df3c1b8855c2bd1bd0f4329670a0eca328e15`.

Evidence and individual scores: [A03 report](card-animation-a03-review.md), `results/card-effects-review/A03-gpt61/acceptance.json`. All twenty initial desktop/mobile contacts, natural endings and natural timing contacts were inspected, followed by both corrected contacts/endings and nine timing samples per size. Independently declared ending-state oracles, repeated completion/reset, backward seek, cancellation, reduced motion, footer cleanup and browser-error checks pass. Original mobile frozen-hash failures remain preserved with unchanged geometry/progress and 4–18 changed anti-alias pixels; no favorable recapture was substituted.

Full smoke passed 134 root tests, 106 studio tests, analysis checks and both viewer builds; the embedded kit also passed. The corrected build passed 108 studio tests and both studio/kit builds. The first sandboxed smoke attempt could not bind five local mock HTTP servers; the approved loopback rerun passed. Both available recorded plays, Shoot First and Disarm, passed actual before/after, Replay and backward seeking on both builds; the other eight have no examples in the existing demo recordings. Sparse recorded Bamboozle returns retain generic movement receipts without invented alternate payment or token causes. A04's optional capture plumbing is present in the corrected source, but no A04 identity is registered or accepted. The clean streak stays zero and effort remains `xhigh`.

### A04 frozen review candidate — 2026-10-11

Production fingerprint `c1b2849b22d4d9d28ff149462c925aa2d6ad251d63d6100bc771b24a3111dcdd` has 60 registered identities. This is a review candidate, not another ten accepted cards. Author checks cover all ten desktop/mobile natural endings, finite rendering and focused hand/captive geometry. Before handoff, review of incomplete evidence caught unsupported zero-payment, rescue-exhaustion and hit-sequence claims; shared rendering/suppression predicates now reject those claims while retaining supported generic movement. Author mobile corrections separate dense labels from counters and held arrivals. These development fixes do not establish independent first-pass reliability.

Root smoke passed 134 root tests, 127 studio tests, analysis checks, both viewer builds and the embedded kit. `results/card-effects-state-check/a04-recorded.json` passed the sole available recorded Calculated Lethality action through actual before/after, Replay and backward seeking. Nine other identities have no existing recording; no games were generated. Author evidence remains under `results/card-effects-review/A04-gpt61/source-*`, including the preserved Father mobile hash diagnosis (10 edge pixels, maximum channel delta 1, stable progress/geometry). Independent reviewer `animation_a05_spec`, GPT-6.1-sol / `xhigh`, preserved the frozen source in `source60/`. Its natural mobile review found Galactic Ambition’s incoming Wampa and counters obscured by the caption at about 30%, despite correct fixed frames, landing and final state. Root inspected `lifecycle-mobile/galactic-ambition/natural-30.png` and confirmed the failure. Frozen 70-card review confirms caption clearance, but a second ~31% collision remains: the signature’s FREE HAND PLAY badge covers the travelling Wampa’s counters. The renderer is correcting that label before the next frozen build. Initial evidence remains unchanged. This batch cannot earn a clean first pass.

### A04 and A05 final acceptance — 2026-10-11

Independent reviewer `animation_a05_spec`, GPT-6.1-sol / `xhigh`, accepted both ten-card rounds on frozen production fingerprint `5711c6dd384fb40ed2e224bed2616e6bd28ebb400843ba9972f5c628ccb56198`. This brings the accepted count to 70, not 80: A06's main signatures were not imported in this intermediate build. A04 and A05 retain their separate **9/10 first passes** and original failed captures. Neither earns a clean batch.

Galactic Ambition now keeps its travelling Wampa and 4/5 counters clear of both caption and FREE HAND PLAY badge throughout the early natural route. Spark of Hope now measures geometry after the new cue's board commits: selection immediately after Palpatine's Return and Replay both highlight the actual discard origin, without attributing the effect to surviving Defender. Their final readability/meaning/impact scores are both 4/5/4. A nearby Spark receipt overlaps only decorative base-ring art; the full HP numeral remains visible.

Separate acceptance receipts are `results/card-effects-review/A04-gpt61/acceptance.json` and `results/card-effects-review/A05-gpt61/acceptance.json`; durable details and individual scores are [A04 review](card-animation-a04-review.md) and [A05 review](card-animation-a05-review.md). The reviewer actually inspected all 22 affected desktop/mobile ordered contacts, 22 natural timing contacts and 22 natural completed boards, plus early source-route frames. All 20 source ending oracles and 40 rendered ending oracles pass. Affected scenes pass Replay/reset/backward seek, cancellation, reduced-motion completion and browser-error checks. Arriving cards and resource slots align within two pixels. Preserved broad alignment failures are ordinary surviving-card reflow; preserved mobile raster differences are four corner pixels with maximum channel delta one and unchanged progress/geometry.

The correction build passes full smoke (134 root / 179 studio tests, analysis and both viewers), embedded-kit build, and the two available recorded actions: Calculated Lethality and Commission. Eighteen identities have no matching recording; no games were generated. A06 integration subsequently passes 185 studio tests and typechecking, but its complete-build and independent visual review remain pending. The accepted-count increase does not change the zero clean streak or `xhigh` effort.

### A01 candidate mechanics

The following identities and mechanics were checked against installed JSON and their `forceteki/server/game/cards/01_SOR/events/` implementations. All are implemented and accepted; six passed first review and four required correction.

| Identity | Canonical print | Required demonstration / new question |
| --- | --- | --- |
| Moment of Peace | SOR_073 | Give one unit a Shield; retain the token after playback. |
| Mission Briefing | SOR_171 | Chosen player draws two; deck and hand counts and destination agree. |
| Keep Fighting | SOR_169 | Ready a unit with current power 3 or less; the completed pose stays ready. |
| Outmaneuver | SOR_221 | Exhaust all units in the selected arena on both sides; other arena stays unchanged. |
| Attack Pattern Delta | SOR_106 | Three distinct friendly units receive +3/+3, +2/+2, and +1/+1 for the phase. |
| Power Failure | SOR_170 | Defeat selected upgrades on one unit; distinguish upgrades from the host and reflect resulting stats/tokens. |
| Change of Heart | SOR_224 | Non-leader changes controller; ownership stays distinct and control returns at regroup. Immediate scene must label the delayed return. |
| Sneak Attack | SOR_219 | Play a unit from hand at cost −3, entering ready; delayed regroup defeat is not an immediate defeat. |
| Recruit | SOR_123 | Search top five for a unit, reveal and draw it; do not imply five cards were drawn or reveal unavailable replay information. |
| Strike True | SOR_127 | Friendly unit deals its current power to an enemy unit; this is damage, not an attack/exhaustion. |

## Acceptance record format

For each dispatched batch, add one record with: date and source revision/fingerprint; actual model and effort; exact ten IDs; skill revision; authored/regression classification; per-card first-pass verdict and readability/meaning/impact scores; final verdict after fixes; state assertions and test/build result; frame manifest and independent review paths; concrete failures and resulting skill edits; unresolved gaps and next batch.

Keep first-pass verdicts after repairs, so effort decisions cannot count revised work as a first-pass success. Record who authored and who independently reviewed. Review paths must point to existing evidence before recording a pass. Generated artifacts under `results/` are ignored; retain their relevant findings and paths here.

## Effort policy and present status

Starting effort: GPT-6.1-sol / `xhigh` (explicitly confirmed). Clean newly authored streak: **0 batches** after A08 independent semantic failures. No reduction is earned; retain `xhigh`.

After two consecutive newly authored rounds pass 10/10 on the first independent semantic/state/pixel review without regressions, trial `high` on the next ten. Keep the same acceptance checks. Further reductions require two clean authored rounds at the current effort; a material failure restores the last reliable higher effort and resets the streak. Baseline regression rounds do not count toward this authoring reliability threshold.


## A06 frozen candidate and first independent evidence failures

Complete 80-card production fingerprint `5758df9e07be7a4dfcd6fd5fc4247cf963e43f5ef8cd09e801fc3a3d39a18d45` is frozen for independent review. The preceding full smoke passed 134 root / 185 studio tests, analysis and both viewers; the final correction passed all 185 studio tests, typechecking and studio/kit builds. Eight existing actual replays pass before/after, replay and backward seek: four Timely Intervention actions (including Smuggle, Piett and Ambush), Chaos of War, Desperate Attack, Calculated Lethality and Commission. Seven A06 identities have no existing recording.

The independent reviewer found four material evidence-gate failures before formal pixel capture: Anger accepted the wrong causing event, Headhunting accepted inflated source power, Detention accepted a ready rescue behind an exhausted receipt, and Pillage accepted random selection as player choice. All were preserved, reproduced in maintained tests, and corrected; the independent gate harness now passes 31/31. These are first-review failures and keep the clean streak at zero. Author corrections also preserve paid-event disposal and continuous attacker visibility through movement handoffs. A06 is not accepted until the independent full visual review completes. A07 source work proceeds against a separately frozen A06 build.

## A06 acceptance — 2026-10-11

Independent reviewer `animation_a05_spec`, GPT-6.1-sol / `xhigh`, accepted all ten cards and the separate Anger next-action scene at frozen fingerprint `5758df9e07be7a4dfcd6fd5fc4247cf963e43f5ef8cd09e801fc3a3d39a18d45`. The first independent pass remains **6/10**, retaining the four earlier semantic failures. All 22 desktop/mobile rendered ending and lifecycle cases pass, alongside 11 source ending oracles and 31 evidence-gate probes. The reviewer inspected every ordered contact, natural timing contact and natural ending, plus Timely's entry-to-Ambush and Headhunting's survivor handoffs.

All actual arriving/continuing overlay cards land within 1.131px of their final positions. Ordinary removed-slot and pocket reflow probe failures are preserved and adjudicated separately. Three initial mobile image hashes differ by four corner pixels each at maximum channel delta1 with identical identity/progress/geometry; no favorable recaptures replace them. Eight existing recorded checks pass, with seven A06 identities unavailable. Source, scores and retained failures are in [the review](card-animation-a06-review.md) and `results/card-effects-review/A06-gpt61/acceptance.json`. The accepted count is now 80 of 2,458. The clean authored streak remains zero, so effort remains `xhigh`.

## A07 frozen handoff — 2026-10-11 local / 2026-10-12 UTC

Production candidate fingerprint: `7e153d55dd9f335d451d739d030830939cffb75a90c42bf31d43418e97099f08`. Root smoke passed 134 root tests, 216 studio tests, analysis checks and both viewer builds; the embedded kit passed. The independently authored source oracle and gate harness passed again against the immutable frozen snapshot: 12 complete endings and 72 evidence probes. Root executed those reruns; they are not an independent production pixel review.

Author corrections preserve Swoop's base-counter clearance, Ma's actual upgrade-owner disposal and Raid's exact earlier causing source. All author ordered contacts and valid natural timing contacts have been inspected. The original wrong-card sampler files and Bravado hover-contaminated capture remain marked invalid; replacement evidence is separate. Actual recorded before/after, Replay and backward seek pass for Spare the Target, Commission and four Timely Intervention actions (six unique cases; the first Timely case appears in both reports). Nine A07 identities have no recording. No fresh games were generated.

All three active GPT-6.1-sol / `xhigh` agents returned account usage-limit errors before independent A07 production capture. The candidate and 42 source files plus 167 rule-reference files are preserved under `results/card-effects-review/A07-gpt61/source90/`; `frozen90-handoff.json` records the checks and gaps. Keep the production build frozen for the remaining independent desktop/mobile matrix, two boundaries, completed-board oracles and lifecycle checks. Accepted count remains **80/2,458**, with **2,378 not yet accepted**; clean streak zero and requested effort unchanged.

The local continuation checkpoint identifies the next actions. The new [reuse catalogue](card-animation-reuse.md) records 13 demonstrated extraction/derivation candidates and their semantic differences; maintaining it is now part of each batch. No refactor or A08 product installation was performed during this documentation update.

## Goal resumed — 2026-10-11 local

The user created an explicit goal to complete all cards and authorized up to 200 concurrent workers. The session provides four concurrent slots including root; three GPT-6.1-sol / `xhigh` workers are active on A07 independent review, A08 main rendering and A09 rules/contract preparation. The account usage block has cleared. Production90 remains frozen; A08 source100 is separate and unbuilt. Accepted count remains80 until independent receipts complete. The ongoing reuse catalogue and skill remain part of each batch.

## A07 acceptance and A08 author candidate — 2026-10-11 local

Independent reviewer `animation_a05_spec`, GPT-6.1-sol / `xhigh`, accepted A07 **10/10 on its first independent review**, including Raid phase-end and Final Showdown regroup at both sizes. The reviewer inspected all 24 ordered contacts, 24 natural timing contacts and 24 overlay-free natural endings. Source ending oracles12/12, evidence probes72/72 and rendered ending/lifecycle cases24/24 pass. All actual arrivals land within1.20px; ordinary surviving-card repacking remains explicitly separate. Three initial mobile exact-image failures are preserved and quantified as four rounded-edge pixels each with maximum channel delta1 and identical identity/progress/geometry. [Review](card-animation-a07-review.md), `results/card-effects-review/A07-gpt61/acceptance.json`.

The accepted count is **90/2,458**, with2,368 remaining. The clean authored streak is **1**, which does not yet earn an effort reduction. Production90 is released for the next build. A08 has100 registered source identities and253 passing studio tests; main author captures and the frozen100 build are next. Root inspected corrected Confiscate/Evacuate/This Is The Way at both sizes, including six natural timings and overlay-free endings. Attachment-only masking retains the neighboring Shield, the upgrade flight stays portrait, and the private-eight-card strip is compact. The corrected mobile Way exact-hash failure is preserved (four lower-right caption-edge pixels, delta1, unchanged identity/progress/geometry). This is author evidence, not independent A08 acceptance.

## A08 first independent semantic failures

Independent reviewer `animation_a05_spec` preserved eleven failed negative probes in `results/card-effects-review/A08-gpt61/independent-gates-initial.json` and its exact loaded source snapshot. All five secondary signatures accepted a coherently reduced event payment because their shared predicate checked internal totals without comparing the required printed/aspect cost. Surprise Strike also accepted prevented combat receipts; No Bargain and This Is The Way accepted prevented draws/searches behind successful final states. Their five first-pass failures remain recorded, regardless of later fixes. The clean authored streak returns to **zero**; effort remains `xhigh`.

Root corrected canonical source/cost validation and prevention checks, adding maintained coherent-underpayment/source-title and prevented-receipt probes. All 255 studio tests and typechecking pass; independent correction reruns remain required. Separately, author pixels found A Fine Addition's transferred Armor label covering most of the host art on mobile. The name now has its own ellipsized line above the preserved owner/controller row, and the measured-layout clone uses the same markup. Corrected Addition and accepted Evidence of the Crime captures are required before build. This author finding does not replace the independent five-card failure receipt.

### A08 frozen100 handoff — 2026-10-11

Fingerprint `56cfac8ae5ca15e72c84f2a990a98f60e42fb2a4d09307ee2cd3503bda4fbb3a` passes full smoke (134 root / 256 studio tests, analysis and both viewers) and embedded-kit build. Two existing A08 recorded actions (Smuggler's Aid and Lethal Crackdown) and six affected earlier actions (four Timely Intervention, Commission and Spare the Target) pass actual before/after, Replay and backward seek. Eight A08 identities lack recorded examples; no games were generated. All author corrections are inspected, including the shared transferred-upgrade regression for Evidence of the Crime.

The independent reviewer saved all45 served source files,214 rule references and the separate card loader under `results/card-effects-review/A08-gpt61/source100/`; independent frozen-source ending oracles21/21 and evidence/render-suppression probes122/122 pass. Production stays frozen for all ten independent desktop/mobile visual and lifecycle reviews. A09 product source may advance separately. The complete handoff and preserved validation logs are `results/card-effects-review/A08-gpt61/frozen100-handoff.json`. No A08 visual acceptance is inferred.

A07 post-acceptance coherent-underpayment regressions for Raid/Posting independently pass2/2 after the current-source correction. The old source90 failures and original acceptance remain distinct evidence.

### A09 expanded independent source review

The initial exact-cause failure was corrected, but the independently expanded153-case pass found eight more failures: coherent false canonical names in five secondary signatures, two High Ground ending-phase/round mismatches, and a no-hand-unit Consolidation rendering that falsely said the play was declined. Canonical-definition/current-phase guards and neutral **NO UNIT PLAYED** captions now pass153/153 independently at `39409637ea6ec85ca16414a809b3b56b2c18aa99355bd5e47aec300b9d9c9632`. Manual source examples pass28/28 plus six explicit later High Ground combat negatives. The full maintained studio suite passes294/294 and TypeScript passes. Preserve initial/expanded/corrected source bytes and receipts in `results/card-effects-review/A09-gpt61/`; six distinct first-review failed identities leave a4/10 ceiling. No A09 acceptance is implied before frozen production pixels/lifecycle.

### A08 acceptance and A10 integration — 2026-10-12 UTC

Independent A08 receipt `results/card-effects-review/A08-gpt61/acceptance.json` accepts10/10, bringing the catalogue to100 accepted /2,358 remaining. First pass4/10 and clean streak0 are unchanged. The canonical-name follow-up is independently verified in current source and must ship with the next build; production110 remains frozen for A09 review.

A10 data and root integration are now installed:120 registered,324 studio tests and TypeScript pass. Main signature authoring and desktop/mobile author inspection remain underway. The two explicit Later-action examples start from the paid immediate state without replaying event costs. Root updated the capture script to choose the correct Later action UI label. A11 has read-only research and contract preparation only.

### A09 route findings and A10 author corrections

A09 independent natural inspection found eight paid source flights covering unit counters around11–13% on mobile; combined with the six source/choice-label failures this makes nine distinct initially failed cards and a1/10 first-pass ceiling. The earlier4/10 ceiling is superseded, not erased. Endless Legions' existing TOTAL badges also covered own base HP21. Keep production110 frozen until the reviewer clears the retained original evidence; narrow main/secondary source routes and badge corrections are being verified in source120.

A10 main and secondary signatures are installed; full331 studio tests and TypeScript pass. The initial source120 fingerprint `aa55510554706a79e05d508b0216ff2bbc8fedf72c551e56af02ea15062cb3c5` and root's inspected image hashes are retained in `results/card-effects-review/A10-gpt61/root-secondary-initial-review.json`. Five secondary payment flights, Outflank's defeat routes, U-Wing's private fan, and Take Captive's arrival count need corrections. Both ordered and natural ordinary endings were correct in root's six-scene set; that does not excuse obscured intermediate counters. Accepted remains100; clean streak0. A11 isolated data drafting is authorized, with no product installation before immutable120 handoff.

### A10 expanded evidence and route corrections

Independent preparation found13 semantic failures across four A10 identities, retaining a6/10 first-pass ceiling: Outflank cause/sequence/identity/zone, Petition exact Official identity, and Pyrrhic/Kamino retained-status kind/duration. Narrow source corrections and maintained cases pass332 studio tests and TypeScript. Author execution of the unchanged expanded199-case harness passes199/199; independent rerun remains separate. Manual independent34 ending/alternate oracles pass.

A09 BUILD-CLEAR110 has been received with all original649 image hashes and first-pass1/10 preserved. Root source v3 reviewed22 counter-route contacts at11–16%; U-Wing v4 fixes the private fan, compact arrivals and caption clearance at desktop/mobile, with all ordinary endings separately inspected. Main final source inspection continues. Full smoke/kit, four existing A10 native recordings, frozen120 and immutable reviewer handoff remain next. A11 data is frozen in isolation with25 focused/356 isolated tests; integration must preserve the newer previewState grant guard. Accepted remains100.

### Frozen120 handoff

Author corrections are complete. Production preview5191 is frozen at `dea57742ed505e3ffb736381fd853824c68eac5e990ec16535af60709c16d11c` (51 manifest files). Full smoke134root/332studio, analysis, both viewers and embedded kit pass. Four actual existing A10 plays pass recorded before/after, Replay and backward-seek checks: three Manufactured Soldiers choices and The Clone Wars. Eight A10 identities plus U-Wing/Endless lack existing recordings; no games were generated. The independent source checks pass199/199 plus34 manual oracles, and the immutable final-source handoff precedes A11 product installation. All original author/independent failures are retained in `results/card-effects-review/A10-gpt61/frozen120-handoff.json` and its referenced evidence. Accepted100 remains unchanged until independent frozen pixels/lifecycles pass.

### A11 integration and isolated author correction — 2026-10-12

Frozen120 has an independent immutable-source ACK and remains under review; A11 data and root secondary presentation are installed, bringing the registry to130. Full362 studio tests and TypeScript pass. Root inspected ten ordered contacts, ten natural timing contacts and ten separate ordinary endings; a shared receipt-width failure affected its five scenes and is corrected in isolation for recapture. Original190 image hashes and exact source remain under `A11-gpt61/`; no acceptance is claimed. A12 verified specification/contract are approved for isolated data implementation only. Accepted100 and clean streak0 remain unchanged.

### A09 acceptance and A11 complete source — 2026-10-12

Independent reviewer `animation_a05_spec` accepts all ten A09 identities on frozen120 `dea57742ed505e3ffb736381fd853824c68eac5e990ec16535af60709c16d11c`: **110 accepted / 2,348 remaining**, first1/10 and clean streak0 unchanged. The corrected eight source routes pass both-size ordered, natural, separate ordinary-ending and precise11–13% inspection; all20 ending/lifecycle cases pass, along with153 source gates,28 manual oracles and6 later negatives.524 correction PNG hashes and the transparently reused original Equalize/Invasion evidence are preserved in [the review](card-animation-a09-review.md), `A09-gpt61/acceptance.json` and `correction120-acceptance.json`. U-Wing hardening passes. A separate Endless early-label collision remains recorded and is corrected in source130 under author inspection.

A11 main integration and negative gates bring the maintained suite to367 passing tests; TypeScript passes. Root's corrected five secondary signatures pass ten ordered contact sheets and ten separate natural endings at both sizes, with unchanged motion's earlier natural timings retained. The common label-width failure and three harmless quantified raster differences remain in the v1/v2 author reports. Main capture jobs completed against source130 `563a43e3559d7bf4e7bd3e0b0af841c6fe4c239aedb9e242c7ce36e686acb975`; independent A10 review still owns frozen120.

### A10 acceptance and frozen130 — 2026-10-12

A10 independent10/10 acceptance and BUILD-CLEAR120 are durable: [review](card-animation-a10-review.md), `A10-gpt61/{acceptance,first-pass,build-clear120}.json`. Current **120 accepted /2,338 remaining**. First6/10 and clean streak0 remain. All24 desktop/mobile primary/later ordered, natural and ordinary-ending sets were inspected;24 manualDOM/lifecycle cases,34 source oracles and199 gates pass.670 independent PNG hashes preserve first failures, raster comparisons and invalid-sample classifications.

A11 author scopes and separate Endless early label/fan corrections are clear at `ed53bf9df50643f1d471c7e21ba10f783dc9b005219e76401c7c6dbc7f370a0f`. Full smoke134root/367studio, analysis, both builds, embedded kit and both available recorded A11 plays pass. Eight A11 identities and Endless have no recording; no games were generated. Production130 is frozen for independent review, with `A11-gpt61/frozen130-handoff.json` preserving source hashes/logs. A12 remains isolated until immutable130 ACK.

### A12 source integration — 2026-10-12

After independent source130 ACK (54 served files/335 authorities and support), root installed A12's frozen seven data files, five integration files, five secondary renderers and five maintained negative groups. Every base hash matched; data bytes remain unchanged. Final isolated composite398/398 tests and TypeScript pass. The first typecheck's two unused copied helpers/imports were removed before the final pass. Registry140; accepted120 unchanged. Main rendering and root desktop/mobile inspection are underway; production130 remains frozen for A11 independent review.

### A11 independent evidence findings

The first valid independent252-case pass found eight failures across all five secondary identities: initiative could change without a receipt in all five; Daring accepted an unsatisfied defeat prerequisite, Strategic Analysis accepted an unsatisfied Official-trait condition, and Bold accepted an unrelated attack restriction. The first-pass ceiling is5/10, clean streak0. Initial harness-invalid cases remain separately classified; only valid failures count. Production130 stays unchanged.

Root corrected the source140 predicates without changing rendering, added the eight maintained negatives, and carried initiative/unsupported-condition checks into the new A12 secondary proofs. Product398/398 and TypeScript pass. Root's execution of the unchanged252-case independent harness passes252/252 but is explicitly author execution, pending the independent correction receipt. A12 source140 secondary author snapshot56files is immutable at `99cb3e710dc9e1a4bd64bc917d5dd31dbcac3ddfcb716ebeb755b69e7abdcd2d`; its local build/captures are isolated from frozen130 and ongoing main/UI work.

### A11 expanded Grit audit and A12 author visual failure

The independent expanded A11 audit found Corner's native-Grit survivor factory and rich-gate error, plus Grenade/Blood externally supplied damage receipts with stale surviving-Grit power. First-pass ceiling4/10, clean0. Initial evidence is preserved; the source140 factory/main/secondary corrections keep unsupported resting-stat stories generic, and96 maintained gate groups pass. Independent corrected reruns remain required.

A12 root source99cb has30 actually viewed artifacts: ten ordered contacts, ten natural timing contacts and ten separate endings. Clear the Field needs a mobile layout correction: the after-layout hand row overlaps the taller before-layout ground row. The other four secondary scenes are initially clear, with no independent acceptance. The tiny In Pursuit held-raster exception is preserved and quantified. A13 isolated data drafting is authorized after verified source/contract review; no product release yet. Accepted120, registered140 and2338 unaccepted remain unchanged.


## A11 accepted; A12 source140 author corrections — 2026-10-12

A11 is independently accepted10/10 at frozen140 fingerprint23f8258e6210acfed4fcc07fdbb4964883d1558c3198aaf624d10222729dd31f; original first4/10 and clean streak0 remain. Independent255 gates and19legal+1unsupported Grit oracle pass;240 primary SSR samples match prior reviewed130 pixels. Exact57served files and335 authorities are archived; acceptance and correction140 receipts are in A11-gpt61. Total130 accepted,140 registered,2,328 remaining. Endless early reveal correction is separately accepted.

A12 current140 candidate passes full smoke134root/411studio, analysis, both viewer builds, kit and3 available recorded plays. Author capture still rejects early mobile footer inflation and Impropriety regroup overlap; Aid Later also retained an old permission thumbnail during its flight. Main has saved narrow unbuilt fixes for viewport-relative footer fallback, A12 arena footprint and actual thumbnail masking. A12 Grit and native Sentinel factory/rich regressions are corrected with original failing evidence retained. Next build needs corrected A12 captures plus a targeted earlier paid-hand scroll regression; no A12 acceptance yet. See the current resume checkpoint and A12-gpt61/clear-v2-author-review.json for exact source/evidence boundaries. A13 remains isolated drafting only.

### A12 final140 independent semantic correction (2026-10-12)

Initial immutable23 validated gates299/317 exposed18 failures in the five secondary signatures (phase, invented permission/pending, two unestablished exhaustion constraints, mixed watcher history); three invalid probes are classified separately. The unchanged317-case independent correction passes at secondary b396c8a. First-pass ceiling5/10 and clean streak0 remain; no A12 acceptance yet. Final source9cf05f441d517926bb7c202a09464b6256c6e9a7775f96f78d79f285d1fe4372 includes that semantic correction and Aid provisional positive-size clamp. Studio411/build/kit and all3 existing recorded examples pass; seven missing recordings remain explicit. Final source57 and authority369 files independently archived. Final Aid author pixel check and full independent visual/lifecycle/source review remain.

### A12 independent acceptance — 2026-10-12

Independent reviewer `animation_a05_spec`, GPT-6.1-sol / `xhigh`, accepted all ten A12 identities at final140 fingerprint `9cf05f441d517926bb7c202a09464b6256c6e9a7775f96f78d79f285d1fe4372`. Durable [review](card-animation-a12-review.md), `A12-gpt61/acceptance.json` and `build-clear140.json` establish **140 accepted / 2,318 remaining**. Initial18 failures across five secondary identities remain; first-pass ceiling5/10 and clean streak0. All317 independent gates,25 source oracles and26 rendered ending/lifecycle cases pass. The reviewer actually inspected26 ordered contacts,26 natural contacts,26 ordinary endings and20 early-payment contacts;697 independent PNG hashes and101 inspected artifacts are preserved. Full frozen DOM matches26/26; the retained raster exceptions affect rounded edges only, up to24 pixels/channel delta6. Exact57 served and370 authority/support files pass immutable hash checks.

Author verification remains separately attributed:411 studio tests, studio/kit builds and the three available recorded plays pass; seven cards lack recordings. A11's targeted scroll-entry regression also passes4/4 with its stated footer/counter scope. Source150 for A13 is registered and passes452 studio tests/typecheck, but remains unaccepted. Four recorded handoffs pass on its isolated09ec5d62 candidate; six cards lack recordings. Initial A13 main author inspection found three temporary-display contradictions (Breaking In's expired attack bonus/ready face, Prisoner's old captive count, Unmasking's duplicate selected preview); correction is in progress before final150 review.

### A13 initial independent evidence finding — 2026-10-12

Initial immutable09 review passes303/305 gates. Political Pressure's successful-discard branch accepted both a missing result and an explicit unknown result because it only excluded the failure branch. First-pass ceiling9/10, clean streak0. The two maintained negatives fail before the correction; explicit `result === 'discarded'` now passes452 studio tests and TypeScript. Independent correction rerun is pending. Initial source60files/412 authority-support files, gate script and original failures remain archived. This does not increase acceptance above140.

### A13 frozen correction review; A14–A16 isolated pipeline — 2026-10-12

A13's complete independent ccb29a review passes322 gates,29 manual source oracles and20 rendered lifecycle cases, with87 actually inspected artifacts/562 PNG hashes. All natural/held endings and20 measured arrivals pass. A remaining desktop Prisoner receipt obscures Cruiser's HP7; together with the original Political result bug, first-pass ceiling is8/10, clean0. Original pixel/hash failures remain. Main's measured-gap correction62d3 changes only function Prisoner graphics; author11 targeted artifacts pass. Independent correction-only build release received; root production752b14ad now passes452 studio tests/tsc and studio/kit builds. Exact60 source archive and independent60+414 preflight verified; targeted independent correction review is in progress. Acceptance remains140/2458.

A14 final seven data files pass36 focused/483 isolated tests/tsc. Root secondary author correction04dd2aaf passes493 tests/build and23 actually inspected correction images; Drop's initial transient counter overlap is fixed. Original33 viewed artifacts and AllClear's quantified10-pixel/max1 border raster exception remain. Root boundary wiring adds Gate Later/unused-expiry and Heat expiry; isolated495 tests/tsc pass. Main five authoring continues; no product160 installation.

A15 final seven data files pass40 focused/523 isolated tests/tsc, with two explicit phase-end packets. Root five secondary predicate groups pass, including independent XP after prevention, current title-set grants, actual exhaustion-linked X-Wing creation and strict census; isolated170 integration underway, no pixels yet. A16 full source/spec/contracts are ready and isolated data authoring has started against frozen A15. No additional accepted identities, generated games or engine edits.

### A13 accepted; A14 full isolated source — 2026-10-12

A13 is independently accepted10/10 at production752b14ad. Durable acceptance.json/build-clear150.json and review preserve first-pass8/10/clean0. Independent322 gates,29 source oracles, initial20-case lifecycle matrix and corrected Prisoner desktop/mobile checks pass;615 own PNG hashes/100 actually viewed artifacts retain all original failures. Total150 accepted/2308 remaining. A14 full isolated candidateb1c88e72 on5195 combines exact final data, main and secondary/UI drafts;503studio tests/build pass. Independent63served+448authority archive is verified; semantic review and main author pixels run concurrently. No product160 install yet.

### A14 frozen production160 review; A15–A17 isolated work — 2026-10-12

A14 corrected full candidate is installed and frozen on5191 at `9c02c377472566f447fc1ecf37a0fa74f6943cd0ef0887cd91d0bdb79728e0b5`. Exact63 served source hashes match the reviewed isolated candidate;503 maintained studio tests and studio/kit builds pass. Main author inspected84 artifacts across five primaries/three boundaries and Medal regression; root inspected36 shared secondary artifacts. All26 natural endings match held; no unresolved material author finding. Independent339 gates and36 full source oracles already pass against the identical isolated source; matching production full visual/lifecycle review is now requested. Original six affected source identities yield ceiling4/10/clean0. Accepted remains150, registered160, unaccepted2308. One trailing whitespace in frozen Card.tsx is deferred to the next source revision so the review fingerprint remains unchanged.

A15 root five primary/phase scenes and observed Pilot attachment-to-ground support are isolated. Initial author failures in Apology XP/native Sentinel, Wings counters and Unity expired phase chip are corrected; original evidence remains. The synthetic observed Eject regression exposed attachment-chip landing geometry, compound draw-label overlap and a draw route through unit counters. Corrected outside-margin draw is reviewed at source3bf52a; compact Pilot travel follow-up is being built. This synthetic route check is not existing recorded-game coverage. Main author now verifies and implements Scramble/Salvage/Dogfight/Tandem/Eject from installed rules and full contracts.

A16 final data passes53 focused/576 isolated tests/typecheck. Root five signatures plus integrated UI pass611 tests/build at isolated180 sourcee583566e. A new meaningful Timely phase-boundary routing test exposed a dropped causing source; preserving that event fixes the failure, which remains saved. Desktop/mobile ordered/natural captures are complete and await actual inspection. A15/A16 main modules are not rendered in this isolated candidate. A17 authoritative source/spec/contracts are prepared by the data worker; isolated data work follows. No engine edits, commits, new games or paid calls.

### A14 independent acceptance — 2026-10-12

A14 is accepted10/10 plus three explicit boundary scenes on frozen160 `9c02c377472566f447fc1ecf37a0fa74f6943cd0ef0887cd91d0bdb79728e0b5`. [Independent review](card-animation-a14-review.md), `A14-gpt61/acceptance.json` and `build-clear160.json` establish **160 accepted /2,298 remaining**. Independent339 gates,36 complete manual source oracles and26 desktop/mobile ending/lifecycle cases pass;118 actual inspected artifacts and706 own PNG hashes preserve the original failures. First-pass ceiling4/10 and clean streak0 remain. The shared Medal Sentinel/Experience regression passes both sizes. Four available recorded actions across three identities pass separately; seven identities have no recording. No new games were generated.

A15 full isolated candidate `9206aa246da2cb63fce685ec111a81c43ca99466f073897a77cd50c5d42669bf` passes558 studio tests/build; all66 source files are frozen under `source170-full-v2`. Author review found Scramble arrivals crossing previous mobile restriction labels; correction and new-token physical-history checks are in progress. Independent A15 source review now runs against the preserved v2. Root secondary ten ordered contacts show no material shared-layout regression; natural/ordinary/phase/generic route review continues. A16 root secondary is author-clear at isolatedv3 `187ccfb99f8460bf20ab01a647da73cd53145e90b5a84c3dfb000281dc901374`; full main remains pending. A17 primary receipts are provisional, with all ten factories resolving and root-five source/rendering drafts underway. None increases acceptance above160.

### A15 frozen170; isolated A16–A18 progression — 2026-10-12

A15 final `b3118e86d8678f21e2c9937475a2fbee62c83adc7ef92ace6b94b940426b417e` is installed/frozen on5191, with66 archived/served source hashes,558 tests and studio/kit builds passing. Main author92 actual artifact views and12 lifecycle cases pass; root secondary62 views clear five primaries, Unity expiry and synthetic observed Pilot detachment. Scramble arrival/header collision and upright exhausted arrival were corrected; generated physical IDs with any prior incarnation history now reject rich creation in Scramble and Wings. The coherent original Wings failure and corrected test remain. Independent385 gates/46 manual oracles pass; full final production visual/lifecycle review is underway. Four existing recorded plays pass separately; seven identities have no recording. **Acceptance remains160/2458**, clean streak0.

A17 final data46 focused/622 isolated tests and root integrated668 tests/build pass. First root pixel review finds mobile retained Experience hidden by native Overwhelm under three tokens; isolated ordinary Card compact-row correction is being captured. A16 main authoring and A18 source-backed data continue. No tests, builds or captures alone increase acceptance.

### A17 secondary author clearance; A16 shared hooks — 2026-10-12

A17 root five are author-clear at final isolated70-sourceb0a993043386b9bd5c29b0da58263cb5cb5fb06303e22fd96da0f7fac11bc35c. All51 actually inspected artifacts are hashed in `A17-gpt61/secondary-v3-author-review.json`; v1/v2 mobile failures and tiny raster diagnoses remain retained. Compact token rows preserve both Shields and XP before Piercing; its damage header no longer hides XP after removal. Final both-size ordered/natural/separate endings pass.668 prior semantic tests and final rendering-only build pass. Independent acceptance remains pending, total160 unchanged.

A16 main worker resumed after capacity errors; root shared drafts now support exact generated Sentinel chips/marks and intermediate token-before-unit geometry. A18 root source pass and exact-print existing replay inventory complete; none of the twelve existing games includes an A18 event play. No engine edits or new games.


### A15 independent acceptance — 170 total

A15 accepted10/10 plus Scramble/Unity phase boundaries at frozen170 `b3118e86d8678f21e2c9937475a2fbee62c83adc7ef92ace6b94b940426b417e`. Independent385 gates,46 full source oracles,24/24 lifecycle/endings and both-size actual pixel inspection pass. Reviewer retained642 hashed PNGs and104 distinct actually viewed artifacts. Original first-source ceiling8/10 and generated physical-ID failures remain recorded; clean streak0, effort stays requested GPT-6.1-sol/xhigh. Four existing actions (Wings2,Eject1,Scramble1) pass separately,7missing. Acceptance and BUILD-CLEAR170 are in `results/card-effects-review/A15-gpt61/`; [review](card-animation-a15-review.md).

A16 full candidate180 source-v3 is frozen separately at `3ebfaf95e38519a4c9610f488d041199ae26063c0446fdfe2ee2b4e5768e2951`,69 source files,623studio tests/buildPASS. Main author checks and root secondary regression are running; independent source review starts. Source corrections preserve no second Hotshot attack when native damage already defeated target and reject unsupported active base protection in Lightspeed allocation. No A16 acceptance yet.

### A16 correction and A18 author progress — 2026-10-12

A16 initial independent gates372/381 and source checks45/47 retain real token/source, unsupported no-play and cumulative-lethal findings. All primary/boundary source oracles pass; alternate Trench self1+counter2 and Hotshot initial2+indirect1+counter4 exposed shared missing damage accumulation. A separate two-file data correction has59focused/582full isolated tests and unchanged ten primary/Timely boundary packet hashes. Main/root proof and measured HP corrections are consolidated into full-v4, awaiting integrated checks and new independent pixels. Accepted stays170/2458.

A18 final data40focused/662isolated; root integrated715tests/build pass. Root inspected31 distinct v3 artifacts (ten ordered contacts, ten natural contacts, ten separate natural endings, one raw mobile trail finding). Jam/Diversion/Pulse ordinary results are clear; Barrel/Punch mobile trails and late result labels require v4 correction review. A17/A18 printed-event token contradictions were reproduced in ten maintained groups and corrected (156/156 evidence groups pass). No acceptance inferred from these author results.

A16 follow-up: corrected full-v4 independent381gates/47oracles pass, but actual author/independent pixels found unrelated mobile HP crossed by decorative combat trails and anonymous token overlays in Timely/They Hate. Separate main-v5 fixes pending; first-pass failures retained and clean streak remains0. A18 author v4 combat clearance is retained, but completed Diversion SEN/printed-Overwhelm overlap requires scoped Card/styles correction. Source-v5 build passes; two actual crop probes clear, full targeted playback review ongoing. No new acceptance count.

A16 corrected full-v6 `e900f93b…` is frozen separately with630tests/buildPASS. Main author46 actual images and root targeted18 actual images clear generated identity and unrelated HP; independent corrected381gates/47oracles pass and remaining live/ending/raster review continues. A18 corrected root author72 actual images now clear SEN/printed-keyword stacking; native Jump free-copy ticket has12 actual inspected images and six passing lifecycle/geometry cases. Neither batch is independently accepted yet; total170 remains.

A19 root secondary implementation has begun against provisional isolated data, with explicit phase/round-end UI boundaries. Root probes found a genuine Sweep owner/controller destination mismatch in the staged factory; fix pending with author. The earlier generic-arrow test harness parsing failure and two fixture mistakes remain recorded separately from product findings. Requested GPT-6.1-sol/xhigh stays in use; clean streak0.


### A16 independent production acceptance — 180 total

A16 accepted10/10 plus Timely phase boundary at exact production source `e900f93b5ddfa59c46d74caf01e5410429ded0d1adaefa0aab4e0e0e8758eaf0`,69 served files. Independent381 gates/47 full source oracles,38 DOM/lifecycle runs,200 actually viewed artifacts/1109 hashed PNGs and both-size ordered/natural/early/separate ending review pass. Production630studio tests/build pass; all3 available recorded actions (Lightspeed,Timely,Fight) pass before/after/Replay/backseek and7missing remain explicit. `A16-gpt61/acceptance.json` and `BUILD-CLEAR180.json` grant180 accepted/2278remaining. Original first-pass source ceiling3/10, combined ceiling2/10 and all failures remain; clean0, GPT-6.1-sol/xhigh continues. [Review](card-animation-a16-review.md).

A17 full190 isolated candidate `d9edb825…` has686tests/buildPASS and author pixels in progress; Heartless briefly restores the old pose during return and Stay needs a held deck-count update, so it is not yet author clear. A19 root initial37 actual views found Sweep mobile shrinking-row arrival ambiguity; a one-file existing arena-reservation correction is built separately for targeted review. These are author drafts, not accepted identities.
