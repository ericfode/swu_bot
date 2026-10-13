# A06: ten SHD event specifications

Specification only, **GPT-6.1-sol / xhigh**, 2026-10-11. Scope remains all 2,458 imported identities; 50 are accepted through A03. A03's first independent pass was 9/10, so the clean authored streak is zero and no effort reduction is earned. A04/A05 implementation and acceptance are separate work; these ten are future authoring input.

Read-only authority: installed `forceteki/test/json/Card/<slug>.json`, `_setCodeMap.json`, the ten matching `forceteki/server/game/cards/02_SHD/events/<Class>.ts` and their card tests. Engine HEAD: `2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`. Current skill, visual language, ledger, A03 review, A04/A05 specs and current presentation contracts were inspected. No implementation, engine edits, builds, new games, paid analysis or acceptance captures were performed.

The exact ten are `batches[7]`, generated `A004`, in `results/card-animation-catalogue/imported-a02/batches.json`; durable workflow numbering calls this round A06. Inventory numbering does not imply acceptance.

## Identities and exact primary payments

All ten are non-unique events. Each installed `setCodes` and reverse `_setCodeMap` lookup has exactly the one print below; no extra alias was found. Register numeric identity and exact underscore print, never a title fallback. P1 Luke Skywalker, Faithful Friend SOR_005 provides Vigilance/Heroism; Echo Base SOR_024 provides Command. Each missing aspect occurrence costs 2, including both missing Aggression symbols on Chaos. Normal source-event payment occurs once before resolution; nested play is separate.

| Slug / exact title | Canonical ID | Print | Printed cost / aspects | Primary payment → P1 ready/total |
| --- | --- | --- | --- | --- |
| timely-intervention / Timely Intervention | 6847268098 | SHD_129 | 1 / Command | Event 1 + unit 2 → 7/10 |
| moment-of-glory / Moment of Glory | 1701265931 | SHD_130 | 3 / Command | 3 → 7/10 |
| choose-sides / Choose Sides | 2346145249 | SHD_132 | 7 / Command | 7 → 3/10 |
| give-in-to-your-anger / Give In to Your Anger | 3012322434 | SHD_144 | 1 / Villainy, Aggression | 5 → 5/10 |
| headhunting / Headhunting | 5896817672 | SHD_145 | 2 / Villainy, Aggression | 6 → 4/10 |
| cripple-authority / Cripple Authority | 3228620062 | SHD_156 | 2 / Heroism, Aggression | Override 8 ready: 4 → 4/8 |
| the-chaos-of-war / The Chaos of War | 8090818642 | SHD_159 | 3 / Aggression, Aggression | 7 → 3/10 |
| desperate-attack / Desperate Attack | 6962053552 | SHD_179 | 1 / Aggression | 3 → 7/10 |
| detention-block-rescue / Detention Block Rescue | 8576088385 | SHD_180 | 3 / Aggression | 5 → 5/10 |
| pillage / Pillage | 4772866341 | SHD_181 | 4 / Aggression | 6 → 4/10 |

## Common explicit before/after fixture

Fresh fixture for each event, round 9/action, P1 initiative. Prefix every card with `a06:`; ordinary owners are explicit and arena controller is the enclosing seat. Arena incarnation is `<instance-id>:entry-1`, separate from card identity. Previous entries/abilities are already resolved and are not replayed by this event.

- P1 base `a06:p1:base`, Echo Base SOR_024, HP 30/damage 9; undeployed/ready Luke SOR_005 `a06:p1:leader`; resources 10/10 ready. P2 base `a06:p2:base`, Capital City SOR_020, HP 30/damage 6; undeployed/exhausted Vader SOR_010 `a06:p2:leader`; resources 7/10. Owners are their seats.
- P1 hand contains only `a06:<slug>:event`, with exact title/print from the table. P2 hand contains Takedown SOR_077 `a06:p2:hand:takedown`. Both discards are empty. P1/P2 decks contain 27/29 stable entries, complete deliberate `knownDeck` arrays; unknown face/print slots are `a06:<seat>:deck:<index>`. Named tops replace these slots, never increase totals.
- P1 ground **M** `a06:p1:marine`: Battlefield Marine SOR_095, cost 2, 3/3/damage 1, ready, Rebel/Trooper; **D** `a06:p1:defender`: Echo Base Defender SOR_098, cost 3, 4/3/damage 0, ready, Rebel/Trooper/Sentinel. P1 space **X** `a06:p1:xwing`: Alliance X-Wing SOR_237, cost 2, 2/3/damage 0, ready, Rebel/Vehicle/Fighter.
- P2 ground **T** `a06:p2:trooper`: Death Trooper SOR_033, cost 3, 3/3/damage 0, ready, Imperial/Trooper; **W** `a06:p2:wampa`: Wampa SOR_164, cost 4, 4/5/damage 1, ready, Creature/Overwhelm. P2 space **F** `a06:p2:tie`: TIE/ln Fighter SOR_225, cost 1, 2/1/damage 0, ready, Imperial/Vehicle/Fighter. No upgrades, captives, prior-phase witnesses or statuses unless explicitly overridden.
- Verified supporting faces: Reputable Hunter SHD_117 (`6905327595`), cost 3/Command, 3/4, Bounty Hunter, no attack trigger; Discerning Veteran SHD_120 (`9765804063`), cost 5/Command, 3/4, Bounty Hunter, When Played captures one enemy non-leader ground unit. Supporting equivalent aliases: X also LAW_253; T also SHD_030/SEC_030; W also LOF_164; Repair SOR_074 also JTL_075; Open Fire SOR_172 also TWI_174; Resupply SOR_126 also TWI_127.
- After every normal-hand primary the source event is absent from hand and in P1 discard exactly once. Named overrides below are all other changes: preserve unrelated cards, owners, poses, damage, deck order/counts and bases. Never make a scene clock advance phase or consume an opponent's next action. Phase buffs survive animation completion, attack bonuses do not.

## 1. Timely Intervention — paid entry, chosen Ambush

**Complete clauses.** Play a unit from own hand, paying its normal nested resource/aspect and other costs; grant it Ambush for this phase in the play window. Unit mode excludes playing a Pilot as an upgrade. Normal entry and When Played abilities apply. Ambush is optional: it can ready and attack a legal enemy unit; without a legal target it does not ready. Ordinary arena/Sentinel restrictions apply; a separately supported ability can permit base attacks during Ambush. Choosing nothing/no affordable unit gives no invented play or keyword.

**Primary.** Add a second non-unique X-Wing `a06:timely:new-xwing`, owner P1, to hand. Pay event 1, nested X-Wing 2 (Heroism supplied), total 3. Play it exhausted into P1 space beside X with new entry-1; grant phase Ambush and explicitly trigger it against F. It readies for Ambush, exhausts to attack, deals simultaneous 2 while taking 2. F goes to P2 discard; new X-Wing survives 2/3/damage 2/exhausted with visible AMBUSH · THIS PHASE, existing X unchanged. Hand empty, decks/bases unchanged, P1 discard source only, P2 discard F only, resources 7/10.

**Choreography · ~6.0s.** Actual hand card passes a PAID 2 gate into its measured final space slot; an Ambush latch briefly readies it, then the same identity attacks F. Two opposed counted packets resolve together, F departs and survivor holds damage 2/exhaustion. Separate the source PAID 1 receipt from nested payment; do not show free play or unconditionally ready entry.

**Other route/edges.** Smuggle pays **2 + one Command** from an actual resource source instead of hand cost 1, replacing that source with actual deck top exhausted when available; nested unit price still applies. Empty deck supplies no replacement. Declined Ambush leaves default exhausted entry; no enemy space unit means no X-Wing readying. Test affordability after paying the event, actual unit mode, duplicate X identities, keyword expiry at an explicit phase boundary and normal entry-trigger evidence. Smuggle requires its own explicit fixture/identity/replacement receipts; this hand primary does not accept that route.

## 2. Moment of Glory — phase capacity, unchanged damage

**Complete clauses.** Give any unit +4/+4 for this phase, including enemy, either arena and deployed leaders. It is neither healing nor Experience; no friendly-only or readiness restriction.

**Primary.** Pay 3 and choose M. Power 3→7, maximum HP 3→7, damage stays 1, remaining HP 2→6, still ready. Persist +4/+4 · THIS PHASE on the ordinary unit after overlay removal. All zones/decks/bases otherwise unchanged; discard source only, resources 7/10. A supplied phase-end after snapshot restores 3/3/damage 1, not a timed second effect.

**Choreography · ~4.4s.** Four paired power/capacity rails extend from M's measured counters and hold beside one phase ribbon. Preserve its existing scar, with no heal particles or new attachment medal. Let the large counter change carry the impact.

**Edges/tests.** Enemy/deployed/space units qualify; an undeployed leader or base does not. Verify +4 power/+4 maximum HP independently from unchanged damage and pose. At phase end, capacity loss can defeat an actually over-damaged survivor; never resurrect a prior defeat or convert the four capacity points into healed damage.

## 3. Choose Sides — permanent, simultaneous control exchange

**Complete clauses.** Choose one friendly and one enemy non-leader unit, then exchange control simultaneously. Arenas need not match; each stays its own arena type. There is no regroup/phase expiry. Unit ownership, damage, ready/exhausted pose, incarnation and attachments/captives persist; control-dependent effects and uniqueness consequences need actual supported results. Ordinary upgrade ownership/control does not automatically follow the host; token upgrades follow new unit control and the pinned engine also updates their token owner.

**Primary.** Override F exhausted. Pay 7; select friendly M and enemy F. M goes intact to P2 ground, still owner P1/3/3/damage 1/ready/same entry-1. F goes intact to P1 space beside X, still owner P2/2/1/damage 0/exhausted/same entry-1. P1 ground D only; P2 ground T/W/M, space empty. Hold explicit owner labels without a delayed-return status. Both discard/deck/base counts are unchanged except source disposal; resources 3/10. A supplied regroup state retains the exchanged controllers.

**Choreography · ~5.8s.** Two measured, numbered owner-preserving lanes exchange ground/space occupants in parallel; receiving slots are measured from the final arena layout. Cards keep their dimensions and poses throughout. Hold OWNER P1 · CONTROL P2 and OWNER P2 · CONTROL P1 as two readable receipts, with no departure/entry or free-play stamp.

**Edges/tests.** Missing one side resolves no half-swap; deployed leaders are excluded. Reject duplicate target IDs, changed arena, owner reassignment, damage reset, arbitrary readying and an invented regroup return. Same-title copies require IDs. Include mixed-owner ordinary/token attachments, captive ownership and later owner-destination assertions; any uniqueness defeat must be explicit rather than hidden in the exchange animation.

## 4. Give In to Your Anger — damage now, action constraint later

**Complete clauses.** Deal 1 ability damage to an enemy unit, including a deployed leader. Its controller's next action this phase must be the ordinary Attack With a Unit action using this unit, if able; it must target a unit if a legal unit target exists, otherwise a legal base. It does not bypass readiness, Sentinel, arena, attack-prevention or other targeting rules and cannot be satisfied by playing an attack event/activating another attack ability. If unable/departed, another action is allowed. The constraint expires on that controller's next action or phase end; it is not an automatically scheduled attack.

**Immediate primary.** Pay 5, choose ready T: damage 0→1, remaining HP 3→2; no exhaustion, attack or base change. Keep a visible NEXT P2 ACTION · ATTACK WITH THIS UNIT IF ABLE status bound to T's current incarnation, round 9/action and the explicit next-action witness. P1 discard source, resources 5/10; P2 discard empty. All other cards remain common.

**Required selectable next-action scene.** Begin from that exact immediate ending; source already paid/discarded. Supply actual P2 ordinary attack T→D (D's Sentinel makes it the legal ground-unit target), simultaneous 3 to D and 4 to T. Both are defeated to their own discards, no Overwhelm/base damage; T's prior damage 1 is preserved until departure. The next-action constraint is consumed once; resources/decks/hands unchanged, P1 discard source+D, P2 discard T. Do not replay the one ability damage or event cost.

**Choreography · ~4.4s immediate / ~4.8s boundary.** A one-point sting attaches an angular next-action tether and then holds without moving T. The separately selected boundary releases the tether into one ordinary attack and closes it on actual action completion. Both persistent immediate status and consumed-boundary result require independent pixels, not a wall-clock countdown.

**Edges/tests.** Already-exhausted/no legal attack permits another action and consumes only the witnessed next-action boundary. With no attackable unit but legal base, base attack is required. Lethal initial damage leaves no surviving obligation; a Shield-prevented hit does not itself establish departure. Wrong player/phase/action or a later incarnation must not satisfy, extend or inherit the old witness; preserve actual supplied controller changes rather than guessing future legality.

## 5. Headhunting — three attack windows, one Bounty Hunter boost

**Complete clauses.** Attack with up to three friendly units, one attack fully resolving at a time; each may be declined. These attacks cannot target bases. Each attacker that is currently a Bounty Hunter gets +2/+0 for its own attack only; other units may attack without that boost. Normal ready/Sentinel/arena, counterdamage and triggers apply. Overwhelm or other supported abilities can still damage a base indirectly. There is no printed distinct-unit rule: an actual intervening ready effect could enable the same unit again; normal exhaustion alone prevents reuse.

**Primary.** Replace D with ready Reputable Hunter `a06:head:hunter`, owner P1, 3/4/damage 0/entry-1. Pay 6. Ordered attacks: (1) Hunter 5→T, simultaneous counter 3; T defeated, Hunter damage 3/exhausted, resting power 3. (2) Non-Hunter M 3→W, counter 4; M's damage 1→5 defeats it, W damage 1→4/remaining HP 1, still ready. (3) Non-Hunter X 2→F, counter 2; F defeated, X damage 2/exhausted. Final P1 ground Hunter only, space X; P2 ground W only, space empty. Discards P1 source+M, P2 T+F; bases unchanged (defending W's Overwhelm does not fire), resources 4/10.

**Choreography · ~6.8s.** A three-slot hunt rail opens one numbered attack at a time across ground and space. Only Hunter gets the two-notch bounty bracket; show M/X's ordinary attack amounts. Hold each completed injury/departure before opening the next gate, then survivors' resting stats. Never render three simultaneous volleys or omit the middle attack's loss.

**Edges/tests.** Zero/one/two attacks are legal, unavailable later targets are not replaced automatically, and only actual ready units attack. Reject base targeting and applying +2 to M/X or all phase; preserve ordinary attack triggers and legal indirect base damage. Test a readied repeated attacker without asserting a nonexistent distinct-ID restriction. Chronology and trait/boost receipts are required for rich replay, not inferred from final exhaustion.

## 6. Cripple Authority — total-resource comparison and two players' cards

**Complete clauses.** Draw one for P1; each opponent controlling strictly more total resources than P1 discards one card of their own choice. Exhausted resources count; equality gives no discard. Draw and conditional discard share a simultaneous resolution window, without a causal dependence on the draw. This two-player engine has one opponent.

**Primary.** Override P1 resources 8/8 ready and P2 2/10 ready. P2 hand is Takedown plus Open Fire `a06:cripple:p2:open`; P1 actual deck top is Repair `a06:cripple:draw:0`, owner P1. Pay 4, draw Repair (deck 27→26); P2 chooses Open Fire to discard because total 10>8, although P2 has fewer ready resources. P1 hand Repair, P2 hand Takedown, discards P1 source/P2 Open Fire, resources P1 4/8 and P2 2/10. Bases/arenas unchanged.

**Choreography · ~4.8s.** A total-resource scale reads 8 vs 10 independently from ready counts; parallel deck→P1 hand and P2-chosen-hand→P2 discard lanes resolve. Hold one real arrival and P2 CHOOSES 1, clear of the caption. No resource destruction, random discard or deck search.

**Edges/tests.** Equal/lower opposing total grants draw only even if ready counts suggest otherwise; empty opponent hand discards zero. Draw recipient remains P1. Short-deck failed draw needs actual engine fatigue/result, not a fabricated card; missing comparison or choice evidence cannot establish the conditional rich scene.

## 7. The Chaos of War — each hand measures its own base damage

**Complete clauses.** Simultaneously deal ability damage to each player's base equal to that player's current hand size. The source event has left P1 hand before this count. Zero hand means zero damage; no hand discard/draw, unit damage or allegiance exception.

**Primary.** Add P1 Marine/Repair/Open Fire `a06:chaos:p1:hand:0..2` beside the event; add P2 Resupply `a06:chaos:p2:resupply` beside Takedown. Pay 7 (two missing Aggression occurrences). At resolution hands contain P1 three/P2 two; deal 3 to P1 base (damage 9→12, HP 21→18) and 2 to P2 (damage 6→8, HP 24→22). Those five cards remain in their hands; decks/arenas unchanged, P1 discard source only, resources 3/10.

**Choreography · ~5.0s.** Two counted hand silhouettes independently spool 3 and 2 marks toward their own bases in one shared hit window. Hold both base counters and unchanged hand counts. Source departure from hand precedes the P1 count, visibly avoiding the tempting off-by-one four-point hit.

**Edges/tests.** Test event-only acting hand→zero own hit, unequal hand counts, zero opposing hand and both bases taking lethal damage. Simultaneous lethal outcomes use actual supplied match truth; do not select a winner by animation order. Repeated Aggression penalties must not collapse into one symbol.

## 8. Desperate Attack — damaged attacker, legal base target

**Complete clauses.** Attack with a damaged friendly unit, if able; it gets +2/+0 for that attack only. Damage means actual existing damage, not low effective HP, cost, exhausted pose or a debuff. Ready/legal attack requirements remain. Enemy unit or base may be targeted under ordinary restrictions; no attack is optional merely because Headhunting is optional.

**Primary.** Common M is ready with damage 1. Pay 3; attack P2 base (T/W are not Sentinel). M attacks at 5, exhausts and deals 5: P2 base damage 6→11/HP 24→19. Base gives no counterdamage; M ends resting 3/3/damage 1/exhausted/remaining HP 2, no attack-bonus status. P1 base/decks/other units unchanged; source alone in P1 discard, resources 7/10.

**Choreography · ~4.8s.** M's existing scar authorizes a two-notch attack-only surge; one five-mark assault reaches the actual enemy base. Surge closes after the strike while scar and exhausted pose stay. Keep the base destination unmistakable, distinguishing this from Headhunting's forbidden base targets.

**Edges/tests.** Undamaged, exhausted, hostile or attack-blocked candidates are illegal. Unit-target variants need simultaneous counterdamage and any real defeat; base variants never counter. A second explicitly readied attack uses resting power 3, not lingering 5. Missing recorded damage/chronology leaves the modifier prerequisite unknown.

## 9. Detention Block Rescue — damage captor, then ordinary captive release

**Complete clauses.** Deal 3 ability damage to any unit, or 6 instead if that selected unit guards at least one captured card at resolution. Either side/arena and deployed leaders are valid units. Six is not multiplied by captive count. The event has no independent rescue clause: captor survival preserves its pocket; only actual leave-play cleanup releases every captive to its real owner's arena, normally exhausted with clean damage/attachments/statuses and fresh incarnation. Rescue is not play and does not trigger When Played.

**Primary.** Remove M from P1 ground. Replace T with P2 Discerning Veteran `a06:detention:captor`, 3/4/damage 0/ready/entry-1, owner P2. Its previously resolved When Played captured M; pocket contains M's same stable ID/print/owner P1 exactly once, with no old arena damage/attachments/statuses. Pay 5; explicit captive count 1 selects damage 6 and defeats Veteran to P2 discard. Then supplied framework rescue moves M from the departed pocket to P1 ground beside D, 3/3/damage 0/exhausted/`a06:p1:marine:entry-2`. Captor absent, pocket consumed, P1 discard source/P2 discard Veteran, resources 5/10; bases/decks/hands unchanged.

**Choreography · ~5.8s.** CAPTURED 1 switches a measured 3→6 damage rail, Veteran fractures into its owner discard, then its preserved pocket origin opens one rescue lane to M's measured final ground slot. Hold RESCUED · OWNER P1 · EXHAUSTED and an empty captor slot. No unconditional rescue gate, hand waypoint or free-play/When Played flash.

**Edges/tests.** Zero captives uses 3; multiple use 6 and all are rescued only after actual departure. A surviving high-HP or Shield-protected captor keeps its captives; a friendly captor is legal. Test mixed owners/arenas, clean fresh entries, no old attack-history inheritance, and prevented defeat/no manufactured arrival. Current A04 rescue requires a present captor; this primary needs explicit last-known pocket evidence after defeat.

## 10. Pillage — P1 chooses player, that player chooses cards

**Complete clauses.** Choose either player; that player discards two cards from their own hand, choosing which. With fewer than two, discard all available cards. This is not random discard and P1 does not choose an opponent's individual cards. Self-selection counts the hand after the source event leaves it.

**Primary.** P2 hand is Takedown, Open Fire `a06:pillage:p2:open`, Resupply `a06:pillage:p2:resupply`. Pay 6; P1 explicitly chooses P2, then P2 chooses Takedown+Open Fire. They move hand→P2 discard once; Resupply remains in P2 hand. P1 discard source only, resources 4/10; all decks, arenas, bases and P2 resources unchanged.

**Choreography · ~4.6s.** A P1 player-choice bracket frames P2's hand, then a separately labeled P2 CHOOSES 2 selector moves two real cards to P2 discard while the third stays. Hold both chooser roles and the retained hand card; avoid title-derived raid/explosion art hiding the simple destination.

**Edges/tests.** Self-target is legal; the resolving source cannot be selected from hand. Test empty/one/two/three-card hands, exact two distinct IDs, missing/ambiguous copies, and preserved unselected cards. No top-deck cards, arena defeat or random selector may substitute for the actual own-hand discard.

## Narrow seams, evidence and acceptance

Supporting systems independently inspected: `AmbushAbility.ts`, `InitiateAttackSystem.ts`, `InitiateAttackAction.ts`, `TakeControlOfUnitSystem.ts`, `PlayableOrDeployableCard.takeControl`, `RescueSystem.ts`, and `core/gameSystem/CardTargetSystem.ts` leave-play cleanup. Reuse existing payment, play, attack, damage, draw/discard and phase-buff primitives; retain accepted timings and measured footer/arena geometry. Do not add a rules interpreter or generic scheduler.

1. Add explicit phase Ambush keyword plus chosen triggered-attack evidence, same played identity and nested price. Existing keyword unions only name Raid/Saboteur. Readiness is the supplied entry→Ambush→attack sequence, not a permanent ready override; unsupported recorded triggers remain generic observed changes.
2. Extend control receipts narrowly with permanent duration and paired exchange identity. Current preview handler always appends a regroup status; it must preserve original owners/poses/incarnations and avoid new delayed return. Token-control/owner behavior needs supplied attachment truth, not unit-owner reassignment.
3. Add one explicit next-controller-action constraint/status and separately selectable action-boundary fixture: subject ID/incarnation, acting seat, round/phase, actual action witness and consumed/expired result. Existing pending effects only handle regroup. Preserve exact immediate/follow-up snapshots; no elapsed-time action or general turn engine.
4. Extend rescue to use a verified departed captor's last-known pocket tied to its actual leave-play receipt, while consuming each captive once. Current `rescue` lookup requires present captor/pocket and rejects this post-defeat case. Keep before-origin geometry available during release; ordinary recordings with only movement remain “left captivity” without inferred rescue/owner/play causality.
5. Add explicit total-resource and resolution-time hand-count bases for the two count-dependent signatures, plus ordered attack IDs/indices, actual Bounty Hunter trait/attack bonus and ordinary player/card chooser receipts. Use the identical evidence gate for rich rendering and generic suppression, preserving sparse supported outcomes.

Meaningful implementation checks: exact identities/aliases/aspect occurrences and nested prices; sufficient resources; source disposal once; physical-card conservation; all chosen owners/zones/stat/damage/pose/count endings; simultaneous/ordered combat and attack-bonus expiry; permanent exchange; both Anger stages and wrong-action/incarnation counterexamples; departed-captor rescue and survival/prevention controls. These are future assertions, not tests executed by this spec author.

Independent acceptance must inspect every desktop and 390×844 18/46/72/90/100 contact and actual natural overlay-free ending, plus pacing, repeated replay/reset/seek/cancel and reduced-motion completion. Inspect phase/next-action/owner status pixels, both exchange lanes and exact final arrival slots. Remove actual defeated attachment chips at their beat, not merely a symbolic glyph. Preserve first-pass failures and served frozen-build fingerprints; diagnose fixed-geometry raster differences once rather than recapturing for favorable hashes. Require readability/meaning ≥4 and impact ≥3 without material semantic/state/clipping failure.

## Existing recorded availability, not UI acceptance

Root's initial read-only demo inventory found five actions across three identities; the complete replay checker subsequently found a fourth Timely Intervention, bringing that inventory to six actions across the same three identities. The initial discovery was incomplete; its discovery file `/tmp/swu-a06-recorded-actions.json` was inspected while finalizing this spec. Indices below identify existing actions, not fresh games or accepted playback.

- **Timely Intervention:** `random-a-vs-random-c-5`, index 31/P2/c78; `random-c-vs-random-a-6`, indices 19/P1/c12 and 235/P1/c11. Root's before/after inventory reports only event payment 1 and disposal, unchanged arenas, no unit movement or attack. Do not invent a nested play, Ambush grant or triggered attack for these recordings.
- **Timely Intervention, Smuggle with Ambush:** `random-b-vs-random-a-2`, indices 136–139/P2/c101. Timely leaves resources for discard with Smuggle payment 2, replaced from deck (34→33); Admiral Piett IBH_060 c75 is then played from hand for 4 and Ambush targets Expendable Mercenary LAW_159 c3. P2 ready resources 7→1, total remains 7, hand 6→5. Piett ends 2/5/damage 3/exhausted, Mercenary 3/3/damage 2/exhausted; bases unchanged. Sparse recorded animation cues contain observed movement/damage, not invented nested payment or trigger receipts.
- **The Chaos of War:** `random-b-vs-random-c-11`, index 82/P2/c90. Actual source payment is 5 with that player's aspects; P2 hand 4→3 and own base damage 0→3, P1 hand remains 4 and base damage 0→4. Other state remains unchanged. The staged P1 price 7 and three/two-card hands are a different deliberate fixture.
- **Desperate Attack:** `random-c-vs-random-b-12`, indices 139–142/P1/c11. Payment 1; explicit attacker/target prompts name Insurgent Saboteurs JTL_168 c40 and enemy Daimyo's Palace c103. Attacker remains power 6/HP 5/damage 4 and becomes exhausted; base damage 1→9 (+8). A later optional upgrade-defeat prompt is passed, with no upgrade removed. Preserve these actual deltas; snapshots alone do not establish temporary combat power or the boost's causal chronology.

The other seven identities have no examples in this existing inventory. The frozen complete 80-scene build `5758df9e07be7a4dfcd6fd5fc4247cf963e43f5ef8cd09e801fc3a3d39a18d45` passed all six actual A06 before/after/replay/seek checks, plus Calculated Lethality and Commission regressions (`results/card-effects-state-check/a06-recorded.json`). Independent primary/boundary pixel review remains separate. No fresh games were generated. Snapshots alone do not prove hidden choice, nested price, Ambush/forced-action chronology, count basis or framework rescue cause. Smuggle is fully specified but has no authored alternate scene here. Both Anger stages and the five narrow contract additions remain implementation requirements, and none of these ten is accepted by this document. Current engine sources resolve the specified mechanics; no additional rules ambiguity was found.
