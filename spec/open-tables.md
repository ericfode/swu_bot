# Open tables: the game log API

Every game finished on the arena window's open tables (`/tables`) is kept for training: people against people and
people against arena bots, unrated. Anyone signed in with GitHub can read them all through this API.

## Reader tokens

Sign in at `https://swu-arena.fly.dev/tables/logs` and press "Make my reader token". A token looks like
`swu_r_` and 48 hex digits; send it as `Authorization: Bearer <token>`. Making a new token ends the old one. On the
window itself, a page signed in with GitHub reads the API without a token.

## Routes

All `GET`, all JSON as `{"result": ...}` unless named otherwise; errors are `{"error": {"code", "message"}}` with
401 (no token or a wrong one) or 404.

| Route | Answer |
|---|---|
| `/api/open/games?since=<playedAt>&limit=<n>` | `{games, next}`: the kept games, oldest first, at most `limit` (default 200, at most 1000) after `since`; `next` is the `since` of the next page, or null |
| `/api/open/games/<id>.jsonl` | one game in the replay format (`spec/replay-format.md`), as `application/x-ndjson` |
| `/api/open/weeks` | `[{week, games, file}]`, by ISO week (`2026-W42`) |
| `/api/open/weeks/<week>.tar.gz` | a week as a folder Holotable opens: `tables-<week>/index.json` and `games/<id>.jsonl` |

A game row:

```json
{"id": "open-1a2b3c4d-9fe7e131", "p1": "pl_80a68a", "p2": "tinybot-v2", "people": ["p1"],
 "outcome": "won", "winnerSeat": "p1", "winner": "pl_80a68a", "rounds": 9, "steps": 208, "error": null,
 "conceded": false, "concededBy": null, "decks": {"p1": "darth-vader_jtl_yellow", "p2": "Vader Aggro"},
 "playedAt": "2026-10-16T00:50:00.479Z", "week": "2026-W42", "bytes": 396322, "sha256": "9fe7e131..."}
```

- A seat is a person's random player id (`pl_` and 6 hex digits, the same in every game of theirs until they ask for a
  new one) or an arena bot's version (`<name>-v<N>`, or `jepa-tx-gate`). GitHub names never appear.
- `outcome` is `won`, `draw` or `abandoned`; a concession is a win for the other seat with `conceded: true` and
  `concededBy` the seat that conceded.
- The replay's header has both deck lists and the game's seed and deal key, so `bot/match.js` (or Holocron's copy) can
  play the game again from its decisions; each step has the deciding seat's view and the decision.

## What to trust

Every game ran in a player's browser, and both players are trusted in this first version: nothing proves that the deal
was fair or that each decision came from the seat that made it. Use the games for training, not for ratings.

## Example

```bash
curl -H "Authorization: Bearer $SWU_TABLES_TOKEN" https://swu-arena.fly.dev/api/open/games?limit=5
curl -H "Authorization: Bearer $SWU_TABLES_TOKEN" -o week.tar.gz https://swu-arena.fly.dev/api/open/weeks/2026-W42.tar.gz
```

Holocron's `lab/tools/pull-open-tables.js` keeps a local copy up to date.
