# A10 read-only research packet

Prepared while A08 production review and A09 implementation run. This is source research, not an approved fixture contract, registration or acceptance. Queue: `results/card-animation-catalogue/imported-a04/batches.json`, `batches[11]` / generated `A006`. Card JSON and the matching classes below were read directly; engine source remains unchanged.

| Identity / canonical print | Cost / aspects | Rules and implementation detail |
| --- | --- | --- |
| Synchronized Strike / TWI_099 / 0633620454 | 2 / Command, Heroism | Deal damage to an enemy unit equal to controlled units in that target's arena. `03_TWI/events/SynchronizedStrike.ts` counts actual friendly arena units at resolution; power, other arena, owner and undeployed leader are irrelevant. |
| Petition the Senate / TWI_100 / 3500129784 | 3 / Command, Heroism | If at least three controlled Official units exist, draw three. `03_TWI/events/PetitionTheSenate.ts` counts current arena units with that trait. Three physically distinct witnesses and actual top cards are needed for the primary. |
| Manufactured Soldiers / TWI_102 / 1192349217 | 3 / Command, Command | Choose two Clone Troopers or three Battle Droids. `03_TWI/events/ManufacturedSoldiers.ts` uses one explicit mode. Created units enter exhausted; no unit play, aspect payment or hand/deck origin. |
| Pyrrhic Assault / TWI_103 / 9415708584 | 3 / Command, Command | Each current friendly unit gains a phase ability: When Defeated, deal two damage to an enemy unit. `03_TWI/events/PyrrhicAssault.ts` targets the current friendly arena set with a lasting effect; it does not immediately damage an enemy or grant a standing aura to future arrivals. Later defeat and selected damage need separately witnessed trigger evidence. |
| Outflank / TWI_123 / 0802973415 | 1 / Command | Two attacks, one at a time, with distinct units. `02_SHD/events/Outflank.ts` explicitly excludes the first chosen attacker from the second. Verify ready/legal recipients, each attack's own damage/counterdamage/Shield/defeat and later attacker selection. |
| Tactical Advantage / TWI_124 / 2651321164 | 1 / Command | Any unit gets +2/+2 this phase; friendly-only is absent. `01_SOR/events/TacticalAdvantage.ts`. Existing wounds and pose persist. |
| The Clone Wars / TWI_125 / 2267524398 | 2 / Command | Pay any additional number of resources; create that many own Clones and opposing Droids. `03_TWI/events/TheCloneWars.ts` selects from ready resources after event payment, then explicitly orders additional payment, Clone creation, Droid creation. Do not count the event cost as token budget or infer a free payment. Zero creates none. |
| Encouraging Leadership / TWI_126 / 4916334670 | 3 / Command | Current friendly units in both arenas gain +1/+1 this phase. `03_TWI/events/EncouragingLeadership.ts` targets current units; later arrivals are not silently buffed. |
| Take Captive / TWI_128 / 3765912000 | 3 / Command | Friendly unit captures an enemy non-leader in the same arena. `02_SHD/events/TakeCaptive.ts` binds captor then target arena. No printed-cost limit and no Bounty Hunter Shield clause. Preserve actual attachment owners and captured identity. |
| In Defense of Kamino / TWI_129 / 1272825113 | 4 / Command | Current friendly Republic units gain Restore2 and a When Defeated ability to create one Clone, this phase. `03_TWI/events/InDefenseOfKamino.ts` captures the current Republic set. The grant is immediate; healing requires an actual attack and creation requires actual defeat. A replacement Clone is a new entry and does not inherit the original granted trigger. |

With Luke SOR_005 plus Echo Base SOR_024, event payments are `[2,3,5,5,1,1,2,3,3,4]`; the two repeated Command symbols incur one missing-symbol penalty. Clone Wars needs its separately selected extra payment. These are legal cost expectations, not completed fixture assertions.

Verified reprint rules from the same canonical card JSON: Outflank also SHD_128; Tactical Advantage also SOR_124; Take Captive also SHD_131. Register all three exact aliases when implementing. The other seven currently have only their stated TWI print.

## Supporting source facts

- Clone Trooper canonical3941784506 has no numbered print, ground2/2, traits Republic/Clone/Trooper and Heroism. Battle Droid canonical3463348370 has no numbered print, ground1/1, Separatist/Droid/Trooper and Villainy. Creation pays neither token's aspects.
- Three source-verified Official witnesses are Mon Mothma: Voice Of The Rebellion SOR_096 (1/3, cost2), Admiral Ackbar: Brilliant Strategist SOR_097 (1/4, cost3), and Bail Organa: Rebel Councilor SOR_094 (1/2, cost1). They can already be on the staged board; their When Played/Action abilities are not part of Petition.
- A09's explicit created-token meaning, per-token identities/pose, token cessation and measured arrival geometry can be extended for Clone Troopers. It is still under implementation and cannot yet be cited as accepted visual reuse.
- Pyrrhic and Kamino need narrow current-entry granted-ability evidence and a visible persistent status. A separate explicit later action can demonstrate their triggers; elapsed animation time must not cause a defeat or attack. Existing `next-action` stage plumbing is a possible extension, subject to the fixture contract.

## Existing recordings

An exact print/name action inventory over existing demo recordings found four actions:

| Card | Game | Classified step range |
| --- | --- | --- |
| Manufactured Soldiers | random-a-vs-random-c-5 | 416–417 |
| The Clone Wars | random-b-vs-random-a-2 | 345–346 |
| Manufactured Soldiers | random-c-vs-random-a-6 | 351–352 |
| Manufactured Soldiers | random-c-vs-random-a-6 | 353–354 |

The remaining eight identities have no matching action in these recordings. Inventory is not replay-handoff acceptance. Raw prompts and source refs are saved in `/tmp/swu-a10-recorded-actions.json`; the source inventory script is `/tmp/swu-a10-recorded-actions.cjs`. No games were generated. Inspect actual recorded before/after objects before deciding whether token type, creation or payment causes are available; disappearance/arrival alone must remain conservative.
