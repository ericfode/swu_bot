# Engine interface (JavaScript)

Bots normally play through the [protocol](protocol.md), as clients of the referee. This page describes the layer
under it: `EnvGame` (the engine wrapper in `bot/env.js`), how each action becomes an engine call, the match loop in
`bot/match.js`, determinism, and **native bots**, the special case of a JavaScript object that reads the engine itself.

## Native bots

A native bot is a JavaScript object with engine access. Use one only when the code needs the engine itself (search
that marks and restores it, like `bot/players/heuristic.js`); anything else is simpler and fairer as a protocol
client, which can also run in process.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Shown in replays and used in game file names (`<p1>-vs-<p2>-<seed>.jsonl`), so keep it file-name safe: no `/`, `\`, spaces. |
| `choose(ctx)` | function | yes | Called once per decision, **synchronously**. Returns one of `ctx.actions`. |
| `needsUndo` | boolean | no | The game is created with rollback enabled, for the search API below. |
| `stats` | object | no | Copied into the match result as `botStats`. |

`ctx` is `{ game, pid, actions, rng }`: the `EnvGame`, the engine player id of the deciding player (`'111'` is seat
`p1`, `'222'` is `p2`), `game.legalActions(pid)` (never empty) and the match rng (see Determinism).

`choose` returns an element of `actions`, or a copy with the same `kind`, `label`, `cardUuid` and `arg`. For a
`distribute` action the copy may add `split` (below). `match.js` does not `await` it.

**Hidden information is by convention only.** `game` exposes the whole engine, including the opponent's hand and the
order of both decks. A fair native bot reads only what a protocol client is sent (`view(game, seat)` in `bot/view.js`
builds exactly that), and before looking ahead it deals the hidden cards again with `determinize(game, pid, rng)` from
`bot/protocol.js`, as the referee does for simulations.

```js
// bot/players/random.js
function createRandomBot(name = 'random') {
    return { name, choose: ({ actions, rng }) => actions[Math.floor(rng() * actions.length)] };
}
```

Registering a bot by name for `node bot/tournament.js --bots ...`: a bot program goes in `bot/external-bots.json`
([protocol.md](protocol.md#running-bot-programs)); a JavaScript bot gets a branch in `makeBot(name)` in
`bot/tournament.js`, which returns a fresh bot per game.

## Actions

`legalActions(pid)` returns plain objects. `kind` and `label` are always present; the other fields are what `apply`
needs. The `label` is for people and logs, not a stable id.

| `kind` | Fields | When offered | Engine call made by `apply` |
|---|---|---|---|
| `button` | `label` (button text), `arg` (string, or a number for choice-menu buttons), `uuid`, `method` | Every enabled prompt button, except a distribute prompt's `Done` (its `command` is `statefulPromptResults`). | `menuButton(pid, arg, uuid, method)` |
| `card` | `label` (card internal name, e.g. `luke-skywalker#faithful-friend`), `cardUuid`, `card` (live engine `Card`) | Every card in `promptState.selectableCards` that is not already selected, when the prompt is not a distribute prompt. | `cardClicked(pid, cardUuid)` |
| `option` | `label`, `arg` (string), `uuid` (prompt uuid) | One per dropdown entry (`label` = entry), and one per number from `selectNumber.min` to `max` (`label` = `#<n>`, `arg` = `"<n>"`). | `menuButton(pid, arg, uuid)` |
| `displayCard` | `label` (internal name), `arg` (card uuid), `uuid` (prompt uuid) | Each display card whose `selectionState` is `selectable`, only when the prompt has no per-card buttons. | `menuButton(pid, arg, uuid, 'menuButton')` |
| `perCardButton` | `label` (`<button text>:<internal name>`), `arg`, `cardUuid`, `uuid` (prompt uuid) | Each enabled per-card button for each display card ("cards with buttons" prompts). | `perCardMenuButton(pid, arg, cardUuid, uuid)` |
| `distribute` | `label` (`distribute <amount>`), `spec`, `targets` (card uuids), `caps` (numbers, `Infinity` = uncapped), `uuid`, optional `split` | Exactly one, for a distribute damage / indirect damage / healing / token prompt. | `statefulPromptResults(pid, { type, valueDistribution }, uuid)` |

Every `apply` is followed by `game.continue()`, which runs the engine until it needs input again.

**Distribute.** `spec` is the engine's `IDistributeAmongTargetsPromptData`:
`{ type, amount, isIndirectDamage, canDistributeLess, canChooseNoTargets, maxTargets?, tokenType? }` with `type` one of
`distributeDamage`, `distributeIndirectDamage`, `distributeHealing`, `distributeTokenUpgrade`. `caps` is the unit's
`remainingHp` for indirect damage on units and `Infinity` otherwise. A split is `[{ id, amount }]`; `apply` sends
`action.split` when set and otherwise a random legal split drawn from `rng`, drops zero entries, and returns what it
sent. `splitError(action, split)` from `bot/env.js` returns why a split is illegal, or `null`: listed targets only, each
once, integer amounts `0..cap`, at most `maxTargets` non-zero entries, total equal to `amount` (at most `amount` with
`canDistributeLess`, 0 only with `canChooseNoTargets`).

**Multi-select prompts** (`selectCardMode: 'multiple'`): each `card` action toggles one card into the selection
(already-selected cards are not offered again); the prompt's `Done` button submits. `promptState.selectedCards` holds
the current selection.

**Stale actions.** Action objects carry prompt uuids that change when the prompt changes (and across a rollback), so
keep them only for the current decision. `game.refetch(pid, action)` finds the live action with the same
`kind`, `label`, `cardUuid` and `arg`.

## EnvGame

`Env` (one per process; loading the ~2000 card modules takes about 7 s) builds games:

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
| `seatOf(pid)`, `pidOf(seat)` | Convert between the two. |
| `names` | `['p1', 'p2']`: engine user names (what `winners` contains). |
| `start()` | async; initialises the engine (mulligan prompts come next). |
| `legalActions(pid)` | Actions for `pid`; empty when `pid` is only waiting. |
| `apply(pid, action, rng)` | Sends the action, then `continue()`. Returns the split for a distribute action. Throws on engine errors. |
| `over`, `winner` | `true` once the engine has a winner; the winning seat, `'draw'`, or `null`. |
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

`playGame(env, { seed, bots, record, maxSteps = 6000, snapshot, onEvent, key, limits })` in `bot/match.js` is async.
Each bot is a protocol client or a native bot; it gets a seat object from `bot/protocol.js` (`ClientSeat` or
`NativeSeat`) with the same methods, so the loop does not care which.

1. Random streams come from `gameStreams(seed, key)` (`bot/rng.js`): the match rng, the engine seed, each seat's
   `hello.seed` and each seat's simulation stream. Two decks are drawn from the match rng.
2. Each protocol client gets `hello`, one after the other. The engine game is created (rollback enabled when a native
   bot sets `needsUndo` or a client asks for simulations) and started.
3. Each step: `order = rng() < 0.5 ? [p1, p2] : [p2, p1]`. The first seat in `order` with a legal action decides, and
   `game.apply(pid, action, rng)` plays it. That is one step. (Usually only one seat has actions; the coin flip only
   matters when both do.)
4. Stops when `game.over` (outcome `won`), after `maxSteps` steps (`STEP_CAP`), when neither seat has an action
   (`STUCK`), or on an exception (`ERROR`, first line of the message; `by` is the seat when a bot caused it).
5. Every protocol client that joined gets `over`, except the one named by `by`.
6. Result: `{ seed, steps, outcome, winner: 'p1'|'p2'|'draw'|null, round, ms, error?, by?, events, botStats, timing }`.
   `timing` is per seat `{ n, ms, p50, p95, max }`, the decision times the referee measured.

`limits` overrides the reply budgets (`{ hello, decide, over }` in ms, defaults in `LIMITS` of `bot/protocol.js`).

## Determinism

A game is a pure function of `seed`, `key` and the bots' behaviour. The match rng is drawn from in a fixed order: the
two decks, then per step the coin flip, a native bot's own draws, and a random split. Protocol clients never draw
from it, so recording, timing and simulations change nothing. A native bot that calls `ctx.rng()` changes every later
coin flip and split: keep those calls deterministic, or seed a private stream from one call as the heuristic bot does.

Without a key the streams match upstream (`seededRng('bot' + seed)`, engine seed `String(seed)`), and `npm run gate`
checks it: two random bots on seeds 1-3 give 594/342/486 steps, p2 winning each, with and without recording.

## Search API (needs rollback)

| Call | Meaning |
|---|---|
| `mark(pid)` | Manual snapshot; returns an id (`-1` when undo is off). Exact only at an action window. |
| `restore(pid, id)` | Roll back to that snapshot (throws `rollback failed`). Clears any engine error left by a failed playout. |
| `refetch(pid, action)` | Live equivalent of an action after a rollback, or `null`. |

A rollback restores the engine rng but not the counter that numbers new cards, so tokens created after a rollback get
new ids. The heuristic bot (`bot/players/heuristic.js`) is the worked example: at each action window it marks, plays
each candidate on the real engine, scores the board, restores, and plays the best. Protocol clients get the same
power, without seeing hidden cards, through [simulations](protocol.md#sim--simulated).

## Known engine bugs

Random play hits two engine bugs (see the root `CLAUDE.md`); they end games with `ERROR` and `by: null`.
