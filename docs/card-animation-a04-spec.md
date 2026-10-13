# A04: ten SOR/SHD event specifications

Specification only, GPT-6.1-sol / `xhigh`, 2026-10-11. Scope remains all 2,458 imported identities; 40 are accepted through A02. A02's first pass was 7/10, so the clean authoring streak is zero and no effort reduction is earned. These ten are pending implementation and independent acceptance.

Read-only sources: installed `forceteki/test/json/Card/<slug>.json`, the five matching `01_SOR/events/` and five `02_SHD/events/` classes and tests, plus attack-history, cost, capture/rescue and entry systems. Engine revision: `2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`; Maximum Firepower's class is `MaximumFirePower.ts`. Current skill, ledger, A03 spec and presentation seams were inspected. No engine edits, builds, new games or paid analysis were used.

## Identities and common payment

All ten are non-unique events, with exactly the single print alias below. Register canonical ID and print, never a title fallback. Common provided aspects are one each of Command, Vigilance and Heroism. Missing symbols cost 2 each, including Midnight Repairs' second Vigilance. Pay the event once before its effect; nested unit play is separately accounted for.

| Slug / exact title | Canonical ID | Print | Cost / aspects | Event payment → P1 ready |
| --- | --- | --- | --- | --- |
| i-am-your-father / I Am Your Father | 0523973552 | SOR233 | 3 / Villainy | 5 → 5 |
| maximum-firepower / Maximum Firepower | 2758597010 | SOR234 | 4 / Villainy | 6 → 4 |
| galactic-ambition / Galactic Ambition | 5494760041 | SOR235 | 7 / Villainy | 9 → 1 |
| medal-ceremony / Medal Ceremony | 4536594859 | SOR245 | 0 / Heroism | 0 → 10 |
| youre-my-only-hope / You're My Only Hope | 3509161777 | SOR246 | 3 / Heroism | 3 → 7; nested primary play 1 → 6 |
| calculated-lethality / Calculated Lethality | 0302968596 | SHD039 | 4 / Vigilance, Villainy | 6 → 4 |
| mystic-reflection / Mystic Reflection | 9999079491 | SHD051 | 1 / Heroism, Vigilance | 1 → 9 |
| midnight-repairs / Midnight Repairs | 8818201543 | SHD054 | 2 / Vigilance, Vigilance | 4 → 6 |
| covert-strength / Covert Strength | 8645125292 | SHD075 | 1 / Vigilance | Normal hand play 1 → 9 |
| unexpected-escape / Unexpected Escape | 1973545191 | SHD076 | 1 / Vigilance | 1 → 9 |

## Complete common before/after contract

Fresh fixture per card; instance IDs are separate from canonical IDs. Every arena entry has owner and `incarnation: '<id>:entry-1'`. All prior entry abilities are resolved; none are replayed merely to animate this event.

- Round 9/action, P1 initiative. P1 Echo Base SOR024, 30 HP/damage 9; undeployed Luke Skywalker, Faithful Friend SOR005; resources 10/10 ready. P2 Capital City SOR020, 30 HP/damage 6; undeployed Darth Vader SOR010; resources 7/10. IDs `a04:<seat>:base` and `a04:<seat>:leader`.
- P1 hand only `a04:<slug>:event`, except the explicit Ambition addition. P2 hand Takedown SOR077, `a04:p2:hand:takedown`. Both discards empty. P1 deck 27, P2 deck 29, with complete stable `knownDeck` arrays; unspecified slots `a04:<seat>:deck:<index>` have unknown face/print and never receive invented public identities. Actual named top cards replace slots, not counts.
- P1 ground **M** `a04:p1:marine`: Battlefield Marine SOR095, cost 2, 3/3/damage 1, ready, Rebel/Trooper; **D** `a04:p1:defender`: Echo Base Defender SOR098, cost 3, 4/3/damage 0, ready, Rebel/Trooper/Sentinel. P1 space **X** `a04:p1:xwing`: Alliance X-Wing SOR237, cost 2, 2/3/damage 0, ready, Rebel.
- P2 ground **T** `a04:p2:trooper`: Death Trooper SOR033, cost 3, 3/3/damage 0, ready, Imperial/Trooper; **W** `a04:p2:wampa`: Wampa SOR164, cost 4, 4/5/damage 1, ready. P2 space **F** `a04:p2:tie`: TIE/ln Fighter SOR225, cost 1, 2/1/damage 0, ready, Imperial. No upgrades/statuses unless specified.
- Supporting aliases verified: X also LAW253; T also SHD030/SEC030; W also LOF164; Repair SOR074 also JTL075; Open Fire SOR172 also TWI174. Aliases do not create extra instances. Additional verified faces: Luke Skywalker, Jedi Knight SOR051, cost 7, 6/7, Force/Jedi/Rebel; Academy Training SOR120, +2/+2; Discerning Veteran SHD120, cost 5, 3/4.
- After each example: source event in P1 discard exactly once, resources as table, unrelated cards/deck order/damage/readiness/owners unchanged. Tokens use stable `a04:<slug>:xp:<index>`, `t:1`, explicit +1/+1, owner P1 in these friendly-recipient primaries. Damage is distinct from printed/effective HP; no scene clock expires rules.

## 1. I Am Your Father — the controller rejects the threat

**Clauses.** First choose an enemy unit, including a deployed leader; its controller chooses whether to say “no” (a clear equivalent indication is valid). Without refusal, deal 7 ability damage to it. With refusal, P1 instead draws 3; the target takes no damage. No legal enemy target means neither branch resolves, though the event may still be played/paid.

**Primary.** Target W; P2 explicitly says NO. P1 actual top cards are Marine SOR095 `a04:father:draw:0`, Repair SOR074 `...:1`, Open Fire SOR172 `...:2`. Pay 5; draw those three into P1 hand, deck 27→24, discard 0→1. W remains 4/5/damage 1/ready; bases and P2 are unchanged.

**Choreography · ~5.2s.** A seven-mark threat bracket targets W before a visible P2 NO seal interrupts it; the stopped ray redirects into three private backs following the real deck→hand route. Hold “P2 says NO · P1 draws 3” and three clear arrivals; no damage flash. The alternative damage branch uses one seven-mark hit and actual defeat destination if lethal.

**Edges.** Do not assign chooser by original owner under changed control, draw for P2, render both branches, or identify unseen draw faces in recordings. Short/empty-deck draws need actual resulting cards and failed-draw outcomes, not a fabricated three-card hand.

## 2. Maximum Firepower — two stationary Imperial firing sources

**Clauses.** A friendly Imperial unit deals its current power as ability damage to any unit in either arena; then a different friendly Imperial unit deals its current power to that same target. Sources may be exhausted; target need not be enemy or in the source arena. No attack, exhaustion payment, counterdamage or Overwhelm. If the target leaves play after the first hit, the second cannot hit a replacement incarnation.

**Primary.** Replace M with P1 Death Trooper SOR033 `a04:maximum:trooper`, 3/3/damage 0, exhausted; replace X with P1 TIE SOR225 `a04:maximum:tie`, 2/1, ready. Replace W with P2 Luke, Jedi Knight SOR051 `a04:maximum:target`, 6/7/damage 0, ready. Pay 6; Trooper deals 3, TIE deals 2, Luke ends damage 5/remaining HP 2. Both firing poses, D and bases stay unchanged.

**Choreography · ~5.8s.** Numbered sightlines converge from measured ground and space sources: current-power 3 pulse, held damage 3, then current-power 2 pulse, held damage 5. Sources remain seated; the exhausted first source is plainly visible. Hold two source identities and one target, unlike Rebel Assault's moving attackers.

**Edges.** No Imperial means no effect; one Imperial permits the first hit without inventing a second. Distinct IDs, current modified power and target presence matter. First-hit defeat stops the second damage route; do not duplicate the first source or choose a new target.

## 3. Galactic Ambition — free arrival, own-base price

**Clauses.** Play a non-Heroism unit from own hand for free; if successfully played, deal its printed cost as ability damage to your own base. Free ignores resource/aspect costs, not other additional costs or play restrictions. Ordinary entry/When Played rules still apply; exhausted entry is the default, not an unconditional override.

**Primary.** Add Wampa SOR164 `a04:ambition:unit`, owner P1, to P1 hand beside the event. Pay event 9 and nested play 0. Wampa moves hand→P1 ground as 4/5/damage 0/exhausted with new incarnation; hand becomes empty. Then P1 base damage 9→13 (HP 21→17), exactly printed cost 4. P1 discard 1, resources 1/10; P2 base stays damage 6.

**Choreography · ~5.4s.** A FREE gate admits the actual intact hand card into the measured final ground slot, then its printed-cost 4 counter returns along a separate route to the acting player's base. Hold exhausted arrival and own-base HP 17; no imaginary unit resource payment or enemy-base hit.

**Edges.** Reject any Heroism symbol, including multi-aspect units. Failed play gives no automatic base hit. A zero-cost unit causes zero; lethal self-base damage requires the actual ending. Selected units with entry abilities need their supported resolutions, not automatic omission or invented bonus effects.

## 4. Medal Ceremony — honor witnessed attacks

**Clauses.** Give one Experience token to each of up to three distinct Rebel units that attacked this phase and remain in play as that same incarnation. Either side and deployed leaders are eligible; “friendly” is not printed. Zero/fewer targets is legal. Exhaustion is not proof of attacking; ready units can qualify if they were readied afterward.

**Primary.** M, D and X start exhausted. Explicit current round/action attack history names their IDs/incarnations and three distinct attack IDs: each attacked P2 base earlier for 3, 4 and 2. Override P2 base damage to 12, from 3 before those attacks; no current event damage. Pay 0, award one XP each: M 4/4/damage 1, D 5/4/damage 0, X 3/4/damage 0, all still exhausted. Base counters/decks/hands unchanged except source discard.

**Choreography · ~4.8s.** Three subdued completed-attack witness ticks authorize three medal drops onto the actual attachment rows; +1/+1 rises with each persistent XP token. No new attack line or repeated old damage. Hold ordinary token/stat results, with no phase-only buff language.

**Edges.** Wrong phase, no attack history, non-Rebel and departed/replayed incarnations are ineligible. Same-phase enemy Rebel is eligible. Tokens are one per selected unit, not three on one, and remain after phase end. Missing recorded attack history remains unknown.

## 5. You're My Only Hope — privately inspect, then play from deck

**Clauses.** Privately look at deck top; may leave it or legally play it for 5 resources less. At own base remaining HP ≤5, may play free instead. Any playable card type/mode is supported, including a Piloting choice; restrictions and additional costs still apply. Inspection is not reveal/draw; empty deck supplies no card.

**Primary.** Top is Wampa SOR164 `a04:hope:top`, owner P1. Base HP 21, so select PLAY −5. Pay event 3, then nested cost `max(0,4+2 missing Aggression−5)=1`. Deck 27→26; Wampa goes directly deck→P1 ground, 4/5/damage 0/exhausted/new incarnation. P1 hand empty, discard event only, resources 6/10; bases unchanged.

**Choreography · ~5.6s.** A private top-card aperture and −5 ruler show a back until public play; the 4+2−5=1 receipt accompanies the face into the measured final arena slot. Hold “FROM DECK · PAID 1” and exhausted arrival; no hand waypoint. Free/leave choices use their own receipts, never simultaneous alternatives.

**Edges.** Threshold includes exactly 5 HP. Leaving top preserves order/count; discount floors at zero after penalties. Free still pays the source event. Upgrade/event/Piloting plays require actual targets, destination and resolution; lack of a legal play does not force a draw or remove top card.

## 6. Calculated Lethality — defeat and redistribute upgrade count

**Clauses.** Choose any non-leader unit with printed cost ≤3; attempt to defeat it. For every upgrade it had, including Shield/Experience tokens, give an Experience token to a friendly unit, freely distributing repetitions. Use the surviving target's upgrades or departure last-known upgrades. The engine explicitly still awards tokens when defeat is prevented (Lurking TIE Phantom test); do not require actual removal for this clause.

**Primary.** T has Academy Training SOR120 `a04:lethality:academy` owner P2 (+2/+2), XP `...:old-xp` owner P2 (+1/+1), Shield `...:shield` owner P2 (0/0): effective 6/6/damage 0, printed cost still 3. Pay 6; defeat T directly, Academy goes to P2 discard, both tokens cease. Count 3; allocate 2 XP to M and 1 to X. M ends 5/5/damage 1, X 3/4/damage 0, poses unchanged; P2 discard exactly T+Academy, P1 discard event, resources 4/10.

**Choreography · ~6.0s.** Three attachment silhouettes are counted before departure; real upgrade and unit take their proper discard routes while token rings collapse. Three counted pips split 2→Marine/1→X-Wing and become permanent XP attachments. Defeat is a cut, not seven damage or a Shield-blocked attack.

**Edges.** Printed-cost filter ignores attachments/payment discounts; friendly target is legal, leaders are not. Zero upgrades yields no XP; several XP may share one friendly host. No eligible recipient must not create one. Prevention retains target/upgrades and needs its actual supported result, not a fabricated discard route.

## 7. Mystic Reflection — subtract capacity, preserve damage

**Clauses.** Enemy unit gets −2/−0 for this phase; with a friendly Force unit in play, −2/−2 instead. Either arena/deployed unit is eligible; undeployed Force leader and a Force upgrade alone do not satisfy the unit prerequisite. Power floors at zero; reduced HP can cause defeat from existing damage/zero HP without becoming new damage.

**Primary.** Replace D with P1 Luke, Jedi Knight SOR051 `a04:mystic:force`, 6/7/damage 0, ready; stage no unresolved entry effect. Pay 1, select W: power 4→2, maximum HP 5→3, damage remains 1, remaining HP 4→2, ready. Persist a visible −2/−2 PHASE status on the ordinary Wampa; other cards/bases unchanged.

**Choreography · ~4.4s.** A reflected two-axis frame links the actual Force unit to W; two power notches and two HP-capacity notches contract separately around unchanged damage. Hold both effective counters and phase marker. No heal/damage particles or permanent token.

**Edges.** Without Force, only power changes. Preserve existing damage and pose; lethal stat reduction requires actual defeat. An explicitly supplied phase-end state removes the modifier, not accumulated damage; scene elapsed time does not advance phase or resurrect a defeated unit.

## 8. Midnight Repairs — spend an eight-point healing budget

**Clauses.** Heal up to 8 total existing damage, distributed among any number of units on either side/in either arena, including deployed leaders. Fewer points/zero targets is legal. Bases are ineligible; no recipient heals beyond its existing damage, and no maximum HP increases.

**Primary.** Override damage: M2, D2, X2, W3, T1; all survive and retain common ready poses. Allocate M2+D2+X1+W3=8. Pay 4; afterward M0/D0/X1/W0/T1 damage. All powers/maximum HP unchanged; bases remain damage 9 and 6, source discard 1, resources 6/10.

**Choreography · ~5.4s.** An eight-notch repair rail sends labeled 2/2/1/3 repair packets to four measured recipients across both sides and arenas. Scars extinguish only by those quantities; rail ends at zero. Hold each recipient's remaining damage, with opposing-side labels kept separately readable.

**Edges.** Damaged-unit eligibility and allocation are independent of allegiance. Validate sum ≤8 and each allocation ≤damage; no base route, automatic full heal, damage redistribution or hidden HP buff. The repeated Vigilance penalty must be paid once, not collapsed to one symbol.

## 9. Covert Strength — one host, simultaneous repair and Experience

**Clauses.** Heal 2 existing damage from any unit and give that same unit one XP token simultaneously. Enemy/deployed units are legal; an undamaged unit still receives XP. Smuggle separately permits play from resources for 3 + one Vigilance, replacing the source with deck top as an exhausted resource if available; it is an alternate play route, not an additional 3-cost hand payment.

**Primary.** Normal hand play; M starts damage 2. Pay 1; heal 2 and add one XP to M in the same resolution window. M ends 4/4/damage 0/ready (remaining HP 1→4: two healed plus one capacity gained). P1 discard event, resources 9/10, decks unchanged. No other recipient or delayed token.

**Choreography · ~4.2s.** A quiet dual-strand knot converges at M: two damage marks fade as one XP medal locks onto its attachment row. Hold two separate receipts, HEAL 2 and XP +1/+1, and the ordinary 4/4 undamaged unit; do not label all three gained remaining HP “healed 3.”

**Edges.** Heal clamps to existing damage (0/1/2), while XP still occurs. A separately authored Smuggle fixture needs explicit resource-source identity, printed Smuggle aspects/payment, actual top replacement/deck decrement and resource count; empty deck yields no replacement. Do not add that route to this normal-play primary or imply Smuggle acceptance from it.

## 10. Unexpected Escape — exhaust captor, rescue to the owner

**Clauses.** Exhaust any unit; optionally rescue one captured non-leader card guarded by that selected unit. Either side, already-exhausted units and units with no captives are legal. Rescue returns to the card's owner in its own arena, default exhausted with fresh arena incarnation; ready-entry effects can alter that. Rescue is `EntryType.Rescued`, not play, so no When Played effect or unit play payment.

**Primary.** M is absent from P1 ground. Replace T with ready P2 Discerning Veteran SHD120 `a04:escape:captor`, 3/4/damage 0; its previously resolved When Played captured P1 Marine `a04:escape:marine`, owner P1, represented once in `cap[]`. No attachments/damage/old arena status survive capture. Pay 1; exhaust Veteran, explicitly choose the captive, remove that reference from its pocket, put Marine into P1 ground beside D as 3/3/damage 0/exhausted with `a04:escape:marine:entry-2`. Veteran survives, cap becomes empty; resources 9/10, discard only event, all decks/hands/bases unchanged.

**Choreography · ~5.2s.** The selected Veteran folds exhausted, its measured captive pocket opens, and one intact card follows a RESCUE · OWNER P1 route into the measured final ground slot. Hold both exhaustion poses and empty pocket; no death stamp, hand route, FREE PLAY badge or replayed capture ability.

**Edges.** Decline rescue or select an uncapturing unit: exhaust only. Multiple captives permit exactly one selected arrival; others remain attached. Original owner overrides captor controller. Wing Leader rescued as a variant does not award its When Played XP. Unknown owner/origin in a recording forbids invented rescue attribution, though the actual after board still renders.

## Minimal shared seams and acceptance boundary

1. Reuse existing payment/play, damage/heal, XP, phase-debuff and measured-arrival primitives. Add declarative current-phase attack history with attacker ID + incarnation for Medal; no scheduler. Conditional choice receipts preserve actual chooser/branch and ordered current-power sources without inferring attacks.
2. Add one explicit `rescue` outcome with captor ID, captured ID, owner/destination, complete entering UnitRef and new incarnation. Current studio UnitRef/lookup/board omit `cap[]` despite recorder/viewer references: add a narrow captured pocket/count and measurable origin. Rescue removes only that captive, enters owner's arena once, and never shares `play` triggers/payments. Recorded before/after remains authoritative; exact stable IDs or unambiguous print identity are required.
3. Treat prior-upgrade count as explicit basis for distributed XP; surviving protected hosts and departed last-known hosts are distinct evidence. Keep distribution and history validation narrow, with no title-derived rules interpreter. Add Smuggle resource-source presentation only when that alternate scene is actually authored.

Spec fixtures are chosen legal branches, not fresh engine/replay execution. Root subsequently inspected existing demo recordings: Calculated Lethality appears in `random-c-vs-random-a-8.jsonl`, action indices 283–286. P1 pays 4 with its actual aspects, defeats its own unupgraded Rogue One `c3` from space, and gains no Experience. Later prompts resolve the departed unit's deck-order trigger; they are not Lethality's upgrade-count distribution. The recording supports the exact removal and final board but does not exercise the primary three-upgrade example. None of the other nine events appeared in that existing demo inventory. No new games were generated. Preserve all forty accepted signatures and A02 caption clearance.

Implementation acceptance: JSON identity/aspect/payment checks; exact before/after conservation and owner destinations; history/incarnation, alternate-choice and protected-defeat edges; persistent tokens/debuff pixels; no attack/damage/play conflation. Run studio tests/build, then independent desktop and 390×844 captures at 18/46/72/90/100% plus natural overlay-free completion. Inspect every contact and actual ending, natural pacing, repeated replay/reset/backward seek/cancellation and relevant reduced-motion behavior. Readability/meaning ≥4 and impact ≥3; material clipping/state/semantic failures reject the card. Record first-pass failures permanently. This document is authoring input, not ten accepted scenes.
