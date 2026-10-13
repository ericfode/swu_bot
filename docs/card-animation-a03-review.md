# A03 independent review

Reviewer: `animation_a02_review`, **GPT-6.1-sol / xhigh**. **Accepted: 10/10 after correction; first independent pass: 9/10.** Precision Fire initially contradicted its Shield removal during combat; the corrected production captures and natural playback resolve it. Clean new-authoring streak remains **0**, so effort remains **xhigh**.

Initial production fingerprint: `71bfc5dc70fb90c37761a26db9f848ac6530afa4b27de45d49fea3ed9c1c2943`. Corrected production fingerprint: `f855f97f0e64795f61c36d19d94df3c1b8855c2bd1bd0f4329670a0eca328e15`. Both builds served exactly 50 scenes at `http://127.0.0.1:5191/#/effects` and stayed frozen through their respective browser jobs. Later unbuilt A04 source is not part of the initial capture claim. Author captures are not counted as independent acceptance.

## Verified source and staged state

Read-only rules sources: the ten installed JSON files under `forceteki/test/json/Card/`, matching SOR event classes, `docs/card-animation-a03-spec.md`, staged fixtures, payment resolver, outcome extractor, shared overlay geometry, and A03 signature gates. Engine revision: `2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`. No engine/source/build edits or new games were performed for this review.

The independent focused command `node --test studio/test/card-effects-a03.test.cjs studio/test/card-effect-evidence-gates.test.cjs` passed **19/19**. It verifies imported identity and print aliases, exact costs, supporting card facts, immutable state resolution, physical-card conservation, stable token identities, owners, and replay reset behavior. These are source/state assertions, not rendered acceptance.

| Card | Mandatory staged ending and distinctions checked |
| --- | --- |
| Precision Fire | Marine pays 3, bypasses Sentinel with actual Saboteur, removes all defending Shields, deals 5 while taking simultaneous 2 counterdamage. Smuggler reaches P2 discard; Marine ends exhausted, resting 3/3 with damage 2. Attack-only bonus/keyword expire. |
| Smoke and Cinders | Pay 7. Each player chooses their own remaining hand after the event departs; both keep two and discard two. P1 discard also contains the event. No draw/deck movement. |
| Forced Surrender | Pay 8. Actual current-phase P1 damage history qualifies P2's two discards; P1 draws two, deck 27→25. Old base damage and earlier exhaustion are preserved, never repeated. Missing/stale/wrong-player history grants draw only. |
| No Good to Me Dead | Pay 6. Wampa exhausts with unchanged stats/damage and a visible round-9 cannot-ready restriction bound to its incarnation. Explicit same-round ready attempts remain blocked; later rounds/new entries do not inherit the lock. |
| I Had No Choice | Pay 11 from 12. P2 chooses Marine to its actual owner's P1 hand; Wampa goes directly to its P2 deck bottom, deck 29→30. No defeat/discard/draw route. |
| Bamboozle | Discard the actual other Cunning card instead of all resource costs; resources remain 10. Exhausted host survives at 4/5, damage 1. Academy Training returns to P2 and Entrenched to P1; explicit Shield/Experience tokens cease locally. Normal resource payment remains 4. |
| Disarm | Pay 3. Wampa power 4→0; HP 5, damage 1, readiness and ownership unchanged. Phase modifier persists. Actual recorded 2→0 is distinguished from printed −4. |
| Shoot First | Pay 3. Marine deals 4 before defender damage, defeats Death Trooper and ends exhausted with its original damage 1 and resting power 3. Shield-prevented/nonlethal variants permit surviving defender counterdamage. |
| Asteroid Sanctuary | Pay 4. Enemy ground Trooper exhausts; friendly space X-Wing receives one stable Shield token with no stat/pose changes. Printed-cost≤3 filter and independent clauses are preserved. |
| Don't Get Cocky | Pay 6. Public top prefix reveals costs 1→3→4, explicitly stops after three, deals 4 to Wampa, and returns those same cards beneath the untouched suffix in one declared random order. No hand/discard/deck-count mutation; bust produces no damage. |

## Recorded evidence boundary

Current recordings contain only Shoot First (`random-a-vs-random-b-1`, steps 285–287) and Disarm (`random-c-vs-random-b-12`, steps 296–297). Actual before/after truth remains the recording's truth. Shoot First's snapshots support attacker exhaustion, defender defeat, and unchanged attacker damage, without exact combat amounts or chronological first-strike receipts. Disarm supports Talzin's Shuttle power 2→0, unchanged HP/damage/pose. Root ran the portable checker against both production builds: before/after handoff, Replay and backward seek passed for these two actual plays, with eight absent recordings reported separately. Receipts: `results/card-effects-state-check/a03-recorded.json` and `a03-corrected-recorded.json`, inspected by this reviewer. These checks do not expand recorded causal evidence.

Synthetic sparse Bamboozle receipts establish two ordinary upgrades reaching their actual owners, including when the host was already exhausted. They do not establish alternate payment, token cessation, complete attachment selection, or fresh exhaustion. A03's rich rendering and generic-receipt suppression use the same evidence predicate; the shared overlay preserves unsupported rich scenes as generic movement. This synthetic check does not claim an actual recorded Bamboozle game.

## Independent pixels and scores

Evidence root: `results/card-effects-review/A03-gpt61/`. **All 20 initial desktop/mobile contact sheets were actually inspected**, including 18/46/72/90/100%, plus every actual overlay-free natural ending. The desktop viewport was 1440×1100; mobile was 390×844. All 20 six-sample natural timing contact sheets were also inspected. Natural samples record actual progress and elapsed time, rather than synthetic SSR frames. Corrected Precision adds two five-frame contacts, two actual natural endings, and two nine-sample natural contacts.

Scores below are the conservative result across both sizes. Thresholds are readability/meaning≥4 and impact≥3; a material contradiction, clipped primary result, or state failure rejects the card regardless of other scores.

| Card | First readability / meaning / impact | First verdict | Final verdict and observed result |
| --- | --- | --- | --- |
| Precision Fire | 4 / 3 / 4 | **FAIL** | **PASS, 4 / 4.5 / 4** after measured Shield-chip removal; Sentinel bypass, simultaneous 5↔2 combat and exhausted survivor remain clear. |
| Smoke and Cinders | 4 / 4.5 / 3.5 | PASS | Each player's own choice, keep-two/discard-two groups and both destinations remain legible. |
| Forced Surrender | 4.5 / 4.5 / 3.5 | PASS | Prior-phase-history receipt, two P1 draws and two P2 choices are distinct; no repeated base damage. |
| No Good to Me Dead | 4.5 / 4.5 / 3.5 | PASS | Restraint and exhausted pose lead to a visible round-9 cannot-ready status after the overlay disappears. |
| I Had No Choice | 4 / 4.5 / 3.5 | PASS | Opponent's Marine choice returns to P1 owner hand; Wampa travels separately to P2 deck bottom. |
| Bamboozle | 4 / 4.5 / 4 | PASS | Actual alternate-payment card departs, mixed-owner upgrades reach separate hands, tokens cease, and surviving host stats change. Both hand arrivals clear the caption. |
| Disarm | 4.5 / 4.5 / 3 | PASS | Power drains 4→0 while HP, damage and ready pose stay unchanged; the phase label is visible in completed pixels. |
| Shoot First | 4 / 4.5 / 3.5 | PASS | Attacker's first damage defeats the defender, interrupts counterdamage, and ends its temporary bonus. |
| Asteroid Sanctuary | 4.5 / 4.5 / 3.5 | PASS | Separate enemy ground exhaustion and friendly space Shield grant, followed by a real persistent Shield token. |
| Don't Get Cocky | 4 / 4.5 / 4 | PASS | Sequential public reveals, printed sum 4, explicit stop, damage 4 and random-bottom route remain distinct. |

### Preserved first-pass failure and correction

Precision Fire's original symbolic Shield fracture ended by 39%, but the board's actual Shield chip was still intact at 46% and during actual natural playback at **2693 ms / 48.2%**, immediately before the simultaneous hit. Correct final snapshots did not erase that contradictory intermediate state. See both `initial-*/41-precision-fire-contact.png` and `lifecycle-*/precision-fire/natural-48.png`.

The correction masks only the measured defeated Shield chip, beginning at 25%. Independently inspected natural frames show the chip fading at 30% and fully removed at **39.2% / approximately 2193 ms**, ahead of 46% arrival and the 49% simultaneous combat beat. Defender art and counters remain visible, the other Sentinel is untouched, and the ending is unchanged. Corrected signature hash: `12188e2c1ccabd45c6373ac45d88176aa7760e4a3530c88fc51203c4b1f66cd4`. Evidence is preserved separately in `corrected-desktop/`, `corrected-mobile/`, and `corrected-lifecycle-*/`.

Residual polish: the narrow dark patch covering the removed chip is visible before defender departure. It does not obscure the defender's primary art/counters or suggest a remaining Shield. Don't Get Cocky's mobile reveal panel briefly covers the target during revelation, then clears before the held damage/result; target, amount, stop choice and destination are readable. Neither is a material acceptance failure.

## Lifecycle and persistent-state verification

The independent `scripts/ending-oracle.cjs` asserts explicit primary ending IDs, zones, power/remaining HP, exhaustion, status labels, upgrades, hand/deck/discard counts, resources and bases. It does not derive expected truth from the rendered manifest. **All ten endings passed on both viewports**, then corrected Precision passed again on both. Every natural completion had no overlay and restored ordinary board padding. Visible round/phase statuses were inspected in actual completed pixels.

Both `lifecycle-desktop/lifecycle.json` and `lifecycle-mobile/lifecycle.json` record all-ten natural completion, reset, repeated completion, backward seek, reseek before/after and reduced-motion results: **all pass, no browser errors, build frozen**. Natural endings match the separate held 100% board without cumulative damage/count/token changes. Observed natural durations were approximately **3.9–5.9 seconds**; the 12/30/48/65/80/94% samples preserve the action and held-result pacing. Reduced motion preserves deterministic completion and final truth.

Cancellation was tested from live Bamboozle to Smoke and Cinders frozen at 18%, held seven seconds past the old clock's completion. The selection, board and progress stayed unchanged. Corrected Precision repeats that cancellation, with actual `cancelled-selection.png` pixels inspected: no old Shield mask or stale completion leaks into Smoke. Corrected Precision's 12/25/30/39/46/49/65/80/94% natural samples, reset/seek/repeat/cancel and reduced-motion assertions all pass; natural completion was **5673 ms desktop / 5643 ms mobile**. Both corrected reports verify fingerprint `f855…`, empty inline padding and absent overlay after completion.

### Exact-hash discrepancies retained

The initial desktop held hashes all match. Initial mobile exact hashes fail for Smoke, Forced Surrender and I Had No Choice. The single four-frame lifecycle diagnostic additionally catches Bamboozle; all four keep exact `0.9000` progress and identical measured geometry. Preserved PNG comparisons show only **4–18 changed pixels**, maximum channel delta **8**, below 0.006% of a frame, at rounded borders and anti-alias edges. This supports raster variation, not moving scene objects. See `lifecycle-mobile/frozen-raster-differences.json` and the original held PNGs. The failures remain recorded; no recaptures were used to manufacture matching hashes. Corrected Precision's held hashes match at both sizes.

## Handoff

Source/rules assertions, all mandatory completed states, actual desktop/mobile pixels, natural pacing and lifecycle behavior support **10/10 final acceptance**. Root's matching-build recorded checker covers the two available plays only. Correction-build shared locator/captured-pocket additions do not activate new A04 scenes or change the staged A03 examples; the recorded checks passed again. First pass remains **9/10**, clean streak **0**, and requested GPT-6.1-sol / **xhigh** remains in force. Both initial and corrected browser jobs have exited; **BUILD-CLEAR** was sent for each frozen build. No implementation, build, engine or game edits were made by this reviewer.
