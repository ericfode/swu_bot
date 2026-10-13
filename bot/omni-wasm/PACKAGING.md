# Portable Wasm distribution

The local `@swu-bot/omni-wasm` tarball contains Node and browser bindings, both
Wasm binaries, the shared JavaScript handle adapter, and the original 100-card
pool. It has no runtime npm dependencies and does not need this repository or
forceteki. Game state, cloning, transitions, and proof search remain in Wasm.
There is no bot strategy in this package.

Build and pack from the repository root:

```sh
npm run wasm:build
npm run wasm:pack
node bot/omni-wasm/verify-package.js
```

The pack command only packages existing bindings; it never rebuilds or publishes.
The verifier extracts the tarball into a temporary directory and checks package
exports, state/clone/search behavior, external catalogue loading, and Node/web
Wasm parity without repository runtime imports. Its web check runs the browser
ESM bindings in Node; it does not test HTTP serving or browser rendering.
The tarball and a SHA-256 receipt are written under
`bot/omni-wasm/pkg/distribution/`. This directory is ignored by Git. The package
is marked private and has no publish command. Install the tarball locally:

```sh
npm install /absolute/path/swu-bot-omni-wasm-0.1.0.tgz
```

## Node

```js
const { createSimulator } = require('@swu-bot/omni-wasm');
const simulator = await createSimulator(); // included original 100-card pool
const game = simulator.loadState(fullState);
const checkpoint = game.clone();
const actions = game.legalActions();
game.apply(actions[0]);
const proof = checkpoint.prove({ depth: 12, nodes: 10000 });
checkpoint.free();
game.free();
simulator.free();
```

`createSimulator` also accepts `poolJson`/`poolPath` and
`catalogueJson`/`cataloguePath`. Supplying a compiled catalogue activates its
explicitly admitted card programs. Without a separate pool it uses all admitted
cards; supplying pool JSON restricts that set and preserves its exact SHA-256.
The large evolving catalogue is deliberately supplied by the caller rather than
bundled as an implicit default.

## Browser or worker

```js
import { createSimulator } from '@swu-bot/omni-wasm/browser';
const simulator = await createSimulator({ poolJson });
// Or: await createSimulator({ catalogueJson, poolJson });
```

For direct HTTP hosting, serve the extracted package unchanged and import
`./browser.mjs`. It imports `./adapter.mjs` and the bindings relative to itself;
the web bindings locate their adjacent `.wasm` file. Serve WebAssembly as
`application/wasm`. A bundler can resolve the package's `browser` export or the
explicit `/browser` entry. The `/wasm` export identifies the web binary if the
host needs to provide an explicit initialization module or URL via `wasm`.

Browser callers supply JSON text explicitly. For the original pool they can
fetch the included `pool.json`; expanded programs require caller-supplied
`catalogueJson`. Run synchronous proofs in a Web Worker to keep the UI responsive.

## Boundary

The input is the complete simulator state schema used by `omni-rs`, including
hidden zones for both players. Host applications must decide which positions
are appropriate to provide. Low-level typed bindings are exported at
`/bindings/node` and `/bindings/web`; `/adapter` exports `WasmSimulator` and
`WasmGame`. No forceteki bridge is included: host state conversion belongs to the
host, while all supported game rules and search remain in the shared core.

This is a portable subset engine, not full SWU or a drop-in Karabast replacement.
Unsupported cards or state fail explicitly. Runtime admission and passing seeded
conformance traces do not establish every interaction. An incomplete proof
(`complete: false`) is not a draw or a solved position.
