# A16 source and existing-recording research

Read-only preparation; no A16 implementation or acceptance. Original imported queue A016 (array index17), ten JTL events. Root read all ten installed JSON/implementations and all ten complete tests. The full primary specification and finite receipt contracts are now prepared; implementation remains pending. Exact source paths/hashes: `results/card-effects-drafts/A16/rules-source-index.json`. Engine remains read-only.

| Slug | Identity | Verified prints | Printed cost / aspects |
| --- | --- | --- | --- |
| lightspeed-assault | 8606123385 | JTL_127 | 2 / command |
| prepare-for-takeoff | 3974134277 | SOR_125, JTL_128 | 2 / command |
| focus-fire | 8905858173 | JTL_129 | 4 / command |
| timely-reinforcements | 2301911685 | JTL_130 | 5 / command |
| turbolaser-salvo | 8174214418 | JTL_131 | 7 / command |
| no-disintegrations | 4033634907 | JTL_144 | 3 / aggression, villainy |
| they-hate-that-ship | 7461173274 | JTL_155 | 1 / aggression, heroism |
| trench-run | 2995807621 | JTL_156 | 1 / aggression, heroism |
| fight-fire-with-fire | 3885807284 | JTL_173 | 1 / aggression |
| hotshot-maneuver | 6544277158 | JTL_174 | 1 / aggression |

Prepare for Takeoff is implemented in `01_SOR/events/PrepareForTakeoff.ts` and installed setCodes explicitly verifies both SOR_125 and JTL_128 under identity3974134277. The SOR alias is supported by JSON, not inferred from the directory. With the established Luke/EchoBase Vigilance/Heroism/Command setup, total event costs are2,2,4,5,7,7,3,3,3,3. Any chosen unit play has its own independently computed payment.

## Rules distinctions

- **Lightspeed Assault:** own space defeat, enemy space ability damage based on defeated friendly unit's last power, then indirect damage based on the enemy's power. Current ruling includes modified power at defeat and permits indirect after enemy death. Native tests explicitly permit indirect despite Lurking TIE immunity or a Shield preventing the direct damage; do not equate the conditional with positive damage actually marked. No enemy space yields the friendly defeat only. Opponent distributes indirect among legal current own units/base; preserve caps and actual prevention. Engine's direct source is the event, not a combat attack.
- **Prepare for Takeoff:** inspect exact top8, choose up to2 Vehicle units, reveal selected to opponent, draw them; random order for unselected bottom cards. No full-deck search or arbitrary chosen bottom ordering. Empty choice is legal.
- **Focus Fire:** choose any unit in an arena with a friendly Vehicle able to apply the effect; every current friendly Vehicle in its arena simultaneously deals its current power as ability damage to that target. Per-hit source is the actual Vehicle, not the event and not an attacker. Exhaustion is irrelevant; no attack triggers/counterdamage/readying. Complete source census and pre-resolution powers must survive simultaneous deaths.
- **Timely Reinforcements:** floor(opponent total resources/2) own exhausted2/2 X-Wings, then phase Sentinel only on that actual generated set. Exhausted resources count, odd remainder does not; old X-Wings stay unchanged. Native tests include Jerjerrod doubled generated set. Reuse A14/A15 generated-entry/keyword metadata only after those are accepted and exact semantics are established.
- **Turbolaser Salvo:** chosen ground or space enemy arena, with one actual friendly space source. Its current power applies simultaneously to every enemy unit in the chosen arena. No friendly hits; space source need not attack or exhaust. Choosing an empty arena is legal; no friendly space source means no damage.
- **No Disintegrations:** any non-leader unit, including friendly, takes remainingHP−1 ability damage. Existing wounds and upgrades affect remainingHP; no maximumHP reduction or direct defeat story. A unit at1 remainingHP receives0. Shields/prevention and native Grit aftermath need explicit supported results.
- **They Hate That Ship:** opponent gets two fresh ready1/1 TIEs, then own hand Vehicle plays normally with cost reduced3 (floor0, actual aspect penalties), normal exhausted entry unless explicitly supported otherwise. New TIE trigger abilities resolve after event; do not synthesize them prematurely. Tokens and unit are separate controllers/payments/sources.
- **Trench Run:** ready Fighter attacks with+4 power for that attack. On Attack first mills opponent's exact top2, then deals attacker unpreventable damage equal to absolute difference of their printed costs. Fewer than two actual discarded cards means no such self-damage; no fabricated second cost. This pre-combat damage can defeat attacker and cancel combat damage; native test confirms base remains untouched in that branch. Surviving attacker completes legal combat then loses+4/granted ability. Printed cost never includes penalties/discounts.
- **Fight Fire With Fire:** choose one friendly and one enemy unit in same arena; deal3 simultaneously to each. No pair means neither receives damage. Independent Shields/prevention/native effects remain independent; no attack/exhaust story.
- **Hotshot Maneuver:** choose any friendly current unit, including exhausted/unable-to-attack. Count actually active On Attack abilities, including valid gained ones; deal2 to distinct enemy units up to available enemy count, then attack with chosen unit if legally able. Initial damage does not require readiness. Targets can occupy either arena. Printed text alone cannot prove a conditional granted ability is active; native tests distinguish non-Jedi Lightsaber from Jedi and multiple Pilot-granted triggers. The later attack triggers its actual On Attack abilities normally, so choose/support explicit native aftermath instead of inventing a generic attack-only body.

## Existing recordings

`A16/existing-replay-inventory.json` uses exact known print matching and post-action snapshots:before index−1, after until. Three actions across three identities; seven absent. No new games.

- Fight Fire With Fire, `random-a-vs-random-c-7`, action402..404, snapshots401→404: P1 pays1, Cin Drallig gains3 wounds, opposing Rocket-jumper loses its Shield and takes no wounds. Both survive; controller/owner/entry classification remains limited by recording.
- Timely Reinforcements, `random-b-vs-random-a-2`, action201, snapshots200→201: P1 pays5; opposing total9 resources yields four exhausted2/2 X-Wings c106..109, each recorded sn1. Recording has no explicit token flag, source-bound phase status or fresh-entry witness; preserve actual numbers while keeping unsupported rich causes generic.
- Lightspeed Assault, same game, action207..208, snapshots206→208: P1 pays2 and c108 disappears from own space; opponent has no space unit, so no enemy hit or indirect damage. No recorded discard entry for the removed null-print X-Wing; do not infer a printed owner-discard movement.

These observations establish available source material only. Production replay acceptance will require the matching final built scene and the maintained before/after/Replay/seek checker.
