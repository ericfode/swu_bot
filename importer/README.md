# Importer: human games from karabast.net

Turns captures of real games played on [Karabast](https://karabast.net) into our replay format
(`spec/replay-format.md`), so the viewer, the position analysis (`analysis/`) and the omni lens (`bot/omni/lens.js`)
read them like any bot game.

Karabast runs the same forceteki engine as this repo. After every change its server pushes a `gamestate` object to
each player (`Game.getState(viewerId)`). Browser extensions such as KaraBuddy and SWU Forge's Kara Tracker save that
stream. The importer reads the saved stream; it needs no engine and no card data.

## Usage

```bash
node importer/import.js <capture file or dir>... --out replays/human [--names Alice,Bob] [--source karabuddy]
npm run viewer    # REPLAYS_DIR defaults to replays/, so replays/human shows up as a tournament
node analysis/analyze.js replays/human --evaluator heuristic
node bot/omni/lens.js replays/human --out replays/human/lens   # omni lens (bot/omni is not on main yet)
```

When both players recorded the same game, pair the two files to get one replay with both hands:

```bash
node importer/import.js --pair alice.karareplay bob.karareplay --out replays/human   # -> <alice id>.both.jsonl
```

Each input becomes `<out>/games/<id>.jsonl`, and `<out>/index.json` is rewritten in the tournament format with
`human: true` and `pov` on each entry.

Inputs are detected from the content (`sources.js`):

| input | from |
|---|---|
| KaraBuddy replay file, v1 (raw states) or v2 (`{full}` / `{patch}` per event) | KaraBuddy extension download |
| `{ events: [{full} \| {patch}] }` | KaraBuddy test fixture shape |
| SWU Forge Battle Log `PersistedTimeline` v2/v3 (`base` + `steps[{timestamp, patch}]` + `chat`) | Kara Tracker extension |
| socket.io text frames, one per line: `42["gamestate",{...}]` | browser devtools export of the game socket |
| JSON array or JSON Lines of `gamestate` objects | any other recorder |
| `importer/capture.js` output | engine-made test captures |

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
counted in `source.merge.unmatched`.

The header says so: `source.pov` (`p1`, `p2`, `both` or `spectator`), `source.hiddenHands`, and `source.synthetic`
lists the step fields the importer filled in (`prompt`, `title`, `action`, `legal`, `seed`). `end.how` says how the
game ended (base destroyed, concede, timeout, or inferred when the log is missing).

What this means for the tools:

- **Viewer:** works unchanged; hidden cards show as card backs.
- **Heuristic analysis and the lens:** they use counts for hands, so an import scores the same as the full game.
  Checked on 30 engine games: subjective curves of the import equal the truth at every round end (762 of 762).
- **LLM analysis:** only the recording seat's subjective view is complete. `analysis/analyze.js` sees
  `hiddenHands` and runs `subjective_<pov>` plus `omniscient`. `objective` would only repeat the recorder's view, and
  the other seat's view cannot be built. The hindsight pass is told which hand is missing. Pass `--views` to override.
- **Fitness / bot training:** no legal-action lists, so imitation learning needs the engine to replay the decisions.

## Seats and privacy

`p1` is the player holding the initiative when the game starts, unless the capture says otherwise. Usernames, user ids
and player chat are never written; names default to `p1` / `p2` (`--names` sets them).

## Testing

```bash
npm test                                                     # includes importer/test (format readers, rounds, chat)
node importer/capture.js --bots rush,random --seeds 1-10 --out /tmp/cap   # engine captures + truth replays
node importer/verify.js /tmp/cap                             # every frame of every view against the truth
```

`capture.js` asks the engine for the exact `gamestate` Karabast would push to p1, p2 and a spectator after each
decision, next to the normal recorder replay. On 31 games (rush, random and heuristic bots, about 12,000 frames per
view) all 93 views match the truth on every frame, hidden cards by count. Capturing does not change the game (seeds
1-3 still give 594/342/486 steps).

Bots that search by rollback (heuristic) and human undo leave extra log lines; the importer only trusts round alerts
when the phase changes, so they do not move the round.
