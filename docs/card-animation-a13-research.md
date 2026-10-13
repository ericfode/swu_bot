# A13 read-only research packet

Preparation for the next ten-card spec, not an implementation or acceptance claim. Read-only sources are installed card JSON and the matching `forceteki/server/game/cards/03_TWI/events/` classes. Sole prints are TWI222,223,224,225,227,237,238,239,249,250. Current own Command/Vigilance/Heroism showcase costs, before optional or nested payments, are3,3,4,5,6,4,5,6,2,2.

| Identity | Primary distinction to preserve |
| --- | --- |
| Political Pressure | Opponent chooses whether to discard a random own-hand card or let the event player create two Droids; random card selection is distinct from the opponent's mode choice. Lack of a discardable hand changes the legal branch. |
| Unmasking the Conspiracy | Actual chosen own-hand discard licenses a private opponent-hand inspection and event-player-chosen opponent discard. The test title says random, but its clicks, implementation and recorded action are chosen. |
| Breaking In | Legal attack with attack-only+2/+0 and Saboteur; preserve actual damage/Shield/Sentinel outcomes without retaining the grant after combat. |
| Now There Are Two of Them | Exactly one controlled unit across both arenas; actual non-Vehicle hand unit shares a trait, played with discount5 and ordinary aspect penalties. Event and nested payment are separate. |
| Prisoner of War | Friendly captor, enemy nonleader non-Vehicle subject. Printed cost comparison is strict `<`; two Droids go to captor controller on the lower-cost branch. Capture and token receipt causality require explicit evidence. |
| Droid Deployment | Two fresh exhausted created Droids, no invented hand/deck movement or unit play. |
| Merciless Contest | Each player chooses their own nonleader unit; both actual choices and owner destinations survive the simultaneous result. A side with no eligible unit does not invent a sacrifice. |
| Execute Order66 | Six damage to every Jedi unit, both sides and arenas; actual causal defeats determine Clone creation under each defeated unit's controller. Surviving Jedi do not create Clones. |
| Heroes on Both Sides | Choose up to one Republic unit and up to one Separatist unit, regardless of controller; each chosen unit receives+2/+2 and Saboteur this phase. Zero or one choice is legal. A shared dual-trait subject needs explicit tested stacking semantics; different controllers are not required. Preserve wounds and ownership. |
| Sword and Shield Maneuver | Each friendly Trooper gains Raid1 and each friendly Jedi gains Sentinel this phase. A dual-trait unit receives both; these do not change resting power immediately. |

## Existing recorded evidence

`results/card-effects-drafts/A13/existing-replay-inventory.json` indexes six actual plays across four identities; the raw before/after snapshots remain in the paths it records. Six identities have no existing example. No fresh games were generated.

- **Heroes**, `random-a-vs-random-b-3`,294→295: P1 pays2; P2 Corporate Shuttle `JTL_059/c65`, space, goes3/5→5/7 with no wound change and its existing Sentinel retained. Other two Heroes plays choose nothing or explicitly play anyway with no effect; each still pays2 and disposes of its source.
- **Sword**, same game323→324: P1 pays2, explicitly plays anyway with no effect; do not infer Trooper/Jedi grants from the title.
- **Unmask**, `random-b-vs-random-a-4`,144→146: P1 pays1 in that actual aspect context, selects its Unrefusable Offer `SHD_226/c38` for discard, then selects P2 One in a Million `SEC_053/c90` for discard. The record establishes chosen cards and movement; inspection visibility needs its own receipt in a rich staged scene.
- **Merciless**, `random-b-vs-random-c-11`,216→217: P2 pays3; P1 chooses V-19 Skirmisher `HMW_137/c0`, which leaves space and enters P1 discard. No P2 unit is removed. Do not manufacture a bilateral sacrifice from the rule's usual wording.

## Read-only test leads

Each identity has a corresponding `forceteki/test/server/cards/03_TWI/events/*.spec.ts`. In particular: Heroes covers zero/one/two selections; Now There Are Two covers0/1/2 current units and absent shared traits; Prisoner covers strict lower/equal cost branches; Execute Order66 covers both controllers and no Jedi. These are authoritative context, not newly executed acceptance tests. The engine remains untouched.
