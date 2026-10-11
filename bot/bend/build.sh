#!/bin/sh
# Builds the Bend bot: the card tables from forceteki/test/json (npm run
# get-cards in forceteki/ first), then the native binary bot/bend/swu-bend.
# Needs node, bun, clang and a Bend 2 checkout (github.com/bendlang/bend):
#   BEND2=~/bend/bend2/main.ts bot/bend/build.sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
node "$here/tools/gen-cards.js"
cd "$here"
bun "${BEND2:?set BEND2 to the bend2/main.ts of a Bend checkout}" main.bend -o swu-bend
echo "built $here/swu-bend"
