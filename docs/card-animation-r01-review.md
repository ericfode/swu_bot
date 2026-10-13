# R01 independent completed-board review — 2026-10-11

**Final verdict: 10/10 accepted after correction. First independent pass: 7/10 accepted.**

Reviewer: **GPT-6.1-sol / xhigh**, independent of the integrating author. This is regression and state-handoff acceptance for ten previously approved compositions, not a newly authored batch. It does not earn an effort reduction or increase the clean authoring streak.

The review applied `skills/swu-card-animation/SKILL.md` revision 1 and the card animation language. Engine source and installed card JSON were read only. Product source was not edited by the reviewer. Browser plugin was not available; the installed Playwright and Chromium were used under the frontend testing skill's fallback.

## Evidence and provenance

Frozen production URL: `http://127.0.0.1:5191/#/effects`, page title `SWU Holotable`. Desktop viewport **1440×1100**; mobile **390×844**; device scale 1. Meaningful page, correct selected title/caption/progress, no framework overlay, no console/page errors.

- First pass: `results/card-effects-review/R01-gpt61/manifest.json`, captured `2026-10-11T20:27:58.859Z`, fingerprint `fda324b1a3ff9e70b05a3a40bfa61f9047d9cea0975382c7178a9854a8e35d10`. All ten contact sheets were actually inspected at 18%, 46%, 72%, 90%, and 100%, along with all ten separate natural-completion images. All 50 held frames were stable; all ten natural DOM results matched the held final result.
- First mobile pass: `results/card-effects-review/R01-gpt61/mobile390/manifest.json`, captured `2026-10-11T20:28:39.546Z`, fingerprint `5039237822c07851027271285929c155a2077833832395053f4f81cdf0ba04b9`. Lightning, Superlaser, and Make an Opening contact sheets were actually inspected. The two first-pass manifest hash sets differ only in `showcase.ts`; preserve them as separate source snapshots. The production artifact remained frozen.
- Corrected desktop and mobile pass: `results/card-effects-review/R01-gpt61/corrected/manifest.json` and `corrected/mobile390/manifest.json`, captured `20:32:29.900Z` and `20:32:33.473Z`, both fingerprint **`14d30b084ef3fda67800072ac990884e39799f35221fc4ccf3d4e5aca9727e6e`**. Lightning, Barrage, and Make an Opening were recaptured at every held phase and natural completion. All six contact sheets and all six natural-completion images were actually inspected. No errors, unstable frames, or natural/held state differences.
- Additional corrected-build lifecycle evidence: `results/card-effects-review/R01-gpt61/lifecycle-review.json`, `lifecycle-natural/`, and `natural-timing/`. Every R01 card passed replay/reset, backward seek, repeat natural result, source disposal, resource/base checks, and reduced-motion natural completion. Interrupting Superlaser with Open Fire left the new six-unit Open Fire board intact after the old wipe would have completed. No stale exit ghost or callback overwrote the selected effect.
- Independent `npm --prefix studio test`: **53/53 pass**, zero skips/failures, saved at `results/card-effects-review/R01-gpt61/studio-tests.log`. The integrating author separately reported `npm run smoke` passing 134 root tests, 53 studio tests, analysis checks, and both viewer builds, plus kit build and recorded-replay checks. The reviewer did not rebuild the frozen production artifact.

The original capture fingerprint omitted the global stylesheet even though its clipping caused the failure. Its observed stylesheet SHA-256 was `2c362be5a5db7b86541ac5e7978b27117bbd66ce85d194e79ff0513f1711ca59`. The corrected fingerprint includes `styles.css` and `EffectsPage.tsx`; corrected stylesheet SHA-256 is `16ec63e06488f4b31cc94901a3a60cf8376f3a2b41964ec66a441afb9422b49e`. First-pass evidence was not overwritten.

## Source-checked rules and legal examples

Each identity was checked against `forceteki/test/json/Card/<slug>.json`, its implementation in `forceteki/server/game/cards/01_SOR/events/`, `abilities.ts`, `preview.ts`, `previewCosts.ts`, and `showcase.ts`. Canonical SOR prints and equivalent listed reprints agree with installed `setCodes`: Open Fire SOR_172/TWI_174, Vanquish SOR_078/TWI_077, Repair SOR_074/JTL_075. The remaining seven use their verified SOR print.

| Card | Complete clauses and restrictions checked | Deliberate example and persistent result |
| --- | --- | --- |
| Open Fire | Choose any unit; deal 4 damage. | Enemy Wampa 4 power / 5 maximum HP takes 4 and remains in ground with 1 HP. Damage is not removal. |
| Force Lightning | Chosen unit loses all abilities for the phase. Then, with a friendly Force unit, choose any available payment N, including 0; deal 2N to that same unit. | Friendly Luke, Jedi Knight is present with the Force trait. Pay 2 extra; Wampa has 4 damage, 1 HP, and a visible `Abilities off · phase` status. |
| Force Choke | Friendly Force unit discounts event by 1. Deal 5 to a non-Vehicle unit; that unit's controller draws 1. Damage/draw resolve simultaneously. | Luke satisfies the discount; Wampa is a Creature, not a Vehicle. Wampa is defeated to enemy discard. Enemy deck 29→28, hand 3→4; the new unknown card has the same stable instance ID on repeated playback. |
| Takedown | Defeat a unit with at most 5 remaining HP; no non-leader restriction. | Enemy Death Trooper has 3 HP; it leaves play for discard. Wampa and both space units remain. No fabricated damage number. |
| Vanquish | Defeat a non-leader unit. | Enemy Death Trooper is an ordinary unit and leaves play for discard. No fabricated damage number. |
| Superlaser Blast | Defeat all units on both sides in both arenas. Bases and undeployed leaders are not units. | All six ground/space units leave; friendly discard 4→8 includes the played event and three friendly units, enemy discard 0→3. Bases remain at 21/30 and 24/30. |
| Overwhelming Barrage | Give a friendly unit +2/+2 for the phase. Then that unit deals its resulting power divided among any number of other units, either controller; exclude source. | Friendly Marine 3/3 with 1 existing damage becomes 5/5, 4 HP remaining, with a visible `+2/+2 · phase` status and no Experience token. It assigns 5 to the distinct enemy Wampa, defeating it. This is damage, not an attack; Marine remains ready. |
| Bombing Run | Choose ground or space; deal 3 to every unit in that arena on both sides. | Ground chosen: all four ground units are hit; Marine, Defender, and Trooper are defeated, Wampa remains with 2 HP. Both space units and both bases are untouched. |
| Make an Opening | Give any chosen unit −2/−2 for the phase and heal 2 from your own base; simultaneous effects. Stat reduction is not damage. | Wampa becomes 2 power / 3 maximum HP with 0 damage and visible `−2/−2 · phase` status. Friendly base damage 9→7; displayed HP 21→23 out of unchanged maximum 30. |
| Repair | Heal 3 from any unit or base; no friendly-only restriction. | Heal existing 9 damage from the friendly base down to 6. Displayed HP 21→24 out of unchanged maximum 30. |

Fixture stats/traits were independently checked for Marine, Defender, Wampa, Death Trooper, Alliance X-Wing, TIE/ln Fighter, and Luke, Jedi Knight. Luke's undeployed leader does not satisfy a Force-unit condition. Friendly base Echo Base supplies Command; Luke's leader supplies Vigilance/Heroism. `Player.getPenaltyAspects` and `SimpleAdjustedCost` confirm multiset aspect matching and the two-resource penalty per missing symbol.

| Card | Printed cost | Missing aspects / discount | Total spent, including extra payment | Initial ready / total | Final ready / total |
| --- | ---: | --- | ---: | --- | --- |
| Open Fire | 3 | Aggression +2 | 5 | 5/7 | 0/7 |
| Force Lightning | 1 | Aggression +2, Villainy +2; extra payment 2 | 7 | 7/7 | 0/7 |
| Force Choke | 2 | Aggression +2, Villainy +2; Force discount −1 | 5 | 5/7 | 0/7 |
| Takedown | 4 | None | 4 | 5/7 | 1/7 |
| Vanquish | 5 | None | 5 | 5/7 | 0/7 |
| Superlaser Blast | 8 | Villainy +2 | 10 | 10/10 | 0/10 |
| Overwhelming Barrage | 5 | Villainy +2 | 7 | 7/7 | 0/7 |
| Bombing Run | 5 | Aggression +2 | 7 | 7/7 | 0/7 |
| Make an Opening | 3 | None | 3 | 5/7 | 2/7 |
| Repair | 1 | None | 1 | 5/7 | 4/7 |

Every event leaves the friendly hand exactly once and enters its discard. The opponent does not pay for playing the event. Alternate legal targets, arena choices, N=0, and damage divisions were checked in the rules vocabulary/source; this review visually accepts the one explicit staged example per identity, not footage of every possible choice or an engine-run match.

## Independent visual scores

Scores are readability / meaning / impact, each 0–5. Acceptance requires readability and meaning ≥4, impact ≥3, and no material contradiction or missing/clipped persistent result.

| Card | First pass score | First pass verdict | Final score | Final verdict / observed basis |
| --- | --- | --- | --- | --- |
| Open Fire | 4 / 5 / 4 | Pass | 4 / 5 / 4 | Pass: directed hit and −4 held label; surviving Wampa stays visibly at 1 HP. |
| Force Lightning | 3 / 3 / 4 | **Fail** | 4 / 5 / 4 | Pass after correction: suppression, extra payment, and 4 damage distinct; ordinary phase chip now remains visible. |
| Force Choke | 4 / 5 / 4 | Pass | 4 / 5 / 4 | Pass: lethal hit/removal plus deck→opponent-hand draw; discount and destination readable. |
| Takedown | 4 / 5 / 3 | Pass | 4 / 5 / 3 | Pass: focused targeting and defeat; ordinary target does not return. |
| Vanquish | 4 / 5 / 4 | Pass | 4 / 5 / 4 | Pass: bright slash, fracture, defeat, and correct persistent removal. |
| Superlaser Blast | 5 / 5 / 5 | Pass | 5 / 5 / 5 | Pass: six distinct removals across both arenas and sides, intact bases after the sweep. |
| Overwhelming Barrage | 3 / 3 / 4 | **Fail** | 4 / 5 / 4 | Pass after correction: source strengthens, target is hit, final source retains phase-labelled stats without invented attack/exhaustion. |
| Bombing Run | 5 / 5 / 4 | Pass | 5 / 5 / 4 | Pass: four ground hits include allies, three removals and one survivor; space remains clear. |
| Make an Opening | 3 / 3 / 4 | **Fail** | 4 / 5 / 4 | Pass after correction: stat shrink and healing remain distinct; phase duration and correct final stats survive. Mobile target outline has proper proportions. |
| Repair | 5 / 5 / 3 | Pass | 5 / 5 / 3 | Pass: concentrated mending grid, explicit +3 heal, and persistent 24/30 base HP. |

The three failures shared one cause: `.card-statuses` sat at `inset: -15px 0 auto` outside the card's clipping boundary. DOM equality falsely appeared healthy because the hidden text still existed. Moving the chips inside the card, allowing mobile wrapping, and keeping them above the stat row corrected the visible result without changing approved choreography. Mobile chips remain small but are readable, anchored to the correct card, and do not cover its power/HP.

Natural timing samples of the three repaired scenes progressed through anticipation, resolution, result, and completion without seeking. Observed completion was 2.729 s for Lightning, 3.008 s for Barrage, and 2.738 s for Make an Opening; intended durations are 2.7, 2.9, and 2.7 s. Browser observation adds polling/screenshot overhead. The held result remained long enough to read before the ordinary board took over.

## Observed skill refinements

1. Persistent-status review must inspect actual overlay-free pixels; DOM text/equality cannot detect overflow clipping. Include suppression and phase-duration chips in desktop/mobile completion review.
2. Fingerprints must include global layout/styles and the visible page entry point; a CSS-only failure/fix otherwise has no recorded source change.

These are measured corrections from this review. No speculative workflow requirement or reduction in review rigor is proposed. R01 is accepted for its ten staged examples; R02 and newly authored rounds need their own independent review.
