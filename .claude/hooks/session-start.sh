#!/bin/bash
# Cloud sessions only: installs flyctl so .mcp.json can start Fly's MCP server (tools/bin/fly-mcp).
# The sandbox cannot download flyctl releases (GitHub release assets and fly.io are blocked), but the Go module
# proxy works, so flyctl is built from source at a pinned version. That takes a few minutes the first time;
# the cloud container state is cached after this hook, so later sessions skip it. Never fails the session.
set -uo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
FLYCTL_VERSION=v0.4.115
dir="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
if "$dir/tools/fly/flyctl-path" >/dev/null 2>&1; then
    exit 0
fi
export PATH="/usr/local/go/bin:$PATH"
if ! command -v go >/dev/null 2>&1; then
    echo "session-start: no Go toolchain, so flyctl (and the fly MCP server) is not installed" >&2
    exit 0
fi
log=/tmp/flyctl-install.log
if GOTOOLCHAIN=auto CGO_ENABLED=0 GOBIN=/usr/local/bin timeout 900 \
    go install -trimpath -ldflags='-s -w' "github.com/superfly/flyctl@$FLYCTL_VERSION" >"$log" 2>&1; then
    ln -sf /usr/local/bin/flyctl /usr/local/bin/fly
else
    echo "session-start: building flyctl $FLYCTL_VERSION failed, see $log" >&2
fi
exit 0
