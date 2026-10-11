# Deck building and drafting (deck JEPA)

Research code for building Star Wars: Unlimited decks and drafting with a learned deck model. The model follows
the JEPA idea of `bot/jepa` (plan in a learned latent space, never rebuild the raw input), applied to decks
instead of board positions:

| `bot/jepa` (play) | here (decks) |
|---|---|
| state = a board | state = a partial deck, or a draft pool after k picks |
| action = a move | action = add a card (pick it, or swap it in) |
| future = the board some decisions later | future = the finished deck |
| value = P(I win from here) | value = P(this deck beats that deck) with the same pilot bot on both sides |

Everything is judged in games: one pilot bot plays both seats, every pair is played on one seed from both seats,
so only the decks differ (`play.js`).

## Files

- `cards.js`: card pool (every implemented leader, base and main-deck card), aspect penalty rule.
- `decks.js`: deck makers: `randomDeck` (aspect-legal random), `statDeck` (simple hand-written builder: units with the
  best printed stats for their cost, on the curve of real decks), `mutate` (swap k copies).
- `play.js`, `play-worker.js`: deck-vs-deck games on worker threads.
- `exp-visible.js`: experiment 1 (can the pilot tell good decks from bad ones?).
- `gen-data.js`: training data: many decks (random, mutated real decks, stat decks) against the field.
- `field-eval.js`: score any candidate decks against the field (the check for every builder).
- `make-starts.js`: stat, random and real reference decks per field leader and base.
- `fetch-rarity.js`: card rarity from the official card database (the engine's card data has none; drafting needs it).
- `export-cards.js`: the card pool as JSON for the Python side.
- `deck_np.py`: card index, deck features, numpy forward pass of the deck model.
- `deck_jepa.py`: trains the deck model in tinygrad (modes `linear`, `sup`, `jepa`, `jepa-ft`).
- `build.py`: builds decks with a trained model (hill-climb card swaps against the field).
- `draft.py`: draft simulator (8-player pods, boosters by rarity, leader draft first) with drafters `random`,
  `rarity`, `stat` and `model` (the JEPA drafter), and limited deck builders.
- `pod-eval.js`: plays the decks of each pod against each other and scores the drafters.

## Commands (from the repo root)

```bash
NODE_USE_ENV_PROXY=1 node bot/deckbuild/fetch-rarity.js      # once; ~12 minutes, polite
node bot/deckbuild/export-cards.js                           # -> /mnt/project-files/deckbuild/cards.json
node bot/deckbuild/exp-visible.js --pilot c-clock            # experiment 1, ~5,800 games
node bot/deckbuild/gen-data.js --decks 900 --opps 8 --seed 1 --out /mnt/project-files/deckbuild/data/gen1
python3 bot/deckbuild/deck_jepa.py --runs /mnt/project-files/deckbuild/exp1-c-clock /mnt/project-files/deckbuild/data/gen1 \
    --mode jepa-ft --out models/deck-jepa.npz
node bot/deckbuild/make-starts.js /mnt/project-files/deckbuild/starts
python3 bot/deckbuild/build.py --model models/deck-jepa.npz --starts /mnt/project-files/deckbuild/starts/stat.json \
    --tag built-jepa --out built.json
node bot/deckbuild/field-eval.js --candidates built.json,/mnt/project-files/deckbuild/starts/real.json --out DIR
python3 bot/deckbuild/draft.py --set SOR --pods 60 --drafters stat,rarity,random,stat --out DIR/pods.json
node bot/deckbuild/pod-eval.js --pods DIR/pods.json --out DIR
```

The pilot is `c-clock` (fast and strong; `make -C bot/c` first). Card data comes from `forceteki/test/json`.
Results, notes and data live in `/mnt/project-files/deckbuild/`.

## Credits and caveats

- Field decks: 27 Premier tournament lists from TCGEngine / SWU Stats (MIT), see `bot/decks/README.md`.
- Card rarity: the official card database (admin.starwarsunlimited.com), fetched once, politely.
- Bot-judged deck strength is biased toward aggro decks (the real-deck ladder found both c-clock and rust-greedy2
  like aggro and dislike control, while humans win about evenly with every style). A builder tuned on bot games
  builds decks for the bots, not for people.
