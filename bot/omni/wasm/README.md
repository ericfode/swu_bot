# JavaScript adapter for the Rust simulator

The adapter holds game state and checkpoints in WebAssembly. `prove()` enters Wasm once, runs the entire Rust
search there, and returns one result. Snapshot serialization happens only when requested by the caller.

From the repository root, with Node 22 and Rust installed:

```sh
npm run wasm:build -- --install-tools
npm run wasm:test
```

The build creates both a CommonJS Node package and an ES module browser package from the same Rust source.
Generated binaries are local build outputs. Tool versions are pinned; the installer uses the workspace's
ignored `target/wasm-tools` directory instead of replacing a global installation. No service credentials are needed.

## Node

```js
const { createSimulator, fromEnvGame } = require('./bot/omni/wasm/node');
async function main(exportedPosition) {
const simulator = await createSimulator(); // default: the committed 100-card pool

// Either import a pool-aware exported position, or a live forceteki action window.
const game = simulator.loadState(exportedPosition);
// const game = fromEnvGame(simulator, existingEnvGame, actingPlayerId);

const checkpoint = game.mark();                 // copied inside Wasm
const actions = game.legalActions(game.actor);
game.apply(game.actor, actions[0]);
game.restore(checkpoint);
const result = game.prove({ depth: 12, ms: 100 }); // whole search stays inside Wasm
console.log(result);

game.free();
simulator.free();
}
// Call main() with one row from a pool-aware exported positions file.
```

`loadState` accepts a full state, its JSON text, or an exported row containing `fullState`. Exported pool hashes
must match. Imports start at action windows; copying a live Wasm handle preserves unresolved prompts too.
Returned snapshots are detached observations: editing one cannot change the retained game.

The adapter exposes `legalActions(pid)`, `apply(pid, action)`, `mark(pid)`, `restore(pid, mark)`, `isActionWindow(pid)`,
`round`, `over`, `winner`, `winners`, `snapshot()`, `clone()`, `prove(limits)`, and `free()`. Player IDs can be mapped
from the existing engine. Actions have stable canonical keys; they are not forceteki UUID-bearing objects.
`restore` keeps the selected checkpoint and discards newer ones. `free()` releases all retained checkpoints.

This is a simulator/search adapter, not an implementation of forceteki's internal object graph. Existing bots
that inspect `game.game`, live card objects, or player methods need a view/protocol adapter. The current match
runner still performs setup and mulligans in forceteki, and unsupported cards are rejected explicitly.

## Browser

```js
import { createSimulator } from './bot/omni/wasm/browser.mjs';
const simulator = await createSimulator({ poolJson: await (await fetch('./bot/omni/rs/pool.json')).text() });
const game = simulator.loadState(exportedPosition);
const result = game.prove({ depth: 12, nodes: 100000 });
game.free();
simulator.free();
```

Serve the generated `.wasm` alongside its loader over HTTP. Run proofs in a Worker when connected to an
interactive UI: the call is synchronous until its budget completes. Browser state/search use the same Rust
implementation; filesystem loading is kept in the Node adapter.

## Command-line integration and checks

```sh
# Exact fixture/corpus replay through the JavaScript adapter.
node bot/omni/wasm/check.js bot/omni-rs/tests/fixtures/*.jsonl.gz

# Existing JS match runner, using Wasm for complete endgame searches.
node bot/omni/solve-games.js --engine wasm --pool bot/omni/rs/pool.json --bots aggro,control --seeds 101 --budget 2000 --depth 12 --sample 0 --out replays/wasm-solves

# Prove exported positions, with a fixed budget or their measured JS time allowance.
node bot/omni/wasm/prove.js replays/omni-rs-matched.jsonl --depth 12 --ms-field jsMs
node bot/omni/wasm/prove.js replays/omni-rs-matched.jsonl --depth 12 --nodes 100000

# Three whole-Wasm rollout runs, with one 10,000-node warmup.
node bot/omni/wasm/bench.js bot/omni-rs/tests/fixtures/heuristic-vs-heuristic-1.jsonl.gz 1000000 3
```

`solve-games.js` defaults to its existing JavaScript prover. `--engine wasm` requires an explicit pool and retains
each measured position in Wasm during the game; proving does not roll back the JS engine. Its `--budget` remains
a cumulative node budget per window solve. The file prover also records import time and caller-observed latency,
separately from the Rust search time. `bench` executes every rollout transition in Wasm, not in a JS loop.

[Low-level bindings, memory ownership, and exact proof semantics](../../omni-wasm/README.md).
