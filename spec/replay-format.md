# Replay and tournament format (v1)

What `bot/tournament.js` writes and what `viewer/` reads. A replay holds the decisions plus a compact board snapshot
after every decision, so a viewer never needs the engine; with its deck lists, seed and chosen action indices it can
also be played again on the engine. Fields marked *(added)* are newer than the original repo's writer; readers that
predate them ignore them. Machine-checkable versions:
[`schemas/replay-event.schema.json`](schemas/replay-event.schema.json),
[`schemas/tournament-index.schema.json`](schemas/tournament-index.schema.json),
[`schemas/tournament-list.schema.json`](schemas/tournament-list.schema.json). TypeScript types:
`viewer/src/core/types.ts`. Writer: `bot/match.js` (events) and `bot/view.js` (snapshots).

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
      "winner": "random-b", "winnerSeat": "p2", "rounds": 14, "steps": 594, "outcome": "won", "error": null, "by": null, "ms": 3120,
      "timing": { "p1": { "n": 297, "ms": 1.8, "p50": 0.004, "p95": 0.01, "max": 0.04 }, "p2": { "...": "same shape" } },
      "key": "9f2c..." }
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
| `games[].by` *(added)* | For `ERROR`: the seat whose bot caused it, which loses (`winner` is the other bot), or `null` (engine or referee; no winner). |
| `games[].faultKind` *(added, optional)* | With `by`, in runs on `bot/game-pool.js` (`ladder.js`, the arena): how the bot failed, `load` (could not be built), `error` (threw, crashed or answered wrong), `time` (over the time cap) or `hang` (stopped by the watchdog). `null` otherwise. |
| `games[].rounds`, `steps`, `ms` | Final round number, decisions taken, wall time. `0` while running. |
| `games[].timing` *(added)* | Per seat: `n` decisions, `ms` total, `p50`, `p95`, `max` per decision, in milliseconds, timed by the referee around each decision (for a program: the whole exchange, simulations included). |
| `games[].key` *(added)* | The game's own secret, which its random streams were derived from (see [protocol.md](protocol.md#fairness)), written when the game ends; `bot/ladder.js` waits until every game on its seed has ended, since the seat-swapped games share it. Absent until then and in runs seeded from the seed alone. (Indexes written before this field have one top-level `key` for the run instead.) |

## Game file (`.jsonl`)

One JSON object per line, each with a `t` (type):

1. one `header`,
2. `step` with `n: 0`: the board after setup, before any decision (`label: "Game start"`),
3. one `step` per decision, `n` = 1, 2, 3, ...,
4. one `end` (absent if the game is still running or the writer died).

A game whose bot failed at `hello` has only the header and the end.

```jsonl
{"t":"header","v":1,"seed":3,"engine":"2be4fcd","players":[{"id":"p1","bot":"random-a","deck":"luke-skywalker#faithful-friend / echo-base"},{"id":"p2","bot":"py-random","deck":"...","lang":"python"}],"decks":{"p1":{...},"p2":{...}}}
{"t":"step","n":0,"label":"Game start","state":{...}}
{"t":"step","n":1,"pid":"p1","prompt":"-|single","title":"Choose a unit to attack","action":{"kind":"card","label":"wampa","i":0,"id":"c41"},"legal":3,"state":{...}}
{"t":"step","n":2,"pid":"p2","prompt":"distributeAmongTargets|-|dist","title":"Distribute 3 damage","action":{"kind":"distribute","label":"distribute 3","i":0,"split":[{"id":"c7","amount":3}]},"legal":1,"state":{...}}
{"t":"end","winner":"p2","round":11,"steps":342,"outcome":"won","error":null,"by":null}
```

| Event | Field | Meaning |
|---|---|---|
| `header` | `v` | Format version, currently `1`. |
| | `seed` | Game seed (number). The same seed, key, bots and engine reproduce the game. |
| | `engine` | forceteki revision or `null`. |
| | `players[]` | `{ id: "p1"\|"p2", bot: <bot name>, deck: <deck metadata name>, lang? }`; `lang` *(added)* when the bot declares one. |
| | `decks` *(added)* | `{ p1, p2 }`: both deck lists, `{ metadata, leader, base, deck: [{ id, count }], isPresentInDb }`, the format `Env.newGame` takes. |
| `step` | `n` | Decision number; `0` is the opening board. |
| | `pid` | Seat that decided (absent on step 0). |
| | `prompt` | Prompt signature at decision time, e.g. `actionWindow\|-` (see [bot-interface.md](bot-interface.md)). |
| | `title` | Prompt text (`menuTitle`) at decision time; may be `""` or `null`. |
| | `action` | `{ kind, label }` of the chosen action (labels as in bot-interface.md), plus *(added)* `i` (its index among the legal actions), `id` (the card id it acts on, when it has one) and `split` (`[{ id, amount }]` sent for a distribute action, zero amounts left out). |
| | `legal` | Number of legal actions the bot chose from. |
| | `label` | Only on step 0: `"Game start"`. |
| | `state` | Board snapshot **after** the action and the engine's follow-up processing. |
| `end` | `winner` | `"p1"`, `"p2"`, `"draw"` or `null`. |
| | `round`, `steps`, `outcome`, `error`, `by`, `key` | As in `index.json` (`key` only in keyed games). `faultKind` too, where `index.json` has it. |

### Snapshot (`state`)

Short keys keep files small (~0.8-1.8 MB per game raw, ~20-30 KB gzipped). The snapshot is **omniscient**: both hands
are listed. It does not include deck order or resource card identities (they would add about half again to a file).
It is the bot's board view (protocol.md, `state`) with both hands shown and no `resources` list.

```json
{ "round": 3, "phase": "action", "initiative": "p1",
  "players": {
    "p1": {
      "name": "p1",
      "base": { "id": "c386", "n": "Echo Base", "s": "SOR_023", "hp": 30, "d": 4 },
      "leader": { "id": "c396", "n": "Luke Skywalker", "s": "SOR_005", "dep": 0, "x": 0 },
      "res": { "ready": 2, "total": 4 },
      "handCount": 1,
      "hand": [ { "id": "c41", "n": "Wampa", "s": "SOR_042" } ],
      "deck": 38,
      "discard": [],
      "ground": [ { "id": "c95", "n": "Battlefield Marine", "s": "SOR_095", "p": 3, "h": 3, "d": 1, "x": 1, "u": [ { "id": "c1201", "n": "Shield", "s": null, "t": 1 } ] } ],
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
| card refs `id` *(added)* | Card id, `c` and a number: stable for the whole game, so copies with the same name can be told apart and a card followed across zones. The same game played again gives the same ids, whatever the bots simulated. (Replays written before this used engine ids, `Card_<n>`.) |
| card refs `n`, `s` | Card title (no subtitle) and set code `<SET>_<NNN>`, or `s: null` when the card has no set number. |
| `base.hp`, `base.d` | Printed HP and damage. Remaining = `hp - d`. |
| `base.epic`, `leader.epic` *(added)* | `1` once the base's epic action or the leader's deploy is used; absent before. |
| `leader.dep`, `leader.x` | `1` if deployed (it then also appears as a unit in `ground`/`space`) or, for a double-sided leader such as Chancellor Palpatine, flipped (no unit); `1` if exhausted. `leader` may be `null`. |
| `passed`, `out` *(added)* | Action phase only: `passed: 1` when the player passed its last action, `out: 1` when it is done for the phase (claimed the initiative, or both passed). |
| `res.ready`, `res.total` | Ready resources, total resources. |
| `handCount` *(added)* | Cards in hand. |
| `force`, `credits` *(added)* | `force: 1` when the player has the Force token; `credits`: credit tokens. Both absent when zero. |
| `hand` | Cards in hand (both players). |
| `deck` | Cards left in the draw deck. |
| `discard` | Discard pile, in engine order. |
| `ground`, `space` | Units this player *controls* in that arena. |
| unit `p`, `h`, `d` | Current power, current max HP, damage. |
| unit `x`, `sn` | Present and `1` when exhausted / has Sentinel; absent otherwise. |
| unit `u` | Attached upgrades (absent when none): card refs plus `t: 1` for token upgrades (Shield, Experience), else `t: 0`. |
| unit `cap` *(added)* | Cards this unit has captured (absent when none); captured cards are open information. |

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

## Playing a replay again

With `decks`, `seed` and each step's `action.i` and `split`, a replay can be re-run on the engine:
`env.newGame({ seed: <engine seed>, deck1: decks.p1, deck2: decks.p2 })`, then for each step apply
`legalActions(<seat's pid>)[action.i]` with its `split` (card ids, mapped to engine uuids with `game.uuidOf`). The
engine seed is `String(seed)` for a run without a key; with one it is `gameStreams(seed, key).engine` from
`bot/rng.js`, with the game's own `key`. `node bot/protocol-test.js` checks that this
reproduces every recorded board. Deck order and face-down resources come back this way too, for "perfect information"
analysis.

## Gaps worth knowing

- Snapshots do not list deck order or resource cards; re-run the replay (above) to get them.
- Games imported from human play (`importer/`, see `importer/README.md`) use this format as one player saw the game,
  or both players when two captures are merged (`header.source.pov`). They have no card ids, no legal actions
  (`legal: 1`), no `decks` (known deck lists are in `source.decklists`) and no engine seed, and show the cards that
  view could not see as `{ "n": "Hidden card", "s": null, "hid": 1 }`. They cannot be played again.
