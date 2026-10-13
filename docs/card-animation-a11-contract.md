# A11 narrow contract proposal

GPT-6.1-sol / xhigh. [Exact clauses/fixtures/evidence](card-animation-a11-spec.md). Isolated implementation approved and saved under `results/card-effects-drafts/A11`; product installation awaits root release after frozen120 handoff. Root secondary: Bold/Daring/Grenade/Blood/Strategic. Main: Corner/Self/Unlimited/Grim/Crossfire. Preserve A10 typed phase grants/Restore/current traits and A09 payment ordering; no engine edits, scheduler or speculative causal inference.

## Reuse first

Exports A11_DEFINITIONS/ABILITIES/EXAMPLES/COSTS, a11ShowcaseState/PreviewSource/PreviewPayment/PreviewOutcomes existing shape. No boundary API needed. Registry exact internal ID **selfdestruct** and Daring aliases TWI170/SHD178. Source payments **[5,6,5,10,3,4,4,5,7,8]**, own16→**[11,10,11,6,13,12,12,11,9,8]**/16; all extra0. Two missing Aggression symbols on Unlimited; Source/owned costs paid once before ordinary effects.

Self reuses exact `requiresDefeat` on ability damage4 after actual friendly entry defeat; owner/leader/token disposition already explicit. No paymentRole/Exploit prefix, no new success enum. Daring/Strategic normal damage/draw; draw fromZone deck/actual top cards. All stat receipts exact current incarnation/sourceCard event/duration phase; all direct event hits sourceCard event. Real defeats owner destinations after actual damage window; tokens explicitly t1 cease and deployed leaders use actual full exhausted undeployed/epic-preserved summary. Do not guess raw owner or infer an ordinary discard from a missing leader arena entry.

## Proposed minimum new evidence

```ts
interface CardEffectOutcome {
  sharedTrait?: { id: string; trait: string; units: { id:string; incarnation:string }[] };
  // On each Bold +2/+0; one sealed0..3 group, shared current trait in EVERY selected unit.
  defenderDamageAtStart?: {
    defenderId: string; incarnation?: string; zone:'ground'|'space'|'base'; damage:number;
  }; // attack-only Corner buff; base damage MUST contribute0
  gritBasis?: {
    attackerId:string; incarnation:string; damage:number; powerIncludesGrit:boolean;
  }; // transient Grit keyword/modifier; native current power contribution cannot count twice
  powerWindow?: { id:string; members:{ id:string; incarnation:string; power:number; controller:Seat }[] };
  // Sealed simultaneous reciprocal source powers, with existing resolutionGroup.
}
// Existing keyword-name unions gain Grit; amount1 means one boolean grant, duration attack.
// No persistent attack-only keyword/status is stored on ending board.
```

The isolated draft implements these exact field names. Current UnitRef.traits supplies staged effective traits, directly JSON-verified plus any explicitly declared real trait modifiers; recorded absent remains unknown. Existing permanent/phase keyword status can represent known native Grit, with current Snapshot.p already including its own wounds; source JSON verifies Scout Bike Pursuer's printed1/4/Grit. No new UnitRef power field or broad keyword evaluator is required.

- **Shared trait:** before first Bold receipt seal distinct current id/entries≤3, actual chosen common trait across entire set (not pairwise union), any controllers/arenas. Repeat identical group on each assigned +2/+0; membership/amount/phase/source exact and each chosen once; none emits no buff. Singleton requires a real trait, not a made-up label. Group cannot change after an earlier assignment.
- **Corner start witness:** actual ready actor, target-unit current ID/entry/arena/damage captured at attack start, same attackId through transient +D/+0, attack/exhaust/forward/counter/defeats. Validate witness against declared attack target, not damage recipient guessed later. Base witness damage0 despite actual base damage6; no defending-unit incarnation on base. Subsequent hits cannot increase this bonus. Primary own W4/5/d0 attacks enemy W4/5/d2 at6, survives resting4/wound4, enemy owner discard. Source causing modifier is actual event; damage sources are actual attacker/defender. Generic ending cannot retain attack bonus or keyword.
- **Grit:** actual ready nonleader actor/current self wounds; transient Grit boolean grant (multiple Grit instances do not multiply damage contribution). Primary Marine resting3/wounds2/no existing Grit→combat5/base hit5/resting3. Native-Grit alternate Scout Bike current power3 already includes printed1+wounds2→combat3, contribution0. Require `powerIncludesGrit` match real current before keyword evidence/verified fixture stats, not guessed from title/power. Grit's contribution follows current wounds during attack; unusual pre-combat wound/Heal/trigger changes need separate declared actual power receipts. Primary/base attack has none; do not build a dynamic keyword engine. Retain existing damage/attackBonus maps or add only concrete scoped validation needed by these tests.
- **Simultaneous reciprocal powers:** Crossfire group exactly two distinct current enemy entries in one arena; seal current powers/controllers before either hit; same powerWindow and resolutionGroup on both reciprocal ability receipts, existing basis.kind source-power/sourceIds actual opposite source/value. No attackId/exhaust/ambiguous event source. Both hit before owner departures, even when first target would be lethal. Source remains the selected unit, not the playing event; controller attribution P2 does not become P1. Sealed window supports modified/Grit sources without recomputing after a prior simulated hit. Explicit successful departure and typed history, if supplied, must preserve actual source controller; do not synthesize missing defeat-history fields merely to demonstrate Bravado.
- **Unlimited/Grenade selection:** use existing resolutionGroup `{id,mode:'simultaneous'}` plus exact complete current cards and their incarnation; validate four distinct assigned4/3/2/1 across controllers/arenas, or first2 and optional different second1 in the first arena. All hit receipts precede HP-loss departures. First selected unit need not survive for optional same-arena second. Add a shared selection witness only if concrete tests expose a gap; a general target-selection/trigger engine is unnecessary.
- **All-ground damage:** complete current ground set from both players, including leader/token/stolen ownership; exclude every space/base/parent captive. Each exact damage2 event receipt, same group, then explicit actual card/leader/token cleanup. Primary six hits and three departures are enough to prove scope. Root side signature must show wound increases before departures and leave unchanged space occupants visible.

## Evidence predicates and maintained tests

Author factories enforce actual ready/friendly/nonleader restrictions, complete selected sets/common trait and exact successful dependency; common resolver applies declared facts/guards without interpreting titles. Rich render/suppress share one predicate verifying canonical source, independently computed costs, explicit source metadata/current entries, legal relations/amounts/ordering and completed ending. Test coherent false payment/source/ending together; simultaneous windows must not silently accept sequential removal/source collapse.

Persistent tests read direct installed JSON/token JSON/reverse aliases. Test full primaries/idempotence/input immutability/source once/owners/resources/decks; Corner target start versus base0/current damage; Grit transient/native nonstack/resting power; Bold total intersection and0/1/2/3/max/trait unknown; actual successful Self defeat and failed/owner/leader/token variants; distinct simultaneous4/3/2/1; optional same-arena Grenade and dead-first eligibility; ground coverage across owners/leader/token, no space hits; actual3draw/short-deck boundary; reciprocal source-power/controller/no combat/no false Bravado attribution. Preserve all prior source tests and recorded unknowns.

Two existing actions are availability only. Grenade recorded Bossk leader→P1leader area and Marchion wound+1 plus separate later deck-choice prompts; Self recorded Hemlock leader→P1leader area and own Punishing One→P1discard. Raw owner/incarnation/damage chronology/trigger cause unknown. Root owns conservative outcomes and matching production replays; no new games or fabricated native trigger receipts. No additional UI stages/pending/delay machinery required.

## Isolated author boundary

All ten primary recipes have explicit before/outcomes/after receipts. Selected alternate shapes require additional actual facts when a Shield absorbs damage or a surviving native-Grit unit changes resting power after wounds; the factory rejects those incomplete recipes rather than retaining an illegal final stat. The native-Grit base-attack and lethal Crossfire-source alternates are supported. Unobserved pre-combat Grit wound changes also require separate actual-power receipts. None of these conservative staged limits changes recorded final snapshots or printed clauses.
