# Replay and tournament format (v1)

What `bot/tournament.js` writes and what `viewer/` reads, as of commit `6e1ca1b`. A replay holds the decisions plus a
compact board snapshot after every decision, so a viewer never needs the engine. Machine-checkable versions:
[`schemas/replay-event.schema.json`](schemas/replay-event.schema.json),
[`schemas/tournament-index.schema.json`](schemas/tournament-index.schema.json),
[`schemas/tournament-list.schema.json`](schemas/tournament-list.schema.json). TypeScript types:
`viewer/src/core/types.ts`. Writer: `bot/match.js` (events) and `bot/recorder.js` (snapshots).

## Files

```
replays/                          (REPLAYS_DIR; gitignored)
  <tournament-id>/
    index.json                    tournament index, rewritten whole after every change
    games/
      <game-id>.jsonl             one game, JSON Lines, appended as it is played
```

- `<tournament-id>` is the basename of `--out` (e.g. `replays/demo` -> `demo`).
- `<game-id>` is `<p1 bot>-vs-<p2 bot>-<seed>`, e.g. `random-a-vs-random-b-3`.
- Pairings are round-robin over `--bots`; each pairing plays `--games` games; seeds count up from `--seed` across the
  whole tournament; the first seat alternates (odd games within a pairing swap seats).

## index.json

```json
{
  "id": "demo", "createdAt": "2026-10-10T21:04:11.123Z", "engine": "2be4fcd",
  "bots": ["random-a", "random-b", "random-c"], "gamesPerPairing": 4,
  "games": [
    { "id": "random-a-vs-random-b-1", "seed": 1, "p1": "random-a", "p2": "random-b",
      "winner": "random-b", "winnerSeat": "p2", "rounds": 14, "steps": 594, "outcome": "won", "error": null, "ms": 3120 }
  ]
}
```

| Field | Meaning |
|---|---|
| `engine` | Short git revision of `forceteki/`, or `null`. |
| `games[].winner` | Winning bot's name, `"draw"`, or `null` (no winner). |
| `games[].winnerSeat` | `"p1"`, `"p2"`, `"draw"` or `null`. |
| `games[].outcome` | `running` (listed as soon as the game starts), then `won`, `STEP_CAP`, `STUCK` or `ERROR`. |
| `games[].error` | First line of the error message (at most 200 chars) for `ERROR`, else `null`. |
| `games[].rounds`, `steps`, `ms` | Final round number, decisions taken, wall time. `0` while running. |

## Game file (`.jsonl`)

One JSON object per line, each with a `t` (type):

1. one `header`,
2. `step` with `n: 0`: the board after setup, before any decision (`label: "Game start"`),
3. one `step` per decision, `n` = 1, 2, 3, ...,
4. one `end` (absent if the game is still running or the writer died).

```jsonl
{"t":"header","v":1,"seed":3,"engine":"2be4fcd","players":[{"id":"p1","bot":"random-a","deck":"luke-skywalker#faithful-friend / echo-base"},{"id":"p2","bot":"random-b","deck":"..."}]}
{"t":"step","n":0,"label":"Game start","state":{...}}
{"t":"step","n":1,"pid":"p1","prompt":"-|single","title":"Choose a unit to attack","action":{"kind":"card","label":"wampa"},"legal":3,"state":{...}}
{"t":"end","winner":"p2","round":11,"steps":342,"outcome":"won","error":null}
```

| Event | Field | Meaning |
|---|---|---|
| `header` | `v` | Format version, currently `1`. |
| | `seed` | Game seed (number). Replaying the seed with the same bots and engine reproduces the game. |
| | `engine` | forceteki revision or `null`. |
| | `players[]` | `{ id: "p1"\|"p2", bot: <bot name>, deck: <deck metadata name> }`. Deck *lists* are not recorded. |
| `step` | `n` | Decision number; `0` is the opening board. |
| | `pid` | Seat that decided (absent on step 0). |
| | `prompt` | Prompt signature at decision time, e.g. `actionWindow\|-` (see [bot-interface.md](bot-interface.md)). |
| | `title` | Prompt text (`menuTitle`) at decision time; may be `""` or `null`. |
| | `action` | `{ kind, label }` of the chosen action (labels as in bot-interface.md). No uuids or distribute split. |
| | `legal` | Number of legal actions the bot chose from. |
| | `label` | Only on step 0: `"Game start"`. |
| | `state` | Board snapshot **after** the action and the engine's follow-up processing. |
| `end` | `winner` | `"p1"`, `"p2"`, `"draw"` or `null`. |
| | `round`, `steps`, `outcome`, `error` | As in `index.json`. |

### Snapshot (`state`)

Short keys keep files small (~0.6-1.4 MB per game raw, ~25 KB gzipped). The snapshot is **omniscient**: both hands are
listed. It does not include deck order, resource card identities or card uuids.

```json
{ "round": 3, "phase": "action", "initiative": "p1",
  "players": {
    "p1": {
      "name": "p1",
      "base": { "n": "Echo Base", "s": "SOR_023", "hp": 30, "d": 4 },
      "leader": { "n": "Luke Skywalker", "s": "SOR_005", "dep": 0, "x": 0 },
      "res": { "ready": 2, "total": 4 },
      "hand": [ { "n": "Wampa", "s": "SOR_042" } ],
      "deck": 38,
      "discard": [],
      "ground": [ { "n": "Battlefield Marine", "s": "SOR_095", "p": 3, "h": 3, "d": 1, "x": 1, "u": [ { "n": "Shield", "s": "SOR_T02", "t": 1 } ] } ],
      "space": []
    },
    "p2": { "...": "same shape" }
  } }
```

(Card names and set codes above are illustrative.)

| Path | Meaning |
|---|---|
| `round`, `phase` | Round number; `setup`, `action` or `regroup`. |
| `initiative` | Seat holding the initiative, or `null`. |
| `players.<seat>.name` | Engine user name (`p1` / `p2`). |
| card refs `n`, `s` | Card title (no subtitle) and set code `<SET>_<NNN>`, or `s: null` when the card has no set number. |
| `base.hp`, `base.d` | Printed HP and damage. Remaining = `hp - d`. |
| `leader.dep`, `leader.x` | `1` if deployed (it then also appears as a unit in `ground`/`space`), `1` if exhausted. `leader` may be `null`. |
| `res.ready`, `res.total` | Ready resources, total resources. |
| `hand` | Cards in hand (both players). |
| `deck` | Cards left in the draw deck. |
| `discard` | Discard pile, in engine order. |
| `ground`, `space` | Units this player *controls* in that arena. |
| unit `p`, `h`, `d` | Current power, current max HP, damage. |
| unit `x`, `sn` | Present and `1` when exhausted / has Sentinel; absent otherwise. |
| unit `u` | Attached upgrades (absent when none): card refs plus `t: 1` for token upgrades (Shield, Experience), else `t: 0`. |

Card art for a ref: `https://cdn.swu-db.com/images/cards/<SET>/<NNN>.png` from `s`, with `-b` before `.png` for a
deployed leader. Tokens and unreleased sets have no art.

## HTTP (viewer/server.cjs)

| Request | Response |
|---|---|
| `GET /api/tournaments` | Array of `{ id, createdAt, engine, bots, games: <count> }`, newest first. |
| `GET /replays/<tournament-id>/index.json` | The index. |
| `GET /replays/<tournament-id>/games/<game-id>.jsonl` | The game file, `application/x-ndjson`, gzip when accepted. |

## Live games

A game file is appended line by line while it is played, and `index.json` lists the game with `outcome: "running"` from
its first move. A reader following a live game must drop an unfinished last line (no trailing newline) and treat a
file with a header but no `end` as in progress. `viewer/src/core/api.ts` (`loadGame(..., allowPartial)`) does this and
re-polls.

## Compatibility rules

These keep tools written against this spec working with the original repo's files, and the original viewer working
with files that carry extra data:

- Readers must ignore unknown fields and unknown event types. The original viewer already does (it only looks at
  `header`, `step`, `end`, and passes extra fields through).
- Writers may add optional fields and new event types without changing `v`. Anything that renames, removes or
  changes the meaning of a field bumps `header.v`.
- Prefer derived data (evaluations, LLM analysis, annotations) in sidecar files next to the game, for example
  `games/<game-id>.<kind>.jsonl` keyed by step `n`, so the original replay stays byte-for-byte what the runner wrote.
- `index.json` and the `/api/tournaments` list follow the same rule.

## Gaps worth knowing

- No deck lists in the header, so a replay alone cannot say what was left in a deck.
- No card uuids in snapshots, so the same card cannot be tracked across steps when two copies share a name.
- No distribute split in `action`.
- No hidden-zone contents (deck order, resources), so "perfect information" analysis needs a re-run of the seed.

Each of these is an optional field a later writer could add under the rules above; none is implemented.
