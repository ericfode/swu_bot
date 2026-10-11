# Real deck lists

Deck files for `node bot/ladder.js --decks <file>` (format and dealing rules: `bot/decklists.js`).

## ash-meta-2026-09

- `ash-meta-2026-09.json`: 27 Premier tournament deck lists, 19 leaders, September 2026 (after the Cad Bane ASH
  leader ban). Each deck is named after its source file, e.g. `director-krennic_law_blue`. `metadata.style` is the
  source's play-style label (hyperaggro .. hardcontrol). Sideboards are left out.
- `ash-meta-2026-09.human.json`: how the same decks did for people. One entry per deck in `archetypes`
  (`fieldDecks`, `gameWinPct`, `label`) and one per deck pair in `cells` (`games`, `matches`, `gameWinPct`,
  `matchWinPct`, `gameWinCI95`, `thin`), from 53 Premier events and 3,239 decks.
- Source: TCGEngine, folder `SWUSim/Tests/BotFixtures/ash-meta-2026-09` at commit
  `a2df9722314b1233d16747f7e56186071106799c`.

**Credit:** Tournament deck lists and match results from TCGEngine / SWU Stats (github.com/TCG-Engine/TCGEngine, MIT,
Copyright (c) 2025 TCG-Engine), from public melee.gg Premier events (event list via swu-competitivehub.com). The MIT
notice is in `LICENSE.TCGEngine` and must stay next to these files.

Only numbers are kept. The importer drops the fixture comment lines (event, placement, decklist links) and the event
list and notes of `real_matchups.json`, because they can point to players.

## Use

```bash
# rebuild from a TCGEngine checkout
node bot/decks/import-swusim.js <TCGEngine>/SWUSim/Tests/BotFixtures/ash-meta-2026-09 bot/decks/ash-meta-2026-09

# mirror run: the same bot on both seats, so only the decks differ (27 decks = 351 pairs; 7020 = 20 games a pair,
# 10 whole passes; --games should be a multiple of 702 so every pair plays equally often)
node bot/ladder.js --bots c-clock#a,c-clock#b --games 7020 --decks bot/decks/ash-meta-2026-09.json --out <dir> --id ash-c-clock-1

# compare with the human results
node analysis/realdeck/compare.js --runs <dir>/ash-c-clock-1 --decks bot/decks/ash-meta-2026-09.json \
     --human bot/decks/ash-meta-2026-09.human.json   # see analysis/realdeck/README.md
```

Write long runs to local disk and copy `index.json` and `ladder.json` in afterwards. Mirror runs belong in
`/mnt/project-files/human-meta/realdeck/`, not `results/`, so `c-clock#a` / `c-clock#b` stay out of the bot league.

## Caveats

- 27 decks and 19 leaders, not the whole field. The human rate is per archetype (all lists of that leader and base),
  not for this exact list.
- Many pair cells are thin (`thin: true`, under 10 matches). Weight by `games` or leave them out.
- The source notes that `director-krennic_law_blue-splash` has no space unit under cost 7, so it loses badly to
  space decks whoever pilots it. Check a deck's curve before calling a result a bot defect.
- `lando-calrissian_law_blue` (the only list with 3x Barriss Offee, ASH_044) loses about 36% of its games to an engine
  crash in Barriss Offee (CLAUDE.md, known engine bugs), so its results say little about the deck.
  `analysis/realdeck/compare.js` leaves it out by default, as it does any deck with too many incomplete games.
- Human results are best-of-three with sideboarding; a bot game is one game with the main deck.
