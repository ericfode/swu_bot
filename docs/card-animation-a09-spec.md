# A09: next ten TWI events

GPT-6.1-sol / xhigh, 2026-10-11 local. **Source verified; data authored, visual acceptance pending.** Whole scope remains 2,458 identities / 2,549 prints; acceptance is separately recorded in the batch ledger. These are imported-a04 `batches[10]`, generated `A005`, and none is registered among the current100. A08 production is frozen. Root explicitly released A09 source authoring after the immutable source100 snapshot; no builds, games or paid calls by the data author.

Read-only authority: installed `forceteki/test/json/Card/<slug>.json` and reverse `_setCodeMap.json`; matching ten `03_TWI/events/*.ts` classes/tests; `CardsEnteredPlayThisPhaseWatcher`, `CreateTokenUnitSystem`, `ExploitCostAdjuster`, `TargetedCostAdjuster`, `CostAdjustStage`, and current renderer/reducer/types. Engine HEAD remains `2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`. All ten are non-unique events with one sole TWI print alias. Token JSON has canonical identity but no numbered print; do not invent one.

## Identities, costs and common fixture

P1 Luke SOR_005 supplies Vigilance/Heroism, Echo Base SOR_024 supplies Command. Each missing occurrence costs2, including Equalize's **second Vigilance**. Primary source payments, in order: **[3,5,1,2,2,3,5,7,5,8]**. No nested resource payment except Consolidation's explicit known free0. Invasion primary uses four actual Exploit cost sacrifices before paying7.

| Exact title / slug | Canonical identity / sole print | Printed cost / aspects | Primary P1 ending ready/total |
| --- | --- | --- | --- |
| Hello There / hello-there | 4036958275 / TWI_052 | 3 / Vigilance, Heroism | 13/16 |
| Equalize / equalize | 5013214638 / TWI_055 | 3 / Vigilance, Vigilance | 11/16 |
| I Have the High Ground / i-have-the-high-ground | 9399634203 / TWI_072 | 1 / Vigilance | 15/16 |
| Grievous Reassembly / grievous-reassembly | 6732988831 / TWI_073 | 2 / Vigilance | 14/16 |
| Guarding the Way / guarding-the-way | 2359136621 / TWI_074 | 2 / Vigilance | 14/16 |
| Disruptive Burst / disruptive-burst | 3596811933 / TWI_075 | 3 / Vigilance | 13/16 |
| Death by Droids / death-by-droids | 0968965258 / TWI_076 | 5 / Vigilance | 11/16 |
| The Invasion of Christophsis / the-invasion-of-christophsis | 2565830105 / TWI_078 | 15 / Vigilance; Exploit4 | 9/16 (15−8=7) |
| Reprocess / reprocess | 7579458834 / TWI_088 | 3 / Command, Villainy | 11/16 |
| Consolidation of Power / consolidation-of-power | 4895747419 / TWI_089 | 6 / Command, Villainy | 8/16 (event8, unit0) |

Common round11/action, P1 initiative, IDs prefix `a09:`; arena entry `<id>:entry-1`. Explicit owner, enclosing seat is controller. P1 Echo Base `a09:p1:base` HP30/damage9, undeployed ready Luke `a09:p1:leader`; P2 Capital City SOR_020 HP30/damage6, undeployed exhausted Vader SOR_010. P1 resources16/16 ready; P2 resources7/10 ready. Full unknown-face resource manifests `a09:<seat>:resource:<i>`, P2 slots7..9 exhausted; pay exact distinct ready IDs. P1 hand exact source `a09:<slug>:event`; P2 hand Takedown/Repair with stable IDs; empty discards. Full staged decks27/29, unknown stable `a09:<seat>:deck:<i>` placeholders. Override rather than duplicate physical cards.

- P1 **M** Marine SOR_095 `a09:p1:marine`, ground3/3/damage1/ready; **D** Echo Base Defender SOR_098 `a09:p1:defender`, ground4/3/damage0/ready/Sentinel; **X** Alliance X-Wing SOR_237 `a09:p1:xwing`, space2/3/damage0/ready.
- P2 **T** Death Trooper SOR_033 `a09:p2:trooper`, cost3, ground3/3/damage1/ready; **W** Wampa SOR_164 `a09:p2:wampa`, cost4, ground4/5/damage1/ready; **F** TIE/ln SOR_225 `a09:p2:tie`, cost1, space2/1/damage0/ready.
- Supporting actual faces: AT-ST SOR_232 (`6072239164`) cost6/Villainy, ground6/7/Overwhelm; Toro Calican SHD_239 (`3952758746`) ground3/5/Bounty Hunter; Academy Training SOR_120 upgrade+2/+2. **Battle Droid** JSON `battle-droid.json`, canonical `3463348370`, no numbered print, token unit cost0/Villainy, ground1/1, Droid/Separatist/Trooper. Its staged reference is `n:'Battle Droid',s:null,t:1`, explicit owner/fresh entry. Creation enters exhausted by default, **EntryType.Created, not Played**; no aspect payment or When Played. Real token units cease when removed, never enter hand/discard/deck.

Normal source ends once in P1 discard after payment. Unmentioned bases/cards/deck counts/stats/wounds/poses/owners stay unchanged. No speculative phase advancement, future attack, scheduler or automatic rule resolution.

## 1. Hello There — witnessed entry, phase stat reduction

**Clauses:** any current unit, either side/arena, which entered play this phase gets−4/−4 for this phase. Includes played, deployed leaders, created tokens and rescued units; excludes earlier-phase entry. It changes stats, not damage; power floors0 and resulting HP failure needs an actual defeat/leader destination/token cessation receipt. Current entry must match explicit staged evidence; printed unit identity or exhausted pose does not establish entry timing.

**Primary:** replace W with enemy AT-ST `a09:hello:atst`,6/7/damage0/exhausted, just played this phase. P2 already paid its legal6 using Capital City/Vader's supplied Villainy, so before P2 ready4/10, resourceIDs0..5 exhausted. Supply current round11/action entry witness for its exact entry (`played`), no new play receipt during Hello. Pay3, AT-ST becomes2/3/damage0/exhausted with persistent phase reduction, same owner/entry. **~4.4s:** prior-entry ticket authorizes a clean four-step stat frame compression, held2/3 with no wound marks. **Edges:** wrong phase/entry/untagged unit; deployed/rescued/created entry; token shrinks to0/0 and ceases; later actual phase snapshot/reset restores original stats without a scheduler.

## 2. Equalize — first reduction, then current count checkpoint

**Clauses:** give any unit−2/−2 this phase. **Then**, if event controller controls fewer units than the first target's controller, give a different current unit−2/−2 this phase (either side/arena). Count current controlled arena units including deployed leaders/tokens, after first reduction and its state-based departures; not owner/discard/captive/undeployed leader counts. Target controller at first effect is relevant even if target departed.

**Primary:** P1 only M/X (remove D; M damage0); P2 T/W/F plus enemy Defender `a09:equalize:enemy-defender`,4/3/Sentinel, four units. Pay5. First W becomes2/3/damage1, survives. Check **P1 2 < target-controller P2 4** now. Second T becomes1/1 with existing damage1, so actual HP-loss defeat→P2 discard. W retains phase status/wound1, own units unchanged. **~5.0s:** first stat cut holds while live2<4 count gate opens a separate second cut/HP-failure departure. **Edges:** first F death can reduce initial3<4 to3=3 and suppress second; different-target rule; friendly first target means own count<own count is false.

**Pinned-source concern:** implementation's `thenCondition` compares actor versus opponent, regardless first target controller, whereas printed condition compares that target's controller. Tests cover enemy-first and post-first-death count timing; friendly-first discrepancy is source-inspected, not a live-game finding. Primary uses enemy-first, satisfying both. Do not edit engine or stage the discrepant friendly-first extra reduction as printed-rule legal.

## 3. I Have the High Ground — standing defender effect, no immediate combat

**Clauses/errata:** choose a friendly unit. For this phase, while it is defending, the attacker gets−4/−0. Its resting stats and enemies' resting stats do not change; actual attacking power floors0 only in matching combat. Effect is bound to that continuing unit/phase, not a global persistent enemy debuff. No attack is caused by playing this event.

**Primary:** pay1, choose D. Keep D4/3/damage0/ready/Sentinel and all enemy stats unchanged; hold explicit phase status **“DEFENDING: ATTACKER −4”**. **~4.2s:** an elevated defensive bracket anchors to D, naming the future conditional power subtraction without a fake lunge/hit. **Optional later proof only:** from exact paid ending, enemy ready W can legally attack Sentinel D at4−4=0, take actual counter4 and be defeated (damage1→5), while D takes0 and keeps4/3. Actor is P2, no event replay/payment. Other targets/arenas, an enemy merely defending, stale entry/phase or absent status gain no reduction. This need not add a new UI boundary; concrete later combat may be tested independently.

## 4. Grievous Reassembly — independent healing and one created Droid

**Clauses:** heal up to3 existing damage from any unit (either controller/arena/deployed leader), and independently create one own Battle Droid. Systems are simultaneous; zero heal/no damaged unit does not cancel creation. No base healing, unit play, resource/aspect cost or ready entry by default. Real token-entry modifiers/triggers require their actual receipts.

**Primary:** W before4/5/damage4/ready. Pay2; W damage4→1 (stats/pose same) while P1 creates `a09:reassembly:droid:0`, ground1/1/damage0/exhausted/t1/new entry. Source discard, deck unchanged. **~4.8s:** enemy wound repair and a separate assembly lattice resolve in the same window, ending with three removed wounds and a measured exhausted token slot. **Edges:** no wounds still creates; partial heal, no arena units, actual ready-token modifier, fresh IDs/replay determinism; no success dependency on heal.

## 5. Guarding the Way — Sentinel always, initiative bonus separately

**Clauses:** give any unit Sentinel this phase; if **event controller** has initiative, also +2/+2 this phase, simultaneously. Friendly-only is absent. Existing damage/pose stays; neither an Experience nor Shield token. No initiative/null initiative means Sentinel only. Later phase truth/reset removes granted keyword/stats while retaining any printed Sentinel.

**Primary:** P1 has initiative; pay2, choose X. X becomes4/5/damage0/ready with actual Sentinel `sn:1` plus phase Sentinel/buff statuses, same space entry. D's printed Sentinel unchanged; enemies unchanged. **~4.4s:** a space-lane guard ring activates, then initiative seal licenses+2/+2. **Edges:** enemy target legal, P2 initiative gives no bonus; wrong actor initiative proof, repeated status duplication, printed versus granted keyword expiry. Standing power is genuinely increased here, unlike High Ground.

## 6. Disruptive Burst — every enemy unit, both arenas

**Clauses:** every opponent-controlled unit gets−1/−1 this phase, including deployed leaders/tokens; owners may differ. No friendly effects, damage markers or base hit. Separate real HP-loss departures; tokens cease, leaders use their actual owner leader summary. Constant-effect changes from departures need explicit truth.

**Primary:** add enemy Battle Droid `a09:burst:droid`,1/1/damage0/exhausted/t1, and deployed Vader (`a09:p2:leader`,5/8/damage2/exhausted, dep1/epic1 summary). Pay3. T→2/2/damage1; W→3/4/damage1; Vader→4/7/damage2, all survive with phase statuses. F→1/0 then owner P2 discard; Droid→0/0 then ceases. Own M/D/X untouched, bases unchanged. **~5.0s:** one opponent-only interference sweep touches both arenas; four measured stat cuts and a token collapse/real-card departure remain distinct. Include all **five** affected units, not only survivors. **Edges:** stolen-unit controller scope, enemy-empty arenas, actual aura cessation, token ID disappearance without invented discard.

## 7. Death by Droids — independent cost-limited defeat and two creations

**Clauses:** defeat any unit of printed cost≤3, either side/arena, including eligible tokens/deployed leaders, then independently create2 own Battle Droids. Source systems are simultaneous, no if-you-do. No eligible target still creates2 (source test verifies); actual prevention does not itself disprove independent creation. Compare printed cost, not power/discounted cost.

**Primary:** pay5; actual cost3 T→P2 discard, while distinct `a09:death:droid:0/1` enter P1 ground1/1/damage0/exhausted/t1. No hand/deck changes. **~5.0s:** printed3 gate isolates one defeat while two independent assembly columns arrive in measured final slots. **Edges:** Wcost4 invalid; friendly target, target token cessation, no target, preserved independent token count, no duplicate token IDs or fake known-free unit play.

## 8. The Invasion of Christophsis — Exploit costs first, opponent-only wipe

**Clauses:** optional Exploit4 can defeat up to4 controlled units, any arena/leaders/tokens, reducing resource cost2 each; normal aspects/other costs remain, never silently free. Unit-cost events resolve before resource payment. Then choose opponent and defeat every unit they control, both arenas/deployed leaders/tokens; own survivors/bases unchanged. Real Bounties, token/leader/attachment/captive destinations remain explicit. Source cost event caches resolved-or-replacement-resolved target events; do not infer replaced/protected cost payment from snapshot disappearance alone.

**Primary:** P1 M/D/X plus old exhausted Battle Droid `a09:invasion:own-droid` and surviving Toro `a09:invasion:survivor`,3/5/damage1/ready. P2 T/W/F plus old Droid `a09:invasion:enemy-droid` and deployed Vader5/8/damage2/exhausted with dep1/epic1 summary. W carries Academy ownerP1 (+2/+2). Explicitly Exploit M,D,X,ownDroid: three cards→P1 discard, token ceases; discount8, **pay7 once**, source→P1 discard. Then T/W/F→owner P2 discard, enemyDroid ceases, Vader→owner P2 exhausted undeployed/epic1 summary; Academy→P1 discard. Only own Toro remains. Ready9/16; bases/decks unchanged. **~6.6s:** four cost sacrifices flow into a visible15−8=7 gate before source disposal and an opponent-only two-arena collapse. **Edges:** zero/fewer Exploit, actual actor/entries, insufficient resources, premature/duplicate payment, mismatched selection; primary uses ordinary actual cost defeats. No general replacement solver is needed.

## 9. Reprocess — chosen discard units to bottom, same number created

**Clauses:** choose0..4 unit cards in own discard; move them to owner deck bottom in a supplied valid random order and create that many Battle Droids. Unit-type in discard, not upgrade/event/opponent discard; discarded Piloting unit is still a printed unit. No entry-history/current-phase defeat prerequisite. Source creation amount is **chosen target length**, not an if-you-do count of successful deck movements; movement/prevention needs its own supplied facts.

**Primary:** own discard M/D/X with IDs `a09:reprocess:dead:0..2` plus unselected Repair `a09:reprocess:repair`. Pay5. Select three, actual bottom order X,M,D; deck27→30, top27 unchanged, own discard retains Repair+source. Create distinct `a09:reprocess:droid:0..2`, own ground1/1/damage0/exhausted/t1. **~5.6s:** three public discard cards descend to a private bottom deck stack; a separately counted three-token assembly receives the selected3 receipt. **Edges:** none/no units creates0, max4/different order, non-unit/other discard invalid, count-selected versus actual move must not be conflated, source event cannot recycle itself.

## 10. Consolidation of Power — choose power now, play free, then sacrifice

**Clauses:** choose any number of controlled units, including zero, both arenas/ready or exhausted/leader/token. Sum their actual current power including modifiers/upgrades. May play an own-hand unit of printed cost≤sum free (resource/aspect costs ignored; other costs/restrictions and actual entry effects remain). **Then defeat chosen units even when free play is declined or no legal hand card exists**; no actual play-success prerequisite. Newly played unit was not in initial selected set.

**Primary:** M has Academy ownerP2/controllerP2, +2/+2:5/5/damage1/ready; X2/3/damage0/exhausted. Hand also Wampa `a09:consolidation:played`, printed4/Aggression. Pay event8. Choose M+X, sealed power5+2=7; explicit nested free pay0 ignores missing Aggression2. Play W from own hand exhausted4/5/damage0/new entry (no When Played ability). Then M/X→P1 discard and Academy→P2 discard. Own D stays4/3/ready/Sentinel; new W stays exhausted; enemy units/bases/decks unchanged, own hand empty/ready8/16. **~6.2s:** two selected power receipts authorize4≤7, new unit arrives in measured final layout, then old chosen units depart along distinct owner routes. **Edges:** decline still sacrifices; empty choice/zero-cost unit; cost above actual sum rejects; no stale power after cleanup, no chosen new arrival, no fake aspect charge or old wound/status inheritance.

## Evidence, reuse and acceptance

Proposed minimum fields/APIs are in [A09 contract](card-animation-a09-contract.md): entry-phase witness; distinct created-token entry; phase Sentinel/initiative proof; conditional attacker-power status; first-target count checkpoint; explicit Exploit pre-payment defeat roles; sealed chosen-power/free-play/then-sacrifice group. Keep common resolver applying declared facts, not running card rules or a phase scheduler. Complete clauses and chosen primary are different.

Reusable candidates: R06 standing keyword/stat changes for Hello/Equalize/Guard/Burst, R07 heal/derived counts, R08 explicit combat for optional High Ground proof, R02 payment/source disposal for Exploit, R03/R09 discard-to-bottom routes, R05 paid/free entry and R10 owner cleanup for Consolidation. **New candidate:** generated token-unit assembly/entry, distinct from playing an existing card; share creation motion/identity/readiness/count while preserving independent versus selected-count clauses. Exploit's cost sacrifice precedes event resolution, unlike Consolidation's then-sacrifice. Do not flatten these into one generic defeat→play recipe.

Tests read installed JSON directly: all identities/sole aliases/aspects/real unit and token stats; exact payments/resources/source disposal once; entry kind/current entry/phase; post-first-effect unit counts/controller/departure; unchanged resting High Ground stats and actual later combat link; initiative versus recipient; all opponent units/leader/token destinations; creation stable IDs/cease/no origin/no When Played/exhausted; independent zero-heal/no-target clauses; exact Exploit prefix/pay-once/source timing; selected count/random bottom; sealed power/free0 and sacrifice on declined play. Strict renderer proof and generic suppression share the same predicate. Inspect desktop/mobile ordered contacts, natural routes, settled boards and lifecycle; authored tests are not acceptance.

**Existing recordings:** root's read-only exact-print/all-alias/normalized-title inventory `/tmp/swu-a09-recorded-actions.{cjs,json}` found **zero plays for all ten**. Availability only; no new games. All A09 mechanics and pixels therefore need explicit staged evidence and independent review, not a claimed recorded-play pass.
