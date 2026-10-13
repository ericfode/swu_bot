# A10 narrow contract proposal

GPT-6.1-sol / xhigh. [Verified rules, legal fixtures and recorded availability](card-animation-a10-spec.md). Root approved isolated drafting and subsequently released hash-checked owned source installation after source110 snapshot. A10 data now frozen; renderer/integration/review remain separate. Root owns integration/observed outcomes/baseline costs/builds and five secondary signatures; main renderer owns Manufactured/Pyrrhic/Clone Wars/Captive/Kamino and relevant UI. No A10 product installation until explicit release.

## Proposed fields and meaning

```ts
// data/types.ts owns shared status types; never import effects into data.
interface GrantedDefeatAbilityBase {
  id: string; sourceId: string; subjectId: string; incarnation: string;
  round: number; phase: string;
}
type GrantedDefeatAbility = GrantedDefeatAbilityBase & (
  { effect: 'damage-enemy-unit'; amount: 2 } |
  { effect: 'create-clone'; amount: 1 }
);
interface UnitRef { traits?: string[]; } // optional explicit current staged facts, from verified JSON/modifiers
interface UnitStatus { grantedAbility?: GrantedDefeatAbility; }
// Keep existing buff status kind, phase duration. Grant branch precedes numeric stat parsing.
interface CardEffectOutcome {
  grantedAbility?: GrantedDefeatAbility; // existing buff, no resting stat/pose changes
  whenDefeatedOrigin?: {
    abilityId: string; sourceId: string; subjectId: string; incarnation: string;
    controller: Seat; round: number; phase: string;
  }; // concrete damage/create activation, with existing requiresDefeat exact id/entry
  restoreOrigin?: {
    attackerId: string; incarnation: string; attackId: string;
    round: number; phase: string; amount: number; // verified total Restore, distinct from capped actual heal receipt
  }; // heal controller base after declaration, before combat; never immediate event healing
  traitCondition?: {
    player: Seat; trait: 'official'; minimum: 3;
    units: { id: string; incarnation: string }[];
  }; // on Petition draw3; actual known qualifying current entries
  captureArena?: { captorId: string; incarnation: string; arena: 'ground'|'space' };
  // Existing tokenType expands to battle-droid | clone-trooper.
  // Existing keyword name expands to Restore (amount2 in these grants). UnitStatus.phase binds phase Restore alongside existing round/incarnation fields.
  // Existing basis kind expands arena-unit-count, with optional arena:ground|space.
}
```

These are explicit stage facts. Native snapshots without traits/owner/token type/grant provenance keep those unknown; neither recorder titles nor arrival counts populate them. Staged trait fields must be checked against installed JSON in author tests (plus any actual declared trait modifiers); avoid a new browser-side general rules engine. Current primary fixture has no trait-changing effects. Rich trait gates require actual verified fixture faces and coherent trait facts, not a count badge alone. If root prefers a small verified trait lookup over optional `UnitRef.traits`, preserve the same current-entry/count contract and report the choice before authoring.

`buff.grantedAbility` requires friendly current unit, exact subject ID/entry/source event/current phase and unique grant ID. Store phase buff status with that full typed descriptor; no p/h/d/x/sn mutation. Ordinary buff/stat behavior remains unchanged. Restore2 uses existing phase keyword status and changes no resting stat/readiness or base damage during ordinary play. Keep label **WHEN DEFEATED: ENEMY UNIT 2** / **WHEN DEFEATED: CREATE CLONE** distinct from keyword Restore2. No new AbilityKind or audio design is required.

Creation extends A09's verified token-type table with Clone2/2/ground/t1/fresh/exhausted, preserving all Battle Droid guards. Clone aspects are not paid. Allow exact source cause from an activated granted ability only after validating `whenDefeatedOrigin`; do not loosen the existing same-event create guard globally. A new replacement Clone has no old grant/status/incarnation. Current created-unit facts and native generic arrival remain different contracts.

## Primary APIs, source and payment

Export A10_DEFINITIONS/ABILITIES/EXAMPLES/COSTS; a10ShowcaseState, a10PreviewSource, a10PreviewPayment, a10PreviewOutcomes with existing `(definition,state,seat,choices?)` shape. Source returns actual own-hand event. Event cost metadata in order **[2,3,5,5,1,1,2,3,3,4]**; printed Manufactured/Pyrrhic3 include one missing second Command2. Clone Wars primary additionally pays **2** via existing pay receipt with exact resource IDs2/3; event payment IDs0/1. Its example pay beat amount2 makes `previewExtraPayment`2; all others0. Primary final P1 ready counts **[14,13,11,11,15,15,12,13,13,12]/16**, P2 stays7/10. Aliases root registers SHD128→Outflank, SOR124→TacticalAdvantage, SHD131→TakeCaptive.

No implicit alternative costs or unit payments. Created tokens source no hand/deck origin. Petition draw actual known top3 changes deck27→24/hand0→3 exactly once; raw private deck is never publicly searched/revealed. Capture cleans minimal owner-preserving ref into pocket, ordinary attachments to owners/token attachments cease, neither hand/play/defeat route nor Shield bonus.

Root secondary: Synchronized/Petition/Outflank/Tactical/Leadership. Main: Manufactured/Pyrrhic/CloneWars/Captive/Kamino. Primary examples in the spec follow that split.

## Concrete guards

- **Arena-count strike:** `basis.kind:'arena-unit-count'`, player=event controller, arena=actual enemy recipient arena, sourceIds=exact current controlled units in that arena, value=length=damage. Count entries including tokens/deployed leaders irrespective owners/readiness; exclude other arena/parent attachments/captives/undeployed summaries. Primary M/D→2 damage to W. Zero known value is valid. Wrong controller/arena/set/amount and friendly/base recipient reject.
- **Official threshold:** on draw3, exact distinct current controlled id/entry witnesses with current Official trait, count≥3, threshold3; actual top cards/known deck shift as today. Primary Mothma/Ackbar/Bail are directly JSON-verified. Fewer3 produces no draw receipt; do not infer past Officials or treat phase grant as a permanent trait. Count both arenas, not current owning player.
- **Current-set grants/stat sweep:** author snapshots enumerate actual friendly set/Republic subset before effect. One grant per qualifying current entry (all arenas). Later arrivals receive none. Clone replacement deliberately proves exclusion even though its trait is Republic. Grant IDs bind source and target entry; reset/new entry cannot retain old phase status. Duplicated same grant ID rejects; separately supported different grants may coexist. Phase expiry comes from actual later snapshots/reset, not a scheduler.
- **Granted defeat activation:** before actual successful removal, seal current entry's qualifying granted ability descriptors and **controller at defeat**, before owner/attachment cleanup. Existing exact `requiresDefeat` proves success; `whenDefeatedOrigin` matches that seal, source ID, grant ID, entry, round/phase. Damage2 requires current opposing unit recipient and `damageType:'ability'`; creation1 belongs to that last-known controller, exact fresh Clone type. SourceCard for activation is departed unit; event cue preserves grant cause separately. Return/capture/prevented defeat/wrong entry/phase/missing grant cannot authorize it. No target means no invented damage; no automatic trigger processing from a grant badge. This is applying supplied facts, not a trigger queue.
- **Restore activation:** actual ready unit declares identified legal attack; its explicit phase Restore status is present at that entry/current phase. Then heal that unit's **current controller base**, actual healing equals min(verified total Restore, existing base damage) in the ordinary supported path, before combat receipts. A09 attack map establishes attack source/target; old grant event is not repaid. Primary Phase I has no printed Restore, exact total2 and actual heal2. Other Restore sources stack per engine total; alternate examples must supply separately verified printed/granted contributions, not assume2 is the whole total. Wrong unit/phase/attack/base/negative or oversized healing rejects. Ending current unit may later be defeated; Restore already resolved on declaration.
- **Outflank:** reuse separate attackIds and existing sequenceId/index1/2; source units must be distinct physical IDs/current legal entries. Author and rich predicate validate first actual combat/exhaustion/HP-loss departures/explicit triggers before second attack. No automatic readying or trigger resolution. Source-tested one/no available attacker variants emit only actual attempts. Avoid adding a generic attack scheduler merely to validate the chosen two complete receipts.
- **Clone Wars:** explicit N additional payment, after event cost, then N own Clones followed by N opposing Droids, no opponent payment. Strict joint gate validates number/type/controller/count/payment budget and ordering, source disposal once, actual created IDs/readiness/after slots. N0 creates none. No split inferred from aggregate recorded ready delta alone. Manufactured mode likewise requires explicit2Clones or3Droids, never their mixture.
- **Same-arena capture:** `captureArena` is a third mutually exclusive permission, alongside existing captureCost and captureBasis (base attack). Require exactly one; retain old RuleRespect/Pursuit guards. Arena witness matches actual current friendly captor ID/entry and actual enemy nonleader target arena; no printed cost limit. Primary M cost2 captures Wcost4 in ground. False cost/history/arena metadata rejects. Preserve actual owner/attachment cleanup and exhausted captor/cap[] geometry. Explicit t1 unit target ceases on capture, never becomes a minimal pocket ref; no token guess from null print/title. Primary no nested captive/pilot; unsupported special cleanup requires separately supplied legal facts, not invented rescue.

## Explicit later-action APIs and snapshots

Propose `a10LaterActionOutcomes(definition, immediate, seat)` only for Pyrrhic/Kamino, undefined otherwise. Root can map this to existing selectable `next-action` stage with **Later action** label; no new timer, phase stage or event payment. A Snapshot does not track the alternating active player; document the actual intervening pass needed for Kamino's friendly attack. Cue retains original source event ref now in discard for provenance; resolver does not find it as a playable source. `playPayment` absent, new cue nonce only changes the clock.

Pyrrhic boundary actor P2 W attacks Sentinel D, simultaneous4/4, two owner defeats; actual D/P1 granted ability targets T for2, then T owner defeat. M/X statuses persist, both bases unchanged, event resource cost unchanged. Kamino boundary after P2 pass: actor P1 PhaseI attacks W; declare → Restore2 own base9→7 → actual3/4 combat → PhaseI owner defeat → one new Clone2/2 exhausted, no inherited status; W damage4 alive, ARC grants remain, Marine unchanged, resources unchanged. Each receipt uses exact attackId/entry/source/destination; separate controller from owner and original event seat. Never derive these actions from elapsed animation time.

## Tests and replay limits

Focused tests read direct installed JSON/reverse alias map/token JSON; no ignored inventory prerequisite. Validate real before/after state, trait/arena scope/count, repeated symbols/pay-once/extra2, modal token counts/identities/owners/default exhaustion/no play triggers; grant without immediate activation, current-set/future-arrival exclusion, wrong phase/entry/trigger/success/controller; Restore timing/base/cap/stack evidence; sequential distinct combat and counterdamage; capture third permission preserving prior modes; input immutability and repetition. Current A09 source286 + root6main gates292 remain passing; broad retesting only for these shared seams.

Existing four recordings prove aggregate payments and actual arrivals/poses plus raw selected mode/number. Raw units omit owner/token/entry/traits; current cue format does not preserve a create-resolution event. Keep generic actual after snapshots and unknowns unless root explicitly carries that recorded evidence. Do not promote title/nullprint/arrival-count inference to rich token creation, invent source cost splits, or claim native trigger coverage. Production replay checker and independent pixels/lifecycle remain separate acceptance.
