#!/usr/bin/env bash
# Common setup entry point for macOS and Linux, including cloud workspaces.
set -euo pipefail
cd "$(dirname "$0")/.."

cards=true
case "${1:-}" in
    --skip-cards) cards=false ;;
    --help|-h)
        echo 'Usage: npm run setup -- [--skip-cards]'
        echo 'Install locked dependencies and build the engine and the viewer (studio).'
        echo '--skip-cards leaves real games unavailable; fixture viewers and non-animation unit tests still work.'
        exit 0
        ;;
    '') ;;
    *) echo "Unknown setup option: $1" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
    echo 'Only one setup option is supported.' >&2
    exit 2
fi

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

for dir in . forceteki analysis studio; do
    npm --prefix "$dir" ci --no-audit --no-fund
done
npm --prefix forceteki run build
npm --prefix studio run build

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
    echo 'Setup complete without card data. See README.md for fixture checks; full smoke requires card data.'
fi
echo 'For a source snapshot without Git history, use npm run smoke:source instead of npm run smoke.'
