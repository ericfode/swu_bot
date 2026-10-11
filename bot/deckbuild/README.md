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
- `report.py`: merges field-eval runs and compares deck groups on the same seeds (paired gaps).
- `dashboard.py`: writes this thread's cards in the research dashboard.
- `loop.sh`: closes the loop: train on every game so far, build or draft with the new models, play, repeat.

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
python3 bot/deckbuild/report.py DIR [DIR2 ...] --out report.json   # runs with the same --seed are paired
# hidden-list check: train without fold K of the field decks, build only those targets
python3 bot/deckbuild/deck_jepa.py ... --mode linear --exclude-fold 0/3 --out fold0.npz
python3 bot/deckbuild/build.py --model fold0.npz --fold 0/3 --starts .../starts/stat.json --out built-fold0.json
python3 bot/deckbuild/draft.py --set SOR --pods 60 --drafters stat,rarity,random,stat --out DIR/pods.json
node bot/deckbuild/pod-eval.js --pods DIR/pods.json --out DIR
```

The pilot is `c-clock` (fast and strong; `make -C bot/c` first). Card data comes from `forceteki/test/json`.
Results, notes and data live in `/mnt/project-files/deckbuild/`.

## Results (2026-10-11, c-clock pilot, 27-deck field)

Every row played all 27 field decks from both seats on the same seeds (1,458 games each); gaps are paired.

| decks | score vs field | gap to real lists |
|---|---|---|
| real tournament lists | 49.6% | |
| built, linear card values | 49.2% | -0.1 [-3.5, +3.3] |
| built, deep supervised | 46.3% | -3.3 [-6.6, +0.1] |
| built, linear, target list hidden (3 folds) | 44.0% | -5.1 [-8.4, -1.8] |
| built, JEPA encoder frozen | 43.2% | -6.0 [-9.4, -2.7] |
| built, JEPA fine-tuned | 42.1% | -7.4 [-10.7, -4.2] |
| stat builder (the builders' start) | 36.2% | -12.9 [-16.2, -9.5] |
| random aspect-legal cards (exp 1) | 26.0% | |

- The builder exploits model errors: built decks score 8 (linear) to 36 (deep supervised) points under the model's own
  prediction, while held-out log loss is about the same for all four models (0.535 to 0.544, constant 0.632).
- With ~1,300 decks, JEPA pretraining does not beat a plain model; on draft data (480 decks) it does
  (held-out log loss 0.598 vs 0.626).
- Draft (Spark of Rebellion, 8-seat pods, the stat builder makes every 30-card deck): stat drafter 64%, random 39%,
  rarity-first 32% (60 pods); JEPA drafter 51% vs stat drafter 49% (40 pods, a tie).

### Closing the loop (`loop.sh`, 3 rounds)

| round | linear-built | gap to real lists | linear predicted | deep-built | deep predicted | JEPA drafter vs stat |
|---|---|---|---|---|---|---|
| 0 | 49.2% | -0.1 | 57.5% | 46.3% | 82.1% | 51.0% |
| 1 | 53.5% | +4.1 [+0.8, +7.4] | 57.4% | 45.1% | 72.4% | 52.9% |
| 2 | 55.9% | +6.6 [+3.4, +9.8] | 57.2% | 38.7% | 80.2% | 51.5% |
| 3 | 56.7% | +7.3 [+4.0, +10.6] | 57.7% | 35.8% | 80.6% | 55.9% [53.8, 57.9] |

- Feeding the builder's own decks back in makes the linear model calibrated (57.7% predicted, 56.7% played) and its
  decks beat real lists for c-clock. The deep supervised builder gets worse each round: every round it finds a new
  region its model overrates, so flexible models need a penalty for unearned confidence (ensemble spread) first.
- Results page: https://claude.ai/artifact/DdoeT9aQ9YaGMbvxNZKNb6. Data: `/mnt/project-files/deckbuild/eval/report.json`.

## Credits and caveats

- Field decks: 27 Premier tournament lists from TCGEngine / SWU Stats (MIT), see `bot/decks/README.md`.
- Card rarity: the official card database (admin.starwarsunlimited.com), fetched once, politely.
- Bot-judged deck strength is biased toward aggro decks (the real-deck ladder found both c-clock and rust-greedy2
  like aggro and dislike control, while humans win about evenly with every style). A builder tuned on bot games
  builds decks for the bots, not for people.
