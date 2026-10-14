# A07 approved narrow contract design

GPT-6.1-sol / xhigh, 2026-10-11. Supplement to [A07 rules/fixtures](card-animation-a07-spec.md). **Design only; product source remains paused until root releases it after the frozen80 checks and reviewer source snapshot.** Root approved retaining existing kinds, explicit player-loss data, and the two boundary APIs. No engine writes or builds.

## Exact fields

```ts
// Add one optional attribution to existing staged history entries.
Snapshot.defeatedThisPhase.cards[].defeatedBy?: Seat;

// Extend existing unit PendingEffect only for the chosen Triple Dark Raid unit fixture.
PendingEffect.trigger: 'regroup-start' | 'phase-end';
PendingEffect.kind: 'return-control' | 'defeat' | 'return-to-hand';
// Existing targetId/incarnation remain required; ownership comes from actual unit.

interface PendingPlayerEffect {
  id: string; sourceId: string; player: Seat;
  trigger: 'regroup-start'; kind: 'lose-game';
}
interface StagedMatchResult {
  winner: Seat | 'draw'; loser?: Seat;
  reason: 'card-effect'; sourceId: string;
}
interface Snapshot {
  pendingPlayers?: PendingPlayerEffect[];
  matchResult?: StagedMatchResult;
}
interface CardEffectOutcome {
  pendingOperation?: 'schedule' | 'consume'; // existing unit delay defaults to schedule
  playerPending?: PendingPlayerEffect; // delay: absent matchResult schedules; present resolves
  matchResult?: StagedMatchResult;
  playAs?: 'unit' | 'upgrade';         // omitted retains existing unit behavior
  requiresReturn?: { id: string; incarnation: string; ownerSeat: Seat };
  attackRole?: 'attacker' | 'defender'; // omitted retains existing attacker modifier
  attackArenaPermission?: 'space-to-ground';
  bountyResolution?: {
    id: string; hostId: string; incarnation: string; collector: Seat;
    abilitySourceId: string; index: number; kind: 'draw'; amount: number;
  };
  // Add these cases to existing choice union; no new generic choice system.
  choice?: /* existing */
    | { kind: 'opponent-mode'; decision: 'resources' | 'unit'; chooser: Seat; actor: Seat }
    | { kind: 'controller-unless'; decision: 'pay' | 'exhaust'; subject: CardRef;
        controller: Seat; amount: 2 }
    | { kind: 'owner-replay'; decision: 'play-free' | 'decline'; owner: Seat;
        subjectId: string; returnedIncarnation: string };
  // Extend existing attackBonusBasis.kind with 'wookiee'; supplied print/trait verified in tests.
}
```

Existing `cards`, `upgrade`, `targetCard`, `ownerSeat`, `chooserSeat`, `fromSeat/fromZone`, `pending`, `unit`, `entersReady`, `entryType`, `attackId/index`, `duration`, `deckOperation`, `defeatPhase` and `incarnation` retain their meanings. No added AbilityKind or sound design. Vehicle-upgrade phase-end/pilot-leader cleanup is a complete printed branch but not this chosen unit fixture; do not fabricate an upgrade incarnation from a unit payload.

## APIs and ownership

Data exports `A07_DEFINITIONS`, `A07_ABILITIES`, `A07_EXAMPLES`, `A07_COSTS`, `a07ShowcaseState(definition)`, `a07PreviewOutcomes(definition,state,seat,choices?)`, `a07PreviewPayment(definition,state,seat)`.

Two explicit boundary exports:

```ts
a07PhaseEndOutcomes(definition, immediate, seat): CardEffectOutcome[] | undefined;
a07RegroupOutcomes(definition, immediate, seat): CardEffectOutcome[] | undefined;
```

Phase-end supports Triple Dark Raid; regroup supports Final Showdown; other definitions return undefined. Source is already paid/discarded and boundary outputs have no event payment. Root owns cue/preview `stage:'phase-end'`, selector/caption/capture integration, registrations, baseline costs, and persistent `matchResult` banner. The main renderer owns Raid/Spare/Adventure/Final/Posting plus shared geometry; root owns Bravado/Wookiee/Look/Ma/Swoop signatures. All builds and replay inference remain root-owned.

## Receipt meanings

- **Bravado:** the actual preview price uses current `defeatedThisPhase` with unit/leader-unit last-known type, controller opposing P1, and `defeatedBy:P1`. It does not require current discard or most-recent entry. Historical `cost` receipt binds F in `card`, its old `incarnation`, exact `defeatPhase`, amount−2; existing `ready` binds damaged exhausted X. No fresh defeat receipt. Validate discount against this explicit attribution before event payment; unsupported recorded history never receives the discount proof. The suspected upgrade-only watcher behavior stays documented and unauthored.
- **Raid:** existing private top-search-bottom operation, exact top7/selection/complete permutation; normal nested `pay0`, direct `play` from deck with complete X-Wing/ready/new entry, then `delay.pending` `{id:'a07:raid:return',sourceId:event,targetId:selected,incarnation:entry1,trigger:'phase-end',kind:'return-to-hand'}`. Its visible delay status names phase-end return and uses phase duration, never a regroup label. Boundary explicitly consumes that exact pending (`delay.pendingOperation:'consume'`) before ordinary owner-hand `return` for the same continuing entry; supplied missing/new-entry truth produces only consumption, not invented return. Require the selected phase-end boundary rather than elapsed time. No phase advancement from time, no regroup ready/draw, no source resourcing.
- **Wookiee:** `ready` carries `choice.opponent-mode`; P2 chooses mode, actor P1. Unit branch also has `chooserSeat:P1`, current Slaves card and ready amount1, followed by existing attack-only buff with `attackBonusBasis.wookiee`, ordered attack/exhaust/combat results. Resource branch uses `ready`/`zone:'resources'`, actual selected exhausted `cards`, amount equal to count; update manifest flags and ready count only. Six is capped by actual exhausted availability; no resource gain/deck replacement. Rich scene validates the mode/actor/target-choice roles together.
- **Spare:** ordinary enemy-unit owner-hand return and attachment cleanup; separate draw2 carries exact `bountyResolution` host entry/Death Mark source/collector/sequence. Capture the grant before removal; actual source upgrade at the correct before host and printed draw2 ability are required. Collection is a simultaneous independent system, **not** `requiresReturn`; a missing/prevented return neither proves nor disproves an actual separately witnessed Bounty resolution. Sparse recordings retain their supported generic return. Future other Bounty effects need separately authored actual receipts, not a title-based converter.
- **Adventure:** return exact W entry to owner P2 hand with owner-replay choice metadata; decline emits no play/pay. Accepted replay supplies explicit P2 normal-resource payment0 and `play` from P2 hand, `requiresReturn` binding old entry/owner, `entryType:'played'`, `entersReady:false`, complete clean W entry2. New entry effects require separate actual receipts. The current event controller P1 never becomes the unit's owner/player or pays the owner's free cost. Remove Academy once to actual owner P1.
- **Final:** ready each actual controlled unit, then `delay.playerPending` with player P1/source event and no matchResult. The ordinary ending retains this player obligation and remains ongoing. Regroup boundary uses `delay` with the same pending plus explicit `{winner:P2,loser:P1,reason:'card-effect',sourceId:event}`; require actual prior player obligation and supplied regroup boundary, consume once, set `Snapshot.matchResult`. Do not target/defeat units or assign base damage. An already supplied actual terminal result cannot be overwritten by simulating a later regroup; stage helper emits no contradictory loss. This is explicit staged result application, not a game-ending rules engine.
- **Look:** primary `pay` byP2 carries `choice.controller-unless` `{decision:'pay',subject:W,controller:P2,amount:2}`, exact two resource IDs, amount2, `chooserSeat:P2`; omit unit-play `sourceCard` linkage. Exhaust alternative carries the same choice with `decision:'exhaust'`, actual W, amount1/arena. Require current controller, actual branch/amount and affordability after any own-source payment. Pay does not ready or exhaust W; no new cost reduction or free play.
- **Posting:** private whole-search-shuffle with selected/revealed Public Enemy ID, exact full permutation; separate actual draw; explicit ordinary nested pay0 with selected card source. Then existing `play` gains `playAs:'upgrade'`, actual hand/deck origin, complete final `upgrade:{same ID/print/owner,controller:P1,t:0,p:0,h:0}`, `targetCard:W`, destination host seat/arena, no `unit` or fake unit readiness. Remove source once, append attachment once, apply contributions once, update lookup. This is normal upgrade play, distinct from `attach` transfer; no immediate Bounty collection/Shield. A future selected Vehicle upgrade uses this path only with separately verified restrictions and delayed cleanup evidence.
- **Ma:** ordinary return caches successful exact ID/old incarnation/owner-hand destination. Damage3 has `requiresReturn` for Thug and actual recipient W; require successful prior return and current recipient unit. An absent/prevented return cannot authorize damage. Actual ownership may differ from friendly controller. No attack/host defeat inferred from upgrade cleanup.
- **Swoop:** same attackID binds attacker +2 attack buff (`attackRole:'attacker'`), defender−2 attack debuff (`attackRole:'defender'`), Saboteur1, `attackArenaPermission:'space-to-ground'`, actual ready space X and ground W. Keep separate attacker/defender modifiers rather than overwriting the one existing attack bonus slot. Resolve real Shield-token removal before combat; actual forward4 and counter2 receipts, floor defending power0 as needed. No resting stat/status/arena change. Space/base branches omit both ±2 while retaining Saboteur; base has no counterdamage. Old attack receipts without permission/defender role retain their original behavior.

## Focused negatives and geometry

Test costs/physical conservation/source disposal once and installed JSON identity/traits. Wrong-phase/friendly-at-defeat/someone-else-attributed/upgrade-only Bravado history; no current-discard requirement. Raid no selection, explicit zero, stale/departed/controlled continuing entry and owner destination. Wookiee opponent versus target chooser, non-Wookiee no attack, exact resource flags and partial availability. Spare no Bounty versus actual Death Mark collection independently of return; source/host/entry/collector/amount mismatch. Adventure owner decline, free ignores aspects, old entry versus fresh, missing prior return or zero receipt. Final immediate ongoing versus separate terminal regroup, repeated boundary and preexisting actual winner. Look unable payer, wrong controller and no fabricated readying. Posting Bounty **upgrade** type/trait, private shuffle/selected-only reveal, actual host/payment/attachment count/no Shield now. Ma failed return/non-Underworld/returned recipient. Swoop modifier roles, correct arenas/Shield timing, zero floor and no base counterdamage.

Use measured before hand/pocket/attachment origins and after hand/arena/attachment slots; inspect natural routes between named frames, mobile footer clearance and persistent player pending/terminal banners. Render and suppress generic receipts with the same strict compound predicate. The only available A07 recording is Spare's plain Maz return at its actual price3; no Bounty or hidden historical detail is inferred. Production remains frozen and A07 is unimplemented/unaccepted during this design hold.
