# Omniscient search

A reference bot and an exact endgame prover that **see everything**: both hands, both deck orders and the real engine
RNG (so every searched line uses the real future draws). They are not fair bots. They exist to measure how much
information and lookahead are worth, and how far from the end SWU can be solved exactly.

| File | What |
|---|---|
| `search.js` | `OmniSearch`: alpha-beta over action windows (`alphaBeta`) and an AND/OR forced-win prover with a transposition table (`prove`, `solve`). A move = an action plus each option of its first follow-up prompt; deeper prompts and the other player's mid-action prompts use the heuristic bot's rule-based `defaultChoose`. |
| `evaluate.js` | Leaf score: the heuristic bot's terms and weights, with the low-base-HP penalty subtracted instead of added. |
| `../players/omniscient.js` | The bot. Names in `tournament.js`: `omni[-d<depth>][-n<nodes>][-blind]` (default depth 2, 600 nodes or 6 s per window). `-blind` reseeds the RNG and shuffles both decks before every searched move, so it cannot see the deck order or random results (it still sees both hands). |
| `solve-games.js` | Solve-horizon experiment: play games, then walk back from the end and prove each action window. |
| `export-positions.js` | Replays solved games and writes every action window as a labelled position (JSONL). `--legacy` replays games solved before the base-score fix; `--reprove` runs the current prover again on every window the solve run tried. |
| `lens.js` | Per-card value "lens" for viewers (`swu-lens/1`), from replays plus the bot's decision logs. |
| `report.js` | Summary, dashboard panel and experiment files under `/mnt/project-files`. |

```bash
node bot/tournament.js --bots omni,heuristic --games 16 --seed 101 --out replays/omni     # matches
OMNI_LOG_DIR=replays/omni-decisions node bot/tournament.js --bots omni,heuristic ...       # also log decisions + search trees
node bot/omni/solve-games.js --bots heuristic,heuristic --seeds 201-216 --budget 2000 --stop 2 --out replays/solve
node bot/omni/lens.js replays/omni --decisions replays/omni-decisions --out replays/lens
```

Search needs `undo: true` (the bot sets `needsUndo`). One search node (apply a move, roll back) costs about 38 ms on
the cloud sandbox; that, not the search code, limits depth.

The prover never caps the defending side's moves (every first action and every option of its first follow-up
prompt), and a defender move that throws in the engine counts as not refuted. Deeper prompts still follow
`defaultChoose`, so a proof is exact for that move model, not for the full game.

Results (2026-10-11, 15 solved games, 112 matches; the heuristic opponent used the old base score, now the `legacy`
profile): proofs reach about 3 windows from the end (max 10, never more than one round); a window has about 28
distinct moves, a whole game about 10^145 lines. Omni won 14/16 against the heuristic bot; a 1-ply bot with the fixed
score won 15/15; omni beat that 1-ply bot 32/48 (67% +/- 13). The first blind runs (results/omni-ref-2/3) only
reseeded the RNG, so they still saw the deck order; they do not measure what the draws are worth.
