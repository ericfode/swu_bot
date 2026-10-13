# A14 narrow contract proposal

GPT-6.1-sol / xhigh. Read-only, awaiting root approval; no A14 product/isolated implementation yet. [Source clauses, exact identities and legal recipes](card-animation-a14-spec.md). Preserve frozen A13 and all source140 fixes. Main suggestion: Manufacturing/No Glory/Gate/Covering/Heat; secondary Drop/Pain/Clear/Direct/Airlock. No new AbilityKind, clock-triggered rules, general keyword engine or random/deck-order inference.

## API and payment

`A14_DEFINITIONS/ABILITIES/EXAMPLES/COSTS`; existing `a14ShowcaseState`, `a14PreviewSource`, `a14PreviewPayment`, `a14PreviewOutcomes`. Choices expose selected bottom IDs/order, unit/capture-control target, optional XP/Shield target(null decline), selected base. `a14LaterActionOutcomes(definition,immediate,seat)` supplies Gate's one authored ordinary P2 space attack; undefined otherwise. `a14PhaseEndOutcomes` supplies explicit Gate unused-protection expiry or Heat source-bound grant/loss cleanup, undefined otherwise. Root owns existing next-action/phase-end UI integration and retains the original source without payment/intro replay. Expiry is an expressly chosen boundary, never elapsed animation time.

Sole prints TWI251/257/JTL042/043/055/074/076/077/078/079. Payments **[4,2,5,7,2,1,2,2,4,5]**, extra0. Own ready20→**[16,18,15,13,18,19,18,18,16,15]**, totals20; P2 resource flags unchanged. Gate Later consumes no resources, base9 remains9, actual enemy TIE exhausts. Phase-end consumes no payment, draw or readiness. Full source JSON/provider multiset and actual source identity remain independent rich-proof authorities.

## Proposed minimum types

```ts
// data/types.ts; finite source-owned staged facts, not a trigger queue.
interface BaseDamageProtection {
  id:string; sourceId:string; baseId:string; seat:Seat;
  round:number; phase:string; uses:1;
}
interface BaseRef { damageProtection?:BaseDamageProtection[] }
interface KeywordWindowMark {
  id:string; sourceId:string; subjectId:string; incarnation:string;
  round:number; phase:string; nativeSentinel:boolean;
}
interface UnitStatus {
  lostKeyword?:'Saboteur';
  keywordWindow?:KeywordWindowMark;
}
// effects/types.ts; current optional outcome fields.
interface CardEffectOutcome {
  handBottom?: {
    id:string; player:Seat; drawnIds:string[]; tokenUnitIdsAtResolution:[];
    selectedIds:string[]; order:string[];
  };
  woundBoost?:{subjectId:string; incarnation:string; wounds:number};
  spaceClearance?: {
    id:string; defeatedId:string; incarnation:string; opponent:Seat;
    remainingIdsAtDefeat:[];
  };
  baseProtection?:
    | {operation:'grant'; effect:BaseDamageProtection}
    | {operation:'consume'; effectId:string; sourceId:string;
       incoming:number; prevented:number; channel:'direct'|'indirect'}
    | {operation:'expire'; effectId:string; sourceId:string};
  keywordOperation?:'gain'|'lose'|'expire'; // omission preserves legacy gain
  keywordWindow?: {
    id:string; sourceId:string; round:number; phase:string;
    members:{id:string; incarnation:string; nativeSentinel:boolean}[];
  };
  // Existing tokenType union adds 'x-wing'.
}
```

Use existing sequenceId/sequenceIndex and full `unit` for No Glory's intermediate control and same-entry defeat, with actual owner preserved. Existing buff+requiresDefeat, Shield cards, damage/attack/exhaust and owner/leader/token cleanup remain reusable. Generalize Return grammar to exact hand→owner-deck-bottom movement and Keyword grammar to declared gain/loss/expiry; do not label a loss as an ability-wide blanking or a base protection as a Shield token.

## Narrow behavior seams

- **Manufacturing actual hand→bottom:** draw2 actual cards first with separate deck consumption. `return`, fromZone hand/fromSeat player, zone deck/destination deck-bottom then moves each selected current hand card to owner's complete known deck. No arena stats/attachments/defeat cleanup, recovery-from-discard or search permutation. handBottom repeats a sealed two-card selection/chosen order, actual same-source drawnIds, and known zero controlled arena token units at resolution. Inspect both arenas; token upgrades/captives/enemy units do not count. Preserve untouched deck and append exactly declared order; selected newly drawn card is legal. Two draws followed by two returns are four actual moves even with net-zero counts. Unsupported short/failing draws require real extra facts. Root renderer needs a deliberate intermediate four-card hand snapshot/geometry, preserving normal private card visibility.
- **Pain fixed wound snapshot:** woundBoost on phase buff seals target's actual current wounds/entry/source at application and requires exactly+N/+0, no HP/wound change. Store ordinary fixed phase boost, not a Grit keyword/recomputed function. Source proof verifies known unit body/trait metadata and current stats; native wound-dependent aftermath remains separate.
- **No Glory sequence:** permanent control receipt index1 carries exact original current entry/from-controller/owner and full unchanged unit with declared controlled intermediate ending; index2 defeat uses same sequence/entry and actual controller then. Already-friendly control can make no movement but still defeat; no if-you-do success gate. Explicit protected takeover may leave old controller and still have a separately actual defeat. Default primary has successful transfer. Preserve native last-controller death effects only with their own real receipts. Renderer must measure/provide a true intermediate P1 arena slot because final board contains no target; owner destination is P2 discard, not temporary controller's pile.
- **All Clear timing:** spaceClearance is sealed on actual successful selected enemy-space removal and repeated on optional XP buff together with requiresDefeat. Check remainingHP≤3 from actual before stats, then actual opponent space count0 immediately after that removal, before later native arrivals. XP grant consumes that moment-of-clearance witness once; final empty space by itself is insufficient. Any surviving unit is an XP host; new actual token contributes1/1, no phase/attack stat or healing. Decline/additional survivor/prevention gives no invented XP. A separately declared later native space entry does not revoke already-authorized XP, following the printed rule; no trigger queue synthesis.
- **Base protection grant/consume:** kind buff/zone base plus baseProtection grant records exact selected base/source/current phase/one use, no damage change or attachment. Persistent base-specific status is visible in ordinary ending. Later actual damage receipt carries incoming and prevented amounts and applied amount=incoming−prevented, actual source/attack/type evidence and matching protection ID; consume once on exact base/current phase. Direct hit prevents all; **indirect hit prevents0 but consumes**, as installed engine tests explicitly demonstrate. This extra channel remains absent in recordings unless supplied; it is not inferred from title or amount. Zero/unknown incoming, wrong base/source/phase and already-used descriptor reject. Expire at explicit phase-end removes only that source-owned unused descriptor with unchanged damage; no general scheduler or automatic future combat.
- **Space X-Wing creation:** extend existing create token enum with x-wing and exact JSON body2/2/space/vehicle+fighter/name X-Wing/t1/owner/created/exhausted/fresh ID. Preserve Droid/Clone ground contracts and ready Doorstep. No Rebel trait, ordinary hand/unit play or native When Played. Covering Shield uses existing explicit token attachment and identifies an actual other current entry excluding generated X-Wing ID; optional decline is zero receipts. A preexisting X-Wing is legal. Unsupported prevented-creation/then outcome stays unclaimed.
- **Heat bound loss window:** seal the exact complete current arena entries and native Sentinel facts once. Each gets source-bound Sentinel gain and Saboteur loss, statuses tagged with keywordWindow; loss applies even to subjects initially without Saboteur. Existing underlying native/phase Saboteur facts are retained but overridden by active loss; visible No Saboteur status persists. During that same round/phase/entry, a new Saboteur attack/phase grant cannot become effective or authorize bypass; use explicit blocked receipt or conservatively reject unsupported rich grant. Future entries inherit neither effect. Other real Sentinel-loss effects must remain possible; no unconditional reassertion. Explicit phase-end expiry carries complete supplied `unit` ending, removes only this window's two statuses, restores known native D Sentinel/Pathfinder Saboteur and preserves stats/wounds/owner/entry/other statuses. Departed/reentered subjects are never resurrected. Ambiguous foreign lasting Sentinel sources need explicit authoritative ending truth; do not extrapolate a general priority system.
- **Direct/Airlock:** known current nonleader Vehicle guard on actual defeat, no opponent-only restriction or artificial attack. Airlock repeats actual phase−5/−5, power floor0, unchanged damage; declared lethal cleanup separately uses owner/leader/token route. Preserve surviving current native effects; Grit/aura/trigger aftermath beyond plain primary must reject until real additional receipts supplied.

## Verification/presentation boundary

Read installed JSON and reverse map in persistent tests, including token xwing.json identity9415311381 without inventing a print alias. Full primary and Gate/Heat boundary before/after, conservation/owner/deck/resource/input/nonce checks; intermediate draw/control receipts; token unit versus upgrade; chosen bottom order versus unknown recorded order; fixed wound boost; takeover controller at defeat; moment-of-space-clearance versus later arrival; one-use base grant/consume/expiry/direct versus indirect; fresh space token/no-play/another-target; whole-arena loss/new-entry/native restoration/blocked gain; live stats versus damage and independent canonical false-payment/cause/prevention probes.

Root owns integration/observed outcomes/replay matching/builds; renderer owns new measured intermediate hand/control slots, space token appearance, base protection status and keyword-loss chips. Review completed desktop/mobile boards and separately selected Later/phase-end scenes; stable final counts alone cannot prove the intermediate semantics. Four existing records prove only two Clone creations, one X-Wing with Shield declined and two actual draw/hand-leaving Manufacture sequences. Their private bottom ordering and every absent mechanic remain unknown. Do not copy staged protection/keyword-loss/history into recordings.
