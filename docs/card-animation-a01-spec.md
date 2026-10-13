# A01 — ten event animation specifications

Status: **specification and staged fixture reference; independent acceptance pending**.
Preparation requested GPT-6.1-sol at `xhigh`. The coordinator repairs and reviews
the twenty existing scenes before expanding the catalogue. This is the first new
ten-identity batch within the imported scope of **2,458 identities / 2,549 print
codes**, not a claim of whole-catalogue support.

Use [the animation skill](../skills/swu-card-animation/SKILL.md),
[the common language](card-animation-language.md), and
[the batch ledger](card-animation-batches.md). Preserve the existing twenty
compositions and their durations. All engine/card-data paths below are read-only.

## 1. Rules and identity sources

Audit date: 2026-10-11. Pinned engine HEAD:
`2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`.
The inventory packet is
`results/card-animation-catalogue/imported/inventory.json`, source fingerprint
`5f195e7efec17cbd2e74e225b705ac283827c0340aae378cabeee76d0228b6ec`.
The ten rows below agree with both that packet and installed JSON `setCodes`.
Every one currently has exactly one print alias. Do not register speculative
reprints or resolve an unknown present print code by title.

The data implementation is [batchA01.ts](../studio/src/effects/batchA01.ts),
with focused state/evidence checks in
[card-effects-a01.test.cjs](../studio/test/card-effects-a01.test.cjs). These
files package this specification; they do not establish visual acceptance.

| Scene slug / internal name | Engine identity | Canonical print / all print aliases | Printed cost | Required aspects, preserving duplicates | Trait |
| --- | --- | --- | ---: | --- | --- |
| `moment-of-peace` | `8981523525` | `SOR_073` | 1 | vigilance | innate |
| `mission-briefing` | `7262314209` | `SOR_171` | 3 | aggression | plan |
| `keep-fighting` | `3058784025` | `SOR_169` | 2 | aggression | tactic |
| `outmaneuver` | `7366340487` | `SOR_221` | 3 | cunning | tactic |
| `attack-pattern-delta` | `1939951561` | `SOR_106` | 3 | command, command | tactic |
| `power-failure` | `4323691274` | `SOR_170` | 2 | aggression | tactic |
| `change-of-heart` | `1626462639` | `SOR_224` | 6 | cunning | gambit |
| `sneak-attack` | `3426168686` | `SOR_219` | 2 | cunning | trick |
| `recruit` | `3407775126` | `SOR_123` | 1 | command | supply |
| `strike-true` | `1349057156` | `SOR_127` | 3 | command | tactic |

JSON: `forceteki/test/json/Card/<scene-slug>.json`.
Implementations: `forceteki/server/game/cards/01_SOR/events/<PascalCase>.ts`.
Existing engine tests: `forceteki/test/server/cards/01_SOR/events/<PascalCase>.spec.ts`.
All ten are non-unique event cards with no printed keyword. No card in A01 is a
"choose two" modal card. Arena/player/recipient choices and optional search
selection remain explicit choices, rather than modal branches.

Important supporting sources:

- [Player.getPenaltyAspects](../forceteki/server/game/core/Player.ts): multiset
  aspect matching; every missing symbol adds 2. Arena units supply no aspects in
  these examples.
- [PlayCardSystem](../forceteki/server/game/gameSystems/PlayCardSystem.ts) and
  [PlayCardResourceCost](../forceteki/server/game/costs/PlayCardResourceCost.ts):
  Sneak Attack plays a card and pays its adjusted cost; it is not free placement.
- [TakeControlOfUnitSystem](../forceteki/server/game/gameSystems/TakeControlOfUnitSystem.ts):
  control is separate from ownership; token upgrades follow the host's control.
  Leader units cannot change control and can instead be defeated on a later
  attempted control change.
- [SearchDeckSystem](../forceteki/server/game/gameSystems/SearchDeckSystem.ts):
  defaults to selecting up to one; searching fewer than five cards is possible
  with a short deck; unchosen cards go to the bottom in random order, not into
  discard. Other effects can modify search count, so a recording's count is not
  established by the printed five.
- [RevealAndDrawSystem](../forceteki/server/game/gameSystems/RevealAndDrawSystem.ts):
  Recruit reveals and draws the selected card; the other searched faces remain
  private. The engine displays the revealed selection to the opponent.
- [DrawSystem](../forceteki/server/game/gameSystems/DrawSystem.ts): an attempted
  missing draw deals 3 damage to the drawing player's base. None of the primary
  examples has a short deck.
- [DelayedEffectSystem](../forceteki/server/game/gameSystems/DelayedEffectSystem.ts):
  Change of Heart and Sneak Attack register a later once-only effect; the
  immediate scene does not advance the game into regroup.

## 2. Minimum semantic extensions

Reuse `shield`, `draw`, `ready`, `exhaust`, `buff`, `defeat`, `damage`, `cost`, and
`pay` with their established meanings. Add meanings only for actions absent from
the nineteen-primitive baseline:

| Meaning | Proposed primitive / route | Constant visible sign |
| --- | --- | --- |
| Play a card | `play`, hand → its printed arena | An intact real card leaves hand and occupies one arena slot; a ready entry is upright from arrival. This is neither draw nor resource. |
| Change controller | `control`, old controller's arena → new controller's same arena | The same intact card crosses the table boundary with a controller arrow; owner stays named separately when known. No hand/discard waypoint, ready reset, or new instance. |
| Search a limited part of a deck | `search`, deck top → temporary search presentation | A counted search shelf/lens; it does not change hand/deck counts by itself or publicly expose every face. |
| Reveal a selection | Reveal sub-beat of `search`, no zone change | One explicitly known selected face turns toward both players before its separate draw movement. |
| Reinsert unchosen search cards | Bottom/reorder sub-beat of `search`, search presentation → deck bottom, random order | A bottom insertion bracket and a random-order mark. No discard waypoint and no claim that the whole deck shuffled. |
| Register a later consequence | `delay`, no immediate movement | A compact outlined clock with `REGROUP START` and the future consequence; never a premature death or second controller move. |

The integrated API uses four new kinds: `play`, `control`, `search`, and `delay`.
`search.cards` is the explicitly staged looked group; `search.card` is its
revealed selection, followed by a separate `draw` receipt. Reveal and bottom
reinsertion keep their own visible signs within that composite primitive.
`cue.playCost` supplies a verified source-event payment for explicit showcases;
only the separate nested unit payment appears as a `pay` receipt. Recorded cues
do not invent either split. The following information must be representable
without parsing a long caption:

1. A movement's explicit `from` and `to` seat/zone, with measured source and
   arrival slots. `outcome.seat` alone cannot identify both sides of control.
2. Stable recipient instance ID, and optional host ID for an upgrade. A unit's
   event damage can name its **damage source** separately from `cue.source`
   (the played event). Strike True needs both.
3. Known owner versus current controller. Existing `CardRef` only has
   `id/n/s`; the containing arena identifies controller but does not establish
   ownership. A staged sidecar may store both. Recorded ownership must remain
   unknown unless the recording supplies it.
4. Pending obligations with stable `id`, source instance, target instance,
   `trigger: regroup-start`, consequence, and `incarnation` lifecycle identity. A new
   playback nonce must not generate a new card or obligation identity.
   Leaving play invalidates the old pending effect. Replaying the same physical
   card from hand does not restore it: the Sneak Attack engine test proves this.
5. Defeated token upgrades **cease to exist**; ordinary upgrades enter their
   owner's discard. `defeat` therefore needs recipient kind/destination rather
   than blindly sending every defeated object to a pile.
6. Complete legal clauses can specify `duration: phase` or a later trigger.
   A `regroup-start` trigger is not merely another duration of a stat buff.
   Selected-player draw and multiple distinct recipients must also be expressible.

Author deliberate `before` and `after` snapshots for these showcases. A staged
result may be calculated from the fixture recipe, but it must not acquire game
truth by blindly applying every possible clause in `cardAbilities`. The current
`resolvePreviewState` requires focused extensions for hand → arena, control,
real multi-card draws, host-stat rollback after upgrade removal, and pending
statuses. It currently handles none of the first two and generates unknown
cards for a two-card draw. Do not convert a replay into a preview or apply these
fixture reducers to a recording.

Current `outcomes.ts` compares stable instances and can already observe most
simple stat/exhaustion/draw changes. It lacks control and hand → arena receipts,
misses vanished tokens that have no discard reference, and cannot observe a
deck search, reveal prompt, cost split, or pending regroup effect from snapshots.
Current `detect.ts` cues played events only; a later regroup consequence needs
its own explicitly attributed recorded cue if it is to receive an animation.
The board can still render a later recorded state correctly without that cue.

Keep pending statuses and ownership presentation after the overlay is gone.
Staged future snapshots are separate selectable follow-ups; **Final board** for
the event is always the immediate after state. No timer may apply the future
consequence to a live recording or an immediate staged final board.

## 3. Shared legal fixture, stable identities and payments

These are independent late-game examples, not ten consecutive plays. Start at
round 9, action phase, initiative p1. All units were already in play before this
event; no When Played abilities are silently triggered by fixture construction.
All ownership defaults to the same seat as the initial containing side, except
where a later control movement is explicitly specified.

Use this complete common `Snapshot`; replace `EVENT_NAME`, `EVENT_PRINT`, and
`SCENE_SLUG` with the identity table. Apply a card's stated before overrides,
then its exact after edits. Every unspecified field/array member retains the
common value; no random or nonce-derived IDs are permitted.

The implementation adds each card's explicit `owner` and each arena unit's
`incarnation: <instance-id>:entry-1`. Its staged `knownDeck` arrays contain the
named private prefixes below plus stable unknown-card references for the rest;
their lengths equal the stated deck counts. Unknown remainder faces stay
unknown. The selected card's stable ID persists when it leaves that deck.

```json
{
  "round": 9,
  "phase": "action",
  "initiative": "p1",
  "players": {
    "p1": {
      "name": "Rebel Alliance",
      "base": { "id": "a01:p1:base", "n": "Echo Base", "s": "SOR_024", "hp": 30, "d": 9 },
      "leader": { "id": "a01:p1:leader", "n": "Luke Skywalker: Faithful Friend", "s": "SOR_005", "dep": 0, "x": 0 },
      "res": { "ready": 10, "total": 10 },
      "hand": [{ "id": "a01:SCENE_SLUG:event", "n": "EVENT_NAME", "s": "EVENT_PRINT" }],
      "deck": 27,
      "discard": [],
      "ground": [
        { "id": "a01:p1:marine", "n": "Battlefield Marine", "s": "SOR_095", "p": 3, "h": 3, "d": 1 },
        { "id": "a01:p1:defender", "n": "Echo Base Defender", "s": "SOR_098", "p": 4, "h": 3, "d": 0, "sn": 1 }
      ],
      "space": [{ "id": "a01:p1:xwing", "n": "Alliance X-Wing", "s": "SOR_237", "p": 2, "h": 3, "d": 0 }]
    },
    "p2": {
      "name": "Galactic Empire",
      "base": { "id": "a01:p2:base", "n": "Capital City", "s": "SOR_020", "hp": 30, "d": 6 },
      "leader": { "id": "a01:p2:leader", "n": "Darth Vader: Dark Lord of the Sith", "s": "SOR_010", "dep": 0, "x": 1 },
      "res": { "ready": 7, "total": 10 },
      "hand": [{ "id": "a01:p2:takedown-hand", "n": "Takedown", "s": "SOR_077" }],
      "deck": 29,
      "discard": [],
      "ground": [
        { "id": "a01:p2:trooper", "n": "Death Trooper", "s": "SOR_033", "p": 3, "h": 3, "d": 0 },
        { "id": "a01:p2:wampa", "n": "Wampa", "s": "SOR_164", "p": 4, "h": 5, "d": 1 }
      ],
      "space": [{ "id": "a01:p2:tie", "n": "TIE/ln Fighter", "s": "SOR_225", "p": 2, "h": 1, "d": 0 }]
    }
  }
}
```

Abbreviations below: `M` = `a01:p1:marine`, `D` = `a01:p1:defender`,
`X` = `a01:p1:xwing`, `T` = `a01:p2:trooper`, `W` = `a01:p2:wampa`,
`F` = `a01:p2:tie`. An ID is a physical instance identifier, not an ownership
claim. Change of Heart deliberately retains W's ID on p1's side.

Verified real-card facts from installed JSON:

| Face / fixture | Base power / HP | Arena / relevant facts |
| --- | --- | --- |
| Battlefield Marine `SOR_095` | 3 / 3 | Ground; command + heroism; no ability/keyword |
| Echo Base Defender `SOR_098` | 4 / 3 | Ground; command + heroism; Sentinel |
| Alliance X-Wing `SOR_237` | 2 / 3 | Space; heroism; no ability/keyword; equivalent `LAW_253` |
| Death Trooper `SOR_033` | 3 / 3 | Ground; villainy + vigilance; When Played damage already resolved before fixture; equivalent `SHD_030`, `SEC_030` |
| Wampa `SOR_164` | 4 / 5 | Ground; printed cost 4, aggression, Overwhelm; equivalent `LOF_164` |
| TIE/ln Fighter `SOR_225` | 2 / 1 | Space; villainy; no ability/keyword |
| Academy Training `SOR_120` | upgrade +2 / +2 | Ordinary upgrade; no ability/keyword |
| Entrenched `SOR_072` | upgrade +3 / +3 | Ordinary upgrade; attached unit cannot attack bases |
| Shield, `s: null`, `t: 1` | upgrade +0 / +0 | Token upgrade; prevents the next damage and is defeated |
| Experience, `s: null`, `t: 1` | upgrade +1 / +1 | Token upgrade; persistent stats |

Echo Base supplies command; undeployed Luke supplies vigilance and heroism.
Therefore p1 supplies exactly `[command, vigilance, heroism]`, including only
one command symbol. The undeployed Force leader does not establish a Force
unit, and none of A01's effects has a Force prerequisite.

The exact shared after-operation is: remove `a01:<slug>:event` from p1 hand,
put that same minimal `id/n/s` reference in p1 discard once, and spend the event
payment below. The event is not a resource or a drawn/discarded-hand outcome.
All after states retain `round: 9`, `phase: action`, and p2's 7/10 resources.

| Event | Cost calculation on this board | p1 ready resources after complete immediate resolution |
| --- | --- | ---: |
| Moment of Peace | 1 + 0 penalty | 9 / 10 |
| Mission Briefing | 3 + 2 for missing aggression | 5 / 10 |
| Keep Fighting | 2 + 2 for missing aggression | 6 / 10 |
| Outmaneuver | 3 + 2 for missing cunning | 5 / 10 |
| Attack Pattern Delta | 3 + 2 for the second missing command symbol | 5 / 10 |
| Power Failure | 2 + 2 for missing aggression | 6 / 10 |
| Change of Heart | 6 + 2 for missing cunning | 2 / 10 |
| Sneak Attack | Event: 2 + 2 for missing cunning = 4; nested Wampa: 4 + 2 for missing aggression − 3 = 3 | 3 / 10 (7 spent in two distinct payments) |
| Recruit | 1 + 0 penalty | 9 / 10 |
| Strike True | 3 + 0 penalty | 7 / 10 |

Only Sneak Attack has a discount in this batch, and it discounts the **unit**,
not its source event. A cheaper in-aspect unit may cost zero after the reduction;
no calculation or displayed payment may become negative. Recorded ready-resource
loss alone cannot prove either of Sneak Attack's separate payments.

## 4. Card specifications

Durations below are initial authoring targets. Use one deterministic Anime.js
clock. Samples at 18%, 46%, 72%, and 90% should contain anticipation, legible
action, intermediate/finished outcome, and a held result respectively. Leave
roughly the last quarter for reading; the overlay then disappears onto the
explicit after snapshot. A small effect need not fill three seconds with sparks.

### 4.1 Moment of Peace — SOR_073

**Complete rules.** Choose a unit in either arena controlled by either player;
give it one Shield token. A deployed leader is a unit. No friendly-only,
non-leader, power, trait, damage, or existing-Shield restriction. Shield tokens
stack. No healing, stat increase, attack, exhaust, or delayed clause.
Implementation: [MomentOfPeace.ts](../forceteki/server/game/cards/01_SOR/events/MomentOfPeace.ts).

**Primary example.** `Shield the damaged Battlefield Marine; no damage is healed.`
Before = common snapshot, no overrides. Choose M. After = shared payment/disposal
plus append exactly this to M's upgrades:

```json
{ "id": "preview:moment-of-peace:0:shield:0", "n": "Shield", "s": null, "t": 1 }
```

M remains p3/h3/d1, ready, in p1 ground; remaining HP remains 2. Both bases,
all other cards, deck/hand counts except the event, and arena sizes stay exact.
The Shield survives natural completion and replay reset does not stack another.

**Signature: six quiet shutters; 2,200 ms.** Anticipation: a thin broken hexagon
forms just outside M, leaving a readable gap rather than washing out its face.
Action: six shallow blue panels close into one continuous shell in a clockwise
sequence, with the last panel meeting the first around 46%. A small `1 SHIELD`
badge settles toward the real attachment position. Hold one closed shell and
the real token; no green mending lines, HP tick, impact shake, or whole-table flash.

**Replay evidence.** A same-instance M with one additional identified Shield
supports a shield receipt. No guessed healing. An absent after snapshot or an
ambiguous id-less duplicate supplies no target-specific claim.

**Assertions / independent check.** Token count 0 → 1; token ID stable across
nonce changes; M stats/damage/exhaustion unchanged; after resources 9/10 and
discard contains the source once. Test a previously shielded enemy space unit
getting a second Shield as a separate legal target case. The reviewer must read
"protection added" from the shell and see the token on the ordinary completed
board, with M still visibly damaged.

### 4.2 Mission Briefing — SOR_171

**Complete rules.** Choose a player, including yourself or the opponent; that
player attempts to draw exactly two cards from their own deck to their hand.
No hand discard, public reveal, unit requirement, or attack. Standard missing
draw damage applies with fewer than two cards available; animate only the
observed actual draw and base damage in such a replay.
Implementation: [MissionBriefing.ts](../forceteki/server/game/cards/01_SOR/events/MissionBriefing.ts).

**Primary example.** `Choose the opponent: their deck → hand, two cards.`
Before = common snapshot. Explicit private deck manifest for this demonstration:
first p2 card `{id: "a01:mission-briefing:p2:draw:0", n: "Open Fire", s: "SOR_172"}`;
second `{id: "a01:mission-briefing:p2:draw:1", n: "Wampa", s: "SOR_164"}`.
These are different copies from W and the event source. The other 27 deck cards
are untouched; the deck manifest is staged evidence, not a new replay field.

After = shared payment/disposal; p2 deck 29 → 27; p2 hand contains its original
Takedown plus those two exact references (1 → 3). p1 deck remains 27 and p1 hand
contains no card. No base damage or arena change. The two drawn cards are not
played, and ordinary drawing does not make their faces public.

**Signature: two-file dossier; 2,500 ms.** A two-slot holographic folder opens
at the chosen player's deck. Its two tabs launch intact card backs one after
the other along parallel arcs into that same player's hand. Count `1`, then `2`
at arrival; hold `DRAW 2` at the destination. The source event's faint connector
indicates p1 caused a p2 draw. Do not launch from p1 deck or expose faces during
flight merely because an omniscient replay knows them. The ordinary final hand
may show precisely the faces allowed by its current visibility policy.

**Replay evidence.** New p2 hand references corroborated by p2 deck loss give
two draws. The observer already examines both seats, but the ability scope must
be `chosen-player`, not `own-hand`. Hidden/id-less hands may only support an
aggregate count if an actual count field is supplied; never invent two identities.

**Assertions / independent check.** Deck −2, chosen hand +2, nonchosen deck/hand
unchanged except p1 event; exact new IDs/faces; no new unit or reveal receipt;
resources 5/10. Test choosing p1 separately and a one-card-deck recording with
one draw and observed 3 base damage. Reviewer follows both moving backs into
the opponent's hand and sees final count 3, deck 27, no undeclared public reveal.

### 4.3 Keep Fighting — SOR_169

**Complete rules.** Ready a unit with **current** power at most 3, including
temporary modifiers and upgrades. Either side, either arena, and a deployed
leader are legal. No attack follows. Being ready already does not create a new
ready-state change; engine tests show the event can simply resolve when no
exhausted target benefits. No stat, damage, heal, or trait clause.
Implementation: [KeepFighting.ts](../forceteki/server/game/cards/01_SOR/events/KeepFighting.ts).

**Primary example.** `Ready the exhausted 3-power Battlefield Marine; no attack.`
Before = common snapshot with M `x: 1`. After = shared payment/disposal with M's
`x` absent. M remains p3/h3/d1 in p1 ground. All other ready/exhausted poses,
counts, tokens, damage and stats stay unchanged.

**Signature: restart pulse; 2,200 ms.** Two short stalled chevrons appear beside
M's dimmed action edge. A precise teal pulse runs up the card spine, lifts it
upright with aspect-compensated rotation, and lights one action pip. Hold
`3 POWER · READY` adjacent to M, then leave the ordinary upright card. No lunge,
enemy target, damage number, or buff arrow. A restrained amber spark at the
source may set the card's tone; readiness retains the language's motion/sign.

**Replay evidence.** A same-phase M `x:1` → absent/0 supports ready. Regroup
readiness is not this card's receipt. A known legal selection with unchanged
pose is not a new ready outcome.

**Assertions / independent check.** M ready at natural and held completion,
resources 6/10; no damage or stat changes. Reject a currently 4-power Marine
with one Experience even though its printed power is 3; accept a unit reduced
to 3 from a higher printed power. Reviewer sees the entire card rotate without
flattening on 390×844 and observes no attack after the restoration.

### 4.4 Outmaneuver — SOR_221

**Complete rules.** Choose ground or space; exhaust **every unit in the chosen
arena on both sides**, including deployed leaders. Units already exhausted
remain exhausted. Other arena, bases, undeployed leaders, upgrades as separate
objects, resources and hands are unaffected. An empty chosen arena is a legal
no-change choice when other units exist (covered by the engine tests).
Implementation: [Outmaneuver.ts](../forceteki/server/game/cards/01_SOR/events/Outmaneuver.ts).

**Primary example.** `Ground chosen: all four ground units on both sides exhaust.`
Before = common snapshot with W `x: 1` already. After = shared payment/disposal
and M, D, T, W each `x: 1`. X and F remain ready in space; p1 undeployed Luke
remains x0 and p2 undeployed Vader x1. No unit moves or takes damage. This is
three newly exhausted units and one already exhausted unit, not four changes.

**Signature: arena pinwheel arrest; 2,700 ms.** Anticipation: measured ground
boundaries on both sides connect into one open hooked ribbon; clearly label
`GROUND`. The ribbon curls around the four actual footprints, never across the
space row. One clean sweep rotates M, D and T sideways; W gets a brief matching
outline but no second rotation. Per-card amber action indicators dim. Hold all
four exhausted poses with a small `GROUND · BOTH SIDES` scope marker. Avoid a
missile streak, damage burst, or a central badge that hides the opposing rows.

**Replay evidence.** Three same-phase x changes support three exhaust receipts.
A recorded arena-choice prompt can support the scope marker. Without that
choice, highlight actual changes only; their locations may not disambiguate
which arena was chosen when no card changed. Do not manufacture a fourth receipt.

**Assertions / independent check.** Ground x values `[1,1,1,1]`; space x values
unchanged; all stats, damage, identities and counts unchanged; resources 5/10.
Test choosing space, a deployed leader in the chosen arena, and an empty arena.
Reviewer sees both sides caught by one scope and the ready space units after
completion, including on mobile.

### 4.5 Attack Pattern Delta — SOR_106

**Complete rules.** Give one friendly unit +3/+3 this phase; then **another**
friendly unit +2/+2 this phase; then a **third distinct** friendly unit +1/+1
this phase. Targets may span arenas and include deployed leaders. A target
cannot receive multiple clauses. The engine resolves available clauses with
one or two legal friendly units rather than requiring three to play the event.
The buffs expire at the end of the action phase; they are not Experience tokens,
healing, permanent HP, or attack-only bonuses. No attack is instructed.
Implementation: [AttackPatternDelta.ts](../forceteki/server/game/cards/01_SOR/events/AttackPatternDelta.ts).

**Primary example.** `Marine +3/+3; Defender +2/+2; X-Wing +1/+1 — this phase.`
Before = common snapshot. Select M, then D, then X. After = shared
payment/disposal plus:

| Stable target | Before p/h/d | Immediate after p/h/d | Persistent presentation status |
| --- | --- | --- | --- |
| M | 3 / 3 / 1 | 6 / 6 / 1 | `+3/+3 · phase` |
| D | 4 / 3 / 0 | 6 / 5 / 0 | `+2/+2 · phase` |
| X | 2 / 3 / 0 | 3 / 4 / 0 | `+1/+1 · phase` |

Attach one `status` entry per card with `kind: buff`, `duration: phase`, and its
exact label. Upgrades/token counts remain empty. D retains Sentinel. All three
stay ready. A separate staged phase-end follow-up removes only these bonuses
and statuses, restoring the initial p/h while preserving damage; do not claim
that the immediate final board has already expired them.

**Signature: descending delta formation; 2,900 ms.** Three small command nodes
identify the selected footprints across ground and space. A triangular path
assembles from source → M → D → X without moving the units. Three paired stat
columns rise in actual rules order, displaying `+3/+3`, `+2/+2`, `+1/+1`; make
all three bonuses readable together by 72%. Their sizes descend but their text
remains equal legibility. Hold the triangle and three phase markers; no six
Experience tokens, flight formation, attack arrows, or damage to the enemy.

**Replay evidence.** Same-phase net stat deltas can be observed per instance.
They may include triggered or other simultaneous modifiers; display those
actual deltas, not always 3/2/1. Target prompt IDs are needed to preserve which
selection received which clause when outcomes are offset. Phase duration comes
from explicit rules/staged evidence; ordinary stat differences alone do not
prove a permanent token.

**Assertions / independent check.** Exactly three distinct friendly IDs with
the three stat pairs; d unchanged; zero Experience; phase statuses persist after
overlay; resources 5/10. Verify one- and two-recipient cases without selecting
the same unit twice. Reviewer reads the descending three-part plan without a
caption and sees all final numbers, including X in space. On mobile labels must
not merge into a single strip across opposing rows.

### 4.6 Power Failure — SOR_170

**Complete rules.** Choose one unit with upgrades, then defeat any number of
upgrades attached to **that one unit**. Either side, either arena and deployed
leaders are allowed. The selected-unit resolver is optional and the upgrade
resolver permits choosing none; zero, some, or all are valid. The selection
may include token upgrades. No direct host damage or defeat is instructed.
Removing stat upgrades may change its stats and can independently cause a
lethal remaining-HP consequence; show that only when supported. Ordinary
upgrades go to their owners' discard, tokens cease to exist.
Implementation: [PowerFailure.ts](../forceteki/server/game/cards/01_SOR/events/PowerFailure.ts).

**Primary example.** `Defeat Academy Training, Entrenched and Shield on Wampa; keep its Experience.`
Before = common snapshot with W p10/h11/d1/x1 and this exact attachment list:

```json
[
  { "id": "a01:power-failure:academy", "n": "Academy Training", "s": "SOR_120", "t": 0 },
  { "id": "a01:power-failure:entrenched", "n": "Entrenched", "s": "SOR_072", "t": 0 },
  { "id": "a01:power-failure:shield", "n": "Shield", "s": null, "t": 1 },
  { "id": "a01:power-failure:experience", "n": "Experience", "s": null, "t": 1 }
]
```

Every attachment's owner/controller is p2. The stats are Wampa's 4/5 plus 2/2,
3/3, 0/0, and 1/1; these are legal unit upgrades. After = shared payment/disposal;
W stays on p2 ground, exhausted, d1, now p5/h6 (5 remaining HP), with only the
original Experience attached. The two ordinary selected upgrade references
enter p2 discard (0 → 2), stripped to `id/n/s`. The selected Shield exists in no
final zone, including discard. No second host is touched and no damage is dealt.

**Signature: severed circuit branches; 2,800 ms.** Show a short branching circuit
anchored to W's real attachment stack. Mark the three selected branches, leave
Experience lit. At action, each chosen upgrade separates from its host: two
small intact face ghosts fracture at their own footprint and arc to p2 discard;
the Shield shell splits and vanishes locally. The host's face stays whole while
stats step 10/11 → 5/6; the 1 damage marker stays. Hold `3 UPGRADES DEFEATED`,
`2 → DISCARD`, and the retained Experience without stacking all badges on the
host name. No whole-unit death burst or arbitrary numeric damage.

**Replay evidence.** Identified ordinary upgrades in discard corroborate defeat;
host net stat loss is separately observable. A vanished token has no discard
receipt in the current observer. For a specific token-defeat claim require an
explicit selected token ID/resolution receipt plus its observed absence. Absence
alone might be Shield consumption by another recorded consequence. Without that
evidence, the ordinary after snapshot shows the missing attachment without
an attributed token-defeat animation. The current replay format provides no
explicit resolution evidence for this, so the observer deliberately emits no
vanished-token defeat receipt, even when the played card has a defeat clause
and the host survives. The explicit staged selection still animates the token.
Net stat loss from upgrade removal must not be labeled `THIS PHASE`.

**Assertions / independent check.** Selected IDs absent from W; Experience same
ID; p5/h6/d1/x1; W still present; exactly two p2 discard refs and no Shield;
resources 6/10. Verify zero selection, upgrades split across hosts rejected,
another host untouched, and host lethal after HP-upgrade removal in a separate
recorded fixture. Reviewer sees the attachments—not the Wampa—lose power and
finds only the two physical upgrades in the completed pile.

### 4.7 Change of Heart — SOR_224

**Complete rules.** Take control of one non-leader unit in either arena; target
selection is not restricted to enemy units. Register a delayed effect: at the
start of regroup, its **owner**, not necessarily its former controller, takes
control of it. The unit does not enter hand, change arena, ready, heal, reset
damage, replay When Played, or change physical identity. Attachments remain
attached; token upgrades follow its control. Ownership of ordinary attachments
is separate. The delayed effect does not return a card already outside play.
The engine tests additionally cover a unit later becoming a leader via a pilot:
on a would-be control change it is defeated instead. Initially leader units,
including units currently classed as leaders by piloting, are excluded.
Implementation: [ChangeOfHeart.ts](../forceteki/server/game/cards/01_SOR/events/ChangeOfHeart.ts).

**Primary example.** `Take the exhausted Wampa; owner p2 regains control at regroup start.`
Before = common snapshot with W `x:1`; explicit sidecar for W:
`{owner: p2, controller: p2, incarnation: "a01:p2:wampa:entry-1"}`. No attachments are staged
for the primary example. After = shared payment/disposal and move the **same W
object identity** from p2 ground to the end of p1 ground; no copy remains on p2.
W remains p4/h5/d1/x1. Sidecar controller becomes p1, owner remains p2; attach
one stable pending obligation:

```json
{
  "id": "a01:change-of-heart:regroup:W",
  "sourceId": "a01:change-of-heart:event",
  "targetId": "a01:p2:wampa",
  "incarnation": "a01:p2:wampa:entry-1",
  "trigger": "regroup-start",
  "kind": "return-control",
  "returnController": "p2"
}
```

Immediate arena sizes: p1 ground 2 → 3, p2 ground 2 → 1; hands/decks/discards
except the source event unchanged. A distinct staged **regroup-start** follow-up,
after resolving the pending effect but before normal regroup ready/draw/resource
steps, moves W back to p2 ground with its same stats/damage/x and clears this
obligation. Never call a snapshot after normal regroup steps identical to this
boundary snapshot: those steps independently change resources, readiness and hands.

**Signature: allegiance bridge; 3,000 ms.** A narrow two-seat bridge projects
between W's measured old position and its arrival slot in p1 **ground**. One
controller border changes from the old seat mark to the new seat mark as the
intact exhausted card slides across; a small fixed `OWNER: P2` tab remains.
At landing, hold `P1 CONTROLS` with an outlined clock `P2 AT REGROUP START`.
Do not straighten the unit, teleport through hand, use defeat fractures, or
draw the delayed return arc in this immediate scene. The optional later scene
reverses the bridge to the owner only when its own staged/recorded transition exists.

**Replay evidence.** Same stable instance in the same arena on a different side
corroborates control movement. Existing snapshots do not record owner or pending
effects; do not infer owner from an ID prefix or previous side. Display the
observed controller destination, omit owner/future result badges when unsupported,
and keep the delayed clause in the separate rules description. A later same-ID
side movement is observable but requires explicit trigger/source attribution to
call it Change of Heart's return. Do not attach it to the original event span.

**Assertions / independent check.** Exactly one W across all zones; immediate
controller p1/owner p2; same ID/p/h/d/x; ground only; resources 2/10; one pending
status visible after overlay. Check future owner restoration, target defeated
before regroup, a target whose owner differs from old controller, and a piloted
leader target rejected. Reviewer must see an exhausted existing card change
sides and still be present on p1's ordinary immediate final board with its clock,
then inspect the separate future boundary without conflating the two.

### 4.8 Sneak Attack — SOR_219

**Complete rules.** Play a unit from your own hand; it costs 3 less, applying
ordinary aspect penalties and other legal adjustments, and enters play ready.
The source event must also be paid. This is a normal card play, so When Played,
uniqueness, entry and other triggers can matter. It is not an attack, damage,
free summon, opponent-hand play, discard recovery, or pilot-as-upgrade play.
If the played card is still in play after resolution, register defeat at the
start of regroup. The effect is tied to that entry into play; prior defeat or
return to hand invalidates it. Replaying the same card is a new entry and is not
defeated by the old obligation. If uniqueness immediately defeats the played
copy, no pending obligation is installed on that absent copy.
Implementation: [SneakAttack.ts](../forceteki/server/game/cards/01_SOR/events/SneakAttack.ts).

**Primary example.** `Pay 4 for Sneak Attack; pay 3 for Wampa after −3; it enters ready and is defeated at regroup start.`
Before = common snapshot with an additional p1 hand reference
`{id: "a01:sneak-attack:wampa-hand", n: "Wampa", s: "SOR_164"}`. This is a
different physical Wampa from W. Explicit owner/controller p1. No other discount
provider, entry trigger, uniqueness conflict, or hidden prerequisite is staged.

After = shared event disposal/payment (10 → 6 ready), then pay exactly 3 more
(6 → 3), remove the same Wampa ID from hand, and append it to p1 ground as:

```json
{ "id": "a01:sneak-attack:wampa-hand", "n": "Wampa", "s": "SOR_164", "p": 4, "h": 5, "d": 0 }
```

Its `x` is absent: it enters ready, rather than entering exhausted and then
receiving a fictional ready action. p1 hand 2 → 0; p1 ground 2 → 3; deck stays
27; p1 discard contains only the event. Pending obligation:

```json
{
  "id": "a01:sneak-attack:regroup:wampa:entry-1",
  "sourceId": "a01:sneak-attack:event",
  "targetId": "a01:sneak-attack:wampa-hand",
  "incarnation": "a01:sneak-attack:wampa-hand:entry-1",
  "trigger": "regroup-start",
  "kind": "defeat"
}
```

A separate staged regroup-start follow-up, before normal regroup ready/draw
steps, removes this Wampa to p1 discard and clears the obligation. The ordinary
immediate final board keeps the ready Wampa and the pending marker. No attack
is performed by either Wampa in this example; Overwhelm is not triggered.

**Signature: hand shutter infiltration; 3,100 ms.** Begin at the actual selected
hand card. Two shallow shutters expose a concealed route to one empty ground
arrival slot. Present distinct compact cost beats `EVENT 4` and `UNIT 6 → 3`;
the latter is the adjusted Wampa cost, not a resource gain. The intact Wampa
slides rapidly through the route and lands upright, relighting its entry-ready
indicator. Hold `PLAYED READY` and outlined `DEFEAT AT REGROUP START`. A single
trailing streak may sell the ambush, but no unit lunge, impact number, opposing
target, smoke covering its face, or immediate skull/removal animation.

**Replay evidence.** Same-instance hand → arena with its observed final stats
and exhaustion supports `play`. Ready entry can be stated only if the recording
captures entry status or unambiguous intermediate evidence; a final exhausted
pose could include a follow-up attack. Total resource loss does not prove the
discount or split. Snapshots alone do not record pending defeat. If nested play
is classified as its own action, inspect the complete event/child span before
claiming the unit and source event settled together; do not duplicate a play cue.

**Assertions / independent check.** Two hand departures with exact same IDs in
discard/arena; unit p4/h5/d0 ready; both payments total 7 once, total resources
unchanged; one stable pending status; no damage or attack receipts. Verify
insufficient resources after event cost, cost floor zero, other printed arena,
When Played effects in a separate recorded fixture, uniqueness removal, and
return/replay invalidating the old obligation. Reviewer must distinguish the
event from the unit, read the two payments, and see the ready unit on the
completed board for the rest of the action phase.

### 4.9 Recruit — SOR_123

**Complete rules.** Search the top five cards of **your own deck** for up to
one unit; reveal the selected unit and draw that specific card. Put all unchosen
searched cards on the bottom of your deck in random order. The engine offers
`Take nothing` even with a legal unit; no unit found/selection declined draws
zero and reinserts all searched cards. A short deck searches only what exists;
other explicit effects can change the search count. Unit cards may be either
arena and need no particular trait, cost or aspect. Nothing is played, resourced,
milled, discarded or recovered. Revealing one selection does not reveal all five
to the opponent.
Implementation: [Recruit.ts](../forceteki/server/game/cards/01_SOR/events/Recruit.ts).

**Primary example.** `Search top 5; reveal and draw Battlefield Marine; randomize the other 4 at deck bottom.`
Before = common snapshot. Explicit staged p1 deck manifest, top first:

```json
[
  { "id": "a01:recruit:top:0", "n": "Open Fire", "s": "SOR_172" },
  { "id": "a01:recruit:top:1", "n": "Battlefield Marine", "s": "SOR_095" },
  { "id": "a01:recruit:top:2", "n": "Repair", "s": "SOR_074" },
  { "id": "a01:recruit:top:3", "n": "Alliance X-Wing", "s": "SOR_237" },
  { "id": "a01:recruit:top:4", "n": "Resupply", "s": "SOR_126" }
]
```

The remaining 22 cards keep their relative order and remain in deck. Choose
`a01:recruit:top:1`, not M (the existing arena Marine). After = shared
payment/disposal; p1 hand contains precisely this selected Marine reference,
deck 27 → 26; no new arena unit or p2 change. Explicit demonstration shuffle
permutation for the four **unchosen** cards is `[top:4, top:3, top:2, top:0]`
inserted after the untouched 22. This fixed sampled permutation makes review
deterministic; label random order, not this permutation as a rule. Their faces
stay private in the animation. Discard contains only the event.

**Signature: five-window selection shelf; 3,200 ms.** A compact shelf unfolds
from p1 deck with five face-down slots. A selection aperture settles on the
second slot, lifts one Marine, and turns **that one** face toward both seats.
Hold the reveal briefly before a clear deck → hand arc. Four remaining backs
close into a bundle, exchange positions with one random-order glyph, and slide
under the visible deck-bottom bracket. By 72%, hold `1 → HAND`, `4 → BOTTOM`
with the final counts. Never show a five-card hand fan, a discard cascade, all
five faces, or a whole-deck shuffle. On a narrow table, the shelf wraps/compacts
inside the measured deck region rather than covering the hand and source caption.

**Replay evidence.** The current snapshots expose no deck identities/order or
search set. New hand card plus deck loss one corroborates the draw (add a draw
clause to its vocabulary). It does not corroborate five searched, public reveal,
four bottom moves or randomized order. Exact search/reveal/reorder choreography
requires explicit prompt/resolution evidence with visibility. Without it, render
a modest deck focus and the observed one-card draw only, keeping the full rules
in the rules description. Known final hand identity alone is not a reveal receipt.

**Assertions / independent check.** Selected card is a unit among the initial
five; exact selected ID moves to hand; deck −1, hand replaces source 1 → 1;
other four retained at bottom as a set; untouched22 order preserved; zero mill,
defeat, discard-hand, play or p2 receipt; resources 9/10. Check Take nothing,
no-unit search, shorter deck, another legal unit selected, and lack of search
evidence in replay. Reviewer counts five searched backs, exactly one revealed
Marine and four bottom arrivals, then sees only one Marine in the ordinary hand.

### 4.10 Strike True — SOR_127

**Complete rules.** Choose a friendly unit in any arena as the damage source,
then an enemy unit in any arena as recipient; the friendly unit deals damage
equal to its **current** power. Arena matching, non-unique status, non-leader
status, readiness and attack legality are not required. Deployed leaders may be
source/recipient. This is ability damage, not an attack: no source exhaustion,
counterdamage, Sentinel targeting constraint, or Overwhelm combat spillover.
Ordinary damage prevention, defeat and triggered consequences can still apply.
The engine permits playing with no legal source/recipient and resolving without
the effect; show no invented target in that case.
Implementation: [StrikeTrue.ts](../forceteki/server/game/cards/01_SOR/events/StrikeTrue.ts).

**Primary example.** `Exhausted Marine deals its 3 power to Wampa; no attack or counterdamage.`
Before = common snapshot with M `x:1`. Choose M as source and W as recipient.
After = shared payment/disposal and W d1 → 4, p4/h5 unchanged (1 HP remaining).
M stays p3/h3/d1/x1. W remains ready; both stay in their original ground rows.
No defeat, Shield, bonus, healing, base damage or further exhaust change occurs.

**Signature: power-to-hit sightline; 2,400 ms.** A thin calibration line starts
at M's **power chip**, marks `3`, and locks onto W's measured footprint. Three
closely grouped pulse ticks carry one readable packet along that line, landing
as one focused hit. The damage marker advances 1 → 4 and `3 DAMAGE` settles
beside W. M never lunges, rotates or straightens; its exhausted posture remains
obvious. Hold the line briefly and W's surviving 1 HP. Scale impact below Open
Fire's battery burst and avoid a combat clash/counterstrike.

**Replay evidence.** Survivor damage delta 3 is directly observable. Source
power and target prompt IDs can identify M as the dealing unit; a before/after
damage delta alone does not identify the damage source. Preserve `cue.source`
as the event and a separate damage-source reference as M. Lethal minimal discard
references do not reveal final damage numbers; do not synthesize a numeric
damage receipt from the source power when only defeat was recorded.

**Assertions / independent check.** W survives d4; M x1/d1 unchanged; no attack
or exhaust receipt; source M and target W are different explicit IDs; resources
7/10. Check a source enhanced by upgrades/phase modifiers, legal cross-arena
damage, enemy/friendly target restrictions, Shield prevention, and a no-target
event. Reviewer reads a unit's 3 power becoming damage while that exhausted unit
stays stationary, then finds both surviving cards and their correct damage on
the completed board.

## 5. Integration and independent acceptance

Add the ten identities as a batch only after baseline handoff review. Suggested
ownership: one author for shared mechanics, then signatures/fixtures, with a
different reviewer. Do not split writers across the same integration file.
The relevant seams are `catalogue.ts`, `abilities.ts`, `showcase.ts`, `preview.ts`,
`previewCosts.ts`, `previewState.ts`, `outcomes.ts`, `detect.ts`, `types.ts`,
`CardEffectOverlay.tsx` and `primitives.tsx` under `studio/src/effects/`, plus the
minimum board presentation typing/rendering required for pending statuses.

Semantics/state checks before capture:

- Verify each identity/canonical print/all aliases/cost/aspects against installed
  JSON and matching implementation; unknown present prints cannot title-fallback.
  Rules grammar preserves all optional, distinct-target, owner, timing and
  destination clauses. Per-card checks above verify behavior, not just duplicated
  declaration strings.
- Build independent expected before/after fixtures from this document. Assert
  all IDs are unique across live zones (upgrades included), non-token card
  conservation, correct counts, damage ≤ HP for surviving staged units, and
  ready-resource bounds. The delayed cards have separate immediate/future states.
- Preserve before/cue immutability. Completing twice does not spend/draw/stack
  twice. Replay with a new nonce yields the identical ending IDs and obligations.
  Seeking backward restores before; switching scene/step cancels old completion.
  Check control/play movements at natural completion, 100%, interruption and reset.
- Replay fixtures must contain recorded snapshots for actual endings. Explicitly
  test unsupported hidden search details, missing owner/delay information, vanished
  token ambiguity, duplicate id-less units and unknown print IDs. No new numeric
  payment, search, damage or future-outcome claim from rules alone.
- Run `npm --prefix studio test` and `npm --prefix studio run build`. Review
  affected old scenes if any shared primitive or lifecycle contract changed;
  preserve their approved durations/compositions. This specification itself has
  no product implementation and does not establish those tests have passed.

Use `node studio/scripts/capture-effects.mjs --help` before capture. The inspected
script supports `--cards`, 18/46/72/90/100 frames, natural completion comparison
and a natural-completion image; do not assume that remains true after edits.
Use a fresh `results/card-effects-review/a01/<pass>/` directory with exact source
fingerprint, hashes, selected identity/caption/progress, viewport, example and
browser error log. Do not reuse a pass path after changing source. Freeze source
while capturing to avoid HMR resetting the selection.

The independent reviewer inspects four ordered effect frames **and** the
overlay-free natural completed board, comparing it against the explicit after
fixture. Natural completion must report `data-effect-state="settled"`, have no
overlay and match the held 100% state. The reviewer also watches live timing of
these ten new signatures, then replays/resets to check no cumulative changes.
Inspect a separate regroup-start follow-up for Change of Heart and Sneak Attack;
it never substitutes for their immediate final board.

Check 390×844 for Keep Fighting/Outmaneuver rotations, Delta's three targets,
Power Failure's dense attachments, Change of Heart's bridge/owner/pending label,
Sneak Attack's hand → arena arrival and payments, Recruit's five-slot shelf and
bottom insertion, and Strike True's source-to-target relation. Preserve actual
card aspect ratios through nonuniform SVG scaling. Verify changed playback
completes under reduced motion with the same immediate after state and no
automatic regroup effect.

Record readability / meaning / impact (0–5 each), first-pass failures and fixes.
Acceptance requires readability ≥4, meaning ≥4, impact ≥3, no material rules
contradiction, complete persistent state, no clipped primary information and
passing assertions. A focused, restrained shield or ready effect may earn impact
3 without a particle budget. Do not count source compilation, a generated
manifest, attractive 90% pixels or this specification as card acceptance.

After acceptance, update the ledger with actual model/effort, author and reviewer,
source fingerprint, tests, frame paths and any narrow measured skill correction.
The baseline twenty do not count toward effort reduction. Retain `xhigh` until
two successive newly authored ten-card batches pass 10/10 on their first
independent review with no semantic/state regressions; then trial the next lower
effort with the same evidence.
