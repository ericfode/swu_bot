#!/bin/sh
# Build swu-bot-hs with plain GHC (no network needed when aeson is installed, e.g. Ubuntu's libghc-aeson-dev).
# With cabal instead: cabal build && cp "$(cabal list-bin swu-bot-hs)" build/swu-bot-hs
set -e
cd "$(dirname "$0")"
mkdir -p build
ghc -O2 -Wall -Wno-name-shadowing -Wno-unused-do-bind -isrc -iapp -outputdir build -o build/swu-bot-hs app/Main.hs
