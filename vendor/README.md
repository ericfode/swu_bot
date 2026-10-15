# vendor/

Built files from the project's other repositories that the arena runs, committed at a pinned commit so the images
build no Rust and no viewer. Each folder has a `VERSION.json`: the source repository and commit, how it was built, and
the size and sha256 of every file (`bot/test/sims.test.js` checks Kessel's). `notices/<name>.md` lists the third-party
packages each build bundles, with their licenses and license texts (`notices.js`; it sits outside the folders, so a
change to it alone deploys nothing). Never edit these files by hand.

| Folder | From | What uses it |
|---|---|---|
| `kessel/` | [ericfode/kessel](https://github.com/ericfode/kessel): `crates/kessel-wasm/js/{node.js,adapter.mjs}` and the Node package `crates/kessel-wasm/pkg/node` | `bot/sims/rust-sims.js`: the referee's simulations on the Rust engine (`"simEngine": "rust"`, `spec/protocol.md`); the games image copies it (`Dockerfile.games`) |
| `holotable/` | [ericfode/holotable](https://github.com/ericfode/holotable): the viewer kit `dist-kit/swu-viewer-kit.js`, built with this repo's `meta/atlas-kit.js` | the window serves it as `/kit.js` (`bot/arena/window.js`, `Dockerfile`); `app/build.mjs` embeds it |

## Refresh

```bash
node vendor/refresh.js kessel <kessel clone> <commit>         # needs cargo, rustup and the wasm32-unknown-unknown target
node vendor/refresh.js holotable <holotable clone> <commit>   # needs npm and the registry
```

The script exports the commit with `git archive` into a temporary folder, builds it there (Kessel:
`crates/kessel-wasm/build.js --target node --install-tools`, which installs the wasm-bindgen it pins unless
`WASM_BINDGEN` names that version; Holotable: `npm ci` and `npm run build:kit` with `ATLAS_KIT=meta/atlas-kit.js`),
replaces the folder and writes its `VERSION.json` and `notices/<name>.md` (from a second kit build with a source map
for Holotable, from `cargo tree` and `cargo metadata` for Kessel; Kessel's also needs the `forceteki/` submodule for
forceteki's license until Kessel ships `LICENSE.forceteki`). Kessel builds with its paths remapped, so the same commit and
toolchain give the same bytes. Commit the folder with the commit it came from in the message, then run `npm test`.
Kessel's `fromEnvGame` takes the forceteki state exporter as its last argument (`fullState` from `bot/sims/state.js`);
the referee loads positions with `loadState` and does not call it.
