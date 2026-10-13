# A03: ten SOR event animations

Specification only, authored with GPT-6.1-sol at xhigh. These are the next ten pending imported identities; authored examples do not imply independent visual acceptance. Preserve the approved twenty signatures and the corrected A01/A02 movement and caption clearances. No engine edits, new games, or builds were used for this specification.

Rules sources: installed `forceteki/test/json/Card/<slug>.json`, corresponding classes under `forceteki/server/game/cards/01_SOR/events/`, their engine tests, and the current A01/A02 types, staged resolver, and signatures. Pinned engine: `2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`. Exact canonical IDs below are authoritative; verify the current imported inventory and served-build fingerprints when capturing.

## Identity and payment

All ten are non-unique events with exactly one imported print alias each. Register by canonical ID and exact print, never by a title fallback. The provided aspects in the common fixture are Command, Vigilance, Heroism; each missing aspect symbol adds 2. The event leaves hand and is paid once before its effect. All resources are ordinary staged resources; no discount is present.

| Slug | Exact name / canonical ID | Print / aliases | Printed cost; aspects | Common-fixture payment |
| --- | --- | --- | --- | --- |
| precision-fire | Precision Fire / 9210902604 | SOR168 only | 1; Aggression | 3 |
| smoke-and-cinders | Smoke and Cinders / 6702266551 | SOR174 only | 5; Aggression | 7 |
| forced-surrender | Forced Surrender / 5871074103 | SOR175 only | 6; Aggression | 8 |
| no-good-to-me-dead | No Good to Me Dead / 8800836530 | SOR186 only | 2; Cunning, Villainy | 6 |
| i-had-no-choice | I Had No Choice / 2715652707 | SOR187 only | 7; Cunning, Villainy | 11; use 12 ready resources |
| bamboozle | Bamboozle / 9644107128 | SOR199 only | 2; Cunning, Heroism | Normal 4; primary alternate discard pays 0 resources |
| disarm | Disarm / 2587711125 | SOR216 only | 1; Cunning | 3 |
| shoot-first | Shoot First / 8297630396 | SOR217 only | 1; Cunning | 3 |
| asteroid-sanctuary | Asteroid Sanctuary / 6901817734 | SOR218 only | 2; Cunning | 4 |
| dont-get-cocky | Don't Get Cocky / 2202839291 | SOR223 only | 4; Cunning | 6 |

Precision Fire has the printed keyword reminder Saboteur. Traits: Tactic (Precision Fire, Disarm); Disaster (Smoke and Cinders); Plan (Forced Surrender, No Good to Me Dead); Trick (I Had No Choice, Bamboozle, Shoot First, Asteroid Sanctuary); Gambit (Don't Get Cocky).

## Common complete before state

Use a fresh fixture per example. IDs below are instance IDs, distinct from canonical card identities. Every reference has explicit owner; every arena unit has `incarnation: '<id>:entry-1'`. No unexplained prior effect is needed except the explicit history in Forced Surrender and the declared legal attachment history in Bamboozle.

- Round 9, action phase, P1 initiative. P1: Echo Base SOR024 (30 HP, 9 damage), undeployed Luke Skywalker, Faithful Friend SOR005, 10/10 ready resources. P2: Capital City SOR020 (30 HP, 6 damage), undeployed Darth Vader SOR010, 7/10 resources. Bases/leaders: `a03:<seat>:base`, `a03:<seat>:leader`. I Had No Choice overrides P1 to 12/12.
- P1 hand initially contains only `a03:<slug>:event`, the exact event above. P2 hand contains `a03:p2:takedown-hand`, Takedown SOR077, cost 4. Discards initially empty. Per-card additions below replace this hand recipe where specified.
- P1 deck 27 and P2 deck 29, with complete `knownDeck` arrays. Actual top cards below use real names/prints. Uninspected slots have stable unknown references `a03:<seat>:deck:<index>` with `s: null`; these references establish position/count only, never an invented card face or rule.
- P1 ground: **M** `a03:p1:marine`, Battlefield Marine SOR095, 3/3, damage 1, ready, Rebel/Trooper, cost 2; **D** `a03:p1:defender`, Echo Base Defender SOR098, 4/3, damage 0, ready, Sentinel, Rebel/Trooper, cost 3. P1 space: **X** `a03:p1:xwing`, Alliance X-Wing SOR237, 2/3, damage 0, ready, cost 2.
- P2 ground: **T** `a03:p2:trooper`, Death Trooper SOR033, 3/3, damage 0, ready, cost 3; **W** `a03:p2:wampa`, Wampa SOR164, 4/5, damage 1, ready, cost 4. P2 space: **F** `a03:p2:tie`, TIE/ln Fighter SOR225, 2/1, damage 0, ready, cost 1. Prior entry abilities are already resolved. No upgrades/statuses unless specified.
- Supporting reprint identities: Alliance X-Wing also LAW253; Death Trooper also SHD030/SEC030; Wampa also LOF164. These aliases identify the same cards, not additional instances in the fixture. Other supporting faces use their stated SOR prints.

Unless stated otherwise, the after state preserves all unrelated cards, ownership, stats, damage, pose, deck order/count, and resources. Source event goes to P1 discard; P1 ready resources become 10 minus the table payment. Illegal attacks must never be used to make a scene more interesting.

## 1. Precision Fire — breach a shield under Sentinel cover

**Complete clauses.** Attack with a ready friendly unit if able. It gains Saboteur for that attack. If it is a Trooper, it also gains +2/+0 for that attack. Saboteur applies to any selected unit, not only Troopers. It permits ignoring enemy Sentinel when selecting a defender and defeats all Shield upgrades on the defending unit when the attack is declared; it does not ignore arena restrictions, grant Overwhelm, or change simultaneous combat into attacker-first combat. Blanking can prevent the keyword from functioning.

**Primary recipe.** M starts at damage 0. Replace T with P2 Echo Base Defender SOR098, `a03:p2:sentinel`, 4/3, damage 0, ready, Sentinel. Replace W with Crafty Smuggler SOR207, `a03:p2:smuggler`, 2/2, damage 0, ready, with its already-created Shield `a03:precision:shield`, token, owner P2, p/h contributions 0. M attacks the Smuggler despite the other Sentinel. Declare transient Saboteur and +2 attack power; defeat the Shield before combat; M deals 5 and the Smuggler deals 2 simultaneously. Smuggler moves to P2 discard, Shield ceases, M remains 3/3 at damage 2, exhausted. Sentinel and bases are unchanged. Pay 3. No attack-only bonus/status remains.

**Choreography.** A narrow breach line passes the Sentinel's outline, snaps the Shield ring off the measured defending card, then the ordinary paired combat flashes resolve. Hold the surviving Marine's 2 damage and the defender's actual discard destination. This is a shield breach, not Shoot First's immunity to a defeated defender.

**Acceptance.** Non-Trooper X gets Saboteur but no +2; same-arena and ready legality remain; every Shield is removed before damage; ordinary combat includes the 2 counterdamage; no permanent keyword/stat change or Sentinel defeat.

## 2. Smoke and Cinders — each player keeps their own two

**Complete clauses.** Each player discards all but 2 cards from their own hand, choosing their own discards. The played event is already out of P1 hand. Hands of 0, 1, or 2 discard nothing; this never draws up to 2. Separate chooser attribution is required.

**Primary recipe.** P1 before hand: event plus M-face SOR095 `a03:smoke:p1:keep:0`, Repair SOR074 `...:keep:1`, Open Fire SOR172 `...:discard:0`, Wampa SOR164 `...:discard:1`. P1 chooses Open Fire/Wampa to discard, leaving Marine/Repair. P2 before hand: common Takedown plus TIE/ln Fighter SOR225 `a03:smoke:p2:keep:1`, Resupply SOR126 `...:discard:0`, Recruit SOR123 `...:discard:1`. P2 chooses Resupply/Recruit to discard, leaving Takedown/TIE. Pay 7; P1 discard event plus 2, P2 discard 2; both hands exactly 2, all decks/arenas unchanged.

**Choreography.** Two independent hand fans tighten around two retained backs while each player's own selected cards peel into their measured discard pile. Label the chooser beside each fan; no common random-selection stamp. Unrevealed retained hands remain private in public presentation.

**Acceptance.** Count P1 hand after source departure; prevent discarding opponent-selected cards without explicit chooser evidence; keep 0/1/2-card hands unchanged; verify distinct ownership/counts and mobile arrival/caption clearance.

## 3. Forced Surrender — draw and a witnessed ultimatum

**Complete clauses.** Draw 2 cards. Each opponent whose base **you damaged this phase** discards 2 cards of their choice. Damage attribution is the acting player who dealt actual damage, not card ownership or existing base counters. Attack, ability, or Overwhelm damage may qualify. These instructions are simultaneous in the implementation; successful draws are not a prerequisite for the discard clause. Normal failed-draw rules remain applicable outside this full-deck example.

**Primary recipe.** P1 known top: Battlefield Marine SOR095 `a03:forced:draw:0`, Open Fire SOR172 `...:draw:1`. Explicit history: round 9/action, P1 X dealt 2 combat damage to P2 base earlier this phase, taking base damage 4→6; X is already exhausted before this event. P2 hand: Takedown plus TIE SOR225 `a03:forced:p2:discard:0`, Recruit SOR123 `...:discard:1`; P2 chooses TIE/Recruit. Pay 8, draw those actual 2 (deck 27→25, hand 0→2), P2 hand 3→1/discard 0→2. Both base counters remain unchanged during the event.

**Choreography.** A small “P1 damaged this base · this phase” witness marker anchors to the actual enemy base, then a balanced two-lane draw/own-choice discard. The old 2 damage is a prerequisite receipt, never a new projectile or repeated damage.

**Acceptance.** No same-phase positive P1 history means draw only, even if base damage is 6. Reject old-phase history and wrong acting player. Validate source IDs and actual draw cards; missing drawn cards must not erase an independently established discard obligation. The current primary adapter rejects decks shorter than two instead of fabricating failed-draw base damage; exercising that branch needs separate explicit damage receipts.

## 4. No Good to Me Dead — a round-long ready lock

**Complete clauses.** Exhaust any unit, friendly or enemy, in either arena, including a deployed leader. It cannot ready for the rest of this **round**, including the regroup ready step. An already-exhausted unit is a legal target. This is a readiness restriction, not suppression, a phase-only effect, or a delayed defeat/control trigger.

**Primary recipe.** Select ready W. Pay 6. W becomes exhausted and retains 4/5, damage 1, owner/controller P2. Its completed board shows “CANNOT READY · ROUND 9” tied to W's current incarnation. No damage, defeat, hand movement, or extra exhaustion of another unit.

**Choreography.** A restraint closes around the measured Wampa, turns it exhausted, and settles into a clear lock and round label. Hold that ordinary status after the overlay ends; a clock must not imply a countdown driven by animation time.

**Acceptance.** Staged readiness attempts during round 9, including regroup, remain blocked. In round 10 the restriction expires, but expiration itself does not perform a missing ready action. Leaving play clears the entry-bound effect; a later incarnation is not locked. Focused state assertions suffice; do not add automatic boundary UI scenes merely because a duration exists.

## 5. I Had No Choice — opponent splits hand and deck

**Complete clauses.** P1 chooses up to 2 distinct non-leader units from either side/arena. An opponent chooses 1 of those: return that unit to its owner's hand; put the other on the bottom of its owner's deck. With multiple opponents, the controlling player chooses which opponent makes that selection. Selecting 0 is allowed; selecting 1 leaves no second unit for the deck. Leaders are ineligible. Attached upgrades follow their own removal rules/owners; tokens cease. Neither unit movement is defeat, discard, or shuffle.

**Primary recipe.** P1 resources **12/12**; pay 11. P1 selects M and W. P2 chooses M for hand: M moves intact to P1 hand. W moves to P2 deck bottom after its existing 29 cards, deck 29→30. P1 ground retains D, P2 ground retains T; unit discards remain empty, P2 hand remains Takedown. Preserve stable moved card IDs; out-of-play refs omit arena damage/pose without calling that healing. P1 has 1 resource left.

**Choreography.** Two selected cards share a fork; an explicit P2 choice seal rests on M, then one path ends at the measured P1 hand slot and the other inserts beneath the P2 deck. Hold separate destination/owner labels, with no generic defeat stamps or hand waypoint on the deck route.

**Acceptance.** Opponent chooser survives into receipts; the two destinations use each unit's owner even under borrowed control. Exact deck order appends only W once; one chosen unit returns only to hand; non-leader filter, no duplicate selection, and sufficient 11-cost payment.

## 6. Bamboozle — discard payment, dismantle, retain host

**Complete clauses.** May discard **another Cunning card from own hand** instead of paying all play costs, including additional costs. This alternate cost is unavailable when playing with Smuggle. Otherwise pay normal costs. Exhaust any unit, including deployed leaders; return each upgrade on it to **that upgrade's owner's hand**. Ordinary upgrades return, tokens cease instead of entering a hand; an attached leader cannot become a hand card and follows its leader leave-play rule. The host remains unless a separately supported consequence, such as lethal HP after stat removal, removes it. Normal play triggers still occur under alternate payment.

**Primary recipe.** P1 hand event plus Disarm SOR216 `a03:bamboozle:payment`; explicitly choose alternate discard payment, paying **0 resources**. W starts ready, damage 1, with Academy Training SOR120 `a03:bamboozle:academy` owner P2, +2/+2; Entrenched SOR072 `...:entrenched` owner P1, +3/+3; Shield `...:shield` owner P2, 0/0; Experience `...:experience` owner P2, +1/+1. W therefore starts 10/11 and ends 4/5, damage 1, exhausted, no upgrades. Academy goes to P2 hand, Entrenched to P1 hand, both tokens cease. P1 discard contains Disarm payment and event, P1 resources remain 10. Mixed ownership is reachable after W was previously controlled by P1 for attaching Entrenched, then returned to P2; there is no live control effect now.

**Choreography.** Disarm first folds into the cost slot as a concrete alternate payment. Attachment cards detach one by one from W's measured upgrade row to their two owner's hands; token rings collapse locally. The exhausted surviving Wampa remains visible while its stats settle 10/11→4/5. Never stamp defeat over the host.

**Acceptance.** Normal route costs 4 here. Alternate source cannot pay for itself, another non-Cunning card is invalid, payment is discarded once, and no hidden resource charge occurs. Roll back explicit p/h exactly; owner destinations are independent of controller. Test host survival, token absence, and separate leader/lethal-stat boundaries without inventing unsupported receipts.

## 7. Disarm — power reduction with a zero floor

**Complete clauses.** Give an enemy unit −4/−0 for this phase, in either arena, including deployed leaders. Only power changes: no HP reduction, damage, exhaustion, suppression, or defeat. Effective power is floored at 0 by the engine.

**Primary recipe.** Pay 3, select W. It remains ready, 5 HP and damage 1, while effective power 4→0 and a visible phase −4/+0 status persists. Phase expiry removes the modifier and restores resting power 4; it does not change damage/readiness. Alternate F or the recorded 2-power Shuttle becomes **0**, never −2.

**Choreography.** A precise four-notch power gauge drains into a locked zero stop at the measured stat counter. The card remains upright and solid; leave a compact phase marker rather than blacking out its rules or HP.

**Acceptance.** Power floor, unchanged HP/damage/pose/ownership, persistent completed phase status, and restoration when the staged phase changes. Replay reports actual observed 2→0 even though printed modifier is −4.

## 8. Shoot First — an actual attacker-first combat

**Complete clauses.** Attack with a ready friendly unit if able; it gets +1/+0 for this attack and deals combat damage before the defending unit. A defender defeated by that first combat damage deals no counterdamage; a surviving defender does counter with its then-current power. Ordinary Sentinel, arena and attack restrictions still apply. Bases do not counterattack. The attack-only +1 expires.

**Primary recipe.** Pay 3. M at 3/3, damage 1, attacks enemy T at 3/3, damage 0. M deals 4 first, T moves to P2 discard before it could deal damage, and M retains damage **1**, exhausted, resting 3/3. Bases and all other units remain unchanged. Use a single attack ID linking attacker/defender, transient bonus, forward damage, and defeat.

**Choreography.** A quick aim/shot reaches T ahead of a briefly forming return-fire line; T's defeat interrupts that line, which never reaches M. Hold M's unchanged damage and T's real discard arrival. A surviving-defender variant must finish its return fire.

**Acceptance.** A killed defender cannot emit a fabricated counter receipt. Nonlethal or Shield-prevented damage permits actual counterdamage; updated defender power matters. Preserve ordinary simultaneous counterdamage in Precision Fire. No permanent +1 or universal immunity.

## 9. Asteroid Sanctuary — disable one, shield another

**Complete clauses.** Exhaust an enemy unit. Give a Shield token to a friendly unit with **printed cost 3 or less**. Separate clauses: the Shield is not conditioned on successfully exhausting an enemy. Either arena is legal, the two targets need not share an arena, and deployed leaders follow the printed-cost filter where applicable. Already-exhausted enemy targets do not prohibit the Shield clause.

**Primary recipe.** Pay 4. Select enemy ground T to exhaust and friendly space X, printed cost 2, to receive Shield `a03:asteroid:shield`, owner P1, token p/h 0/0. T becomes exhausted, X retains its ready pose, both retain original stats/damage, X has one new Shield. No attacks, healing, movement, or power increase.

**Choreography.** A crossing asteroid screen closes over T as it rotates exhausted; its sheltered wake becomes a Shield ring around X in the other arena. Distinct measured targets and held results keep this unlike Moment of Peace's single containment.

**Acceptance.** Cost filter uses printed cost, not actual paid cost; enemy-only exhaustion/friendly-only token. Test one valid half when the other has no valid target. No implicit arena sweep, stat inflation, or exhaustion of X.

## 10. Don't Get Cocky — public reveal, choose when to stop

**Complete clauses.** Choose any unit. Reveal deck top cards one at a time, choosing whether to continue, up to 7 cards or the deck end. With a nonempty deck, reveal the first card before choosing to stop. Sum actual revealed cards' **printed** costs. If sum is 7 or less, deal that much damage to the chosen unit; above 7 deals **no damage**, not 7. Then put all revealed cards on the deck bottom in random order. Continuing after the sum exceeds 7 is allowed until the limit. Empty deck gives no reveal/damage. No draws, hand arrivals, discards, or deck-count change.

**Primary recipe.** W starts damage 0. P1 top cards: Repair SOR074 cost 1 `a03:cocky:top:0`, Battlefield Marine SOR095 cost 2 `...:top:1`, Recruit SOR123 cost 1 `...:top:2`. Publicly reveal these in sequence, running totals 1→3→4, explicitly STOP after 3. Pay 6, deal 4 to W (4/5, damage 4, survives), preserve the untouched 24-card suffix and put revealed IDs on bottom in one possible random order `[2,1,0]`; P1 deck remains 27 and hand remains empty after event. The engine's repeat-prefix reveal prompt is not an extra reveal of new card instances.

**Choreography.** Three cards turn face up sequentially along a risk gauge marked 7; each printed cost adds to the running total. A visible STOP seals 4, sends exactly 4 to W, and gathers those same three cards beneath the measured deck. In a bust variant, the gauge breaks above 7 and emits no damage ray, but the bottom movement still happens.

**Acceptance.** Exact revealed prefix, public faces, per-card printed costs, stop/count bound, threshold, and full remaining permutation. Test sum 8→no damage, sum 7→7, zero-cost reveal, stop after 1, short/empty decks, continued reveal after bust, and no count/destination duplication.

## Narrow shared seams for authoring

Keep the staged resolver a consumer of verified declarations. It should not become a second engine or interpret these event titles. Recorded `transition.after` remains recording truth.

1. **Explicit event payment alternative.** Add staged cue payment metadata distinguishing normal resource payment from alternate own-hand discard. The alternate receipt names the actual payment card(s), the selected alternate route, and that all play costs are replaced. Resolve it before effect outcomes, exactly once; validate declared evidence and never disguise it as a negative discount. Current `cue.playCost: 0` is display metadata and does not override the resolver's metadata-derived charge.
2. **Round readiness restriction.** A small `restrict` outcome/status with `restriction: 'cannot-ready'`, `duration: 'round'`, round number, and subject incarnation communicates No Good to Me Dead. It is neither `suppress` nor delayed scheduling. Persist it on the completed board; only explicitly selected later staged state may expire it.
3. **Owner destination and attachment return.** Extend intact movement with an explicit hand/deck-bottom destination and origin. Append a unit to its owner's complete known deck once; do not route via a hand, defeat/discard pile, or search receipt. Returning upgrades looks up the actual attachment/host, rolls back explicit p/h, preserves the host, routes ordinary cards to each owner, and ceases tokens locally. Primary Bamboozle deliberately avoids attached leaders and lethal HP rollback; those require specific supported after-state evidence.
4. **Attack semantics.** Extend keyword data with attack-only Saboteur separately from persistent phase Raid. Add explicit `combatOrder: 'simultaneous' | 'attacker-first'` to attack evidence, reuse attack IDs/indexes and transient buff. Forward/counter receipts declare actual combat damage. First-strike counter validation must require a surviving defender; current A02 counter handling only checks its arena entry, not that it is still present. Simultaneous Precision Fire must retain both combat amounts.
5. **Base history prerequisite.** Optional staged `baseDamagedThisPhase` evidence records round/phase, acting player, actual target base ID, source ID and positive amount. Absence remains unknown, not fabricated from base counters. Match it only for explicitly declared Forced Surrender's condition.
6. **Reveal sequence and sum.** Reuse `DeckOperation` with top scope, public visibility, `top-search-bottom`, no selected IDs, and complete remaining permutation for Don't Get Cocky. Add optional ordered reveal/stop receipt metadata and a printed-cost-sum basis containing actual IDs, explicit costs, sum, and threshold 7. A search receipt only changes order; actual movement/count mutations still happen once in their separate receipts. This scene performs no draw/play/discard mutation.

Geometry: owner-hand and deck-bottom targets must be measured in the final layout. Upgrade departures originate at their attachment boxes, not their host's center. Account for hand wrapping and captions through the held arrival, not only the overlay-free board. The three measured A02 mobile obstructions (Search, Legion, Heroic) justify reusing the refined destination clearance; do not invent additional skill rules before review.

## Recorded evidence and independent acceptance

Only two A03 played-event actions were found in current recordings; source inspection is not fresh gameplay acceptance. `/private/tmp/swu-a03-recorded-actions.json` is a temporary discovery note, not a committed test prerequisite.

- Shoot First: `random-a-vs-random-b-1`, steps 285–287. P1 source event c26; chosen attacker Marchion Ro, Eye of the Nihil c15; chosen defender Cinta Kaz, The Struggle Comes First c66. Marchion exhausts, Cinta moves to discard, and attacker damage does not increase. Prompts and snapshots do not expose chronological combat amounts; render actual ending without manufacturing 4 damage, first-strike sequencing, or a counter receipt from this specification.
- Disarm: `random-c-vs-random-b-12`, steps 296–297. P1 source c36; chosen target Talzin's Shuttle, Mysterious Arrival c77. Observed power 2→0. Keep actual delta −2 distinct from the printed −4 modifier; no negative effective power.

The other eight have verified source rules and deliberate staged fixtures, without a newly exercised live rules path. Missing selection/payment/history/reveal-order/keyword evidence in a recording must remain unknown. A departed token or an absent counter receipt alone does not authorize attribution beyond what the recording establishes.

Acceptance: authoritative JSON identity/cost/aspect assertions; complete before/after state conservation, owner destinations, exact payments, modifier expiration, choice attribution, and deck permutations; negative evidence cases above; repeated playback/seek/natural completion without accumulation. Independent pixels: four held progress frames plus natural overlay-free completion, desktop and 390×844 for movement/compound scenes, reduced-motion completion where playback changes. Readability/meaning ≥4, impact ≥3, no contradiction/clipped primary receipt. Review timing live. Ten authored scenes are still ten pending reviews until those checks pass.
