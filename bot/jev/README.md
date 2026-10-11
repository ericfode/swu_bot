# Jev bot

A bot whose decisions come from [TypeSafe](https://typesafe.ai)'s Jev model (a "System One" model that returns typed
answers with probabilities). It is a stdio bot (`spec/stdio-protocol.md`), registered as `jev` in
`bot/external-bots.json`, so it plays in `tournament.js` and `ladder.js` like any other name:

```bash
node bot/tournament.js --bots jev,random-a --games 2 --out replays/jev-test
node bot/ladder.js --bots jev,random,rush,heuristic --games 6 --workers 2 --id jev-ladder-1 --record
```

Python 3 standard library only. Needs network access to `api.typesafe.ai`.

## How it decides

For every decision with more than one legal action, one `POST /v1/systemone` request with two questions over the same
state:

- `action`: a **Choice** over the legal actions, labelled `a0`, `a1`, ... Each label is described in plain English
  ("Play Wampa from your hand (cost 4)", "Choose the opponent's Battlefield Marine in ground arena (3 power, 3 HP left)").
  The bot plays the label with the highest probability.
- `win`: a **Score** from 0 ("you almost certainly lose") to 4 ("you almost certainly win"). It does not affect the
  move; it is Jev's own position estimate, shown on the dashboard and logged.

The state is the stdio `decide` view rewritten for reading: round, phase, who has the initiative, the prompt text, and
for each side the base HP left, resources, units (power, HP left, ready/exhausted, sentinel, upgrades, card text),
leader, and, for its own side, the hand with cost and card text. Card text comes from `forceteki/test/json`. The
opponent's hand and both decks stay hidden.

Code keeps what code can do exactly:

- prompts with one legal action are answered without a call;
- damage and healing splits (kill the strongest enemy unit that can die, rest on the base; heal own units first);
- a loop guard: the same choice in the same prompt more than twice in a round is ruled out;
- if the API fails after retries, a random non-pass move (counted as a fallback).

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | none | Sent as `Authorization: Bearer ...` when set. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | API root. |
| `JEV_MODEL` | `jev-latest` | Model name (`jev-preview` also exists). |
| `JEV_TIMEOUT` | `20` | Seconds per attempt; 4 attempts with backoff. |
| `JEV_PANEL` | off | Path of a dashboard strategy panel to keep updated (`dashboard/README.md`, section 5). |
| `JEV_LOG` | off | Append one JSON line per decision: options, probabilities, choice, win estimate, latency. `{pid}` in the path becomes the process id. |
| `SWU_CARD_JSON` | `forceteki/test/json` | Card data folder. |
