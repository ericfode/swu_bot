# A05 narrow contract proposal

GPT-6.1-sol / xhigh; read-only source review, 2026-10-11. Product writes remain paused for the A04 build. This note supplements the chosen fixtures in [the A05 specification](card-animation-a05-spec.md); it does not claim implementation or acceptance.

All ten installed JSON identities, names, sole aliases, aspects and costs match the spec. Matching engine classes were checked, including current watcher incarnation checks, leader summaries, attachment control and resource readiness swaps. Existing Commission recording is the only available A05 case; its unobserved searched cards/order remain unknown.

## Data extensions

```ts
interface ResourceRef extends CardRef { x?: 1 }
interface UpgradeRef extends CardRef { controller?: Seat /* existing t,p,h remain */ }
interface LeaderRef extends CardRef { epic?: 1 /* existing dep,x remain */ }
interface PlayerSnap { resources?: ResourceRef[] /* complete only when explicitly supplied */ }
interface Snapshot {
  // Extend existing entries; older A02 records remain valid without stronger fields.
  defeatedThisPhase?: {
    round: number; phase: string;
    cards: { id: string; controller?: Seat; incarnation?: string;
      lastKnownType?: 'unit' | 'leader-unit' | 'resource' | 'upgrade' | 'token' }[];
  };
  mostRecentIncarnations?: Record<string, string>;
  // Add optional facts to existing A04 attack entries.
  attacksThisPhase?: {
    round: number; phase: string;
    attacks: { id: string; attackerId: string; incarnation: string;
      attackingSeat?: Seat; defendingSeat?: Seat; targetIds?: string[] }[];
  };
}
```

`resources` must agree with `res.total` and the count of unexhausted cards with `res.ready`. No manifest is manufactured from aggregates. Captive references continue using `UnitRef.cap`; no nested cleanup scheduler is introduced.

## Receipt extensions

Two new kinds: `attach` and `capture`. Leader defeat, resourcing, resource plays, public resource inspection and search reuse their existing kinds.

```ts
interface CardEffectOutcome {
  targetCard?: CardRef;                 // new attachment host
  upgrade?: UpgradeRef;                // complete final attachment, same ID/owner
  controllerSeat?: Seat;               // explicit new upgrade controller
  leader?: LeaderRef;                  // explicit completed summary on defeat
  requiresDefeat?: { id: string; incarnation: string };
  resourceReadySwap?: { readyId: string; exhaustedId: string };
  visibility?: 'private' | 'public';
  resourceReveal?: { playIds: string[] }; // cards holds actual public resource selection
  captureBasis?: {
    round: number; phase: string; attackId: string;
    attackerId: string; incarnation: string;
    attackingSeat: Seat; defendingSeat: Seat; targetId: string;
  };
  // Extend zone with 'leader'; fromZone can still use existing 'resources'.
}
// Existing resources payment variant gains optional cardIds.
type ResourcesPayment = { kind: 'resources'; cardIds?: string[] };
interface DeckOperation { revealedIds?: string[] }
```

Normal event payment uses `cue.playPayment.cardIds` when an explicit resource manifest exists; nested `pay` uses its actual `cards` IDs. Validate exact count, uniqueness, ready status and membership, then exhaust those cards once. Previous aggregate-only fixtures retain their current path. A05 exports `a05PreviewPayment` so root can supply the selected event resource IDs without adding a duplicate event `pay` receipt.

## Meaning and validation

- **Evidence:** `attach` names the exact upgrade in `card`, old host in `sourceCard`, new host in `targetCard`, old seat/arena in `fromSeat/fromZone`, and destination host seat/arena in `seat/zone`. `ownerSeat` stays P2; `controllerSeat` and final `upgrade.controller` become P1. Roll back/add the explicit attachment contributions once, preserve both hosts and damage, update lookup membership. Same-host control change updates control without duplicate attachment/stat changes. Later ordinary removal routes to the preserved owner. Base-attached sources remain the pinned class's unsupported case.
- **Rival:** `defeat` has `zone:'leader'` and complete `leader:{same ID/print/owner,dep:0,x:1,epic:1}`. Require the actual deployed arena entry and matching owner leader summary; remove only the arena entry, retain spent deployment and route no card to discard. Other defeat destinations keep their old behavior. No guessed leader readiness or restored epic availability.
- **Remnant/Commission:** private `DeckOperation.top-search-bottom` retains actual looked prefix and complete permutation; `revealedIds` identifies only selected public faces. Separate draw receipts consume selected cards/counts once. Remnant selects three actual units with no combined cost cap; Commission selects one actual matching-trait card, including the Electrostaff upgrade. Unselected faces stay private.
- **Palpatine:** existing `play` from `discard`, explicit cost/reduction receipt and actual nested payment IDs. Event consumes eight resources; selected Force Kylo costs two after all penalties and −8. Entry is exhausted/new incarnation; discard→arena never uses a hand/rescue waypoint. Other selected units with unsupported entry effects require separately authored resolution evidence.
- **Spark:** `resource` uses `fromZone:'discard'`, exact selected Marine, explicit owner, current `defeatPhase` and `incarnation`. Require own current discard membership, current phase, `lastKnownType:'unit'`, and equality to `mostRecentIncarnations[id]`; duplicate history cannot resource one instance twice. Append the actual minimal card exhausted to `resources`, total +1, ready unchanged. Source event stays in discard. Aggregate recorded gain identifies neither the Marine nor the event.
- **Respect:** `capture` names departed unit in `card`, actual friendly captor in `sourceCard`, exact old seat/arena and incarnation, and owner-preserving `cap` destination at captor seat/arena. `captureBasis` must match current explicit attack history, attacking/defending players and actual own base target. Repeated attacks yield one captive. Strip departing arena stats/statuses; dispose its ordinary upgrades to owners and cease tokens. Primaries contain no nested captives; an already-capturing target requires separately supplied cleanup, not an automatic fabricated rescue. Future departed-captor rescue work belongs to A06.
- **Loyalty:** draw carries `requiresDefeat`; require a successfully applied prior defeat for that exact ID/incarnation, not a removed card, attempted/prevented defeat, or source discard. Draw still belongs to event controller when unit owner differs. Failed-draw damage needs explicit separate receipts.
- **Legions:** `inspect` with `visibility:'public'`, `zone/fromZone:'resources'`, exact revealed `cards`, and chosen `resourceReveal.playIds:[0,2,1]`. `play` origins are those actual resource IDs in declared order, with explicit zero unit payment. Remove each resource once, lower total once, retain original deck/hand counts. The primary pays16 from20 then plays three already-exhausted resources, ending ready4/total17. A ready-resource departure uses the declared `resourceReadySwap` when an exhausted replacement is supplied; validate the exact changed flags rather than guessing from aggregate counts. Revealed Repair remains exhausted in resources.

## Final author API after release

`A05_DEFINITIONS`, `A05_COSTS`, `A05_ABILITIES`, `A05_EXAMPLES`, `a05ShowcaseState(definition)`, `a05PreviewOutcomes(definition,state,seat,choices?)`, and `a05PreviewPayment(definition,state,seat)`. Root owns registrations, baseline costs and replay inference; renderer owns measured attachment, leader, resource and captive geometry. Source saves must compile; no imports of an absent batch module.

Focused tests read installed JSON directly and assert actual final states, payments/manifest readiness, card conservation, owner/control distinction, leader summary, deck permutations, latest-incarnation history, capture filters, successful defeat prerequisite and replay unknowns. No builds, games, engine edits or paid calls. Hand Smuggle primaries remain unauthored alternatives; completed data is still pending independent pixels and live lifecycle acceptance.

## Concrete negative-fixture plan

- Transfer the Academy back onto its current host: unchanged stats/count, changed controller only. A later explicit upgrade removal must reach P2 discard. Wrong owner, duplicate attachment ID and print-cost4 selections reject; unsupported base sources are not manufactured.
- Fell current power5 succeeds,4 fails; a phase-debuffed qualifying print fails. Leader targets reject. Rival's Vader keeps same ID and spent epic1, becomes dep0/x1 and never enters discard; missing/wrong completed leader payload rejects.
- Resource payments reject duplicate, absent or already-exhausted selected IDs. Legions primary consumes paid/exhausted slots0,2,1 only. A ready slot16 departure with explicit swap to exhausted Repair slot3 keeps ready4 and lowers total20→19; wrong swap member/status rejects. No reveal, only non-unit reveal and duplicate consumption cannot create units.
- Spark old phase, resource-type defeat, ordinary hand discard and most-recent-entry2 versus defeated-entry1 all remain in discard. Repeating the same qualifying defeat record does not produce two resources; source event remains discard in every case.
- Respect excludes the currently friendly attacker, a deployed leader, attack against a unit, wrong defending player/base/phase and a later incarnation. Duplicate same-entry attacks produce one captive; zero-damage base attack still qualifies. The common Defender is absent so the prior ground base attack is legal. Nested captives require separate cleanup evidence and remain outside this round's adapter.
- Loyalty prevented defeat grants no draw; copied draw receipt without the successful exact defeat rejects. A P2-owned/P1-controlled unit goes to P2 discard while P1 draws. Short decks are rejected by the primary adapter until explicit failed-draw damage is authored.
- Remnant may draw three cost9 units without U-Wing's cap; zero selections draw none. Commission's selected Electrostaff is an Item upgrade, never attached or played. Wrong trait, eleventh card, duplicate/too-many selections and invalid complete permutations reject. Unselected shelf faces stay private.
- Return's selected non-Force Wampa uses −6 even beside a friendly Force Luke; its floored zero nested payment remains explicit. Primary Kylo uses −8 because his own JSON Force trait, with no Rey waiver; wrong source/order/owner, missing nested payment and insufficient ready resources reject.
