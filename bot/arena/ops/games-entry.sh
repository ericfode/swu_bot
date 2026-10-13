#!/bin/sh
# The games machine's first process (Dockerfile.games). GAMES_COORDINATOR (fly.games.toml) picks the program that runs
# the machine: "elixir" the Elixir coordinator (coord/, coord/README.md), anything else bot/arena/games.js. Both use
# the same /data, so switching back needs no migration: `fly machine update <id> --env GAMES_COORDINATOR=node`.
if [ "${GAMES_COORDINATOR:-node}" = elixir ]; then
    exec /app/coord/bin/coord start
fi
exec node bot/arena/games.js
