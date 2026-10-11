# Bot interface (in-process, v1)

This is the contract the original repo uses between a bot and the forceteki engine. It is described here exactly as
implemented in `bot/env.js`, `bot/match.js` and `bot/tournament.js` at commit `6e1ca1b`; nothing in this document
changes it. A bot that follows it runs in the original tournament runner with one line added to `makeBot`.

Bots that are not JavaScript use the same contract through the stdio adapter: see [stdio-protocol.md](stdio-protocol.md).

## The bot object

A bot is any JavaScript object with:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Shown in replays and used in game file names (`<p1>-vs-<p2>-<seed>.jsonl`), so keep it file-name safe: no `/`, `\`, spaces. |
| `choose(ctx)` | function | yes | Called once per decision, **synchronously**. Returns one of `ctx.actions`. |
| `needsUndo` | boolean | no | If any bot in a game sets it, the game is created with `undo: true` so the bot can `mark`/`restore` (see Search API). |
| `stats` | object | no | Copied into the match result as `botStats`. `tournament.js` prints it assuming the heuristic bot's shape (`windows`, `noops`, `loopPasses`, `ms`, `playouts`, `failedPlayouts`), so other bots should leave it unset or use that shape. |

`ctx` is `{ game, pid, actions, rng }`:

| Field | Meaning |
|---|---|
| `game` | The `EnvGame` (below). Full engine access. |
| `pid` | Engine player id of the deciding player: `'111'` is seat `p1`, `'222'` is seat `p2` (`game.ids`). |
| `actions` | `game.legalActions(pid)`, never empty. |
| `rng` | The match's seeded RNG, `() => number in [0,1)`. Shared with the match loop, see Determinism. |

`choose` must return an element of `actions` (the same object, or a copy with the same fields; the engine call is built
from the fields in the action table below). It must not be `async`: `match.js` does not `await` it.

Bot instances: `tournament.js` builds new bot objects for every game (`seats.map(makeBot)`), while `gate.js` reuses one
pair across several games. A bot should work either way, for example by resetting per-game state when `game` changes.

**Hidden information is by convention only.** `game` exposes the whole engine, including the opponent's hand and deck
order. Fair bots read only public information about the opponent (counts for hand and deck); the heuristic bot also
reseeds the engine RNG inside its playouts so lookahead cannot see real draws. Out-of-process bots get a redacted view
instead (see the stdio protocol).

### Minimal bot

```js
// bot/players/random.js
function createRandomBot(name = 'random') {
    return { name, choose: ({ actions, rng }) => actions[Math.floor(rng() * actions.length)] };
}
```

Registering it: add a branch to `makeBot(name)` in `bot/tournament.js`, which maps a bot name from `--bots` to a fresh bot.

## Actions

`legalActions(pid)` returns plain objects. `kind` and `label` are always present; the other fields are what `apply`
needs. The `label` is for humans and logs (it is what replays record), not a stable id.

| `kind` | Fields | When offered | Engine call made by `apply` |
|---|---|---|---|
| `button` | `label` (button text), `arg` (string, or a number for choice-menu buttons), `uuid`, `method` | Every enabled prompt button, except a distribute prompt's `Done` (its `command` is `statefulPromptResults`). | `menuButton(pid, arg, uuid, method)` |
| `card` | `label` (card internal name, e.g. `luke-skywalker#faithful-friend`), `cardUuid`, `card` (live engine `Card`) | Every card in `promptState.selectableCards` that is not already selected, when the prompt is not a distribute prompt. | `cardClicked(pid, cardUuid)` |
| `option` | `label`, `arg` (string), `uuid` (prompt uuid) | One per dropdown entry (`label` = entry), and one per number from `selectNumber.min` to `max` (`label` = `#<n>`, `arg` = `"<n>"`). | `menuButton(pid, arg, uuid)` |
| `displayCard` | `label` (internal name), `arg` (card uuid), `uuid` (prompt uuid) | Each display card whose `selectionState` is `selectable`, only when the prompt has no per-card buttons. | `menuButton(pid, arg, uuid, 'menuButton')` |
| `perCardButton` | `label` (`<button text>:<internal name>`), `arg`, `cardUuid`, `uuid` (prompt uuid) | Each enabled per-card button for each display card ("cards with buttons" prompts). | `perCardMenuButton(pid, arg, cardUuid, uuid)` |
| `distribute` | `label` (`distribute <amount>`), `spec`, `targets` (card uuids), `caps` (numbers, `Infinity` = uncapped), `uuid` | Exactly one, for a distribute damage / indirect damage / healing / token prompt. | `statefulPromptResults(pid, split, uuid)` |

Every `apply` is followed by `game.continue()`, which runs the engine until it needs input again.

**Distribute.** `spec` is the engine's `IDistributeAmongTargetsPromptData`:
`{ type, amount, isIndirectDamage, canDistributeLess, canChooseNoTargets, maxTargets?, tokenType? }` with `type` one of
`distributeDamage`, `distributeIndirectDamage`, `distributeHealing`, `distributeTokenUpgrade`. The bot only chooses
*whether* to take this action; `apply` always computes the split itself with `randomDistribution(action, rng)`: random
targets (at most `maxTargets`), each given at most its cap, total equal to `amount` (or less if `canDistributeLess`).
`caps` is the unit's `remainingHp` for indirect damage on units and `Infinity` otherwise. The engine rejects a split
that names a non-target, exceeds `amount`, or (without `canDistributeLess`) does not sum to `amount`.
A bot can still pick the split by returning a copy of the action whose `targets` are its chosen uuids, `caps` the chosen
amounts, and `spec.maxTargets` their count: `randomDistribution` then has exactly one possible result. The stdio
adapter does this (`forcedDistribution` in `bot/players/external.js`).

**Multi-select prompts** (`selectCardMode: 'multiple'`): each `card` action toggles one card into the selection
(already-selected cards are not offered again); the prompt's `Done` button submits. `promptState.selectedCards` holds
the current selection.

**Stale actions.** Action objects carry prompt uuids that change when the prompt changes (and across a rollback), so
keep them only for the current decision. `game.refetch(pid, action)` finds the live action with the same
`kind`, `label`, `cardUuid` and `arg`.

## EnvGame

`Env` (one per process; loading the ~2000 card modules is slow) builds games:

```js
const { Env, seededRng } = require('./bot/env');
const env = new Env();                       // card data from forceteki/test/json
const rng = seededRng('bot' + seed);
const game = env.newGame({ seed, deck1: env.randomDeck(rng), deck2: env.randomDeck(rng), undo: false, names: ['p1', 'p2'] });
await game.start();
```

| Member | Meaning |
|---|---|
| `ids` | `['111', '222']`: engine player ids of seats `p1`, `p2`. |
| `names` | `['p1', 'p2']`: engine user names (what `winners` contains). |
| `start()` | async; initialises the engine (mulligan prompts come next). |
| `legalActions(pid)` | Actions for `pid`; empty when `pid` is only waiting. |
| `apply(pid, action, rng)` | Sends the action, then `continue()`. Throws on engine errors. |
| `over` | `true` once the engine has a winner. |
| `winners` | Engine user names of the winners (`['p2']`; two names = draw). |
| `round`, `phase` | Round number; phase name (`setup`, `action`, `regroup`). |
| `player(pid)` | The engine `Player` (base, leader, zones, prompt state). |
| `promptSignature(pid)` | Short shape string of the prompt, see below. |
| `isActionWindow(pid)` | `true` at the top-level "choose an action" prompt of the action phase. |
| `mark(pid)`, `restore(pid, id)`, `refetch(pid, a)` | Search API, below. |
| `game` | The raw forceteki `Game`. |

**Prompt signature.** `promptSignature(pid)` joins, with `|`: `promptType` (or `-`), `selectCardMode` (or `-`), then
whichever of `dist`, `num`, `dd`, `disp`, `pcb`, `batch` apply (distribute, number, dropdown, display cards, per-card
buttons, batch trigger resolution). Examples: `actionWindow|-`, `-|single`, `resource|multiple`,
`distributeAmongTargets|-|dist`, `displayCards|-|disp|pcb`. `promptType` values come from the engine's `PromptType`:
`initiative`, `number`, `resource`, `actionWindow`, `displayCards`, `distributeAmongTargets`, `triggerWindow`,
`passDelay`, `batchTriggerResolution`, `optionalTrigger`. Target selection prompts usually have no `promptType`. The
prompt's text is `player(pid).currentPrompt().menuTitle` (e.g. "Choose a unit to attack").

**Decks.** `newGame` takes decks as `{ metadata: { name, author }, leader: { id, count: 1 }, base: { id, count: 1 },
deck: [{ id, count }], isPresentInDb: false }`, where ids are set codes `<SET>_<NNN>` such as `SOR_010`.
`env.randomDeck(rng)` builds a random 50-card deck (leader and base random, cards limited to their aspects, at most
3 copies or 1 if unique); it is not checked by the engine's deck validator.

## The match loop

`playGame(env, { seed, bots, record, maxSteps = 6000, snapshot, onEvent })` in `bot/match.js`:

1. `rng = seededRng('bot' + seed)`; `deck1 = env.randomDeck(rng)`, `deck2 = env.randomDeck(rng)`; engine seeded with `String(seed)`.
2. Each step: `order = rng() < 0.5 ? [p1, p2] : [p2, p1]`. The first player in `order` with at least one legal
   action decides: `action = bot.choose(...)`, then `game.apply(pid, action, rng)`. That is one step.
   (Usually only one player has actions; the coin flip only matters when both do.)
3. Stops when `game.over` (outcome `won`), after `maxSteps` steps (`STEP_CAP`), when neither player has an action
   (`STUCK`), or on an exception from the engine or a bot (`ERROR`, with the first line of the message).
4. Result: `{ seed, steps, outcome, winner: 'p1'|'p2'|'draw'|null, round, ms, error?, events, botStats }`.

## Determinism

A game is a pure function of `seed` and the bots' behaviour. Bot RNG (`seededRng`, mulberry32) and engine RNG
(`game.setRandomSeed`) are separate and both seeded. Because `rng` is shared with the loop, a bot's calls to `rng()`
change every later coin flip and distribute split: keep them deterministic (or use a private stream seeded from one
`rng()` call, as the heuristic bot does). The regression check is `npm run gate`: two random bots on seeds 1-3 give
594/342/486 steps, p2 winning each, with and without recording.

## Search API (needs `undo: true`)

| Call | Meaning |
|---|---|
| `mark(pid)` | Manual snapshot; returns an id (`-1` when undo is off). Exact only at an action window. |
| `restore(pid, id)` | Roll back to that snapshot (throws `rollback failed`). Clears any engine error left by a failed playout. |
| `refetch(pid, action)` | Live equivalent of an action after a rollback, or `null`. |

The heuristic bot (`bot/players/heuristic.js`) is the worked example: at each action window it marks, plays each
candidate on the real engine, scores the board, restores, and plays the best.

## Known engine bugs

Random play hits two engine bugs (see the root `CLAUDE.md`); they surface as `ERROR` outcomes and are not the bot's fault.
