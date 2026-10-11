#!/usr/bin/env bash
# Starts the Bend bot. Bend reads stdin by opening /dev/stdin, which fails
# (ENXIO) when stdin is a socket, as with Node's child_process.spawn, so cat
# turns it into a pipe. exec makes the bot this process: a kill of the PID the
# harness started reaches the bot itself, not just a wrapper shell.
dir=$(dirname "$0")
exec "$dir/swu-bend" --cards "$dir/" "$@" < <(cat)
