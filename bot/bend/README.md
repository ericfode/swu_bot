# swu-bend: a Star Wars Unlimited bot in Bend 2

A bot written in [Bend 2](https://github.com/bendlang/bend) (an affine, dependently typed language that compiles to
native code through C). It plays the forceteki engine over the stdio protocol in `spec/stdio-protocol.md`, like the
Rust and Python bots, so `match.js`, `tournament.js` and `ladder.js` use it unchanged.

Registered in `bot/external-bots.json` as:

- `bend`: the bot's own scores pick every move.
- `bend-jev`: the same bot, but at action windows and target prompts TypeSafe's Jev model picks one of the bot's best
  four candidates (needs `curl` and `TYPESAFE_API_KEY`; on any failure the bot plays its own pick).
- `bend-jev-ties`: Jev only breaks near-ties: it chooses among the moves within 15 (1.5 base damage) of the best.

Measured on 60 paired games vs `rush`: `bend-jev` won 34 where `bend` won 40; `bend-jev-ties` won 44, the same as
`bend`. So `bend` is the default and the Jev modes are experiments. Round robin of 10 games per pairing (seed 501):
`bend` 29-11, `bend-jev-ties` 27-13, `rust-greedy2` 26-14, `rush` 15-25, `tempo` 3-37.

```bash
cd forceteki && npm run get-cards && cd ..             # card data, once
BEND2=~/bend/bend2/main.ts bot/bend/build.sh           # card tables + native binary bot/bend/swu-bend
node bot/ladder.js --bots bend,rush --games 20         # play
node bot/tournament.js --bots bend,node-random --games 2 --out replays/bend-check   # protocol check
```

`build.sh` needs node, bun and clang. `run.sh` (bash) execs the binary with its stdin fed through `cat`: Bend reads
stdin by opening `/dev/stdin`, and that fails (ENXIO) when stdin is a socket, which is what Node's `spawn` gives a child.
Because of the `exec`, the process the harness starts is the bot itself, so killing it leaves nothing behind.

## How it decides

Everything is scored in tenths of a point of enemy base damage, around a zero point `Z` (U32 has no sign).

- `eval.bend`: a unit is worth `20 x power + 8 x hp left + 15 x shields`, plus small bonuses for Sentinel, Raid,
  Overwhelm, Saboteur, Restore, Grit and leaders. A point of base damage is worth 10, rising to 15 and 25 as the enemy
  base gets low; damage that kills the base is worth 200000. Combat is simultaneous: an attack gains the target's worth
  (or 4 per point when it doesn't kill) and loses the attacker's worth if the counter-damage kills it. Shields,
  Saboteur and Overwhelm are counted.
- `board.bend`: who blocks (Sentinel), how much a ready board can hit the base for (lethal check), the aspect penalty
  (+2 per missing icon), and what a card in hand adds when played.
- `policy.bend`, one handler per prompt kind:
  - action window: a knapsack over this round's ready resources picks the best set of cards to play; the best of
    those, the best attack, deploying the leader (free once resources reach its deploy cost) or Claim Initiative (only
    when nothing else is worth doing) wins. With lethal on board every attack goes to the base.
  - attack targets: the same combat score per target.
  - targets in general: the title's verbs ("deal", "defeat", "heal", "give a Shield", ...) say whether the effect helps
    or hurts its target, then units are scored by worth; multi-select prompts click useful cards until none is left.
  - resources: put in the card worth least now (expensive beyond reach, off-aspect); stop at 8 resources with a
    small hand.
  - distribute: kill what the amount can kill, the rest to the base; indirect damage to me goes to my base unless that
    would lose the game; healing and tokens to my best units.
  - menus: Deploy, Trigger, Keep, "Yourself"; Cancel on "will have no effect"; a player choice goes by whether the
    effect helps or hurts.
  - loop guards: a card clicked in an action window is not clicked again that round, a multi-select click that
    changed nothing is not repeated, and the same prompt 8 times in a row takes an exit.
- `jev.bend` (bend-jev): one HTTPS call per decision. The state goes as short text (bases, resources, units with
  stats and keywords, my hand with card text); the question is a `choice` over the bot's top four candidates, plus a
  `noul` "will I win?" for an outlook. Jev cannot pick a move the bot thinks is clearly bad (score below `Z - 20`).

Thoughts go to stderr, one line per decision, e.g. `[bend] r4 #68 window: play c232 (+164, 9 options) | jev m1/4 win 62%`.

## Files

| File | What |
|---|---|
| `main.bend` | command line, stdin loop, replies, Jev hook |
| `json.bend`, `io.bend`, `txt.bend` | JSON parser, line reader and file reading, text helpers |
| `cards.bend` | loads `cards.tsv` / `cards-text.tsv` (made by `tools/gen-cards.js` from forceteki's card JSON) |
| `model.bend` | the decide message as typed records |
| `eval.bend`, `board.bend` | scores |
| `policy.bend` | the decisions |
| `jev.bend` | the TypeSafe call |
