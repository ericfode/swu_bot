#!/bin/sh
# Starts the Bend bot. Bend reads stdin by opening /dev/stdin, which fails
# (ENXIO) when stdin is a socket, as with Node's child_process.spawn; cat in
# front turns it into a pipe.
dir=$(dirname "$0")
cat | exec "$dir/swu-bend" --cards "$dir/" "$@"
