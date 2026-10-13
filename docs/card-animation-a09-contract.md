# A09 narrow contract proposal

GPT-6.1-sol / xhigh. Read [verified clauses/fixtures](card-animation-a09-spec.md). **Root approved these narrow shapes for isolated drafting; product installation remains paused until explicit release.** Preserve A08 source fields, existing RuleRespect capture evidence and all stage unions. No engine edits, general scheduler, causal inference from recordings or sound design.

## Fields proposed

```ts
interface UnitRef { t?: 1; } // explicit staged TOKEN UNIT marker, not guessed from null print/title
// Define in data/types.ts; effects/types.ts imports this type. No data→effects dependency.
interface DefenseModifier {
  attackerPower: -4; sourceId: string; round: number; phase: string; incarnation: string;
}
interface Snapshot {
  enteredThisPhase?: { round: number; phase: string; units: {
    id: string; incarnation: string; entryType: 'played'|'created'|'rescued'|'deployed';
  }[] };
}
// Add concrete token creation meaning to AbilityKind/ABILITY_LANGUAGE.
type AbilityKind = /* existing */ | 'create';
// Add Sentinel to existing keyword-name unions (outcomes and UnitStatus).
// Existing keyword amount1/duration:'phase' updates sn as well as visible phase status.
interface CardEffectOutcome {
  entryType?: /* existing */ | 'created';
  enteredPhase?: { round: number; phase: string; incarnation: string };
  tokenType?: 'battle-droid'; // create requires complete unit/t1/owner/fresh ID/entry/pose
  paymentRole?: 'exploit';   // only explicit cost-defeat prefix, resolved BEFORE event pay
  defenseModifier?: DefenseModifier; // conditional buff, no resting-stat change
  defenseOrigin?: { protectedId: string; incarnation: string; sourceId: string };
  unitCountCondition?: { firstId: string; incarnation: string; player: Seat;
    against: Seat; ownCount: number; otherCount: number }; // on second Equalize debuff
  chosenUnits?: { id: string; incarnation: string; power: number }[];
  chosenUnitGroup?: string; // same selection group across creation/play/then-sacrifice receipts
  // Extend condition with {kind:'initiative';player:Seat;initiative:Seat|null}.
}
interface UnitStatus { defenseModifier?: DefenseModifier; }
// Add only these explicit source cost options.
interface PreviewCardCost { exploit?: 4; }
// Extend existing kind:'resources' PreviewPlayPayment member.
{ kind:'resources'; cardIds?: string[];
  exploit?: { sourceId: string; units: { id: string; incarnation: string }[] };
}
```

`create` uses existing `unit`, `seat`, `zone:'ground'`, `amount:1`, `entersReady:false`, `entryType:'created'`, `ownerSeat`, `sourceCard=event`, stable token identity and optional same `resolutionGroup`. One receipt per actual generated token avoids a made-up aggregate object or ambiguous arrival slot. No pay/free/draw/fromZone origin is attached. Creation is known from its explicit receipt; recorder snapshots without that evidence stay generic actual arrival. Extend only silent audio exhaustiveness for the new kind.

Existing `sequenceId/index` binds first/second Equalize reductions. Existing `printedCost`, `basis` and `requiresDefeat/Return` keep their meanings; do not misuse those success dependencies for independent token clauses. `chosenUnits/chosenUnitGroup` is a sealed selected-set witness, not an arena-selection engine. Reassembly/Death use fixed creation counts; Reprocess uses chosen-discard group count; Consolidation uses chosen current power. Exact selection metadata is source-verified in focused tests.

## APIs, costs and ownership

Export `A09_DEFINITIONS`, `A09_ABILITIES`, `A09_EXAMPLES`, `A09_COSTS`, `a09ShowcaseState(definition)`, `a09PreviewSource(definition,state,seat)`, `a09PreviewPayment(definition,state,seat,choices?)`, `a09PreviewOutcomes(definition,state,seat,choices?)`. Source API returns the actual own-hand event; retain A08 source-before-hand-fallback precedence. No new required boundary API/UI stage. High Ground primary is the immediate persistent conditional status; later defensive combat can be tested through an explicit independent action with actorP2/source-null and no event payment.

Primary event payments **[3,5,1,2,2,3,5,7,5,8]**, P1 starts16/16 and ends **[13,11,15,14,14,13,11,9,11,8]/16**. Equalize's metadata has two Vigilance symbols and actual5. Invasion metadata printed15/Vigilance/exploit4, primary four actual sacrifices→discount8→payment7; no Exploit branch costs15. Reprocess/Consolidation include own missing Villainy2. Consolidation nested free0; `previewExtraPayment` stays0 for all ten. Root owns registry/catalogue/showcase/preview/cost baseline/aliases/observed tests/builds; author later owns data module/tests/shared types/reducer/cost/abilities and silent create-audio case. Renderer split remains root-assigned. No A09 recorded examples exist.

## Concrete application guards

- **Hello:** debuff−4/−4 carries `enteredPhase` for the actual selected entry. Require before `enteredThisPhase` current round/phase and exact id/entry. Played/deployed/created/rescued all qualify; an undeployed leader or captive is not a current unit. No history reconstruction from readiness/current discard. Stat loss leaves wounds unchanged; explicit defeat/leader/token receipt handles actual HP failure. Watcher records card identity, whereas staged proof deliberately names the current entry.
- **Equalize:** first debuff index1 records actual id/entry/controller; explicit HP-loss departure, if any, resolves before index2. Second uses `unitCountCondition` against that first controller, current arena counts on both sides and distinct recipient. Reject false/old counts, same target, missing first result or friendly-first own<own claim. Primary2<4 satisfies printed rule and pinned implementation. Document source's opponent-only count discrepancy; do not encode it into legal staged examples.
- **High Ground:** use `buff` with `defenseModifier`, amount omitted or descriptive text; branch before normal numeric stat parsing. Require actual friendly current subject/entry and current round/phase/causing sourceID; store phase buff status containing the modifier and visible label, **do not modify p/h/sn**. In a separately declared later attack, transient attacker debuff−4/−0 carries `defenseOrigin`; require protected unit's matching actual status/entry/source/phase and identified attack targeting it, opposing current attacker, correct attackID. Clamp attack power0, resting attacker power unaffected afterward. No attack is generated by the primary event and no timer triggers it.
- **Reassembly / Death:** heal and create1 share simultaneous group without dependency; defeat and create2 share simultaneous group without dependency. No wounds/no legal target/actual separately supplied prevented action does not erase explicit independent creation. Created units must have unique new IDs, actual BattleDroid JSON1/1/damage0/ground/t1/exhausted/owner, current fresh entry; token body never starts in hand/deck or triggers When Played. Removing any explicit t1 token unit ceases it; current ordinary unit discard behavior remains unchanged.
- **Guard:** keyword Sentinel1/phase on any actual current unit sets `sn:1` plus visible status; initiative+2/+2 has exact actual `condition` actor/initiative proof. Conditional recipient can be enemy; check event controller's initiative, not target's. Do not inflate power for keyword alone or create attachment token. Reset/actual later-phase state supplies expiry, no generic phase scheduler.
- **Burst:** five actual enemy entries receive−1/−1, including deployed Vader and old Droid. Explicit F defeat→owner discard, token cease; survivor stat changes leave wounds/readiness unchanged. Include opponent-controlled differently owned units and exclude captive/undeployed leader summaries. No base damage or guessed aura result.
- **Invasion cost:** payment descriptor must name actual causing source and≤4 distinct current controlled unit entries. `paymentRole:'exploit'` defeat receipts form an exact prefix matching that set; ordinary actual sacrifices only in this primary. Refactor current event-pay block into one `paySourceOnce` operation: for all existing events invoke before ordinary outcomes as today; for Exploit process that declared cost prefix through the **existing defeat handler once**, verify expected current entry departures, then charge verified resource amount/remove source once before any resolution receipt. Keep source alive in hand through cost sacrifices and dispose it at actual resource-payment beat. Tagged prefix cannot be replayed in the ordinary loop. Cost helper validates explicit selected current entries/source/max4 before computing15−2N; application checks the staged ordinary successes before accepting that amount. Failed/replaced cost effects need separately supported actual resolution evidence, not a generic replacement solver; reject them in this narrow ordinary-cost path rather than guessing. Other events retain identical payment ordering, especially A08 Smuggle and alternate-discard payment.
- **Invasion resolution:** actual selected opponent's every controlled arena unit receives a distinct defeat receipt, no own survivor target. Preserve each actual owner/leader exhausted undeployed+epicspent destination and ordinary attachment owner; tokens cease. No draw/resource replacement/base damage/captive rescue without explicit evidence.
- **Reprocess:** seal selected own-discard unit refs in existing `cards` plus `chosenUnitGroup`; no invented incarnation for minimal discard references. Existing recovery-to-deck moves exactly that subset in supplied random bottom order; creation group's count equals original selected length, not successful movement count. Maximum4/none, unit type verified from JSON, source event/other discard excluded. Do not use `requiresRecover` or infer number from deck delta alone. Token unit receipts are new identities, never copies of recycled physical IDs.
- **Consolidation:** selection witness seals distinct current controlled entries/current powers before free play (including modifiers); count may0. Actual selected-hand printed unit cost must be≤sum. Explicit nested pay0, complete clean exhausted entering unit, no missing-aspect charge; common play from hand, normal actual entry effects only. Same chosen group on later defeat receipts; require they match original selected entries, preserve real owner/attachment destinations. Defeat chosen set even when no play receipt exists (declined/no target), so **no requiresPlay condition**. New arrival cannot become an original selected sacrifice. Primary W has no When Played trigger. Arbitrary replacement/trigger cleanup remains explicitly supplied rather than synthesized.

## Maintained tests and reuse

Read direct installed JSON/token JSON and reverse print map. Verify all ten exact names/identities/cost symbols and supporting stats. Positive/negative tests: old entry/phase; Equalize after-first-death count/friendly-controller boundary; conditional defense versus resting stats and actual later targeted combat; Sentinel/initiative; token create IDs/pose/type/cease/independent zero benefit; Exploit prefix actual controller/entry/max4/resource charge once before resolution/source disposal and unchanged old payments; discard-selected count/random-bottom conservation; chosen current power/free0/then-sacrifice despite decline. State must repeat without mutating before/cue; token physical creation/cessation are explicit conservation exceptions. New rich gates and generic suppression share predicates.

Reuse the existing payment, stat/keyword, owner movement, selected entry and actual combat recipes. Add generated token-unit assembly as a specific recipe candidate. Preserve independence versus count coupling and cost-before-play versus then-sacrifice ordering; same final units are not enough to select a recipe. Source-only author checks are not independent visual acceptance. Product source remains frozen pending root release.
