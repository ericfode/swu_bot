# R02 independent completed-board review — 2026-10-11

**Final verdict: 10/10 accepted after correction. First independent pass: 9/10 accepted.**

Reviewer: **GPT-6.1-sol / xhigh**, independent of the integrating author. These ten scenes are the second regression batch of previously approved compositions. They do not count toward the newly authored clean streak or justify lowering review effort. Product source and the engine were not edited by the reviewer.

The review applied the repository's `skills/swu-card-animation/SKILL.md`, the card animation language, and the frontend testing skill's installed-Playwright fallback. The Browser plugin was unavailable. Rules were checked against installed card JSON and the matching pinned engine source, read only.

## Evidence and provenance

Frozen production URL: `http://127.0.0.1:5191/#/effects`; page title `SWU Holotable`. Desktop **1440×1100**, mobile **390×844**, device scale 1. The page contained the intended theatre and no framework error overlay. Captures asserted selected identity, caption, and progress. No console/page errors were recorded.

- Desktop manifest: `results/card-effects-review/R02-gpt61/manifest.json`, captured **2026-10-11T20:35:34.657Z**. All ten contact sheets were actually inspected at 18%, 46%, 72%, 90%, and 100%. All ten separate natural-completion images were actually inspected. All 50 held frames were stable; every natural completed DOM matched its held final state, including instance IDs and exhaustion.
- Mobile manifest: `results/card-effects-review/R02-gpt61/mobile390/manifest.json`, captured **2026-10-11T20:35:36.965Z**. Restock, Cunning, The Force Is With Me, and Spark of Rebellion were captured at all five phases plus natural completion. All four contact sheets and all four natural-completion images were actually inspected. All 20 held frames were stable, and all four natural results matched held completion.
- Both manifests share fingerprint **`14d30b084ef3fda67800072ac990884e39799f35221fc4ccf3d4e5aca9727e6e`**, including shared styles and the showcase page. Provenance was acquired before shared A01 integration resumed. The production artifact stayed frozen; changes to the shared checkout after this acquisition are not retroactively represented by these captures.
- This build includes the corrected Restock discard fixture, Rebel Pathfinder **SOR_239**, verified against its JSON's SOR_239/SEC_250 print identities. The prior SOR_084 identity was not used for this pass.
- Independent studio tests already passed **53/53** against this same baseline build during R01; receipt: `results/card-effects-review/R01-gpt61/studio-tests.log`. The integrating author separately reported the full smoke checks passing 134 root tests, 53 studio tests, analysis checks, and both viewer builds. The reviewer did not rebuild production or treat those tests as visual acceptance.
- Independent first-build lifecycle evidence: `results/card-effects-review/R02-gpt61/lifecycle-review.json`, completed **20:43:42.624Z–20:44:55.186Z**, pass=true and no console errors. All ten passed final-state expectations, backward seek/reset, repeated natural playback without cumulative counters/tokens, stable moved-card identity, overlay removal, and reduced-motion natural completion. Cancelling Command by selecting Restock retained Restock's six-unit board and correct counters; no stale strike or Experience appeared.
- Corrected Power-only desktop/mobile manifests: `results/card-effects-review/R02-gpt61/corrected/manifest.json` and `corrected/mobile390/manifest.json`, captured **20:46:29.927Z / 20:46:31.025Z**. Both fingerprint **`27de73f05ebbbb66eab44877b3b4d9ebdbe3450f10eae172dd12691f9b81a35a`**. This production build also contains A01 integration; **only Power of the Dark Side is newly visually reviewed here**, and this report does not accept A01. Both corrected contact sheets and both natural completed-board images were actually inspected. All ten held frames were stable, natural state matched held completion, and no errors were recorded. The nine already accepted scenes retain their original capture provenance.
- Corrected live evidence: `corrected/live-review.json` and `corrected/natural-timing/`, completed **20:47:52.071Z–20:48:03.750Z**, pass=true and no console errors. Power passed natural desktop/mobile handoff, backward seek/reset and repeat state equality, and mobile reduced-motion completion. The unseeked 72%/90% desktop/mobile result pixels were actually inspected.

## Source-checked rules and deliberate examples

All ten identities were checked against `forceteki/test/json/Card/<slug>.json`, `forceteki/server/game/cards/01_SOR/events/<Card>.ts`, the complete clauses in `abilities.ts`, and staged receipts/state in `showcase.ts`, `preview.ts`, `previewState.ts`, and `previewCosts.ts`. Resupply SOR_126/TWI_127 and Waylay SOR_222/TWI_226 have verified equivalent registered prints; remaining scenes use their canonical SOR print.

| Card | Complete clauses/restrictions checked | Staged example and persistent result |
| --- | --- | --- |
| Restock | Choose zero through four cards from **one** discard pile, either player; place them on the **bottom of their owner's deck in random order**. Cannot mix owners/piles. | Four existing friendly discard cards travel intact to friendly deck bottom. Deck 27→31. The played Restock is a distinct fifth instance and remains alone in discard: 4→1. No card is returned to hand. The example explicitly names random order; the completed board records deck count, not visible deck ordering. |
| Resupply | Put **this event** into play as one resource. The resource enters exhausted. | Source event leaves hand and becomes resource. Total 7→8; paying 3 reduces ready 5→2, and the newly added resource does not increase ready. Discard remains 4. |
| Command | Choose **two different modes, in either order**: grant 2 Experience to any unit; a friendly unit deals its current power as damage to a non-unique enemy unit; put this event into play as a resource; return a unit from your own discard to your hand. Engine recovery requires a BasicUnit, not a leader. | Experience then strike. Marine receives two permanent Experience tokens, 3/3→5/5, retaining its 1 damage and thus 4 remaining HP. It deals 5 to non-unique enemy Wampa, defeating it. Marine remains ready because this is damage, not an attack. Resource/recovery modes are not claimed. |
| Vigilance | Choose **two different modes, in either order**: discard 6 from opponent's deck top; heal 5 from any base; defeat any unit with at most 3 remaining HP; give any unit one Shield. | Heal friendly base 21→26 out of unchanged maximum 30, then Shield Marine. Marine retains 3 power and 2 remaining HP. No mill/defeat is shown. |
| Aggression | Choose **two different modes, in either order**: draw 1; defeat up to 2 upgrades, not their hosts; ready a unit with current power at most 3; deal 4 to any unit. | Exhausted 3-power Marine readies; Wampa takes 4 and remains with 1 HP. Marine gains no stats, no draw occurs, and no upgrade/host is removed. |
| Cunning | Choose **two different modes, in either order**: return a non-leader unit with current power at most 4 to its owner's hand; give any unit +4/+0 for the phase; exhaust up to 2 units; opponent discards 1 **random** hand card. | Return non-leader 4-power Wampa to its owner, enemy hand 3→4, then exhaust distinct remaining Death Trooper and TIE/ln Fighter. No random discard or phase buff is shown. Wampa's stable instance ID survives the move. |
| Power of the Dark Side | **The opponent**, not the event's controller, chooses a unit they control; defeat it. Any unit type, including a deployed leader, is legal. | Opponent-controlled Death Trooper is defeated to its owner's discard, 0→1; Wampa remains intact. State is correct, but the first-pass animation does **not** visibly attribute the choice to the opponent. |
| The Force Is With Me | Choose a friendly unit; give it 2 Experience. If you control a Force **unit**, also give that unit a Shield. Optionally attack with that same unit; it must be ready and have a legal attack. | Friendly Luke, Jedi Knight supplies the Force prerequisite. Ready Marine receives two Experience and Shield, becomes 5/5 with its existing 1 damage, then attacks enemy base for 5 and exhausts. Enemy base 24→19; base does not counterattack, so Marine stays at 4 HP with Shield retained. |
| Waylay | Return any non-leader unit to **its owner's** hand; no power limit or friendly-only restriction. | Wampa travels intact from enemy ground to enemy hand, 3→4. No fracture, damage, defeat, or discard increase. Its original instance ID persists. |
| Spark of Rebellion | Look at an opponent's hand, then choose exactly one card from it and discard it. Choice is not random. | Opponent hand is inspected, Takedown is marked as the chosen card and travels to opponent discard; hand 3→2 and discard 0→1. Deck remains 29. The overlay uses backs rather than inventing otherwise unknown faces. |

Base/leader aspects were independently checked during R01: friendly Echo Base supplies one Command; undeployed Luke leader supplies Vigilance/Heroism. Luke, Jedi Knight's verified Force trait meets the conditional scene; the leader's name alone does not. Wampa is non-unique and has 4 power / 5 maximum HP; Marine is 3/3 with 1 damage; Trooper and TIE are separate ready enemy units. Missing aspect symbols are counted as a multiset, including duplicate Command/Vigilance/Aggression/Cunning icons, at two resources per missing symbol.

| Card | Printed cost / required aspects | Missing aspect penalty | Total spent | Initial ready / total | Final ready / total |
| --- | --- | ---: | ---: | --- | --- |
| Restock | 1 / none | 0 | 1 | 5/7 | 4/7 |
| Resupply | 3 / Command | 0 | 3 | 5/7 | 2/8 |
| Command | 4 / Command ×2 | 2 | 6 | 6/7 | 0/7 |
| Vigilance | 4 / Vigilance ×2 | 2 | 6 | 6/7 | 0/7 |
| Aggression | 4 / Aggression ×2 | 4 | 8 | 8/8 | 0/8 |
| Cunning | 4 / Cunning ×2 | 4 | 8 | 8/8 | 0/8 |
| Power of the Dark Side | 3 / Vigilance, Villainy | 2 | 5 | 5/7 | 0/7 |
| The Force Is With Me | 4 / Vigilance, Heroism | 0 | 4 | 5/7 | 1/7 |
| Waylay | 3 / Cunning | 2 | 5 | 5/7 | 0/7 |
| Spark of Rebellion | 2 / Cunning, Heroism | 2 | 4 | 5/7 | 1/7 |

Every event leaves friendly hand once. All enter friendly discard once except Resupply, which becomes the exhausted resource. Opponent resources remain 3/7. These are deliberate one-choice examples, not engine-run matches or a claim that every legal modal/target combination was played. Complete clauses were source-checked separately from footage acceptance.

## Independent first-pass visual scores

Scores are readability / meaning / impact, each 0–5. Pass requires readability and meaning ≥4, impact ≥3, and no material contradiction, missing outcome, clipped primary information, or failed state assertion.

| Card | First-pass score | Verdict and observed basis |
| --- | --- | --- |
| Restock | 4 / 5 / 4 | Pass: four distinct discard cards and a deck-bottom insertion; correct persistent counts. Mobile route remains identifiable. |
| Resupply | 5 / 5 / 3 | Pass: event routes into resource row and rotates; final extra resource is exhausted, with correct remaining ready count. |
| Command | 4 / 5 / 4 | Pass: two Experience are separate from temporary buffs, strengthened source hits for 5, and permanent tokens/stat gain persist without exhausting it. |
| Vigilance | 4 / 5 / 3 | Pass: two chosen modes remain separate, +5 healing and Shield read clearly; maximum base HP is unchanged. |
| Aggression | 4 / 5 / 4 | Pass: readying and 4-damage hit target different units; the ordinary Marine stays ready and Wampa survives. |
| Cunning | 4 / 5 / 4 | Pass: intact return and two distinct exhaustions; ordinary exhausted cards remain dimmed and tilted. Mobile cards preserve proportions. |
| Power of the Dark Side | 4 / 3 / 4 | **Fail:** focused dark implosion and defeat/removal are clear, but no opponent-selection mark or specific example caption establishes who chooses. |
| The Force Is With Me | 4 / 5 / 4 | Pass: Experience, conditional Shield, chosen attack, base damage, and exhaustion are distinct; all three token chips and correct stats persist. Mobile has small/truncated Experience text but two separate chips and Shield remain identifiable. |
| Waylay | 5 / 5 / 4 | Pass: intact retraction to owner's hand, no death cue; correct ending hand count and empty target slot. |
| Spark of Rebellion | 4 / 5 / 4 | Pass: hand inspection precedes a marked chosen card moving to discard. No fabricated face reveal, random-selection mark, or deck route. |

The first-pass Power failure was semantic, not a broken callback. `PowerOfTheDarkSide.ts` sets `choosingPlayer: RelativePlayer.Opponent`, and the language's staged example says to mark opponent selection. The first build's `preview.ts` dropped that distinction and `outcomeLabel` turned defeat into `DEFEATED`; the actual 72% and 90% pixels showed no chooser attribution, while the caption remained generic. Its correct after-state could not establish who made the choice.

Unseeked natural timing was sampled at anticipation, resolution, result, and settle for Restock, Command, Cunning, The Force Is With Me, and Spark. Their resolution and held-result images were actually inspected. Observed completion was 2.640, 2.923, 2.922, 3.096, and 2.730 s respectively, against intended durations 2.6, 2.9, 2.9, 3.0, and 2.7 s. Browser polling/screenshots add observation overhead. The result labels remain readable before ordinary board handoff; timings preserve the approved signatures.

## Correction and final acceptance

The integrating author carried `selection: 'opponent'` into the explicit staged defeat receipt, added the target badge **`OPPONENT CHOICE · DEFEATED`**, and replaced the generic example caption with **`Opponent chooses their Death Trooper; defeat that chosen unit`**. The implosion, fracture, departure, timing signature, and completed-board outcome were preserved. The author reported 65 studio tests, typecheck and build passing after A01 integration and this correction; those are author-reported validation, separately from the reviewer's focused browser evidence.

The badge wraps within the original target footprint on desktop and mobile, is readable in actual pixels, and does not cover another unit's stats. The caption states the chooser during anticipation/resolution; the target badge reiterates it during the held result. Natural completion still removes only Trooper, keeps Wampa intact, retains both bases, places the played source and defeated unit into their respective discards, and pays exactly five ready resources. Observed desktop/mobile completion was **3.013 / 2.976 s** against the unchanged intended 2.9 s; browser observation overhead accounts for the excess. Backward seek restores Trooper and resources; repeated natural completion does not duplicate removal or source disposal.

| Card | First-pass score / verdict | Final score / verdict |
| --- | --- | --- |
| Power of the Dark Side | 4 / 3 / 4 — Fail | **4 / 5 / 4 — Pass after correction** |
| Remaining nine R02 cards | As individually recorded above — Pass | Same scores — Pass |

**R02 is accepted for all ten explicit staged examples.** Its first-pass 9/10 result remains part of the record. The corrected Power pass does not overwrite the first-build captures or imply that all ten were recaptured on the later thirty-scene build.

## Measured skill refinement

Preserve and display **chooser provenance** when it changes the card's action. An opponent-choice defeat can have exactly the same target and final state as controller-choice removal; state equality alone cannot distinguish them. Carry the verified/staged chooser into a readable selection marker or specific example label. In recorded playback, do not infer chooser facts without supported evidence.

First-pass evidence is preserved. No reduction in review rigor or authoring effort is earned by this regression batch.
