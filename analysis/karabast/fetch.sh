#!/bin/bash
# Copy every queue run (frames + games.jsonl) from the Karabast Sprite into <dest>/runs, through the Sprites API
# (the egress proxy adds the key). Opponents' names stay on the Sprite: ~/karabast/private is never read.
#   bash analysis/karabast/fetch.sh <dest>
set -euo pipefail
dest=${1:?usage: fetch.sh <dest>}
api=https://api.sprites.dev/v1/sprites/mcp-swu-karabast
cmd='cd ~/karabast/runs && tar czf /tmp/kb-runs.tgz q-* && stat -c %s /tmp/kb-runs.tgz'
curl -sS -X POST "$api/exec?cmd=bash&cmd=-c&cmd=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$cmd")" >/dev/null
mkdir -p "$dest/runs"
curl -sS -o "$dest/kb-runs.tgz" "$api/fs/read?path=/tmp/kb-runs.tgz"
tar xzf "$dest/kb-runs.tgz" -C "$dest/runs"
ls "$dest/runs" | while read -r r; do echo "$r $(ls "$dest/runs/$r/frames" 2>/dev/null | wc -l) frames"; done
