#!/bin/bash
# Runs a command in its own PID and mount namespace (needs root and unshare):
#
#   bot/arena/ops/isolate.sh [--user <name>] [--tmp <dir>] [--hide <path>]... -- <command> [args...]
#
# Inside, /proc shows only the command's own process tree, so nothing it starts (bot programs, the intake's checks) can
# read another process's environment: the games machine's coordinator holds the window token there. --tmp <dir> puts
# that folder (made if missing) in place of /tmp, so what other processes keep in /tmp is out of reach too. Each --hide
# path (the round-seed secret, credential files) is covered by an empty mount. --user <name> runs the command as that
# user, with no capabilities and no way to gain any (no setuid programs): it cannot undo those mounts, and it reads
# only what that user may. Without --user the command keeps root's privileges, and root could unmount them, so the
# intake's checker passes --user; the referee runs as root here and starts its bot code as that user itself
# (referee.js spawnBots).
# Everything else, the network included, is shared. The command's exit code is this script's. SIGTERM, SIGINT or
# SIGHUP to this script (or to the command) stops the command with SIGTERM, and when the command ends every process left
# in the namespace ends with it.
set -euo pipefail
# wait for a child, passing TERM, INT and HUP on as $1 does; exit with the child's code
follow() {
    local how=$1 child=$2 code=0
    trap 'kill "-$how" "$child" 2>/dev/null || true' TERM INT HUP
    while :; do
        wait "$child" && code=0 || code=$?
        kill -0 "$child" 2>/dev/null || break
    done
    exit "$code"
}
if [ "${ARENA_ISOLATED:-}" != 1 ]; then
    # unshare ignores TERM while it waits, so a stop goes to it as KILL, and --kill-child then sends TERM inside
    unshare --pid --fork --kill-child=SIGTERM --mount --mount-proc --propagation private \
        env ARENA_ISOLATED=1 bash "$(readlink -f "$0")" "$@" &
    follow KILL "$!"
fi
hide=()
tmp=
user=
while [ $# -gt 0 ] && [ "$1" != -- ]; do
    if [ "$1" = --hide ] && [ $# -ge 2 ]; then
        hide+=("$2")
        shift 2
    elif [ "$1" = --tmp ] && [ $# -ge 2 ]; then
        tmp=$2
        shift 2
    elif [ "$1" = --user ] && [ $# -ge 2 ]; then
        user=$2
        shift 2
    else
        echo "isolate.sh: usage: isolate.sh [--user <name>] [--tmp <dir>] [--hide <path>]... -- <command> [args...]" >&2
        exit 2
    fi
done
[ $# -ge 2 ] || { echo "isolate.sh: no command after --" >&2; exit 2; }
shift
if [ -n "$tmp" ]; then
    mkdir -p "$tmp"
    chmod 1777 "$tmp"
    mount --bind "$tmp" /tmp
fi
for p in ${hide[@]+"${hide[@]}"}; do
    if [ -d "$p" ]; then
        mount -t tmpfs -o size=1m,mode=0700 hidden "$p"
    elif [ -e "$p" ]; then
        mount --bind /dev/null "$p"
    fi
done
# the mounts are made: from here on the command runs as $user, its capabilities (and any way back to them) dropped
run=()
if [ -n "$user" ]; then
    uid=$(id -u "$user") && gid=$(id -g "$user") || { echo "isolate.sh: no user $user" >&2; exit 2; }
    run=(setpriv "--reuid=$uid" "--regid=$gid" --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs --)
fi
# bash stays PID 1 here: it reaps orphans and passes signals on (PID 1 ignores those it has no handler for)
env -u ARENA_ISOLATED ${run[@]+"${run[@]}"} "$@" &
follow TERM "$!"
