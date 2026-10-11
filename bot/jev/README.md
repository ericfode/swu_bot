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

## jev-look: imagine before deciding

`jev-look` is the same program started with `--look` behind the adapter `bot/jev/look.js` (an `ExternalBot` subclass
with engine rollback). At an action window where Jev's favourite move has less than 80% probability, it asks Jev a
second Choice: which situation to imagine, from a small vocabulary over its top 3 moves:

| Situation | What the engine plays out |
|---|---|
| `after` | The move, with its follow-up choices (targets etc.), until the next action window. |
| `reply` | The move, then the opponent's most aggressive board reply (strongest ready unit attacks, else leader, else pass). |
| `round` | The move, then both sides keep making board moves until the round ends (at most 40 steps). |
| `decide` | Stop imagining and act. |

The adapter marks the game, plays the situation, rolls back, and returns the board from Jev's seat plus the steps
taken. The bot adds a summary (what happened, what changed, both boards) to the state as `imagined`, asks the action
question again with it, and repeats until Jev picks `decide` or 3 imaginations are used. Imagined lines never use the
opponent's hand cards, and draws and shuffles use a private seed, so they reveal nothing hidden.

Wire format (additive to the stdio protocol): the bot answers `decide` with
`{"t":"imagine","situation":{"kind":"after","i":3}}`; the adapter answers
`{"t":"imagined","seq":12,"ok":true,"left":2,"state":{...},"over":false,"winner":null,"steps":[{"who":"p1","at":"action","what":"Wampa"}]}`.
Every `decide` sent through this adapter carries `imagine: {kinds, left}` at action windows and `imagine: null`
elsewhere. Any stdio bot can use it by setting `"adapter": "bot/jev/look.js"` in `external-bots.json`.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | none | Sent as `Authorization: Bearer ...` when set. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | API root. |
| `JEV_MODEL` | `jev-latest` | Model name (`jev-preview` also exists). |
| `JEV_TIMEOUT` | `20` | Seconds per attempt; 4 attempts with backoff. |
| `JEV_PANEL` | off | Path of a dashboard strategy panel to keep updated (`dashboard/README.md`, section 5). `{name}` becomes `jev` or `jev-look`. |
| `JEV_LOOK_CONFIDENT` | `0.8` | `jev-look` imagines only when the top move is less likely than this. |
| `JEV_LOG` | off | Append one JSON line per decision: options, probabilities, choice, win estimate, latency. `{pid}` in the path becomes the process id. |
| `SWU_CARD_JSON` | `forceteki/test/json` | Card data folder. |
