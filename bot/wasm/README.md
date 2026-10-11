# wasm — a bot written by hand in WebAssembly text

`bot.wat` is the whole bot: about 1,600 lines of hand-written WAT, compiled to a 12 KB module. There is no compiler
from another language in between. `host.js` is a thin shim that speaks the stdio protocol (`spec/stdio-protocol.md`):
it parses JSON, looks up printed card stats, copies everything into flat i32 tables in the module's memory, calls
`decide()`, and sends back the index the module wrote. It makes no choices of its own.

    node bot/wasm/host.js --check                          # compile and validate bot.wat
    node bot/tournament.js --bots wasm,rush --games 10 --out replays/wasm-vs-rush
    node bot/ladder.js --bots wasm,rush,tempo,random --games 10
    node --test bot/test/wasm.test.js                      # decisions on hand-made messages, no engine

It is registered as `wasm` (`"lang": "wasm"`) in `bot/external-bots.json`. `host.js` compiles `bot.wat` at start-up
with `wabt` (a root devDependency, so run `npm install` at the repo root once) and reads card stats from
`forceteki/test/json/Card` (or `$SWU_CARD_JSON/Card`, the same convention as the Rust bot). `SWU_WASM_TRACE=1` prints the module's `trace` calls on stderr.

## What it does

Everything is integer arithmetic over fixed-layout records, which is what WebAssembly is good at:

- **Attack planner.** In the action window it enumerates every assignment of its ready units to targets (hold, the
  enemy base, each enemy unit) per arena, up to 7^6 combinations, and keeps the best integer score. Sentinel and
  Saboteur limit the targets, a Shield soaks the first hit, Raid adds power, Overwhelm spills over to the base, and the
  defender's counter-damage is charged to each attacker. So two units can gang up on a unit neither kills alone, and it
  won't trade two units for one. When the units that can reach the base have lethal, all of them go face.
- **Race clock.** Base damage is worth more when it is ahead in the race (rounds to kill their base with the power on
  board vs. rounds for them to kill its base) and trades are worth more when it is behind.
- **Spend plan.** A bitmask knapsack over the playable hand finds the cards that use the most of this turn's ready
  resources (cost plus 2 per aspect icon its leader and base don't cover). Removal with no enemy unit and upgrades with no
  unit to go on are held.
- **Action order.** Lethal, then attacks that kill a ready enemy unit, then deploying the leader, then the spend plan
  (most expensive first), then other kills, base hits and chip damage, then claiming initiative, then passing.
- **Other prompts.** The prompt title is read with substring searches over the lower-cased bytes ("deal 3 damage",
  "defeat", "heal", "attach", "-2/-2", "experience", ...) to decide whether a target should be friendly or enemy and
  which one gains the most. Damage splits kill the most valuable units they can and put the rest on the enemy base.
  Resources go to expensive and off-aspect cards; cheap on-aspect units stay in hand.
- **Memory between decisions.** A per-game table of (position fingerprint, action) pairs means a click that changed
  nothing (a play it then cancelled) is never repeated in the same position. Search prompts ("select up to 2 cards") do
  not report which cards are already picked, so it remembers its own picks to avoid unpicking them.

## Memory layout

The module exports every offset and field number as a global (`UNITS`, `U_POW`, `H_ROUND`, ...), and `host.js` reads
them from the instance, so the layout is defined once, in `bot.wat`:

| Region | Address | Contents |
|---|---|---|
| header | 0 | i32 slots: counts, round, prompt type, bases, resources, leader, aspects, distribute spec |
| source | 512 | card record of the card that asked the prompt |
| distribute | 1024 | one 16-byte row per split target (unit row, base flag, cap) |
| units | 4096 | 128-byte rows: owner, arena, power, hp, damage, exhausted, sentinel, shields, uid + card record |
| hand | 12288 | 128-byte rows: uid + card record |
| actions | 16384 | 128-byte rows: kind, zone, controller, unit/hand row, base/leader flag, label, uid + card record |
| text | 278528 | lower-cased UTF-8: prompt titles, labels, card text |
| out | 917504 | chosen index, split flag, split amounts |
| state | 921600 | per-game memory (rng, last pick, visit and tried tables) |
| scratch | 950272 | planner and knapsack work arrays |
| strings | 983040 | the module's own keyword strings |

A card record (printed cost, power, hp, type bits, arena, aspect codes, keyword bits, upgrade stats, text) sits at
byte 64 of every unit, hand, action and source row, so one set of accessors reads them all.
