# swu_bot

The SWU Arena: a Star Wars Unlimited arena where bots play each other on the real forceteki rules engine. This repo
holds the referee and the game player, the arena window and API (`bot/arena/`), the arena server that runs the games
machine (`server/`), the SWU Arena app (`app/`), the bot interface (`spec/`) and the arena's own baseline bots. The
repository is `https://github.com/ericfode/swu_bot` (private). It began as a fork of `thrazznos/swu_bot` and became a
standalone repository with the same history on 2026-10-15, so pull request numbers restarted at #1; PRs #1 to #180 are
in the archived fork, `ericfode/swu_bot-fork`.

## Where things went

In October 2026 the project split into four repositories. This one keeps only what the live arena runs.

| Was here | Now |
|---|---|
| Every research bot (ISMCTS, omni, learned, JEPA, Jev, the Rust, C, Python, Haskell, Clojure, Lisp, Bend and WebAssembly bots), `bot/examples/`, evaluators (`bot/eval/`), learning, deck building, `analysis/`, `meta/` (except `atlas-kit.js`), `theory/`, `importer/`, the Karabast player (`bot/karabast/`), ladder sweeps and measurement scripts | [holocron](https://github.com/ericfode/holocron) (`bots/`, `lab/`, `karabast/`; see its README) |
| The Rust rules simulator and card compiler (`bot/omni-rs`, `bot/omni-wasm`, `bot/card-compiler`, `bot/cards`, `Cargo.toml`) and their measurement receipts (`results/omni-*`, now `validation/`) | [kessel](https://github.com/ericfode/kessel); the referee runs a prebuilt copy from `vendor/kessel` |
| Holotable, the replay and tournament viewer (`studio/`), its card animation and sound notes (`docs/`) and the card-animation skill | [holotable](https://github.com/ericfode/holotable); the app and the window embed its prebuilt viewer kit from `vendor/holotable` |

Everything that moved is still in this repo's history. A few files moved nowhere and live only there: the protocol
conformance, rollback and determinism checks (`bot/protocol-test.js`, `bot/rollback-test.js`,
`bot/determinism-check.js`), the Karabast feed (`bot/karabast/feed.js`), Kessel's reference-game generator and
probe fixtures (`bot/cards/reference/`, `bot/cards/pipeline/*-probe-fixture.js`) and the card-conversion skill
(`.agents/skills/swu-card-conversion/`). `vendor/README.md` says which
commit each vendored build comes from and how to refresh it. The Elixir coordinator that ran the games machine until
stage 5 (`coord/`) is in the history too: the arena server's games role (`server/src/main-games.ts`) replaced it.

## Setup on a laptop or Linux workspace

Install Git, Bash, and Node.js 22. The tested version is pinned in `.nvmrc` (22.22.3, bundled npm 10.9.8). An
existing GitHub login with repository access is needed to clone; authenticate each machine independently.

```bash
git clone --recurse-submodules https://github.com/ericfode/swu_bot.git
cd swu_bot
# If using nvm:
nvm install
nvm use
npm run setup
npm run smoke
npm run gate
```

`setup` installs the exact lockfile dependency versions with `npm ci` at the root and in `forceteki`, builds the
pinned engine, then downloads official card data. It does not start services or require API keys, and it needs no
Rust or viewer build: Kessel and the viewer kit come prebuilt in `vendor/`. Native npm dependencies are installed for
each machine; do not copy `node_modules` between macOS and Linux.

The engine's TypeScript build can exceed Node's default 2 GB heap in a Linux workspace. On a machine with enough
available RAM, allow a 4 GB heap:

```bash
NODE_OPTIONS="--max-old-space-size=4096" npm run setup
```

The process also needs memory outside that heap. If the workspace cannot provide enough memory, use a larger
workspace rather than repeatedly retrying the build.

The engine revision is the Git submodule pin, currently `2ebed8ca2dce46ced42ca90de470e0f427c596dd` on
`https://github.com/ericfode/forceteki`. An existing clone needs `git submodule sync && git submodule update --init`
after the pin or its URL changes. Setup never advances it to a remote branch. Card data is fetched from a live
upstream API and is not content-pinned by the npm lockfiles; matching code and dependencies alone cannot guarantee
identical future card data. Record the source revision and card-data snapshot when comparing experiments.

`smoke` runs the unit tests (`npm test`: the bot, arena, app and Perch tooling tests). It requires a normal Git
checkout with history (one bot test reads commit `5123bc4`), Git itself, and local HTTP sockets for the mocked Perch
integration tests. `gate` runs seeds 1–3 with and without recording and exits 1 unless both runs give 594/342/486
steps with p2 winning each game.

## Restricted networks

Dependency installation needs `registry.npmjs.org`; submodule initialization needs `github.com`. Real-game setup also
needs `admin.starwarsunlimited.com`. Card artwork is optional and comes from `cdn.swu-db.com` while viewing replays.

If the official card-data service is unavailable, `npm run setup -- --skip-cards` still builds the engine and
`npm test` still runs; the tests that play real games skip or fail without card data. Retry
`npm --prefix forceteki run get-cards` when access is available, then run the real-game checks.

## Daily commands

```bash
npm run random -- 3 1 6000          # random real seeded games; needs card data
npm run gate                        # determinism gate
npm run tournament -- --bots rush,heuristic,random --games 4 --out replays/demo   # with replays
npm run ladder -- --bots rush,aggro,tempo,control,heuristic,random --games 10
npm run app                         # SWU Arena app -> app/dist/app.html
npm test
```

A ladder started where `SWU_WINDOW` is set (cloud sessions set it) sends its run to the live arena window; unset it
for a test run. To look at replays, open them in Holotable (its own repo) or in the arena window.

## Cloud and source-transfer setup

Select `ericfode/swu_bot` in the saved environment, use Node 22, and run `npm run setup` from the repository root.
`npm run smoke` is the verification command. Use `--skip-cards` if the environment cannot reach the card API and
record that limitation. No secrets are needed for these commands.

Perch's native parser library also needs a writable cache. In restricted Linux workspaces, set a task-local cache
before preparing parsers or running Perch:

```bash
export TREE_SITTER_LANGUAGE_PACK_CACHE_DIR="$PWD/.perch/parsers"
node -e 'const p = require("@xberg-io/tree-sitter-language-pack"); p.download(["javascript", "typescript", "tsx"]); console.log(p.downloadedLanguages());'
```

This downloads parser libraries; it does not call Jev. The existing Perch integration test creates a child
environment that keeps `HOME` but drops this cache override. On a cloud host with a read-only default home cache,
that test can still fail even when the explicit cache works. Report the tooling failure and the passing application
checks separately; a writable/prepopulated default parser cache must be provided by that environment before claiming
a full-suite pass. Keep the test and its scope guards intact.

A credential-free source snapshot may include the pinned `forceteki` tree without Git metadata. The same setup
command works from that tree. Preserve its accompanying provenance and checksums; it is a snapshot, not a clone with
Git history or remotes. For that limited environment, use:

```bash
NODE_OPTIONS="--max-old-space-size=4096" npm run setup
npm run smoke:source
```

`smoke:source` runs the bot and app tests. It requires installed official card JSON. It explicitly skips the one
legacy-evaluation comparison that reads `5123bc4` from Git, and omits the Perch tooling suite (Git snapshots, parser
cache, and local HTTP mocks). It is narrower than `smoke`; passing it does not validate those omitted checks. Restore a
normal authenticated clone and run `npm run smoke` before making a PR.

Never transfer authentication, `.env`, npm caches, generated replays, or `node_modules` as part of an environment
handoff.

Claude's shared Library (`/mnt/project-files` in its sessions) is separate from this repository. Dashboards,
research, replay datasets, shared Perch cache and usage records, and other Library assets are not included by cloning
Git. Export only the assets needed for the work, separately from credentials and service configuration. Claude's
proxy-injected Fly, Jev and Sprites credentials do not carry over to other environments; basic setup needs none.

See `CLAUDE.md`, `bot/README.md`, `bot/arena/README.md`, `server/README.md` and `app/README.md` for the architecture
and component-specific workflows.
