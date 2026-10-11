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

The engine revision is the Git submodule pin, currently
`2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`. Setup never advances it to a remote
branch. Card data is fetched from a live upstream API and is not content-pinned
by the npm lockfiles; matching code and dependencies alone cannot guarantee
identical future card data. Record the source revision and card-data snapshot
when comparing experiments.

`smoke` runs the existing root and analysis tests and builds both viewers.
`gate` runs seeds 1–3 with and without recording. It prints results rather than
asserting them; compare both runs and check for errors. The documented baseline
is 594/342/486 steps with p2 winning each game.

## Restricted networks and fixture development

Dependency installation needs `registry.npmjs.org`; submodule initialization
needs `github.com`. Real-game setup also needs `admin.starwarsunlimited.com`.
Card artwork is optional and comes from `cdn.swu-db.com` while viewing replays.

If the official card-data service is unavailable:

```bash
npm run setup -- --skip-cards
npm run smoke
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

A credential-free source snapshot may include the pinned `forceteki` tree
without Git metadata. The same setup command works from that tree. Preserve
its accompanying provenance and checksums; it is a snapshot, not a clone with
Git history or remotes. Restore a normal authenticated clone before pushing or
collaborating through Git. Never transfer authentication, `.env`, npm caches,
generated replays, or `node_modules` as part of an environment handoff.

See `CLAUDE.md`, `bot/README.md`, `studio/README.md`, and `analysis/README.md` for
the architecture and component-specific workflows.
