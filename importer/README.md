# Importer: human games from karabast.net

Turns captures of real games played on [Karabast](https://karabast.net) into our replay format
(`spec/replay-format.md`), so the viewer, the position analysis (`analysis/`) and the omni lens (`bot/omni/lens.js`)
read them like any bot game.

Karabast runs the same forceteki engine as this repo. After every change its server pushes a `gamestate` object to
each player (`Game.getState(viewerId)`). Browser extensions such as KaraBuddy and SWU Forge's Kara Tracker save that
stream. The importer reads the saved stream; it needs no engine and no card data.

## Usage

```bash
node importer/import.js <capture file or dir>... --out replays/human [--names Alice,Bob] [--source karabuddy] [--keep-file-names]
npm run studio:dev    # REPLAYS_DIR defaults to replays/, so replays/human shows up as a tournament
node analysis/analyze.js replays/human --evaluator heuristic
node bot/omni/lens.js replays/human --out replays/human/lens   # omni lens (bot/omni is not on main yet)
```

When both players recorded the same game, pair the two files to get one replay with both hands:

```bash
node importer/import.js --pair alice.karareplay bob.karareplay --out replays/human   # -> <hash>.both.jsonl
```

Each input becomes `<out>/games/<id>.jsonl`, and `<out>/index.json` is rewritten in the tournament format with
`human: true` and `pov` on each entry. The id is `g-<hash>` for a file and `<hash>.both` for a pair, where `<hash>` is
the first 10 hex digits of the SHA-1 of the input bytes (`sha1sum`; for a pair, of both files in order). Re-importing
the same file replaces its entry. File names are not used by default, because they often hold usernames (KaraBuddy
names its downloads after both players). For files you named yourself, such as `capture.js` output,
`--keep-file-names` makes the id the file name without its extension (`.p1`/`.p2` dropped for a pair) and writes
`source.file` (and `source.pairedWith`) to the header.

A file holding several games (a socket dump across a rematch, a best-of-three) is split where the game id changes,
the log restarts, or a won game is followed by a new setup; it gives `<id>`, `<id>.2`, ... with `source.game` and
`source.games` in each header.

A directory input adds its `.json`, `.jsonl`, `.txt`, `.log` and `.karareplay` files, except `*.truth.jsonl`.

Inputs are detected from the content (`sources.js`):

| input | from |
|---|---|
| KaraBuddy replay file, v1 (raw states) or v2 (`{full}` / `{patch}` per event) | KaraBuddy extension download |
| `{ events: [{full} \| {patch}] }` | KaraBuddy test fixture shape |
| SWU Forge Battle Log `PersistedTimeline` v2/v3 (`base` + `steps[{timestamp, patch}]` + `chat`) | Kara Tracker extension |
| socket.io text frames, one per line: `42["gamestate",{...}]` | browser devtools export of the game socket |
| JSON array or JSON Lines of `gamestate` objects | any other recorder |
| `importer/capture.js` output | engine-made test captures |
| SWU-PGN/1.x game file (`.swupgn`, `[Game "SWU-PGN/1.0"]` header) | Karabast's draft game notation, see below |

### Public KaraBuddy replays

KaraBuddy users can publish a replay; the site lists up to 200 of them, anonymized. `fetch-karabuddy.js` imports that
list, and only that list:

```bash
node importer/fetch-karabuddy.js --out replays/karabuddy-public [--limit 200] [--delay 3000] [--dry-run]
```

It is slow and polite on purpose. It reads `robots.txt` first and stops if the API is disallowed. It sends one request
at a time, at least 1 s apart (3 s by default), with a User-Agent that names this project. Re-runs skip games already in
`<out>/games`. KaraBuddy shows strangers no names and no deck lists, so the replay keeps neither (the downloaded file is
never written to disk), and chat is dropped as in every import. Each header credits KaraBuddy and links the replay's
page (`source.credit`, `source.url`). Encrypted and pruned replays are skipped. The container needs `karabuddy.app` and
the payload hosts (`*.public.blob.vercel-storage.com`, `*.r2.dev`) allowed.

## What a capture has, and what it lacks

A capture is one viewer's stream. A player sees their own hand and resources; the opponent's hand and face-down
resources are stubs with no name. A spectator sees neither hand.

| field | in the replay |
|---|---|
| board, bases, leaders, upgrades, damage, exhausted, discards, deck sizes, initiative, round, phase | exact |
| recording player's hand and resources | exact |
| other hand, other resources | `{ "n": "Hidden card", "s": null, "hid": 1 }`, right count |
| decisions | rebuilt from the game log lines (play, attack, deploy, resource, pass, ...); `legal` is 1 |
| deck order, the opponent's resource choices, legal actions, the engine seed | not in any capture |

Two captures of one game, one from each seat, fill that gap (`--pair`, `merge.js`). Karabast pushes the same update
to both players, so frames pair up by public board and log length; the merged replay has both hands and resources and
`pov: "both"`. Only deck order is still missing. On the 30 engine games every merged frame equals the truth
(9,493 frames). With frames dropped from one file, the frames that lose their partner keep that hand hidden and are
counted in `source.merge.unmatched`. When either file lacks log positions (SWU Forge timelines), frames that only
look alike (a mulligan keeps the board the same) are paired only when the run lengths agree; otherwise that hand stays
hidden rather than shown from the wrong moment.

The header says so: `source.pov` (`p1`, `p2`, `both` or `spectator`), `source.hiddenHands`, and `source.synthetic`
lists the step fields the importer filled in (`prompt`, `title`, `action`, `legal`, `seed`). `end.how` says how the
game ended (base destroyed, concede, timeout, or inferred when the log is missing).

What this means for the tools:

- **Viewer:** works unchanged; hidden cards show as card backs.
- **Heuristic analysis and the lens:** they use counts for hands, so an import scores the same as the full game.
  Checked on 30 engine games: subjective curves of the import equal the truth at every round end (762 of 762).
- **LLM analysis:** only the recording seat's subjective view is complete. `analysis/analyze.js` sees
  `hiddenHands` and runs `subjective_<pov>` plus `omniscient`. `objective` would only repeat the recorder's view, and
  the other seat's view cannot be built. The hindsight pass is told which hand is missing. In a merged game with
unpaired frames, checkpoints where a hand is hidden skip that seat's view and `objective`. Pass `--views` to override.
- **Fitness / bot training:** no legal-action lists, so imitation learning needs the engine to replay the decisions.

## SWU-PGN game files

[SWU-PGN](https://github.com/SWU-Karabast/forceteki/pull/2350) (draft, branch `swu-game-notation`, spec
`docs/SWU-PGN-1.0-SPEC.md`) is a game file Karabast's server can write: both deck lists, both shuffled deck orders, the
seed, and one NDJSON record per board change, with a full board ("keyframe") at every round edge. It is omniscient, so
`importer/swupgn.js` gives a replay with both hands (`source.format: "swu-pgn"`, `pov: "both"`, `hiddenHands: []`).

```bash
node importer/import.js game.swupgn --out replays/pgn
```

- **Board:** the records are folded in order (spec sections 11-13; the MOVE rule, the keyframe check and the `for`
  linking follow the MIT reference reader). The fold equals the reference reader's on all five spec test vectors and
  reproduces every keyframe in them; mismatches, if a file has any, are counted in `source.check`.
- **Decisions:** one step per action-window move (play, attack, deploy, ability, pass, claim), per `CHOICE` /
  `MODAL_CHOICE` (target, mode, who goes first; `legal` is the number offered), per mulligan / keep, and per card
  resourced in setup and regroup. An attack is two steps (attacker, then target) like a bot replay. Each step carries
  `seq` (the record it came from) and `log` (the story lines of the records it covers).
- **Header:** `source.decks`, `source.deckOrder` (INIT, before any reshuffle) and `source.cards` (the file's card
  index) keep the file's own ids (`SOR#095:2`); `source.pgnSeed`, `engineBuild`, `result`, `reason` keep the tags.
  `P1Id` / `P2Id` are never copied.
- **Not in our snapshot:** which cards are in the resource row (we keep counts; which ones are exhausted is not in the
  file either), deck order after a shuffle (not recorded), card copy ids, keywords other than Sentinel, credits and the
  Force token, Epic Action use, a flipped leader's face, `active`, annotations and `ms` timings. Captives held by a
  unit are an optional `cap` list on that unit. Base HP before round 1 comes from the first keyframe.
- **Perspective files:** a `Perspective "P1"` tag means the other player's hidden cards may be missing (the spec does
  not say how they are blanked, and the reference writer never writes one). The import then says `pov: "p1"`,
  `hiddenHands: ["p2"]`, and fills a hand whose size exceeds its known cards with hidden cards.

## Seats and privacy

`p1` is the player holding the initiative when the game starts, unless the capture says otherwise. Usernames, user ids
and player chat are never written; names default to `p1` / `p2` (`--names` sets them). Names that the engine writes
into log text as plain strings (some card abilities, lobby alerts such as a rematch request or a bug report) are
replaced by the seat, or "a spectator". SWU Forge chat entries are dropped like Karabast chat. Input file names are
not written either, unless you pass `--keep-file-names`.

## Testing

```bash
npm test                                                     # includes importer/test (format readers, rounds, chat, SWU-PGN vectors)
node importer/capture.js --bots rush,random --seeds 1-10 --out /tmp/cap   # engine captures + truth replays
node importer/verify.js /tmp/cap                             # every frame of every view against the truth
```

`capture.js` asks the engine for the exact `gamestate` Karabast would push to p1, p2 and a spectator after each
decision, next to the normal recorder replay. On 31 games (rush, random and heuristic bots, about 12,000 frames per
view) all 93 views match the truth on every frame, hidden cards by count. Capturing does not change the game (seeds
1-3 still give 594/342/486 steps).

Bots that search by rollback (heuristic) and human undo leave extra log lines. The importer takes a round alert when
the phase changes; inside a phase it takes one only when it moves the round back, comes with a "rolled back to" line,
or the phase started without one, so search leftovers do not move the round.
