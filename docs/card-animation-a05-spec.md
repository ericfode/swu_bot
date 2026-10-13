# A05: ten SHD event specifications

Specification only, requested GPT-6.1-sol / `xhigh` workflow, 2026-10-11. These identities are future authoring input, not accepted scenes. Forty identities are accepted through A02; A03/A04 are separate work. The new-authoring clean streak remains zero.

Read-only rules: installed `forceteki/test/json/Card/<slug>.json`, `_setCodeMap.json`, each matching `forceteki/server/game/cards/02_SHD/events/<Class>.ts`, and `forceteki/test/server/cards/02_SHD/events/<Class>.spec.ts`. Engine HEAD is `2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`. Supporting systems are identified below. No engine edits, builds, fresh gameplay, paid providers or acceptance captures were run for this specification.

The exact ten occur together as generated batch `A003` in `results/card-animation-catalogue/imported-a02/batches.json`; the durable ledger names this future round A05. Inventory numbering is not acceptance numbering. JSON and engine clauses, rather than inventory descriptions, determine the rules here.

## Identity and payment contract

All ten are non-unique events. Each JSON `setCodes` and reverse `_setCodeMap` lookup has exactly one print below; there are no additional verified aliases. Register the numeric identity and exact print without title fallback. Print spelling in executable metadata uses underscores.

P1's undeployed Luke Skywalker, Faithful Friend SOR_005 supplies one Vigilance and one Heroism; Echo Base SOR_024 supplies one Command. A missing aspect occurrence adds 2, including a second Command. Event payment is made once, before its effect. Nested unit payments are separate; discounts include penalties before flooring at zero.

| Slug / exact title | Canonical identity | Print | Printed cost / aspects | P1 payment → ready/total |
| --- | --- | --- | --- | --- |
| evidence-of-the-crime / Evidence of the Crime | 6452159858 | SHD_077 | 3 / Vigilance | 3 → 7/10 |
| fell-the-dragon / Fell the Dragon | 3329959260 | SHD_078 | 4 / Vigilance | 4 → 6/10 |
| rivals-fall / Rival's Fall | 5303936245 | SHD_079 | 6 / Vigilance | 6 → 4/10 |
| remnant-reserves / Remnant Reserves | 1565760222 | SHD_093 | 4 / Command, Villainy | 6 → 4/10 |
| palpatines-return / Palpatine's Return | 4643489029 | SHD_094 | 6 / Command, Villainy | Event 8 + nested 2 → 0/10 |
| spark-of-hope / Spark of Hope | 9828896088 | SHD_105 | 2 / Command, Heroism | 2 → 8/11 after resourcing |
| rule-with-respect / Rule with Respect | 8080818347 | SHD_106 | 4 / Command, Heroism | 4 → 6/10 |
| enforced-loyalty / Enforced Loyalty | 5984647454 | SHD_108 | 2 / Command, Command | 4 → 6/10 |
| endless-legions / Endless Legions | 5576996578 | SHD_109 | 14 / Command, Command | Override 20 ready: 16 → 4/17 after three plays |
| commission / Commission | 1141018768 | SHD_127 | 1 / Command | Normal hand play 1 → 9/10 |

## Common deliberate before/after fixture

Fresh fixture per identity, round 9/action, P1 initiative. Prefix every instance with `a05:`. Arena entries have `incarnation: '<instance-id>:entry-1'`; that is separate from printed identity. Controller is the enclosing seat unless explicitly stated. All previous entry abilities are resolved and are not replayed by this event.

- P1 base `a05:p1:base`, Echo Base SOR_024, HP 30/damage 9; leader `a05:p1:leader`, Luke SOR_005, undeployed/ready. Resources 10/10 ready. P2 base `a05:p2:base`, Capital City SOR_020, HP 30/damage 6; leader `a05:p2:leader`, Darth Vader, Dark Lord of the Sith SOR_010, undeployed/exhausted. P2 resources 7/10. These objects are owned by their seat.
- P1 hand contains only `a05:<slug>:event`. P2 hand contains Takedown SOR_077, `a05:p2:hand:takedown`. Both discards start empty. P1/P2 decks have 27/29 cards and complete deliberate `knownDeck` manifests. Unknown slots use `a05:<seat>:deck:<index>`, unknown face/print; named cards below replace slots, never add to those totals.
- P1 ground **M** `a05:p1:marine`: Battlefield Marine SOR_095, cost 2, 3/3/damage 1, ready, Rebel/Trooper. **D** `a05:p1:defender`: Echo Base Defender SOR_098, cost 3, 4/3/damage 0, ready, Rebel/Trooper/Sentinel. P1 space **X** `a05:p1:xwing`: Alliance X-Wing SOR_237, cost 2, 2/3/damage 0, ready, Rebel/Vehicle/Fighter.
- P2 ground **T** `a05:p2:trooper`: Death Trooper SOR_033, cost 3, 3/3/damage 0, ready, Imperial/Trooper. **W** `a05:p2:wampa`: Wampa SOR_164, cost 4, 4/5/damage 1, ready, Creature/Overwhelm. P2 space **F** `a05:p2:tie`: TIE/ln Fighter SOR_225, cost 1, 2/1/damage 0, ready, Imperial/Vehicle/Fighter. No upgrades, captured cards or statuses unless specified.
- Every ordinary unit and hidden-zone card has an explicit owner. Verified support aliases: X also LAW_253; T also SHD_030/SEC_030; W also LOF_164; Repair SOR_074 also JTL_075; Open Fire SOR_172 also TWI_174. Academy Training SOR_120 costs 2/Command and gives +2/+2. Electrostaff SOR_071 costs 2/Vigilance, is Item/Weapon, +2/+2, and attaches only to non-Vehicles when later played.
- Give explicit resource cards stable `a05:p1:resource:<index>` IDs and exhausted flags for new resource movements. Ordinary primary payments exhaust indices `0..payment-1`; unused faces remain private/unknown. The aggregate and manifest must agree. P2's manifest has three exhausted and seven ready resources.
- After every primary the source event is in P1 discard exactly once and is absent from hand. The named overrides below describe all other changes. Bases, unrelated arenas/cards, damage, readiness, ownership, deck order and counts remain as staged. No elapsed animation time advances rules or resolves a later trigger.

## 1. Evidence of the Crime — transfer the attachment, keep both hosts

**Complete clauses.** P1 chooses an upgrade with printed cost ≤3, takes control of it, and attaches it to an eligible unit of P1's choice. The upgrade and new host may be on either side and in different arenas; a deployed leader may host it. Attachment restrictions still apply. Ownership is unchanged; the new controller is P1 even on an enemy host. Control is not limited to this phase or regroup. This is attachment transfer, not playing, defeating, recovering or returning the upgrade.

**Primary.** W has Academy Training SOR_120 `a05:evidence:academy`, owner/controller P2, ordinary upgrade, +2/+2; W starts effective 6/7/damage 1. Choose that upgrade and M. Pay 3. The identical upgrade moves W→M, owner P2/controller P1. W ends 4/5/damage 1, no attachments; M ends 5/5/damage 1 with exactly this upgrade. Both units remain ready and in their original arenas. P1 discard is the event only; P2 discard stays empty.

**Choreography · ~5.4s.** A printed-cost ≤3 evidence tag brackets the small attachment, a thin clamp releases it from W, and one intact upgrade follows a measured cross-seat route into M's attachment row. Old/new stat frames change by −2/−2 and +2/+2 while damage counters stay fixed. Hold “OWNER P2 · CONTROL P1” with both surviving hosts; no host defeat stamp or hand waypoint.

**Edges/tests.** Reject cost 4, an illegal host, absent/ambiguous attachment IDs, and a stolen upgrade being assigned P1 ownership. Same-host control change must not duplicate it or double its stats. A transfer that removes enough HP to defeat the old host needs that actual additional result. Unique-upgrade conflict, attachment abilities and Piloting/leader upgrades require supported consequences. The pinned class explicitly excludes base-attached sources (issue 2656); preserve this engine limitation instead of claiming complete base-source support. Verify owner destination on a later explicit leave-play state.

## 2. Fell the Dragon — cut on current power, not remaining HP

**Complete clauses.** Defeat a chosen non-leader unit with current effective power ≥5. Either controller and arena are legal. Current upgrades and temporary modifiers count; printed cost, printed power and remaining HP are not the filter. No damage is dealt and Shield does not convert this into damage prevention.

**Primary.** W receives Academy Training `a05:fell:academy`, owner/controller P2, +2/+2. Its current 6 power qualifies despite printed 4; effective HP 7/damage 1. Pay 4 and defeat W directly. W and Academy enter P2 discard as two distinct cards; W does not remain on board. M/D/X/T/F retain their original states. P1 discard is only the event; resources 6/10.

**Choreography · ~4.4s.** A five-notch power gauge qualifies W's actual 6 counter; a high, clean diagonal cut breaks its silhouette and routes the unit and small attachment separately to P2 discard. Hold “POWER 6 ≥ 5 · NON-LEADER” and an empty former slot. Avoid a six-damage number or animation implying the attachment alone was removed.

**Edges/tests.** Current power exactly 5 passes and 4 fails, including a printed-5 unit debuffed to 4. Deployed leaders are excluded even at 5+, friendly/space non-leaders qualify. Tokens cease rather than entering discard; captured cards are rescued by normal leave-play cleanup. Preserve damage without inventing a lethal damage receipt.

## 3. Rival's Fall — defeat a deployed leader to its leader area

**Complete clauses.** Defeat any chosen unit, friendly or enemy, in either arena, with no power/HP/cost restriction. Deployed leaders are units; undeployed leaders and bases are not. A non-leader goes to its owner's discard, a token ceases, and a deployed leader undeploys to its owner's leader/base area exhausted. Normal attachment/captive cleanup applies.

**Primary.** P2 Vader SOR_010 `a05:p2:leader` is instead deployed in ground: 5/8/damage 2, ready, owner/controller P2, incarnation `a05:p2:leader:entry-1`; the leader summary is `dep:1,x:0,epic:1` (deployment already spent). P2 has 10 resources, enough for his earlier deployment threshold 7. Pay 6 and defeat Vader. Remove his arena entry; the same leader summary becomes `dep:0,x:1,epic:1`, with no arena damage/statuses. P2 discard stays empty; P1 discard only event, resources 4/10.

**Choreography · ~4.8s.** A rivalry bracket singles out the deployed card; its unit face folds away and the intact front leader face retreats into the measured leader slot, ending exhausted. Hold “LEADER DEFEATED · UNDEPLOYED” beside the ordinary leader card. This destination must read differently from Fell's discard cut.

**Edges/tests.** Assert no duplicate leader object, no discard entry, no ready pose, no restored deployment availability and no retained unit damage. Generic non-leader defeat remains a discard route. Leader return requires a new narrow destination/result seam: current `CardEffectOutcome.zone` has no leader destination and the preview's generic defeat would misroute this primary. `LeaderUnitCard.initializeForCurrentZone` and `DefeatCardSystem` are the authority, not an inferred base heal.

## 4. Remnant Reserves — select three, reveal those three

**Complete clauses.** Privately search the top five of own deck for up to three units, reveal selected cards to the opponent and draw them. Zero/fewer selections are legal, with no combined-cost cap. All other searched cards go to random deck bottom; untouched remainder stays ordered. Short decks search fewer. This is draw to hand, not free play.

**Primary.** P1 top five IDs `a05:remnant:top:0..4` are Wampa SOR_164, Repair SOR_074, Defender SOR_098, X-Wing SOR_237, Open Fire SOR_172. Select indices 0,2,3 (printed costs 4+3+2=9, legally above U-Wing's separate cap). Pay 6; reveal/draw these three to P1 hand. Deck 27→24; after order is original suffix 5..26 followed by top:4 then top:1, one explicitly staged random permutation. No units enter an arena; source alone enters discard.

**Choreography · ~5.6s.** Five private backs form a compact reserve shelf; three chosen gates expose only the selected faces, then three distinct cards travel into measured final hand slots. Two unchosen backs roll under a BOTTOM 2 tab. Hold three arrivals and counts “DRAW 3 · DECK 24,” with no arena flash or printed-cost budget.

**Edges/tests.** Conserve every instance exactly once and validate selections are actual top-prefix units, maximum three, with duplicate prints distinguished by IDs. Select none puts all searched cards at bottom without draw/fatigue; empty deck does nothing. Reuse `DeckOperation.top-search-bottom`; do not make all five public, shuffle the entire deck, invent ordering from a recording, or misread three arrivals as one overlapping ghost.

## 5. Palpatine's Return — play directly from discard with the Force reduction

**Complete clauses.** Play a unit from own discard for six resources less, or eight less if that selected unit has Force. The conditional trait belongs to the selected unit, not a different controlled Force unit. Aspect penalties still enter the adjusted resource price before the reduction floors at zero. Other additional costs/restrictions and normal When Played/entry abilities apply; this is play, not return to hand or rescue. Unit mode excludes playing a Pilot as an upgrade.

**Primary.** P1 discard contains Kylo Ren, Killing the Past SHD_141 `a05:return:kylo`, owner P1; printed cost 6, Aggression/Villainy, Force/First Order, 6/7 ground unit. No Rey is controlled, so his conditional Villainy waiver is inactive. Pay event 6+2 missing Villainy=8, then nested `max(0,6+2 Aggression+2 Villainy−8)=2`. Kylo leaves discard directly for P1 ground after D, exhausted, damage 0, no upgrades/statuses, new `a05:return:kylo:entry-2`. P1 discard ends event only; hand/decks/bases unchanged, resources 0/10.

**Choreography · ~5.8s.** A discard aperture extracts the actual Kylo face; a Force-marked eight-step price ruler moves 10→2, separate from the event's PAID 8 receipt. He travels directly to the measured final ground slot and settles exhausted. Hold “FROM DISCARD · FORCE −8 · PAID 2,” never a hand fan, ready entry or free badge.

**Edges/tests.** Non-Force uses −6; a different Force unit does not grant −8. Zero-floor, nested affordability, missing repeated symbols and additional costs need assertions. Ignore earlier damage/attachments on re-entry; preserve ID and create fresh arena incarnation. Kylo has no When Played trigger and no Rey in this fixture, so no entry resolution is omitted. Other selected units' entry/static effects cannot be silently skipped. No discard unit or a blocked play produces no invented arrival.

## 6. Spark of Hope — resource a defeated unit, not this event

**Complete clauses.** Choose a unit currently in own discard that was defeated as a unit this phase, as its most recent arena incarnation, and resource that card exhausted under P1. Former controller does not need to be P1. Older-phase defeat, ordinary discard, resource defeat and a prior defeated incarnation followed by replay/return/discard do not qualify. The source event itself goes to discard; no unit play or When Played ability occurs.

**Primary.** Remove M from P1 ground and put its same card ID in P1 discard. Explicit current round-9/action defeat evidence records `a05:p1:marine:entry-1`, last-known type unit, owner P1/controller P2, with that incarnation also recorded as the card's most recent entry. No later replay occurred. Add decoys `a05:spark:old` X-Wing (defeated round 8) and `a05:spark:discarded` Wampa (discarded from hand this phase). Pay 2, choose M alone. M moves discard→P1 resources exhausted, no arena entry/stats; totals 10→11, ready 10→8. P1 discard ends the two decoys plus source; P1 hand empty, D/X remain in play.

**Choreography · ~4.8s.** A modest current-phase defeat witness tick authorizes M; a small spark carries the intact discard card into a measured resource slot, rotates it exhausted and increments total 10→11 without increasing ready 8. The source stays visibly in discard. Hold “MARINE RESOURCED · EXHAUSTED · 8/11.” No arena rebirth or resourced-event signature.

**Edges/tests.** Strengthen existing `defeatedThisPhase` with explicit most-recent incarnation/type; ID+phase alone accepts the engine's tested replay/Waylay/discard counterexample incorrectly. Membership is own discard, independent of controller at defeat. Test three decoys, duplicate defeat history for one card, resource-origin defeat and wrong current phase. Preserve unknown history in recorded replays; resource increase alone cannot prove this card or its prerequisite.

## 7. Rule with Respect — capture witnessed base attackers across arenas

**Complete clauses.** Choose a friendly in-play unit; it captures every currently enemy non-leader unit that attacked P1's base this phase and remains in play as the same incarnation. Attacking/defending seats and actual base target are recorded facts, not damage-counter/exhaustion guesses. Damage need not have been positive. Captor may be in another arena and need not be ready. Enemy leaders, attacks against a unit, new incarnations, and attackers now friendly are excluded; capture restrictions still apply.

**Primary.** Remove D from this fixture entirely, so no ground Sentinel invalidates the prior base attacks. W and F are exhausted after explicit earlier legal attacks on `a05:p1:base` for 4 and 2; base damage was 3 before those attacks and is common 9 now. History has distinct attack IDs `a05:respect:attack:w/f`, round 9/action, their entry-1 incarnations, attacker/controller P2, defending player P1, actual P1 base target. T never attacked. Pay 4, choose ready M. W and F leave their arenas and become exactly two open captive references in M's `cap[]`, owner P2, stable IDs; M remains 3/3/damage 1/ready. P2 T remains; no discard/draw/base-damage changes beyond source disposal, resources 6/10.

**Choreography · ~6.0s.** Two quiet past-attack witness stamps originate at W/F without replaying old hits. A ground-and-space capture net draws each intact card into M's measured captive pocket; the visible pocket settles at CAPTURED 2 with both identities inspectable. Hold surviving M and emptied enemy slots. No defeat fracture, stolen-unit arena arrival or ordinary upgrade attachment sign.

**Edges/tests.** Preserve ownership and strip departing unit damage/upgrades/statuses; normal leave-play cleanup discards ordinary upgrades to owners, ceases tokens and rescues that unit's own captives if any. Capture does not transfer these cards as controllable arena units. Repeated attacks by the same incarnation produce one captive; zero eligible attackers produces none. Test leader, non-base attack, wrong phase, returned/replayed incarnation and changed-controller exclusions. Later rescue needs an explicit supplied boundary/state, never a timed escape.

## 8. Enforced Loyalty — the draw depends on the actual defeat

**Complete clauses.** Defeat a chosen friendly unit, including a deployed leader and either arena. If that defeat successfully occurs, P1 draws two cards. A hostile-owned friendly unit leaves to its owner's appropriate destination, while the event controller draws. Prevented/no defeat grants no draw. Short-deck failed draws follow actual engine results (3 own-base damage per missing draw); do not invent unavailable cards.

**Primary.** P1 top two are Repair SOR_074 `a05:loyalty:draw:0` and Open Fire SOR_172 `a05:loyalty:draw:1`. Pay 4 (second Command missing), choose M and defeat it directly to P1 discard. Only after supported successful defeat, draw those two into P1 hand; deck 27→25. Final P1 discard is event+M, ground D only, X unchanged, resources 6/10; bases retain 9/6 damage. No extra damage/exhaustion or prior M damage applied to another unit.

**Choreography · ~5.2s.** A narrow loyalty seal cuts the chosen friendly M into its owner discard; its confirmed-departure latch then opens two distinct deck→hand routes. Hold “FRIENDLY UNIT DEFEATED · P1 DRAWS 2” and the real new hand. The two arrivals must clear the caption and be visibly contingent, unlike Remnant's search gates.

**Edges/tests.** Distinguish successful defeat from attempted defeat/disappearance, especially an indestructible target. No friendly target or prevented defeat preserves deck/hand. Verify two Command occurrences, leader destination, changed owner and draw recipient. Empty/one-card decks need actual fatigue receipts and ending, not two ghost cards; pinned card tests explicitly cover 6/3 base damage respectively.

## 9. Endless Legions — reveal resources, then play units one at a time

**Complete clauses.** P1 may publicly reveal any number of own resource cards, including none or non-units. Play each legally playable revealed unit for free, one at a time in chosen order, fully resolving its play/trigger consequences before the next. Resource/aspect costs are ignored, additional costs and restrictions are not. Revealed non-units and units no longer legal/available remain unplayed. This does not draw, turn events/upgrades into units, resource the source, or replace played resources from deck.

**Primary.** Override P1 resources to 20/20 with complete IDs `a05:p1:resource:0..19`. Faces 0 Marine SOR_095, 1 Wampa SOR_164, 2 X-Wing SOR_237, 3 Repair SOR_074; all owned P1, remaining faces private/unknown. Pay 16 by exhausting 0..15. Reveal exactly 0..3; choose play order 0→2→1. Each selected unit leaves its exhausted resource slot for its normal arena exhausted/damage 0 with new `<id>:entry-1`: Marine 3/3, X-Wing 2/3, Wampa 4/5. Existing units stay. Repair remains exhausted resource; resource total 20→17, ready 4. Deck/hand unchanged except event disposal; discard source only, no deck replacement.

**Choreography · ~7.0s.** Four named resource shutters open publicly; three numbered departure gates admit the actual cards to measured final ground/space slots one at a time. Each completed landing lowers TOTAL 20→19→18→17; READY stays 4. Repair's gate is visibly non-unit and closes in place. Hold all three exhausted arrivals, three freed resource slots and “FREE UNIT PLAYS · 4/17.”

**Edges/tests.** Identity/readiness conservation is mandatory, including a ready source: a friendly departing resource swaps to exhausted when an exhausted replacement is available (`CardTargetSystem.leavesResourceZoneEventHandler`), preserving ready count; use the supplied actual resulting flags. Validate reveal membership, chosen sequence, single consumption and no skip of a still-legal revealed unit. Zero/all-non-unit reveal plays nothing. Blocked/defeated resource during an earlier entry trigger must not play later; unsupported triggers must remain unavailable, not be scheduled by animation time. Current `res` aggregates and generic play receipts cannot prove these identities/order; do not infer them from a final board.

## 10. Commission — one trait-qualified card, not necessarily a unit

**Complete clauses.** Privately search own top ten for at most one card with Bounty Hunter, Item or Transport; reveal it to opponent and draw it. Any card type bearing a matching trait is legal. May take nothing; unselected searched cards go to random bottom, untouched remainder stays ordered. Short/empty decks search fewer/no cards without failed-draw fatigue. Smuggle is a separate resource-source play for 3 plus one Command, with actual top-deck replacement as an exhausted resource if available; it does not add the printed hand cost.

**Primary.** Normal hand play. Top ten `a05:commission:top:0..9` are Marine SOR_095, Repair SOR_074, Open Fire SOR_172, Defender SOR_098, Wampa SOR_164, X-Wing SOR_237, TIE SOR_225, Enforced Loyalty SHD_108, Electrostaff SOR_071, Resupply SOR_126. Choose index 8 because Item, although it is an upgrade. Pay 1; reveal/draw only Electrostaff into P1 hand. Deck 27→26: unchanged suffix 10..26, then unchosen indices `[9,7,6,5,4,3,2,1,0]`, one explicit random permutation. No attachment/stats/arena change; source-only discard, resources 9/10.

**Choreography · ~5.6s.** Ten private backs form a compact manifest; Bounty Hunter/Item/Transport headers light only the selected Item gate. Electrostaff reveals, travels intact into its measured hand slot, and holds as a hand card while nine backs settle under BOTTOM 9. Do not attach it to M, show ten public faces, or imply ten draws.

**Edges/tests.** Match actual traits, not title/art, unit type or one preferred trait. Reject a selected eleventh card and two selections; select none moves the searched group to bottom without draw. A separately authored Smuggle scene must identify the actual resource source, pay 3 once, remove that source exhausted, consume actual original deck top into exhausted resources, then search the new top ten. Nonempty replacement preserves resource total; empty deck leaves one fewer resource. This normal-hand primary does not establish Smuggle visual acceptance.

## Narrow implementation seams and honest evidence boundary

Reuse the nineteen original primitives plus existing A01/A02/A03 `play`, `search`, explicit deck permutations, payment and incarnation machinery. Preserve accepted timing signatures and A02's measured footer/hand clearance. Do not add a card-rules evaluator to the viewer.

Supporting authority: `forceteki/server/game/gameSystems/AttachUpgradeSystem.ts`, `CaptureSystem.ts`, `ResourceCardSystem.ts`, `SearchDeckSystem.ts`, `PlayCardSystem.ts`, `DefeatCardSystem.ts`; `forceteki/server/game/stateWatchers/CardsDefeatedThisPhaseWatcher.ts` and `AttacksThisPhaseWatcher.ts`; `forceteki/server/game/core/card/LeaderUnitCard.ts`; `forceteki/server/game/core/ability/PlayCardAction.ts`; and `forceteki/server/game/actions/PlayUnitAction.ts` / `PlayEventAction.ts`. These source inspections establish this specification's mechanics, not fresh execution of its fixtures.

1. Add an attachment-transfer receipt with exact upgrade ID/print/owner/controller, old/new host IDs and explicit before/after stat contributions. One transfer updates attachment membership and control; ordinary leave-play consequences are separately supplied. Extend `UpgradeRef` with optional controller rather than assuming its enclosing host controller.
2. Add a leader-defeat destination with explicit completed LeaderRef (`dep:0,x:1`, deployment spent). Preserve bot/view.js's existing optional `epic` summary rather than deriving it from ready/deployed state. Measure the leader slot; generic discard removal is insufficient.
3. Add optional stable resource-card references/readiness, compatible with bot/view.js's optional `resources`, and measured visible source/landing slots. Reuse `resource` for discard→resource and `play` for resource→arena, with explicit source and nested price/order. Aggregate-only recordings render their actual after board while leaving identities/payment/reveal order unknown.
4. Strengthen staged defeat evidence with last-known unit type and most-recent incarnation; add explicit same-phase attack records with attacker incarnation, attacking/defending seats and targets. A04 proposed attack history and captured pockets; inspect their eventual implementation before reusing them. Its private peek, rescue and last-known-upgrade contracts are not assumed present here.
5. Add `capture` with exact captor/captive IDs, owner and measured pocket/count; current studio UnitRef/lookup/Board omit `cap[]` although recorder/viewer have it. A capture receipt must remove an arena incarnation once and preserve the captive reference. Later `rescue` remains a separate operation; no timer executes game rules.

For each primary, assert exact canonical prints/aspects, event and nested costs, sufficient starting resources, one source disposal, instance conservation, intended destinations/owners, deck permutations/counts and final readiness/stats. Meaningful negative tests are the filter/history/identity/prevention counterexamples above, interrupted completion/reset/backward seek, and untouched-zone preservation—not tests that merely restate metadata.

Implementation acceptance still requires studio tests/build, independently inspected desktop and 390×844 images at 18/46/72/90/100%, natural overlay-free completion, and live timing/replay/reduced-motion checks. Prioritize moving attachments/leader/resource cards, three hand arrivals, two captive origins and dense multi-entry layout. Verify exact title/caption/progress before each frame; inspect actual persistent owner/control/captive/payment pixels for clipping. Scores must reach readability/meaning ≥4 and impact ≥3 with no material state contradiction. Keep first-pass failures and frozen-build fingerprints.

This spec supplies deliberate legal examples, not fresh engine execution. At initial specification, no A05 recording inventory had been checked; the later read-only inventory below supplies one available case. Before/after snapshots alone do not establish selection, hidden reveal/search faces, chronology, nested prices or resource identity. Current primitives do not support all new primaries yet, base-upgrade transfer remains a pinned-engine limitation, and Commission's alternate Smuggle scene remains unauthored. Report these gaps until implemented and reviewed; none of these ten may be counted accepted from this document.

### Existing recording available for later handoff verification

Read-only inventory of the current `replays/demo/games/*.jsonl` found one of these ten: Commission in `random-a-vs-random-c-7.jsonl`, classified action indices 17–19 (before state 16). P1 plays `c9` SHD_127 for 1 resource (ready 2→1); P1 selects `c25`, Naboo Royal Starship SEC_099, in the recorded trait-qualified selection prompt, and P2 acknowledges the reveal. The exact card enters P1's hand, deck 44→43, hand 4→4 after event disposal and draw; arenas and bases stay unchanged. The snapshot omits the other searched cards and final deck permutation, so the animation must not invent their identities or order. This inventory is source evidence only; run the persistent replay checker against the matching A05 production build before claiming UI acceptance. No recordings were found for the other nine, and no games were generated.
