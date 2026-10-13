# Persistent SWU game handles in WebAssembly

This package runs the same `omni-rs` rules and prover in Node or a browser. A `WasmGame` owns its position inside
Wasm. `clone()` copies that position there, including unresolved prompts. `prove()` runs the entire AND/OR search
inside Wasm: JavaScript does not enumerate, serialize, or apply its search nodes.

Build with Rust and Node 22:

```sh
node bot/omni-wasm/build.js --install-tools
```

`--install-tools` installs the `wasm32-unknown-unknown` Rust target if missing and the matching `wasm-bindgen`
CLI in the workspace's ignored `target/wasm-tools`. Subsequent builds need only `node bot/omni-wasm/build.js`.
Use `--target node` or `--target web` for one format; the default builds both. `--debug` selects the Rust debug
profile. Generated packages are ignored under `bot/omni-wasm/pkg/`; no paid service or credentials are involved.

Node loads `pkg/node/omni_wasm.js` as CommonJS:

```js
const fs = require('fs');
const { WasmEngine } = require('./pkg/node/omni_wasm.js');
const engine = new WasmEngine(fs.readFileSync('../omni/rs/pool.json', 'utf8'));
const game = engine.loadState(JSON.stringify(fullState));
const checkpoint = game.clone();
const actions = JSON.parse(game.legalActions());
game.apply(actions[0].key);
const result = JSON.parse(checkpoint.prove(JSON.stringify({ depth: 12, ms: 100 })));
game.free();
checkpoint.free();
engine.free();
```

Browser code imports `pkg/web/omni_wasm.js` and initializes its companion `.wasm` file:

```js
import init, { WasmEngine } from './pkg/web/omni_wasm.js';
await init();
const engine = new WasmEngine(await (await fetch('../omni/rs/pool.json')).text());
```

Serve those files over HTTP. Put synchronous proofs in a Web Worker to keep the UI responsive. The generated
TypeScript declarations describe the low-level interface; JSON strings are used only at caller boundaries.

| Method | Meaning |
| --- | --- |
| `new WasmEngine(poolJson)` | Validates supported rules and hashes the exact UTF-8 pool bytes. |
| `WasmEngine.fromCatalogue(catalogueJson, poolJson?)` | Loads admitted compiled card programs. Optional exact pool JSON restricts the card set and preserves its SHA-256. |
| `engine.poolHash()` | SHA-256 provenance shared with trace/export tools. |
| `engine.loadState(stateJson)` | Imports a complete action-window snapshot and checks its round trip. |
| `game.clone()` | Independent checkpoint, sharing only the immutable catalogue. |
| `game.snapshot()` | JSON full-state view. Importing snapshots with pending prompts is unsupported; clone them instead. |
| `game.legalActions(actor?)` | JSON action array, each with a canonical `key`; enumeration does not mutate state. |
| `game.apply(key, actor?)` | Validates and commits one action atomically. Optional actor selects a pending regroup seat. |
| `game.setActor(actor)` | Selects a pending regroup seat; otherwise it must already be that seat's turn. |
| `game.prove(limitsJson)` | `{depth,nodes,ms,tableEntries}`; omitted fields use native defaults. Does not mutate the game. |
| `game.bench(nodes)` | Complete-window deterministic rollout inside Wasm; positive integer up to 4,294,967,295. Same workload as native `bench`; does not mutate the game. |
| `game.actor()`, `round()`, `phase()`, `isActionWindow()`, `over()`, `winner()` | Small metadata reads without serializing the full state. Winner is `p1`, `p2`, `draw`, or undefined. |
| `game.stateHash()`, `poolHash()` | Diagnostic hexadecimal state hash and catalogue provenance. |
| `game.free()`, `engine.free()` | Release handles explicitly. Existing games retain their catalogue after engine disposal. |

Limits are cumulative across all iterative depths and both target players, as in the native prover. A result
with `complete: false` is unfinished; its `depth` is the last iteration completed for both targets. `null` does
not establish a draw. Only actual game choices are considered: reversible menus and rejected clicks are
normalized, and simultaneous regroup lets the defender respond after the prover commits.

The Wasm clock uses `performance.now()` through `web-time`; native builds retain `std::time::Instant`. Deadline
checks read the host clock, but game state and search decisions stay in Wasm. A call is synchronous and returns
when its time/node/depth budget finishes; terminating its Worker is the way to cancel from a browser thread.
Wasm and native throughput must be measured separately. This package makes no claim that Wasm matches the
native benchmark, and it retains the simulator's explicit card-subset boundary.
