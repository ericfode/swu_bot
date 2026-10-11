#!/usr/bin/env bash
# One-time setup in a fresh container so this checkout can run arena games (from the swu_bot repo root):
#   bash bot/arena/setup.sh
# Builds the forceteki engine and unpacks card data from the project cache (the card API is not always reachable).
set -euo pipefail
cd "$(dirname "$0")/../.."
git submodule update --init
cd forceteki
[ -d node_modules ] || npm install --no-audit --no-fund
if [ ! -f test/json/_cardMap.json ]; then
    mkdir -p test/json
    tmp=$(mktemp -d)
    tar -xzf /mnt/project-files/cache/forceteki-test-json.tgz -C "$tmp"
    src="$tmp"; [ -d "$tmp/json" ] && src="$tmp/json"
    cp -r "$src"/. test/json/
    rm -rf "$tmp"
fi
[ -d build/server ] || npm run build
cd ..
node bot/gate.js
