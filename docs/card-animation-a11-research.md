# A11 initial rules research

Read-only preparation by root (GPT-6.1-sol / xhigh), 2026-10-12 UTC. These are the ten identities in `results/card-animation-catalogue/imported-a04/batches.json` index12 / old queue A007. They are not registered or accepted. Installed card JSON and all ten matching engine classes were read directly. No engine source changed.

| Canonical print | Card / JSON internal name | Printed cost / aspects | Luke + Echo play cost | Verified mechanic |
| --- | --- | --- | --- | --- |
| TWI_139 | Corner the Prey / corner-the-prey | 1 Villainy Aggression | 5 | Actual attack; attack-only power equals damage on defending unit at attack start; base damage contributes zero. |
| TWI_140 | Self-Destruct / selfdestruct | 2 Aggression Villainy | 6 | Defeat a current friendly unit, then if successful deal4 to a unit; dependent clause, either controller for second target. |
| TWI_153 | Bold Resistance / bold-resistance | 3 Aggression Heroism | 5 | Choose0..3 current units, either controller; one common trait must intersect across the entire set; +2/+0 this phase. |
| TWI_156 | Unlimited Power / unlimited-power | 6 Aggression Aggression | 10 | Four distinct unit targets receive4/3/2/1 simultaneously; targets can cross arenas/controllers. |
| TWI_170 | Daring Raid / daring-raid | 1 Aggression | 3 | Deal2 to an actual unit or base, either controller. Exact equivalent reprint SHD_178. |
| TWI_171 | Grenade Strike / grenade-strike | 2 Aggression | 4 | Mandatory first unit2; optional different second unit1 in the same actual arena, either controller. Engine uses related target resolvers in one event ability. |
| TWI_172 | Grim Resolve / grim-resolve | 2 Aggression | 4 | Actual ready non-leader attacks with Grit for this attack; resting power must restore afterward. Verify existing-Grit interaction before choosing a rich variant. |
| TWI_173 | Blood Sport / blood-sport | 3 Aggression | 5 | Damage2 to every actual ground unit, both sides including tokens/deployed leaders; space unaffected. |
| TWI_175 | Strategic Analysis / strategic-analysis | 5 Aggression | 7 | Draw3 actual deck cards; no public search/reveal invented. |
| TWI_176 | Caught in the Crossfire / caught-in-the-crossfire | 6 Aggression | 8 | Exactly two enemy units in the same arena each deal ability damage equal to current power to the other, simultaneously. This is not combat and neither attacks/exhausts merely for this effect. |

The matching engine classes are under `forceteki/server/game/cards/03_TWI/events/`, except DaringRaid under `02_SHD/events/`. JSON uses internal-name filenames, not numeric IDs. Corner's JSON erratum says defending unit; its engine excludes bases from the damage-at-start bonus. Corner's unit/base boundary is covered in the installed `03_TWI/events/CornerThePrey.spec.ts`. Crossfire's engine directly sets each opposing unit as the damage source, so defeat attribution is not the event player merely because they played the event; its installed Bravado interaction test names that distinction. Unlimited's JSON explicitly states simultaneous damage; target selection order does not make the damage sequential.

Proposed author split after A10: root owns Bold Resistance, Daring Raid, Grenade Strike, Blood Sport, Strategic Analysis. Main owns Corner, Self-Destruct, Unlimited, Grim, Crossfire. Existing damage, selected trait witnesses, owner cleanup, exact attack and attack-only expiry seams should be reused where justified. New semantics needing a compact contract: common trait across the entire selected set; actual damage-at-attack-start versus self wounds for Grit; simultaneous separate sources in Crossfire; dependent actual defeat for Self-Destruct. This research is not a final contract or authorization to overwrite a frozen source snapshot.

## Existing recorded availability

`/tmp/swu-a11-recorded-actions.cjs` classified existing demo actions by exact print/name aliases, output `/tmp/swu-a11-recorded-actions.json`:

- Grenade Strike: `random-a-vs-random-b-1.jsonl`, step335 through339.
- Self-Destruct: `random-c-vs-random-a-8.jsonl`, step244 through246.
- No existing match for the other eight identities.

This is availability only. Raw action/snapshot inspection and production replay checks remain required. No games were generated.

Further source check: `UnitProperties.ts:1046` gates Grit with `hasSomeKeyword`, then adds exactly current damage to power once; multiple Grit grants do not add several copies. The actual Grim Resolve test attacks a base with Marine damage2 for5 and undamaged Wampa for4. A new rich example should separate the attack-start wounds/current combat power from resting post-attack power and avoid double-counting a pre-existing Grit contribution.

The existing Grenade recording chooses Bossk then Marchion Ro and includes two subsequent deck top/bottom decisions in the same classified action; aggregate before/after changes therefore are not all necessarily Grenade's damage. Self-Destruct's recorded choices are friendly Doctor Hemlock then Punishing One. Those raw choices were read, but exact before/after card deltas have not yet been audited here.
