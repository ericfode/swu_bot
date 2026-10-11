# swu-lisp: a Common Lisp bot

A Star Wars Unlimited bot written in Common Lisp (SBCL). It plays the real engine through the stdio JSON Lines
protocol (`spec/stdio-protocol.md`, adapter `bot/players/external.js`) and needs nothing beyond SBCL: it has its own
JSON reader and loads card stats from the engine's card JSON.

    sudo apt-get install sbcl                 # SBCL 2.x
    npm run lisp:build                        # = sbcl --non-interactive --load bot/lisp/build.lisp -> bot/lisp/swu-lisp
    npm run lisp:test                         # 24 checks on mock boards, no engine needed
    node bot/tournament.js --bots lisp,rush --games 10 --out replays/lisp
    node bot/ladder.js --bots lisp,rush,aggro,tempo,random --games 10

The build compiles the sources and saves one executable (`swu-lisp`, ~40 MB, gitignored) with the 2,479 cards of
`forceteki/test/json/Card` already inside, so a game starts in milliseconds. Set `SWU_CARD_JSON` at build time to read
card data from somewhere else. `SWU_LISP_TRACE=<file>` makes the bot log every decision and its reason.
It is registered as `lisp` (`"lang": "lisp"`) in `bot/external-bots.json`.

## How it decides

| Part | File | What it does |
| --- | --- | --- |
| JSON | `src/json.lisp` | Reader (objects to hash tables) and writer. |
| Cards | `src/cards.lisp` | Cost, power, HP, aspects, keywords, Raid/Restore amounts, upgrade stats; lookup by internal name, set code or title. |
| Text patterns | `src/intent.lisp` | Prompt and card text become token lists; s-expression rules turn them into intents. |
| Board model | `src/world.lisp` | The observation as structs, a combat simulator and the evaluation. |
| Policy | `src/policy.lisp` | One answer per `decide` message. |
| Protocol | `src/main.lisp` | The stdin/stdout loop; on any internal error it logs to stderr and plays a safe default. |

**Text patterns.** Rules are written as data and matched against tokens (`?n` binds a number, `*` any run of tokens).
The rule that matches earliest in the text wins, because the main verb of a sentence usually comes first:

```lisp
(defintents *target-intents*
  ("choose a target for attack" (:attack-target))
  ("deal ?n damage" (:damage ?n))
  ("defeat" (:defeat))
  ("?p / ?h" (:buff ?p ?h))          ; "+2/+2", "–2/–2"
  ...)
(read-intent "Deal 3 damage to a unit and draw a card" *target-intents*)  ; => (:DAMAGE 3)
```

**Board model and evaluation.** Units carry power, HP, damage, shields, readiness and the keywords that change combat
(Sentinel, Saboteur, Overwhelm, Raid, Restore, Ambush, Shielded). The evaluation from the bot's seat is:

- units: 1.5 x power + 0.7 x HP left + 1.5 per shield, small bonuses for Sentinel, Raid and Overwhelm; ready units
  add 0.4 x power (they can still attack this round);
- bases: each remaining HP point is worth 0.8 above 15 HP, 1.0 down to 11 HP, then up to 2.35 for the last point; a
  dead base is -1000;
- threats: -6 when the opponent's total power reaches the bot's remaining base HP, +4 the other way round.

**Action window.** Every legal move is tried in the model and scored after the opponent's best single attack reply
(a 2-ply search in the model, attacks only, because the opponent's hand is hidden):

- attacks: every legal target, Sentinel respected;
- hand cards: units are added to the board (Ambush units attack at once), upgrades go on the best unit, events are read
  with the event patterns (damage and removal on the best target, held when there is no target);
- the cards worth playing then go through a knapsack over the ready resources (aspect penalty included), so the round's
  resources buy the most value;
- leader deploy is free and the leader arrives ready, so it is scored like a ready unit.

It takes the best move worth more than 0.25 points; otherwise it claims the initiative if it does not have it, else
passes. The pick is remembered, so the attack-target prompt that follows uses the planned target.

**Other prompts.** Resource step: resource the card it least wants to keep (off-aspect, far from castable), until 6
resources, later only when the hand needs it. Targets: the prompt's intent is applied to each candidate in the model and
scored. Damage splits: lethal on the enemy base, then kills with the most value per point, then shields, then the base;
indirect damage on its own side goes to its own base first. Cancels on "will have no effect" prompts, and a move that
led to a Cancel is not retried that round.

## Results

One build, one ladder (`results/lisp-ladder-1`, 10 games per pair, seeds 301-305 from both seats, real cards, forceteki
`2be4fcd`; aggro/tempo with the base-danger fix from PR #10, rust-greedy2 from PR #9):

| Bot | W-L | Win rate | BT Elo | ms per decision (harness) |
| --- | --- | --- | --- | --- |
| aggro | 40-10 | 80% | 1839 | 174 |
| **lisp** | **38-11** | **78%** | **1818** | **2.2** |
| rust-greedy2 | 36-14 | 72% | 1765 | 3.2 |
| tempo | 20-29 | 41% | 1471 | 173 |
| rush | 14-35 | 29% | 1357 | 0.1 |
| random | 0-49 | 0% | 751 | 0.0 |

Head to head: lisp 7-3 vs rust-greedy2, 5-5 vs aggro, 8-1 vs tempo, 8-2 vs rush, 10-0 vs random.

Known issue: one game (tempo vs lisp, seed 312) hit the 6,000-step cap. In a "Choose units to deal 1 damage to"
multi-select prompt the bot kept clicking the same card, and the prompt never took it. The repeat guard lowers that
card's score but still picks it when it is the only card and no minimum is met.
