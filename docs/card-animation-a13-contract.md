# A13 narrow contract proposal

GPT-6.1-sol / xhigh; read-only design awaiting root approval. [Exact sources, complete clauses and legal endings](card-animation-a13-spec.md). Preserve source140/A12, root's retained-grant wrapper guard and all accepted scenes. No new AbilityKind, stage, scheduler, random engine or historical trigger inference. Suggested main: Unmask/Breaking/Now There Are Two/Prisoner/Order66; secondary: Political/Droid/Merciless/Heroes/Sword.

## API and payment

`A13_DEFINITIONS/ABILITIES/EXAMPLES/COSTS`; `a13ShowcaseState`, `a13PreviewSource`, `a13PreviewPayment`, `a13PreviewOutcomes` with existing signatures; unsupported definitions undefined. Choices should expose explicit Political mode/actual random outcome card, own/opponent discard IDs, attacker/defender IDs, hand-play ID(null decline), captor/target IDs, per-player sacrifice IDs and Republic/Separatist role IDs(null decline). No boundary API is necessary: all ten primaries finish now or retain ordinary phase grants. Do not invent a later attack merely to demonstrate Raid/Saboteur.

Exact sole prints TWI_222/223/224/225/227/237/238/239/249/250; normal costs **[3,3,4,5,6,4,5,6,2,2]**. Now extra1 for Mercenary Company, all others0. Common ready20 → **[17,17,16,14,14,16,15,14,18,18]**, total20 unchanged; P2 resources unchanged. Every event source routes once hand→discard, nested play cost is separate, no hidden replacement/resourcing/draw. Metadata source JSON and concrete provider aspect multiset govern rich predicates independently of internally consistent ending totals.

## Proposed optional fields

```ts
// effects/types.ts only; no data -> effects dependency.
interface CardEffectOutcome {
  requiresDiscard?: { id:string; seat:Seat }; // prior successful own-hand discard, no fake entry ID
  singleUnitPlay?: { player:Seat; unitId:string; incarnation:string; sharedTrait:string; printedCost:number; aspects:PreviewAspect[] };
  captureSelection?: {
    id:string; sourceId:string;
    captor:{ id:string; incarnation:string; printedCost:number };
    target:{ id:string; incarnation:string; printedCost:number };
  };
  damageDefeatOrigin?: {
    sourceId:string; subjectId:string; incarnation:string; controller:Seat; amount:number;
  };
  traitGrant?: {
    id:string; trait:'republic'|'separatist'|'trooper'|'jedi';
    scope:'up-to-one-any'|'all-friendly'; members:{id:string; incarnation:string}[];
  };
}
// Existing choice union adds:
type OpponentRandomDiscard = {
  kind:'opponent-random-discard'; chooserSeat:Seat; handSeat:Seat;
  decision:'discard'|'decline'; result:'discarded'|'not-discarded'; selectedId?:string;
};
```

Existing `cards/card/fromSeat/fromZone/visibility/chooserSeat/sequenceId/sequenceIndex` express private opponent-hand inspection and its selected discard; no new hand container or public reveal type. Existing `requiresDefeat` accompanies Order66's damage cause. Existing keyword union already contains all required names. `singleUnitPlay` is repeated on nested cost/pay/play; `captureSelection` on capture and its conditional creations; `traitGrant` on each role's buff/keyword receipts. Their actual printed/current facts are verified in factories/tests/rich predicates, not inferred into recordings.

## Narrow reducer seams

- **Political mode/randomness:** explicit choice on relevant discard/create receipts names P2 as mode chooser and P2's hand, while creation beneficiary remains P1. Decline cannot carry a successful-discard result; discard branch requires one actual random-card hand departure with matching selectedId. A random outcome is a supplied fact, not a player card choice or seeded RNG simulation. Empty hand or an explicit prevented/no-change discard can yield not-discarded and two Droids; do not require decision decline for that result. Successful discard yields no creation. Rich predicates independently check exactly two/zero bodies and contradictory attempts. Unsupported prevention/replacement facts remain generic rather than inventing the branch.
- **Unmask successful discard/private hand:** local successful-hand-discard map is filled only by an actual present card leaving own hand under the same event source, excluding the paid source. `requiresDiscard` on inspection/opponent discard must match its exact ID/player/cause. Inspection uses `kind:'inspect',seat:opponent,fromSeat:opponent,fromZone:'hand',zone:'hand',visibility:'private',chooserSeat:eventSeat,cards:completeActualHand,card:selected,sequenceId,sequenceIndex:1`; changes no counts/order. Validate exact unique membership/faces/owners and selected membership. Following chosen discard uses the same sequence/index2, actual selected card and event-player chooser, from opponent hand to actual owner discard. Prevented/no-change own discard grants no inspection; absent/stale inspection cannot authorize the second discard. Known empty opponent hand emits no selected discard. Keep the selected face private until actual public discard arrival; raw known refs alone are not an inspection receipt.
- **Exactly one/discounted hand play:** `singleUnitPlay` seals the one living controlled arena entry across both lanes and one actual shared current trait with the selected own-hand non-Vehicle unit. Cost−5/pay actual/play clean complete unit share this witness and cause. Use existing `previewGivenCost` for printed cost+missing aspects−5/floor0; pay receipt exact physical resource IDs. No source event repayment. Normal entry exhausted, native keywords remain; optional Ambush declined in primary, with no attack or When Played inference. Zero/two own units, false trait/Vehicle/owner/payment/source do not fall back to normal eligible play. A declined/no-target event still pays its source and creates no unit.
- **Prisoner selection/cost comparison:** add `captureSelection` as a fourth mutually exclusive concrete capture witness alongside old captureCost/base-attack/same-arena; preserve old captureCost's ≤ semantics. This new witness permits **any printed-cost relationship**, verifies current friendly captor/opposing known nonleader non-Vehicle target/entries and exact cause, and seals both selected printed costs before movement. Existing generic pocket/owner/attachment/token cleanup remains authoritative. It does not mean successful capture licenses the bonus. On each conditional Droid creation, match that exact sealed selection/cause, require strict targetCost<captorCost and current captor controller beneficiary; equal/greater creates none. A prevented capture may coexist with valid lower-cost creation because the text has no if-you-do and the class's second sequential conditional is separate. Do not introduce requiresCapture. Unsupported departed/captured captor or nested capture replacements require explicit resulting facts, not speculative LKI/scheduling.
- **Order66 causal clones:** keep the actual full Jedi damage group, all six hits before departures. For each create, `requiresDefeat` plus `damageDefeatOrigin` must match an actual prior same-cue source ability hit of the exact current entry, actual successful lethal removal and controller **at defeat**, with that entry creating once. Source/amount/controller/prevention are not guesses from discard membership or owner. Source proof checks canonical six/Jedi/complete set and actual Shield absorption before rich support. Surviving or protected targets, unrelated defeat, source change, owner substitution and duplicate Clone cannot satisfy the witness. Existing leader-area/token/ordinary owner destinations apply; Clone entry remains exhausted. Native death-trigger/aura changes require separately declared receipts.
- **Phase traits/keywords:** `traitGrant` seals before/current role membership. `up-to-one-any` has0..1 matching entry, any controller; `all-friendly` is the exact complete matching event-player set across both arenas. Different roles may include the same real dual-trait entry: apply both role effects, never a global deduplication. One+2/+2 per selected Heroes role, no wounds/readiness/owner changes. Permit Saboteur phase as a boolean current-entry/round/phase-bound retained status while preserving existing transient attack Saboteur. Sword Raid1 remains a phase keyword with unchanged resting p; Sentinel sets sn1 and retains a **Sentinel** label without numeric1. Preserve native Sentinel and independent Raid sums; expiry comes from actual later snapshots/reset, no general phase executor. Unknown traits give conservative fallback, not a guessed complete target set.

## Focused verification and presentation

Read source JSON directly for ten identities/aliases/aspects, Mercenary6/5/5, Cruiser6/7, Vernestra3/4, Padawan1/3 with its actual Force prerequisite absent, Clone Dive2/1, Super Droid4/3 and actual keyword bodies. All before/after conservation and full exact primary endings; nonce/input immutability; coherent false source/payment/ending and prevented-outcome gates. New behavior tests cover successful-discard versus paid source, full private hand/chooser/random mode, exactly-one across both arenas, normal/floor/nested cost, capture equal/greater/lower and no fake success dependency, Order controller/actual damage/duplicate/no-Jedi/leader, full trait sets/role cardinality/native keyword/resting stats. Actual legally dual-trait fixture requires a real modifying source; preserve complete rules but do not fabricate one for a test.

Root owns integration, observed outcomes/tests, replay checker and builds. Main/secondary use identical predicates to suppress generic receipts, and unsupported branches retain conservative concrete movement. Measure private hand fan and real owner discard route, cross-arena pocket and separate new-token final slots; keep surviving attack stats clear. Inspect retained phase keywords inside actual ending card bounds at both sizes. Six existing records prove only their observed changes/prompts; six identities absent. Read-only engine tests inform source semantics and are not new acceptance runs.
