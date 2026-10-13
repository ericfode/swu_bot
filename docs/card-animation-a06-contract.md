# A06 narrow contract proposal

GPT-6.1-sol / xhigh, 2026-10-11. This approved proposal was prepared during the source70 hold and implemented after root explicitly released product writes following the reviewer's source70 snapshot. The [verified A06 specification](card-animation-a06-spec.md) supplies the ten identities, complete clauses and chosen legal snapshots. Matching engine event classes and control/rescue systems were rechecked read-only. Authoring and independent visual acceptance remain separate; the served production70 build stays frozen.

Keep the current data-module API (`A06_DEFINITIONS`, `A06_ABILITIES`, `A06_EXAMPLES`, `A06_COSTS`, `a06ShowcaseState`, `a06PreviewOutcomes`, `a06PreviewPayment`). Normal event payment stays separate from linked nested unit payment. These six additions express deliberately supplied facts; none advances a game or interprets card titles.

## Proposed exact extensions

```ts
// Add Ambush to the existing keyword name union. The amount is 1.
type KeywordName = 'Raid' | 'Saboteur' | 'Ambush';

interface NextActionConstraint {
  id: string; sourceId: string; subjectId: string; incarnation: string;
  controller: Seat; round: number; phase: string; targetUnitIfAble: true;
}
type ActionBoundaryWitness = {
  id: string; player: Seat; round: number; phase: string;
  action: 'attack-with-unit' | 'other' | 'phase-end';
  result: 'satisfied' | 'unable' | 'expired';
  attackerId?: string; incarnation?: string; attackId?: string; targetId?: string;
  // Only needed for an explicitly supplied non-attack boundary.
  unableReason?: 'exhausted' | 'departed';
};
interface Snapshot { nextActionConstraints?: NextActionConstraint[] }
interface UnitStatus {
  // Extend existing unions; old values remain valid.
  duration: /* existing */ | 'permanent' | 'next-action';
  restriction?: /* existing */ | 'must-attack';
  actionConstraintId?: string;
}
interface CardEffectOutcome {
  duration?: /* existing */ | 'permanent' | 'next-action';
  restriction?: /* existing */ | 'must-attack';
  attackOrigin?: { kind: 'ambush'; playedId: string; incarnation: string };
  controlExchange?: { id: string; memberIds: [string, string] };
  nextAction?: { operation: 'add'; constraint: NextActionConstraint }
    | { operation: 'consume'; constraintId: string; witness: ActionBoundaryWitness };
  captiveCleanup?: { id: string; captorId: string; incarnation: string; cards: CardRef[] };
  captiveCleanupId?: string;
  resolutionGroup?: { id: string; mode: 'simultaneous' };
  condition?: { kind: 'resources-more'; player: Seat; total: number; than: Seat; thanTotal: number };
  playerChoice?: { chooserSeat: Seat; selectedSeat: Seat };
  attackBonusBasis?: { kind: 'bounty-hunter' | 'damaged'; sourceId: string; incarnation: string; damage?: number };
  // Extend existing basis.kind, retaining its existing sourceIds/value fields.
  // 'hand-count': player + actual current hand IDs (including the zero-card case).
  // 'captured-count': current captor ID + countRule { zero:3, positive:6 }.
  basis?: /* existing */ | {
    kind: 'hand-count' | 'captured-count'; sourceIds: string[]; value: number;
    player?: Seat; countRule?: { zero: number; positive: number };
  };
}
// Root-owned explicit selector: extend existing cue/preview stage with 'next-action'.
```

## Meaning, validation and receipt order

1. **Timely: paid play → Ambush grant → chosen ready → attack.** Existing `pay` has selected unit in `sourceCard`, amount2 and exact resource IDs. Existing `play` carries the full exhausted X-Wing/new incarnation, `entryType:'played'`, `entersReady:false`. Add phase keyword Ambush1 only to that same entry. A chosen `ready` and `attack` each carry `attackOrigin` referring to this actual earlier play; do not apply `entersReady:true` or ready an unopposed space unit. Reuse identified simultaneous combat damage/defeat receipts. Declined Ambush leaves entry exhausted and the phase keyword present. A grant alone does not establish that the trigger was chosen. The unauthored Smuggle route is a complete rule clause, not a fabricated replacement scene.

2. **Choose Sides: two permanent control receipts, one atomic pair.** Both have the same `controlExchange`, `duration:'permanent'`, exact source seat/arena and destination seat/same arena, preserved `ownerSeat`, and existing `unit` containing the complete declared final unit/attachments. Prevalidate both actual non-leader entries, distinct IDs, opposite controllers and full pair before moving either. Do not append a regroup status or pending return. Preserve incarnation, stats, damage, pose, cap references and ordinary attachment owner/controller. Compare token attachment final owner/controller against the explicitly supplied new controller; the pinned engine changes token ownership, while unit ownership stays fixed. The rich signature uses the same pair gate; an incomplete recorded pair stays generic. A supplied later regroup snapshot keeps control; no scheduler is added.

3. **Anger: one immediate obligation, one independently selected action boundary.** Immediate ability damage1 is followed by `restrict`/`nextAction.add` only for the surviving current T entry. Store the exact constraint plus its linked visible unit status. `next-action` starts from the immediate ending with no event source/payment replay. Its ordinary T→D attack and simultaneous damage/defeats precede `restrict`/`nextAction.consume`; the explicit witness links the actual attack ID/target and original constraint. Require the same controller/round/phase, reject a different entry, and consume once. The fixture/installed-source tests establish the legal Sentinel target; no generic legality list is added. `other/unable` is implemented only for directly checkable exhausted/departed subjects. An actual phase-end witness expires the constraint. Attack-prevented/no-legal-target alternate boundaries are deferred. No automatic attack, passing of time, speculative controller action, or general phase scheduler. Root owns selector/stage integration.

4. **Detention: conditional damage → verified defeat with last-known pocket → rescue.** Damage uses `basis.captured-count`, the actual target pocket count and explicit countRule3/6. A successful captor `defeat` supplies `captiveCleanup` exactly matching its current ID/incarnation and every before-pocket card. Cache these minimal references before removing the host; ordinary attachments still follow existing disposal rules. Each following `rescue` names `captiveCleanupId`, that source captor/fromSeat/fromZone, and the existing full fresh rescued `unit`, explicit owner/arena/readiness and `entryType:'rescued'`. Require that the cleanup's actual preceding defeat succeeded, consume each captive exactly once, and require the complete release group by resolution end. Reject stale/duplicate/foreign/missing captive references, failed defeat and a fabricated play/When Played receipt. Existing present-captor rescue remains valid. Protected/surviving hosts retain their pockets and supply no cleanup. Capture/return departures outside this concrete defeat route remain future work; do not silently release their captives.

5. **Counts and choosers: visible evidence without zone invention.** Chaos pairs two ability-damage receipts with one simultaneous group and `basis.hand-count` from each actual resolution-time hand after source disposal. Zero allows an empty sourceIds array; hands stay unchanged and match conclusion is supplied truth. Cripple's draw and chosen opposing discard share a simultaneous group; the discard's `condition.resources-more` must match actual totals (not ready counts), use a strict comparison and retain `chooserSeat:opponent`. Pillage additionally records P1's `playerChoice` and P2's `chooserSeat`; discard IDs must be actual distinct hand members and the resolving event is already absent. Do not add random selection or a hidden deck search. Existing actual draw/deck consumption is unchanged.

6. **Attack prerequisites and ordering reuse the existing combat model.** Headhunting uses existing attackId/attackIndex, attack-only buffs and explicit exhaust/damage/defeat for each completed segment. Only the source-verified Hunter buff has `attackBonusBasis.bounty-hunter`; supporting print/trait is asserted against installed JSON in data tests. No boost receipt accompanies Marine/X-Wing. Desperate's attack-only buff uses `attackBonusBasis.damaged` with actual current damage1, matched ID/incarnation, then base attack5 with no counterdamage. The common reducer checks identity/current damage/bonus linkage; the data adapter/tests establish the verified trait and legal targets rather than introducing a trait/rules engine. Repeated attackers remain possible after an explicit intervening ready; no new distinct-ID rule. Resting power and completed status stay unchanged by attack-only bonuses.

## Focused evidence checks and geometry handoff

Test every primary complete after state and event/nested resource manifests, source disposal once and physical-card conservation. Add counterexamples for unpaid/missing Ambush play, declined/no-target trigger, half exchange/token ownership/ordinary attachment control, wrong Anger player/action/entry and double consumption, stale/prevented/incomplete captive cleanup, resource equality/ready-count confusion, self Pillage/source exclusion, zero Chaos hand and source off-by-one, undamaged Desperate and non-Hunter boost. Preserve prior70 tests and sparse replay unknowns.

Renderer needs measured hand→space paid entry plus ready/attack poses; both final exchanged arena slots; persistent next-action status and separate boundary caption; departed captor's **before** pocket origin and rescued **after** arena slot; current hands/counts and each own base counter. Root handles the next-action selector and replay integration. Rich rendering and generic suppression must share exact evidence predicates.

Existing recordings cover Timely no-play disposal, Chaos actual own/opponent base deltas, and Desperate actual exhausted attacker/base+8. They do not establish Ambush or temporary attack chronology. Keep those observed deltas and unknowns; source/schema completion is not independent visual acceptance. No engine edits or production build were performed by the data author.

The implemented boundary API is `a06NextActionOutcomes(definition, immediate, seat)`, returning undefined outside Give In to Your Anger and no new event payment. Rescue now checks a supplied most-recent entry and records the explicit fresh arrival. Permanent exchange preserves prior statuses and adds only its declared control status. Tests exercise actual final boards, mixed-owner release, Shield prevention, departed-pocket completeness, old-entry Anger rejection, and a repeated attacker after an explicit intervening ready. Root owns stage UI and production/replay integration.
