# A12 narrow contract proposal

GPT-6.1-sol / xhigh. [Verified identities, clauses, legal recipes and recordings](card-animation-a12-spec.md). Docs only; A12 implementation awaits root approval. Preserve root's A10 retained-grant wrapper fix and installed A11 witnesses. Suggested renderer split: main Guerilla/Planetary/Unnatural/Aid/Impropriety; secondary Wartime/Doorstep/Clear/Creative/In Pursuit. No new AbilityKind, general scheduler, pilot engine or combat excess inference.

## APIs and payment contract

`A12_DEFINITIONS/ABILITIES/EXAMPLES/COSTS`; `a12ShowcaseState`, `a12PreviewSource`, `a12PreviewPayment`, `a12PreviewOutcomes` with the existing signatures. Payment/outcome choices must share the exact Exploit selection. `a12LaterActionOutcomes(definition, immediate, seat)` returns the one authored Aid upgrade-play recipe, undefined otherwise. Existing `resolveStagedRegroup` can resolve Unnatural/Impropriety supplied pending facts; root adds their stage IDs and retains the actual original event reference on their boundary cues. No new boundary executor is needed for these ordinary-unit primaries.

Sole prints TWI_177/178/188/189/190/199/200/201/204/221. Source costs **[10,8,5,7,8,4,4,7,8,2]**, Unnatural immediate extra4; Aid later1 is not a primary extra. Own ready20 → **[9,12,15,9,12,16,16,13,12,18]**; Guerilla total20→19 and enemy total12→11/ready9 stays. Other totals unchanged. Planetary no/one/two/three Exploit sacrifices cost14/12/10/8. No event cost duplicated inside receipts or boundaries.

## Proposed exact optional fields

```ts
// data/types.ts: current explicit staged facts; unknown recorded fields remain absent.
interface UnitRef {
  printedTitle?: string;   // JSON title, excluding subtitle; n remains display name
  unique?: boolean;       // actual known unique symbol
  leaderUnit?: boolean;   // current unit classification, including a known piloted leader
}
// Existing defeat history lastKnownType adds token-unit and token-upgrade.
// Legacy ambiguous 'token' remains unknown rather than becoming a counted unit.
interface PhaseDiscardPlayPermission {
  id:string; sourceId:string; cardId:string; player:Seat;
  round:number; phase:string; fromZone:'discard'; discount:2;
  cardType:'event'|'upgrade'; aspects:string[];
}
interface Snapshot {
  discardPlayPermissions?: PhaseDiscardPlayPermission[];
}
interface CardEffectOutcome {
  unitDefeatCount?: {round:number; phase:string; units:{id:string; incarnation:string}[]};
  defeatedEntry?: {id:string; incarnation:string}; // historical arena entry, not new played entry
  sameNameGroup?: {
    id:string; selectedId:string; selectedIncarnation:string;
    title:string; selectedPrintedCost:number; members:{id:string; incarnation:string}[];
  };
  requiresExhaust?: {id:string; incarnation:string};
  phasePlayPermission?: PhaseDiscardPlayPermission; // grant on kind cost, amount -2, duration phase
  phasePermissionId?: string; // actual nested cost/pay/play consuming an existing permission
}
// Existing keyword-name unions add boolean Overwhelm, amount1, phase duration.
// Existing created-entry handler accepts explicit entersReady:true with x absent,
// or false with x1; missing readiness never becomes ready.
```

No data→effects import is needed: permission aspects are explicit source facts tested against JSON. Three unit metadata fields are optional; neither normalized display names nor current leader summary ID is sufficient to infer arbitrary printed titles, uniqueness or piloted-leader classification. Raw bot/view.js already records n=title, but staged n often includes subtitle; never split a guessed delimiter to establish a rules match.

## Narrow reducer/evidence seams

- **Resource defeat:** use existing defeat with fromSeat/fromZone:'resources', actual card/chooserSeat, ownerSeat, destination discard. Validate current exact resource ID/readiness after event payment, remove once via existing resource removal and preserve owner. Ready loss differs from spent loss. Do not enter unit defeatedIncarnations/history, roll back arena stats, move through hand or run When Defeated unit effects. Guerilla's selected resource is not an Exploit cost.
- **Planetary:** reuse Exploit prefix (successful selected cost departures → discount → one event payment), then per selected entry ready/buff+1/+0/keywordOverwhelm phase. Factory/proof seals distinct0..3 surviving targets, actual current entries and source, permitting enemies/already-ready units. Overwhelm is boolean; no stacking/inflated resting power or immediate base hit. Actual excess-damage combat is outside this primary and needs separate concrete future evidence.
- **Wartime:** unitDefeatCount on search checks complete current-phase typed unit/leader/token-unit defeat entries, unique `(physical ID, incarnation)` pairs, not unique physical IDs. Upgrade/resource/ambiguous token entries are not silently counted. Actual looked length=min(history count, deck length). Existing private top-search-bottom operation + separate actual draw handles0/1 selection and complete remaining permutation. Known zero history can emit a zero-look receipt with no draw; absence of history is unknown. Document the engine watcher mixed-upgrade count discrepancy; no engine patch.
- **Unnatural:** cost/play carry defeatedEntry plus existing defeatPhase; require actual own discard card, current round/phase unit history and matching mostRecentIncarnations. Do not use requiresDefeat (that tracks successful removals inside this cue). New full unit has a different entry, clean4/5/wound0/readiness, exact4 payment after event7. Existing pending defeat/entry guard handles separately selected regroup; left-play obligations disappear, never resurrect another entry. Normal printed/aspect cost minus2/floor0, not free play.
- **Clear:** repeat one sealed sameNameGroup on actual return receipts; validate selected current nonleader/printedCost≤3 and exact complete selected-plus-enemy-title set before first return. Only selected target has cost limit. Other friendly matches excluded; no duplicate enemy-selected subject. Known title/classification must be current/JSON-verified. Owners, ordinary attachments, token cessation and complete eventual hand destinations reuse prior routes. Unsupported captive/pilot cleanup requires actual facts, not inferred defeat or resurrection.
- **Creative / In Pursuit:** common exhaustion success map records only an actual ready→exhausted change of a specific current entry by the actual causing event, with current controller. Enemy requiresExhaust must match that friendly success/cause; prevented/absent/already-exhausted attempts cannot authorize it. Exhaustion receipts with explicit incarnation must match current entry. Creative creation has no dependency: ordinary independent exhausted Clone creation remains valid when exhaustion makes no change or has no legal target.
- **Doorstep:** three direct fresh ready-created Droids, no hand/deck/play/payment/When Played and no fake exhausted waypoint. Preserve exhausted normal creation and all prior token tests; rich proof binds actual canonical source to its required pose, not merely a self-consistent result.
- **Aid:** after actual selected deck discards, cost/-2/phase receipts grant exact per-card permissions. Require same-cue successful selected deck→own discard movement, known Heroism non-unit printed facts, actual event source and current round/phase. A permission does not pay resources or play a card. Existing top10 private search uses complete order; separate two discards reduce deck exactly twice and make only those faces public at their discard beat. Later Jedi cost3−2=1/pay1/playAs upgrade from own discard carries phasePermissionId; verify known permission/current phase/actual source card/payer/host before consumption, preserve +3/+3 and wounds. Any leave-discard movement invalidates that permission; returning the event to discard cannot replay it again. Separate later search/discard can grant a new ID. No source Aid repay. Initial selected0/1/2 copies each get their own visible phase permission; no successful discard means no grant.
- **Impropriety:** extend existing atomic two-control preflight to matching duration regroup with two actual owner-return pending descriptors. Ready nonleaders on opposite controllers, distinct entries; no same-arena requirement. Preserve owners/pose/stats/ordinary attachments; token-upgrade ownership/control follows the host. Pending returnController is owner, not initial controller. At explicit regroup, only continuing selected entries return; already-owned entries need pending/status cleanup but no fictitious flight. Departed/re-entered subjects cannot return. Initially piloted leaders are excluded; a later leader replacement requires explicit actual defeat/leader cleanup and is not synthesized by this ordinary-unit recipe.

## Root presentation and verification responsibilities

Persist +1/+0/Overwhelm on actual ending cards; persist Aid's two card-specific phase play/discount permissions in ordinary board/discard context. Permission availability is distinct from an automatic delayed consequence. Reuse measured source resources, owner hands, discard/upgrade origins and actual fresh token slots. Original source flights/costs only on the primary action; boundaries preserve canonical prior cause and show no new source payment.

Tests read installed JSON/reverse map directly: all ten identities/costs, real top10 choices and Bo-Katan's high-cost same-title subtitle variant. Full primaries/replay nonce/input immutability/physical resources/owners/decks; all0..3 Exploit choices; native keyword nonstack; repeated typed unit defeats versus upgrades; stale resurrection entries; independent versus success-dependent exhaustion; ready versus exhausted creation; exact title set and token/owner cleanup; phase permission eligibility/source/one-use/expiry/movement and real upgrade host/stat/payment. Probe coherent wrong canonical cause/payment/IDs/ending, explicit prevention and false permission/history, retaining generic recorded movements when rich proof fails. Existing three recordings cover only actual poses/owner-hand movement/no-effect disposal, not hidden typed prerequisites or the rich staged story.
