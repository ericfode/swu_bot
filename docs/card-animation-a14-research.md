# A14 read-only research packet

Future preparation only. No A14 implementation, current renderer ownership or acceptance is implied. Verified installed JSON and matching implementations under `forceteki/server/game/cards/03_TWI/events/` and `04_JTL/events/` are read-only. Sole prints and printed costs are TWI251/4, TWI257/2, JTL042/3,043/5,055/2,074/1,076/2,077/2,078/4,079/5. Under the current Command/Vigilance/Heroism showcase, actual source costs are4,2,5,7,2,1,2,2,4,5.

| Identity | Distinction to preserve |
| --- | --- |
| Drop In | Two fresh exhausted Clone Troopers created in ground; no unit play or hand/deck origin. |
| Private Manufacturing | Draw two actual cards first. If no controlled token units across either arena, move two actual hand cards to deck bottom in chosen order. A token upgrade is not a token unit. Preserve a genuine intermediate hand state, not a guessed net-zero draw. |
| Power from Pain | Phase+X/+0 uses the target's wounds when applied; does not heal, grow HP, add damage, or keep recomputing like Grit. |
| No Glory, Only Results | Take control of a nonleader, then defeat it; owner and last controller differ. Target can already be friendly. Preserve the intermediate control and subsequent actual defeat rather than skipping directly to an enemy kill. |
| You're All Clear, Kid | Enemy space unit with remaining HP≤3, then optional Experience only after successful defeat and no enemy space units remain. Either side's unit can receive the token. |
| Close the Shield Gate | Any chosen base receives one phase-limited damage prevention use. Immediate scene retains a base status; a separate later damage scene consumes actual prevention. It is not a Shield token or permanent immunity. |
| Covering the Wing | Create an exhausted2/2 X-Wing token in space, then optional Shield to another unit; exclude the new token from that choice, allow either side otherwise. Existing creation enums/primitives may need a narrow space-token variant. |
| In the Heat of Battle | All units, both arenas/controllers, gain Sentinel and lose Saboteur for the phase. Persist suppression separately from granting a keyword; restore native abilities at the explicit phase boundary without fabricating a combat. |
| Direct Hit | Defeat a nonleader Vehicle, either controller/arena. Printed classification and traits must be known; name or artwork cannot establish Vehicle. |
| Out the Airlock | Phase−5/−5 changes stats, preserving damage markers. A lethal result needs actual departure evidence; surviving and lethal branches are different. |

## Existing recordings

`/tmp/swu-a14-recorded-actions.json` and `/tmp/swu-a14-deltas.json` index four existing plays across three identities. Raw before/after files accompany them; no games were generated. Source action indices refer to the recording's existing classifier, with before at index−1 and after at `until`.

- Drop In, `random-b-vs-random-c-9`,78→78: P2 pays4 and creates exhausted2/2 Clone Troopers c106/c107; event c71 moves hand→discard.
- Covering, `random-c-vs-random-a-8`,300→301: P1 pays2 and creates exhausted2/2 X-Wing c107 in space, explicitly declines optional Shield. Do not add a Shield to its recorded animation.
- Private Manufacturing, `random-c-vs-random-b-10`,225→230: P1 pays2; c35 Battle Droid Escort and c44 Peli Motto arrive in hand, c8 Summa-verminoth and c28 Morgan Elsbeth leave hand, event c49 alone enters discard; net deck count is unchanged. Selection clicks include toggles and are not a simple bottom-order list.
- Private Manufacturing, same game373→383: P2 pays2; c73 Lom Pyke and c86 Seasoned Fleet Admiral arrive in hand, c64 Consumed by the Dark Side and c83 Separatist Council leave, event c59 enters discard; net deck count again unchanged. Actual deck order is unavailable in these snapshots and must remain unknown.

Seven identities lack an existing recorded example. Their future staged recipes require independent explicit evidence and cannot claim native coverage from the installed engine tests alone.
