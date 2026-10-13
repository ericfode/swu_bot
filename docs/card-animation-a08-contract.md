# A08 narrow contract proposal

GPT-6.1-sol / xhigh, 2026-10-11. Supplements [verified A08 rules and fixtures](card-animation-a08-spec.md). **Proposal only; no A08 product edits.** Root may authorize an isolated draft after reviewing these exact shapes; product writes still require the later frozen90 build/replay/reviewer-source release. Retain existing AbilityKinds and stages; no new scheduler, sound design, terminal state or pending machinery.

## Exact added fields

```ts
// previewCosts.ts: ordinary metadata stays the hand/standard printed cost.
interface PreviewCardCost {
  printed: number; aspects: readonly PreviewAspect[];
  smuggle?: { printed: number; aspects: readonly PreviewAspect[] };
}
// Extend ONLY the existing kind:'resources' PreviewPlayPayment member.
{
  kind: 'resources'; cardIds?: string[];
  smuggle?: {
    sourceId: string;
    // Complete exact permutation/flags AFTER cost payment and engine exhaust-state
    // rearrangement, BEFORE removal of the now-exhausted source resource.
    resourcesAfterPayment: ResourceRef[];
  };
}
interface CardEffectOutcome {
  fromZone?: /* existing origin zones */ | 'capture';
  captureCost?: { captorPrintedCost: number; targetPrintedCost: number };
  upgradePlayPermission?: {
    sourceId: string; player: Seat; ignoreAspectPenalties: true;
    defeated: { id: string; incarnation: string };
  };
  // Extend existing basis.kind with 'defeated-power'; value/sourceIds unchanged.
}
```

`zone` remains ordinary destinations; `'capture'` is an origin distinction only. Existing pocket entries keep their real enclosing arena plus `captive:true`, so no captured card becomes an active arena unit. Existing `captureBasis` is the distinct RuleRespect base-attack witness; it is not renamed or weakened. Existing `defeatPhase`, `requiresDefeat`, `sourceCard`, `ownerSeat`, `controllerSeat`, `incarnation`, `upgrade`, `targetCard`, `printedCost`, `visibility`, `cards` and resource `entersReady` retain their meanings.

No new Shield field is necessary for the Toro primary: actual `card/sourceCard` Toro, current `incarnation`, stable declared Shield token and source-verified Toro print establish that chosen Bounty Hunter case. A rich signature must validate the actual known print/trait together. It may not make Shield dependent on capture or claim an unknown gained trait from a title alone.

## APIs and root integration

Data module exports `A08_DEFINITIONS`, `A08_ABILITIES`, `A08_EXAMPLES`, `A08_COSTS`, `a08ShowcaseState(definition):Snapshot|undefined`, `a08PreviewOutcomes(definition,state,seat,choices?):CardEffectOutcome[]|undefined`, `a08PreviewPayment(definition,state,seat,choices?):PreviewPlayPayment|undefined`, and **`a08PreviewSource(definition,state,seat):CardRef|undefined`**. The last returns the actual stable source from hand or resources for these deliberately staged fixtures; it never creates a fallback source or interprets a recording. No A08 boundary API is needed.

Root owns catalogue/showcase/preview registrations, baseline payment expectations, replay outcomes/tests, all builds and observed verification. In `previewCue`, obtain the A08 actual source before constructing `cue.source`; pass its payment descriptor to `previewPlayCost` and `resolvePreviewState`. Existing non-A08 source lookup/payment remain unchanged. Register **SOR_220→surprise-strike** and **SOR_251→confiscate** as well as SHD canonical prints. Author owns shared data/types/effects/types/previewState/abilities/previewCosts and focused A08 tests once released; renderer ownership stays root-assigned.

Root primary event payments in queue order are **[4,5,8,3,5,3,2,1,2,6]**. Smuggler primary begins11/12 ready and uses Smuggle3 (ordinary printed metadata remains hand1); FineAddition pays separate nested2, so its total is4. `previewExtraPayment('a-fine-addition')=2`; Smuggle's event3 is not an extra pay beat. Normal-hand Smuggler variant is1. P1 primary ending ready/total: **[8/12,7/12,4/12,9/12,7/12,8/12,10/12,11/12,8/12,6/12]**. Deck count−1 only for NoBargain and Smuggle; ThisWay−2; all other primary decks unchanged. Source goes once to own discard, including resource-origin Smuggle. Smuggle resources total stays12, not13 or11 when replacement exists.

## Receipt sequences and guarded application

- **Surprise:** attack-only +3/+0 buff, ready M's attack/exhaust, forward6, counter3, both owner-discard defeats; same attackID/entries/order evidence throughout. Current primitives suffice. Do not discard the counterstroke because T already left before its rendered receipt; combat is simultaneous. No persistent bonus/status.
- **Pursuit:** capture receipt targets actual T/entry, `sourceCard=Toro`, `seat=P1`, `fromSeat=P2/fromZone=ground`, `ownerSeat=P2`, `captureCost:{captorPrintedCost:3,targetPrintedCost:3}`; then independently shield Toro with declared token. Common capture validation checks one supported concrete witness: either existing matching base-attack history, or printed-cost comparison, never both contradictory branches. Preserve friendly current captor/enemy non-leader/owner/entry checks; compare finite nonnegative printed costs and≤, unrelated to upgraded power/HP. Primary removes Academy to P1 discard, strips T's active state into owner-preserving pocket ref, and preserves Toro's wounds/exhaustion. Alternative non-Hunter produces capture only. For the no-legal-capture Toro branch, move T/F into P2 hand so only ineligible cost4 W remains; emit Shield only. Capture and Shield stay independent even if a separately supplied actual capture is prevented.
- **Evacuate:** six actual non-leader return receipts, destination owner hand, same shared simultaneous group/selection-all evidence, excluding actual deployed Vader. Existing ordinary return cleans Academy once. No new return/rescue machinery for the primary; retain explicit rejection of captor return without separately declared release cleanup. A future cleanup extension is outside this proposal.
- **Deal:** one `discard`, `card=captive`, `sourceCard=X`, `fromSeat=P1/fromZone:'capture'`, `seat=P2/zone:'discard'`, `ownerSeat=P2`. Resolve exact current guard and pocket identity, require guard controlled by event controller and destination matching known captive owner. Remove only that pocket ref, retain `cap:[]`, add minimal card to owner discard once; never detach X/upgrades, seal unit defeat, collect Bounty, rescue or play. An absent/ambiguous/mismatched pocket must reject this explicit staged receipt.
- **NoBargain:** exact P2-selected hand discard with `chooserSeat:P2`, then actual P1 draw1, same `resolutionGroup:{id,mode:'simultaneous'}`. Empty P2 hand emits draw only. The draw has no successful-discard prerequisite; no random choice or P1 hand inspection is declared.
- **Aid:** `A08_COSTS['smugglers-aid']={printed:1,aspects:['heroism'],smuggle:{printed:3,aspects:['heroism']}}`. Primary payment selects exact ready IDs0..2, `smuggle.sourceId` equals actual resource event ID, and full `resourcesAfterPayment` contains the same12 stable resources/faces/owners in one valid order, exactly4 exhausted including the source. Validate original resource membership/source print, explicit mode metadata, cost/aspects, payment affordability/IDs, complete permutation and exhausted count; apply declared rearrangement, then remove resource source to discard once. This alone makes total11/ready8. Output separate private `resource` receipt for actual known deck top Marine (`fromSeat:P1/fromZone:'deck'`, `seat:P1`, `ownerSeat:P1`, `entersReady:false`, `sourceCard=event`, `visibility:'private'`), then heal3 own base. Exact deck-top removal decreases deck27→26 and appending exhausted resource restores total12 without changing ready8; update lookup to its new zone. No hand waypoint/public reveal/arena entry. Source and replacement are different physical IDs. Empty deck emits no replacement, ending8/11. Normal-hand play has no Smuggle descriptor, no replacement, pays1 and keeps deck/resources totals unchanged. An explicit invalid Smuggle descriptor cannot silently fall back to normal hand play.
- **ThisWay:** private top8 exact permutation, selected/revealed IDs1+3, selectionLimit2; separate draw2 with actual Sabine+Devotion consumes selected fronts once. No extra count mutation in search; nonselected six go bottom in a supplied valid random order, suffix untouched. Complete clauses retain zero/two-of-same-category branches without exposing unchosen faces or playing the selected cards.
- **Confiscate:** ordinary selected Academy defeat with `sourceCard=W`, actual ownerP1 and explicit+2/+2 rollback; original Shield stays attached, W survives4/5/damage1. Current primitives suffice. Token target ceases; a separate host defeat must be explicitly witnessed if HP loss causes it. Pilot/leader-upgrade cleanup requires its distinct owner destination, not default ordinary discard.
- **Addition:** historical enemy F witness is current round/phase unit-type/P2-controller; old entry still qualifies and `defeatedBy` is not required. `cost` selected Armor amount−2 names ignored missing Cunning penalty, `pay` selected source2/actual P1 resource IDs, then `play` `playAs:'upgrade'`, `fromSeat:P2/fromZone:'discard'`, destination own M, actual Armor ownerP2/controllerP1,+2/+2, no unit/readiness. Play has `defeatPhase` plus `upgradePlayPermission:{sourceId:event,player:P1,ignoreAspectPenalties:true,defeated:{id:F,incarnation:oldEntry}}`. Validate exact prior phase/type/controller witness and same causing event; permit origin seat distinct from playing/controller seat only with this explicit authority. Existing ordinary upgrade routes still require their playing controller and linked payment; true owner is never reassigned. Apply contributions/remove discard card once. Own hand/discard alternatives use the same authority. Normal selected cost2 remains payable; only nested aspect penalties are ignored, not event's own missing Villainy2 or additional restrictions. Printed-cost/trait metadata is verified against installed JSON in tests, not decoded from card titles.
- **Crackdown:** defeat exact W/entry with actual owner and no prevention, seal **current power7 before removing any attachments**, then damage P1 base7 with `requiresDefeat:{id:W,incarnation:entry1}` and `basis:{kind:'defeated-power',sourceIds:[W],value:7}`. Keep a primitive last-known-power map keyed by exact successful departed entry; require the same sealed value and successful-defeat witness for damage, actual own base, no combat. Existing draw requiresDefeat remains intact. Zero uses a present sealed0 value, not absence/default; failed/prevented/wrong-entry defeat creates no authorizing value. Prior real PowerFromPain in P2 discard/current phase status is part of before state, not replayed during this event.

## Evidence and acceptance boundaries

Validate installed JSON identity/aliases, printed costs/trait/upgrade contributions and resource totals before writing fixture declarations. Focused tests cover all ten physical conservation/source-disposal/pay-once outcomes; capture inequality versus stats, independent Shield/no-target/non-Hunter; six-unit owner returns/excluded leader; captive-only discard/empty pocket/no fake rescue; simultaneous chooser plus independent draw; both Smuggle modes, exact replacement/top/identity/readiness/permutation/private visibility/empty deck/ready-source rearrangement; top8 two public selections/counts; ordinary versus token defeat and surviving host; opponent-discard ownership/controller/payment/history with no own-defeater requirement; successful LKI seal before rollback and power0/failed defeat.

Use the same compound proof to render and suppress generic receipts. A source found only in resource count deltas does not identify Smuggle. Known printed source/top identity and actual source resource→discard/deck→resource route can support observed movement, but not unknown payment mode, hidden face, healing or rearrangement. Recorded Smuggler is hand1/no heal/deck unchanged; recorded Snoke Crackdown has actual own-base6 and enemy aura-stat restoration from its supplied ending, without fabricated conditional chronology, buff or Experience. Root owns those observed tests.

Preserve measured before resource/pocket/hand/attachment origins and actual after resource/hand/attachment/discard slots. Do not label every resource replacement publicly or change rack height at handoff. Multiple Evacuate arrivals and ThisWay's selected two must clear mobile caption through their natural routes. Toro's empty versus filled pocket and surviving guard stay separate from active-card markers. Source files are not accepted animations; independent90→100 pixels, completion and available replay checks remain later work.
