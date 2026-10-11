#!/usr/bin/env bash
# One refresh of the meta-analyzer: read every result and replay, rebuild the page, update the dashboard panel.
# Usage: meta/refresh.sh [project-files dir]   (default /mnt/project-files)
set -euo pipefail
P="${1:-/mnt/project-files}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$P/meta"
mkdir -p "$OUT"
node "$HERE/analyze.js" --results "$P/results" --out "$OUT/meta.json" --cache "$OUT/replay-cache.json" \
  --panels "$P/dashboard/panels" --bots "$P/dashboard/league/bots.json"
node "$HERE/build-page.js" "$OUT/meta.json" "$OUT/theory.json" "$OUT/atlas.html" "$P/viewer-kit/swu-viewer-kit.js"
URL="$(cat "$OUT/artifact-url.txt" 2>/dev/null || true)"
node "$HERE/panel.js" "$OUT/meta.json" "$OUT/theory.json" "$P/dashboard/panels/meta-analyzer.json" "$URL"
