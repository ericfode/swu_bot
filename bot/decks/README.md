# Real deck lists

Deck files for `node bot/ladder.js --decks <file>` (format and dealing rules: `bot/decklists.js`). The arena's start
check (`bot/arena/api.js`) sends a new bot two of these decks in its hello.

## ash-meta-2026-09

- `ash-meta-2026-09.json`: 27 Premier tournament deck lists, 19 leaders, September 2026 (after the Cad Bane ASH
  leader ban). Each deck is named after its source file, e.g. `director-krennic_law_blue`. `metadata.style` is the
  source's play-style label (hyperaggro .. hardcontrol). Sideboards are left out.
- Source: TCGEngine, folder `SWUSim/Tests/BotFixtures/ash-meta-2026-09` at commit
  `a2df9722314b1233d16747f7e56186071106799c`.

**Credit:** Tournament deck lists from TCGEngine / SWU Stats (github.com/TCG-Engine/TCGEngine, MIT, Copyright (c) 2025
TCG-Engine), from public melee.gg Premier events (event list via swu-competitivehub.com). The MIT notice is in
`LICENSE.TCGEngine` and must stay next to these files.

Only numbers are kept. The importer dropped the fixture comment lines (event, placement, decklist links), because they
can point to players.

The importer (`import-swusim.js`), the human results for the same decks (`ash-meta-2026-09.human.json`) and the
comparison of bot and human results (`lab/analysis/realdeck/compare.js`) are in
[holocron](https://github.com/ericfode/holocron)'s `decks/` and `lab/analysis/realdeck/`, with the real-deck test.

## Caveats

- 27 decks and 19 leaders, not the whole field.
- The source notes that `director-krennic_law_blue-splash` has no space unit under cost 7, so it loses badly to
  space decks whoever pilots it. Check a deck's curve before calling a result a bot defect.
- `lando-calrissian_law_blue` (the only list with 3x Barriss Offee, ASH_044) loses about 36% of its games to an engine
  crash in Barriss Offee (CLAUDE.md, known engine bugs), so its results say little about the deck.
