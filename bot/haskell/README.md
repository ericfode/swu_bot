# swu-bot-hs (Haskell)

A Star Wars Unlimited bot in Haskell. It plays through the stdio protocol (`spec/stdio-protocol.md`): the engine
stays in JS, and for each decision `bot/players/external.js` sends one JSON line and reads back the index of the
chosen action. Registered as `haskell` in `bot/external-bots.json`.

## Strategy

The bot keeps a small, pure model of the visible board and searches it with a lazy game tree, in the style of
Hughes' "Why Functional Programming Matters":

- **Model** (`src/Model.hs`): units (power, HP, damage, exhausted, arena, Sentinel, Shields, Raid, Overwhelm,
  Saboteur, Grit, Restore), bases, hand, resources, leader, initiative and turn order. Combat is exact for these
  keywords: both units deal damage at the same time, a Shield absorbs one hit, Sentinel forces targets, Overwhelm
  sends excess damage to the base.
- **Card text** (`src/Effects.hs`): common one-sentence effects become model effects: "Deal N damage to a unit",
  "Defeat a non-leader unit with N or less remaining HP", heal, Shield and Experience tokens, +N/+N and -N/-N,
  draw, create tokens, exhaust, bounce/capture, and upgrade stats. Other text is worth a flat value per resource.
- **Search** (`src/Search.hs`): the whole tree of model positions is one lazy value (`gameTree`); `prune` cuts it
  at 4 moves (my move, the opponent's reply, my next move, their reply) and `alphaBeta` reads only the branches it
  needs, best-looking 8 moves per node. The opponent's hand is hidden, so in the tree the opponent attacks, uses its
  leader, passes or claims the initiative. Two passes end the round. Sooner wins score higher, so the bot takes a
  win when it can.
- **Evaluation**: base HP (each point counts more once a base is below 10), unit value (power, remaining HP,
  keywords, Shields), cards in hand, resources, the initiative, and a race term: how many rounds each board needs to
  kill the other base.
- **Action window** (`src/Policy.hs`): every legal action becomes model moves (a ready unit becomes one attack per
  legal target, the leader becomes deploy or its action), each is searched, the best is played, and the plan
  (attack target, deploy, ...) answers the follow-up prompts. An action that comes back to the same position, or
  that the bot has to cancel in a follow-up prompt, is not tried again in that round.
- **Other prompts**: targets are scored by applying the prompt's effect to the model; when the text is not
  understood, simple intent rules decide (harm enemy units, help own units). Resourcing keeps cards that are
  castable soon and efficient, and spends far-off and off-aspect cards; damage and healing splits are chosen by the
  bot (kill the most valuable units first, take forced damage on the base while it is healthy).

`decide` is a pure function of the card data, the bot's memory of the game and the message; `app/Main.hs` only does
the I/O.

## Build and run

Needs GHC 9.x with `aeson` (on Ubuntu: `apt-get install ghc libghc-aeson-dev`), or cabal.

```bash
bot/haskell/build.sh          # -> bot/haskell/build/swu-bot-hs (plain ghc, no network needed)
# or: cd bot/haskell && cabal build
node bot/ladder.js --bots haskell,rush,tempo,random --games 10
```

Card data (costs, keywords, upgrade stats) is read from `$SWU_CARD_JSON`, default `forceteki/test/json/Card` under
the working directory (the repo root when the adapter starts it). Without it the bot still plays, with flat values.
`SWU_HS_DEBUG=1` prints every action-window candidate with its search value, and every prompt answer, to stderr.

Speed: about 5 ms per decision as the harness measures it (adapter included), at most about 0.2 s.

## Results

RESULTS_PLACEHOLDER
