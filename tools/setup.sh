#!/usr/bin/env bash
# Common setup entry point for macOS and Linux, including cloud workspaces.
set -euo pipefail
cd "$(dirname "$0")/.."

cards=true
sandbox=true
for opt in "$@"; do
    case "$opt" in
        --skip-cards) cards=false ;;
        --skip-sandbox) sandbox=false ;;
        --help|-h)
            echo 'Usage: npm run setup -- [--skip-cards] [--skip-sandbox]'
            echo 'Install locked dependencies, build the engine, fetch the card data and set up the bot sandbox.'
            echo '--skip-cards leaves real games unavailable; the unit tests that need no card data still run.'
            echo '--skip-sandbox leaves out the sandbox bots run in (npm run dev needs it).'
            exit 0
            ;;
        *) echo "Unknown setup option: $opt" >&2; exit 2 ;;
    esac
done

if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
    echo 'Install Node.js 22 (see .nvmrc) and its bundled npm first.' >&2
    exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]; then
    echo 'Node.js 22 is required. With nvm: nvm install && nvm use' >&2
    exit 1
fi

# Source transfer archives include the pinned engine tree and need no Git login.
# Git checkouts initialise the exact recorded submodule revision, never --remote.
if [ ! -f forceteki/package-lock.json ]; then
    git submodule update --init --recursive
fi

for dir in . forceteki; do
    npm --prefix "$dir" ci --no-audit --no-fund
done
npm --prefix forceteki run build

if [ "$cards" = true ]; then
    npm --prefix forceteki run get-cards
    node -e '
        const fs = require("node:fs");
        const assert = require("node:assert/strict");
        const { computeCardDataHash } = require("./forceteki/scripts/cardDataHash");
        const root = "forceteki/test/json/";
        const map = JSON.parse(fs.readFileSync(root + "_cardMap.json", "utf8"));
        assert.ok(Object.keys(map).length > 0, "Card map is empty");
        assert.ok(fs.readdirSync(root + "Card").length > 0, "Card data is missing");
        assert.equal(fs.readFileSync(root + "card-data-hash.txt", "utf8"), computeCardDataHash());
    '
    echo 'Setup complete. Run npm run smoke, then npm run gate to check real games.'
else
    echo 'Setup complete without card data. npm test runs; real games and npm run gate need card data.'
fi

# The sandbox submitted bots run in (bot/compiled/README.md), for npm run dev: wasmtime for Python in a virtualenv of
# its own (python3 -I still loads it, and a Homebrew Python refuses pip installs into itself), Javy and CPython for
# WASI (sha256-checked), and the protocol random bot. Needs pypi.org and github.com once.
if [ "$sandbox" = true ]; then
    if ! command -v python3 >/dev/null; then
        echo 'Install Python 3 (with its venv module) first, or run setup with --skip-sandbox.' >&2
        exit 1
    fi
    venv=build/compiled/venv
    if [ ! -x "$venv/bin/python3" ]; then
        python3 -m venv "$venv"
    fi
    toolchain() { node -p "require('./bot/compiled/toolchain.json').$1"; }
    "$venv/bin/python3" -m pip install --disable-pip-version-check --quiet "wasmtime==$(toolchain python.wasmtime)"
    "$venv/bin/python3" bot/compiled/build.py --tools
    if [ -x "build/compiled/.tools/javy-$(toolchain javy.version)/javy" ]; then
        "$venv/bin/python3" bot/compiled/build.py node-random
    else
        echo 'No Javy for this computer yet: JavaScript bots and --vs random need it, Python bots and bundles do not.'
    fi
    "$venv/bin/python3" -I -c 'import wasmtime'
    echo 'Sandbox ready. Try: npm run dev -- <your bot folder>'
fi
echo 'For a source snapshot without Git history, use npm run smoke:source instead of npm run smoke.'
