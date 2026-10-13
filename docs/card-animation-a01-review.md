# A01 independent animation review

Reviewer: `animation_a01_review`, **GPT-6.1-sol / xhigh**, 2026-10-11. This is a newly authored ten-card batch. It is the first measured authoring batch, and the twenty baseline regressions do not reduce its required effort.

**Final independent semantic/state/pixel review: 10/10 accepted after correction, including both separate regroup examples.** The first independent pixel pass was 6/10, with four failures; those results remain preserved below. This batch earns no clean-first-pass streak credit and no reduction from xhigh. Integration test/build completion is the root agent's separate gate.

## Evidence and rules boundary

Initial source fingerprint: `27de73f05ebbbb66eab44877b3b4d9ebdbe3450f10eae172dd12691f9b81a35a`. Both initial manifests have this fingerprint, including the board, card component, shared styles, EffectsPage, GameViewer and all effect modules. The production URL was `http://127.0.0.1:5191/#/effects`; the first A01 build was frozen throughout initial capture.

- Desktop: `results/card-effects-review/A01-gpt61/desktop/manifest.json`, 1440×1100, ten contact sheets, fifty held frames at 18/46/72/90/100%, and ten separate natural completed-board images.
- Mobile: `results/card-effects-review/A01-gpt61/mobile/manifest.json`, 390×844, nine contact sheets, forty-five held frames and nine natural images. All A01 cards except the single-target stationary Moment of Peace were included.
- Every one of the nineteen contact sheets and nineteen natural images was inspected. The completed boards were inspected as pixels, including phase, ownership and pending-regroup chips; DOM presence was not treated as proof of visibility.
- All nineteen held states were stable, every natural ending matched its held 100% state, and both manifests report no browser warnings/errors. Lifecycle and timed-playback evidence is recorded separately below.

Read-only source audit independently checked all ten installed JSON files and matching `01_SOR/events/*.ts` implementations. Identity, sole imported print alias, cost, repeated aspects, target scope, optional clauses and delayed timing agree with the specification. No engine/card-data edits were made by the reviewer. Snapshot-only replay inference deliberately leaves search/reveal/reorder, owner, delayed trigger and payment split unknown without receipts; a vanished Shield is not attributed to this event merely because it is absent afterward. Strike True's observed damage is retained without fabricating an attack or a damage-source identity.

## Preserved first-pass verdicts

Scores are readability / meaning / impact, on 0–5 scales. Acceptance requires at least 4 / 4 / 3 and no material semantic, state or clipping failure.

| Card | Scores | First pass | Pixel/state finding |
| --- | --- | --- | --- |
| Moment of Peace | 4 / 5 / 3 | Accept | One closed Shield shell, then one real Shield on the damaged Marine. Final 3 power / 2 remaining HP; damage is not healed. |
| Mission Briefing | 4 / 5 / 3 | Accept | Two moving backs originate at p2's deck and arrive at p2's hand. Final p2 hand 3, deck 27; p1 hand empty and resources 5/10. Small auxiliary zone lettering is compressed on mobile, but the selected-player count and route remain readable. |
| Keep Fighting | 4 / 5 / 3 | Accept | Full card rotation remains proportionate on mobile. Marine finishes upright, 3 power / 2 remaining HP, with no attack or damage change; resources 6/10. |
| Outmaneuver | 4 / 5 / 4 | Accept | Both ground regions are marked; three new rotations and Wampa's already-exhausted marker are distinguishable. All four ground units end exhausted; both space units remain ready. Resources 5/10. |
| Attack Pattern Delta | 4 / 5 / 4 | Accept | Three separate numbered recipients and descending +3/+3, +2/+2, +1/+1 bonuses are readable together. Final phase chips remain visibly within card bounds. Marine 6/5 remaining, Defender 6/5, X-Wing 3/4; no Experience or healing. |
| Power Failure | 3 / 3 / 3 | Fail | At 72/90%, three generic `DEFEATED` stamps cover Wampa's face, obscuring that only selected attachments were defeated. The completed board is correct: exhausted host 5 power / 5 remaining HP, Experience retained, Shield absent and two ordinary upgrades in p2 discard. |
| Change of Heart | 3 / 4 / 3 | Fail | The arriving Wampa overlaps Defender in the held animation, then jumps to its true third slot at completion. On mobile that true slot is the second row. Duplicate control/delay labels add congestion. Final exhausted Wampa correctly remains on p1, owner p2, with visible return-at-regroup status; resources 2/10. Initial build lacked the required separate regroup boundary example. |
| Sneak Attack | 3 / 4 / 3 | Fail | The arriving Wampa overlaps Defender, then jumps to the real final slot. Duplicate generic payment/cost badges cover Marine at 72/90%. Distinct event 4 and unit 6→3 beats are present early; final ready 4/5 Wampa and defeat-at-regroup chip are correct, resources 3/10. Initial build lacked the required separate regroup boundary example. |
| Recruit | 3 / 4 / 3 | Fail | Five backs and exactly one revealed Marine are correct, but a long generic search receipt becomes a vertical block across p1's base/deck and returning backs at 72/90%. Final Marine is in hand only, deck 26, discard only the event; resources 9/10. |
| Strike True | 4 / 5 / 3 | Accept | Stationary exhausted Marine is the visible power source; Wampa survives with 1 remaining HP. No lunge, readiness change or counterdamage occurs. Final source 3/2 remaining, target 4/1 remaining; resources 7/10. |

Failure evidence is in desktop/mobile contact sheets 26–29, especially the 72% and 90% frames. These are presentation failures; none of the ten primary immediate after snapshots is materially wrong.

## Lifecycle, timing and corrected review

Initial lifecycle pass is complete in `results/card-effects-review/A01-gpt61/lifecycle-review.json`: all ten passed explicit final-state assertions, backward seeking to the original before board, reset/repeated natural completion without cumulative changes, and overlay removal. Interrupting Change of Heart with Recruit did not allow an old completion callback to overwrite the selection. All ten also completed with the same correct immediate state at 390×844 under reduced motion. No browser warnings/errors occurred.

Natural pacing was inspected in forty actual-clock frame captures and ten ordered natural-timing contact sheets, rather than only paused/scrubbed frames. Recorded completion was 2,272 / 2,549 / 2,276 / 2,734 / 2,911 / 2,911 / 3,097 / 3,193 / 3,278 / 2,451 ms in review order, within 111 ms of authored durations. Anticipation, action and a held reading interval are present; the same four overlay failures persist under natural timing. This sampled timing review is not a frame-rate performance benchmark.

Initial playback script and timed frames are in `results/card-effects-review/A01-gpt61/lifecycle-review.mjs` and `natural-timing/`; image hashes, including natural-completion images, are in `image-hashes.json`. The loaded initial production assets were `index-B2RLHuav.js` and `index-BDeVt61W.css`. All correction captures use separate output paths and fingerprints, preserving this first pass.

### First correction pass, preserved

The first corrected build has served fingerprint `3f29d5708856c0ae3ade6bb7a8d4bedffe4fb6504e06d5c07a1e90bc18e3aa33`. Captures in `corrected/desktop`, `corrected/mobile`, `corrected/regroup-desktop` and `corrected/regroup-mobile` all report `sourceOrigin: served-build`, stable held frames, natural ending equal to held 100%, and no browser warnings/errors. All twelve contact sheets and twelve separate natural completed-board images were inspected.

Power Failure and Recruit now meet 4 / 5 / 3. Power Failure names the selected Academy Training, Entrenched and Shield before departure, distinguishes ordinary discard from token removal, and states that the 5/5-remaining host survives with Experience. Recruit has five backs, only the selected Marine face, the one-card hand destination and four random-bottom receipt without the former vertical generic block. The exact final arrival position now matches both control/play ghosts, including the wrapped mobile second row.

Change of Heart and Sneak Attack desktop meet 4 / 5 / 3, but their mobile immediate scenes remain 3 / 4 / 3: the delay label covers `OWNER P2` or `EVENT 4 · UNIT 3 PAID` at 72/90%. These held-reading receipts are required meaning, so their presence in the DOM does not close the defect. The author received `corrected/mobile/27-change-of-heart-contact.png` and `28-sneak-attack-contact.png` for another spacing correction.

The separate regroup desktop scenes meet 4 / 5 / 3. Heart returns the same exhausted, damaged Wampa to p2; Sneak defeats only the new p1 Wampa and increments p1 discard from one to two. Neither readies other units, draws, pays the event again or changes resources. Mobile natural endings are also correct and clear. The mobile regroup held contact sheets contain an incidental TIE hover preview over the lower board after the capture tool clicks and scrolls; those held frames require a clean recapture with the pointer parked away from cards. This is an evidence obstruction, not a manufactured animation verdict.

Source review checked the explicit later-stage resolver: it consumes only an existing pending regroup trigger, matches stable identity and incarnation, requires known ownership for return, preserves counters, distinguishes ordinary cards from tokens, removes the resolved obligation, and does not schedule a future timer or infer missing replay metadata. Final selectors/cancellation/reduced-motion QA and the last mobile receipt recapture remain pending.

### Final correction and acceptance

Final frozen served fingerprint: `56dafba4adea9b1163e0d86cdec49c358a4b18ac34f9b2f51e6ae0abd77dfa42`. `final-correction/desktop`, `final-correction/mobile` and `final-correction/regroup-mobile` contain Heart/Sneak's final primary and clean mobile boundary captures. All six contact sheets and all six separate natural completed-board images were inspected. Every manifest reports served-build attribution, stable held pixels, matching natural/held final states and no browser warnings/errors.

Clamping the complete three-row mobile receipt keeps `P1 CONTROLS`, `OWNER P2`, and `P2 AT REGROUP START` separate. Sneak's `PLAYED READY`, `EVENT 4 · UNIT 3 PAID`, and `DEFEAT AT REGROUP START` remain simultaneously readable. Neither receipt covers Marine or Defender. Their arrival ghosts retain the correct exhaustion and dimensions and land at the same wrapped slot as the real final card.

| Card | Final scores | Final verdict |
| --- | --- | --- |
| Moment of Peace | 4 / 5 / 3 | Accept |
| Mission Briefing | 4 / 5 / 3 | Accept |
| Keep Fighting | 4 / 5 / 3 | Accept |
| Outmaneuver | 4 / 5 / 4 | Accept |
| Attack Pattern Delta | 4 / 5 / 4 | Accept |
| Power Failure | 4 / 5 / 3 | Accept |
| Change of Heart | 4 / 5 / 3 | Accept, primary and regroup |
| Sneak Attack | 4 / 5 / 3 | Accept, primary and regroup |
| Recruit | 4 / 5 / 3 | Accept |
| Strike True | 4 / 5 / 3 | Accept |

The six first-pass accepts retain their inspected original pixel evidence; the four failures have replacement evidence. The final build's all-ten immediate states were independently rechecked, rather than assuming earlier accepted state assertions still hold after shared changes.

`final-validation/lifecycle-review.json` reports **pass** against the final served fingerprint, checked again at completion. It verifies all ten exact immediate final boards, backwards seeking to the original before board and overlay removal. Corrected four scenes pass repeated natural Replay without accumulating tokens, damage, cards or payments. Both boundary scenes preserve counters, resolve exactly one known obligation, restore the pending board on backwards seek, match natural completion to held 100%, retain the selected stage on Replay, and restore the primary event scene when selected. Switching from a running boundary to the primary scene or another card cancels the old callback. Fresh-load deep links select the correct regroup stage. All ten primary scenes and both boundaries pass mobile reduced-motion completion and reset.

The first deep-link harness attempt navigated only the hash of an already-mounted page and therefore retained its initialized selector state; it was corrected to reload the URL. Its log is preserved in `final-validation/qa-attempt-same-document.json`. The continuation carries the previously passed checks and the corrected fresh-load/dependent checks. This was a test setup error, not a product fix or a suppressed defect.

Twenty-four actual-clock frames and six final timing contact sheets were inspected for the corrected four primary scenes and two boundaries. The selected upgrades, search/reveal, movement, control direction and delayed obligation remain readable under running time. Final completion was 2,929 / 3,099 / 3,198 / 3,280 ms for Power/Heart/Sneak/Recruit and 3,100 / 3,193 ms for the Heart/Sneak boundaries, at most 129 ms beyond authored duration including harness overhead. No browser warnings/errors occurred. These measurements establish sequence and completion, not a frame-rate benchmark.

Final QA scripts are `final-validation.mjs`, `final-validation-continuation.mjs` and `final-timing-contacts.mjs`; final loaded assets were `index-Bt1RBCU-.js` and `index-DniNUhT-.css`. `review-image-hashes.json` hashes all 376 preserved PNG artifacts. No review product, engine or card-data edits, rebuilds or commits were made. No material A01 semantic, state, clipping or lifecycle issue remains. The root agent owns the current integration test/build gate.
