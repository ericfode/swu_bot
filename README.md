# swu_bot

A Star Wars Unlimited bot lab using the real forceteki rules engine, with
tournament runners, replay viewers, and position analysis. Development uses
Eric's fork, `https://github.com/ericfode/swu_bot`, whose upstream is
`https://github.com/thrazznos/swu_bot`. Both repositories are private.

## Setup on a laptop or Linux workspace

Install Git, Bash, and Node.js 22. The tested version is pinned in `.nvmrc`
(22.22.3, bundled npm 10.9.8). An existing GitHub login with repository access is
needed to clone; authenticate each machine independently.

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

`setup` installs the exact lockfile dependency versions with `npm ci` at the root
and in `forceteki`, `viewer`, `analysis`, and `studio`. It builds the pinned
engine and both viewers, then downloads official card data. It does not start
services or require API keys. Native npm dependencies are installed for each
machine; do not copy `node_modules` between macOS and Linux.

The engine's TypeScript build can exceed Node's default 2 GB heap in a Linux
workspace. On a machine with enough available RAM, allow a 4 GB heap:

```bash
NODE_OPTIONS="--max-old-space-size=4096" npm run setup
```

The process also needs memory outside that heap. If the workspace cannot provide
enough memory, use a larger workspace rather than repeatedly retrying the build.

The engine revision is the Git submodule pin, currently
`2ebed8ca2dce46ced42ca90de470e0f427c596dd` on `https://github.com/ericfode/forceteki`.
An existing clone needs `git submodule sync && git submodule update --init` after
the pin or its URL changes. Setup never advances it to a remote
branch. Card data is fetched from a live upstream API and is not content-pinned
by the npm lockfiles; matching code and dependencies alone cannot guarantee
identical future card data. Record the source revision and card-data snapshot
when comparing experiments.

`smoke` runs the root, analysis, and studio animation tests and builds both viewers.
Animation rules tests read the installed official card JSON, so run the default
setup (including cards) before the full smoke check.
It requires a normal Git checkout with history (including commit `5123bc4`), Git
itself, and local HTTP sockets for the mocked Perch integration tests.
`gate` runs seeds 1–3 with and without recording and exits 1 unless both runs
give 594/342/486 steps with p2 winning each game.

## Restricted networks and fixture development

Dependency installation needs `registry.npmjs.org`; submodule initialization
needs `github.com`. Real-game setup also needs `admin.starwarsunlimited.com`.
Card artwork is optional and comes from `cdn.swu-db.com` while viewing replays.

If the official card-data service is unavailable:

```bash
npm run setup -- --skip-cards
npm test && npm run analysis:test && npm run viewer:build && npm --prefix studio run build
npm --prefix studio run fixtures
REPLAYS_DIR="$PWD/studio/fixtures/replays" npm run studio:dev
```

The fixture games are synthetic and support viewer development; they do not
validate the real rules engine. Retry `npm --prefix forceteki run get-cards`
when access is available, then run the real-game checks.

## Daily commands

```bash
npm run random -- 3 1 6000          # real seeded games; needs card data
npm run demo                       # generate replays/demo
npm run viewer                     # original viewer, http://localhost:5180
npm run studio:dev                 # Holotable, http://localhost:5190
npm run test:py                    # optional Python bot tests; Python 3 required
```

Stop viewer processes with Ctrl-C. In a cloud workspace, use its authenticated
port preview/forwarding for 5180 or 5190. If that preview requires binding Vite
on all interfaces, use `npm run studio:dev -- --host 0.0.0.0` inside that
workspace; keep its access controls in place.

Rust, C, Haskell, Clojure, Lisp, Bend, Lean, and learned-model tooling are
optional; follow the corresponding `bot/<language>/README.md` or
`theory/README.md` only when working on those components. Basic setup does not
install these toolchains or run paid model analysis or deployment commands.

## Cloud and source-transfer setup

Select `ericfode/swu_bot` in the saved environment, use Node 22, and run
`npm run setup` from the repository root. `npm run smoke` is the verification
command. Use `--skip-cards` if the environment cannot reach the card API and
record that limitation. No secrets are needed for these commands.

Perch's native parser library also needs a writable cache. In restricted Linux
workspaces, set a task-local cache before preparing parsers or running Perch:

```bash
export TREE_SITTER_LANGUAGE_PACK_CACHE_DIR="$PWD/.perch/parsers"
node -e 'const p = require("@xberg-io/tree-sitter-language-pack"); p.download(["javascript", "typescript", "tsx"]); console.log(p.downloadedLanguages());'
```

This downloads parser libraries; it does not call Jev. The existing Perch
integration test creates a child environment that keeps `HOME` but drops this
cache override. On a cloud host with a read-only default home cache, that test
can still fail even when the explicit cache works. Report the tooling failure
and the passing application checks separately; a writable/prepopulated default
parser cache must be provided by that environment before claiming a full-suite
pass. Keep the test and its scope guards intact.

A credential-free source snapshot may include the pinned `forceteki` tree
without Git metadata. The same setup command works from that tree. Preserve
its accompanying provenance and checksums; it is a snapshot, not a clone with
Git history or remotes. For that limited environment, use:

```bash
NODE_OPTIONS="--max-old-space-size=4096" npm run setup
npm run smoke:source
```

`smoke:source` runs bot, importer and app tests, analysis and studio animation checks,
and both viewer builds. It requires installed official card JSON. It explicitly skips the one legacy-evaluation comparison that reads
`5123bc4` from Git, and omits the Perch tooling suite (Git snapshots, parser
cache, and local HTTP mocks). It is narrower than `smoke`; passing it does not
validate those omitted checks. The original tests remain unchanged. Restore a
normal authenticated clone and run `npm run smoke` before making a PR.

Never transfer authentication, `.env`, npm caches,
generated replays, or `node_modules` as part of an environment handoff.

Claude's shared Library (`/mnt/project-files` in its sessions) is separate from
this repository. Dashboards, research, replay datasets, shared Perch cache and
usage records, and other Library assets are not included by cloning Git. Export
only the assets needed for the work, separately from credentials and service
configuration. Claude's proxy-injected Fly, Jev and Sprites credentials do not
carry over to other environments; basic setup and fixture development need none.

See `CLAUDE.md`, `bot/README.md`, `studio/README.md`, and `analysis/README.md` for
the architecture and component-specific workflows.
