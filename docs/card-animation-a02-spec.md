# A02 — next ten event specifications

Status: **specification only; implementation and independent acceptance pending**.
Prepared with the requested GPT-6.1-sol at `xhigh`, 2026-10-11. A01 review and
skill refinement precede authoring this batch. This is another ten identities in
the imported **2,458 identities / 2,549 print codes** scope. An inventory entry or
passing state test is not visual acceptance.

Use [the animation skill](../skills/swu-card-animation/SKILL.md),
[the common language](card-animation-language.md), and
[the A01 contracts](card-animation-a01-spec.md). Preserve the approved twenty
signatures. This document changes no engine or product source and requires no
paid/live game. The scene recipes below are explicit staged demonstrations;
recordings retain their actual before/after snapshots and visibility limits.

## Verified identities and costs

Sources: pinned engine `2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`,
`forceteki/test/json/Card/<slug>.json`, matching
`forceteki/server/game/cards/01_SOR/events/<PascalCase>.ts`, and existing
`forceteki/test/server/cards/01_SOR/events/<PascalCase>.spec.ts`.
Fresh inventory: `results/card-animation-catalogue/imported-a01/inventory.json`,
fingerprint `9cf934bdc9b2af8367ebef3a52256c2a7ccc17ef63dadb5fc2631f91820bc45c`.
All are non-unique events. All installed aliases are listed, preserving aspect
multiplicity; do not add speculative reprints or resolve unknown codes by name.

The common staged player's Luke leader (`SOR_005`, undeployed) plus Echo Base
(`SOR_024`) provide **heroism, vigilance, command**. Every missing aspect symbol
adds 2 resources. Arena units supply no aspects in these recipes. Every source
event is paid once; nested U-Wing plays cost zero resources.

| Slug | Engine identity | Canonical print / all aliases | Printed cost | Required aspects | Staged payment | Ready resources after |
| --- | --- | --- | ---: | --- | ---: | ---: |
| `search-your-feelings` | `7485151088` | `SOR_042` | 4 | villainy, vigilance | 4 + 2 = 6 | 4 |
| `it-binds-all-things` | `0867878280` | `SOR_075` | 2 | vigilance | 2 | 8 |
| `the-emperors-legion` | `9785616387` | `SOR_091` | 2 | command, villainy | 2 + 2 = 4 | 6 |
| `rebel-assault` | `8988732248` | `SOR_103` | 1 | heroism, command | 1 | 9 |
| `uwing-reinforcement` | `8968669390` | `SOR_104` | 7 | heroism, command | 7 | 3 |
| `heroic-sacrifice` | `6954704048` | `SOR_150` | 1 | aggression, heroism | 1 + 2 = 3 | 7 |
| `karabast` | `6515891401` | `SOR_151` | 2 | aggression, heroism | 2 + 2 = 4 | 6 |
| `for-a-cause-i-believe-in` | `5767546527` | `SOR_152` | 3 | aggression, heroism | 3 + 2 = 5 | 5 |
| `rallying-cry` | `1208707254` | `SOR_154` | 3 | aggression, aggression | 3 + 4 = 7 | 3 |
| `force-throw` | `1705806419` | `SOR_167` | 1 | aggression | 1 + 2 = 3 | 7 |

Traits, in table order: innate; force; imperial/supply; rebel/tactic; supply;
tactic; spectre; innate; tactic; force. Rallying Cry's JSON keyword list contains
`raid`; the other nine have no printed keywords. None is a choose-N modal card.
Preserve recipient, optional-branch, order, and chooser decisions separately.

## Common legal before-state and stable identities

Reuse A01's full common fixture with the prefix changed from `a01:` to `a02:`.
This reference makes the recipes small; the authored fixture must still be a
complete `Snapshot`, not a partial overlay. Round 9, action phase, P1 initiative.
P1 resources 10/10; P2 resources 7/10. P1 base damage 9, HP 30; P2 base damage 6,
HP 30. Both leaders are undeployed. P2 is Capital City `SOR_020` plus Vader
`SOR_010`. P1 deck 27, P2 deck 29. Common discards are empty.

P1 hand initially contains only `a02:<slug>:event`, its real source face.
P2 hand contains `a02:p2:takedown-hand`, Takedown `SOR_077`, printed cost 4.
Each card has explicit `owner`; each arena unit's `incarnation` is
`<id>:entry-1`. `x=0` means ready; `x=1` means exhausted. Damage below is actual
damage counters, not missing HP. All common units begin ready with no upgrades
or temporary statuses; prior When Played abilities are already resolved.

| Short name / stable ID | Owner/controller | Face | Arena | Power / HP | Damage | Relevant printed trait / keyword |
| --- | --- | --- | --- | --- | ---: | --- |
| M / `a02:p1:marine` | P1/P1 | Battlefield Marine `SOR_095` | ground | 3/3 | 1 | Rebel, Trooper |
| D / `a02:p1:defender` | P1/P1 | Echo Base Defender `SOR_098` | ground | 4/3 | 0 | Rebel, Trooper; Sentinel |
| X / `a02:p1:xwing` | P1/P1 | Alliance X-Wing `SOR_237` | space | 2/3 | 0 | Rebel, Vehicle, Fighter |
| T / `a02:p2:trooper` | P2/P2 | Death Trooper `SOR_033` | ground | 3/3 | 0 | Imperial, Trooper |
| W / `a02:p2:wampa` | P2/P2 | Wampa `SOR_164` | ground | 4/5 | 1 | Creature; Overwhelm |
| F / `a02:p2:tie` | P2/P2 | TIE/ln Fighter `SOR_225` | space | 2/1 | 0 | Imperial, Vehicle, Fighter |

When a recipe replaces D with L, L is `a02:p1:force`, Luke Skywalker: Jedi Knight
`SOR_051`, owner/controller P1, ground 6/7, Force/Jedi/Rebel, Restore 3. This is
the unit, not the undeployed leader; its earlier When Played effect has expired.
L never attacks in either primary recipe, so Restore is not triggered.

Deck choice recipes use a full staged `knownDeck`: real specified faces plus
stable unknown refs `a02:<slug>:unknown:<n>` for the rest. Unknown faces stay
unknown. All named cards get unique IDs even when another copy is on the board.
Only source-event payment/discard and the listed recipe changes occur. Event
resolution gives priority to P2; do not manufacture a second action or phase
advance. Final natural completion must retain the resolved state, not the common
fixture. Preview reset restores the original fixture.

## Ten complete rules and primary recipes

### 1. Search Your Feelings — private retrieval, whole-deck shuffle

**Clauses.** Search your entire deck for a card of any type and draw it; then
shuffle the remaining deck. The engine permits taking nothing. It does not
require revealing the chosen card publicly. Empty-deck search does nothing;
this is not an attempted blind draw and does not manufacture empty-deck damage.

**Before → after.** Put Open Fire `SOR_172`, ID
`a02:search-your-feelings:selected`, at index 8 of P1's full 27-card staged
manifest. Select that event to make the lack of unit restriction clear. It moves
deck → hand with the same ID/owner; deck 27 → 26, P1 hand event-only → Open
Fire-only, source event → discard, ready resources 10 → 4. Shuffle **all** 26
remaining IDs; use their reversed initial order as one reproducible possible
permutation. No rest-of-deck order guarantee, public reveal, mill, or bottom-only
reinsertion. All arena cards stay unchanged.

**Signature, about 5 seconds.** A private amber lens indexes the whole counted
deck; one selected card slides into P1's hand while its public side remains a
back. The entire residual deck briefly separates into three interleaved layers,
then closes under a single shuffle loop. Reserve time for the `DECK 26 / HAND 1`
landing. An explicit omniscient staged view may name Open Fire as private
information; a public replay may not reveal a hidden face.

**Assertion / replay boundary.** Exact selected ID is conserved; shuffled ID set
equals the original set minus selection. Taking nothing preserves counts but
still shuffles. A before/after deck count cannot prove selection identity,
search scope, or shuffled order; require explicit staged/resolution evidence.

### 2. It Binds All Things — actual healing becomes damage

**Clauses.** Heal up to 3 damage from one unit, friendly or enemy, in either
arena. Choosing no healing is legal. If you control an in-play Force unit, you
may deal **the amount actually healed** to another unit, friendly or enemy, in
either arena. The damage recipient must differ from the healed unit. Neither
recipient can be a base; three is a cap, not a guaranteed damage value.

**Before → after.** Replace D with L at damage 3, ready. Heal L by 3: 3 → 0.
L itself satisfies the friendly Force-unit prerequisite. Choose optional damage
3 to W: damage 1 → 4, leaving 1 HP. Source event → discard, resources 10 → 8.
No ready/exhaust change, attack, Shield, stat boost, or healing of P1's base.

**Signature, about 5 seconds.** Three green damage marks lift from L into one
small suspended balance ring. After `HEALED 3` lands, that same counted payload
crosses the ring and becomes three red damage marks on W. The different-unit
connection stays legible. The Force mark certifies L before the optional damage.

**Assertion / limitation.** Removed damage = inflicted damage = 3 in this
recipe; a 1-damage healed unit must produce at most 1, not 3. Reject same-unit
damage, bases, and the Force branch without an actual friendly Force unit.
Pinned engine implementation reads `thenContext.events[0].totalDistributed`
without guarding a missing healing event. Zero-heal/no-target resolution is a
known limitation; do not fix tracked engine source or use paid/live games here.
Stage the positive legal branch, document the zero branch, and do not claim
engine validation of it. Snapshot deltas may establish healing/damage amounts
but cannot establish the optional choice or causal conversion unaided.

### 3. The Emperor's Legion — recover this-phase defeats from your pile

**Clauses.** Return **each** unit currently in your discard pile that was defeated
**this phase** to your hand. No Imperial trait restriction and no selection
limit. Eligibility follows the current discard pile, not the controller at
defeat. A unit discarded, resourced, or defeated in a previous phase is not
eligible. The wording is phase history, not entire round history.

**Before → after.** Add four real cards to P1's discard: Marine `SOR_095` ID
`a02:legion:marine`, X-Wing `SOR_237` ID `a02:legion:xwing`, Defender `SOR_098`
ID `a02:legion:old`, and Open Fire `SOR_172` ID `a02:legion:event-old`. Explicit
staged history records Marine and X-Wing defeated in the current action phase;
Marine was controlled by P2 at defeat but owned by P1. Defender was defeated in
the preceding phase; Open Fire was ordinarily discarded this phase. Recover
exactly Marine + X-Wing into P1's hand. Discard 4 → 3 after adding the source
event; hand event-only → two recovered units; resources 10 → 6. No arena entry,
new incarnation, draw, deck change, resurrection attack, or ready action.

**Signature, about 5 seconds.** A compact `THIS PHASE` bracket highlights two
eligible faces in the discard stack, leaving the older Defender dim but visible.
Two intact cards rise together as an orderly return file into P1's hand. A
small historical P2 controller mark on Marine resolves to the current P1 pile
route; avoid a villainy-colored blanket sweep that implies only Imperials.

**Assertion / replay boundary.** All and only the two history-qualified unit IDs
return. Current snapshots can establish discard → hand movement but cannot
prove this-phase eligibility without the defeat history/explicit resolution.
Keep history in staged recipe metadata until a real replay source provides it.

### 4. Rebel Assault — two different Rebels, two attack windows

**Clauses.** Attack with a Rebel unit; it gets +1/+0 **for that attack**. Then
attack with another Rebel unit with the same attack-only bonus. Units must be
ready and able to make a legal attack; the second must differ from the first.
Resolve each attack and its triggers before the next. This effect does not ready
units or let them bypass Sentinel, arena restrictions, or attack restrictions.

**Before → after.** M and X begin ready; both are Rebels. P2 has no Sentinel,
so each may attack P2's base. Attack M first: attack power 3 + 1 = 4, base damage
6 → 10; M becomes exhausted and returns to resting 3/3. Then attack X: attack
power 2 + 1 = 3, base damage 10 → 13; X exhausted, resting 2/3. P1 resources
10 → 9, source event → discard. D stays ready. Unit damage counters stay
unchanged; bases deal no combat counter-damage. No attack bonus remains at end.

**Signature, about 6 seconds.** Two numbered Rebel command brackets fire in
sequence, first ground and then space. Each briefly clips a `+1 THIS ATTACK`
power tab to its own attacker, travels on that attack's measured route, rotates
the attacker exhausted, and retracts the tab before the next bracket opens.
Leave the base's 4-then-3 increments distinct and settle on `BASE DAMAGE 13`.

**Assertion / replay boundary.** Two actual attack segments, distinct attacker
IDs, damage [4,3], final exhausted poses, original resting stats. A lone eligible
Rebel or an unavailable second attack does not invent a second unit. Exhaustion
plus base damage in aggregate cannot prove attack order or temporary bonuses.

### 5. U-Wing Reinforcement — select three, play from deck for free

**Clauses.** Search the top 10 (or all remaining cards if fewer) for up to three
units with combined **printed** cost at most 7; play each for free in selected
order, resolving each play and triggers before the next. Free ignores resource
costs including aspect penalties, not other additional costs. Pilot selections
can only be played as units. Put all unchosen searched cards on the bottom in
random order. Taking nothing is legal. Normal entry is exhausted; this is not
Sneak Attack's ready entry and not a draw to hand.

**Before → after.** The first ten P1 deck entries, IDs `a02:uwing:top:<index>`:

| Index | Face | Printed cost | Primary choice |
| --- | --- | ---: | --- |
| 0 | Battlefield Marine `SOR_095` | 2 | first play, ground 3/3 |
| 1 | Open Fire `SOR_172` | 3 | unchosen event |
| 2 | Repair `SOR_074` | 1 | unchosen event |
| 3 | Echo Base Defender `SOR_098` | 3 | second play, ground 4/3 Sentinel |
| 4 | Resupply `SOR_126` | 3 | unchosen event |
| 5 | Wampa `SOR_164` | 4 | unchosen unit |
| 6 | Moment of Peace `SOR_073` | 1 | unchosen event |
| 7 | Alliance X-Wing `SOR_237` | 2 | third play, space 2/3 |
| 8 | Recruit `SOR_123` | 1 | unchosen event |
| 9 | TIE/ln Fighter `SOR_225` | 1 | unchosen unit |

Select indices [0,3,7], sum 2+3+2=7. These three have no When Played triggers
and enter their printed arenas with damage 0, exhausted, owner/controller P1,
stable IDs and new `<id>:entry-1` incarnations. P1 ground count 2 → 4, space
1 → 2, deck 27 → 24, hand event-only → empty, discard gains source event,
resources 10 → 3 with **zero nested resource payments**. Preserve the untouched
17 deck cards in order. Append unchosen indices [9,8,6,5,4,2,1] as one staged
possible random bottom order. Existing units' states stay unchanged.

**Signature, about 6.5 seconds.** A private ten-card manifest opens with three
numbered selection sockets and a shared `2 + 3 + 2 = 7` cost ruler. A U-Wing
silhouette is the carrier, not a fabricated arena unit. Selected real faces
deploy sequentially, becoming public at play and landing exhausted across
ground/space. The seven other backs gather under a bottom insertion bracket
with a random-order mark. Hold the three stable occupied slots at the end.

**Assertion / replay boundary.** Three unique units enter from deck, not hand;
no fourth selection, sum above 7, event play, pilot-as-upgrade, draw receipt, or
ready entry. A nonmatching-aspect unit in an alternate legal selection remains
free. Replay deck/arena deltas may show actual entries, but hidden searched
faces, selection order, printed budget and bottom permutation require evidence.

### 6. Heroic Sacrifice — draw, attack, conditional self-defeat

**Clauses.** Draw one, then attack with a ready unit if able. During **that
attack** it gets +2/+0 and gains a trigger defeating it when it deals **combat
damage**. Prevented/zero combat damage does not trigger that defeat. Damage
from another ability is not combat damage. This is not an unconditional defeat
after an attack, a phase-long bonus, or a regroup obligation.

**Before → after.** P1 deck top is Repair `SOR_074`, ID
`a02:heroic-sacrifice:draw`. Draw it: deck 27 → 26. Ready M attacks P2's base
legally (no enemy Sentinel): attack power 3+2=5, base damage 6 → 11. M deals
actual combat damage, then its granted trigger defeats M to its owner's discard.
P1 ground 2 → 1; hand event-only → Repair-only; discard gains source event and
M; resources 10 → 7. D, X and all enemies unchanged. There is no surviving
attack buff/status or future pending defeat. Base causes no counter-damage.

**Signature, about 6 seconds.** A restrained draw arc lands Repair first. One
bright `+2 THIS ATTACK` tab and a hollow sacrifice ring follow M's attack route.
The ring closes only after the five combat damage marks visibly land on the
base; then the intact M face moves to P1 discard. Keep the draw, strike, and
sacrifice beats distinguishable; a generic explosion cannot explain the trigger.

**Assertion / replay boundary.** Order draw → attack → positive combat damage →
self-defeat; final M absent and same ID in discard. Alternate fully Shield-
prevented combat damage leaves the attacker alive unless another actual rule
defeats it. Snapshot disappearance alone cannot attribute the cause or prove
that combat damage occurred; require attack/combat and triggered-resolution data.

### 7. Karabast — damaged friendly unit is the damage source

**Clauses.** A friendly unit deals damage to an enemy unit equal to its current
damage counters plus one. Neither side can be a base; either arena is valid.
No attack, ready condition, exhaustion payment, or healing is instructed. The
formula uses damage, not current power, printed power, or HP lost to a modifier.

**Before → after.** M has damage 1 and is deliberately **exhausted** before this
recipe. Select M and W. M deals 1+1=2 ability damage to W, whose damage 1 → 3;
W survives with 2 HP. M's damage stays 1, power 3, exhausted. Source event →
discard, resources 10 → 6. No attack/counter-damage, ready, or base damage.

**Signature, about 4.5 seconds.** One amber scar on M enters a small `1 + 1`
counter, then becomes a two-mark red pulse aimed at W. Leave M flat/exhausted
throughout. The permanent scar remains while W's two fresh marks settle; the
source relationship is the distinctive image, not an attacking card lunge.

**Assertion / replay boundary.** Damage 2 from a damaged exhausted friendly
source, no source-state delta. Test undamaged source produces 1 and different
power does not change the formula. Recorded damage delta may be known while the
chosen source is unavailable; do not assign one from a convenient matching value.

### 8. For a Cause I Believe In — reveal, count Heroism, choose top/discard

**Clauses.** Publicly reveal the top four (or fewer in a short deck). Deal one
damage to an enemy base for each revealed card with Heroism, counting each card
once. You may discard any subset of those revealed cards, then return the rest
to the top in any chosen order. Damage uses the original revealed set, including
cards subsequently discarded. No draw, private search, random bottom, or whole
deck shuffle. The implementation resolves reveal/choices with base damage in a
simultaneous effect; do not claim a replay timing order it does not record.
Its lethal branch reveals and ends the game without the later choice prompt.

**Before → after.** Top four IDs `a02:cause:top:<index>` are [Marine `SOR_095`
(Heroism), X-Wing `SOR_237` (Heroism), Open Fire `SOR_172` (not Heroism), Repair
`SOR_074` (not Heroism)]. Publicly reveal all four; count 2 → base damage 6 → 8.
Choose to discard X-Wing and Open Fire. Return Repair then Marine to the top,
followed by the original untouched 23 in order. Deck 27 → 25; P1 hand source
event → empty; discard gains source event plus those two exact deck cards;
resources 10 → 5. Arena X and M are different copies and remain unchanged.

**Signature, about 5.5 seconds.** Four public faces turn together. Exactly two
Heroism badges light and send a counted pair of marks to the enemy base. The
four-way choice shelf then separates two down-to-discard routes from two
numbered up-to-top slots; Repair locks above Marine. A top insertion chevron
distinguishes chosen top order from Recruit/U-Wing's random bottom return.

**Assertion / replay boundary.** Heroism count 2 survives discarding the heroic
X-Wing; exact two chosen discard IDs, exact chosen top order, no hand gain. Short
and zero-Heroism decks must not show four cards or fabricate damage. Public
revealed faces need explicit reveal data; zone deltas alone do not reveal the
other returned faces or their selected order. Lethal branch stops at game end.

### 9. Rallying Cry — persistent Raid, no resting stat increase

**Clauses.** Every currently friendly unit gains Raid 2 for this phase, in both
arenas, including a deployed friendly leader unit. Raid is +2/+0 **while
attacking** and adds to any existing Raid. This instruction does not attack or
ready any unit. The implementation targets the units currently in play at
resolution, not units played later; the grant expires at phase end.

**Before → after.** All three current friendly M/D/X gain explicit phase-long
Raid 2 status. Their resting power/HP remain **3/3, 4/3, 2/3**, existing damage
and ready poses unchanged; enemies gain nothing. Source event → discard,
resources 10 → 3. No base damage, attack, Experience token, permanent power
change, or invented follow-up action. If separately reviewing a subsequent
legal attack, M's attack power would be 5 and revert to 3 afterward; that is not
part of the primary event's after-state.

**Signature, about 4.5 seconds.** A Rebel battle-call ribbon crosses both own
arenas and stamps three compact `RAID 2 · THIS PHASE` attack pennants. Pennants
stay outlined at rest, avoiding the filled numeric buff language of Attack
Pattern Delta. They remain readable on the resolved board after the rally
ribbon leaves. An attack glyph explains the conditional bonus without a lunge.

**Assertion / replay boundary.** Three friendly persistent keyword grants,
zero resting stat/readiness/damage delta, no enemy grant. Stacking and phase
expiry must affect keyword/attack calculation, not permanently rewrite `p`.
Snapshots lacking effective keywords cannot prove this grant from unchanged
numbers; only explicitly staged or resolved keyword data may show the status.

### 10. Force Throw — chosen player chooses the discard; printed cost damage

**Clauses.** Choose either player; that player chooses and discards one card
from their own hand. If that discard occurs and the event controller controls
an in-play Force unit, the controller may damage any unit, friendly or enemy,
in either arena, equal to the discarded card's **printed** cost. No random
discard, chosen-opponent-card authority, base target, or payment of that cost.
No actual discarded card or no friendly Force unit means no conditional damage.

**Before → after.** Replace D with L at damage 0, ready; set W damage to 0.
P1 chooses player P2. P2 chooses its sole Takedown `a02:p2:takedown-hand`,
`SOR_077`, printed cost 4; it moves P2 hand → P2 discard. L satisfies P1's
Force prerequisite. P1 chooses optional damage 4 to W: 0 → 4, survives 1 HP.
P2 hand 1 → 0, discard 0 → 1; P1 hand event → empty, discard gains source
event, resources 10 → 7. P2 resources stay 7; no 4-resource payment or attack.

**Signature, about 5 seconds.** A choice bracket points to P2's hand; the
`P2 CHOOSES` tag precedes its departing face. Takedown's printed 4 passes through
a Force ring certified by L, then four damage marks land on W. The face completes
its route into **P2** discard while the numbered payload has its own route.
Retain distinct player chooser, Force prerequisite, damage target, and owner pile.

**Assertion / replay boundary.** Correct chooser, exact discarded card/owner,
printed cost 4, unit-only optional damage. Alternate self-discard is legal;
missing Force skips damage; modified payment/discount does not alter damage.
An unknown discarded face cannot establish its printed cost, and a discard plus
damage delta alone does not establish who made either choice.

## Concrete semantic dependencies before authoring

Reuse A01's explicit ownership, incarnation, play, search, and measured movement
contracts, but do not reuse its limited-search reducer for every deck effect.
These are narrow additions needed by these ten rules, not a replacement engine:

| Needed meaning | Minimum staged evidence / state | Implementation boundary |
| --- | --- | --- |
| Sequential actual attacks | Per-attack attacker/defender IDs, legal target, attack-only modifier, combat damage, exhaustion and trigger receipts | `duration: attack` exists on outcomes, but ability grammar/state must support attack windows and restore resting stats before final state. Do not infer attacks from aggregated damage + exhaustion. |
| Combat-triggered self-defeat | Positive combat-damage receipt attributed to that attacker and granted trigger | Separate from A01 regroup `delay`; no persistent future obligation after a resolved attack. Fully prevented damage must not sacrifice the attacker. |
| Phase keyword grant | Targeted current-unit IDs, keyword Raid, value 2, phase duration | Distinct from normal numeric `buff`. Persistent keyword chip; resting `p` unchanged. Record unknown keywords as unknown. |
| Search policies / visibility | Whole-deck shuffle; top-N private selection/random bottom; public reveal/chosen top order | Explicit policy, complete inspected group when staged, selected IDs/order and returned IDs/order. No invented public faces in a recording. Do not require every unknown card to animate individually. |
| Multiple plays from deck | Up to three selected IDs with printed costs, selection order, free resource cost, printed arena, exhausted entry, complete units | A01's play reducer currently handles hand origin; extend verified deck origin without a hand waypoint. Resolve plays/triggers sequentially, not a simultaneous token spawn. |
| Optional revealed-deck discards | Chosen IDs, deck origin, chooser, owner's discard destination | Reuse a routed discard with explicit origin; ordinary hand discard and forced top mill do not express this choice. |
| This-phase discard eligibility | Defeated-unit IDs, actual phase, current own discard membership | Explicit staged history sidecar until recordings provide actual defeat history. Recover all qualified, no invented historical controller constraint. |
| Derived damage amounts | Actual healed amount; chosen friendly source's current damage +1; selected discarded face's printed cost | Keep formula and basis explicit; snapshot/metadata can validate a staged basis, but matching numeric deltas do not establish replay causality. |

Suggested narrow shared fields for the coordinator to finalize (not declarations
already present in product code):

- `deckOperation?: { policy: 'whole-search-shuffle' | 'top-search-bottom' |
  'reveal-top-choice'; visibility: 'private' | 'public'; looked: CardRef[];
  selected: CardRef[]; discarded?: CardRef[]; remainingOrder: CardRef[] }` on an
  explicit deck receipt. `remainingOrder` is the complete resulting manifest;
  it includes selected cards until a separate draw/play consumes them in the
  first two policies, and excludes the selected discard IDs in the third.
  Each consuming receipt validates its ID against that operation; no double
  removal. Shuffle/random order are sampled staged permutations, not a claim
  of an observable random seed. Missing recorded fields remain missing.
- `attackId?: string`, `attackIndex?: number`, `sourceCard` as attacker and
  `card` as defender on actual attack/combat receipts; `duration: 'attack'` on
  its temporary `buff`. Apply only during that attack segment, never to final
  resting stats. Damage remains a separately counted receipt.
- `keyword?: { name: 'raid'; amount: number }`, phase duration, and a persistent
  `UnitStatus` keyword value. A dedicated `keyword` kind is clearest; if the
  coordinator retains `buff`, require this discriminant so numeric-stat code
  cannot accidentally add 2 to resting power.
- `chooserSeat?: Seat` plus existing `fromSeat/fromZone/ownerSeat` on chosen
  discard receipts. Force Throw's chooser is the selected player; Cause's
  chooser is P1 and origin is deck. Add explicit `basis` metadata for derived
  damage if the renderer needs to show its formula rather than only the result.
- Staged `defeatedThisPhase` evidence as IDs plus phase/round, separate from
  `Snapshot` if possible; no persistent unit status on an absent discard card.

Whole-deck shuffle and chosen-top order must update the full staged manifest
without duplicating cards. Public reveal changes visibility, not card location
or counts. U-Wing deck plays change deck/arena counts; Search Your Feelings draws;
For a Cause optional discards change deck/discard counts. They need distinct
receipts even when one common `search` composition presents their temporary shelf.
Every displayed known face must come from authoritative metadata and actual
staged/resolution evidence. Labels may explain a choice, but must not be the only
machine-readable representation of origin, destination, order, or keyword.

## Checks and independent acceptance

Implementation's behavior checks should cover each table recipe plus the narrow
negative cases above: immutable before/cue; exact resource payment once; card-ID
and owner conservation; stable IDs across preview nonce; chosen manifest order;
attack bonuses absent at rest; no sacrifice on prevented combat damage; Raid
present without resting stat inflation; this-phase eligibility; wrong chooser,
target, printed-cost budget or Force prerequisite rejected/skipped faithfully.
Do not execute source-engine games to paper over the known zero-heal bug.

Independently capture each primary at approximately 18/46/72/90/100 percent,
then observe natural completion and frozen after-state. Reopen/replay to check
reset. Check 390×844 and reduced motion. The reviewer must identify the source,
recipient, route/choice and duration from the visible motion and final board,
and score readability ≥4, meaning ≥4, impact ≥3. In particular verify the private
Search scene does not publicly reveal, attacks settle at original power, U-Wing
occupies three real exhausted slots, Legion returns to hand, Heroic leaves a
vacated slot, Cause has top/discard routes, and Raid survives as a keyword chip.
No pixel capture, behavior test, or independent review has yet been performed
for A02; record those separately in the batch ledger after authoring.
